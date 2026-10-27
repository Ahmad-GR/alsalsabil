const EMAILJS_ENDPOINT = 'https://api.emailjs.com/api/v1.0/email/send';
const EMAILJS_REQUIRED_SETTINGS = [
  'EMAILJS_SERVICE_ID',
  'EMAILJS_TEMPLATE_ID',
  'EMAILJS_PUBLIC_KEY',
  'EMAILJS_PRIVATE_KEY',
];
const EMAIL_TIMEOUT_MS = Number(process.env.EMAIL_TIMEOUT_MS || 10000);
const EMAILJS_MIN_INTERVAL_MS = 1000;
let emailQueue = Promise.resolve();
let lastRequestAt = 0;

function isEmailConfigured() {
  return EMAILJS_REQUIRED_SETTINGS.every(name => Boolean(process.env[name]?.trim()));
}

function withTimeout(promise, timeoutMs) {
  let timer;
  const timeout = new Promise((resolve, reject) => {
    timer = setTimeout(() => reject(new Error('انتهت مهلة إرسال البريد الإلكتروني')), timeoutMs);
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

async function sendEmail({ to, subject, html, templateId, templateParams = {} }) {
  if (!isEmailConfigured()) {
    throw new Error('إعداد EmailJS غير مكتمل. أضف مفاتيح الخدمة والقالب إلى server/.env.');
  }

  const selectedTemplateId = templateId?.trim() || process.env.EMAILJS_TEMPLATE_ID.trim();
  const send = async () => {
    const waitMs = Math.max(0, EMAILJS_MIN_INTERVAL_MS - (Date.now() - lastRequestAt));
    if (waitMs) await new Promise(resolve => setTimeout(resolve, waitMs));
    lastRequestAt = Date.now();

    const controller = new AbortController();
    const request = fetch(EMAILJS_ENDPOINT, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      signal: controller.signal,
      body: JSON.stringify({
        service_id: process.env.EMAILJS_SERVICE_ID,
        template_id: selectedTemplateId,
        user_id: process.env.EMAILJS_PUBLIC_KEY,
        accessToken: process.env.EMAILJS_PRIVATE_KEY,
        template_params: {
          to_email: to,
          subject,
          title: subject,
          html_content: html,
          ...templateParams,
        },
      }),
    });

    try {
      const response = await withTimeout(request, EMAIL_TIMEOUT_MS);
      if (!response.ok) {
        throw new Error(`EmailJS request failed with status ${response.status}.`);
      }
      await response.text();
    } catch (error) {
      if (error.name === 'AbortError') {
        throw new Error('انتهت مهلة إرسال البريد الإلكتروني');
      }
      throw error;
    } finally {
      controller.abort();
    }
  };

  const task = emailQueue.then(send);
  emailQueue = task.then(() => undefined, () => undefined);
  return task;
}

function escapeHtml(value) {
  return String(value || '').replace(/[&<>"']/g, character => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
  }[character]));
}

async function sendVerificationEmail(to, code) {
  await sendEmail({
    to,
    subject: 'تفعيل حسابك في السلسبيل',
    html: `
      <div dir="rtl" style="font-family:Arial,sans-serif;text-align:right">
        <h2>أهلاً بك في السلسبيل،</h2>
        <p>شكراً لتسجيلك. يرجى استخدام الرمز التالي لتفعيل حسابك:</p>
        <p style="font-size:24px;font-weight:bold;letter-spacing:4px">${escapeHtml(code)}</p>
        <p>إذا لم تطلب هذا، يرجى تجاهل هذا البريد الإلكتروني.</p>
      </div>
    `,
  });
}

async function sendPasswordResetEmail(to, code) {
  await sendEmail({
    to,
    subject: 'إعادة تعيين كلمة المرور لحسابك',
    html: `
      <div dir="rtl" style="font-family:Arial,sans-serif;text-align:right">
        <h2>طلب إعادة تعيين كلمة المرور،</h2>
        <p>لقد طلبت إعادة تعيين كلمة المرور. استخدم الرمز التالي للمتابعة:</p>
        <p style="font-size:24px;font-weight:bold;letter-spacing:4px">${escapeHtml(code)}</p>
        <p>هذا الرمز صالح لمدة ساعة واحدة.</p>
        <p>إذا لم تطلب هذا، يرجى تجاهل هذه الرسالة.</p>
      </div>
    `,
  });
}

async function sendContactConfirmationEmail(to, name, message) {
  await sendEmail({
    to,
    subject: 'تأكيد استلام رسالتك',
    html: `
      <div dir="rtl" style="font-family:Arial,sans-serif;text-align:right">
        <h2>مرحباً ${escapeHtml(name)}،</h2>
        <p>شكراً لتواصلك معنا. لقد استلمنا رسالتك:</p>
        <blockquote>${escapeHtml(message)}</blockquote>
        <p>سنقوم بالرد عليك في أقرب وقت ممكن.</p>
        <p>مع خالص التحية،<br>فريق السلسبيل</p>
      </div>
    `,
  });
}

module.exports = {
  isEmailConfigured,
  sendEmail,
  sendVerificationEmail,
  sendPasswordResetEmail,
  sendContactConfirmationEmail,
};
