const fs = require('fs');
const path = require('path');
const Database = require('better-sqlite3');
const defaultCourses = require('../data/default-courses.json');

let database = null;
let databasePath = null;
let databaseReady = false;
let databaseError = null;

function nowIso() {
  return new Date().toISOString();
}

function toJson(value, fallback) {
  return JSON.stringify(value ?? fallback);
}

function fromJson(value, fallback) {
  if (!value) return fallback;
  try {
    return JSON.parse(value);
  } catch {
    return fallback;
  }
}

function boolToInt(value) {
  return value ? 1 : 0;
}

function resolveDatabasePath() {
  const configuredPath = process.env.SQLITE_PATH || './data/hifz-platform.sqlite';
  return path.isAbsolute(configuredPath)
    ? configuredPath
    : path.resolve(__dirname, '..', configuredPath);
}

function columnExists(db, tableName, columnName) {
  return db.prepare(`PRAGMA table_info(${tableName})`).all().some((column) => column.name === columnName);
}

function normalizeUsernameValue(value) {
  return String(value || '')
    .trim()
    .normalize('NFKC')
    .toLowerCase()
    .replace(/[^\p{L}\p{N}_]+/gu, '');
}

function buildFallbackUsername(source, id, used = new Set()) {
  let base = normalizeUsernameValue(source).slice(0, 24);
  if (!/\p{L}/u.test(base)) base = `user${id}`;
  if (!/\p{N}/u.test(base)) base = `${base}${id}`;
  if (base.length < 4) base = `${base}${String(id).padStart(4, '0')}`;

  let candidate = base.slice(0, 32);
  let counter = 1;

  while (used.has(candidate) || candidate.length < 4) {
    const suffix = String(id + counter);
    const prefix = base.slice(0, Math.max(1, 32 - suffix.length));
    candidate = `${prefix}${suffix}`;
    counter += 1;
  }

  return candidate;
}

function ensureUserSchema(db) {
  if (!columnExists(db, 'users', 'username')) {
    db.exec(`ALTER TABLE users ADD COLUMN username TEXT NOT NULL DEFAULT ''`);
  }
  if (!columnExists(db, 'orders', 'payment_method')) {
    db.exec(`ALTER TABLE orders ADD COLUMN payment_method TEXT`);
  }
  if (!columnExists(db, 'orders', 'payment_reference')) {
    db.exec(`ALTER TABLE orders ADD COLUMN payment_reference TEXT`);
  }
  if (!columnExists(db, 'orders', 'stripe_session_id')) {
    db.exec(`ALTER TABLE orders ADD COLUMN stripe_session_id TEXT`);
  }
  if (!columnExists(db, 'orders', 'stripe_payment_intent')) {
    db.exec(`ALTER TABLE orders ADD COLUMN stripe_payment_intent TEXT`);
  }
  if (!columnExists(db, 'users', 'reset_token')) {
    db.exec(`ALTER TABLE users ADD COLUMN reset_token TEXT`);
  }
  if (!columnExists(db, 'users', 'reset_expires')) {
    db.exec(`ALTER TABLE users ADD COLUMN reset_expires TEXT`);
  }
  if (!columnExists(db, 'users', 'verification_code')) {
    db.exec(`ALTER TABLE users ADD COLUMN verification_code TEXT`);
  }

  const rows = db.prepare(`
    SELECT id, email, username, updated_at
    FROM users
    ORDER BY id ASC
  `).all();

  const usedUsernames = new Set();

  rows.forEach((row) => {
    let username = normalizeUsernameValue(row.username);
    const isValid =
      username.length >= 3 &&
      /\p{L}/u.test(username) &&
      !usedUsernames.has(username);

    if (!isValid) {
      username = buildFallbackUsername(row.email, row.id, usedUsernames);
    }

    if (username !== row.username) {
      db.prepare('UPDATE users SET username = ?, updated_at = ? WHERE id = ?').run(
        username,
        row.updated_at || nowIso(),
        row.id
      );
    }

    usedUsernames.add(username);
  });

  db.exec('CREATE UNIQUE INDEX IF NOT EXISTS idx_users_username ON users(username);');
  db.exec('CREATE INDEX IF NOT EXISTS idx_users_role ON users(role);');
}

function ensureDatabaseIndexesAndHealth(db) {
  db.exec('PRAGMA foreign_keys = ON;');
  db.exec('PRAGMA journal_mode = WAL;');

  db.exec(`
    CREATE UNIQUE INDEX IF NOT EXISTS idx_categories_name ON categories(name);
    CREATE UNIQUE INDEX IF NOT EXISTS idx_categories_slug ON categories(slug);
    CREATE UNIQUE INDEX IF NOT EXISTS idx_users_email ON users(email);
    CREATE UNIQUE INDEX IF NOT EXISTS idx_users_username ON users(username);

    CREATE INDEX IF NOT EXISTS idx_users_created_at ON users(created_at);
    CREATE INDEX IF NOT EXISTS idx_orders_user_status ON orders(user_id, status, created_at);
    CREATE INDEX IF NOT EXISTS idx_orders_status_created ON orders(status, created_at);
    CREATE INDEX IF NOT EXISTS idx_order_items_order_course ON order_items(order_id, course_id);
    CREATE INDEX IF NOT EXISTS idx_enrollments_user_course ON enrollments(user_id, course_id);
    CREATE INDEX IF NOT EXISTS idx_enrollments_course_user ON enrollments(course_id, user_id);
    CREATE INDEX IF NOT EXISTS idx_courses_category_published ON courses(category, is_published, id);
    CREATE INDEX IF NOT EXISTS idx_courses_published ON courses(is_published, id);
    CREATE INDEX IF NOT EXISTS idx_lessons_course_order ON lessons(course_id, lesson_order, id);
    CREATE INDEX IF NOT EXISTS idx_lessons_free_course ON lessons(course_id, is_free);
    CREATE INDEX IF NOT EXISTS idx_contacts_email_created ON contacts(email, created_at);
  `);

  const integrityResult = db.prepare('PRAGMA integrity_check').get();
  if (!integrityResult || integrityResult.integrity_check !== 'ok') {
    const message = integrityResult?.integrity_check || 'database integrity verification failed';
    throw new Error(`Database integrity check failed: ${message}`);
  }
}

function slugifyCategoryName(value) {
  const raw = String(value || '').trim();
  if (!raw) return 'category';

  const normalized = raw
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 60);

  return normalized || 'category';
}

function ensureCategorySchema(db) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS categories (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL UNIQUE,
      slug TEXT NOT NULL UNIQUE,
      created_at TEXT NOT NULL
    );
  `);

  const existing = new Map(
    db.prepare('SELECT name, slug FROM categories').all().map((row) => [row.name, row.slug])
  );

  const timestamp = nowIso();
  const fallbackCategories = [
    { name: 'حفظ القرآن', slug: 'quran-memorization' },
    { name: 'التجويد', slug: 'tajweed' },
    { name: 'السنة', slug: 'sunnah' },
    { name: 'الفقه', slug: 'fiqh' },
    { name: 'العقيدة', slug: 'aqidah' },
  ];

  for (const category of fallbackCategories) {
    if (!existing.has(category.name)) {
      try {
        db.prepare('INSERT INTO categories (name, slug, created_at) VALUES (?, ?, ?)')
          .run(category.name, category.slug, timestamp);
      } catch {
        // ignore duplicates introduced by a race or previous partial seeding
      }
    }
  }

  const courseCategories = [...new Set(defaultCourses.map((course) => String(course.category || course.cat || 'حفظ القرآن').trim()).filter(Boolean))];
  for (const name of courseCategories) {
    if (existing.has(name)) continue;
    const slug = slugifyCategoryName(name);
    try {
      db.prepare('INSERT INTO categories (name, slug, created_at) VALUES (?, ?, ?)')
        .run(name, slug, timestamp);
    } catch {
      // ignore duplicate slug after fallback normalization
    }
  }
}

function createSchema(db) {
  db.exec('PRAGMA foreign_keys = ON;');
  db.exec('PRAGMA journal_mode = WAL;');

  db.exec(`
    CREATE TABLE IF NOT EXISTS users (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      first_name TEXT NOT NULL,
      last_name TEXT NOT NULL,
      username TEXT NOT NULL DEFAULT '',
      email TEXT NOT NULL UNIQUE,
      phone TEXT NOT NULL DEFAULT '',
      password_hash TEXT NOT NULL,
      role TEXT NOT NULL DEFAULT 'student',
      is_verified INTEGER NOT NULL DEFAULT 1,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS categories (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
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
      price REAL NOT NULL,
      old_price REAL,
      duration_label TEXT NOT NULL DEFAULT '',
      students_count INTEGER NOT NULL DEFAULT 0,
      rating REAL NOT NULL DEFAULT 5,
      description TEXT NOT NULL DEFAULT '',
      includes_json TEXT NOT NULL DEFAULT '[]',
      thumbnail TEXT NOT NULL DEFAULT '',
      is_published INTEGER NOT NULL DEFAULT 1,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS lessons (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      course_id INTEGER NOT NULL,
      title TEXT NOT NULL,
      description TEXT NOT NULL DEFAULT '',
      duration_label TEXT NOT NULL DEFAULT '',
      external_url TEXT NOT NULL DEFAULT '',
      video_url TEXT NOT NULL DEFAULT '',
      video_data TEXT NOT NULL DEFAULT '',
      is_free INTEGER NOT NULL DEFAULT 0,
      lesson_order INTEGER NOT NULL,
      added_at TEXT NOT NULL,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      FOREIGN KEY (course_id) REFERENCES courses(id) ON DELETE CASCADE
    );

    CREATE TABLE IF NOT EXISTS orders (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      order_id TEXT NOT NULL UNIQUE,
      user_id INTEGER NOT NULL,
      total_amount REAL NOT NULL DEFAULT 0,
      status TEXT NOT NULL DEFAULT 'paid',
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
    );

    CREATE TABLE IF NOT EXISTS order_items (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      order_id INTEGER NOT NULL,
      course_id INTEGER,
      course_title TEXT NOT NULL DEFAULT '',
      price_at_time REAL NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL,
      FOREIGN KEY (order_id) REFERENCES orders(id) ON DELETE CASCADE,
      FOREIGN KEY (course_id) REFERENCES courses(id) ON DELETE SET NULL
    );

    CREATE TABLE IF NOT EXISTS enrollments (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id INTEGER NOT NULL,
      course_id INTEGER NOT NULL,
      order_id INTEGER NOT NULL,
      progress REAL NOT NULL DEFAULT 0,
      completed_lessons_json TEXT NOT NULL DEFAULT '[]',
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      UNIQUE(user_id, course_id),
      FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE,
      FOREIGN KEY (course_id) REFERENCES courses(id) ON DELETE CASCADE,
      FOREIGN KEY (order_id) REFERENCES orders(id) ON DELETE CASCADE
    );

    CREATE TABLE IF NOT EXISTS contacts (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL,
      email TEXT NOT NULL,
      subject TEXT NOT NULL DEFAULT '',
      message TEXT NOT NULL,
      created_at TEXT NOT NULL
    );

    CREATE INDEX IF NOT EXISTS idx_users_email ON users(email);
    CREATE INDEX IF NOT EXISTS idx_lessons_course_id ON lessons(course_id, lesson_order);
    CREATE INDEX IF NOT EXISTS idx_orders_user_id ON orders(user_id, created_at);
    CREATE INDEX IF NOT EXISTS idx_order_items_order_id ON order_items(order_id);
    CREATE INDEX IF NOT EXISTS idx_enrollments_user_id ON enrollments(user_id);
    CREATE INDEX IF NOT EXISTS idx_contacts_email ON contacts(email, created_at);
  `);

  ensureCategorySchema(db);
  ensureUserSchema(db);
  ensureDatabaseIndexesAndHealth(db);
}

function normalizeCourse(course) {
  return {
    id: Number(course.legacyId || course.id),
    title: String(course.title || '').trim(),
    category: String(course.category || course.cat || 'حفظ القرآن').trim(),
    emoji: String(course.emoji || '📖'),
    bg: String(course.bg || 'linear-gradient(135deg,#1a6b4a,#22865e)'),
    badge: String(course.badge || ''),
    level: String(course.level || 'مبتدئ'),
    price: Number(course.price || 0),
    oldPrice: course.oldPrice === null || course.oldPrice === undefined || course.oldPrice === ''
      ? null
      : Number(course.oldPrice),
    durationLabel: String(course.durationLabel || course.duration || ''),
    studentsCount: Number(course.studentsCount || course.students || 0),
    rating: Number(course.rating || 5),
    description: String(course.description || course.desc || ''),
    includes: Array.isArray(course.includes) ? course.includes.filter(Boolean) : [],
    thumbnail: String(course.thumbnail || course.imgData || ''),
    isPublished: course.isPublished !== false,
    lessons: Array.isArray(course.lessons) ? course.lessons : [],
  };
}

function insertLesson(db, courseId, lesson, order) {
  const timestamp = nowIso();
  db.prepare(`
    INSERT INTO lessons (
      course_id, title, description, duration_label, external_url, video_url,
      video_data, is_free, lesson_order, added_at, created_at, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    courseId,
    String(lesson.title || '').trim(),
    String(lesson.description || ''),
    String(lesson.durationLabel || lesson.duration || ''),
    String(lesson.externalUrl || lesson.url || ''),
    String(lesson.videoUrl || lesson.url || ''),
    String(lesson.videoData || ''),
    boolToInt(lesson.isFree ?? lesson.free),
    order,
    String(lesson.addedAt || timestamp),
    timestamp,
    timestamp
  );
}

function upsertDefaultCourse(db, course, overwriteExisting) {
  const normalized = normalizeCourse(course);
  const existing = db.prepare('SELECT id FROM courses WHERE id = ?').get(normalized.id);
  const timestamp = nowIso();

  if (existing) {
    if (!overwriteExisting) return { inserted: false, updated: false };

    db.prepare(`
      UPDATE courses
      SET title = ?, category = ?, emoji = ?, bg = ?, badge = ?, level = ?, price = ?,
          old_price = ?, duration_label = ?, students_count = ?, rating = ?, description = ?,
          includes_json = ?, thumbnail = ?, is_published = ?, updated_at = ?
      WHERE id = ?
    `).run(
      normalized.title,
      normalized.category,
      normalized.emoji,
      normalized.bg,
      normalized.badge,
      normalized.level,
      normalized.price,
      normalized.oldPrice,
      normalized.durationLabel,
      normalized.studentsCount,
      normalized.rating,
      normalized.description,
      toJson(normalized.includes, []),
      normalized.thumbnail,
      boolToInt(normalized.isPublished),
      timestamp,
      normalized.id
    );

    return { inserted: false, updated: true };
  }

  db.prepare(`
    INSERT INTO courses (
      id, title, category, emoji, bg, badge, level, price, old_price,
      duration_label, students_count, rating, description, includes_json,
      thumbnail, is_published, created_at, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    normalized.id,
    normalized.title,
    normalized.category,
    normalized.emoji,
    normalized.bg,
    normalized.badge,
    normalized.level,
    normalized.price,
    normalized.oldPrice,
    normalized.durationLabel,
    normalized.studentsCount,
    normalized.rating,
    normalized.description,
    toJson(normalized.includes, []),
    normalized.thumbnail,
    boolToInt(normalized.isPublished),
    timestamp,
    timestamp
  );

  normalized.lessons.forEach((lesson, index) => {
    insertLesson(db, normalized.id, lesson, index + 1);
  });

  return { inserted: true, updated: false };
}

function runInTransaction(work) {
  const db = getDb();
  db.exec('BEGIN');
  try {
    const result = work(db);
    db.exec('COMMIT');
    return result;
  } catch (error) {
    try {
      db.exec('ROLLBACK');
    } catch {}
    throw error;
  }
}

function syncDefaultCourses({ overwriteExisting = false } = {}) {
  return runInTransaction((db) => {
    let inserted = 0;
    let updated = 0;

    defaultCourses.forEach((course) => {
      const result = upsertDefaultCourse(db, course, overwriteExisting);
      if (result.inserted) inserted += 1;
      if (result.updated) updated += 1;
    });

    return { inserted, updated };
  });
}

function initDatabase() {
  if (database) return database;

  databasePath = resolveDatabasePath();
  fs.mkdirSync(path.dirname(databasePath), { recursive: true });

  try {
    database = new Database(databasePath);
    createSchema(database);
    syncDefaultCourses({ overwriteExisting: false });
    databaseReady = true;
    databaseError = null;
    return database;
  } catch (error) {
    databaseReady = false;
    databaseError = error;
    throw error;
  }
}

function getDb() {
  if (!database) {
    return initDatabase();
  }
  return database;
}

function getDatabaseStatus() {
  return {
    ready: databaseReady,
    path: databasePath || resolveDatabasePath(),
    error: databaseError ? databaseError.message : null,
  };
}

module.exports = {
  boolToInt,
  fromJson,
  getDatabaseStatus,
  getDb,
  initDatabase,
  nowIso,
  resolveDatabasePath,
  runInTransaction,
  syncDefaultCourses,
  toJson,
};
