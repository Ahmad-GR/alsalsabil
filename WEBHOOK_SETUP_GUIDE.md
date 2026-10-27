# دليل إعداد Webhooks (الخطوات العملية) ⚙️

## 🔧 إعداد Stripe Webhook

### 1. الذهاب إلى Stripe Dashboard

```
https://dashboard.stripe.com/
→ اختر الحساب
→ Developers → Webhooks
```

### 2. إضافة Endpoint جديد

```
Webhook URL: https://your-domain.com/payments/webhook

يجب أن يكون:
✓ HTTPS (آمن)
✓ يمكن الوصول من الإنترنت

مثال:
https://hifz-platform.example.com/payments/webhook
```

### 3. اختيار الأحداث

```
☑ checkout.session.completed    ← المهم!
☑ checkout.session.async_payment_succeeded
☑ checkout.session.async_payment_failed
☐ invoice.payment_failed
☐ charge.dispute.created
...
```

### 4. نسخ Secret Key

```
في Dashboard:
Signing secret (whsec_...)

أضفه في .env:
STRIPE_WEBHOOK_SECRET=whsec_...
```

### 5. اختبار الـ Webhook

```bash
# استخدم Stripe CLI للاختبار المحلي

# 1. تحميل Stripe CLI
# من: https://stripe.com/docs/stripe-cli

# 2. تسجيل الدخول
stripe login

# 3. استمع للأحداث
stripe listen --forward-to localhost:3000/payments/webhook

# ستحصل على:
# > Ready! Your webhook signing secret is: whsec_...
# انسخ هذا الـ secret في .env

# 4. في طرفية أخرى، اختبر الدفع:
stripe trigger payment_intent.succeeded
```

---

## 🔧 إعداد PayPal Webhook

### 1. الذهاب إلى PayPal Developer Portal

```
https://developer.paypal.com/
→ Account Settings
→ Webhooks
```

### 2. إضافة Webhook

```
Webhook URL: https://your-domain.com/payments/webhook-paypal

معرفات الأحداث (Event Types):
☑ CHECKOUT.ORDER.COMPLETED    ← المهم!
☑ CHECKOUT.ORDER.DENIED
☑ CHECKOUT.ORDER.APPROVED
☑ PAYMENT.CAPTURE.COMPLETED
☐ PAYMENT.CAPTURE.FAILED
☑ PAYMENT.CAPTURE.REFUNDED
☑ CUSTOMER.DISPUTE.CREATED
...
```

### 3. نسخ Webhook ID

```
في PayPal Dashboard:
Webhook ID: WH_...

أضفه في .env:
PAYPAL_WEBHOOK_ID=WH_...
```

### 4. الحصول على Client ID و Secret

```
PayPal Dashboard:
→ Apps & Credentials
→ Sandbox/Live

PAYPAL_CLIENT_ID=xxx
PAYPAL_CLIENT_SECRET=xxx
PAYPAL_SECRET_KEY=xxx
```

---

## 📋 ملف .env الكامل

```bash
# ==========================================
# STRIPE CONFIGURATION
# ==========================================
STRIPE_SECRET_KEY=sk_live_...
STRIPE_WEBHOOK_SECRET=whsec_...

# ==========================================
# PAYPAL CONFIGURATION
# ==========================================
PAYPAL_CLIENT_ID=AQxxxxx
PAYPAL_CLIENT_SECRET=yyyyy
PAYPAL_SECRET_KEY=zzzzz
PAYPAL_WEBHOOK_ID=WH_xxxxx

# ==========================================
# GENERAL CONFIGURATION
# ==========================================
ENABLE_PAYMENTS=true           # تفعيل/تعطيل الدفع
SEND_PAYMENT_EMAILS=true       # إرسال رسائل البريد

CLIENT_URL=http://localhost:3000
SERVER_URL=http://localhost:5000

# ==========================================
# EMAIL CONFIGURATION (EmailJS)
# ==========================================
EMAILJS_SERVICE_ID=
EMAILJS_TEMPLATE_ID=
EMAILJS_REPLY_TMPL=
EMAILJS_PUBLIC_KEY=
EMAILJS_PRIVATE_KEY=

# ==========================================
# DATABASE
# ==========================================
DATABASE_PATH=./data/hifz-platform.sqlite
```

---

## 🧪 اختبار التطبيق محلياً

### خطوة 1: تثبيت Stripe CLI

```bash
# Windows (PowerShell)
Invoke-WebRequest -Uri "https://files.stripe.com/stripe-cli/installers/latest/stripe_cli_windows_x86_64.msi" `
  -OutFile "stripe_cli.msi"
msiexec /i stripe_cli.msi

# macOS
brew install stripe/stripe-cli/stripe

# Linux
curl -fsSLO https://dl.stripe.com/stripe-cli-alpine-linux-x86_64.tar.gz
tar -zxf stripe-cli-alpine-linux-x86_64.tar.gz

# Linux (Debian)
sudo apt-get install stripe
```

### خطوة 2: تسجيل الدخول وإعداد الـ Webhook

```bash
stripe login
# ستفتح متصفح - اختر الحساب

# أنشئ Restricted API Key للاختبار
# (في Stripe Dashboard)
```

### خطوة 3: استقبال الأحداث المحلية

```bash
# في طرفية 1: استمع للأحداث
stripe listen --forward-to http://localhost:5000/payments/webhook

# الناتج:
# > Ready! Your webhook signing secret is: whsec_test...
# انسخ هذا في .env (للاختبار فقط!)
```

### خطوة 4: شغّل السارفر

```bash
# في طرفية 2:
cd server
npm install
npm run dev

# يجب أن ترى:
# listening on port 5000
```

### خطوة 5: اختبر الدفع

#### اختبار Stripe:
```bash
# في طرفية 3: شغّل أحداث Stripe

# 1. عملية دفع مكتملة
stripe trigger checkout.session.completed

# 2. شاهد في الـ logs:
# ✓ Stripe webhook processing successful
# ✓ Order #123 marked as paid
# ✓ User enrolled in courses
```

#### اختبار PayPal (محاكاة):
```bash
# استخدم curl لإرسال webhook وهمي

curl -X POST http://localhost:5000/payments/webhook-paypal \
  -H "Content-Type: application/json" \
  -H "Paypal-Transmission-Id: test-transmission-001" \
  -H "Paypal-Transmission-Time: 2024-03-27T10:00:00Z" \
  -H "Paypal-Cert-Url: https://api.paypal.com/cert" \
  -d '{
    "event_type": "CHECKOUT.ORDER.COMPLETED",
    "event_id": "WH_4GG550363W3123456",
    "resource": {
      "id": "PAYPAL_ORDER_ID_12345",
      "status": "COMPLETED"
    }
  }'
```

---

## 🔍 مراقبة الـ Webhooks

### Stripe Dashboard

```
Dashboard → Developers → Webhooks → اختر الـ Endpoint

شاهد:
✓ All events (جميع الأحداث المرسلة)
✓ Failed attempts (محاولات فاشلة)
✓ Response status (حالة الرد)
```

### PayPal Dashboard

```
Account Settings → Webhooks → اختر الـ Webhook

شاهد:
✓ Transaction ID
✓ Status (Delivered/Failed)
✓ Response Body
✓ Retry count
```

---

## ⚠️ مشاكل شائعة والحلول

### مشكلة 1: "Webhook Secret Invalid"

```
❌ خطأ: Webhook signature verification failed

السبب:
- STRIPE_WEBHOOK_SECRET غير صحيح
- تم نسخ secret من مكان خاطئ

الحل:
1. تحقق من .env
2. تأكد من نسخ whsec_... من الـ Dashboard
3. أعد تشغيل السارفر (npm run dev)
```

### مشكلة 2: "Order Not Found"

```
❌ خطأ: Could not find order with ID

السبب:
- Order لم يتم إنشاؤه في قاعدة البيانات
- مشكلة في حفظ metadata

الحل:
1. تحقق من أن /create-checkout أرسلت metadata صحيح
2. تحقق من قاعدة البيانات:
   sqlite3 data/hifz-platform.sqlite
   SELECT * FROM orders WHERE id = 123;
```

### مشكلة 3: "User Not Enrolled"

```
❌ المستخدم لم يحصل على وصول الكورس

السبب:
- Webhook لم يعالج بشكل صحيح
- خطأ في enrollUserInCourses

الحل:
1. شاهد الـ logs:
   npm run dev  # ابحث عن [PayPal Webhook] أو [Stripe]
2. تحقق من قاعدة البيانات:
   SELECT * FROM enrollments WHERE user_id = 1;
```

### مشكلة 4: "Webhook Timeout"

```
❌ خطأ: Webhook delivery timeout

السبب:
- السارفر بطيء جداً
- عملية enrollUserInCourses تستغرق وقتاً طويلاً

الحل:
1. أضفه إلى queue (async job)
2. استخدم backgroundworker
3. أرسل 200 OK مباشرة، معالج لاحقاً
```

---

## 📊 مثال: تسلسل كامل للاختبار

```bash
# الحافظة: PowerShell

# 1. فتح 3 نوافذ (Tabs)

# Tab 1: شاهد Stripe events
stripe listen --forward-to http://localhost:5000/payments/webhook

# Tab 2: شغّل السارفر
cd server
npm run dev

# Tab 3: اختبر من الـ Frontend أو curl
# ملاحظة: اختبر من واجهة المستخدم (Frontend)...

# لكن إذا أردت اختبار Webhook مباشرة:
curl -X POST http://localhost:5000/payments/webhook \
  -H "stripe-signature: $(stripe trigger payment_intent.succeeded)" \
  -H "Content-Type: application/json" \
  -d '...'
```

---

## 🚀 دليل النشر (Production)

### قبل النشر:

```bash
# 1. تحديث .env بـ Live Keys (ليس Sandbox!)
STRIPE_SECRET_KEY=sk_live_XXXX
STRIPE_WEBHOOK_SECRET=whsec_live_XXXX
PAYPAL_CLIENT_ID=Live ID...
PAYPAL_CLIENT_SECRET=Live Secret...

# 2. تحديث الـ Webhook URLs في PayPal/Stripe
# من: http://localhost/payments/webhook
# إلى: https://your-domain.com/payments/webhook

# 3. اختبار على بيئة staging أولاً
# (ليس مباشرة على production!)

# 4. تفعيل HTTPS
# استخدم Let's Encrypt (مجاني)
# أو استأجر شهادة SSL

# 5. إضافة logging جيد
npm install winston  # مكتبة logging قوية
```

### في Stripe/PayPal Dashboard:

```
1. اذهب إلى Live Mode (وليس Test Mode)
2. حديث الـ Webhook URLs
3. حدّث API Keys
4. أرسل أول 3 طلبات اختبار يدويًا
5. راقب الـ logs
```

---

## 💡 نصائح للإنتاج

```javascript
// تسجيل كل حدث
console.log('[WEBHOOK] Event:', event_type, 'OrderID:', paypalOrderId);

// إضافة retry logic
if (updated.changes === 0) {
  // حاول مرة أخرى بعد 1 ثانية
  setTimeout(() => { process.emit('retry-webhook', orderId); }, 1000);
}

// إرسال تنبيهات عند الفشل
if (!order) {
  sendAlert('admin@platform.com', 'Missing order webhook: ' + paypalOrderId);
}

// تسجيل في قاعدة البيانات
INSERT INTO webhook_logs (type, event_id, status, created_at)
VALUES ('paypal', event_id, 'success', NOW());
```
