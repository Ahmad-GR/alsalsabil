const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '.env') });
require('dotenv').config({ path: path.join(__dirname, '..', '.env') });
const express = require('express');
const cors = require('cors');
const { getDb, initDatabase } = require('./lib/postgres');

const app = express();
const port = process.env.PORT || 5001;
let serverStarted = false;

app.disable('x-powered-by');
app.use((req, res, next) => {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Frame-Options', 'DENY');
  res.setHeader('Referrer-Policy', 'strict-origin-when-cross-origin');
  res.setHeader('Permissions-Policy', 'camera=(), microphone=(), geolocation=()');
  if (process.env.NODE_ENV === 'production') {
    res.setHeader('Strict-Transport-Security', 'max-age=31536000; includeSubDomains');
  }
  next();
});
app.use(express.json({ limit: '10mb' }));
app.use(cors({
  origin(origin, callback) {
    const allowed = [process.env.CLIENT_URL, 'http://localhost:5500', 'http://localhost:5501', 'http://localhost:5502', 'http://127.0.0.1:5500', 'http://127.0.0.1:5501', 'http://127.0.0.1:5502'];
    if (!origin || allowed.includes(origin)) return callback(null, true);
    const publicHttpsOrigin = /^https:\/\/[^/]+\.(devtunnels\.ms|github\.dev|githubpreview\.dev)$/i.test(origin);
    if (publicHttpsOrigin) return callback(null, true);
    return callback(null, false);
  },
  credentials: true,
}));

app.use(express.static(path.join(__dirname, '..', 'public')));

// app.use('/api/auth', require('./routes/auth')); // تم تعطيل هذا المسار لأنه يتعارض مع site.js
app.use('/api/site', require('./routes/site'));
app.use('/api/payments', require('./routes/payments'));
app.use('/api/videos', require('./routes/videos'));

app.get('/api/health', (req, res) => {
  let dbStatus = 'disconnected';
  try {
    const db = getDb();
    if (db?.open) {
      const result = db.prepare('SELECT 1 AS result').get();
      if (result.result === 1) {
        dbStatus = 'connected';
      }
    }
  } catch (e) { /* ignore */ }

  res.json({
    status: 'ok',
    database: dbStatus,
    message: dbStatus === 'connected'
      ? 'الخادم وقاعدة البيانات يعملان بنجاح'
      : 'الخادم يعمل لكن قاعدة البيانات غير جاهزة حالياً',
  });
});

app.use('/api', (req, res) => {
  res.status(404).json({ error: 'مسار API غير موجود' });
});

app.get('*', (req, res) => {
  res.sendFile(path.join(__dirname, '..', 'public', 'index.html'));
});

function startServer() {
  if (serverStarted) return;
  serverStarted = true;
  app.listen(port, () => {
    console.log(`Server running: http://localhost:${port}`);
    console.log(`Open in browser: http://localhost:${port}`);
  });
}

async function bootstrap() {
  try {
    initDatabase();
  } catch (err) {
    console.error('❌ فشل الاتصال بقاعدة البيانات:', err.message);
  }

  startServer();
}

bootstrap();
