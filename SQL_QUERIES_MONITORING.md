# SQL Queries للاختبار والمراقبة 📊

## 🔍 مراقبة الطلبات

### 1. عرض جميع الطلبات وحالتها

```sql
SELECT 
  id,
  user_id,
  total_amount,
  status,
  payment_method,
  paypal_order_id,
  stripe_session_id,
  created_at,
  updated_at
FROM orders
ORDER BY created_at DESC
LIMIT 20;
```

### 2. عرض الطلبات المعلقة (pending)

```sql
SELECT 
  id,
  user_id,
  total_amount,
  payment_method,
  created_at
FROM orders
WHERE status = 'pending'
  AND created_at > datetime('now', '-24 hours')
ORDER BY created_at DESC;
```

### 3. عرض الطلبات المدفوعة

```sql
SELECT 
  o.id,
  o.user_id,
  u.email,
  o.total_amount,
  o.status,
  o.payment_method,
  COUNT(oi.id) as num_courses,
  o.created_at
FROM orders o
JOIN users u ON o.user_id = u.id
LEFT JOIN order_items oi ON o.id = oi.order_id
WHERE o.status = 'paid'
GROUP BY o.id
ORDER BY o.created_at DESC
LIMIT 20;
```

---

## 📦 مراقبة تفاصيل الطلب

### 4. عرض تفاصيل طلب معين (مثال: Order #123)

```sql
-- بيانات الطلب
SELECT * FROM orders WHERE id = 123;

-- عناصر الطلب (الكورسات)
SELECT 
  oi.course_id,
  oi.course_title,
  oi.price_at_time,
  oi.created_at
FROM order_items oi
WHERE oi.order_id = 123;

-- تسجيل المستخدم في الكورسات
SELECT 
  e.course_id,
  c.title,
  e.progress,
  e.created_at
FROM enrollments e
JOIN courses c ON e.course_id = c.id
WHERE e.order_id = 123;
```

### 5. عرض الكورسات المشتراة من قبل مستخدم (مثال: User #1)

```sql
SELECT 
  o.id as order_id,
  o.total_amount,
  o.status,
  o.payment_method,
  GROUP_CONCAT(oi.course_title, ', ') as courses,
  o.created_at
FROM orders o
LEFT JOIN order_items oi ON o.id = oi.order_id
WHERE o.user_id = 1
GROUP BY o.id
ORDER BY o.created_at DESC;
```

---

## 👥 مراقبة المستخدمين المسجلين في الكورسات

### 6. عرض عدد الطلاب لكل كورس

```sql
SELECT 
  c.id,
  c.title,
  COUNT(e.id) as student_count,
  c.students_count as recorded_count,
  c.price,
  c.created_at
FROM courses c
LEFT JOIN enrollments e ON c.id = e.course_id
GROUP BY c.id
ORDER BY student_count DESC;
```

### 7. التحقق من عدم قراءة الكورس (لم يرسل enrollment)

```sql
-- كورسات مدفوعة لكن لم يتم تسجيل المستخدم
SELECT 
  o.id as order_id,
  o.user_id,
  oi.course_id,
  oi.course_title,
  o.status,
  o.created_at
FROM order_items oi
JOIN orders o ON oi.order_id = o.id
WHERE o.status = 'paid'
  AND NOT EXISTS (
    SELECT 1 FROM enrollments e 
    WHERE e.order_id = o.id 
    AND e.course_id = oi.course_id
  )
ORDER BY o.created_at DESC;
```

---

## 💰 إحصائيات الدفع

### 8. إجمالي الإيرادات

```sql
SELECT 
  COUNT(DISTINCT id) as total_orders,
  SUM(total_amount) as total_revenue,
  AVG(total_amount) as avg_order_value,
  MIN(total_amount) as min_order,
  MAX(total_amount) as max_order
FROM orders
WHERE status = 'paid';
```

### 9. الإيرادات حسب طريقة الدفع

```sql
SELECT 
  payment_method,
  COUNT(id) as order_count,
  SUM(total_amount) as total_revenue,
  AVG(total_amount) as avg_order_value
FROM orders
WHERE status = 'paid'
GROUP BY payment_method
ORDER BY total_revenue DESC;
```

### 10. الإيرادات اليومية

```sql
SELECT 
  DATE(created_at) as date,
  COUNT(id) as orders,
  SUM(total_amount) as revenue,
  AVG(total_amount) as avg_order
FROM orders
WHERE status = 'paid'
GROUP BY DATE(created_at)
ORDER BY date DESC
LIMIT 30;
```

---

## 🔴 كشف المشاكل والأخطاء

### 11. الطلبات المعلقة لمدة أكثر من 24 ساعة

```sql
-- قد تكون بسبب فشل webhook
SELECT 
  id,
  user_id,
  total_amount,
  payment_method,
  created_at,
  CAST((julianday('now') - julianday(created_at)) * 24 as INTEGER) as hours_pending
FROM orders
WHERE status = 'pending'
  AND created_at < datetime('now', '-24 hours')
ORDER BY created_at ASC;
```

### 12. الطلبات المضروبة (refunded)

```sql
SELECT 
  id,
  user_id,
  total_amount,
  status,
  created_at
FROM orders
WHERE status = 'refunded'
ORDER BY created_at DESC
LIMIT 20;
```

### 13. الطلبات الملغاة (cancelled)

```sql
SELECT 
  id,
  user_id,
  total_amount,
  payment_method,
  created_at
FROM orders
WHERE status = 'cancelled'
ORDER BY created_at DESC
LIMIT 20;
```

---

## 🐛 استكشاف الأخطاء

### 14. البحث عن طلب PayPal معين

```sql
-- إذا كان لديك PayPal Order ID
SELECT * FROM orders WHERE paypal_order_id = 'PAYPAL_ORDER_ID_HERE';

-- أو Stripe Session ID
SELECT * FROM orders WHERE stripe_session_id = 'cs_live_XXXXX';
```

### 15. المستخدمون بدون أي طلبات (لم يشتروا شيء)

```sql
SELECT 
  u.id,
  u.email,
  u.first_name,
  u.last_name,
  u.created_at
FROM users u
WHERE NOT EXISTS (
  SELECT 1 FROM orders o WHERE o.user_id = u.id
)
ORDER BY u.created_at DESC;
```

### 16. التحقق من عدم تطابق الأرقام

```sql
-- المستخدمون المسجلون في كورس بدون دفع
SELECT DISTINCT
  e.user_id,
  c.title
FROM enrollments e
JOIN courses c ON e.course_id = c.id
WHERE e.order_id IS NULL
  OR NOT EXISTS (
    SELECT 1 FROM orders o 
    WHERE o.id = e.order_id 
    AND o.status = 'paid'
  )
LIMIT 20;
```

---

## 📋 الصيانة والتنظيف

### 17. حذف الطلبات المعلقة القديمة (بحذر!)

```sql
-- قبل الحذف، شاهد كم عدد الطلبات
SELECT COUNT(*) FROM orders 
WHERE status = 'pending'
  AND created_at < datetime('now', '-7 days');

-- الحذف (تأكد قبل التنفيذ!)
DELETE FROM orders 
WHERE status = 'pending'
  AND created_at < datetime('now', '-7 days');
```

### 18. تحديث عدد الطلاب في الكورسات (إذا كان خاطئ)

```sql
-- تحديث الأرقام بناءً على قاعدة البيانات الفعلية
UPDATE courses c
SET students_count = (
  SELECT COUNT(DISTINCT e.user_id)
  FROM enrollments e
  WHERE e.course_id = c.id
);
```

---

## 🔔 استعلامات للتحكم والإشراف

### 19. تقرير شامل عن طلب معين

```sql
-- الكل في قسم واحد
SELECT 
  '=== ORDER INFO ===' as section,
  'Order ID: ' || o.id as detail,
  'User: ' || u.email as detail,
  'Amount: ' || o.total_amount as detail,
  'Status: ' || o.status as detail,
  'Method: ' || o.payment_method as detail,
  'Created: ' || o.created_at as detail
FROM orders o
JOIN users u ON o.user_id = u.id
WHERE o.id = 123

UNION ALL

SELECT 
  '=== COURSES ===' as section,
  oi.course_id || ' - ' || oi.course_title as detail,
  'Price: ' || oi.price_at_time as detail,
  '' as detail,
  '' as detail,
  '' as detail,
  '' as detail
FROM order_items oi
WHERE oi.order_id = 123;
```

### 20. تحقق سريع من صحة جدول orders

```sql
-- التحقق من وجود جميع الأعمدة المطلوبة
PRAGMA table_info(orders);

-- يجب أن تشمل:
-- - id
-- - user_id
-- - total_amount
-- - status
-- - payment_method
-- - stripe_session_id
-- - stripe_payment_intent
-- - paypal_order_id
-- - paypal_payment_id
-- - created_at
-- - updated_at
```

---

## ⚡ استعلام سريع لـ Dashboard

### 21. ملخص يومي (Dashboard)

```sql
SELECT 
  'Today' as period,
  COUNT(CASE WHEN status = 'paid' THEN 1 END) as orders_today,
  SUM(CASE WHEN status = 'paid' THEN total_amount ELSE 0 END) as revenue_today,
  COUNT(CASE WHEN status = 'pending' THEN 1 END) as pending_orders
FROM orders
WHERE DATE(created_at) = DATE('now')

UNION ALL

SELECT 
  'This Week',
  COUNT(CASE WHEN status = 'paid' THEN 1 END),
  SUM(CASE WHEN status = 'paid' THEN total_amount ELSE 0 END),
  COUNT(CASE WHEN status = 'pending' THEN 1 END)
FROM orders
WHERE DATE(created_at) >= DATE('now', '-7 days')

UNION ALL

SELECT 
  'This Month',
  COUNT(CASE WHEN status = 'paid' THEN 1 END),
  SUM(CASE WHEN status = 'paid' THEN total_amount ELSE 0 END),
  COUNT(CASE WHEN status = 'pending' THEN 1 END)
FROM orders
WHERE strftime('%Y-%m', created_at) = strftime('%Y-%m', 'now');
```

---

## 🛠️ كيفية تشغيل هذه الاستعلامات

### من سطر الأوامر:

```bash
# فتح قاعدة البيانات
sqlite3 ./server/data/hifz-platform.sqlite

# ثم انسخ والصق أي استعلام
sqlite> SELECT COUNT(*) FROM orders;
```

### من الـ Node.js:

```javascript
const { getDb } = require('./lib/sqlite');
const db = getDb();

// مثال
const orders = db.prepare(`
  SELECT id, status, total_amount 
  FROM orders 
  WHERE status = 'paid'
  LIMIT 10
`).all();

console.table(orders);
```

### من التطبيق نفسه (API):

```javascript
// أضف route للمسؤولين فقط
router.get('/admin/orders-report', adminMiddleware, (req, res) => {
  const db = getDb();
  const report = db.prepare(`
    SELECT COUNT(*) as total_orders,
           SUM(total_amount) as total_revenue
    FROM orders WHERE status = 'paid'
  `).get();
  
  res.json(report);
});
```
