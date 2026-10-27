const axios = require('axios');
const crypto = require('crypto');

const TAP_BASE_URL = 'https://api.tap.company/v2';

function getTapSecretKey() {
  return process.env.TAP_SECRET_KEY || process.env.TAP_SECRET || '';
}

async function createTapCharge({
  amount,
  currency = 'SAR',
  customerEmail,
  description,
  orderId,
  returnUrl,
  postUrl,
  metadata = {},
  sourceId,
  source,
}) {
  const secretKey = getTapSecretKey();
  if (!secretKey) {
    throw new Error('Tap secret key غير مضبوط. تأكد من إعداد TAP_SECRET_KEY');
  }

  const resolvedSource = source || (sourceId ? { id: sourceId } : { id: process.env.TAP_SOURCE_ID || 'src_card' });

  const payload = {
    amount: Math.max(0.01, Number(Number(amount).toFixed(2))),
    currency: String(currency).toUpperCase(),
    threeDSecure: true,
    save_card: false,
    description: description || 'Course purchase',
    metadata: {
      orderId: String(orderId || ''),
      ...metadata,
    },
    customer: {
      email: customerEmail || 'customer@example.com',
    },
    source: resolvedSource,
    redirect: {
      url: returnUrl,
    },
    post: {
      url: postUrl,
    },
  };

  const response = await axios.post(`${TAP_BASE_URL}/charges`, payload, {
    headers: {
      Authorization: `Bearer ${secretKey}`,
      'Content-Type': 'application/json',
    },
    timeout: 30000,
  });

  return response.data;
}

async function verifyTapWebhookSignature({ body, signature, secret }) {
  if (!body || !signature || !secret) return false;

  const charge = body.data?.object || body.charge || body;
  const reference = charge.reference || {};
  const amount = Number(charge.amount);
  const currency = String(charge.currency || '').toUpperCase();
  const decimals = ['BHD', 'JOD', 'KWD', 'OMR'].includes(currency) ? 3 : 2;
  if (!charge.id || !Number.isFinite(amount) || !currency || !charge.status || !charge.transaction?.created) {
    return false;
  }

  const signedValues = [
    `x_id${charge.id}`,
    `x_amount${amount.toFixed(decimals)}`,
    `x_currency${currency}`,
    `x_gateway_reference${reference.gateway || ''}`,
    `x_payment_reference${reference.payment || ''}`,
    `x_status${charge.status}`,
    `x_created${charge.transaction.created}`,
  ].join('');
  const expected = crypto.createHmac('sha256', secret).update(signedValues).digest();
  const provided = Buffer.from(String(signature).trim(), 'hex');
  return provided.length === expected.length && crypto.timingSafeEqual(provided, expected);
}

module.exports = {
  createTapCharge,
  verifyTapWebhookSignature,
};
