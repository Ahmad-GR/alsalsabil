require('dotenv').config();

const fs = require('fs');
const path = require('path');
const Database = require('better-sqlite3');
const { Pool } = require('pg');

async function checkSqlite() {
  const configuredPath = process.env.SQLITE_PATH || './data/hifz-platform.sqlite';
  const filePath = path.isAbsolute(configuredPath)
    ? configuredPath
    : path.resolve(__dirname, '..', configuredPath);

  if (!fs.existsSync(filePath)) {
    console.log('SQLite: file not present');
    return;
  }

  const db = new Database(filePath, { readonly: true, fileMustExist: true });
  try {
    const integrity = db.pragma('integrity_check', { simple: true });
    const tables = db.prepare('SELECT name FROM sqlite_master WHERE type = ? ORDER BY name')
      .all('table')
      .map(({ name }) => name);
    console.log(`SQLite: integrity=${integrity}; tables=${tables.length}`);
  } finally {
    db.close();
  }
}

async function checkPostgres() {
  if (!process.env.DATABASE_URL) {
    console.log('PostgreSQL: DATABASE_URL is not configured');
    return false;
  }

  let connectionString = process.env.DATABASE_URL;
  if (process.env.DATABASE_PORT) {
    const url = new URL(connectionString);
    url.port = process.env.DATABASE_PORT;
    connectionString = url.toString();
  }

  const pool = new Pool({
    connectionString,
    ssl: process.env.DATABASE_SSL === 'false' ? false : { rejectUnauthorized: false },
    connectionTimeoutMillis: Number(process.env.DATABASE_CONNECT_TIMEOUT_MS || 5000),
    max: 1,
  });

  try {
    const client = await pool.connect();
    try {
      await client.query('BEGIN READ ONLY');
      const info = await client.query('SELECT current_database() AS database_name, current_schema() AS schema_name');
      const tables = await client.query(
        'SELECT table_name FROM information_schema.tables WHERE table_schema = current_schema() AND table_type = $1 ORDER BY table_name',
        ['BASE TABLE']
      );
      const users = await client.query(
        "SELECT count(*)::int AS total, count(*) FILTER (WHERE role = 'admin')::int AS admins FROM users"
      );
      const courses = await client.query(
        'SELECT count(*)::int AS total, count(*) FILTER (WHERE is_published = 1)::int AS published FROM courses'
      );
      await client.query('ROLLBACK');
      console.log(`PostgreSQL: connected; database=${info.rows[0].database_name}; tables=${tables.rowCount}`);
      console.log(`Data counts: users=${users.rows[0].total}; admins=${users.rows[0].admins}; courses=${courses.rows[0].total}; published=${courses.rows[0].published}`);
      return true;
    } finally {
      client.release();
    }
  } catch (error) {
    console.error(`PostgreSQL: unavailable (${error.code || 'connection error'})`);
    return false;
  } finally {
    await pool.end();
  }
}

(async () => {
  await checkSqlite();
  const postgresReady = await checkPostgres();
  if (!postgresReady) process.exitCode = 1;
})().catch((error) => {
  console.error(`Database check failed (${error.code || error.message})`);
  process.exitCode = 1;
});