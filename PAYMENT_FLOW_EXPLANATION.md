# شرح مفصل: رحلة الشراء والدفع 🛒💳

## 📊 تسلسل العملية كاملة

```
المستخدم              المتجر              PayPal/Stripe
    |                  |                      |
    |--- يختار كورسات --->|                      |
    |                  |                      |
    |                  |-- ينشئ Order ------<--|
    |                  |   (pending)          |
    |                  |                      |
    |<-- URL الدفع -----|                      |
    |                  |                      |
    |--- يذهب للدفع ----->|                      |
    |                  |-- يفتح جلسة دفع ------>|
    |                  |                      |
    |<------ يدفع هنا ------|<----- نموذج الدفع ---|
    |                  |                      |
    |                  |<----- تأكيد الدفع ---|
    |                  |                      |
    |                  |<--- Webhook الدفع ---|
    |                  |                      |
    |<-- رسالة نجاح -----|                      |
    |                  |-- ينشئ Enrollments --|
    |                  |-- يرسل بريد تأكيد ---|
```

---

## 🔄 الخطوات بالتفصيل

### **1️⃣ المستخدم يختار كورسات**
```javascript
// في الـ Frontend
const courseIds = [1, 2, 3]; // الكورسات المختارة
res = await fetch('/payments/create-checkout', {
  method: 'POST',
  body: JSON.stringify({ courseIds })
});
// النتيجة: رابط PayPal أو Stripe
```

**ماذا يحدث في الـ Backend؟**
```javascript
// في /payments/create-checkout
1. التحقق من المستخدم (middleware: protect)
2. التحقق من وجود الكورسات وأنها منشورة
3. حساب الإجمالي
4. ✓ إنشاء Order في قاعدة البيانات
   - الحالة: 'pending'
   - المبلغ الإجمالي
   - معرف المستخدم
5. إضافة order_items (تفاصيل كل كورس)
6. إرسال البيانات إلى PayPal/Stripe
7. تخزين معرف الجلسة في الـ Order
```

---

### **2️⃣ المستخدم يدفع**

#### **PayPal:**
```javascript
// في /payments/create-paypal-order
1. إنشاء طلب في PayPal API
2. تخزين paypal_order_id في قاعدة البيانات
3. إرجاع الرابط للمستخدم
4. المستخدم يدفع ويوافق

✓ في الـ Frontend:
   await fetch('/payments/capture-paypal-order', {
     orderId: paypalOrderId // معرف الطلب من PayPal
   });
   // ينقل البيانات للـ Backend
```

#### **Stripe:**
```javascript
// المستخدم يكمل الدفع في جلسة Stripe
// Stripe تعيده إلى:
success_url: `${CLIENT_URL}?payment=success&session={CHECKOUT_SESSION_ID}`

✓ الـ Frontend يتحقق من الجلسة:
  GET /payments/verify-session/:sessionId
```

---

### **3️⃣ تأكيد الدفع - الخطوة الحاسمة ⚠️**

#### **الطريقة الآمنة (Webhook):**

**Stripe:**
```javascript
// Stripe ترسل webhook آمن مع توقيع
POST /payments/webhook

تسلسل المعالجة:
1. ✓ التحقق من التوقيع باستخدام STRIPE_WEBHOOK_SECRET
   stripe.webhooks.constructEvent(body, signature, secret)
   
2. ✓ البحث عن الـ Order باستخدام metadata
   const orderId = session.metadata.orderId
   
3. ✓ تحديث الـ Order إلى 'paid'
   UPDATE orders SET status = 'paid' WHERE id = orderId
   
4. ✓ تسجيل المستخدم في الكورسات (enrollUserInCourses)
   
5. ✓ إرسال بريد التأكيد

✓ الهدف: ضمان أن الأموال وصلت فعلاً
```

**PayPal:**
```javascript
// PayPal ترسل webhook آمن
POST /webhook-paypal

تسلسل المعالجة:
1. ✓ التحقق من التوقيع (signature verification)
   - transmissionId, transmissionTime, certUrl
   - التحقق من الشهادة
   
2. ✓ التحقق من نوع الحدث
   if (event_type === 'CHECKOUT.ORDER.COMPLETED')
   
3. ✓ البحث عن الـ Order باستخدام paypal_order_id
   const dbOrder = db.prepare(...)
   
4. ✓ تحديث الـ Order إلى 'paid'
   UPDATE orders SET status = 'paid'
   
5. ✓ تسجيل المستخدم في الكورسات
   enrollUserInCourses(db, orderId)
   
6. ✓ إرسال بريد التأكيد

✓ الهدف: ضمان أن PayPal أكدت الدفع
```

---

### **4️⃣ تسجيل المستخدم في الكورسات**

```javascript
// الدالة: enrollUserInCourses(db, orderId)

for each course_id in order_items:
    1. ✓ إنشاء record في جدول enrollments
       INSERT INTO enrollments (user_id, course_id, order_id, ...)
       
    2. ✓ تحديث عدد الطلاب في الكورس
       UPDATE courses SET students_count = students_count + 1
       
    3. ✓ تعيين الوسائط والدروس للمستخدم
       (إذا كان نظامك يدعم ذلك)

النتيجة: ✓ المستخدم الآن لديه وصول للكورس
```

---

### **5️⃣ إرسال بريد التأكيد**

```javascript
// الدالة: sendConfirmationEmail(order)

if (emailNotificationsEnabled) {
    البريد يتضمن:
    ✓ تأكيد الشراء
    ✓ قائمة الكورسات
    ✓ رابط الوصول للكورس
    ✓ التفاصيل (القيمة، التاريخ، إلخ)
}

ملاحظة: روابط الوسائط قد تكون محمية بـ authentication
```

---

## 🔐 عوامل الأمان الرئيسية

| العامل | الأهمية | كيفية التنفيذ |
|--------|--------|--------------|
| **التحقق من التوقيع** | ⭐⭐⭐⭐⭐ | `stripe.webhooks.constructEvent()` أو التحقق من PayPal signature |
| **عدم الوثوق بـ Frontend** | ⭐⭐⭐⭐⭐ | كل معاملة يجب أن تُتحقق في Backend |
| **معرف الطلب الفريد** | ⭐⭐⭐⭐ | استخدام database ID وليس معرف خارجي فقط |
| **المعاملات (Transactions)** | ⭐⭐⭐⭐ | `runInTransaction()` لتجنب حالات races |
| **التسجيل (Logging)** | ⭐⭐⭐ | تسجيل كل خطوة لأغراض التدقيق |

---

## ⚠️ حالات الخطأ والمعالجة

```javascript
// حالة 1: Webhook وصل مرتين
UPDATE orders SET status = 'paid' WHERE id = ? AND status = 'pending'
// تحديث واحد فقط (SQL يتعامل معها تلقائياً)

// حالة 2: Webhook لطلب غير موجود
// نرجع 200 OK (لتجنب إعادة المحاولة)
// ونسجل الخطأ للتحقيق

// حالة 3: فشل تسجيل المستخدم في الكورسات
// نرسل 200 OK إلى PayPal (تم الاستقبال)
// لكننا نسجل الخطأ ونتابعه يدويًا

// حالة 4: فشل إرسال البريد
// لا نعيد محاولة - المستخدم مسجل بالفعل
// نسجل للمتابعة اليدوية
```

---

## 📈 مثال حقيقي: تتبع طلب معين

```javascript
// الطلب #123 للمستخدم أحمد (ahmad@example.com)

Timeline:
┌─ 2:00 PM ─ أحمد يختار الكورسات (الرياضيات، الفيزياء)
├─ Order #123 ينشأ: { status: 'pending', total: 150 }
│
├─ 2:01 PM ─ أحمد ينقر "ادفع الآن"
├─ قاعدة البيانات: paypal_order_id = "9A1234567890"
│
├─ 2:05 PM ─ أحمد يدفع 150 ريال بنجاح في PayPal
│
├─ 2:05:05 PM ─ PayPal يرسل Webhook
│            - تحقق من التوقيع ✓
│            - Order #123 موجود ✓
│            - تحديث Status إلى 'paid' ✓
│
├─ 2:05:06 PM ─ تسجيل في الكورسات:
│            - INSERT enrollments (user_id=1, course_id=5)
│            - INSERT enrollments (user_id=1, course_id=6)
│            - UPDATE courses SET students_count += 1 (×2)
│
├─ 2:05:07 PM ─ إرسال البريد إلى ahmad@example.com
│            - الموضوع: "تم تأكيد شراء كورساتك!"
│            - المرفقات: روابط الكورسات
│
└─ 2:05:08 PM ─ أحمد يتلقى البريد ✓
                يمكنه الوصول للكورسات الآن
```

---

## 🚀 متطلبات البيئة

```bash
# .env يجب أن يحتوي على:
PAYPAL_CLIENT_ID=xxx
PAYPAL_CLIENT_SECRET=xxx
PAYPAL_WEBHOOK_ID=xxx           # ← مهم جداً

STRIPE_SECRET_KEY=xxx
STRIPE_WEBHOOK_SECRET=xxx       # ← مهم جداً

EMAILJS_SERVICE_ID=xxx          # لإرسال البريد
EMAILJS_TEMPLATE_ID=xxx
EMAILJS_PUBLIC_KEY=xxx
EMAILJS_PRIVATE_KEY=xxx
CLIENT_URL=http://localhost:3000
ENABLE_PAYMENTS=true
SEND_PAYMENT_EMAILS=true
```

---

## ⚡ ملخص العملية

```
1️⃣ المستخدم يختار + يدفع
   ↓
2️⃣ إنشاء Order في قاعدة البيانات
   ↓
3️⃣ تحويل آمن إلى PayPal/Stripe
   ↓
4️⃣ المستخدم يدفع بنجاح ✓
   ↓
5️⃣ Webhook آمن من PayPal/Stripe (مع تحقق التوقيع)
   ↓
6️⃣ تحديث Order → 'paid'
   ↓
7️⃣ تسجيل المستخدم في الكورسات ← ⭐ الخطوة الذهبية
   ↓
8️⃣ إرسال بريد التأكيد
   ↓
✅ المستخدم يمكنه الوصول للكورسات الآن
```
