const express = require('express');
const jwt = require('jsonwebtoken');
const bcrypt = require('bcryptjs');
const crypto = require('crypto');
const User = require('../models/User');
const { Order, Enrollment } = require('../models/Order');
const { protect } = require('../middleware/auth');
const { sendVerificationEmail, sendPasswordResetEmail } = require('../utils/email');

const router = express.Router();
const JWT_SECRET = process.env.JWT_SECRET || (
  process.env.NODE_ENV === 'production'
    ? (() => { throw new Error('JWT_SECRET must be configured in production'); })()
    : 'local_dev_secret_change_me'
);

// Helper to sign JWT token with user's _id
function signToken(user) {
  // Use user._id which is the MongoDB ObjectId
  return jwt.sign({ id: user._id.toString() }, JWT_SECRET, { expiresIn: '30d' });
}

// Normalization functions remain the same
function normalizeEmail(email) {
  return String(email || '').trim().toLowerCase();
}

function normalizeUsername(username) {
  return String(username || '').trim().normalize('NFKC').toLowerCase();
}

// Validation regex and functions remain the same
const USERNAME_REGEX = /^[\p{L}\p{N}_]{3,}$/u;
function isValidUsername(username) {
  return USERNAME_REGEX.test(normalizeUsername(username));
}

const PASSWORD_REGEX = /^(?=.*\p{L})(?=.*\p{N})(?=.*[^\p{L}\p{N}\s]).{6,}$/u;
function isStrongPassword(password) {
  return PASSWORD_REGEX.test(String(password || '').normalize('NFKC'));
}

function validateUsernameOrThrow(username) {
  if (!isValidUsername(username)) {
    const error = new Error('اسم المستخدم يجب أن يكون 3 خانات على الأقل، ويمكن أن يحتوي على أحرف أو أرقام أو شرطة سفلية');
    error.statusCode = 400;
    throw error;
  }
}

function validatePasswordOrThrow(password) {
  if (!isStrongPassword(password)) {
    const error = new Error('كلمة المرور يجب أن تكون 6 أحرف على الأقل وتحتوي على حرف ورقم ورمز');
    error.statusCode = 400;
    throw error;
  }
}

// A simplified and safer user object mapper
function mapUser(user) {
    if (!user) return null;
    const userObject = user.toObject ? user.toObject() : user;
    return {
      id: userObject._id, // Keep `id` as string representation of `_id` for compatibility
      _id: userObject._id,
      firstName: userObject.firstName || '',
      lastName: userObject.lastName || '',
      username: userObject.username || '',
      email: userObject.email || '',
      phone: userObject.phone || '',
      passwordHash: userObject.passwordHash || '',
      role: userObject.role || 'student',
      isVerified: !!userObject.isVerified,
      verificationCode: userObject.verificationCode || '',
      resetToken: userObject.resetToken || '',
      resetExpires: userObject.resetExpires || '',
      createdAt: userObject.createdAt,
      updatedAt: userObject.updatedAt,
    };
}

// Database queries updated to use _id and proper Mongoose methods
async function getUserById(id) {
  const user = await User.findById(id).lean();
  return mapUser(user);
}

async function getUserByEmail(email) {
  const user = await User.findOne({ email: normalizeEmail(email) }).lean();
  return mapUser(user);
}

async function getUserByUsername(username) {
  const user = await User.findOne({ username: normalizeUsername(username) }).lean();
  return mapUser(user);
}

async function findUserByLogin(login) {
  const user = await User.findOne({
    $or: [{ email: normalizeEmail(login) }, { username: normalizeUsername(login) }],
  }).lean();
  return mapUser(user);
}

// Serialize user data for frontend, using user._id
async function serializeUser(user) {
  if (!user) return null;
  const userId = user._id;
  const enrollments = await Enrollment.find({ userId }).lean();
  const paidOrders = await Order.find({ userId, status: { $in: ['paid', 'manual'] } }).sort({ createdAt: -1 }).lean();

  return {
    username: user.username,
    email: user.email,
    name: [user.firstName, user.lastName].filter(Boolean).join(' ').trim(),
    phone: user.phone || '',
    role: user.role,
    isAdmin: user.role === 'admin',
    isVerified: user.isVerified,
    enrolledCourses: enrollments.map((item) => item.courseId.toString()).filter(Boolean),
    enrolledCourseTitles: [], // This seems to be unused, but kept for compatibility
    totalSpent: paidOrders.reduce((sum, order) => sum + Number(order.totalAmount || 0), 0),
    orders: paidOrders.map((order) => order.orderId).filter(Boolean),
    joinDate: user.createdAt,
  };
}

// Helper to split full name
function splitName(name) {
  const parts = String(name || '').trim().split(/\s+/).filter(Boolean);
  const firstName = parts.shift() || 'مستخدم';
  const lastName = parts.join(' ') || 'جديد';
  return { firstName, lastName };
}

// Get user orders using userId (_id)
async function getUserOrders(userId) {
    const orders = await Order.find({ userId, status: { $in: ['paid', 'manual'] } }).sort({ createdAt: -1 }).lean();

    return orders.map((order) => ({
        orderId: order.orderId,
        total: Number(order.totalAmount || 0),
        date: order.createdAt,
        status: order.status,
        items: (order.courses || []).map((item) => ({
            id: item.courseId ? item.courseId.toString() : null,
            title: item.courseTitle || '',
            price: Number(item.priceAtTime || 0),
        })),
    }));
}

// --- ROUTES ---

router.post('/register', async (req, res) => {
  try {
    const { name, username, email, password } = req.body;
    if (!name || !username || !email || !password) {
      return res.status(400).json({ error: 'يرجى إكمال جميع الحقول' });
    }

    validateUsernameOrThrow(username);
    validatePasswordOrThrow(password);

    const normalizedEmail = normalizeEmail(email);
    const normalizedUsername = normalizeUsername(username);

    if (await getUserByEmail(normalizedEmail)) {
      return res.status(400).json({ error: 'هذا البريد الإلكتروني مسجل بالفعل' });
    }
    if (await getUserByUsername(normalizedUsername)) {
      return res.status(400).json({ error: 'اسم المستخدم مستخدم بالفعل' });
    }

    const { firstName, lastName } = splitName(name);
    const passwordHash = await bcrypt.hash(password, 12);
    const verificationCode = crypto.randomBytes(3).toString('hex').toUpperCase();

    // Create user without the problematic numeric `id`
    const userDoc = await User.create({
      firstName,
      lastName,
      username: normalizedUsername,
      email: normalizedEmail,
      phone: '',
      passwordHash,
      role: 'student',
      isVerified: false,
      verificationCode,
    });

    const user = mapUser(userDoc);
    await sendVerificationEmail(user.email, verificationCode);

    return res.status(201).json({
      message: 'تم إنشاء الحساب بنجاح. يرجى التحقق من بريدك الإلكتروني لتفعيل الحساب.',
      user: await serializeUser(user),
    });
  } catch (error) {
    console.error('Registration error:', error);
    return res.status(error.statusCode || 500).json({ error: error.message || 'تعذر إنشاء الحساب' });
  }
});

router.post('/verify-email', async (req, res) => {
  try {
    const { email, code } = req.body;
    const user = await getUserByEmail(email);

    if (!user || user.verificationCode !== code.toUpperCase()) {
      return res.status(400).json({ error: 'رمز التحقق غير صالح' });
    }

    // Update user by _id
    await User.updateOne({ _id: user._id }, { $set: { isVerified: true, verificationCode: '' } });
    const updatedUser = await getUserById(user._id);

    return res.json({
      token: signToken(updatedUser),
      user: await serializeUser(updatedUser),
      message: 'تم تفعيل حسابك بنجاح.',
    });
  } catch (error) {
    console.error('Email verification error:', error);
    return res.status(500).json({ error: 'فشل في تفعيل الحساب' });
  }
});

router.post('/login', async (req, res) => {
  try {
    const loginValue = req.body.login || req.body.email || '';
    const { password } = req.body;
    if (!loginValue || !password) {
      return res.status(400).json({ error: 'أدخل البريد أو اسم المستخدم وكلمة المرور' });
    }

    const user = await findUserByLogin(loginValue);
    if (!user || !(await bcrypt.compare(password, user.passwordHash))) {
      return res.status(401).json({ error: 'اسم المستخدم أو البريد الإلكتروني أو كلمة المرور غير صحيحة' });
    }

    if (!user.isVerified) {
       // Optionally, resend verification on login attempt
       // await sendVerificationEmail(user.email, user.verificationCode);
      return res.status(401).json({ error: 'يرجى تفعيل حسابك أولاً. تم إرسال رمز التحقق إلى بريدك الإلكتروني.' });
    }

    return res.json({
      token: signToken(user),
      user: await serializeUser(user),
    });
  } catch (error) {
    console.error('Login error:', error);
    return res.status(500).json({ error: 'تعذر تسجيل الدخول' });
  }
});

router.post('/forgot-password', async (req, res) => {
  try {
    const { email } = req.body;
    const user = await getUserByEmail(email);

    if (!user) {
      // Respond gently to prevent user enumeration
      return res.json({ message: 'إذا كان البريد الإلكتروني موجودًا، فسيتم إرسال رمز إعادة التعيين.' });
    }

    const resetCode = crypto.randomBytes(3).toString('hex').toUpperCase();
    const resetExpires = String(Date.now() + 3600000); // 1 hour

    await User.updateOne({ _id: user._id }, { $set: { resetToken: resetCode, resetExpires } });
    await sendPasswordResetEmail(user.email, resetCode);

    return res.json({ message: 'تم إرسال رمز إعادة تعيين كلمة المرور إلى بريدك الإلكتروني.' });
  } catch (error) {
    console.error('Forgot password error:', error);
    return res.status(500).json({ error: 'فشل في إرسال البريد الإلكتروني' });
  }
});

router.post('/reset-password', async (req, res) => {
  try {
    const { email, code, newPassword } = req.body;
    const user = await getUserByEmail(email);

    if (!user || user.resetToken !== code.toUpperCase() || Number(user.resetExpires || 0) < Date.now()) {
      return res.status(400).json({ error: 'رمز إعادة التعيين غير صالح أو منتهي الصلاحية' });
    }

    validatePasswordOrThrow(newPassword);
    const passwordHash = await bcrypt.hash(newPassword, 12);

    await User.updateOne({ _id: user._id }, { $set: { passwordHash, resetToken: '', resetExpires: '' } });

    return res.json({ message: 'تم تغيير كلمة المرور بنجاح.' });
  } catch (error) {
    console.error('Reset password error:', error);
    return res.status(error.statusCode || 500).json({ error: error.message || 'فشل في إعادة تعيين كلمة المرور' });
  }
});

router.get('/me', protect, async (req, res) => {
  try {
    // req.user is the lean user object from `protect` middleware
    const freshUser = await getUserById(req.user._id);
    return res.json({
      user: await serializeUser(freshUser),
      orders: await getUserOrders(freshUser._id),
    });
  } catch (error) {
    console.error('Get me error:', error);
    return res.status(500).json({ error: 'تعذر تحميل بيانات الحساب' });
  }
});

module.exports = router;
