const axios = require('axios');

// Cliq API Configuration
const CLIQ_BASE_URL = process.env.CLIQ_BASE_URL || 'https://api.cliq.io/v1';
const CLIQ_MERCHANT_ID = process.env.CLIQ_MERCHANT_ID || '';
const CLIQ_API_KEY = process.env.CLIQ_API_KEY || '';

function getCliqConfig() {
  return {
    merchantId: CLIQ_MERCHANT_ID,
    apiKey: CLIQ_API_KEY,
    baseUrl: CLIQ_BASE_URL,
  };
}

async function createCliqCharge({
  amount,
  currency = 'JOD',
  customerEmail,
  customerPhone,
  description,
  orderId,
  returnUrl,
  metadata = {},
}) {
  const { merchantId, apiKey, baseUrl } = getCliqConfig();

  if (!merchantId || !apiKey) {
    throw new Error('Cliq credentials غير مضبوطة. تأكد من إعداد CLIQ_MERCHANT_ID و CLIQ_API_KEY');
  }

  // Generate unique transaction ID
  const transactionId = `${orderId}-${Date.now()}`;

  const payload = {
    merchantId,
    amount: Math.max(1, Math.round(amount * 100)) / 100, // Convert to decimal
    currency,
    orderReference: String(orderId),
    transactionId,
    customerEmail: customerEmail || 'customer@example.com',
    customerPhone: customerPhone || '+962788790701',
    description: description || 'Course purchase',
    returnUrl: returnUrl || 'http://localhost:5000/checkout',
    metadata,
  };

  try {
    // Create payment request with Cliq API
    // Note: Cliq API structure may vary - this is a template
    const response = await axios.post(`${baseUrl}/payments`, payload, {
      headers: {
        'Authorization': `Bearer ${apiKey}`,
        'Content-Type': 'application/json',
      },
      timeout: 10000,
    });

    if (response.status === 200 && response.data) {
      return {
        transactionId: response.data.transactionId || transactionId,
        checkoutUrl: response.data.checkoutUrl || response.data.paymentUrl,
        status: response.data.status || 'pending',
        reference: response.data.reference || String(orderId),
      };
    }

    throw new Error(`Cliq API response: ${response.status}`);
  } catch (error) {
    if (error.response?.data) {
      throw new Error(`Cliq error: ${error.response.data.message || JSON.stringify(error.response.data)}`);
    }
    throw error;
  }
}

async function verifyCliqPayment(transactionId, apiKey) {
  const { baseUrl } = getCliqConfig();

  if (!apiKey) {
    throw new Error('Cliq API key مفقود للتحقق');
  }

  try {
    const response = await axios.get(`${baseUrl}/payments/${transactionId}`, {
      headers: {
        'Authorization': `Bearer ${apiKey}`,
      },
      timeout: 10000,
    });

    return response.data;
  } catch (error) {
    throw new Error(`فشل التحقق من حالة الدفع: ${error.message}`);
  }
}

module.exports = {
  createCliqCharge,
  verifyCliqPayment,
  getCliqConfig,
};
