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
function validateDisplayNameOrThrow(value, fieldName) {
  const name = String(value || '').trim();
  if (!name || name.length > 80 || /[<>]/u.test(name) || /[\u0000-\u001F\u007F]/u.test(name)) {
    const error = new Error(`${fieldName} يحتوي على أحرف غير صالحة`);
    error.statusCode = 400;
    throw error;
  }
}
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
    thumbnail: (() => {
      const value = String(body.imgData || body.thumbnail || existingCourse?.thumbnail || '').trim();
      if (!value) return '';
      if (value.startsWith('data:image/')) return normalizeImageData(value);
      return /^https?:\/\/[^
