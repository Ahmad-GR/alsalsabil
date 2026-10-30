const express = require('express');
const { randomInt } = require('crypto');
const jwt = require('jsonwebtoken');
const bcrypt = require('bcryptjs');
const { boolToInt, fromJson, getDb, nowIso, runInTransaction, toJson } = require('../lib/postgres');
const { protect, isAdmin } = require('../middleware/auth');
const { isEmailConfigured, sendEmail } = require('../utils/email');
const multer = require('multer');
const path = require('path');
const fs = require('fs');
const cloudinary = require('cloudinary').v2;

// استخدام الذاكرة بدلاً من التخزين المحلي لرفع الملف مباشرة للسحابة
const storage = multer.memoryStorage();
const upload = multer({ storage, limits: { fileSize: 2000 * 1024 * 1024 } }); // 2GB
const uploadHandler = upload.single('videoFile');

const router = express.Router();
const canPublish = (req, res, next) => {
  if (!['admin', 'teacher', 'instructor'].includes(req.user?.role)) {
    return res.status(403).json({ error: 'غير مصرح بالنشر' });
  }
  return next();
};
const JWT_SECRET = process.env.JWT_SECRET || (
  process.env.NODE_ENV === 'production'
    ? (() => { throw new Error('JWT_SECRET must be configured in production'); })()
    : 'local_dev_secret_change_me'
);
const USERNAME_REGEX = /^[\p{L}\p{N}_]{3,}$/u;
const PASSWORD_REGEX = /^(?=.*\p{L})(?=.*\p{N})(?=.*[^\p{L}\p{N}\s]).{6,}$/u;

const ADMIN_EMAIL = () => process.env.ADMIN_NOTIFY_EMAIL || process.env.ADMIN_EMAIL || '';
const CLIENT_URL = () => process.env.CLIENT_URL || 'http://localhost:5000';
const rateLimitBuckets = new Map();
const skipEmailVerification = process.env.NODE_ENV !== 'production'
  && process.env.DEV_SKIP_EMAIL_VERIFICATION === 'true';

function escapeHtml(value) {
  return String(value || '').replace(/[&<>"']/g, character => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
  }[character]));
}

function normalizeImageData(value) {
  const image = String(value || '').trim();
  if (!image) return '';
  if (!/^data:image\/(?:jpeg|png|gif|webp);base64,[a-z0-9+/=\s]+$/i.test(image) || image.length > 5000000) {
    const error = new Error('صيغة الصورة غير صالحة أو حجمها كبير');
    error.statusCode = 400;
    throw error;
  }
  return image;
}

function rateLimit({ windowMs, max, message }) {
  return (req, res, next) => {
    const key = `${req.path}:${req.ip}`;
    const now = Date.now();
    const bucket = rateLimitBuckets.get(key);
    if (!bucket || now - bucket.startedAt >= windowMs) {
      rateLimitBuckets.set(key, { startedAt: now, count: 1 });
      return next();
    }
    bucket.count += 1;
    if (bucket.count > max) {
      res.set('Retry-After', String(Math.ceil((windowMs - (now - bucket.startedAt)) / 1000)));
      return res.status(429).json({ error: message });
    }
    return next();
  };
}

/* ── قوالب الإيميلات ── */
function tplHeader(icon, title, subtitle = '') {
  return `
<div dir="rtl" style="font-family:Arial,sans-serif;max-width:540px;margin:auto;background:#fdf8ef;border-radius:16px;overflow:hidden;border:1px solid #e8dcc8">
  <div style="background:linear-gradient(135deg,#1a6b4a,#22865e);padding:32px;text-align:center">
    <div style="font-size:2.5rem;margin-bottom:8px">${icon}</div>
    <h1 style="color:white;font-size:1.4rem;margin:0;font-weight:700">السلسبيل</h1>
    ${subtitle ? `<p style="color:rgba(255,255,255,0.75);margin-top:6px;font-size:.9rem">${subtitle}</p>` : ''}
  </div>
  <div style="padding:36px">`;
}
function tplFooter() {
  return `
  </div>
  <div style="background:#f7f0e3;padding:16px;text-align:center;font-size:.78rem;color:#8a7050">
    © 2025 السلسبيل — جميع الحقوق محفوظة
  </div>
</div>`;
}
function tplAyah() {
  return `<div style="background:#f0f9f4;border-right:4px solid #1a6b4a;padding:14px 16px;border-radius:0 8px 8px 0;margin:20px 0">
    <p style="color:#1a6b4a;font-size:.88rem;margin:0">﴿ وَلَقَدْ يَسَّرْنَا الْقُرْآنَ لِلذِّكْرِ فَهَلْ مِن مُّدَّكِرٍ ﴾</p>
  </div>`;
}

function emailVerifyHtml(firstName, code) {
  return tplHeader('📖', 'السلسبيل', 'منصة الحفظ والتعلم') + `
    <p style="font-size:1.05rem;color:#2c1f0e;margin-bottom:8px">السلام عليكم <strong style="color:#1a6b4a">${escapeHtml(firstName)}</strong> 🌸</p>
    <p style="color:#5a4220;line-height:1.8;margin-bottom:20px">شكراً لتسجيلك معنا. للتحقق من بريدك الإلكتروني، أدخل الرمز التالي:</p>
    <div style="background:white;border:2px dashed #c9a84c;border-radius:14px;padding:28px;text-align:center;margin:24px 0">
      <div style="font-size:2.8rem;font-weight:900;letter-spacing:14px;color:#1a6b4a;font-family:monospace">${code}</div>
      <p style="color:#8a7050;font-size:.82rem;margin-top:10px;margin-bottom:0">⏱️ صالح لمدة <strong>10 دقائق</strong> فقط</p>
    </div>
    ${tplAyah()}
    <p style="color:#8a7050;font-size:.82rem">إذا لم تطلب هذا، يمكنك تجاهل هذه الرسالة.</p>
  ` + tplFooter();
}

function emailWelcomeHtml(firstName) {
  return tplHeader('🌟', 'أهلاً بك في السلسبيل!') + `
    <p style="font-size:1.05rem;color:#2c1f0e">السلام عليكم <strong style="color:#1a6b4a">${escapeHtml(firstName)}</strong> 🌸</p>
    <p style="color:#5a4220;line-height:1.8">تم تفعيل حسابك بنجاح. يمكنك الآن تصفح جميع البرامج والاشتراك في رحلة حفظ القرآن والعلم الشرعي.</p>
    <div style="text-align:center;margin:28px 0">
      <a href="${CLIENT_URL()}" style="background:linear-gradient(135deg,#1a6b4a,#22865e);color:white;padding:14px 32px;border-radius:10px;text-decoration:none;font-weight:700;font-size:1rem">ابدأ رحلتك الآن →</a>
    </div>
  ` + tplFooter();
}

function emailResetHtml(firstName, code) {
  return tplHeader('🔑', 'إعادة تعيين كلمة المرور') + `
    <p style="font-size:1.05rem;color:#2c1f0e;margin-bottom:8px">السلام عليكم <strong style="color:#1a6b4a">${escapeHtml(firstName)}</strong></p>
    <p style="color:#5a4220;line-height:1.8;margin-bottom:20px">تلقينا طلبًا لإعادة تعيين كلمة مرورك. استخدم الرمز التالي:</p>
    <div style="background:white;border:2px dashed #c9a84c;border-radius:14px;padding:28px;text-align:center;margin:24px 0">
      <div style="font-size:2.8rem;font-weight:900;letter-spacing:14px;color:#c0392b;font-family:monospace">${code}</div>
      <p style="color:#8a7050;font-size:.82rem;margin-top:10px;margin-bottom:0">⏱️ صالح لمدة <strong>15 دقيقة</strong> فقط</p>
    </div>
    <p style="color:#8a7050;font-size:.82rem">إذا لم تطلب إعادة التعيين، تجاهل هذه الرسالة وحسابك بأمان.</p>
  ` + tplFooter();
}

function emailContactUserHtml(name, subject, message) {
  return tplHeader('💬', 'تم استلام رسالتك', 'سنرد عليك في أقرب وقت') + `
    <p style="font-size:1.05rem;color:#2c1f0e">السلام عليكم <strong style="color:#1a6b4a">${escapeHtml(name)}</strong> 🌸</p>
    <p style="color:#5a4220;line-height:1.8">تم استلام رسالتك بنجاح، وسنرد عليك في أقرب وقت ممكن إن شاء الله.</p>
    <div style="background:white;border:1px solid #e8dcc8;border-radius:12px;padding:20px;margin:20px 0">
      <p style="color:#8a7050;font-size:.82rem;margin:0 0 6px">الموضوع: <strong style="color:#2c1f0e">${escapeHtml(subject || 'بدون موضوع')}</strong></p>
      <p style="color:#8a7050;font-size:.82rem;margin:0">رسالتك:</p>
      <p style="color:#2c1f0e;line-height:1.8;margin-top:8px;padding-right:12px;border-right:3px solid #1a6b4a">${escapeHtml(message)}</p>
    </div>
    ${tplAyah()}
  ` + tplFooter();
}

function emailContactAdminHtml(name, email, subject, message) {
  return tplHeader('📬', 'رسالة جديدة من الموقع') + `
    <p style="color:#2c1f0e;font-size:1rem">وردت رسالة جديدة عبر نموذج التواصل:</p>
    <table style="width:100%;border-collapse:collapse;margin:16px 0;font-size:.9rem">
      <tr><td style="padding:8px 12px;background:#f0f9f4;border-radius:4px;font-weight:700;color:#1a6b4a;width:100px">الاسم</td><td style="padding:8px 12px">${escapeHtml(name)}</td></tr>
      <tr><td style="padding:8px 12px;background:#f0f9f4;border-radius:4px;font-weight:700;color:#1a6b4a">البريد</td><td style="padding:8px 12px"><a href="mailto:${escapeHtml(email)}" style="color:#1a6b4a">${escapeHtml(email)}</a></td></tr>
      <tr><td style="padding:8px 12px;background:#f0f9f4;border-radius:4px;font-weight:700;color:#1a6b4a">الموضوع</td><td style="padding:8px 12px">${escapeHtml(subject || '—')}</td></tr>
    </table>
    <div style="background:white;border:1px solid #e8dcc8;border-radius:12px;padding:20px;margin-top:16px">
      <p style="color:#8a7050;font-size:.82rem;margin:0 0 8px">نص الرسالة:</p>
      <p style="color:#2c1f0e;line-height:1.8;margin:0;padding-right:12px;border-right:3px solid #1a6b4a">${escapeHtml(message)}</p>
    </div>
  ` + tplFooter();
}

/* ══════════════════════════════════════════
   OTP / VERIFY CODE — SQLite (لا نموذج منفصل)
══════════════════════════════════════════ */
/* ══════════════════════════════════════════
   UTILITIES
══════════════════════════════════════════ */
function requireDbReady(req, res, next) {
  try { getDb(); return next(); }
  catch (error) {
    return res.status(503).json({ error: 'تعذر فتح قاعدة البيانات المحلية حالياً. تأكد من صلاحية مجلد server/data ثم أعد تشغيل الخادم.' });
  }
}
router.use(requireDbReady);

function saveOtp(userId, type, code, minutesTTL) {
  const db = getDb();
  const expiresAt = new Date(Date.now() + minutesTTL * 60 * 1000).toISOString();
  db.prepare('DELETE FROM otp_codes WHERE user_id = ? AND type = ?').run(userId, type);
  db.prepare('INSERT INTO otp_codes (user_id, type, code, expires_at) VALUES (?, ?, ?, ?)')
    .run(userId, type, String(code).trim(), expiresAt);
}

function verifyOtp(userId, type, code) {
  const db = getDb();
  const row = db.prepare('SELECT * FROM otp_codes WHERE user_id = ? AND type = ? ORDER BY created_at DESC LIMIT 1').get(userId, type);
  if (!row) return { ok: false, error: 'الرمز غير موجود أو منتهي الصلاحية' };
  if (row.code !== String(code).trim()) return { ok: false, error: 'الرمز غير صحيح' };
  if (new Date(row.expires_at) < new Date()) return { ok: false, error: 'انتهت صلاحية الرمز، اطلب رمزاً جديداً' };
  db.prepare('DELETE FROM otp_codes WHERE id = ?').run(row.id);
  return { ok: true };
}

function ensureIsVerifiedColumn(db) {
  // The PostgreSQL schema creates this column up front; this remains a
  // compatibility hook for callers that initialize an older database.
  const column = db.prepare(`
    SELECT column_name
    FROM information_schema.columns
    WHERE table_name = 'users' AND column_name = 'is_verified'
  `).get();
  if (!column) {
    db.exec('ALTER TABLE users ADD COLUMN is_verified INTEGER NOT NULL DEFAULT 0');
  }
}
function signToken(user) {
  return jwt.sign({ id: user.id }, JWT_SECRET, { expiresIn: '30d' });
}
function splitName(name) {
  const parts = String(name || '').trim().split(/\s+/).filter(Boolean);
  const firstName = parts.shift() || 'مستخدم';
  const lastName = parts.join(' ') || 'جديد';
  return { firstName, lastName };
}
function normalizeEmail(email) { return String(email || '').trim().toLowerCase(); }
function normalizeUsername(username) {
  return String(username || '').trim().normalize('NFKC').toLowerCase();
}
function isValidUsername(username) { return USERNAME_REGEX.test(normalizeUsername(username)); }
function isStrongPassword(password) { return PASSWORD_REGEX.test(String(password || '').normalize('NFKC')); }

function validateUsernameOrThrow(username) {
  if (!isValidUsername(username)) {
    const error = new Error('اسم المستخدم يجب أن يكون 3 خانات على الأقل، ويمكن أن يحتوي على أحرف أو أرقام أو شرطة سفلية');
    error.statusCode = 400; throw error;
  }
}
function validatePasswordOrThrow(password) {
  if (!isStrongPassword(password)) {
    const error = new Error('كلمة المرور يجب أن تكون 6 أحرف على الأقل وتحتوي على حرف ورقم ورمز');
    error.statusCode = 400; throw error;
  }
}

function mapUserRow(row) {
  if (!row) return null;
  return {
    id: row.id,
    firstName: row.first_name,
    lastName: row.last_name,
    username: row.username,
    email: row.email,
    phone: row.phone || '',
    avatarUrl: row.avatar_url || '',
    passwordHash: row.password_hash,
    role: row.role || 'student',
    isVerified: row.is_verified === 1 || row.is_verified === true,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}
function getUserById(id) {
  const row = getDb().prepare('SELECT * FROM users WHERE id = ?').get(id);
  return mapUserRow(row);
}
function getUserByEmail(email) {
  const row = getDb().prepare('SELECT * FROM users WHERE email = ?').get(normalizeEmail(email));
  return mapUserRow(row);
}
function getUserByUsername(username) {
  const row = getDb().prepare('SELECT * FROM users WHERE username = ?').get(normalizeUsername(username));
  return mapUserRow(row);
}

cloudinary.config({
  cloud_name: process.env.CLOUDINARY_CLOUD_NAME,
  api_key:    process.env.CLOUDINARY_API_KEY,
  api_secret: process.env.CLOUDINARY_API_SECRET,
});

function findUserByLogin(login) {
  const row = getDb().prepare('SELECT * FROM users WHERE email = ? OR username = ?').get(
    normalizeEmail(login), normalizeUsername(login)
  );
  return mapUserRow(row);
}
function getNextCourseId() {
  const row = getDb().prepare('SELECT COALESCE(MAX(id), 0) + 1 AS next_id FROM courses').get();
  return row?.next_id || 1;
}
function parseIncludes(value, fallback = []) {
  if (Array.isArray(value)) return value.filter(Boolean);
  if (!value) return fallback;
  return String(value).split('\n').map(item => item.trim()).filter(Boolean);
}
function buildCoursePayload(body, existingCourse) {
  return {
    title: String(body.title || existingCourse?.title || '').trim(),
    category: String(body.cat || body.category || existingCourse?.category || 'حفظ القرآن').trim(),
    price: Number(body.price ?? existingCourse?.price ?? 0),
    oldPrice: body.oldPrice === null || body.oldPrice === undefined || body.oldPrice === ''
      ? (existingCourse?.old_price ?? null) : Number(body.oldPrice),
    level: String(body.level || existingCourse?.level || 'مبتدئ'),
    durationLabel: String(body.duration || body.durationLabel || existingCourse?.duration_label || ''),
    emoji: String(body.emoji || existingCourse?.emoji || '📖'),
    badge: String(body.badge || existingCourse?.badge || ''),
    description: String(body.desc || body.description || existingCourse?.description || ''),
    includes: parseIncludes(body.includes, fromJson(existingCourse?.includes_json, [])),
    studentsCount: existingCourse?.students_count ?? 0,
    lifetimeAccess: body.lifetimeAccess === undefined
      ? (existingCourse ? !!existingCourse.lifetime_access : true)
      : (body.lifetimeAccess === true || body.lifetimeAccess === 1 || body.lifetimeAccess === 'true'),
    rating: existingCourse?.rating ?? Number(body.rating || 5),
    bg: String(body.bg || existingCourse?.bg || 'linear-gradient(135deg,#1a6b4a,#22865e)'),
    thumbnail: String(body.imgData || body.thumbnail || existingCourse?.thumbnail || ''),
    isPublished: body.isPublished === undefined
      ? (existingCourse ? !!existingCourse.is_published : true)
      : !!body.isPublished,
    courseEndAt: body.courseEndAt === undefined
      ? (existingCourse?.course_end_at || null)
      : (body.courseEndAt ? new Date(body.courseEndAt).toISOString() : null),
    expiredAction: ['keep', 'archive', 'delete'].includes(body.expiredAction)
      ? body.expiredAction
      : (existingCourse?.expired_action || 'keep'),
    teacherId: body.teacherId === undefined
      ? (existingCourse?.teacher_id || null)
      : (body.teacherId === null || body.teacherId === '' ? null : Number(body.teacherId)),
  };
}

function getCourseRows({ publishedOnly = false, ids = null, category = null } = {}) {
  const db = getDb();
  db.prepare("DELETE FROM courses WHERE expired_action = 'delete' AND course_end_at IS NOT NULL AND course_end_at <= CURRENT_TIMESTAMP").run();
  let whereParts = [];
  let params = [];

  if (Array.isArray(ids) && ids.length) {
    whereParts.push(`id IN (${ids.map(() => '?').join(', ')})`);
    params.push(...ids);
  }
  if (publishedOnly) {
    whereParts.push("is_published = 1 AND is_archived = 0 AND (course_end_at IS NULL OR course_end_at > CURRENT_TIMESTAMP)");
  }
  if (category) {
    whereParts.push('category = ?');
    params.push(category);
  }
  const whereClause = whereParts.length ? `WHERE ${whereParts.join(' AND ')}` : '';
  return db.prepare(`SELECT * FROM courses ${whereClause} ORDER BY id ASC, created_at ASC`).all(...params);
}
function getCourseRowById(id) {
  return getDb().prepare('SELECT * FROM courses WHERE id = ?').get(Number(id));
}
function getLessonsMap(courseIds) {
  const map = new Map();
  if (!courseIds.length) return map;
  const placeholders = courseIds.map(() => '?').join(', ');
  const rows = getDb().prepare(`
    SELECT * FROM lessons WHERE course_id IN (${placeholders}) ORDER BY course_id ASC, lesson_order ASC, id ASC
  `).all(...courseIds);
  rows.forEach(row => {
    if (!map.has(row.course_id)) map.set(row.course_id, []);
    map.get(row.course_id).push(row);
  });
  return map;
}
function serializeLesson(row) {
  return {
    id: row.id,
    title: row.title,
    duration: row.duration_label || '',
    url: row.external_url || row.video_url || null,
    videoData: row.video_data || null,
    free: !!row.is_free,
    addedAt: row.added_at || row.created_at || null,
    description: row.description || '',
  };
}
function serializeCourse(row, lessonsMap, studentsCount) {
  const lessons = (lessonsMap.get(row.id) || []).map(serializeLesson);
  return {
    id: row.id, dbId: String(row.id), title: row.title,
    cat: row.category, emoji: row.emoji || '📖',
    bg: row.bg || 'linear-gradient(135deg,#1a6b4a,#22865e)',
    badge: row.badge || '', level: row.level || 'مبتدئ',
    price: Number(row.price || 0),
    oldPrice: row.old_price === null ? null : Number(row.old_price || 0),
    duration: row.duration_label || '',
    students: studentsCount,
    rating: Number(row.rating || 5),
    desc: row.description || '',
    teacherId: row.teacher_id || null,
    includes: fromJson(row.includes_json, []),
    imgData: row.thumbnail || null, lessons,
    lifetimeAccess: !!row.lifetime_access,
    courseEndAt: row.course_end_at || null,
    expiredAction: row.expired_action || 'keep',
  };
}
function getSerializedCourses(options = {}) {
  const courseRows = getCourseRows(options);
  const lessonsMap = getLessonsMap(courseRows.map(c => c.id));
  const enrollmentCounts = new Map();
  if (courseRows.length) {
    const placeholders = courseRows.map(() => '?').join(', ');
    getDb().prepare(`
      SELECT course_id, COUNT(*)::int AS count FROM enrollments
      WHERE course_id IN (${placeholders}) GROUP BY course_id
    `).all(...courseRows.map(course => course.id))
      .forEach(row => enrollmentCounts.set(row.course_id, Number(row.count)));
  }
  return courseRows.map(row => serializeCourse(row, lessonsMap, enrollmentCounts.get(row.id) || 0));
}
function getSerializedCourseById(id) {
  const rows = getSerializedCourses({ ids: [Number(id)] });
  return rows[0] || null;
}
function serializeUser(db, user) {
  const enrollments = db.prepare(`
    SELECT e.course_id, c.title AS course_title FROM enrollments e
    LEFT JOIN courses c ON c.id = e.course_id
    WHERE e.user_id = ? ORDER BY e.course_id ASC
  `).all(user.id);
  const paidOrders = db.prepare(`
    SELECT order_id, total_amount FROM orders
    WHERE user_id = ? AND status IN ('paid','manual') ORDER BY created_at DESC
  `).all(user.id);
  return {
    id: user.id,
    username: user.username,
    email: user.email,
    firstName: user.firstName,
    lastName: user.lastName,
    name: [user.firstName, user.lastName].filter(Boolean).join(' ').trim(),
    phone: user.phone || '',
    avatarUrl: user.avatarUrl || '',
    role: user.role,
    isAdmin: user.role === 'admin',
    isVerified: user.isVerified,
    enrolledCourses: enrollments.map(item => item.course_id).filter(Boolean),
    enrolledCourseTitles: enrollments.map(item => item.course_title).filter(Boolean),
    totalSpent: paidOrders.reduce((sum, o) => sum + Number(o.total_amount || 0), 0),
    orders: paidOrders.map(o => o.order_id).filter(Boolean),
    joinDate: user.createdAt,
  };
}
function getUserOrders(userId) {
  const db = getDb();
  const orders = db.prepare(`
    SELECT * FROM orders WHERE user_id = ? AND status IN ('paid','manual') ORDER BY created_at DESC
  `).all(userId);
  if (!orders.length) return [];
  const placeholders = orders.map(() => '?').join(', ');
  const items = db.prepare(`
    SELECT order_id, course_id, course_title, price_at_time FROM order_items
    WHERE order_id IN (${placeholders}) ORDER BY id ASC
  `).all(...orders.map(o => o.id));
  const itemsMap = new Map();
  items.forEach(item => {
    if (!itemsMap.has(item.order_id)) itemsMap.set(item.order_id, []);
    itemsMap.get(item.order_id).push(item);
  });
  return orders.map(order => ({
    orderId: order.order_id,
    total: Number(order.total_amount || 0),
    date: order.created_at,
    status: order.status,
    items: (itemsMap.get(order.id) || []).map(item => ({
      id: item.course_id || null,
      title: item.course_title || '',
      price: Number(item.price_at_time || 0),
    })),
  }));
}

function createEnrollmentForUser(db, userId, courseId, { orderPrefix = 'MANUAL', totalAmount = 0, status = 'manual' } = {}) {
  const course = getCourseRowById(courseId);
  if (!course) { const e = new Error('الكورس المحدد غير موجود'); e.statusCode = 404; throw e; }

  const existingEnrollment = db.prepare('SELECT id FROM enrollments WHERE user_id = ? AND course_id = ?').get(userId, courseId);
  if (existingEnrollment) return null;

  const timestamp = nowIso();
  const orderId = `${orderPrefix}-${Date.now().toString(36).toUpperCase()}`;
  const orderResult = db.prepare(`
    INSERT INTO orders (order_id, user_id, total_amount, status, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?)
  `).run(orderId, userId, totalAmount, status, timestamp, timestamp);
  const sqliteOrderId = Number(orderResult.lastInsertRowid);
  db.prepare(`INSERT INTO order_items (order_id, course_id, course_title, price_at_time, created_at) VALUES (?, ?, ?, ?, ?)`)
    .run(sqliteOrderId, courseId, course.title, totalAmount, timestamp);
  db.prepare(`INSERT INTO enrollments (user_id, course_id, order_id, progress, completed_lessons_json, created_at, updated_at) VALUES (?, ?, ?, 0, '[]', ?, ?)`)
    .run(userId, courseId, sqliteOrderId, timestamp, timestamp);
  return sqliteOrderId;
}

const genCode = () => String(randomInt(100000, 1000000));

/* ══════════════════════════════════════════
   PUBLIC ROUTES
══════════════════════════════════════════ */

// GET /courses
router.get('/courses', (req, res) => {
  try {
    const { category: categorySlug } = req.query;
    const options = { publishedOnly: true };
    if (categorySlug && categorySlug !== 'الكل') {
      const category = getDb().prepare('SELECT name FROM categories WHERE slug = ?').get(categorySlug);
      if (category) options.category = category.name;
    }
    return res.json({ courses: getSerializedCourses(options) });
  } catch (error) {
    return res.status(500).json({ error: 'تعذر تحميل الكورسات' });
  }
});

router.get('/stats', (req, res) => {
  try {
    const courses = getDb().prepare(`
      SELECT duration_label, rating
      FROM courses
      WHERE is_published = 1 AND is_archived = 0
        AND (course_end_at IS NULL OR course_end_at > CURRENT_TIMESTAMP)
      ORDER BY id ASC, created_at ASC
    `).all();
    const hours = courses.reduce((total, course) => {
      const match = String(course.duration_label || '').match(/([\d٠-٩۰-۹]+(?:[.,٫][\d٠-٩۰-۹]+)?)\s*(?:ساعة|ساعات|ساعه|ساعت|hours?|hrs?|h)/iu);
      if (!match) return total;
      const arabicDigits = '٠١٢٣٤٥٦٧٨٩';
      const persianDigits = '۰۱۲۳۴۵۶۷۸۹';
      const normalizedHours = match[1].replace(/[٠-٩۰-۹]/g, digit => {
        const digitIndex = arabicDigits.indexOf(digit);
        return String(digitIndex >= 0 ? digitIndex : persianDigits.indexOf(digit));
      }).replace(/[٫,]/g, '.');
      return total + (Number.parseFloat(normalizedHours) || 0);
    }, 0);
    const rating = courses.length
      ? courses.reduce((total, course) => total + Number(course.rating ?? 5), 0) / courses.length
      : 0;
    const users = getDb().prepare('SELECT COUNT(*)::int AS count FROM users').get();
    return res.json({
      users: Number(users?.count || 0),
      courses: courses.length,
      hours: Number(hours.toFixed(1)),
      rating,
    });
  } catch (error) {
    console.error('Could not load homepage statistics', error);
    return res.status(500).json({ error: 'تعذر تحميل إحصاءات المنصة' });
  }
});

// GET /teachers - public teaching team directory for the about page
router.get('/teachers', (req, res) => {
  try {
    const teachers = getDb().prepare(`
      SELECT first_name, last_name, avatar_url
      FROM users
      WHERE role IN ('teacher', 'instructor')
      ORDER BY first_name ASC, last_name ASC, id ASC
    `).all().map(teacher => ({
      name: [teacher.first_name, teacher.last_name].filter(Boolean).join(' ').trim(),
      avatarUrl: teacher.avatar_url || '',
    }));
    return res.json({ teachers });
  } catch (error) {
    return res.status(500).json({ error: 'تعذر تحميل الفريق التعليمي' });
  }
});

// GET /categories-list - for public use
router.get('/categories-list', (req, res) => {
  try {
    const categories = getDb().prepare('SELECT id, name, slug FROM categories ORDER BY name ASC').all();
    res.json({ categories });
  } catch (e) {
    res.status(500).json({ error: 'تعذر جلب التصنيفات' });
  }
});

// GET /uploads/:filename — مسار محمي لعرض الفيديوهات المرفوعة
router.get('/uploads/:filename', (req, res) => {
  // المسار الصحيح لمجلد الرفع العام
  const uploadsDir = path.join(__dirname, '..', '..', 'public', 'uploads');

  try {
    const token = req.query.token;
    if (!token) return res.status(401).json({ error: 'غير مصرح: مفقود رمز المصادقة' });
    
    const decoded = jwt.verify(token, JWT_SECRET);
    const filename = req.params.filename;
    const filepath = path.join(uploadsDir, filename);
    
    if (!fs.existsSync(filepath)) {
      return res.status(404).json({ error: 'الملف غير موجود' });
    }
    
    const db = getDb();
    const user = db.prepare('SELECT role FROM users WHERE id = ?').get(decoded.id);
    if (!user) return res.status(401).json({ error: 'مستخدم غير صالح' });
    
    // إذا لم يكن أدمن، تحقق مما إذا كان الدرس مدفوعاً وأن المستخدم مشترك بالكورس
    if (user.role !== 'admin') {
      const lesson = db.prepare('SELECT course_id, is_free FROM lessons WHERE video_url LIKE ?').get('%' + filename);
      if (lesson && !lesson.is_free) {
        const enrollment = db.prepare('SELECT id FROM enrollments WHERE user_id = ? AND course_id = ?').get(decoded.id, lesson.course_id);
        if (!enrollment) return res.status(403).json({ error: 'غير مصرح: يرجى الاشتراك في الكورس لمشاهدة هذا الفيديو' });
      }
    }
    
    // إرسال الفيديو كـ Stream متوافق مع المشغلات
    return res.sendFile(filepath);
  } catch (error) {
    return res.status(401).json({ error: 'غير مصرح: رمز المصادقة غير صالح أو منتهي' });
  }
});

// POST /register — يرسل رمز تأكيد للإيميل
router.post('/register', rateLimit({ windowMs: 15 * 60 * 1000, max: 5, message: 'محاولات التسجيل كثيرة، حاول لاحقاً' }), async (req, res) => {
  try {
    const { username, email, password } = req.body;
    const legacyName = req.body?.name;
    const nameParts = legacyName ? splitName(legacyName) : {};
    const firstName = String(req.body?.firstName ?? nameParts.firstName ?? '').trim();
    const lastName = String(req.body?.lastName ?? nameParts.lastName ?? '').trim();
    if (!firstName || !lastName || !username || !email || !password)
      return res.status(400).json({ error: 'يرجى إكمال جميع الحقول' });
    if (!skipEmailVerification && !isEmailConfigured())
      return res.status(503).json({ error: 'التسجيل متوقف مؤقتاً حتى يتم إعداد خدمة البريد الإلكتروني' });

    validateUsernameOrThrow(username);
    validatePasswordOrThrow(password);

    const normalizedEmail = normalizeEmail(email);
    const normalizedUsername = normalizeUsername(username);
    if (getUserByEmail(normalizedEmail))
      return res.status(400).json({ error: 'هذا البريد الإلكتروني مسجل بالفعل' });
    if (getUserByUsername(normalizedUsername))
      return res.status(400).json({ error: 'اسم المستخدم مستخدم بالفعل' });

    const passwordHash = await bcrypt.hash(password, 12);
    const timestamp = nowIso();
    const db = getDb();
    ensureIsVerifiedColumn(db);

    const result = db.prepare(`
      INSERT INTO users (first_name, last_name, username, email, phone, password_hash, role, is_verified, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, 'student', ?, ?, ?)
    `).run(firstName, lastName, normalizedUsername, normalizedEmail, '', passwordHash, skipEmailVerification ? 1 : 0, timestamp, timestamp);

    const userId = Number(result.lastInsertRowid);
    if (skipEmailVerification) {
      const freshUser = getUserById(userId);
      return res.status(201).json({
        token: signToken(freshUser),
        user: serializeUser(db, freshUser),
        message: 'تم إنشاء حساب اختبار وتفعيله مباشرة في بيئة التطوير',
      });
    }
    const code = genCode();
    saveOtp(userId, 'verify', code, 10);

    // إرسال إيميل التأكيد (لا ننتظره)
    try {
      await sendEmail({
        to: normalizedEmail,
        subject: '🌿 رمز تأكيد تسجيلك في السلسبيل',
        html: emailVerifyHtml(firstName, code),
      });
    } catch (emailError) {
      db.prepare('DELETE FROM otp_codes WHERE user_id = ? AND type = ?').run(userId, 'verify');
      db.prepare('DELETE FROM users WHERE id = ?').run(userId);
      console.error('Registration email failed:', emailError.message);
      return res.status(503).json({ error: 'تعذر إرسال رسالة التحقق حالياً، حاول مرة أخرى لاحقاً' });
    }

    return res.status(201).json({
      requireVerify: true,
      userId,
      message: 'تم التسجيل! تحقق من بريدك الإلكتروني للحصول على رمز التأكيد',
    });
  } catch (error) {
    return res.status(error.statusCode || 500).json({ error: error.message || 'تعذر إنشاء الحساب' });
  }
});

// POST /verify-email
router.post('/verify-email', rateLimit({ windowMs: 15 * 60 * 1000, max: 10, message: 'محاولات التحقق كثيرة، حاول لاحقاً' }), async (req, res) => {
  try {
    const { userId, code } = req.body;
    if (!userId || !code) return res.status(400).json({ error: 'البيانات ناقصة' });

    const db = getDb();
    ensureIsVerifiedColumn(db);
    const user = getUserById(Number(userId));
    if (!user) return res.status(404).json({ error: 'المستخدم غير موجود' });
    if (user.isVerified) {
      return res.status(400).json({ error: 'تعذر التحقق من الحساب. سجّل الدخول أو اطلب رمزاً جديداً.' });
    }

    const check = verifyOtp(Number(userId), 'verify', code);
    if (!check.ok) return res.status(400).json({ error: check.error });

    db.prepare('UPDATE users SET is_verified = 1, updated_at = ? WHERE id = ?').run(nowIso(), Number(userId));
    const freshUser = getUserById(Number(userId));

    await sendEmail({
      to: freshUser.email,
      subject: '🎉 أهلاً بك في السلسبيل!',
      html: emailWelcomeHtml(freshUser.firstName),
    });

    return res.json({ token: signToken(freshUser), user: serializeUser(db, freshUser) });
  } catch (error) {
    return res.status(500).json({ error: 'خطأ في الخادم' });
  }
});

// POST /resend-verify
router.post('/resend-verify', rateLimit({ windowMs: 15 * 60 * 1000, max: 5, message: 'طلبات إعادة الإرسال كثيرة، حاول لاحقاً' }), async (req, res) => {
  try {
    const { userId } = req.body;
    const user = getUserById(Number(userId));
    if (!user) return res.status(404).json({ error: 'المستخدم غير موجود' });
    if (user.isVerified) return res.status(400).json({ error: 'الحساب مفعّل مسبقاً' });

    const code = genCode();
    saveOtp(user.id, 'verify', code, 10);
    await sendEmail({
      to: user.email,
      subject: '🔄 رمز تأكيد جديد — السلسبيل',
      html: emailVerifyHtml(user.firstName, code),
    });
    return res.json({ message: 'تم إرسال رمز جديد إلى بريدك الإلكتروني' });
  } catch (error) {
    return res.status(500).json({ error: 'خطأ في الخادم' });
  }
});

// POST /login
router.post('/login', rateLimit({ windowMs: 15 * 60 * 1000, max: 10, message: 'محاولات الدخول كثيرة، حاول لاحقاً' }), async (req, res) => {
  try {
    const loginValue = req.body.login || req.body.email || '';
    const { password } = req.body;
    if (!loginValue || !password)
      return res.status(400).json({ error: 'أدخل البريد أو اسم المستخدم وكلمة المرور' });

    const user = findUserByLogin(loginValue);
    if (!user || !(await bcrypt.compare(password, user.passwordHash)))
      return res.status(401).json({ error: 'اسم المستخدم أو البريد الإلكتروني أو كلمة المرور غير صحيحة' });

    if (!user.isVerified)
      return res.status(403).json({ error: 'يرجى تأكيد بريدك الإلكتروني أولاً', requireVerify: true, userId: user.id });

    return res.json({ token: signToken(user), user: serializeUser(getDb(), user) });
  } catch (error) {
    return res.status(500).json({ error: 'تعذر تسجيل الدخول' });
  }
});

// POST /forgot-password — يرسل رمز إعادة التعيين
router.post('/forgot-password', rateLimit({ windowMs: 15 * 60 * 1000, max: 5, message: 'طلبات الاستعادة كثيرة، حاول لاحقاً' }), async (req, res) => {
  try {
    const email = normalizeEmail(req.body.email || '');
    if (!email) return res.status(400).json({ error: 'أدخل بريدك الإلكتروني' });

    const user = getUserByEmail(email);
    // نرسل نفس الرد دائماً لحماية الخصوصية
    if (user && user.isVerified) {
      const code = genCode();
      saveOtp(user.id, 'reset', code, 15);
      await sendEmail({
        to: user.email,
        subject: '🔑 رمز إعادة تعيين كلمة المرور — السلسبيل',
        html: emailResetHtml(user.firstName, code),
      });
    }
    return res.json({ message: 'إذا كان البريد مسجلاً، ستصل رسالة خلال لحظات' });
  } catch (error) {
    return res.status(500).json({ error: 'خطأ في الخادم' });
  }
});

// POST /reset-password
router.post('/reset-password', rateLimit({ windowMs: 15 * 60 * 1000, max: 10, message: 'محاولات كثيرة، حاول لاحقاً' }), async (req, res) => {
  try {
    const { email, code, newPassword } = req.body;
    if (!email || !code || !newPassword) return res.status(400).json({ error: 'البيانات ناقصة' });

    validatePasswordOrThrow(newPassword);

    const user = getUserByEmail(normalizeEmail(email));
    if (!user || !user.isVerified) return res.status(400).json({ error: 'رمز التحقق غير صحيح أو منتهي الصلاحية' });

    const check = verifyOtp(user.id, 'reset', code);
    if (!check.ok) return res.status(400).json({ error: check.error });

    const passwordHash = await bcrypt.hash(newPassword, 12);
    getDb().prepare('UPDATE users SET password_hash = ?, updated_at = ? WHERE id = ?')
      .run(passwordHash, nowIso(), user.id);

    return res.json({ message: 'تم تغيير كلمة المرور بنجاح، يمكنك تسجيل الدخول الآن' });
  } catch (error) {
    return res.status(error.statusCode || 500).json({ error: error.message || 'خطأ في الخادم' });
  }
});

// GET /me
router.get('/me', protect, (req, res) => {
  try {
    const freshUser = getUserById(req.user.id);
    return res.json({ user: serializeUser(getDb(), freshUser), orders: getUserOrders(freshUser.id) });
  } catch (error) {
    return res.status(500).json({ error: 'تعذر تحميل بيانات الحساب' });
  }
});

router.get('/dashboard', protect, (req, res) => {
  try {
    const db = getDb();
    const enrollments = db.prepare(`
      SELECT e.course_id, e.progress, e.completed_lessons_json, e.created_at AS enrolled_at,
             c.title, c.thumbnail, c.course_end_at, c.expired_action
      FROM enrollments e JOIN courses c ON c.id = e.course_id
      WHERE e.user_id = ? ORDER BY enrolled_at DESC
    `).all(req.user.id).map(row => ({
      courseId: row.course_id,
      title: row.title,
      thumbnail: row.thumbnail || null,
      progress: Number(row.progress || 0),
      watchedLessons: fromJson(row.completed_lessons_json, []),
      enrolledAt: row.enrolled_at,
      courseEndAt: row.course_end_at || null,
      expired: !!row.course_end_at && new Date(row.course_end_at).getTime() <= Date.now(),
      expiredAction: row.expired_action || 'keep',
    }));
    const posts = db.prepare(`
      SELECT p.id, p.title, p.body, p.image_url, p.created_at, p.course_id, c.title AS course_title,
             u.first_name || ' ' || u.last_name AS author_name, u.avatar_url AS author_avatar_url
      FROM posts p
      LEFT JOIN courses c ON c.id = p.course_id
      JOIN users u ON u.id = p.author_id
      WHERE p.is_published = 1 AND p.post_type = 'post' AND (p.course_id IS NULL OR EXISTS (
        SELECT 1 FROM enrollments e WHERE e.course_id = p.course_id AND e.user_id = ?
      ))
      ORDER BY p.created_at DESC LIMIT 50
    `).all(req.user.id);
    const messages = db.prepare(`
      SELECT COUNT(*)::int AS unread FROM messages WHERE recipient_id = ? AND is_read = 0
    `).get(req.user.id);
    return res.json({ enrollments, posts, unreadMessages: messages?.unread || 0 });
  } catch (error) {
    return res.status(500).json({ error: 'تعذر تحميل لوحة التحكم' });
  }
});

router.get('/announcements', (req, res) => {
  try {
    const posts = getDb().prepare(`
      SELECT p.id, p.title, p.body, p.image_url, p.created_at
      FROM posts p
      WHERE p.is_published = 1 AND p.post_type = 'announcement' AND p.course_id IS NULL
      ORDER BY p.created_at DESC LIMIT 10
    `).all();
    return res.json({ announcements: posts });
  } catch (error) {
    return res.status(500).json({ error: 'تعذر تحميل الإعلانات' });
  }
});

router.post('/courses/:courseId/lessons/:lessonId/progress', protect, (req, res) => {
  try {
    const courseId = Number(req.params.courseId);
    const lessonId = Number(req.params.lessonId);
    const watched = req.body?.watched !== false;
    const db = getDb();
    const enrollment = db.prepare('SELECT * FROM enrollments WHERE user_id = ? AND course_id = ?').get(req.user.id, courseId);
    if (!enrollment) return res.status(403).json({ error: 'يجب الاشتراك في الكورس أولاً' });
    const lesson = db.prepare('SELECT id FROM lessons WHERE id = ? AND course_id = ?').get(lessonId, courseId);
    if (!lesson) return res.status(404).json({ error: 'الدرس غير موجود' });
    const watchedLessons = new Set(fromJson(enrollment.completed_lessons_json, []).map(Number));
    watched ? watchedLessons.add(lessonId) : watchedLessons.delete(lessonId);
    const total = db.prepare('SELECT COUNT(*)::int AS count FROM lessons WHERE course_id = ?').get(courseId)?.count || 0;
    const progress = total ? Math.round((watchedLessons.size / total) * 100) : 0;
    db.prepare('UPDATE enrollments SET completed_lessons_json = ?, progress = ?, updated_at = ? WHERE id = ?')
      .run(toJson(Array.from(watchedLessons), []), progress, nowIso(), enrollment.id);
    return res.json({ courseId, lessonId, watched, progress, watchedLessons: Array.from(watchedLessons) });
  } catch (error) {
    return res.status(500).json({ error: 'تعذر حفظ تقدم الدرس' });
  }
});

router.get('/messages', protect, (req, res) => {
  try {
    const rows = getDb().prepare(`
      SELECT m.id, m.subject, m.body, m.image_url, m.is_read, m.created_at,
             m.sender_id, m.recipient_id,
             s.username AS sender_username, s.first_name AS sender_first_name,
             s.last_name AS sender_last_name, s.avatar_url AS sender_avatar_url,
             r.username AS recipient_username, r.first_name AS recipient_first_name,
             r.last_name AS recipient_last_name, r.avatar_url AS recipient_avatar_url
      FROM messages m JOIN users s ON s.id = m.sender_id JOIN users r ON r.id = m.recipient_id
      WHERE m.sender_id = ? OR m.recipient_id = ? ORDER BY m.created_at DESC LIMIT 100
    `).all(req.user.id, req.user.id);
    return res.json({ messages: rows });
  } catch (error) { return res.status(500).json({ error: 'تعذر تحميل الرسائل' }); }
});

router.get('/users/directory', protect, (req, res) => {
  try {
    const search = String(req.query?.search || '').trim().slice(0, 80);
    if (search.length < 2) return res.json({ users: [] });
    const pattern = `%${search.replace(/[%_]/g, '\\$&')}%`;
    const users = getDb().prepare(`
      SELECT id, username, first_name, last_name, role, avatar_url
      FROM users
      WHERE id <> ? AND (username ILIKE ? ESCAPE '\\' OR first_name ILIKE ? ESCAPE '\\' OR last_name ILIKE ? ESCAPE '\\')
      ORDER BY username ASC LIMIT 20
    `).all(req.user.id, pattern, pattern, pattern).map(user => ({
      id: user.id,
      username: user.username,
      name: [user.first_name, user.last_name].filter(Boolean).join(' ').trim(),
      role: user.role,
      avatarUrl: user.avatar_url,
    }));
    return res.json({ users });
  } catch (error) {
    return res.status(500).json({ error: 'تعذر تحميل قائمة المستخدمين' });
  }
});

router.post('/messages', protect, (req, res) => {
  try {
    const recipientId = Number(req.body?.recipientId);
    const subject = String(req.body?.subject || '').trim().slice(0, 160);
    const body = String(req.body?.body || '').trim().slice(0, 10000);
    const imageUrl = normalizeImageData(req.body?.imageUrl);
    if (!recipientId || (!body && !imageUrl) || recipientId === req.user.id) return res.status(400).json({ error: 'المستلم ونص الرسالة أو الصورة مطلوب' });
    const db = getDb();
    const recipient = db.prepare('SELECT id FROM users WHERE id = ?').get(recipientId);
    if (!recipient) return res.status(404).json({ error: 'المستخدم غير موجود' });
    const timestamp = nowIso();
    const result = runInTransaction((transactionDb) => {
      const inserted = transactionDb.prepare('INSERT INTO messages (sender_id, recipient_id, subject, body, image_url, created_at) VALUES (?, ?, ?, ?, ?, ?)').run(req.user.id, recipientId, subject, body, imageUrl, timestamp);
      transactionDb.prepare(`
        INSERT INTO notifications (user_id, type, title, body, link, entity_id, created_at)
        VALUES (?, 'message', ?, ?, 'messages', ?, ?)
      `).run(recipientId, `رسالة جديدة من ${req.user.firstName} ${req.user.lastName}`.trim(), body.slice(0, 180), inserted.lastInsertRowid, timestamp);
      return inserted;
    });
    return res.status(201).json({ id: result.lastInsertRowid });
  } catch (error) { return res.status(500).json({ error: 'تعذر إرسال الرسالة' }); }
});

router.patch('/messages/:id/read', protect, (req, res) => {
  const result = runInTransaction((db) => {
    const updated = db.prepare('UPDATE messages SET is_read = 1 WHERE id = ? AND recipient_id = ?').run(Number(req.params.id), req.user.id);
    if (updated.changes) {
      db.prepare("UPDATE notifications SET is_read = 1 WHERE user_id = ? AND type = 'message' AND entity_id = ?")
        .run(req.user.id, Number(req.params.id));
    }
    return updated;
  });
  return result.changes ? res.json({ success: true }) : res.status(404).json({ error: 'الرسالة غير موجودة' });
});

router.get('/notifications', protect, (req, res) => {
  try {
    const notifications = getDb().prepare(`
      SELECT id, type, title, body, link, is_read, created_at
      FROM notifications WHERE user_id = ? ORDER BY created_at DESC LIMIT 50
    `).all(req.user.id);
    const unread = getDb().prepare('SELECT COUNT(*) AS count FROM notifications WHERE user_id = ? AND is_read = 0').get(req.user.id);
    return res.json({ notifications, unread: Number(unread?.count || 0) });
  } catch (error) {
    return res.status(500).json({ error: 'تعذر تحميل الإشعارات' });
  }
});

router.patch('/notifications/read-all', protect, (req, res) => {
  getDb().prepare('UPDATE notifications SET is_read = 1 WHERE user_id = ? AND is_read = 0')
    .run(req.user.id);
  return res.json({ success: true });
});

router.patch('/notifications/:id/read', protect, (req, res) => {
  const result = getDb().prepare('UPDATE notifications SET is_read = 1 WHERE id = ? AND user_id = ?')
    .run(Number(req.params.id), req.user.id);
  return result.changes ? res.json({ success: true }) : res.status(404).json({ error: 'الإشعار غير موجود' });
});

// PUT /profile
router.put('/profile', protect, async (req, res) => {
  try {
    const { username, phone, currentPassword, newPassword } = req.body;
    const legacyName = req.body?.name;
    const nameParts = legacyName ? splitName(legacyName) : {};
    const firstName = String(req.body?.firstName ?? nameParts.firstName ?? '').trim();
    const lastName = String(req.body?.lastName ?? nameParts.lastName ?? '').trim();
    const avatarUrl = normalizeImageData(req.body?.avatarUrl);
    if (!firstName || !lastName || !username) return res.status(400).json({ error: 'الاسم الأول واسم العائلة واسم المستخدم مطلوبة' });

    const user = getUserById(req.user.id);
    if (!user) return res.status(404).json({ error: 'المستخدم غير موجود' });

    validateUsernameOrThrow(username);
    const normalizedUsername = normalizeUsername(username);
    const existingUsername = getUserByUsername(normalizedUsername);
    if (existingUsername && existingUsername.id !== user.id)
      return res.status(400).json({ error: 'اسم المستخدم مستخدم بالفعل' });

    let passwordHash = user.passwordHash;
    if (newPassword) {
      validatePasswordOrThrow(newPassword);
      if (!(await bcrypt.compare(currentPassword || '', user.passwordHash)))
        return res.status(400).json({ error: 'كلمة المرور الحالية غير صحيحة' });
      passwordHash = await bcrypt.hash(newPassword, 12);
    }

    getDb().prepare(`
      UPDATE users SET first_name = ?, last_name = ?, username = ?, phone = ?, avatar_url = ?, password_hash = ?, updated_at = ? WHERE id = ?
    `).run(firstName, lastName, normalizedUsername, String(phone || ''), avatarUrl, passwordHash, nowIso(), user.id);

    return res.json({ user: serializeUser(getDb(), getUserById(user.id)) });
  } catch (error) {
    return res.status(error.statusCode || 500).json({ error: error.message || 'تعذر تحديث الحساب' });
  }
});

// GET /config
router.get('/config', (req, res) => {
  res.json({
    paymentEnabled: process.env.ENABLE_PAYMENTS !== 'false',
    tapPublicKey: process.env.TAP_PUBLIC_KEY || process.env.TAP_PK || '',
    tapCurrency: process.env.TAP_CURRENCY || 'SAR',
    paymentProvider: 'tap',
  });
});

// POST /checkout
router.post('/checkout', protect, async (req, res) => {
  try {
    const courseIds = Array.isArray(req.body.courseIds)
      ? [...new Set(req.body.courseIds.map(Number).filter(id => !Number.isNaN(id)))] : [];
    if (!courseIds.length) return res.status(400).json({ error: 'السلة فارغة' });

    const courses = getCourseRows({ publishedOnly: true, ids: courseIds });
    if (!courses.length) return res.status(404).json({ error: 'لم يتم العثور على الكورسات المطلوبة' });

    const placeholders = courses.map(() => '?').join(', ');
    const existingEnrollments = getDb().prepare(`
      SELECT course_id FROM enrollments WHERE user_id = ? AND course_id IN (${placeholders})
    `).all(req.user.id, ...courses.map(c => c.id));

    const existingCourseIds = new Set(existingEnrollments.map(item => item.course_id));
    const newCourses = courses.filter(c => !existingCourseIds.has(c.id));
    if (!newCourses.length) return res.status(400).json({ error: 'جميع الكورسات المحددة مشتَرَك فيها بالفعل' });
    if (newCourses.some(course => Number(course.price || 0) > 0)) {
      return res.status(402).json({ error: 'يجب إتمام الدفع عبر مزود الدفع قبل تفعيل الاشتراك' });
    }

    const paypalOrderId = req.body.paypalOrderId;
    const orderId = paypalOrderId ? `PP-${paypalOrderId}` : `HF-${Date.now().toString(36).toUpperCase()}`;
    const totalAmount = newCourses.reduce((sum, c) => sum + Number(c.price || 0), 0);
    const timestamp = nowIso();

    const createdOrder = runInTransaction((db) => {
      const orderResult = db.prepare(`
        INSERT INTO orders (order_id, user_id, total_amount, status, created_at, updated_at)
        VALUES (?, ?, ?, 'paid', ?, ?)
      `).run(orderId, req.user.id, totalAmount, timestamp, timestamp);
      const sqliteOrderId = Number(orderResult.lastInsertRowid);
      newCourses.forEach(course => {
        db.prepare(`INSERT INTO order_items (order_id, course_id, course_title, price_at_time, created_at) VALUES (?, ?, ?, ?, ?)`)
          .run(sqliteOrderId, course.id, course.title, Number(course.price || 0), timestamp);
        db.prepare(`INSERT INTO enrollments (user_id, course_id, order_id, progress, completed_lessons_json, created_at, updated_at) VALUES (?, ?, ?, 0, '[]', ?, ?)`)
          .run(req.user.id, course.id, sqliteOrderId, timestamp, timestamp);
      });
      return db.prepare('SELECT * FROM orders WHERE id = ?').get(sqliteOrderId);
    });

    const freshUser = getUserById(req.user.id);
    const freshOrder = getUserOrders(req.user.id).find(o => o.orderId === createdOrder.order_id);

    // إرسال إيميل تأكيد الاشتراك
    const coursesList = newCourses.map(c => `<li style="margin:6px 0">📖 ${c.title}</li>`).join('');
    try {
      await sendEmail({
        to: freshUser.email,
        subject: '🎉 تم الاشتراك بنجاح — السلسبيل',
        html: tplHeader('🎉', 'بارك الله في علمك!') + `
          <p style="font-size:1.05rem;color:#2c1f0e">السلام عليكم <strong style="color:#1a6b4a">${freshUser.firstName}</strong> 🌸</p>
          <p style="color:#5a4220;line-height:1.8">تم تفعيل اشتراكك بنجاح في البرامج التالية:</p>
          <ul style="color:#2c1f0e;line-height:2;padding-right:20px">${coursesList}</ul>
          <div style="background:#f0f9f4;border-radius:10px;padding:16px;margin:20px 0;text-align:center">
            <p style="color:#1a6b4a;font-weight:700;margin:0">إجمالي الدفع: $${totalAmount}</p>
          </div>
          <div style="text-align:center;margin-top:24px">
            <a href="${CLIENT_URL()}" style="background:linear-gradient(135deg,#1a6b4a,#22865e);color:white;padding:14px 32px;border-radius:10px;text-decoration:none;font-weight:700">ادخل إلى المنصة الآن →</a>
          </div>
        ` + tplFooter()
      });
    } catch (emailErr) {
      console.error("Failed to send confirmation email, but order was processed:", emailErr);
    }

    return res.status(201).json({
      order: freshOrder || { orderId: createdOrder.order_id, total: Number(createdOrder.total_amount || 0), date: createdOrder.created_at, items: newCourses.map(c => ({ id: c.id, title: c.title, price: Number(c.price || 0) })) },
      user: serializeUser(getDb(), freshUser),
    });
  } catch (error) {
    return res.status(500).json({ error: 'تعذر إتمام الاشتراك' });
  }
});

// POST /contact — يرسل إيميل للمستخدم وللأدمن
router.post('/contact', rateLimit({ windowMs: 15 * 60 * 1000, max: 5, message: 'طلبات التواصل كثيرة، حاول لاحقاً' }), async (req, res) => {
  try {
    const { name, email, subject, msg } = req.body;
    if (!name || !email || !msg) return res.status(400).json({ error: 'يرجى إكمال جميع الحقول' });

    const cleanName = String(name).trim();
    const cleanEmail = String(email).trim().toLowerCase();
    const cleanSubject = String(subject || '').trim();
    const cleanMsg = String(msg).trim();

    getDb().prepare(`INSERT INTO contacts (name, email, subject, message, created_at) VALUES (?, ?, ?, ?, ?)`)
      .run(cleanName, cleanEmail, cleanSubject, cleanMsg, nowIso());

    // إرسال إيميل تأكيد للمستخدم (لا نوقف الطلب أو نُسقط الخادم إذا فشل الإرسال)
    sendEmail({
      to: cleanEmail,
      subject: '✅ تم استلام رسالتك — السلسبيل',
      html: emailContactUserHtml(cleanName, cleanSubject, cleanMsg),
    }).catch((emailError) => {
      console.error('Contact confirmation email failed:', emailError.message);
    });

    // إشعار الأدمن
    const adminEmail = ADMIN_EMAIL();
    if (adminEmail) {
      sendEmail({
        to: adminEmail,
        subject: `📬 رسالة جديدة من ${cleanName} — ${cleanSubject || 'بدون موضوع'}`,
        html: emailContactAdminHtml(cleanName, cleanEmail, cleanSubject, cleanMsg),
        templateId: process.env.EMAILJS_REPLY_TMPL,
        templateParams: {
          from_name: cleanName,
          from_email: cleanEmail,
          message: cleanMsg,
        },
      }).catch((emailError) => {
        console.error('Contact admin-notify email failed:', emailError.message);
      });
    }

    return res.status(201).json({ message: 'تم إرسال رسالتك بنجاح' });
  } catch (error) {
    return res.status(500).json({ error: 'تعذر إرسال الرسالة' });
  }
});

/* ══════════════════════════════════════════
   ADMIN ROUTES
══════════════════════════════════════════ */

// GET /admin/users
router.get('/admin/users', protect, isAdmin, (req, res) => {
  try {
    const db = getDb();
    const users = db.prepare('SELECT * FROM users ORDER BY created_at DESC').all().map(mapUserRow);
    if (!users.length) {
      return res.json({ users: [] });
    }

    const userIds = users.map(u => u.id);
    const placeholders = userIds.map(() => '?').join(',');

    // جلب كل الاشتراكات والطلبات دفعة واحدة لتحسين الأداء
    const enrollments = db.prepare(`
      SELECT e.user_id, e.course_id, c.title AS course_title 
      FROM enrollments e JOIN courses c ON c.id = e.course_id 
      WHERE e.user_id IN (${placeholders})
    `).all(...userIds);

    const orders = db.prepare(`
      SELECT user_id, order_id, total_amount 
      FROM orders 
      WHERE user_id IN (${placeholders}) AND status IN ('paid', 'manual')
    `).all(...userIds);

    // تجميع البيانات حسب المستخدم
    const enrollmentsMap = enrollments.reduce((map, e) => map.set(e.user_id, [...(map.get(e.user_id) || []), e]), new Map());
    const ordersMap = orders.reduce((map, o) => map.set(o.user_id, [...(map.get(o.user_id) || []), o]), new Map());

    // بناء الاستجابة النهائية
    const serializedUsers = users.map(user => {
      const userEnrollments = enrollmentsMap.get(user.id) || [];
      const userOrders = ordersMap.get(user.id) || [];
      return {
        id: user.id, username: user.username, email: user.email,
        name: [user.firstName, user.lastName].filter(Boolean).join(' ').trim(),
        phone: user.phone || '', role: user.role, isAdmin: user.role === 'admin',
        isVerified: user.isVerified, joinDate: user.createdAt,
        enrolledCourses: userEnrollments.map(e => e.course_id),
        enrolledCourseTitles: userEnrollments.map(e => e.course_title),
        totalSpent: userOrders.reduce((sum, o) => sum + Number(o.total_amount || 0), 0),
        orders: userOrders.map(o => o.order_id),
      };
    });

    return res.json({ users: serializedUsers });
  } catch (error) {
    return res.status(500).json({ error: 'تعذر تحميل المستخدمين' });
  }
});

// POST /admin/users — إنشاء مستخدم/أدمن يدوياً
router.post('/admin/users', protect, isAdmin, async (req, res) => {
  try {
    const { name, username, email, password, role, courseId } = req.body;
    if (!name || !username || !email || !password)
      return res.status(400).json({ error: 'يرجى إدخال الاسم واسم المستخدم والبريد وكلمة المرور' });

    validateUsernameOrThrow(username);
    validatePasswordOrThrow(password);

    const normalizedEmail = normalizeEmail(email);
    const normalizedUsername = normalizeUsername(username);
    const normalizedRole = ['user', 'student', 'admin', 'teacher', 'instructor'].includes(role) ? role : 'student';

    if (getUserByEmail(normalizedEmail)) return res.status(400).json({ error: 'هذا البريد الإلكتروني مسجل بالفعل' });
    if (getUserByUsername(normalizedUsername)) return res.status(400).json({ error: 'اسم المستخدم مستخدم بالفعل' });

    const { firstName, lastName } = splitName(name);
    const passwordHash = await bcrypt.hash(password, 12);
    const timestamp = nowIso();

    const createdUserId = runInTransaction((db) => {
      ensureIsVerifiedColumn(db);
      const userResult = db.prepare(`
        INSERT INTO users (first_name, last_name, username, email, phone, password_hash, role, is_verified, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, 1, ?, ?)
      `).run(firstName, lastName, normalizedUsername, normalizedEmail, '', passwordHash, normalizedRole, timestamp, timestamp);
      const userId = Number(userResult.lastInsertRowid);
      const normalizedCourseId = Number(courseId || 0);
      if (!Number.isNaN(normalizedCourseId) && normalizedCourseId > 0) {
        createEnrollmentForUser(db, userId, normalizedCourseId, {
          orderPrefix: normalizedRole === 'admin' ? 'ADM' : 'MANUAL',
          totalAmount: 0, status: 'manual',
        });
      }
      return userId;
    });

    return res.status(201).json({
      user: serializeUser(getDb(), getUserById(createdUserId)),
      message: 'تم إنشاء الحساب وتفعيله مباشرة دون إرسال رمز تحقق',
      verificationSkipped: true,
    });
  } catch (error) {
    return res.status(error.statusCode || 500).json({ error: error.message || 'تعذر إنشاء المستخدم' });
  }
});

// POST /admin/users/:id/enroll — تسجيل مستخدم في كورس يدوياً
router.post('/admin/users/:id/enroll', protect, isAdmin, (req, res) => {
  try {
    const userId = Number(req.params.id);
    const courseId = Number(req.body.courseId);
    if (!userId || !courseId) return res.status(400).json({ error: 'بيانات ناقصة' });

    const user = getUserById(userId);
    if (!user) return res.status(404).json({ error: 'المستخدم غير موجود' });

    let enrolled = false;
    runInTransaction((db) => {
      const result = createEnrollmentForUser(db, userId, courseId, { orderPrefix: 'MANUAL', totalAmount: 0, status: 'manual' });
      enrolled = result !== null;
    });

    if (!enrolled) return res.status(400).json({ error: 'المستخدم مسجل في هذا الكورس بالفعل' });
    return res.json({ message: 'تم تسجيل المستخدم في الكورس بنجاح', user: serializeUser(getDb(), getUserById(userId)) });
  } catch (error) {
    return res.status(error.statusCode || 500).json({ error: error.message || 'تعذر التسجيل في الكورس' });
  }
});

router.post('/admin/users/:id/reset-password', protect, isAdmin, async (req, res) => {
  try {
    const userId = Number(req.params.id);
    const temporaryPassword = String(req.body?.temporaryPassword || '');
    validatePasswordOrThrow(temporaryPassword);
    const user = getUserById(userId);
    if (!user) return res.status(404).json({ error: 'المستخدم غير موجود' });
    const passwordHash = await bcrypt.hash(temporaryPassword, 12);
    getDb().prepare('UPDATE users SET password_hash = ?, updated_at = ? WHERE id = ?')
      .run(passwordHash, nowIso(), userId);
    return res.json({ success: true, message: 'تم تعيين كلمة مرور مؤقتة. لا يتم تخزينها أو إظهارها مرة أخرى.' });
  } catch (error) {
    return res.status(400).json({ error: error.message || 'تعذر إعادة تعيين كلمة المرور' });
  }
});

// POST /admin/users/:id/unenroll — إزالة مستخدم من كورس يدوياً
router.post('/admin/users/:id/unenroll', protect, isAdmin, (req, res) => {
  try {
    const userId = Number(req.params.id);
    const courseId = Number(req.body.courseId);
    if (!userId || !courseId) return res.status(400).json({ error: 'بيانات ناقصة' });

    const user = getUserById(userId);
    if (!user) return res.status(404).json({ error: 'المستخدم غير موجود' });

    let unenrolled = false;
    runInTransaction((db) => {
      const existingEnrollment = db.prepare('SELECT id FROM enrollments WHERE user_id = ? AND course_id = ?').get(userId, courseId);
      if (existingEnrollment) {
        db.prepare('DELETE FROM enrollments WHERE id = ?').run(existingEnrollment.id);
        unenrolled = true;
      }
    });

    if (!unenrolled) return res.status(400).json({ error: 'المستخدم غير مسجل في هذا الكورس' });
    return res.json({ message: 'تم إزالة المستخدم من الكورس بنجاح', user: serializeUser(getDb(), getUserById(userId)) });
  } catch (error) {
    return res.status(error.statusCode || 500).json({ error: error.message || 'تعذر الإزالة من الكورس' });
  }
});

// PUT /admin/users/:id/role — ترقية/تخفيض دور مستخدم
router.put('/admin/users/:id/role', protect, isAdmin, (req, res) => {
  try {
    const userId = Number(req.params.id);
    const { role } = req.body;
    if (!userId || !['user', 'student', 'teacher', 'admin'].includes(role))
      return res.status(400).json({ error: 'بيانات غير صالحة' });
    if (userId === req.user.id)
      return res.status(400).json({ error: 'لا يمكنك تغيير دورك الخاص' });

    const user = getUserById(userId);
    if (!user) return res.status(404).json({ error: 'المستخدم غير موجود' });

    getDb().prepare('UPDATE users SET role = ?, updated_at = ? WHERE id = ?').run(role, nowIso(), userId);
    const roleNames = { user: 'مستخدم', student: 'طالب', teacher: 'معلم', admin: 'مدير' };
    return res.json({ message: `تم تغيير الدور إلى ${roleNames[role]}`, user: serializeUser(getDb(), getUserById(userId)) });
  } catch (error) {
    return res.status(500).json({ error: 'تعذر تغيير الدور' });
  }
});

// GET /admin/contacts — عرض رسائل التواصل
router.get('/admin/contacts', protect, isAdmin, (req, res) => {
  try {
    const rows = getDb().prepare('SELECT * FROM contacts ORDER BY created_at DESC').all();
    return res.json({ contacts: rows });
  } catch (error) {
    return res.status(500).json({ error: 'تعذر تحميل الرسائل' });
  }
});

// ── CATEGORIES ──

router.get('/admin/categories', protect, isAdmin, (req, res) => {
  try {
    const categories = getDb().prepare('SELECT * FROM categories ORDER BY name ASC').all();
    res.json({ categories });
  } catch (e) {
    res.status(500).json({ error: 'تعذر جلب التصنيفات' });
  }
});

router.post('/admin/categories', protect, isAdmin, (req, res) => {
  const { name, slug } = req.body;
  if (!name || !slug) {
    return res.status(400).json({ error: 'الاسم والاسم اللطيف (slug) مطلوبان' });
  }
  try {
    const result = getDb().prepare('INSERT INTO categories (name, slug, created_at) VALUES (?, ?, ?)')
      .run(name.trim(), slug.trim(), nowIso());
    const newCategory = getDb().prepare('SELECT * FROM categories WHERE id = ?').get(result.lastInsertRowid);
    res.status(201).json({ category: newCategory });
  } catch (e) {
    if (e.code === 'SQLITE_CONSTRAINT_UNIQUE') {
      return res.status(400).json({ error: 'هذا التصنيف أو الاسم اللطيف موجود بالفعل' });
    }
    res.status(500).json({ error: 'تعذر إضافة التصنيف' });
  }
});

router.put('/admin/categories/:id', protect, isAdmin, (req, res) => {
  const { name, slug } = req.body;
  const id = Number(req.params.id);
  if (!name || !slug) return res.status(400).json({ error: 'الاسم والاسم اللطيف (slug) مطلوبان' });
  try {
    getDb().prepare('UPDATE categories SET name = ?, slug = ? WHERE id = ?').run(name.trim(), slug.trim(), id);
    res.json({ success: true });
  } catch (e) { res.status(500).json({ error: 'تعذر تحديث التصنيف' }); }
});

router.delete('/admin/categories/:id', protect, isAdmin, (req, res) => {
  try {
    getDb().prepare('DELETE FROM categories WHERE id = ?').run(Number(req.params.id));
    res.json({ success: true });
  } catch (e) { res.status(500).json({ error: 'تعذر حذف التصنيف' }); }
});

// ── COURSES ──

router.post('/admin/courses', protect, isAdmin, (req, res) => {
  try {
    const payload = buildCoursePayload(req.body);
    if (!payload.title || payload.price === undefined) return res.status(400).json({ error: 'اسم الكورس والسعر مطلوبان' });
    const courseId = getNextCourseId();
    const timestamp = nowIso();
    getDb().prepare(`
      INSERT INTO courses (id, title, category, emoji, bg, badge, level, price, old_price, duration_label, students_count, rating, description, includes_json, thumbnail, lifetime_access, is_published, course_end_at, expired_action, teacher_id, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(courseId, payload.title, payload.category, payload.emoji, payload.bg, payload.badge, payload.level, payload.price, payload.oldPrice, payload.durationLabel, payload.studentsCount, payload.rating, payload.description, toJson(payload.includes, []), payload.thumbnail, boolToInt(payload.lifetimeAccess), boolToInt(payload.isPublished), payload.courseEndAt, payload.expiredAction, payload.teacherId, timestamp, timestamp);
    return res.status(201).json({ course: getSerializedCourseById(courseId) });
  } catch (error) { return res.status(500).json({ error: 'تعذر حفظ الكورس' }); }
});

router.put('/admin/courses/:id', protect, isAdmin, (req, res) => {
  try {
    const courseId = Number(req.params.id);
    const existingCourse = getCourseRowById(courseId);
    if (!existingCourse) return res.status(404).json({ error: 'الكورس غير موجود' });
    const payload = buildCoursePayload(req.body, existingCourse);
    getDb().prepare(`
      UPDATE courses SET title=?, category=?, emoji=?, bg=?, badge=?, level=?, price=?, old_price=?, duration_label=?, students_count=?, rating=?, description=?, includes_json=?, thumbnail=?, lifetime_access=?, is_published=?, course_end_at=?, expired_action=?, teacher_id=?, updated_at=? WHERE id=?
    `).run(payload.title, payload.category, payload.emoji, payload.bg, payload.badge, payload.level, payload.price, payload.oldPrice, payload.durationLabel, payload.studentsCount, payload.rating, payload.description, toJson(payload.includes, []), payload.thumbnail, boolToInt(payload.lifetimeAccess), boolToInt(payload.isPublished), payload.courseEndAt, payload.expiredAction, payload.teacherId, nowIso(), courseId);
    return res.json({ course: getSerializedCourseById(courseId) });
  } catch (error) { return res.status(500).json({ error: 'تعذر تحديث الكورس' }); }
});

router.delete('/admin/courses/:id', protect, isAdmin, (req, res) => {
  try {
    const courseId = Number(req.params.id);
    if (!getCourseRowById(courseId)) return res.status(404).json({ error: 'الكورس غير موجود' });
    runInTransaction((db) => {
      db.prepare('DELETE FROM enrollments WHERE course_id = ?').run(courseId);
      db.prepare('DELETE FROM courses WHERE id = ?').run(courseId);
    });

    return res.json({ success: true });
  } catch (error) { return res.status(500).json({ error: 'تعذر حذف الكورس' }); }
});

router.post('/admin/posts', protect, canPublish, (req, res) => {
  try {
    const title = String(req.body?.title || '').trim().slice(0, 200);
    const body = String(req.body?.body || '').trim().slice(0, 30000);
    const imageUrl = normalizeImageData(req.body?.imageUrl);
    const courseId = req.body?.courseId ? Number(req.body.courseId) : null;
    const postType = req.body?.postType === 'announcement' ? 'announcement' : 'post';
    if (postType === 'announcement' && req.user.role !== 'admin') {
      return res.status(403).json({ error: 'الإعلانات متاحة للمدير فقط' });
    }
    if (['teacher', 'instructor'].includes(req.user.role) && courseId) {
      const assigned = getDb().prepare('SELECT id FROM courses WHERE id = ? AND teacher_id = ?').get(courseId, req.user.id);
      if (!assigned) return res.status(403).json({ error: 'يمكنك النشر فقط في كورساتك المسندة إليك' });
    }
    if (postType === 'announcement' && courseId) return res.status(400).json({ error: 'الإعلان يجب أن يكون عاماً ولا يرتبط بكورس' });
    if (!title || !body) return res.status(400).json({ error: 'العنوان والمحتوى مطلوبان' });
    if (courseId && !getDb().prepare('SELECT id FROM courses WHERE id = ?').get(courseId))
      return res.status(404).json({ error: 'الكورس غير موجود' });
    const timestamp = nowIso();
    const result = runInTransaction((db) => {
      const inserted = db.prepare(`
        INSERT INTO posts (author_id, course_id, title, body, image_url, post_type, is_published, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(req.user.id, courseId, title, body, imageUrl, postType, req.body.isPublished === false ? 0 : 1, timestamp, timestamp);
      if (req.body.isPublished !== false) {
        const notificationType = postType === 'announcement' ? 'announcement' : 'post';
        const notificationTitle = `${postType === 'announcement' ? 'إعلان' : 'منشور'} جديد: ${title}`;
        const notificationBody = body.slice(0, 180);
        if (courseId) {
          db.prepare(`
            INSERT INTO notifications (user_id, type, title, body, link, entity_id, created_at)
            SELECT e.user_id, ?, ?, ?, 'community', ?, ?
            FROM enrollments e
            WHERE e.course_id = ? AND e.user_id <> ?
          `).run(notificationType, notificationTitle, notificationBody, inserted.lastInsertRowid, timestamp, courseId, req.user.id);
        } else {
          db.prepare(`
            INSERT INTO notifications (user_id, type, title, body, link, entity_id, created_at)
            SELECT id, ?, ?, ?, 'community', ?, ? FROM users WHERE id <> ?
          `).run(notificationType, notificationTitle, notificationBody, inserted.lastInsertRowid, timestamp, req.user.id);
        }
      }
      return inserted;
    });
    return res.status(201).json({ id: result.lastInsertRowid });
  } catch (error) { return res.status(500).json({ error: 'تعذر نشر المقال' }); }
});

// GET /teacher/students — طلاب الكورسات المسندة للمعلم فقط
router.get('/teacher/students', protect, (req, res) => {
  try {
    if (!['teacher', 'instructor', 'admin'].includes(req.user.role))
      return res.status(403).json({ error: 'هذه الصفحة متاحة للمعلمين والمدير فقط' });
    const teacherId = req.user.role === 'admin' && req.query.teacherId ? Number(req.query.teacherId) : req.user.id;
    const rows = getDb().prepare(`
      SELECT c.id AS course_id, c.title AS course_title,
             u.id AS user_id, u.first_name, u.last_name, u.username, u.email,
             e.progress, e.created_at AS enrolled_at
      FROM courses c
      LEFT JOIN enrollments e ON e.course_id = c.id
      LEFT JOIN users u ON u.id = e.user_id
      WHERE c.teacher_id = ? AND (u.id IS NULL OR u.role IN ('user', 'student'))
      ORDER BY c.title ASC, u.first_name ASC, u.last_name ASC
    `).all(teacherId);
    const courses = new Map();
    rows.forEach(row => {
      if (!courses.has(row.course_id)) courses.set(row.course_id, { id: row.course_id, title: row.course_title, students: [] });
      if (row.user_id) courses.get(row.course_id).students.push({
        id: row.user_id,
        name: [row.first_name, row.last_name].filter(Boolean).join(' ').trim(),
        username: row.username,
        email: row.email,
        progress: Number(row.progress || 0),
        enrolledAt: row.enrolled_at,
      });
    });
    return res.json({ courses: Array.from(courses.values()) });
  } catch (error) {
    return res.status(500).json({ error: 'تعذر تحميل طلاب الكورسات' });
  }
});

router.get('/admin/posts', protect, canPublish, (req, res) => {
  try {
    const ownPostsOnly = ['teacher', 'instructor'].includes(req.user.role);
    const posts = getDb().prepare(`
      SELECT p.id, p.title, p.body, p.image_url, p.post_type, p.course_id, p.is_published, p.created_at,
             c.title AS course_title
      FROM posts p LEFT JOIN courses c ON c.id = p.course_id
      ${ownPostsOnly ? 'WHERE p.author_id = ?' : ''}
      ORDER BY p.created_at DESC LIMIT 200
    `).all(...(ownPostsOnly ? [req.user.id] : []));
    return res.json({ posts });
  } catch (error) {
    return res.status(500).json({ error: 'تعذر تحميل المنشورات' });
  }
});

router.put('/admin/posts/:id', protect, isAdmin, (req, res) => {
  try {
    const id = Number(req.params.id);
    const title = String(req.body?.title || '').trim().slice(0, 200);
    const body = String(req.body?.body || '').trim().slice(0, 30000);
    const imageUrl = normalizeImageData(req.body?.imageUrl);
    const courseId = req.body?.courseId ? Number(req.body.courseId) : null;
    const postType = req.body?.postType === 'announcement' ? 'announcement' : 'post';
    if (postType === 'announcement' && courseId) return res.status(400).json({ error: 'الإعلان يجب أن يكون عاماً ولا يرتبط بكورس' });
    if (!title || !body) return res.status(400).json({ error: 'العنوان والمحتوى مطلوبان' });
    if (courseId && !getDb().prepare('SELECT id FROM courses WHERE id = ?').get(courseId))
      return res.status(404).json({ error: 'الكورس غير موجود' });
    const result = getDb().prepare(`
      UPDATE posts SET title = ?, body = ?, image_url = ?, course_id = ?, post_type = ?, is_published = ?, updated_at = ?
      WHERE id = ?
    `).run(title, body, imageUrl, courseId, postType, req.body.isPublished === false ? 0 : 1, nowIso(), id);
    return result.changes ? res.json({ success: true }) : res.status(404).json({ error: 'المنشور غير موجود' });
  } catch (error) {
    return res.status(500).json({ error: 'تعذر تحديث المنشور' });
  }
});

router.delete('/admin/posts/:id', protect, isAdmin, (req, res) => {
  try {
    const result = getDb().prepare('DELETE FROM posts WHERE id = ?').run(Number(req.params.id));
    return result.changes ? res.json({ success: true }) : res.status(404).json({ error: 'المنشور غير موجود' });
  } catch (error) {
    return res.status(500).json({ error: 'تعذر حذف المنشور' });
  }
});

router.post('/admin/courses/:id/lessons', protect, isAdmin, (req, res, next) => {
  uploadHandler(req, res, function (err) {
    if (err instanceof multer.MulterError) {
      return res.status(400).json({ error: 'حجم الفيديو كبير جداً أو خطأ في الرفع (الحد الأقصى 2GB)' });
    } else if (err) {
      return res.status(500).json({ error: err.message || 'تعذر معالجة الملف' });
    }
    next();
  });
}, async function(req, res, next) {
  try {
    const courseId = Number(req.params.id);
    if (!getCourseRowById(courseId)) return res.status(404).json({ error: 'الكورس غير موجود' });
    const { title, duration, url, free } = req.body;
    
    let videoUrl = String(url || '').trim();
    
    if (req.file) {
      try {
        const result = await new Promise((resolve, reject) => {
          const stream = cloudinary.uploader.upload_stream(
            { resource_type: 'video', folder: `hifz-platform/courses/${courseId}` },
            (error, result) => error ? reject(error) : resolve(result)
          );
          stream.end(req.file.buffer);
        });
        videoUrl = result.secure_url;
      } catch (uploadErr) {
        return res.status(500).json({ error: 'حدث خطأ أثناء رفع الفيديو لسحابة Cloudinary' });
      }
    }
    
    if (!title || (!videoUrl && !req.body.videoData)) return res.status(400).json({ error: 'أدخل عنوان الدرس ومصدر الفيديو' });
    const db = getDb();
    const nextOrderRow = db.prepare('SELECT COALESCE(MAX(lesson_order), 0) + 1 AS next_order FROM lessons WHERE course_id = ?').get(courseId);
    const timestamp = nowIso();
    db.prepare(`
      INSERT INTO lessons (course_id, title, description, duration_label, external_url, video_url, video_data, is_free, lesson_order, added_at, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(courseId, String(title).trim(), '', String(duration || ''), String(url || ''), videoUrl, String(req.body.videoData || ''), boolToInt(free === 'true' || free === true), nextOrderRow?.next_order || 1, timestamp, timestamp, timestamp);
    return res.status(201).json({ course: getSerializedCourseById(courseId) });
  } catch (error) { return res.status(500).json({ error: 'تعذر إضافة الدرس' }); }
});

router.delete('/admin/courses/:id/lessons/:lessonIndex', protect, isAdmin, (req, res) => {
  try {
    const courseId = Number(req.params.id);
    if (!getCourseRowById(courseId)) return res.status(404).json({ error: 'الكورس غير موجود' });
    const lessonIndex = Number(req.params.lessonIndex);
    const lessons = getDb().prepare('SELECT id FROM lessons WHERE course_id = ? ORDER BY lesson_order ASC, id ASC').all(courseId);
    if (Number.isNaN(lessonIndex) || lessonIndex < 0 || lessonIndex >= lessons.length)
      return res.status(404).json({ error: 'الدرس غير موجود' });
    runInTransaction((db) => {
      db.prepare('DELETE FROM lessons WHERE id = ?').run(lessons[lessonIndex].id);
      db.prepare('SELECT id FROM lessons WHERE course_id = ? ORDER BY lesson_order ASC, id ASC').all(courseId)
        .forEach((lesson, index) => db.prepare('UPDATE lessons SET lesson_order = ?, updated_at = ? WHERE id = ?').run(index + 1, nowIso(), lesson.id));
    });
    return res.json({ course: getSerializedCourseById(courseId) });
  } catch (error) { return res.status(500).json({ error: 'تعذر حذف الدرس' }); }
});

module.exports = router;
