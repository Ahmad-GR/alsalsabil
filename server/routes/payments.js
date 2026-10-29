const express = require('express');
const stripe  = require('stripe')(process.env.STRIPE_SECRET_KEY);
const { protect } = require('../middleware/auth');
const { createTapCharge, verifyTapWebhookSignature } = require('../utils/tap');
const { createCliqCharge } = require('../utils/cliq');
const { getDb, runInTransaction, nowIso } = require('../lib/postgres');
const { getUserById } = require('./site');

function getCourseRows({ publishedOnly = false, ids = null } = {}) {
  const db = getDb();
  let whereParts = [];
  let params = [];

  if (Array.isArray(ids) && ids.length) {
    whereParts.push(`id IN (${ids.map(() => '?').join(', ')})`);
    params.push(...ids);
  }
  if (publishedOnly) {
    whereParts.push('is_published = 1');
  }

  const whereClause = whereParts.length ? `WHERE ${whereParts.join(' AND ')}` : '';
  return db.prepare(`SELECT * FROM courses ${whereClause} ORDER BY id ASC, created_at ASC`).all(...params);
}

const router = express.Router();

const paymentEnabled = process.env.ENABLE_PAYMENTS !== 'false';
const emailNotificationsEnabled = process.env.SEND_PAYMENT_EMAILS === 'true';

if (!process.env.STRIPE_SECRET_KEY || !process.env.STRIPE_WEBHOOK_SECRET) {
  console.warn('Warning: Stripe keys are missing. تأكد من إعداد STRIPE_SECRET_KEY و STRIPE_WEBHOOK_SECRET');
}
if (!process.env.TAP_SECRET_KEY && !process.env.TAP_SECRET) {
  console.warn('Warning: Tap secret key is missing. تأكد من إعداد TAP_SECRET_KEY');
}

/**
 * Enrolls a user in the courses associated with a paid order.
 * @param {number} orderId - The internal SQLite ID of the order.
 */
function enrollUserInCourses(orderId) {
  const db = getDb();
  const order = db.prepare('SELECT * FROM orders WHERE id = ?').get(orderId);
  if (!order) return 0;

  const orderItems = db.prepare('SELECT * FROM order_items WHERE order_id = ?').all(order.id);
  let enrolled = 0;

  runInTransaction((transactionDb) => {
    const timestamp = nowIso();
    orderItems.forEach(item => {
      if (!item.course_id) return;
      const existing = transactionDb.prepare('SELECT id FROM enrollments WHERE user_id = ? AND course_id = ?')
        .get(order.user_id, item.course_id);
      if (existing) return;
      transactionDb.prepare(`INSERT INTO enrollments (user_id, course_id, order_id, progress, completed_lessons_json, created_at, updated_at) VALUES (?, ?, ?, 0, '[]', ?, ?)`) 
        .run(order.user_id, item.course_id, order.id, timestamp, timestamp);
      enrolled += 1;
    });
  });
  return enrolled;
}

/**
 * Sends a confirmation email after a successful purchase.
 * @param {object} order - The order object from the database.
 */
async function sendConfirmationEmail(order) {
  const user = getUserById(order.user_id);

  if (!user) return;

  // فرض تعطيل الإيميل بغض النظر عن حالة الإعدادات حتى تتحقق الطلب.
  if (!emailNotificationsEnabled) {
    console.log(`[EMAIL DISABLED] Email notifications are disabled for order ID ${order.id} to avoid إرسال رسائل.`);
    return;
  }

  // منع إرسال الرسائل حتى لو كان مفعل من البيئة
  console.log(`[EMAIL DISABLED] Forced disable of payment emails for ${user.email}, order ID ${order.id}.`);
  return;
}

// ══════════════════════════════════════════
// STRIPE PAYMENT ROUTES
// ══════════════════════════════════════════

router.post('/create-checkout', protect, async (req, res) => {
  if (!paymentEnabled) return res.status(503).json({ error: 'الدفع معطل حالياً' });
  try {
    const { courseIds } = req.body;
    if (!courseIds?.length) return res.status(400).json({ error: 'لا توجد كورسات' });

    const courses = getCourseRows({ ids: courseIds, publishedOnly: true });
    if (!courses.length) return res.status(404).json({ error: 'الكورسات غير موجودة' });

    const lineItems = courses.map(c => ({
      price_data: {
        currency: 'jod',
        product_data: {
          name:        c.title,
          description: `${c.category} • ${c.level}`,
        },
        unit_amount: Math.round(parseFloat(c.price || 0) * 100), // تحويل السعر إلى هللات بشكل صحيح
      },
      quantity: 1,
    }));

    const totalAmount = courses.reduce((s, c) => s + Number(c.price || 0), 0);

    const orderId = runInTransaction((db) => {
      const timestamp = nowIso();
      const orderResult = db.prepare(`
        INSERT INTO orders (order_id, user_id, total_amount, status, payment_method, created_at, updated_at)
        VALUES (?, ?, ?, 'pending', 'stripe', ?, ?)
      `).run(`STRIPE-${Date.now().toString(36).toUpperCase()}`, req.user.id, totalAmount, timestamp, timestamp);
      const sqliteOrderId = Number(orderResult.lastInsertRowid);

      courses.forEach(course => {
        db.prepare(`INSERT INTO order_items (order_id, course_id, course_title, price_at_time, created_at) VALUES (?, ?, ?, ?, ?)`)
          .run(sqliteOrderId, course.id, course.title, Number(course.price || 0), timestamp);
      });

      return sqliteOrderId;
    });

    const session = await stripe.checkout.sessions.create({
      payment_method_types: ['card'],
      line_items:   lineItems,
      mode:         'payment',
      success_url:  `${process.env.CLIENT_URL}?payment=success&session={CHECKOUT_SESSION_ID}`,
      cancel_url:   `${process.env.CLIENT_URL}?payment=cancel`,
      customer_email: req.user.email,
      metadata:     { orderId: String(orderId) },
      locale:       'ar',
    });

    getDb().prepare('UPDATE orders SET stripe_session_id = ? WHERE id = ?')
      .run(session.id, orderId);
    res.json({ url: session.url });
  } catch (err) {
    console.error('Stripe create checkout error:', err.message);
    res.status(500).json({ error: 'فشل في إنشاء جلسة الدفع' });
  }
});

router.post('/webhook', express.raw({type: 'application/json'}), async (req, res) => {
  if (!paymentEnabled) return res.status(503).json({ error: 'الدفع معطل حالياً' });
  const sig = req.headers['stripe-signature'];
  let event;

  try {
    event = stripe.webhooks.constructEvent(req.body, sig, process.env.STRIPE_WEBHOOK_SECRET);
  } catch (err) {
    console.error('Stripe webhook signature error:', err.message);
    return res.status(400).send(`Webhook Error: ${err.message}`);
  }

  if (event.type === 'checkout.session.completed') {
    const session = event.data.object;
    const orderId = Number(session.metadata?.orderId || 0);
    if (!orderId) {
      console.error('Invalid orderId in webhook metadata');
      return res.status(400).send('Invalid orderId');
    }

    try {
      let becamePaid = false;
      runInTransaction((db) => {
        const result = db.prepare("UPDATE orders SET status = 'paid', stripe_payment_intent = ? WHERE id = ? AND status = 'pending'")
          .run(session.payment_intent, orderId);
        becamePaid = result.changes > 0;
        if (!becamePaid) return;

        const order = db.prepare('SELECT * FROM orders WHERE id = ?').get(orderId);
        const items = db.prepare('SELECT * FROM order_items WHERE order_id = ?').all(orderId);
        const timestamp = nowIso();
        items.forEach(item => {
          if (!item.course_id) return;
          const existing = db.prepare('SELECT id FROM enrollments WHERE user_id = ? AND course_id = ?')
            .get(order.user_id, item.course_id);
          if (!existing) {
            db.prepare(`INSERT INTO enrollments (user_id, course_id, order_id, progress, completed_lessons_json, created_at, updated_at) VALUES (?, ?, ?, 0, '[]', ?, ?)`) 
              .run(order.user_id, item.course_id, orderId, timestamp, timestamp);
          }
        });
      });

      if (becamePaid) {
        const order = getDb().prepare('SELECT * FROM orders WHERE id = ?').get(orderId);
        sendConfirmationEmail(order).catch(console.error);
      }
    } catch (err) {
      console.error('Stripe webhook processing error:', err);
      return res.status(500).send('Webhook processing failed');
    }
  }

  res.json({ received: true });
});

// ══════════════════════════════════════════
// TAP PAYMENT ROUTES
// ══════════════════════════════════════════

router.post('/webhook-tap', express.json(), async (req, res) => {
  if (!paymentEnabled) return res.status(503).json({ error: 'الدفع معطل حالياً' });

  try {
    const isVerified = await verifyTapWebhookSignature({
      body: req.body,
      signature: req.headers.hashstring,
      secret: process.env.TAP_WEBHOOK_SECRET || process.env.TAP_SECRET_KEY || process.env.TAP_SECRET,
    });

    if (!isVerified) {
      return res.status(403).json({ error: 'التوقيع غير صحيح' });
    }

    const charge = req.body?.data?.object || req.body?.charge || {};
    const eventType = req.body?.type || req.body?.event?.type || '';
    const tapOrderId = charge?.metadata?.orderId || charge?.order?.id || '';

    if ((eventType === 'charge.succeeded' || charge.status === 'CAPTURED') && tapOrderId) {
      const dbOrder = getDb().prepare('SELECT * FROM orders WHERE order_id = ?').get(tapOrderId);
      if (!dbOrder) {
        return res.status(200).json({ received: true });
      }

      const expectedAmount = Number(dbOrder.total_amount);
      const receivedAmount = Number(charge.amount);
      if (String(charge.currency || '').toUpperCase() !== 'JOD'
        || !Number.isFinite(receivedAmount)
        || Math.abs(receivedAmount - expectedAmount) > 0.001) {
        return res.status(400).json({ error: 'بيانات مبلغ الدفع لا تطابق الطلب' });
      }

      const result = getDb().prepare("UPDATE orders SET status = 'paid', updated_at = ? WHERE id = ? AND status = 'pending'")
        .run(nowIso(), dbOrder.id);

      if (result.changes > 0) {
        await enrollUserInCourses(dbOrder.id);
      }
    }

    res.status(200).json({ received: true });
  } catch (err) {
    console.error('[Tap Webhook] خطأ عام:', err.message);
    res.status(200).json({ received: true });
  }
});

router.post('/create-tap-charge', protect, async (req, res) => {
  if (!paymentEnabled) return res.status(503).json({ error: 'الدفع معطل حالياً' });
  try {
    const { courseIds } = req.body;
    if (!courseIds?.length) return res.status(400).json({ error: 'لا توجد كورسات' });

    const courses = getCourseRows({ ids: courseIds, publishedOnly: true });
    if (!courses.length) return res.status(404).json({ error: 'الكورسات غير موجودة' });

    const totalAmount = courses.reduce((s, c) => s + Number(c.price || 0), 0);
    const orderReference = `TAP-${Date.now().toString(36).toUpperCase()}`;

    const orderId = runInTransaction((db) => {
      const timestamp = nowIso();
      const orderResult = db.prepare(`
        INSERT INTO orders (order_id, user_id, total_amount, status, payment_method, created_at, updated_at)
        VALUES (?, ?, ?, 'pending', 'tap', ?, ?)
      `).run(orderReference, req.user.id, totalAmount, timestamp, timestamp);
      const sqliteOrderId = Number(orderResult.lastInsertRowid);

      courses.forEach(course => {
        db.prepare(`INSERT INTO order_items (order_id, course_id, course_title, price_at_time, created_at) VALUES (?, ?, ?, ?, ?)`)
          .run(sqliteOrderId, course.id, course.title, Number(course.price || 0), timestamp);
      });

      return sqliteOrderId;
    });

    const charge = await createTapCharge({
      amount: totalAmount,
      currency: 'JOD',
      customerEmail: req.user.email,
      description: `Purchase of ${courses.length} course(s)`,
      orderId: orderReference,
      returnUrl: `${process.env.CLIENT_URL || 'http://localhost:5001'}?payment=tap-success&order=${encodeURIComponent(orderReference)}`,
      postUrl: process.env.TAP_POST_URL || `${process.env.SERVER_URL || 'http://localhost:5001'}/api/payments/webhook-tap`,
      metadata: {
        orderId: orderReference,
        app: 'hifz-platform',
      },
    });

    getDb().prepare('UPDATE orders SET payment_reference = ? WHERE id = ?').run(charge?.id || orderReference, orderId);

    res.json({ success: true, charge, orderId: orderReference });
  } catch (err) {
    console.error('Tap create charge error:', err.message);
    res.status(500).json({ error: 'فشل في إنشاء طلب الدفع عبر Tap Payments' });
  }
});

router.get('/verify-session/:sessionId', protect, async (req, res) => {
  try {
    const db = getDb();
    const order = db.prepare('SELECT * FROM orders WHERE stripe_session_id = ? AND user_id = ?')
      .get(req.params.sessionId, req.user.id);
    if (!order) return res.status(404).json({ error: 'لم يتم العثور على الطلب' });
    const session = await stripe.checkout.sessions.retrieve(req.params.sessionId);

    const items = db.prepare(`
      SELECT course_title, price_at_time FROM order_items WHERE order_id = ?
    `).all(order.id);

    if (session.payment_status === 'paid' && order.status !== 'paid') {
      let becamePaid = false;
      runInTransaction((db) => {
        const result = db.prepare("UPDATE orders SET status = 'paid', stripe_payment_intent = ? WHERE id = ? AND status = 'pending'")
          .run(session.payment_intent || null, order.id);
        becamePaid = result.changes > 0;
        if (becamePaid) {
          const items = db.prepare('SELECT * FROM order_items WHERE order_id = ?').all(order.id);
          const timestamp = nowIso();
          items.forEach(item => {
            if (!item.course_id) return;
            const existing = db.prepare('SELECT id FROM enrollments WHERE user_id = ? AND course_id = ?')
              .get(order.user_id, item.course_id);
            if (!existing) {
              db.prepare(`INSERT INTO enrollments (user_id, course_id, order_id, progress, completed_lessons_json, created_at, updated_at) VALUES (?, ?, ?, 0, '[]', ?, ?)`) 
                .run(order.user_id, item.course_id, order.id, timestamp, timestamp);
            }
          });
        }
      });
      if (becamePaid) order.status = 'paid';
    }

    res.json({
      paymentStatus: session.payment_status,
      order: {
        id: order.id,
        total: order.total_amount,
        status: order.status,
        date: order.created_at,
        items: items.map((i) => ({ title: i.course_title, price: i.price_at_time })),
      }
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.post('/create-cliq-charge', protect, async (req, res) => {
  if (!paymentEnabled) return res.status(503).json({ error: 'الدفع معطل حالياً' });
  try {
    const { courseIds } = req.body;
    if (!courseIds?.length) return res.status(400).json({ error: 'لا توجد كورسات' });

    const courses = getCourseRows({ ids: courseIds, publishedOnly: true });
    if (!courses.length) return res.status(404).json({ error: 'الكورسات غير موجودة' });

    const totalAmount = courses.reduce((s, c) => s + Number(c.price || 0), 0);
    const orderReference = `CLIQ-${Date.now().toString(36).toUpperCase()}`;

    const orderId = runInTransaction((db) => {
      const timestamp = nowIso();
      const orderResult = db.prepare(`
        INSERT INTO orders (order_id, user_id, total_amount, status, payment_method, created_at, updated_at)
        VALUES (?, ?, ?, 'pending', 'cliq', ?, ?)
      `).run(orderReference, req.user.id, totalAmount, timestamp, timestamp);
      const sqliteOrderId = Number(orderResult.lastInsertRowid);

      courses.forEach(course => {
        db.prepare(`INSERT INTO order_items (order_id, course_id, course_title, price_at_time, created_at) VALUES (?, ?, ?, ?, ?)`)
          .run(sqliteOrderId, course.id, course.title, Number(course.price || 0), timestamp);
      });

      return sqliteOrderId;
    });

    const charge = await createCliqCharge({
      amount: totalAmount,
      currency: 'JOD',
      customerEmail: req.user.email,
      customerPhone: req.user.phone,
      description: `Purchase of ${courses.length} course(s)`,
      orderId: orderReference,
      returnUrl: `${process.env.CLIENT_URL || 'http://localhost:5001'}?payment=cliq-success&order=${encodeURIComponent(orderReference)}`,
      metadata: { orderId: orderReference, app: 'hifz-platform' },
    });

    getDb().prepare('UPDATE orders SET payment_reference = ? WHERE id = ?')
      .run(charge.transactionId || orderReference, orderId);

    res.json({
      success: true,
      orderId: orderReference,
      checkoutUrl: charge.checkoutUrl,
      transactionId: charge.transactionId,
    });
  } catch (err) {
    console.error('Cliq create charge error:', err.message);
    res.status(500).json({ error: 'فشل في إنشاء طلب الدفع عبر كليك' });
  }
});

module.exports = router;
