const jwt = require('jsonwebtoken');
const { getDb } = require('../lib/postgres');

const JWT_SECRET = process.env.JWT_SECRET || (
  process.env.NODE_ENV === 'production'
    ? (() => { throw new Error('JWT_SECRET must be configured in production'); })()
    : 'local_dev_secret_change_me'
);

function mapUserRow(row) {
  if (!row) return null;
  return {
    id: row.id,
    firstName: row.first_name,
    lastName: row.last_name,
    username: row.username,
    email: row.email,
    phone: row.phone || '',
    passwordHash: row.password_hash,
    role: row.role || 'student',
    isVerified: row.is_verified === 1 || row.is_verified === true,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

exports.protect = (req, res, next) => {
  try {
    const token = req.headers.authorization?.split(' ')[1];
    if (!token) {
      return res.status(401).json({ error: 'يجب تسجيل الدخول أولاً' });
    }

    const decoded = jwt.verify(token, JWT_SECRET);
    const db = getDb();
    const userRow = db.prepare('SELECT * FROM users WHERE id = ?').get(decoded.id);

    if (!userRow) {
      return res.status(401).json({ error: 'المستخدم غير موجود' });
    }

    req.user = mapUserRow(userRow);
    next();
  } catch (error) {
    return res.status(401).json({ error: 'التوكن غير صالح أو منتهي الصلاحية' });
  }
};

exports.isAdmin = (req, res, next) => {
  if (req.user?.role !== 'admin') {
    return res.status(403).json({ error: 'غير مصرح لك' });
  }
  return next();
};
