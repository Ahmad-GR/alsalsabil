# 📚 روابط سريعة - دليل الدفع والـ Webhooks

## 🎯 الملفات المرجعية

### 1. **الشرح التفصيلي** 📖
👉 [PAYMENT_FLOW_EXPLANATION.md](PAYMENT_FLOW_EXPLANATION.md)
- رحلة الشراء خطوة بخطوة
- رسوم توضيحية (ASCII diagrams)
- مثال حقيقي كامل
- عوامل الأمان

**متى تقرأ؟** عندما تريد فهم العملية بالكامل

---

### 2. **دليل الإعداد العملي** 🔧
👉 [WEBHOOK_SETUP_GUIDE.md](WEBHOOK_SETUP_GUIDE.md)
- إعداد Stripe Webhook خطوة بخطوة
- إعداد PayPal Webhook خطوة بخطوة
- اختبار محلي (Stripe CLI)
- حل 4 مشاكل شائعة
- دليل النشر على الإنتاج

**متى تقرأ؟** عندما تريد تفعيل الـ webhooks

---

### 3. **المقارنة الأمنية** 🔐
👉 [UNSAFE_VS_SAFE_CODE.md](UNSAFE_VS_SAFE_CODE.md)
- الكود القديم (غير آمن) vs الكود الجديد (آمن)
- أمثلة هجمات محتملة
- 3 حالات خطرة والحل الآمن

**متى تقرأ؟** لفهم لماذا التغييرات مهمة

---

### 4. **استعلامات المراقبة** 📊
👉 [SQL_QUERIES_MONITORING.md](SQL_QUERIES_MONITORING.md)
- 20+ استعلام SQL جاهز للاستخدام
- مراقبة الطلبات والإيرادات
- كشف الأخطاء والمشاكل
- صيانة قاعدة البيانات

**متى تقرأ؟** عندما تريد مراقبة الدفع أو تصحيح الأخطاء

---

### 5. **الدليل الشامل** 📋
👉 [COMPLETE_PAYMENT_GUIDE.md](COMPLETE_PAYMENT_GUIDE.md)
- ملخص شامل لكل شيء
- البدء السريع (Quick Start)
- ملخص الملفات المضافة
- نصائح ودروس مستفادة

**متى تقرأ؟** أول مرة تبدأ فيها

---

## 🔧 الملف الرئيسي

👉 **[server/routes/payments.js](server/routes/payments.js)**

### الإضافات الرئيسية:
```javascript
// ✅ دالة التحقق من التوقيع
verifyPayPalWebhookSignature()

// ✅ مسار جديد
POST /payments/webhook-paypal
- يستقبل أحداث PayPal
- يتحقق من التوقيع
- يحدّث الطلب
- يسجل المستخدم في الكورسات
- يرسل بريد تأكيد
```

---

## ⚡ البدء السريع (5 دقائق)

### 1. حدّث .env
```bash
PAYPAL_WEBHOOK_ID=WH_...
PAYPAL_CLIENT_ID=AQ...
PAYPAL_CLIENT_SECRET=...
STRIPE_WEBHOOK_SECRET=whsec_...
```
👉 [دليل كامل](WEBHOOK_SETUP_GUIDE.md#-%D8%AA%D8%AD%D8%AF%D9%8A%D8%AB-env)

### 2. أضفِ Webhooks في PayPal/Stripe
```
Stripe: https://your-domain.com/payments/webhook
PayPal: https://your-domain.com/payments/webhook-paypal
```
👉 [خطوات مفصلة](WEBHOOK_SETUP_GUIDE.md)

### 3. اختبر محلياً
```bash
stripe listen --forward-to http://localhost:5000/payments/webhook
npm run dev
stripe trigger checkout.session.completed
```
👉 [دليل اختبار](WEBHOOK_SETUP_GUIDE.md#-%D8%A7%D8%AE%D8%AA%D8%A8%D8%B1-%D8%A7%D9%84%D8%AA%D8%B7%D8%A8%D9%8A%D9%82-%D9%85%D8%AD%D9%84%D9%8A%D8%A7%D9%8B)

---

## 🆘 استكشاف الأخطاء

### "Webhook Signature Failed"
👉 [الحل](WEBHOOK_SETUP_GUIDE.md#-%D9%85%D8%B4%D9%83%D9%84%D8%A9-1-webhook-secret-invalid)

### "Order Not Found"
👉 [الحل](WEBHOOK_SETUP_GUIDE.md#-%D9%85%D8%B4%D9%83%D9%84%D8%A9-2-order-not-found)

### "User Not Enrolled"
👉 [الحل](WEBHOOK_SETUP_GUIDE.md#-%D9%85%D8%B4%D9%83%D9%84%D8%A9-3-user-not-enrolled)

### "Webhook Timeout"
👉 [الحل](WEBHOOK_SETUP_GUIDE.md#-%D9%85%D8%B4%D9%83%D9%84%D8%A9-4-webhook-timeout)

---

## 📊 مراقبة يومية

### استعلام سريع:
```sql
-- عدد الطلبات ورقم الإيرادات اليوم
SELECT COUNT(*) as orders, SUM(total_amount) as revenue
FROM orders WHERE status = 'paid' AND DATE(created_at) = DATE('now');
```

### استعلامات أكثر:
👉 [20+ استعلام جاهز](SQL_QUERIES_MONITORING.md)

---

## 📈 الإحصائيات

### أدوات المراقبة:
- **Stripe Dashboard**: https://dashboard.stripe.com/
  - شاهد جميع الدفع
  - اختبر الـ webhooks
  - اعرض Logs

- **PayPal Dashboard**: https://developer.paypal.com/
  - شاهد الطلبات
  - اختبر الـ webhooks
  - اعرض Transaction Details

---

## 🔑 نقاط الأمان

```
1. ✅ تحقق من التوقيع (Signature)
2. ✅ استخدم معرّفات داخلية (IDs)
3. ✅ اجعل العمليات آمنة (Atomic)
4. ✅ سجل كل شيء (Logging)
5. ✅ اختبر على Staging أولاً
```

👉 [شرح مفصل](UNSAFE_VS_SAFE_CODE.md)

---

## 💡 نصائح مهمة

### ❌ لا تفعل:
```javascript
const email = req.body.email; // غير آمن!
INSERT INTO sales WHERE email = ? // قد يزيف البريد
```

### ✅ افعل:
```javascript
if (!verifySignature(req)) return 403;
const order = db.get(orderId); // من قاعدة البيانات الموثوقة
```

👉 [أمثلة أكثر](UNSAFE_VS_SAFE_CODE.md#-%D8%A7%D9%84%D9%87%D8%AC%D9%88%D9%85-%D8%B9%D9%84%D9%89-%D8%A7%D9%84%D9%83%D9%88%D8%AF-%D8%BA%D9%8A%D8%B1-%D8%A7%D9%84%D8%A2%D9%85%D9%86)

---

## 🚀 الخطوات التالية

- [ ] اختبر على حساب Sandbox (تجريبي)
- [ ] أضفِ logging للـ webhook events في قاعدة البيانات
- [ ] أنشئ dashboard للمسؤولين لمراقبة الدفع
- [ ] أضفِ تنبيهات عند فشل webhook
- [ ] انشر على الإنتاج مع Live keys

👉 [دليل النشر](WEBHOOK_SETUP_GUIDE.md#-%D8%AF%D9%84%D9%8A%D9%84-%D8%A7%D9%84%D9%86%D8%B4%D8%B1-production)

---

## 📞 الملخص السريع

```
ماذا تم إضافة؟
✅ PayPal Webhook آمن
✅ معالجة كاملة للأحداث
✅ تسجيل تلقائي في الكورسات
✅ بريد تأكيد
✅ توثيق شامل (5 ملفات)

الملفات:
✅ payments.js - الكود
✅ 5 ملفات توثيق

الأمان:
✅ تحقق من التوقيع
✅ معاملات آمنة
✅ معالجة شاملة للأخطاء

المراقبة:
✅ 20+ استعلام SQL جاهز
✅ أمثلة للاستخدام
```

---

## 🎓 التعلم

لأول مرة؟ اقرأ على هذا الترتيب:
1. [COMPLETE_PAYMENT_GUIDE.md](COMPLETE_PAYMENT_GUIDE.md) (10 دقائق)
2. [PAYMENT_FLOW_EXPLANATION.md](PAYMENT_FLOW_EXPLANATION.md) (15 دقيقة)
3. [UNSAFE_VS_SAFE_CODE.md](UNSAFE_VS_SAFE_CODE.md) (10 دقائق)
4. [WEBHOOK_SETUP_GUIDE.md](WEBHOOK_SETUP_GUIDE.md) (اختبر بالفعل!)

---

**الآن أنت مستعد!** 🚀

هل تريد مساعدة في شيء معين؟
