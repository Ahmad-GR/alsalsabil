let paypal;
let client;
let paypalIntegrationEnabled = true;

try {
  paypal = require('@paypal/checkout-server-sdk');
} catch (err) {
  paypalIntegrationEnabled = false;
  console.warn('PayPal SDK not installed: @paypal/checkout-server-sdk. Run npm install @paypal/checkout-server-sdk.');
}

if (paypalIntegrationEnabled) {
  // 1. إعداد بيئة باي بال
  //    استخدم SandboxEnvironment للاختبار و LiveEnvironment للبيئة الحقيقية
  const environment = process.env.NODE_ENV === 'production'
    ? new paypal.core.LiveEnvironment(process.env.PAYPAL_CLIENT_ID, process.env.PAYPAL_CLIENT_SECRET)
    : new paypal.core.SandboxEnvironment(process.env.PAYPAL_CLIENT_ID, process.env.PAYPAL_CLIENT_SECRET);

  client = new paypal.core.PayPalHttpClient(environment);

  console.log(`PayPal SDK initialized in ${process.env.NODE_ENV === 'production' ? 'Live' : 'Sandbox'} mode.`);
}

/**
 * إنشاء طلب دفع في باي بال
 * @param {number} totalAmount - المبلغ الإجمالي للطلب
 * @param {Array} courses - قائمة الكورسات لتفاصيل الشراء
 * @returns {Promise<object>} تفاصيل الطلب الذي تم إنشاؤه
 */
async function createOrder(totalAmount, courses) {
  if (!paypalIntegrationEnabled) {
    throw new Error('PayPal integration غير متاحة: قم بتثبيت @paypal/checkout-server-sdk');
  }
  const request = new paypal.orders.OrdersCreateRequest();
  request.prefer("return=representation");

  // ملاحظة: باي بال لا يدعم الريال السعودي (SAR) بشكل جيد في بيئة الاختبار
  // لذا سنستخدم الدولار الأمريكي (USD) هنا. يجب التحقق من دعم SAR في البيئة الحقيقية.
  const currency = 'USD';
  const exchangeRate = 3.75;

  const items = courses.map(course => ({
    name: course.title.substring(0, 127), // الحد الأقصى لعدد الحروف في باي بال
    unit_amount: {
      currency_code: currency,
      value: (course.price / exchangeRate).toFixed(2),
    },
    quantity: '1',
    category: 'DIGITAL_GOODS',
  }));

  // حساب المجموع الكلي من أسعار المنتجات بعد التقريب لتجنب أخطاء باي بال
  const itemTotalValue = items.reduce((sum, item) => sum + parseFloat(item.unit_amount.value), 0).toFixed(2);

  request.requestBody({
    intent: 'CAPTURE',
    purchase_units: [{
      amount: {
        currency_code: currency,
        value: itemTotalValue, // استخدام المجموع المحسوب لضمان التطابق
        breakdown: {
          item_total: {
            currency_code: currency,
            value: itemTotalValue,
          },
        },
      },
      items: items,
    }],
  });

  const order = await client.execute(request);
  return order.result;
}

/**
 * تأكيد الدفع لطلب باي بال
 * @param {string} orderId - معرف طلب باي بال
 * @returns {Promise<object>} تفاصيل عملية الدفع المؤكدة
 */
async function captureOrder(orderId) {
  if (!paypalIntegrationEnabled) {
    throw new Error('PayPal integration غير متاحة: قم بتثبيت @paypal/checkout-server-sdk');
  }
  const request = new paypal.orders.OrdersCaptureRequest(orderId);
  request.requestBody({});

  const capture = await client.execute(request);
  return capture.result;
}

/**
 * يتحقق من صحة توقيع إشعار PayPal (Webhook) لضمان أنه قادم من PayPal بالفعل.
 * @param {object} params - معلومات الإشعار.
 * @param {string} params.transmissionId - مُعرف الإرسال من رأس الطلب.
 * @param {string} params.transmissionTime - وقت الإرسال من رأس الطلب.
 * @param {string} params.signature - التوقيع من رأس الطلب.
 * @param {string} params.webhookId - مُعرف الـ Webhook الخاص بك من إعدادات PayPal.
 * @param {object} params.webhookBody - جسم الطلب (body) كما هو.
 * @returns {Promise<boolean>} - `true` إذا كان التوقيع صحيحًا.
 */
async function verifyPayPalWebhookSignature({ transmissionId, transmissionTime, signature, webhookId, webhookBody }) {
  if (!paypalIntegrationEnabled) {
    throw new Error('PayPal integration غير متاحة.');
  }
  if (!transmissionId || !transmissionTime || !signature || !webhookId) {
    console.error('PayPal Webhook Verification: Missing headers or webhook ID.');
    return false;
  }

  try {
    const { verification_status } = await paypal.webhooks.WebhooksVerifySignatureRequest.verify(client, transmissionId, transmissionTime, signature, webhookId, JSON.stringify(webhookBody));
    return verification_status === 'SUCCESS';
  } catch (err) {
    console.error('PayPal Webhook Signature Verification Error:', err.message);
    return false;
  }
}

module.exports = {
  createOrder,
  captureOrder,
  verifyPayPalWebhookSignature,
};