const { AsyncLocalStorage } = require('node:async_hooks');
const deasync = require('deasync');
const { Pool } = require('pg');
const bcrypt = require('bcryptjs');
const defaultCourses = require('../data/default-courses.json');

let pool = null;
const transactionContext = new AsyncLocalStorage();
let ready = false;
let databaseError = null;

function waitFor(promise) {
  let complete = false;
  let value;
  let error;
  promise.then((result) => { value = result; complete = true; }, (reason) => { error = reason; complete = true; });
  deasync.loopWhile(() => !complete);
  if (error) throw error;
  return value;
}

function querySync(executor, sql, params = []) {
  let complete = false;
  let value;
  let error;
  executor.query(sqlText(sql), params, (queryError, result) => {
    error = queryError;
    value = result;
    complete = true;
  });
  deasync.loopWhile(() => !complete);
  if (error) throw error;
  return value;
}

function sqlText(sql) {
  let index = 0;
  return sql.replace(/\?/g, () => `$${++index}`);
}

function query(sql, params = []) {
  const executor = transactionContext.getStore() || pool;
  return querySync(executor, sql, params);
}

function statement(sql) {
  return {
    all(...params) {
      return query(sql, params).rows;
    },
    get(...params) {
      return query(sql, params).rows[0];
    },
    run(...params) {
      let command = sql.trim();
      if (/^INSERT\s/i.test(command) && !/\bRETURNING\b/i.test(command)) {
        command += ' RETURNING id';
      }
      const result = query(command, params);
      return {
        changes: result.rowCount,
        lastInsertRowid: result.rows[0]?.id || null,
      };
    },
  };
}

function createSchema() {
  query(`
    CREATE TABLE IF NOT EXISTS users (
      id SERIAL PRIMARY KEY,
      first_name TEXT NOT NULL,
      last_name TEXT NOT NULL,
      username TEXT NOT NULL DEFAULT '',
      email TEXT NOT NULL UNIQUE,
      phone TEXT NOT NULL DEFAULT '',
      avatar_url TEXT NOT NULL DEFAULT '',
      password_hash TEXT NOT NULL,
      role TEXT NOT NULL DEFAULT 'student',
      is_verified INTEGER NOT NULL DEFAULT 1,
      reset_token TEXT,
      reset_expires TEXT,
      verification_code TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS categories (
      id SERIAL PRIMARY KEY,
      name TEXT NOT NULL UNIQUE,
      slug TEXT NOT NULL UNIQUE,
      created_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS courses (
      id INTEGER PRIMARY KEY,
      title TEXT NOT NULL,
      category TEXT NOT NULL,
      emoji TEXT NOT NULL DEFAULT '📖',
      bg TEXT NOT NULL DEFAULT 'linear-gradient(135deg,#1a6b4a,#22865e)',
      badge TEXT NOT NULL DEFAULT '',
      level TEXT NOT NULL DEFAULT 'مبتدئ',
      price NUMERIC NOT NULL DEFAULT 0,
      old_price NUMERIC,
      duration_label TEXT NOT NULL DEFAULT '',
      students_count INTEGER NOT NULL DEFAULT 0,
      rating NUMERIC NOT NULL DEFAULT 5,
      description TEXT NOT NULL DEFAULT '',
      includes_json TEXT NOT NULL DEFAULT '[]',
      thumbnail TEXT NOT NULL DEFAULT '',
      lifetime_access INTEGER NOT NULL DEFAULT 1,
      is_published INTEGER NOT NULL DEFAULT 1,
      course_end_at TIMESTAMPTZ,
      expired_action TEXT NOT NULL DEFAULT 'keep',
      is_archived INTEGER NOT NULL DEFAULT 0,
      teacher_id INTEGER REFERENCES users(id) ON DELETE SET NULL,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS lessons (
      id SERIAL PRIMARY KEY,
      course_id INTEGER NOT NULL REFERENCES courses(id) ON DELETE CASCADE,
      title TEXT NOT NULL,
      description TEXT NOT NULL DEFAULT '',
      duration_label TEXT NOT NULL DEFAULT '',
      external_url TEXT NOT NULL DEFAULT '',
      video_url TEXT NOT NULL DEFAULT '',
      video_data TEXT NOT NULL DEFAULT '',
      bunny_video_id TEXT,
      duration NUMERIC,
      file_size NUMERIC,
      is_protected INTEGER NOT NULL DEFAULT 0,
      processing_status TEXT,
      uploaded_at TEXT,
      is_free INTEGER NOT NULL DEFAULT 0,
      lesson_order INTEGER NOT NULL,
      added_at TEXT NOT NULL,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS orders (
      id SERIAL PRIMARY KEY,
      order_id TEXT NOT NULL UNIQUE,
      user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      total_amount NUMERIC NOT NULL DEFAULT 0,
      status TEXT NOT NULL DEFAULT 'paid',
      payment_method TEXT,
      payment_reference TEXT,
      stripe_session_id TEXT,
      stripe_payment_intent TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS order_items (
      id SERIAL PRIMARY KEY,
      order_id INTEGER NOT NULL REFERENCES orders(id) ON DELETE CASCADE,
      course_id INTEGER REFERENCES courses(id) ON DELETE SET NULL,
      course_title TEXT NOT NULL DEFAULT '',
      price_at_time NUMERIC NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS enrollments (
      id SERIAL PRIMARY KEY,
      user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      course_id INTEGER NOT NULL REFERENCES courses(id) ON DELETE CASCADE,
      order_id INTEGER NOT NULL REFERENCES orders(id) ON DELETE CASCADE,
      progress NUMERIC NOT NULL DEFAULT 0,
      completed_lessons_json TEXT NOT NULL DEFAULT '[]',
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      UNIQUE(user_id, course_id)
    );
    CREATE TABLE IF NOT EXISTS contacts (
      id SERIAL PRIMARY KEY,
      name TEXT NOT NULL,
      email TEXT NOT NULL,
      subject TEXT NOT NULL DEFAULT '',
      message TEXT NOT NULL,
      created_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS messages (
      id SERIAL PRIMARY KEY,
      sender_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      recipient_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      subject TEXT NOT NULL DEFAULT '',
      body TEXT NOT NULL,
      image_url TEXT NOT NULL DEFAULT '',
      is_read INTEGER NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS posts (
      id SERIAL PRIMARY KEY,
      author_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      course_id INTEGER REFERENCES courses(id) ON DELETE CASCADE,
      title TEXT NOT NULL,
      body TEXT NOT NULL,
      image_url TEXT NOT NULL DEFAULT '',
      post_type TEXT NOT NULL DEFAULT 'post',
      is_published INTEGER NOT NULL DEFAULT 1,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS notifications (
      id SERIAL PRIMARY KEY,
      user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      type TEXT NOT NULL,
      title TEXT NOT NULL,
      body TEXT NOT NULL DEFAULT '',
      link TEXT NOT NULL DEFAULT '',
      entity_id INTEGER,
      is_read INTEGER NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS otp_codes (
      id SERIAL PRIMARY KEY,
      user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      type TEXT NOT NULL,
      code TEXT NOT NULL,
      expires_at TEXT NOT NULL,
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
    );
  `);
  query("ALTER TABLE users ADD COLUMN IF NOT EXISTS first_name TEXT NOT NULL DEFAULT ''");
  query("ALTER TABLE users ADD COLUMN IF NOT EXISTS last_name TEXT NOT NULL DEFAULT ''");
  query("ALTER TABLE users ADD COLUMN IF NOT EXISTS username TEXT NOT NULL DEFAULT ''");
  query("ALTER TABLE users ADD COLUMN IF NOT EXISTS phone TEXT NOT NULL DEFAULT ''");
  query("ALTER TABLE users ADD COLUMN IF NOT EXISTS avatar_url TEXT NOT NULL DEFAULT ''");
  query("ALTER TABLE users ADD COLUMN IF NOT EXISTS is_verified INTEGER NOT NULL DEFAULT 1");
  query("ALTER TABLE courses ADD COLUMN IF NOT EXISTS duration_label TEXT NOT NULL DEFAULT ''");
  query("ALTER TABLE courses ADD COLUMN IF NOT EXISTS rating NUMERIC NOT NULL DEFAULT 5");
  query("ALTER TABLE courses ADD COLUMN IF NOT EXISTS is_published INTEGER NOT NULL DEFAULT 1");
  query("ALTER TABLE courses ADD COLUMN IF NOT EXISTS course_end_at TIMESTAMPTZ");
  query("ALTER TABLE courses ADD COLUMN IF NOT EXISTS lifetime_access INTEGER NOT NULL DEFAULT 1");
  query("ALTER TABLE courses ADD COLUMN IF NOT EXISTS expired_action TEXT NOT NULL DEFAULT 'keep'");
  query("ALTER TABLE courses ADD COLUMN IF NOT EXISTS is_archived INTEGER NOT NULL DEFAULT 0");
  query("ALTER TABLE courses ADD COLUMN IF NOT EXISTS teacher_id INTEGER REFERENCES users(id) ON DELETE SET NULL");
  query("ALTER TABLE messages ADD COLUMN IF NOT EXISTS subject TEXT NOT NULL DEFAULT ''");
  query("ALTER TABLE messages ADD COLUMN IF NOT EXISTS body TEXT NOT NULL DEFAULT ''");
  query("ALTER TABLE messages ADD COLUMN IF NOT EXISTS image_url TEXT NOT NULL DEFAULT ''");
  query("ALTER TABLE messages ADD COLUMN IF NOT EXISTS is_read INTEGER NOT NULL DEFAULT 0");
  query("ALTER TABLE posts ADD COLUMN IF NOT EXISTS course_id INTEGER REFERENCES courses(id) ON DELETE CASCADE");
  query("ALTER TABLE posts ADD COLUMN IF NOT EXISTS title TEXT NOT NULL DEFAULT ''");
  query("ALTER TABLE posts ADD COLUMN IF NOT EXISTS body TEXT NOT NULL DEFAULT ''");
  query("ALTER TABLE posts ADD COLUMN IF NOT EXISTS is_published INTEGER NOT NULL DEFAULT 1");
  query("ALTER TABLE posts ADD COLUMN IF NOT EXISTS created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP::text");
  query("ALTER TABLE posts ADD COLUMN IF NOT EXISTS updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP::text");
  query("ALTER TABLE notifications ADD COLUMN IF NOT EXISTS entity_id INTEGER");
  query("ALTER TABLE notifications ADD COLUMN IF NOT EXISTS body TEXT NOT NULL DEFAULT ''");
  query("ALTER TABLE notifications ADD COLUMN IF NOT EXISTS link TEXT NOT NULL DEFAULT ''");
  query("ALTER TABLE notifications ADD COLUMN IF NOT EXISTS is_read INTEGER NOT NULL DEFAULT 0");
  query("ALTER TABLE posts ADD COLUMN IF NOT EXISTS image_url TEXT NOT NULL DEFAULT ''");
  query("ALTER TABLE posts ADD COLUMN IF NOT EXISTS post_type TEXT NOT NULL DEFAULT 'post'");

  query('CREATE INDEX IF NOT EXISTS idx_users_role ON users(role)');
  query('CREATE INDEX IF NOT EXISTS idx_users_email ON users(email)');
  query('CREATE INDEX IF NOT EXISTS idx_lessons_course_id ON lessons(course_id, lesson_order)');
  query('CREATE INDEX IF NOT EXISTS idx_orders_user_id ON orders(user_id, created_at)');
  query('CREATE INDEX IF NOT EXISTS idx_orders_status_created ON orders(status, created_at)');
  query('CREATE INDEX IF NOT EXISTS idx_order_items_order_id ON order_items(order_id)');
  query('CREATE INDEX IF NOT EXISTS idx_enrollments_user_id ON enrollments(user_id)');
  query('CREATE INDEX IF NOT EXISTS idx_contacts_email ON contacts(email, created_at)');
  query('CREATE INDEX IF NOT EXISTS idx_otp_user_type ON otp_codes(user_id, type, created_at)');
  query('CREATE INDEX IF NOT EXISTS idx_messages_recipient ON messages(recipient_id, is_read, created_at)');
  query('CREATE INDEX IF NOT EXISTS idx_messages_sender ON messages(sender_id, created_at)');
  query('CREATE INDEX IF NOT EXISTS idx_posts_course ON posts(course_id, is_published, created_at)');
  query('CREATE INDEX IF NOT EXISTS idx_notifications_user ON notifications(user_id, is_read, created_at)');
  query('CREATE INDEX IF NOT EXISTS idx_notifications_entity ON notifications(user_id, type, entity_id)');
  query('CREATE INDEX IF NOT EXISTS idx_courses_public_stats ON courses(is_published, is_archived, course_end_at)');
  query('CREATE INDEX IF NOT EXISTS idx_enrollments_course_user ON enrollments(course_id, user_id)');
  query('CREATE INDEX IF NOT EXISTS idx_posts_published_type_created ON posts(is_published, post_type, created_at DESC)');
  query('CREATE INDEX IF NOT EXISTS idx_messages_conversation_created ON messages(sender_id, recipient_id, created_at DESC)');
  query('CREATE INDEX IF NOT EXISTS idx_messages_recipient_conversation_created ON messages(recipient_id, sender_id, created_at DESC)');

  const userColumns = new Set(query(`
    SELECT column_name
    FROM information_schema.columns
    WHERE table_schema = current_schema() AND table_name = 'users'
  `).rows.map((row) => row.column_name));
  if (userColumns.has('name')) {
    query(`
      UPDATE users
      SET first_name = COALESCE(NULLIF(first_name, ''), split_part(btrim(name), ' ', 1)),
          last_name = COALESCE(
            NULLIF(last_name, ''),
            NULLIF(substr(btrim(name), length(split_part(btrim(name), ' ', 1)) + 2), '')
          )
      WHERE name IS NOT NULL AND (COALESCE(first_name, '') = '' OR COALESCE(last_name, '') = '')
    `);
  }
}

function seedCategories() {
  const categories = [
    ['حفظ القرآن', 'quran-memorization'],
    ['التجويد', 'tajweed'],
    ['السنة', 'sunnah'],
    ['الفقه', 'fiqh'],
    ['العقيدة', 'aqidah'],
  ];
  categories.forEach(([name, slug]) => {
    query('INSERT INTO categories (name, slug, created_at) VALUES (?, ?, ?) ON CONFLICT (name) DO NOTHING', [name, slug, new Date().toISOString()]);
  });
}

function syncDefaultCourses() {
  defaultCourses.forEach((course) => {
    const id = Number(course.legacyId || course.id);
    const exists = statement('SELECT id FROM courses WHERE id = ?').get(id);
    if (!exists) {
      const now = new Date().toISOString();
      statement(`INSERT INTO courses (id, title, category, emoji, bg, badge, level, price, old_price, duration_label, students_count, rating, description, includes_json, thumbnail, is_published, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(
        id, course.title || '', course.category || course.cat || 'حفظ القرآن', course.emoji || '📖',
        course.bg || 'linear-gradient(135deg,#1a6b4a,#22865e)', course.badge || '', course.level || 'مبتدئ',
        Number(course.price || 0), course.oldPrice == null ? null : Number(course.oldPrice),
        course.durationLabel || course.duration || '', Number(course.studentsCount || course.students || 0),
        Number(course.rating || 5), course.description || course.desc || '',
        JSON.stringify(Array.isArray(course.includes) ? course.includes.filter(Boolean) : []),
        course.thumbnail || course.imgData || '', course.isPublished === false ? 0 : 1, now, now
      );
    }
  });
}

function seedConfiguredAdmin() {
  const adminEmail = String(process.env.ADMIN_EMAIL || '').trim().toLowerCase();
  const adminPassword = String(process.env.ADMIN_PASSWORD || '');
  if (!adminEmail || !adminPassword) return;

  const existingUsers = statement('SELECT COUNT(*)::int AS count FROM users').get();
  if (Number(existingUsers?.count || 0) !== 0) return;

  const now = new Date().toISOString();
  statement(`
    INSERT INTO users (
      first_name, last_name, username, email, phone, password_hash,
      role, is_verified, created_at, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, 'admin', 1, ?, ?)
  `).run(
    'مدير',
    'النظام',
    String(process.env.ADMIN_USERNAME || 'admin1').trim().toLowerCase(),
    adminEmail,
    '',
    bcrypt.hashSync(adminPassword, 12),
    now,
    now
  );
}

function initDatabase() {
  if (ready) return pool;
  if (!process.env.DATABASE_URL) {
    throw new Error('DATABASE_URL is required for PostgreSQL/Supabase');
  }
  pool = new Pool({
    connectionString: process.env.DATABASE_URL,
    ssl: process.env.DATABASE_SSL === 'false' ? false : { rejectUnauthorized: false },
    max: Number(process.env.DATABASE_POOL_SIZE || 10),
    connectionTimeoutMillis: Number(process.env.DATABASE_CONNECT_TIMEOUT_MS || 10000),
  });
  try {
    query('SELECT 1 AS result');
    createSchema();
    seedConfiguredAdmin();
    seedCategories();
    syncDefaultCourses();
    ready = true;
    databaseError = null;
    return pool;
  } catch (error) {
    databaseError = error;
    throw error;
  }
}

function getDb() {
  if (!ready) initDatabase();
  return {
    open: true,
    prepare: statement,
    exec(sql) { sql.split(';').map((part) => part.trim()).filter(Boolean).forEach((part) => query(part)); },
    transaction(work) {
      let client;
      let connectionError;
      let connected = false;
      pool.connect((error, connectedClient) => {
        connectionError = error;
        client = connectedClient;
        connected = true;
      });
      deasync.loopWhile(() => !connected);
      if (connectionError) throw connectionError;
      return transactionContext.run(client, () => {
        try {
          query('BEGIN');
          const result = work(this);
          query('COMMIT');
          return result;
        } catch (error) {
          query('ROLLBACK');
          throw error;
        } finally {
          client.release();
        }
      });
    },
  };
}

function runInTransaction(work) {
  return getDb().transaction(work);
}

function nowIso() { return new Date().toISOString(); }
function boolToInt(value) { return value ? 1 : 0; }
function toJson(value, fallback) { return JSON.stringify(value ?? fallback); }
function fromJson(value, fallback) {
  if (!value) return fallback;
  try { return JSON.parse(value); } catch { return fallback; }
}
function getDatabaseStatus() {
  return { ready, path: 'Supabase PostgreSQL', error: databaseError ? databaseError.message : null };
}

module.exports = { boolToInt, fromJson, getDatabaseStatus, getDb, initDatabase, nowIso, runInTransaction, toJson };
