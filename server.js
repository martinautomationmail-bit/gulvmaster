'use strict';

/*
  Gulv Master — PostgreSQL edition
  ------------------------------------------------------------
  Rules built into this server:
  1) GitHub contains code only.
  2) Render Postgres owns all users, tasks, bookings, notes and capacity data.
  3) JobTread sync is read-only input. It upserts jt_tasks only.
     It NEVER creates, edits or deletes planning_bookings.
  4) A one-time protected migration page imports the existing SQLite database
     directly into Postgres without putting the .db file in GitHub.
*/

const express = require('express');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const path = require('path');
const crypto = require('crypto');
const cron = require('node-cron');
const multer = require('multer');
const { Pool } = require('pg');
// Uses Node's built-in SQLite reader only for the one-time migration upload.
// This avoids native build issues on Render.
const { DatabaseSync: SqliteDatabase } = require('node:sqlite');
const fs = require('fs');
const os = require('os');

const app = express();
const PORT = Number(process.env.PORT || 3000);
const JWT_SECRET = process.env.JWT_SECRET || '';
const DATABASE_URL = process.env.DATABASE_URL || '';
const MIGRATION_SECRET = process.env.MIGRATION_SECRET || '';
const JT_ORG = process.env.JT_ORG_ID || '';
const JT_GRANT = process.env.JT_GRANT_KEY || '';
const JT_API = 'https://api.jobtread.com/pave';
// JobTread paginerer lister. Its task query accepts 40 per page in this portal;
// we fetch subsequent pages with nextPage instead of asking for 250 at once.
const JT_PAGE_SIZE = Math.max(1, Math.min(40, Number.parseInt(process.env.JT_PAGE_SIZE || process.env.JT_TASK_LIMIT || '40', 10) || 40));
const JT_MAX_PAGES = Math.max(1, Math.min(100, Number.parseInt(process.env.JT_MAX_PAGES || '100', 10) || 100));
const JT_INCLUDE_TODOS = String(process.env.JT_INCLUDE_TODOS || 'true').toLowerCase() !== 'false';
const JT_AUTO_SYNC = String(process.env.JT_AUTO_SYNC || 'true').toLowerCase() !== 'false';

if (!DATABASE_URL) {
  console.error('FATAL: DATABASE_URL mangler. Appen kan ikke starte uden Render Postgres.');
  process.exit(1);
}
if (!JWT_SECRET) {
  console.error('FATAL: JWT_SECRET mangler.');
  process.exit(1);
}

app.disable('x-powered-by');
// 12mb: rummer base64 logo/avatar-billeder sendt som data-URI fra admin-UI'et.
app.use(express.json({ limit: '12mb' }));
app.use(express.urlencoded({ extended: false }));

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 1024 * 1024, files: 1 },
  fileFilter: (req, file, cb) => {
    const lower = String(file.originalname || '').toLowerCase();
    if (!lower.endsWith('.db') && !lower.endsWith('.sqlite') && !lower.endsWith('.sqlite3')) {
      return cb(new Error('Vælg en SQLite databasefil (.db, .sqlite eller .sqlite3).'));
    }
    cb(null, true);
  }
});

const pool = new Pool({
  connectionString: DATABASE_URL,
  max: 5,
  idleTimeoutMillis: 30000,
  connectionTimeoutMillis: 10000
});

function asyncRoute(handler) {
  return (req, res, next) => Promise.resolve(handler(req, res, next)).catch(next);
}

function nowTextSQL() {
  return "(CURRENT_TIMESTAMP AT TIME ZONE 'UTC')::text";
}

async function initSchema() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS users (
      id SERIAL PRIMARY KEY,
      name TEXT NOT NULL,
      email TEXT UNIQUE NOT NULL,
      password_hash TEXT NOT NULL,
      role TEXT DEFAULT 'employee',
      color TEXT DEFAULT '#2563EB',
      initials TEXT,
      jobtread_name TEXT,
      active INTEGER DEFAULT 1,
      created_at TEXT DEFAULT ${nowTextSQL()},
      worker_type TEXT DEFAULT 'employee',
      vendor_group TEXT,
      trade TEXT,
      weekly_capacity DOUBLE PRECISION DEFAULT 5,
      can_login INTEGER DEFAULT 1
    );

    CREATE TABLE IF NOT EXISTS jt_tasks (
      id TEXT PRIMARY KEY,
      name TEXT,
      job_id TEXT,
      job_name TEXT,
      job_address TEXT,
      start_date TEXT,
      end_date TEXT,
      type_guess TEXT,
      raw_assignee_name TEXT,
      jt_url TEXT,
      synced_at TEXT DEFAULT ${nowTextSQL()},
      source TEXT DEFAULT 'jobtread',
      created_at TEXT,
      customer_phone TEXT
    );

    CREATE TABLE IF NOT EXISTS assignments (
      id SERIAL PRIMARY KEY,
      task_id TEXT NOT NULL,
      user_id INTEGER NOT NULL,
      week_key TEXT NOT NULL,
      days DOUBLE PRECISION DEFAULT 1,
      notes TEXT,
      start_time TEXT,
      start_date TEXT,
      end_date TEXT,
      created_at TEXT DEFAULT ${nowTextSQL()},
      updated_at TEXT
    );

    CREATE TABLE IF NOT EXISTS planning_bookings (
      id SERIAL PRIMARY KEY,
      task_id TEXT NOT NULL,
      user_id INTEGER NOT NULL,
      week_key TEXT NOT NULL,
      days DOUBLE PRECISION DEFAULT 1,
      notes TEXT,
      start_time TEXT,
      start_date TEXT NOT NULL,
      end_date TEXT NOT NULL,
      created_at TEXT DEFAULT ${nowTextSQL()},
      updated_at TEXT DEFAULT ${nowTextSQL()}
    );

    CREATE TABLE IF NOT EXISTS time_logs (
      id SERIAL PRIMARY KEY,
      user_id INTEGER NOT NULL,
      task_id TEXT NOT NULL,
      started_at TEXT,
      stopped_at TEXT,
      duration_minutes INTEGER,
      notes TEXT,
      created_at TEXT DEFAULT ${nowTextSQL()}
    );

    CREATE TABLE IF NOT EXISTS sync_log (
      id SERIAL PRIMARY KEY,
      synced_at TEXT DEFAULT ${nowTextSQL()},
      tasks_imported INTEGER DEFAULT 0,
      status TEXT,
      message TEXT
    );

    CREATE TABLE IF NOT EXISTS app_migrations (
      name TEXT PRIMARY KEY,
      completed_at TEXT DEFAULT ${nowTextSQL()},
      details TEXT
    );

    CREATE INDEX IF NOT EXISTS idx_assignments_user_start ON assignments(user_id, start_date);
    CREATE INDEX IF NOT EXISTS idx_assignments_task ON assignments(task_id);
    CREATE INDEX IF NOT EXISTS idx_planning_bookings_user_start ON planning_bookings(user_id, start_date);
    CREATE INDEX IF NOT EXISTS idx_planning_bookings_task ON planning_bookings(task_id);
    CREATE INDEX IF NOT EXISTS idx_tasks_source_start ON jt_tasks(source, start_date);
  `);

  // ── v2.1 tilføjelser: logo/avatar, opgavebeskrivelse, filer, ugenoter,
  // og uafhængige "dage" for Daglig plan vs. Kapacitetsboard.
  // ALTER ... ADD COLUMN IF NOT EXISTS er sikkert at køre igen og igen,
  // så eksisterende databaser i produktion opgraderes uden datatab.
  await pool.query(`
    ALTER TABLE users ADD COLUMN IF NOT EXISTS avatar_url TEXT;
    ALTER TABLE jt_tasks ADD COLUMN IF NOT EXISTS description TEXT;
    -- Contact columns are safe to add on an existing Render Postgres database.
    -- They let us keep a manual number protected from future JobTread syncs.
    ALTER TABLE jt_tasks ADD COLUMN IF NOT EXISTS customer_phone TEXT;
    ALTER TABLE jt_tasks ADD COLUMN IF NOT EXISTS customer_phone_source TEXT;
    ALTER TABLE jt_tasks ADD COLUMN IF NOT EXISTS customer_phone_synced_at TEXT;
    ALTER TABLE planning_bookings ADD COLUMN IF NOT EXISTS capacity_days DOUBLE PRECISION;
    -- Capacity-only reservations deliberately live outside the daily plan.
    -- Existing bookings stay daily by default, so this upgrade has no effect on prior plans.
    ALTER TABLE planning_bookings ADD COLUMN IF NOT EXISTS planning_mode TEXT DEFAULT 'daily';
    ALTER TABLE planning_bookings ADD COLUMN IF NOT EXISTS capacity_label TEXT;
    CREATE INDEX IF NOT EXISTS idx_planning_bookings_mode ON planning_bookings(planning_mode);

    CREATE TABLE IF NOT EXISTS app_settings (
      key TEXT PRIMARY KEY,
      value TEXT
    );

    CREATE TABLE IF NOT EXISTS job_files (
      id SERIAL PRIMARY KEY,
      task_id TEXT NOT NULL,
      name TEXT NOT NULL,
      url TEXT NOT NULL,
      category TEXT DEFAULT 'other',
      created_at TEXT DEFAULT ${nowTextSQL()}
    );
    CREATE INDEX IF NOT EXISTS idx_job_files_task ON job_files(task_id);

    CREATE TABLE IF NOT EXISTS library_files (
      id SERIAL PRIMARY KEY,
      name TEXT NOT NULL,
      url TEXT NOT NULL,
      category TEXT DEFAULT 'guide',
      created_at TEXT DEFAULT ${nowTextSQL()}
    );

    CREATE TABLE IF NOT EXISTS weekly_notes (
      id SERIAL PRIMARY KEY,
      user_id INTEGER NOT NULL,
      week_key TEXT NOT NULL,
      note TEXT,
      updated_at TEXT DEFAULT ${nowTextSQL()},
      UNIQUE(user_id, week_key)
    );

    ALTER TABLE planning_bookings ADD COLUMN IF NOT EXISTS completed_at TEXT;
    ALTER TABLE planning_bookings ADD COLUMN IF NOT EXISTS invoiced INTEGER DEFAULT 0;
    ALTER TABLE jt_tasks ADD COLUMN IF NOT EXISTS job_number TEXT;
    ALTER TABLE jt_tasks ADD COLUMN IF NOT EXISTS job_lat DOUBLE PRECISION;
    ALTER TABLE jt_tasks ADD COLUMN IF NOT EXISTS job_lng DOUBLE PRECISION;

    CREATE TABLE IF NOT EXISTS notes_widget (
      user_id INTEGER PRIMARY KEY,
      content TEXT,
      pos_x INTEGER DEFAULT 80,
      pos_y INTEGER DEFAULT 80,
      width INTEGER DEFAULT 320,
      height INTEGER DEFAULT 320,
      updated_at TEXT DEFAULT ${nowTextSQL()}
    );

    CREATE TABLE IF NOT EXISTS time_off (
      id SERIAL PRIMARY KEY,
      user_id INTEGER NOT NULL,
      start_date TEXT NOT NULL,
      end_date TEXT NOT NULL,
      type TEXT DEFAULT 'vacation',
      status TEXT DEFAULT 'pending',
      note TEXT,
      requested_by TEXT DEFAULT 'admin',
      admin_note TEXT,
      created_at TEXT DEFAULT ${nowTextSQL()},
      resolved_at TEXT
    );
    CREATE INDEX IF NOT EXISTS idx_time_off_user ON time_off(user_id, start_date, end_date);
    CREATE INDEX IF NOT EXISTS idx_time_off_status ON time_off(status);

    CREATE TABLE IF NOT EXISTS task_requests (
      id SERIAL PRIMARY KEY,
      user_id INTEGER NOT NULL,
      job_name TEXT NOT NULL,
      description TEXT,
      requested_date TEXT NOT NULL,
      estimated_days DOUBLE PRECISION DEFAULT 1,
      status TEXT DEFAULT 'pending',
      admin_note TEXT,
      resulting_booking_id INTEGER,
      created_at TEXT DEFAULT ${nowTextSQL()},
      resolved_at TEXT
    );
    CREATE INDEX IF NOT EXISTS idx_task_requests_status ON task_requests(status);
    CREATE INDEX IF NOT EXISTS idx_task_requests_user ON task_requests(user_id);
  `);

  await pool.query(`
    INSERT INTO app_settings (key, value) VALUES ('company_name', 'Gulv Master Enterprise ApS')
    ON CONFLICT (key) DO NOTHING;
  `);
}

function secureEqual(left, right) {
  if (typeof left !== 'string' || typeof right !== 'string') return false;
  const a = Buffer.from(left);
  const b = Buffer.from(right);
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

function requireMigrationSecret(req, res, next) {
  if (!MIGRATION_SECRET) return res.status(503).json({ error: 'MIGRATION_SECRET mangler i Render Environment.' });
  const secret = String(req.get('x-migration-secret') || '');
  if (!secureEqual(secret, MIGRATION_SECRET)) return res.status(401).json({ error: 'Forkert migrationskode.' });
  next();
}

function getWeekKey(dateStr) {
  const d = new Date(`${dateStr}T12:00:00`);
  if (Number.isNaN(d.getTime())) return '';
  const day = d.getDay() || 7;
  d.setDate(d.getDate() + 4 - day);
  const yearStart = new Date(Date.UTC(d.getFullYear(), 0, 1));
  const weekNo = Math.ceil((((d - yearStart) / 86400000) + 1) / 7);
  const mon = new Date(`${dateStr}T12:00:00`);
  const md = mon.getDay();
  mon.setDate(mon.getDate() - (md || 7) + 1);
  return `w${mon.getFullYear()}-${String(weekNo).padStart(2, '0')}`;
}

function validDate(value) {
  return typeof value === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(value);
}

// Capacity is planned by week, never by a meeting time or a particular day.
// We still save the Monday/Friday internally so existing reporting remains compatible.
function mondayOfDate(value) {
  const d = new Date(`${value}T12:00:00`);
  if (Number.isNaN(d.getTime())) return '';
  const day = d.getDay() || 7;
  d.setDate(d.getDate() - day + 1);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

function addWorkingDays(startDate, durationDays) {
  const d = new Date(`${startDate}T12:00:00`);
  if (Number.isNaN(d.getTime())) return startDate;
  const days = Math.max(1, Math.ceil(Number(durationDays) || 1));
  let count = 1;
  while (count < days) {
    d.setDate(d.getDate() + 1);
    if (d.getDay() !== 0 && d.getDay() !== 6) count += 1;
  }
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

function cleanTaskType(type) {
  return ['lay', 'sand', 'paint', 'sub', 'other'].includes(type) ? type : 'other';
}

function guessType(name) {
  const t = String(name || '').toLowerCase();
  if (t.includes('slib') || t.includes('behandling')) return 'sand';
  if (t.includes('mal') || t.includes('lak') || t.includes('maling')) return 'paint';
  if (t.includes('vvs') || t.includes('varme')) return 'sub';
  if (t.includes('gulv') || t.includes('parket') || t.includes('afmontering') || t.includes('spaan') || t.includes('stroer') || t.includes('laeg')) return 'lay';
  return 'other';
}

function generatedPlanningEmail(name) {
  const slug = String(name || 'vendor').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 35) || 'vendor';
  return `${slug}-${Date.now()}-${Math.random().toString(36).slice(2, 7)}@planning.local`;
}

function auth(req, res, next) {
  const header = req.headers.authorization;
  if (!header) return res.status(401).json({ error: 'No token' });
  try {
    req.user = jwt.verify(header.replace(/^Bearer\s+/i, ''), JWT_SECRET);
    next();
  } catch (error) {
    res.status(401).json({ error: 'Invalid token' });
  }
}

function adminOnly(req, res, next) {
  if (req.user.role !== 'admin') return res.status(403).json({ error: 'Admin only' });
  next();
}

async function pgOne(sql, values = []) {
  const result = await pool.query(sql, values);
  return result.rows[0] || null;
}

// ── ONE-TIME SQLITE → POSTGRES IMPORT ───────────────────────
const IMPORT_TABLES = {
  users: ['id', 'name', 'email', 'password_hash', 'role', 'color', 'initials', 'jobtread_name', 'active', 'created_at', 'worker_type', 'vendor_group', 'trade', 'weekly_capacity', 'can_login'],
  jt_tasks: ['id', 'name', 'job_id', 'job_name', 'job_address', 'start_date', 'end_date', 'type_guess', 'raw_assignee_name', 'jt_url', 'synced_at', 'source', 'created_at', 'customer_phone'],
  assignments: ['id', 'task_id', 'user_id', 'week_key', 'days', 'notes', 'start_time', 'start_date', 'end_date', 'created_at', 'updated_at'],
  planning_bookings: ['id', 'task_id', 'user_id', 'week_key', 'days', 'notes', 'start_time', 'start_date', 'end_date', 'created_at', 'updated_at'],
  time_logs: ['id', 'user_id', 'task_id', 'started_at', 'stopped_at', 'duration_minutes', 'notes', 'created_at'],
  sync_log: ['id', 'synced_at', 'tasks_imported', 'status', 'message']
};

function qIdent(name) {
  return `"${String(name).replace(/"/g, '""')}"`;
}

function sqliteTableNames(sqlite) {
  return new Set(sqlite.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'").all().map(row => row.name));
}

function sqliteColumns(sqlite, table) {
  return new Set(sqlite.prepare(`PRAGMA table_info(${qIdent(table)})`).all().map(row => row.name));
}

async function importSqliteBuffer(buffer) {
  const tempPath = path.join(os.tmpdir(), `gulvmaster-import-${Date.now()}-${crypto.randomBytes(6).toString('hex')}.db`);
  fs.writeFileSync(tempPath, buffer, { mode: 0o600 });
  let sqlite;
  let client;

  try {
    sqlite = new SqliteDatabase(tempPath, { readOnly: true, enableForeignKeyConstraints: false });
    const integrity = sqlite.prepare('PRAGMA integrity_check').get();
    if (!integrity || integrity.integrity_check !== 'ok') throw new Error('SQLite-filen er ikke sund: integrity_check fejlede.');

    const tables = sqliteTableNames(sqlite);
    if (!tables.has('users') || !tables.has('jt_tasks')) {
      throw new Error('Denne database ligner ikke en Gulv Master portal-database (users eller jt_tasks mangler).');
    }

    client = await pool.connect();
    await client.query('BEGIN');

    const done = await client.query("SELECT 1 FROM app_migrations WHERE name='sqlite_initial_import_20260702'");
    if (done.rowCount) throw new Error('Importen er allerede gennemført. Der er ikke ændret noget.');

    const existing = await client.query(`
      SELECT
        (SELECT COUNT(*)::int FROM users) AS users,
        (SELECT COUNT(*)::int FROM jt_tasks) AS tasks,
        (SELECT COUNT(*)::int FROM planning_bookings) AS bookings,
        (SELECT COUNT(*)::int FROM assignments) AS assignments
    `);
    const counts = existing.rows[0];
    if (Number(counts.users) || Number(counts.tasks) || Number(counts.bookings) || Number(counts.assignments)) {
      throw new Error('Postgres indeholder allerede data. Importen blev stoppet for at undgå dubletter.');
    }

    const summary = {};
    for (const [table, allowedColumns] of Object.entries(IMPORT_TABLES)) {
      if (!tables.has(table)) {
        summary[table] = 0;
        continue;
      }
      const sourceColumns = sqliteColumns(sqlite, table);
      const columns = allowedColumns.filter(column => sourceColumns.has(column));
      const rows = sqlite.prepare(`SELECT ${columns.map(qIdent).join(', ')} FROM ${qIdent(table)}`).all();
      summary[table] = rows.length;
      if (!rows.length) continue;

      const placeholders = columns.map((_, index) => `$${index + 1}`).join(', ');
      const updateColumns = columns.filter(column => column !== 'id');
      const conflict = table === 'jt_tasks'
        ? `ON CONFLICT (id) DO UPDATE SET ${updateColumns.map(column => `${qIdent(column)}=EXCLUDED.${qIdent(column)}`).join(', ')}`
        : `ON CONFLICT (id) DO UPDATE SET ${updateColumns.map(column => `${qIdent(column)}=EXCLUDED.${qIdent(column)}`).join(', ')}`;
      const statement = `INSERT INTO ${qIdent(table)} (${columns.map(qIdent).join(', ')}) VALUES (${placeholders}) ${conflict}`;

      for (const row of rows) {
        await client.query(statement, columns.map(column => row[column] === undefined ? null : row[column]));
      }
    }

    // Older portal versions used the legacy `assignments` table. Convert those
    // rows into independent planning_bookings as an extra safety net. Existing
    // planning_bookings are left untouched and we only add a row when the same
    // legacy assignment has not already been represented.
    const converted = await client.query(`
      INSERT INTO planning_bookings (task_id,user_id,week_key,days,notes,start_time,start_date,end_date,created_at,updated_at)
      SELECT
        a.task_id,
        a.user_id,
        COALESCE(NULLIF(a.week_key,''), 'legacy'),
        COALESCE(a.days,1),
        a.notes,
        a.start_time,
        COALESCE(NULLIF(a.start_date,''), t.start_date),
        COALESCE(NULLIF(a.end_date,''), NULLIF(a.start_date,''), t.end_date, t.start_date),
        COALESCE(a.created_at, ${nowTextSQL()}),
        COALESCE(a.updated_at, a.created_at, ${nowTextSQL()})
      FROM assignments a
      JOIN jt_tasks t ON t.id=a.task_id
      WHERE COALESCE(NULLIF(a.start_date,''), t.start_date) IS NOT NULL
        AND NOT EXISTS (
          SELECT 1 FROM planning_bookings b
          WHERE b.task_id=a.task_id
            AND b.user_id=a.user_id
            AND b.start_date=COALESCE(NULLIF(a.start_date,''), t.start_date)
            AND COALESCE(b.start_time,'')=COALESCE(a.start_time,'')
        )
    `);
    summary.legacy_assignments_converted = converted.rowCount || 0;

    for (const table of ['users', 'assignments', 'planning_bookings', 'time_logs', 'sync_log']) {
      await client.query(`
        SELECT setval(
          pg_get_serial_sequence('${table}', 'id'),
          GREATEST(COALESCE((SELECT MAX(id) FROM ${table}), 1), 1),
          true
        )
      `);
    }

    await client.query(
      "INSERT INTO app_migrations (name, details) VALUES ('sqlite_initial_import_20260702', $1)",
      [JSON.stringify(summary)]
    );
    await client.query('COMMIT');
    return summary;
  } catch (error) {
    if (client) {
      try { await client.query('ROLLBACK'); } catch (_) {}
    }
    throw error;
  } finally {
    if (client) client.release();
    if (sqlite) sqlite.close();
    try { fs.unlinkSync(tempPath); } catch (_) {}
  }
}

app.get('/api/migration/status', asyncRoute(async (req, res) => {
  const done = await pgOne("SELECT completed_at, details FROM app_migrations WHERE name='sqlite_initial_import_20260702'");
  const counts = await pgOne('SELECT (SELECT COUNT(*)::int FROM users) AS users, (SELECT COUNT(*)::int FROM jt_tasks) AS tasks, (SELECT COUNT(*)::int FROM planning_bookings) AS bookings');
  res.json({ migrationConfigured: Boolean(MIGRATION_SECRET), imported: Boolean(done), counts, completedAt: done ? done.completed_at : null });
}));

app.post('/api/migration/import-sqlite', requireMigrationSecret, upload.single('database'), asyncRoute(async (req, res) => {
  if (!req.file || !req.file.buffer) return res.status(400).json({ error: 'Vælg din gulvmaster.db-fil først.' });
  const summary = await importSqliteBuffer(req.file.buffer);
  res.json({ ok: true, summary });
}));

// ── AUTH ────────────────────────────────────────────────────
app.post('/api/auth/login', asyncRoute(async (req, res) => {
  const email = String((req.body || {}).email || '').trim().toLowerCase();
  const password = String((req.body || {}).password || '');
  const user = await pgOne('SELECT * FROM users WHERE email=$1 AND active=1 AND COALESCE(can_login,1)=1', [email]);
  if (!user || !bcrypt.compareSync(password, user.password_hash)) {
    return res.status(401).json({ error: 'Forkert email eller adgangskode' });
  }
  const token = jwt.sign({ id: user.id, name: user.name, role: user.role, email: user.email }, JWT_SECRET, { expiresIn: '30d' });
  res.json({ token, user: { id: user.id, name: user.name, role: user.role, email: user.email, color: user.color, initials: user.initials, avatar_url: user.avatar_url } });
}));

app.get('/api/auth/me', auth, asyncRoute(async (req, res) => {
  const user = await pgOne('SELECT id,name,email,role,color,initials,avatar_url FROM users WHERE id=$1', [req.user.id]);
  if (!user) return res.status(401).json({ error: 'Bruger ikke fundet' });
  res.json(user);
}));

// ── VIRKSOMHEDSPROFIL (navn + logo til login-side og nav) ────
app.get('/api/settings', asyncRoute(async (req, res) => {
  const result = await pool.query('SELECT key,value FROM app_settings');
  const map = {};
  result.rows.forEach(row => { map[row.key] = row.value; });
  res.json({
    company_name: map.company_name || 'Gulv Master Enterprise ApS',
    logo_url: map.logo_url || null
  });
}));

app.put('/api/settings', auth, adminOnly, asyncRoute(async (req, res) => {
  const body = req.body || {};
  const entries = [];
  if (body.company_name !== undefined) entries.push(['company_name', String(body.company_name).trim().slice(0, 200)]);
  if (body.logo_url !== undefined) entries.push(['logo_url', body.logo_url ? String(body.logo_url).slice(0, 3000000) : null]);
  for (const [key, value] of entries) {
    await pool.query(`
      INSERT INTO app_settings (key, value) VALUES ($1,$2)
      ON CONFLICT (key) DO UPDATE SET value=EXCLUDED.value
    `, [key, value]);
  }
  res.json({ ok: true });
}));

// ── USERS / WORKFORCE ───────────────────────────────────────
app.get('/api/users', auth, adminOnly, asyncRoute(async (req, res) => {
  const result = await pool.query(`
    SELECT id,name,email,role,color,initials,jobtread_name,active,worker_type,vendor_group,trade,weekly_capacity,avatar_url,COALESCE(can_login,1) AS can_login
    FROM users
    ORDER BY CASE WHEN role='admin' THEN 0 ELSE 1 END,
             CASE WHEN worker_type='vendor' THEN 1 ELSE 0 END,
             vendor_group NULLS FIRST,
             name
  `);
  res.json(result.rows);
}));

app.post('/api/users', auth, adminOnly, asyncRoute(async (req, res) => {
  const body = req.body || {};
  const canLogin = body.can_login !== false;
  if (!body.name) return res.status(400).json({ error: 'Navn mangler' });
  if (canLogin && (!body.email || !body.password)) return res.status(400).json({ error: 'Email og adgangskode mangler for en bruger med login' });

  const initials = body.initials || String(body.name).split(' ').filter(Boolean).map(part => part[0]).join('').slice(0, 3).toUpperCase();
  const email = canLogin ? String(body.email).trim().toLowerCase() : generatedPlanningEmail(body.name);
  const password = canLogin ? String(body.password) : crypto.randomBytes(24).toString('hex');
  const workerType = body.worker_type === 'vendor' ? 'vendor' : 'employee';
  const role = canLogin ? (body.role || 'employee') : 'employee';
  const weeklyCapacity = Math.max(0, Number(body.weekly_capacity) || 5);

  try {
    const result = await pool.query(`
      INSERT INTO users (name,email,password_hash,role,color,initials,jobtread_name,active,worker_type,vendor_group,trade,weekly_capacity,can_login,avatar_url)
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14)
      RETURNING id
    `, [String(body.name).trim(), email, bcrypt.hashSync(password, 10), role, body.color || '#2563EB', initials, body.jobtread_name || null, body.active === 0 ? 0 : 1, workerType, body.vendor_group || null, body.trade || null, weeklyCapacity, canLogin ? 1 : 0, body.avatar_url || null]);
    res.json({ ok: true, id: result.rows[0].id });
  } catch (error) {
    if (error.code === '23505') return res.status(400).json({ error: 'Email er allerede i brug' });
    throw error;
  }
}));

app.put('/api/users/:id', auth, adminOnly, asyncRoute(async (req, res) => {
  const id = Number(req.params.id);
  const current = await pgOne('SELECT * FROM users WHERE id=$1', [id]);
  if (!current) return res.status(404).json({ error: 'Bruger blev ikke fundet' });
  const body = req.body || {};
  const canLogin = body.can_login !== undefined ? (body.can_login ? 1 : 0) : Number(current.can_login || 1);
  const next = {
    name: body.name !== undefined ? String(body.name).trim() : current.name,
    email: canLogin && body.email !== undefined ? String(body.email).trim().toLowerCase() : current.email,
    password_hash: body.password ? bcrypt.hashSync(String(body.password), 10) : current.password_hash,
    role: canLogin ? (body.role || current.role) : 'employee',
    color: body.color || current.color,
    initials: body.initials !== undefined ? body.initials : current.initials,
    jobtread_name: body.jobtread_name !== undefined ? body.jobtread_name : current.jobtread_name,
    active: body.active !== undefined ? (body.active ? 1 : 0) : current.active,
    worker_type: body.worker_type === 'vendor' ? 'vendor' : (body.worker_type ? 'employee' : (current.worker_type || 'employee')),
    vendor_group: body.vendor_group !== undefined ? body.vendor_group : current.vendor_group,
    trade: body.trade !== undefined ? body.trade : current.trade,
    weekly_capacity: body.weekly_capacity !== undefined ? Math.max(0, Number(body.weekly_capacity) || 0) : (Number(current.weekly_capacity) || 5),
    can_login: canLogin,
    avatar_url: body.avatar_url !== undefined ? (body.avatar_url || null) : current.avatar_url
  };
  if (canLogin && !next.email) return res.status(400).json({ error: 'Email mangler for login-bruger' });
  try {
    await pool.query(`
      UPDATE users SET name=$1,email=$2,password_hash=$3,role=$4,color=$5,initials=$6,jobtread_name=$7,active=$8,worker_type=$9,vendor_group=$10,trade=$11,weekly_capacity=$12,can_login=$13,avatar_url=$14
      WHERE id=$15
    `, [next.name, next.email, next.password_hash, next.role, next.color, next.initials, next.jobtread_name, next.active, next.worker_type, next.vendor_group, next.trade, next.weekly_capacity, next.can_login, next.avatar_url, id]);
    res.json({ ok: true });
  } catch (error) {
    if (error.code === '23505') return res.status(400).json({ error: 'Email er allerede i brug' });
    throw error;
  }
}));

// ── JOBTREAD LIVE SYNC ──────────────────────────────────────
function redactSecret(value) {
  const text = String(value || '');
  return JT_GRANT ? text.split(JT_GRANT).join('[REDACTED]') : text;
}

async function jtFetch(body, label = 'JobTread-kald', attempt = 1) {
  const MAX_ATTEMPTS = 3;
  let response, raw;
  try {
    response = await fetch(JT_API, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body)
    });
    raw = await response.text();
  } catch (networkError) {
    // Netværksfejl (timeout, DNS, afbrudt forbindelse) — prøv igen et par gange,
    // så en enkelt forbigående udsving ikke vælter en hel synkronisering.
    if (attempt < MAX_ATTEMPTS) {
      await new Promise(r => setTimeout(r, attempt * 800));
      return jtFetch(body, label, attempt + 1);
    }
    throw new Error(`${label}: netværksfejl efter ${MAX_ATTEMPTS} forsøg — ${networkError.message}`);
  }

  let data = null;
  try { data = raw ? JSON.parse(raw) : null; } catch (_) {}

  if (!response.ok) {
    // 429 (rate limit) og 5xx er ofte forbigående — prøv igen med lidt ventetid.
    if ((response.status === 429 || response.status >= 500) && attempt < MAX_ATTEMPTS) {
      await new Promise(r => setTimeout(r, attempt * 1000));
      return jtFetch(body, label, attempt + 1);
    }
    const detail = redactSecret(
      data?.error?.message || data?.error || data?.message || raw || 'Ingen fejltekst fra JobTread.'
    ).replace(/\s+/g, ' ').trim().slice(0, 900);
    throw new Error(`${label}: HTTP ${response.status}${detail ? ` — ${detail}` : ''}`);
  }
  if (data?.error) {
    throw new Error(`${label}: ${redactSecret(JSON.stringify(data.error)).slice(0, 900)}`);
  }
  return data || {};
}

async function writeSyncLog(tasksImported, status, message) {
  await pool.query(`INSERT INTO sync_log (tasks_imported,status,message,synced_at) VALUES ($1,$2,$3,${nowTextSQL()})`, [tasksImported, status, message]);
}

function taskConnection(cursor, fields) {
  const where = { and: [['targetType', 'job'], ['isGroup', false]] };
  if (!JT_INCLUDE_TODOS) where.and.unshift(['isToDo', false]);

  // Important: JobTread does NOT accept page: "1" as the first request for
  // this tasks connection. The first request must omit `page` entirely.
  // On later calls, the opaque cursor returned in `nextPage` is passed back
  // unchanged as `page`.
  const args = { size: JT_PAGE_SIZE, where };
  if (cursor !== null && cursor !== undefined && cursor !== '') {
    args.page = cursor;
  }

  return {
    $: args,
    nextPage: {},
    nodes: fields
  };
}

function taskPagePayload(cursor) {
  // Split into two separate small queries to avoid HTTP 413.
  // Query 1: task dates + job info (no assignments)
  return {
    query: {
      $: { grantKey: JT_GRANT },
      organization: {
        $: { id: JT_ORG },
        tasks: taskConnection(cursor, {
          id: {},
          name: {},
          startDate: {},
          endDate: {},
          job: { id: {}, name: {}, location: { address: {} } }
        })
      }
    }
  };
}

function taskAssignPagePayload(cursor) {
  // Query 2: assignments only (no job info)
  return {
    query: {
      $: { grantKey: JT_GRANT },
      organization: {
        $: { id: JT_ORG },
        tasks: taskConnection(cursor, {
          id: {},
          taskAssignments: { nodes: { membership: { user: { name: {} } } } }
        })
      }
    }
  };
}

function taskConnectionFrom(data) {
  return (((data || {}).query || {}).organization || {}).tasks || {};
}

let mainSyncRunning = false;
async function syncFromJT() {
  if (mainSyncRunning) {
    return { ok: false, error: 'Der kører allerede en synkronisering — vent til den er færdig og prøv igen.' };
  }
  mainSyncRunning = true;
  try {
    return await syncFromJTInner();
  } finally {
    mainSyncRunning = false;
  }
}

async function syncFromJTInner() {
  if (!JT_GRANT) {
    await writeSyncLog(0, 'error', 'Grant Key ikke sat.');
    return { ok: false, error: 'Ingen Grant Key' };
  }
  if (!JT_ORG) {
    await writeSyncLog(0, 'error', 'Organisation ID ikke sat.');
    return { ok: false, error: 'Ingen Organisation ID' };
  }

  try {
    // ── PASS 1: tasks (id + navn + datoer + job.id) ──
    const allTasks = [];
    const seenTaskIds = new Set();
    let cur1 = undefined;
    let p1 = 0;

    while (p1 < JT_MAX_PAGES) {
      const args = { size: JT_PAGE_SIZE, where: { and: [['targetType', 'job'], ['isGroup', false]] } };
      if (cur1) args.page = cur1;

      const d = await jtFetch({ query: { $: { grantKey: JT_GRANT }, organization: { $: { id: JT_ORG },
        tasks: { $: args, nextPage: {}, nodes: { id: {}, name: {}, startDate: {}, endDate: {}, job: { id: {} } } }
      }}}, 'Tasks s.' + (p1+1));

      // jtFetch returnerer {organization:{tasks:{...}}} — ingen query wrapper
      const conn = d?.organization?.tasks || d?.query?.organization?.tasks || {};
      const nodes = Array.isArray(conn.nodes) ? conn.nodes : [];

      for (const t of nodes) {
        if (!t?.id || seenTaskIds.has(t.id)) continue;
        seenTaskIds.add(t.id);
        allTasks.push(t);
      }
      p1++;
      const next = conn.nextPage;
      if (!next || next === '') break;
      cur1 = next;
    }

    // ── PASS 2: jobs (navn + adresse) ──
    const jobMap = new Map();
    let cur2 = undefined;
    let p2 = 0;

    while (p2 < 20) {
      const args = { size: 50 };
      if (cur2) args.page = cur2;

      const d = await jtFetch({ query: { $: { grantKey: JT_GRANT }, organization: { $: { id: JT_ORG },
        jobs: { $: args, nextPage: {}, nodes: { id: {}, name: {}, number: {}, location: { address: {} } } }
      }}}, 'Jobs s.' + (p2+1));

      const conn = d?.organization?.jobs || d?.query?.organization?.jobs || {};
      const nodes = Array.isArray(conn.nodes) ? conn.nodes : [];
      for (const j of nodes) {
        if (j?.id) jobMap.set(j.id, { name: j.name || '', address: j.location?.address || '', number: j.number != null ? String(j.number) : '' });
      }
      p2++;
      const next = conn.nextPage;
      if (!next || next === '') break;
      cur2 = next;
    }

    // ── PASS 3: assignments ──
    const assigneeMap = new Map();
    let cur3 = undefined;
    let p3 = 0;

    while (p3 < JT_MAX_PAGES) {
      const args = { size: JT_PAGE_SIZE, where: { and: [['targetType', 'job'], ['isGroup', false]] } };
      if (cur3) args.page = cur3;

      const d = await jtFetch({ query: { $: { grantKey: JT_GRANT }, organization: { $: { id: JT_ORG },
        tasks: { $: args, nextPage: {}, nodes: { id: {}, taskAssignments: { nodes: { membership: { user: { name: {} } } } } } }
      }}}, 'Assign s.' + (p3+1));

      const conn = d?.organization?.tasks || d?.query?.organization?.tasks || {};
      const nodes = Array.isArray(conn.nodes) ? conn.nodes : [];
      for (const t of nodes) {
        if (!t?.id) continue;
        const name = t?.taskAssignments?.nodes?.[0]?.membership?.user?.name;
        if (name) assigneeMap.set(t.id, name);
      }
      p3++;
      const next = conn.nextPage;
      if (!next || next === '') break;
      cur3 = next;
    }

    // ── UPSERT: kun jt_tasks — rører ALDRIG planning_bookings ──
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      for (const task of allTasks) {
        const jobId = task.job?.id || null;
        const ji = jobId ? (jobMap.get(jobId) || {}) : {};
        const customerName = String(ji.name || '')
          .replace(/\s*[-\u2013]\s*(gulvl.gning|gulvslib|maler.*|slibning|service|renovering|t.mrer).*/i, '')
          .trim();

        await client.query(`
          INSERT INTO jt_tasks (id,name,job_id,job_name,job_address,job_number,start_date,end_date,type_guess,raw_assignee_name,jt_url,synced_at,source)
          VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,${nowTextSQL()},'jobtread')
          ON CONFLICT (id) DO UPDATE SET
            name=EXCLUDED.name, job_id=EXCLUDED.job_id, job_name=EXCLUDED.job_name,
            job_address=EXCLUDED.job_address,
            job_number=COALESCE(EXCLUDED.job_number, jt_tasks.job_number),
            start_date=EXCLUDED.start_date,
            end_date=EXCLUDED.end_date, type_guess=EXCLUDED.type_guess,
            raw_assignee_name=EXCLUDED.raw_assignee_name, jt_url=EXCLUDED.jt_url,
            synced_at=EXCLUDED.synced_at, source='jobtread'
        `, [
          task.id, task.name || '', jobId,
          customerName || ji.name || '', ji.address || '', ji.number || null,
          task.startDate || null, task.endDate || task.startDate || null,
          guessType(task.name), assigneeMap.get(task.id) || null,
          jobId ? `https://app.jobtread.com/jobs/${jobId}/schedule` : null
        ]);
      }
      await client.query('COMMIT');
    } catch (err) {
      try { await client.query('ROLLBACK'); } catch (_) {}
      throw err;
    } finally {
      client.release();
    }

    const msg = `${allTasks.length} tasks · ${p1} task-sider · ${p2} job-sider · ${p3} assignment-sider · kundetlf. hentes i baggrunden…`;
    await writeSyncLog(allTasks.length, 'ok', msg);

    // Kundetelefon hentes IKKE her — det er en langsom, uafhængig proces (mange
    // ekstra JobTread-opslag pr. job), der ikke må kunne bremse eller vælte selve
    // synkroniseringen. Den køres i baggrunden efter vi allerede har svaret.
    syncCustomerPhonesFromJT().catch(e => console.error('Baggrunds-telefonopslag fejlede:', e.message));
    syncJobGeocodesInBackground().catch(e => console.error('Baggrunds-geokodning fejlede:', e.message));

    return { ok: true, count: allTasks.length, pages: p1 };

  } catch (error) {
    const safeMsg = redactSecret(error?.message || 'Ukendt fejl').slice(0, 1000);
    await writeSyncLog(0, 'error', safeMsg);
    return { ok: false, error: safeMsg };
  }
}

// ── KUNDEKONTAKT FRA JOBTREAD ───────────────────────────────
// JobTread gemmer kundens telefon i customer-contact custom fields. Den tidligere
// kode krævede feltet hed præcis "Phone" og bad om op til 50 tunge job-kontakter
// pr. request. Det gav enten 0 fund eller HTTP 413 på større organisationer.
// Denne version læser i små sider, matcher almindelige telefonfeltnavne fleksibelt
// og beskytter et nummer, som kontoret selv har skrevet ind i portalen.
const JT_CONTACT_JOB_PAGE_SIZE = Math.max(1, Math.min(10, Number.parseInt(process.env.JT_CONTACT_JOB_PAGE_SIZE || '5', 10) || 5));
const JT_CONTACT_FIELD_PAGE_SIZE = Math.max(1, Math.min(20, Number.parseInt(process.env.JT_CONTACT_FIELD_PAGE_SIZE || '10', 10) || 10));
const JT_CONTACTS_PER_ACCOUNT = Math.max(1, Math.min(20, Number.parseInt(process.env.JT_CONTACTS_PER_ACCOUNT || '10', 10) || 10));

let phoneSyncRunning = false;
let geocodeSyncRunning = false;

function listNodes(value) {
  if (Array.isArray(value)) return value;
  if (Array.isArray(value?.nodes)) return value.nodes;
  return [];
}

function phoneFieldLabel(fieldValue) {
  return String(
    fieldValue?.customField?.name ||
    fieldValue?.customField?.label ||
    fieldValue?.field?.name ||
    fieldValue?.name ||
    ''
  ).trim();
}

function isPhoneFieldLabel(label) {
  const normalized = String(label || '').toLowerCase().replace(/[._-]+/g, ' ').replace(/\s+/g, ' ').trim();
  return /(?:^|\s)(phone|telephone|mobile|mobil|telefon|tlf)(?:\s|$)/.test(normalized) ||
    /phone\s*(number|no)?|mobile\s*(number|no)?|telefon\s*(nummer|nr)?|tlf\.?\s*(nummer|nr)?/.test(normalized);
}

function possiblePhone(value) {
  const text = String(value == null ? '' : value).trim();
  if (!text) return '';
  // Keep a normal international/Danish dial string. We only accept values that
  // actually look like a phone number, so a random custom-field value cannot be
  // copied into the employee view.
  const cleaned = text.replace(/(?:ext\.?|x)\s*\d+$/i, '').replace(/[\s().-]/g, '');
  if (!/^\+?\d{6,18}$/.test(cleaned)) return '';
  return cleaned;
}

function phonesFromValue(value, output = [], seen = new Set()) {
  if (value == null || seen.has(value)) return output;
  if (typeof value === 'string' || typeof value === 'number') {
    const text = String(value).trim();
    const direct = possiblePhone(text);
    if (direct) output.push(direct);
    // Some JobTread custom values are serialised JSON. Parse that form as well.
    if (typeof value === 'string' && /^[{[]/.test(text)) {
      try { phonesFromValue(JSON.parse(text), output, seen); } catch (_) {}
    }
    return output;
  }
  if (typeof value !== 'object') return output;
  seen.add(value);
  if (Array.isArray(value)) {
    value.forEach(item => phonesFromValue(item, output, seen));
    return output;
  }
  // Prefer explicit phone-like properties before walking any nested values.
  ['phone', 'phoneNumber', 'mobile', 'mobilePhone', 'telephone', 'value', 'formattedValue', 'rawValue'].forEach(key => {
    if (Object.prototype.hasOwnProperty.call(value, key)) phonesFromValue(value[key], output, seen);
  });
  return output;
}

function firstPhoneFromFields(fieldValues, stats) {
  for (const fieldValue of listNodes(fieldValues)) {
    stats.fields_scanned++;
    const label = phoneFieldLabel(fieldValue);
    if (!isPhoneFieldLabel(label)) continue;
    stats.phone_fields_matched++;
    const candidate = phonesFromValue(fieldValue?.value)[0] || '';
    if (candidate) return { phone: candidate, label };
  }
  return null;
}

function phoneFromJobContact(job, stats) {
  const containers = [];
  const location = job?.location || {};
  if (location?.contact) containers.push(location.contact);
  const account = location?.account || {};
  if (account?.primaryContact) containers.push(account.primaryContact);
  listNodes(account?.contacts).forEach(contact => containers.push(contact));

  for (const contact of containers) {
    stats.contacts_scanned++;
    const match = firstPhoneFromFields(contact?.customFieldValues, stats);
    if (match) return match;
  }
  return null;
}

function jobContactFields() {
  const customFieldValues = {
    $: { size: JT_CONTACT_FIELD_PAGE_SIZE },
    nodes: { value: {}, customField: { name: {} } }
  };
  return {
    id: {},
    location: {
      address: {},
      contact: { customFieldValues },
      account: {
        primaryContact: { customFieldValues },
        contacts: { $: { size: JT_CONTACTS_PER_ACCOUNT }, nodes: { customFieldValues } }
      }
    }
  };
}

async function syncCustomerPhonesFromJT() {
  if (phoneSyncRunning) return { ok: false, error: 'Der kører allerede et telefonopslag' };
  if (!JT_GRANT || !JT_ORG) return { ok: false, error: 'JobTread Grant Key eller Organisation ID mangler' };

  phoneSyncRunning = true;
  const phoneByJob = new Map();
  const stats = { jobs_scanned: 0, contacts_scanned: 0, fields_scanned: 0, phone_fields_matched: 0, pages: 0 };

  try {
    let cursor;
    while (stats.pages < JT_MAX_PAGES) {
      const args = { size: JT_CONTACT_JOB_PAGE_SIZE };
      if (cursor) args.page = cursor;

      const data = await jtFetch({
        query: {
          $: { grantKey: JT_GRANT },
          organization: {
            $: { id: JT_ORG },
            jobs: { $: args, nextPage: {}, nodes: jobContactFields() }
          }
        }
      }, `Kundetelefon s.${stats.pages + 1}`);

      const connection = data?.organization?.jobs || data?.query?.organization?.jobs || {};
      const jobs = listNodes(connection);
      for (const job of jobs) {
        if (!job?.id) continue;
        stats.jobs_scanned++;
        const match = phoneFromJobContact(job, stats);
        if (match?.phone) phoneByJob.set(String(job.id), match);
      }

      stats.pages++;
      const next = connection.nextPage;
      if (!next || next === '') break;
      cursor = next;
    }

    let updated = 0;
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      for (const [jobId, contact] of phoneByJob.entries()) {
        // A manually entered contact is never overwritten. A previously synced
        // value is refreshed, so a phone correction made in JobTread reaches
        // every portal task linked to the same JobTread job.
        const result = await client.query(`
          UPDATE jt_tasks
          SET customer_phone=$1,
              customer_phone_source='jobtread',
              customer_phone_synced_at=${nowTextSQL()}
          WHERE job_id=$2
            AND source='jobtread'
            AND COALESCE(customer_phone_source,'') <> 'manual'
            AND (
              customer_phone IS NULL OR customer_phone='' OR
              customer_phone_source='jobtread' OR customer_phone <> $1
            )
        `, [contact.phone, jobId]);
        updated += result.rowCount;
      }
      await client.query('COMMIT');
    } catch (error) {
      try { await client.query('ROLLBACK'); } catch (_) {}
      throw error;
    } finally {
      client.release();
    }

    const result = {
      ok: true,
      found: phoneByJob.size,
      updated,
      jobs_scanned: stats.jobs_scanned,
      contacts_scanned: stats.contacts_scanned,
      phone_fields_matched: stats.phone_fields_matched,
      pages: stats.pages
    };
    await writeSyncLog(0, 'ok', `Kundetelefon: ${result.found} jobs med nummer, ${updated} task(s) opdateret. ${stats.jobs_scanned} jobs / ${stats.contacts_scanned} kontakter / ${stats.phone_fields_matched} telefonfelter gennemgået.`);
    return result;
  } catch (phoneError) {
    const safeError = redactSecret(phoneError?.message || 'Ukendt fejl').slice(0, 600);
    await writeSyncLog(0, 'error', `Kundetlf.-opslag fejlede: ${safeError}`);
    console.error('Kundetelefon-opslag fra JobTread fejlede:', safeError);
    return { ok: false, error: safeError };
  } finally {
    phoneSyncRunning = false;
  }
}

// Weather is intentionally separate from phone sync. Nominatim has a one-request-
// per-second limit; making it part of /api/sync-phones could make the browser time
// out before the phone numbers had been saved.
async function syncJobGeocodesInBackground() {
  if (geocodeSyncRunning) return { ok: false, skipped: true, error: 'Geokodning kører allerede' };
  geocodeSyncRunning = true;
  let geocoded = 0;
  try {
    const needsGeocode = await pool.query(`
      SELECT DISTINCT job_id, job_address
      FROM jt_tasks
      WHERE job_id IS NOT NULL
        AND job_address IS NOT NULL
        AND job_address<>''
        AND (job_lat IS NULL OR job_lng IS NULL)
    `);

    for (const row of needsGeocode.rows.slice(0, 60)) {
      try {
        const geoRes = await fetch('https://nominatim.openstreetmap.org/search?format=json&limit=1&countrycodes=dk&q=' + encodeURIComponent(row.job_address), {
          headers: { 'User-Agent': 'GulvMasterEnterprise/1.0 (internal scheduling tool)' }
        });
        const geoData = await geoRes.json();
        if (Array.isArray(geoData) && geoData[0]) {
          await pool.query(`UPDATE jt_tasks SET job_lat=$1, job_lng=$2 WHERE job_id=$3`, [+geoData[0].lat, +geoData[0].lon, row.job_id]);
          geocoded++;
        }
      } catch (_) {
        // One bad address must never stop the contact sync.
      }
      await new Promise(resolve => setTimeout(resolve, 1100));
    }
    if (geocoded) await writeSyncLog(0, 'ok', `Vejr-geokodning: ${geocoded} adresse(r) opdateret.`);
    return { ok: true, geocoded };
  } catch (error) {
    console.error('Geokodning fejlede:', error.message);
    return { ok: false, error: error.message };
  } finally {
    geocodeSyncRunning = false;
  }
}

app.post('/api/sync-phones', auth, adminOnly, asyncRoute(async (req, res) => {
  const result = await syncCustomerPhonesFromJT();
  // Do not make the admin browser wait for weather. The phone rows have already
  // been saved before this background process begins.
  if (result.ok) {
    syncJobGeocodesInBackground().catch(error => console.error('Baggrunds-geokodning fejlede:', error.message));
  }
  res.status(result.ok ? 200 : 500).json({ ...result, weather_sync_started: Boolean(result.ok) });
}));

app.post('/api/sync', auth, adminOnly, asyncRoute(async (req, res) => {
  const result = await syncFromJT();
  res.status(result.ok ? 200 : 500).json(result);
}));

app.get('/api/sync/log', auth, adminOnly, asyncRoute(async (req, res) => {
  const result = await pool.query('SELECT * FROM sync_log ORDER BY id DESC LIMIT 20');
  res.json(result.rows);
}));

// ── TASK POOL + INDEPENDENT MANUAL PLAN ──────────────────────
app.get('/api/tasks', auth, asyncRoute(async (req, res) => {
  const result = await pool.query(`
    SELECT t.*, COUNT(b.id) FILTER (WHERE COALESCE(b.planning_mode,'daily') <> 'capacity')::int AS assignment_count
    FROM jt_tasks t
    LEFT JOIN planning_bookings b ON b.task_id=t.id
    WHERE COALESCE(t.source,'jobtread') <> 'capacity'
    GROUP BY t.id
    ORDER BY CASE WHEN t.source='manual' THEN 0 ELSE 1 END,
             CASE WHEN t.start_date IS NULL OR t.start_date='' THEN 1 ELSE 0 END,
             t.start_date ASC NULLS LAST,
             t.job_name ASC
  `);
  res.json(result.rows);
}));

app.post('/api/tasks/manual', auth, adminOnly, asyncRoute(async (req, res) => {
  const body = req.body || {};
  if (!body.job_name || !body.name || !validDate(body.start_date)) {
    return res.status(400).json({ error: 'Kunde/projekt, opgave og startdato skal udfyldes' });
  }
  const days = Math.max(0.25, Math.min(60, Number(body.days) || 1));
  const endDate = validDate(body.end_date) ? body.end_date : addWorkingDays(body.start_date, days);
  const id = `manual-${crypto.randomUUID ? crypto.randomUUID() : `${Date.now()}-${Math.random().toString(16).slice(2)}`}`;
  await pool.query(`
    INSERT INTO jt_tasks (id,name,job_id,job_name,job_address,job_number,customer_phone,start_date,end_date,type_guess,raw_assignee_name,jt_url,synced_at,source,created_at)
    VALUES ($1,$2,NULL,$3,$4,$5,$6,$7,$8,$9,NULL,NULL,${nowTextSQL()},'manual',${nowTextSQL()})
  `, [id, String(body.name).trim(), String(body.job_name).trim(), body.job_address || '', body.job_number || null, body.customer_phone || null, body.start_date, endDate, cleanTaskType(body.type_guess)]);
  res.json({ ok: true, id });
}));

// ── CAPACITY-ONLY RESERVATIONS ────────────────────────────────
// These blocks are intentionally separate from Daily plan / Employee schedule.
// They reserve a person's weekly availability without creating a meeting time,
// address, telephone number or JobTread case number.
app.post('/api/capacity-reservations', auth, adminOnly, asyncRoute(async (req, res) => {
  const body = req.body || {};
  const startDate = validDate(String(body.week_start || '')) ? String(body.week_start) : null;
  if (!startDate) return res.status(400).json({ error: 'Vælg en gyldig startdato' });
  const user = await pgOne("SELECT id FROM users WHERE id=$1 AND active=1 AND role='employee'", [Number(body.user_id)]);
  if (!user) return res.status(400).json({ error: 'Medarbejderen eller holdet blev ikke fundet' });
  const capacityDays = Math.max(0.25, Math.min(60, Number(body.capacity_days) || 1));
  const endDate = addWorkingDays(startDate, capacityDays);
  const note = body.notes ? String(body.notes).slice(0, 1000) : null;
  const requestedLabel = String(body.label || '').trim().slice(0, 120);
  const existingTaskId = body.task_id ? String(body.task_id) : null;
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    let taskId = existingTaskId;
    let taskLabel = requestedLabel;
    if (taskId) {
      const task = await client.query("SELECT id,job_name,name FROM jt_tasks WHERE id=$1 AND COALESCE(source,'jobtread') <> 'capacity'", [taskId]);
      if (!task.rowCount) throw new Error('Opgaven blev ikke fundet');
      taskLabel = taskLabel || [task.rows[0].job_name, task.rows[0].name].filter(Boolean).join(' — ') || 'Kapacitetsreservation';
    } else {
      taskId = `capacity-${crypto.randomUUID ? crypto.randomUUID() : `${Date.now()}-${Math.random().toString(16).slice(2)}`}`;
      taskLabel = taskLabel || 'Kapacitetsreservation';
      await client.query(`
        INSERT INTO jt_tasks (id,name,job_id,job_name,job_address,start_date,end_date,type_guess,raw_assignee_name,jt_url,synced_at,source,created_at)
        VALUES ($1,$2,NULL,'Kapacitetsreserve','',$3,$4,'other',NULL,NULL,${nowTextSQL()},'capacity',${nowTextSQL()})
      `, [taskId, taskLabel, startDate, endDate]);
    }
    const result = await client.query(`
      INSERT INTO planning_bookings (task_id,user_id,week_key,days,capacity_days,notes,start_time,start_date,end_date,planning_mode,capacity_label,updated_at)
      VALUES ($1,$2,$3,5,$4,$5,NULL,$6,$7,'capacity',$8,${nowTextSQL()})
      RETURNING id
    `, [taskId, user.id, getWeekKey(startDate), capacityDays, note, startDate, endDate, taskLabel]);
    await client.query('COMMIT');
    res.json({ ok: true, id: result.rows[0].id });
  } catch (error) {
    try { await client.query('ROLLBACK'); } catch (_) {}
    res.status(400).json({ error: error.message || 'Kapacitetsreservationen kunne ikke gemmes' });
  } finally {
    client.release();
  }
}));

app.put('/api/capacity-reservations/:id', auth, adminOnly, asyncRoute(async (req, res) => {
  const current = await pgOne("SELECT * FROM planning_bookings WHERE id=$1 AND COALESCE(planning_mode,'daily')='capacity'", [Number(req.params.id)]);
  if (!current) return res.status(404).json({ error: 'Kapacitetsreservationen blev ikke fundet' });
  const body = req.body || {};
  const startDate = validDate(String(body.week_start || current.start_date || '')) ? String(body.week_start || current.start_date) : null;
  if (!startDate) return res.status(400).json({ error: 'Vælg en gyldig startdato' });
  const user = await pgOne("SELECT id FROM users WHERE id=$1 AND active=1 AND role='employee'", [Number(body.user_id || current.user_id)]);
  if (!user) return res.status(400).json({ error: 'Medarbejderen eller holdet blev ikke fundet' });
  const capacityDays = Math.max(0.25, Math.min(60, Number(body.capacity_days) || current.capacity_days || 1));
  const endDate = addWorkingDays(startDate, capacityDays);
  const label = String(body.label !== undefined ? body.label : (current.capacity_label || '')).trim().slice(0, 120) || 'Kapacitetsreservation';
  const note = body.notes !== undefined ? (body.notes ? String(body.notes).slice(0,1000) : null) : current.notes;
  await pool.query(`
    UPDATE planning_bookings
    SET user_id=$1,week_key=$2,days=5,capacity_days=$3,notes=$4,start_time=NULL,start_date=$5,end_date=$6,capacity_label=$7,updated_at=${nowTextSQL()}
    WHERE id=$8
  `, [user.id, getWeekKey(startDate), capacityDays, note, startDate, endDate, label, current.id]);
  res.json({ ok: true });
}));

app.put('/api/tasks/:id/customer-contact', auth, adminOnly, asyncRoute(async (req, res) => {
  const task = await pgOne('SELECT id FROM jt_tasks WHERE id=$1', [req.params.id]);
  if (!task) return res.status(404).json({ error: 'Opgaven blev ikke fundet' });
  const phone = String((req.body || {}).customer_phone || '').trim().slice(0, 60);
  await pool.query(`
    UPDATE jt_tasks
    SET customer_phone=$1,
        customer_phone_source=CASE WHEN $1='' THEN NULL ELSE 'manual' END,
        customer_phone_synced_at=NULL
    WHERE id=$2
  `, [phone || '', req.params.id]);
  res.json({ ok: true, customer_phone: phone || null, customer_phone_source: phone ? 'manual' : null });
}));

app.delete('/api/tasks/manual/:id', auth, adminOnly, asyncRoute(async (req, res) => {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const task = await client.query("SELECT id FROM jt_tasks WHERE id=$1 AND source='manual'", [req.params.id]);
    if (!task.rowCount) {
      await client.query('ROLLBACK');
      return res.status(404).json({ error: 'Kun manuelle opgaver kan slettes her' });
    }
    await client.query('DELETE FROM planning_bookings WHERE task_id=$1', [req.params.id]);
    await client.query('DELETE FROM jt_tasks WHERE id=$1', [req.params.id]);
    await client.query('COMMIT');
    res.json({ ok: true });
  } catch (error) {
    try { await client.query('ROLLBACK'); } catch (_) {}
    throw error;
  } finally {
    client.release();
  }
}));

// Bulk edit (masseredigering i Opgaveliste) — sætter fx fag på flere opgaver ad gangen.
// VIGTIGT: denne route skal stå FØR '/api/tasks/:id', ellers vil Express matche
// "bulk" som et :id-parameter og masseredigering vil aldrig blive ramt.
app.put('/api/tasks/bulk', auth, adminOnly, asyncRoute(async (req, res) => {
  const body = req.body || {};
  const ids = Array.isArray(body.ids) ? body.ids.filter(Boolean) : [];
  const patch = body.patch || {};
  if (!ids.length) return res.status(400).json({ error: 'Ingen opgaver valgt' });
  const sets = [];
  const values = [];
  if (patch.type_guess !== undefined) { values.push(cleanTaskType(patch.type_guess)); sets.push(`type_guess=$${values.length}`); }
  if (patch.job_address !== undefined) { values.push(String(patch.job_address).trim()); sets.push(`job_address=$${values.length}`); }
  if (!sets.length) return res.status(400).json({ error: 'Intet at opdatere' });
  values.push(ids);
  await pool.query(`UPDATE jt_tasks SET ${sets.join(', ')} WHERE id = ANY($${values.length})`, values);
  res.json({ ok: true, updated: ids.length });
}));

// General task edit (Opgaveliste) — works for both JobTread and manual tasks.
app.put('/api/tasks/:id', auth, adminOnly, asyncRoute(async (req, res) => {
  const current = await pgOne('SELECT * FROM jt_tasks WHERE id=$1', [req.params.id]);
  if (!current) return res.status(404).json({ error: 'Opgaven blev ikke fundet' });
  const body = req.body || {};
  const next = {
    job_name: body.job_name !== undefined ? String(body.job_name).trim() : current.job_name,
    name: body.name !== undefined ? String(body.name).trim() : current.name,
    job_address: body.job_address !== undefined ? String(body.job_address).trim() : current.job_address,
    job_number: body.job_number !== undefined ? String(body.job_number).trim().slice(0, 60) : current.job_number,
    type_guess: body.type_guess !== undefined ? cleanTaskType(body.type_guess) : current.type_guess,
    description: body.description !== undefined ? String(body.description).slice(0, 5000) : current.description,
    customer_phone: body.customer_phone !== undefined ? String(body.customer_phone).trim().slice(0, 60) : current.customer_phone
  };
  await pool.query(`
    UPDATE jt_tasks
    SET job_name=$1,name=$2,job_address=$3,type_guess=$4,description=$5,
        customer_phone=$6,
        customer_phone_source=CASE
          WHEN $9::boolean AND COALESCE($6,'')<>'' THEN 'manual'
          WHEN $9::boolean THEN NULL
          ELSE customer_phone_source
        END,
        customer_phone_synced_at=CASE WHEN $9::boolean THEN NULL ELSE customer_phone_synced_at END,
        job_number=$7
    WHERE id=$8
  `, [
    next.job_name, next.name, next.job_address, next.type_guess, next.description,
    next.customer_phone || null, next.job_number || null, current.id,
    body.customer_phone !== undefined
  ]);
  res.json({ ok: true });
}));

// Bulk delete (masse-slet i Opgaveliste) — fjerner opgaver + tilhørende bookinger/filer.
app.post('/api/tasks/bulk-delete', auth, adminOnly, asyncRoute(async (req, res) => {
  const ids = Array.isArray((req.body || {}).ids) ? req.body.ids.filter(Boolean) : [];
  if (!ids.length) return res.status(400).json({ error: 'Ingen opgaver valgt' });
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query('DELETE FROM planning_bookings WHERE task_id = ANY($1)', [ids]);
    await client.query('DELETE FROM job_files WHERE task_id = ANY($1)', [ids]);
    const result = await client.query('DELETE FROM jt_tasks WHERE id = ANY($1)', [ids]);
    await client.query('COMMIT');
    res.json({ ok: true, deleted: result.rowCount });
  } catch (error) {
    try { await client.query('ROLLBACK'); } catch (_) {}
    throw error;
  } finally {
    client.release();
  }
}));

// Generel sletning af én opgave (både JobTread- og manuelle opgaver).
app.delete('/api/tasks/:id', auth, adminOnly, asyncRoute(async (req, res) => {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query('DELETE FROM planning_bookings WHERE task_id=$1', [req.params.id]);
    await client.query('DELETE FROM job_files WHERE task_id=$1', [req.params.id]);
    const result = await client.query('DELETE FROM jt_tasks WHERE id=$1', [req.params.id]);
    await client.query('COMMIT');
    if (!result.rowCount) return res.status(404).json({ error: 'Opgaven blev ikke fundet' });
    res.json({ ok: true });
  } catch (error) {
    try { await client.query('ROLLBACK'); } catch (_) {}
    throw error;
  } finally {
    client.release();
  }
}));

// ── FILER PÅ SAGEN (lægningsvejledninger, plantegninger m.m. pr. opgave) ──
app.get('/api/tasks/:id/files', auth, asyncRoute(async (req, res) => {
  const result = await pool.query('SELECT * FROM job_files WHERE task_id=$1 ORDER BY id DESC', [req.params.id]);
  res.json(result.rows);
}));

app.post('/api/tasks/:id/files', auth, adminOnly, asyncRoute(async (req, res) => {
  const body = req.body || {};
  if (!body.name || !body.url) return res.status(400).json({ error: 'Navn og link/fil skal udfyldes' });
  const result = await pool.query(`
    INSERT INTO job_files (task_id,name,url,category) VALUES ($1,$2,$3,$4) RETURNING id
  `, [req.params.id, String(body.name).trim().slice(0, 200), String(body.url), body.category || 'other']);
  res.json({ ok: true, id: result.rows[0].id });
}));

app.delete('/api/files/:id', auth, adminOnly, asyncRoute(async (req, res) => {
  await pool.query('DELETE FROM job_files WHERE id=$1', [Number(req.params.id)]);
  res.json({ ok: true });
}));

// ── VEJLEDNING / FILBIBLIOTEK (generelle lægningsvejledninger m.m.) ──
app.get('/api/library', auth, asyncRoute(async (req, res) => {
  const result = await pool.query('SELECT * FROM library_files ORDER BY category, name');
  res.json(result.rows);
}));

app.post('/api/library', auth, adminOnly, asyncRoute(async (req, res) => {
  const body = req.body || {};
  if (!body.name || !body.url) return res.status(400).json({ error: 'Navn og link/fil skal udfyldes' });
  const result = await pool.query(`
    INSERT INTO library_files (name,url,category) VALUES ($1,$2,$3) RETURNING id
  `, [String(body.name).trim().slice(0, 200), String(body.url), body.category || 'guide']);
  res.json({ ok: true, id: result.rows[0].id });
}));

app.delete('/api/library/:id', auth, adminOnly, asyncRoute(async (req, res) => {
  await pool.query('DELETE FROM library_files WHERE id=$1', [Number(req.params.id)]);
  res.json({ ok: true });
}));

// ── UGENTLIGE NOTER TIL MEDARBEJDER/VENDOR ───────────────────
app.get('/api/notes/weekly', auth, adminOnly, asyncRoute(async (req, res) => {
  const weekKey = String(req.query.week_key || '');
  if (!weekKey) return res.status(400).json({ error: 'week_key mangler' });
  const result = await pool.query('SELECT * FROM weekly_notes WHERE week_key=$1', [weekKey]);
  res.json(result.rows);
}));

app.put('/api/notes/weekly', auth, adminOnly, asyncRoute(async (req, res) => {
  const body = req.body || {};
  const userId = Number(body.user_id);
  const weekKey = String(body.week_key || '');
  if (!userId || !weekKey) return res.status(400).json({ error: 'user_id og week_key skal udfyldes' });
  const note = body.note ? String(body.note).slice(0, 2000) : null;
  await pool.query(`
    INSERT INTO weekly_notes (user_id,week_key,note,updated_at) VALUES ($1,$2,$3,${nowTextSQL()})
    ON CONFLICT (user_id,week_key) DO UPDATE SET note=EXCLUDED.note, updated_at=${nowTextSQL()}
  `, [userId, weekKey, note]);
  res.json({ ok: true });
}));

app.get('/api/notes/my', auth, asyncRoute(async (req, res) => {
  const weekKey = req.query.week_key ? String(req.query.week_key) : null;
  const result = weekKey
    ? await pool.query('SELECT * FROM weekly_notes WHERE user_id=$1 AND week_key=$2', [req.user.id, weekKey])
    : await pool.query('SELECT * FROM weekly_notes WHERE user_id=$1 ORDER BY week_key DESC LIMIT 8', [req.user.id]);
  res.json(result.rows);
}));

// ── MEDARBEJDER-ANMODNINGER (skal godkendes af admin) ────────
// Medarbejderen beder om at få en opgave sat på sin kalender (typisk i morgen),
// fx fordi de ved en kunde venter et sted, eller de mangler at nå noget.
// Admin godkender/afviser; ved godkendelse oprettes en rigtig opgave + booking.
app.post('/api/task-requests', auth, asyncRoute(async (req, res) => {
  const body = req.body || {};
  const jobName = String(body.job_name || '').trim();
  const requestedDate = body.requested_date;
  if (!jobName) return res.status(400).json({ error: 'Skriv hvad opgaven handler om' });
  if (!validDate(requestedDate)) return res.status(400).json({ error: 'Vælg en gyldig dato' });
  const estimatedDays = Math.max(0.25, Math.min(10, Number(body.estimated_days) || 1));
  const description = body.description ? String(body.description).slice(0, 2000) : null;
  const result = await pool.query(`
    INSERT INTO task_requests (user_id,job_name,description,requested_date,estimated_days,status,created_at)
    VALUES ($1,$2,$3,$4,$5,'pending',${nowTextSQL()})
    RETURNING id
  `, [req.user.id, jobName, description, requestedDate, estimatedDays]);
  res.json({ ok: true, id: result.rows[0].id });
}));

app.get('/api/task-requests/my', auth, asyncRoute(async (req, res) => {
  const result = await pool.query('SELECT * FROM task_requests WHERE user_id=$1 ORDER BY created_at DESC LIMIT 25', [req.user.id]);
  res.json(result.rows);
}));

app.get('/api/task-requests', auth, adminOnly, asyncRoute(async (req, res) => {
  const status = req.query.status ? String(req.query.status) : null;
  const result = status
    ? await pool.query(`
        SELECT r.*, u.name AS user_name, u.color AS user_color, u.initials AS user_initials
        FROM task_requests r JOIN users u ON r.user_id=u.id WHERE r.status=$1 ORDER BY r.created_at DESC
      `, [status])
    : await pool.query(`
        SELECT r.*, u.name AS user_name, u.color AS user_color, u.initials AS user_initials
        FROM task_requests r JOIN users u ON r.user_id=u.id ORDER BY r.created_at DESC
      `);
  res.json(result.rows);
}));

app.put('/api/task-requests/:id/approve', auth, adminOnly, asyncRoute(async (req, res) => {
  const reqRow = await pgOne('SELECT * FROM task_requests WHERE id=$1', [req.params.id]);
  if (!reqRow) return res.status(404).json({ error: 'Anmodningen blev ikke fundet' });
  if (reqRow.status !== 'pending') return res.status(400).json({ error: 'Anmodningen er allerede behandlet' });

  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const taskId = 'req-' + reqRow.id + '-' + Date.now();
    await client.query(`
      INSERT INTO jt_tasks (id,name,job_id,job_name,job_address,description,start_date,end_date,type_guess,synced_at,source,created_at)
      VALUES ($1,'Medarbejder-anmodning',NULL,$2,'',$3,$4,$4,'other',${nowTextSQL()},'employee_request',${nowTextSQL()})
    `, [taskId, reqRow.job_name, reqRow.description, reqRow.requested_date]);

    const bookingResult = await client.query(`
      INSERT INTO planning_bookings (task_id,user_id,week_key,days,capacity_days,notes,start_date,end_date,updated_at)
      VALUES ($1,$2,$3,$4,$4,$5,$6,$6,${nowTextSQL()})
      RETURNING id
    `, [taskId, reqRow.user_id, getWeekKey(reqRow.requested_date), reqRow.estimated_days, reqRow.description || null, reqRow.requested_date]);

    await client.query(`
      UPDATE task_requests SET status='approved', resulting_booking_id=$1, resolved_at=${nowTextSQL()} WHERE id=$2
    `, [bookingResult.rows[0].id, reqRow.id]);
    await client.query('COMMIT');
    res.json({ ok: true, bookingId: bookingResult.rows[0].id });
  } catch (error) {
    try { await client.query('ROLLBACK'); } catch (_) {}
    throw error;
  } finally {
    client.release();
  }
}));

app.put('/api/task-requests/:id/reject', auth, adminOnly, asyncRoute(async (req, res) => {
  const reqRow = await pgOne('SELECT * FROM task_requests WHERE id=$1', [req.params.id]);
  if (!reqRow) return res.status(404).json({ error: 'Anmodningen blev ikke fundet' });
  if (reqRow.status !== 'pending') return res.status(400).json({ error: 'Anmodningen er allerede behandlet' });
  const adminNote = req.body && req.body.admin_note ? String(req.body.admin_note).slice(0, 500) : null;
  await pool.query(`UPDATE task_requests SET status='rejected', admin_note=$1, resolved_at=${nowTextSQL()} WHERE id=$2`, [adminNote, reqRow.id]);
  res.json({ ok: true });
}));

// ── FLYDENDE NOTE-BLOK (personlig scratch-pad, gemmes pr. bruger) ──
app.get('/api/notes-widget', auth, asyncRoute(async (req, res) => {
  const row = await pgOne('SELECT * FROM notes_widget WHERE user_id=$1', [req.user.id]);
  res.json(row || { user_id: req.user.id, content: '', pos_x: 80, pos_y: 80, width: 320, height: 320 });
}));

app.put('/api/notes-widget', auth, asyncRoute(async (req, res) => {
  const body = req.body || {};
  const content = body.content !== undefined ? String(body.content).slice(0, 200000) : '';
  const posX = Number.isFinite(Number(body.pos_x)) ? Math.round(Number(body.pos_x)) : 80;
  const posY = Number.isFinite(Number(body.pos_y)) ? Math.round(Number(body.pos_y)) : 80;
  const width = Number.isFinite(Number(body.width)) ? Math.round(Number(body.width)) : 320;
  const height = Number.isFinite(Number(body.height)) ? Math.round(Number(body.height)) : 320;
  await pool.query(`
    INSERT INTO notes_widget (user_id,content,pos_x,pos_y,width,height,updated_at)
    VALUES ($1,$2,$3,$4,$5,$6,${nowTextSQL()})
    ON CONFLICT (user_id) DO UPDATE SET content=EXCLUDED.content, pos_x=EXCLUDED.pos_x, pos_y=EXCLUDED.pos_y, width=EXCLUDED.width, height=EXCLUDED.height, updated_at=${nowTextSQL()}
  `, [req.user.id, content, posX, posY, width, height]);
  res.json({ ok: true });
}));

// ── FERIE / SYGDOM (blokerer medarbejderens kalender) ────────
// Admin kan oprette direkte (bliver straks godkendt/blokeret). Medarbejdere kan
// sende en anmodning (samme godkendelses-flow som opgave-anmodninger).
function timeOffOverlaps(userId, startDate, endDate, excludeId) {
  const params = [userId, endDate, startDate];
  let sql = `SELECT * FROM time_off WHERE user_id=$1 AND status IN ('approved','pending') AND start_date<=$2 AND end_date>=$3`;
  if (excludeId) { params.push(excludeId); sql += ` AND id<>$${params.length}`; }
  return pool.query(sql, params);
}

app.get('/api/time-off', auth, adminOnly, asyncRoute(async (req, res) => {
  const status = req.query.status ? String(req.query.status) : null;
  const result = status
    ? await pool.query(`
        SELECT t.*, u.name AS user_name, u.color AS user_color, u.initials AS user_initials
        FROM time_off t JOIN users u ON t.user_id=u.id WHERE t.status=$1 ORDER BY t.start_date DESC
      `, [status])
    : await pool.query(`
        SELECT t.*, u.name AS user_name, u.color AS user_color, u.initials AS user_initials
        FROM time_off t JOIN users u ON t.user_id=u.id ORDER BY t.start_date DESC
      `);
  res.json(result.rows);
}));

app.get('/api/time-off/my', auth, asyncRoute(async (req, res) => {
  const result = await pool.query('SELECT * FROM time_off WHERE user_id=$1 ORDER BY start_date DESC LIMIT 25', [req.user.id]);
  res.json(result.rows);
}));

// Bruges også af Daglig plan/Kapacitet/Ledighedsoversigt til at vise blokerede dage —
// returnerer kun GODKENDTE perioder, for alle medarbejdere.
app.get('/api/time-off/approved', auth, asyncRoute(async (req, res) => {
  const result = await pool.query(`SELECT id,user_id,start_date,end_date,type,note FROM time_off WHERE status='approved' ORDER BY start_date`);
  res.json(result.rows);
}));

app.post('/api/time-off', auth, asyncRoute(async (req, res) => {
  const body = req.body || {};
  if (!validDate(body.start_date) || !validDate(body.end_date)) return res.status(400).json({ error: 'Vælg gyldige datoer' });
  if (body.end_date < body.start_date) return res.status(400).json({ error: 'Slutdato skal være efter startdato' });
  const isAdmin = req.user.role === 'admin';
  const userId = isAdmin && body.user_id ? Number(body.user_id) : req.user.id;
  const type = ['vacation', 'sick', 'other'].includes(body.type) ? body.type : 'vacation';
  const note = body.note ? String(body.note).slice(0, 1000) : null;
  const status = isAdmin ? 'approved' : 'pending';
  const result = await pool.query(`
    INSERT INTO time_off (user_id,start_date,end_date,type,status,note,requested_by,created_at,resolved_at)
    VALUES ($1,$2,$3,$4,$5,$6,$7,${nowTextSQL()},${isAdmin ? nowTextSQL() : 'NULL'})
    RETURNING id
  `, [userId, body.start_date, body.end_date, type, status, note, isAdmin ? 'admin' : 'employee']);
  res.json({ ok: true, id: result.rows[0].id, status });
}));

app.put('/api/time-off/:id/approve', auth, adminOnly, asyncRoute(async (req, res) => {
  const row = await pgOne('SELECT * FROM time_off WHERE id=$1', [req.params.id]);
  if (!row) return res.status(404).json({ error: 'Anmodningen blev ikke fundet' });
  await pool.query(`UPDATE time_off SET status='approved', resolved_at=${nowTextSQL()} WHERE id=$1`, [row.id]);
  res.json({ ok: true });
}));

app.put('/api/time-off/:id/reject', auth, adminOnly, asyncRoute(async (req, res) => {
  const row = await pgOne('SELECT * FROM time_off WHERE id=$1', [req.params.id]);
  if (!row) return res.status(404).json({ error: 'Anmodningen blev ikke fundet' });
  const adminNote = req.body && req.body.admin_note ? String(req.body.admin_note).slice(0, 500) : null;
  await pool.query(`UPDATE time_off SET status='rejected', admin_note=$1, resolved_at=${nowTextSQL()} WHERE id=$2`, [adminNote, row.id]);
  res.json({ ok: true });
}));

app.delete('/api/time-off/:id', auth, adminOnly, asyncRoute(async (req, res) => {
  const result = await pool.query('DELETE FROM time_off WHERE id=$1', [req.params.id]);
  if (!result.rowCount) return res.status(404).json({ error: 'Blev ikke fundet' });
  res.json({ ok: true });
}));

// ── OPGAVE FÆRDIG / FAKTURERING ───────────────────────────────
// Medarbejderen kan markere sin egen booking som færdig. Admin kan altid.
app.put('/api/assignments/:id/complete', auth, asyncRoute(async (req, res) => {
  const current = await pgOne('SELECT * FROM planning_bookings WHERE id=$1', [req.params.id]);
  if (!current) return res.status(404).json({ error: 'Bookingen blev ikke fundet' });
  if (req.user.role !== 'admin' && +current.user_id !== +req.user.id) {
    return res.status(403).json({ error: 'Du kan kun markere dine egne opgaver' });
  }
  if (String(current.planning_mode || 'daily') === 'capacity') {
    return res.status(400).json({ error: 'En kapacitetsreservation kan ikke markeres som færdig' });
  }
  const completed = !!(req.body || {}).completed;
  await pool.query(`UPDATE planning_bookings SET completed_at=${completed ? nowTextSQL() : 'NULL'} WHERE id=$1`, [current.id]);
  res.json({ ok: true });
}));

app.put('/api/assignments/:id/invoice', auth, adminOnly, asyncRoute(async (req, res) => {
  const current = await pgOne('SELECT * FROM planning_bookings WHERE id=$1', [req.params.id]);
  if (!current) return res.status(404).json({ error: 'Bookingen blev ikke fundet' });
  if (String(current.planning_mode || 'daily') === 'capacity') return res.status(400).json({ error: 'En kapacitetsreservation kan ikke faktureres' });
  const invoiced = !!(req.body || {}).invoiced;
  await pool.query('UPDATE planning_bookings SET invoiced=$1 WHERE id=$2', [invoiced ? 1 : 0, req.params.id]);
  res.json({ ok: true });
}));

async function normalizeBooking(body) {
  const booking = body || {};
  const task = await pgOne('SELECT id FROM jt_tasks WHERE id=$1', [booking.task_id]);
  if (!task) throw new Error('Opgaven blev ikke fundet');
  const user = await pgOne("SELECT id FROM users WHERE id=$1 AND active=1 AND role='employee'", [Number(booking.user_id)]);
  if (!user) throw new Error('Medarbejderen eller holdet blev ikke fundet');
  if (!validDate(booking.start_date)) throw new Error('Vælg en gyldig startdato');
  const days = Math.max(0.25, Math.min(60, Number(booking.days) || 1));
  // capacity_days er bevidst UAFHÆNGIG af days: Daglig plan bruger "days" til at
  // lægge den faktiske arbejdsperiode (start/slutdato). Kapacitetsboard bruger
  // "capacity_days" udelukkende til udnyttelsestal/analyse, så en ændring i det
  // ene board ikke automatisk ændrer antal dage i det andet.
  const capacityDays = booking.capacity_days !== undefined && booking.capacity_days !== null && booking.capacity_days !== ''
    ? Math.max(0.25, Math.min(60, Number(booking.capacity_days) || days))
    : days;
  const start = booking.start_date;
  return {
    task_id: booking.task_id,
    user_id: Number(booking.user_id),
    week_key: getWeekKey(start),
    days,
    capacity_days: capacityDays,
    notes: booking.notes ? String(booking.notes).slice(0, 1000) : null,
    start_time: booking.start_time || null,
    start_date: start,
    end_date: validDate(booking.end_date) ? booking.end_date : addWorkingDays(start, days)
  };
}

function bookingSelect(where = '') {
  return `
    SELECT b.*,u.name AS user_name,u.color AS user_color,u.initials AS user_initials,u.avatar_url AS user_avatar_url,u.worker_type,u.vendor_group,u.trade,u.weekly_capacity,u.can_login,
           t.name AS task_name,t.job_name,t.job_address,t.job_number,t.job_lat,t.job_lng,t.customer_phone,t.description AS task_description,t.start_date AS task_start_date,t.end_date AS task_end_date,t.type_guess,t.jt_url,t.job_id,t.source AS task_source
    FROM planning_bookings b
    JOIN users u ON b.user_id=u.id
    JOIN jt_tasks t ON b.task_id=t.id
    ${where}
  `;
}

app.get('/api/assignments', auth, asyncRoute(async (req, res) => {
  const isAdmin = req.user.role === 'admin';
  const sql = `${bookingSelect(isAdmin ? '' : 'WHERE b.user_id=$1')} ORDER BY b.start_date ASC,b.id ASC`;
  const result = await pool.query(sql, isAdmin ? [] : [req.user.id]);
  res.json(result.rows);
}));

app.get('/api/assignments/my', auth, asyncRoute(async (req, res) => {
  // Employees only see actual daily work. Capacity-only blocks are an admin planning tool.
  const result = await pool.query(`${bookingSelect("WHERE b.user_id=$1 AND COALESCE(b.planning_mode,'daily') <> 'capacity'")} ORDER BY b.start_date ASC,b.id ASC`, [req.user.id]);
  res.json(result.rows);
}));

app.post('/api/assignments', auth, adminOnly, asyncRoute(async (req, res) => {
  try {
    const booking = await normalizeBooking(req.body);
    const result = await pool.query(`
      INSERT INTO planning_bookings (task_id,user_id,week_key,days,capacity_days,notes,start_time,start_date,end_date,updated_at)
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,${nowTextSQL()})
      RETURNING id
    `, [booking.task_id, booking.user_id, booking.week_key, booking.days, booking.capacity_days, booking.notes, booking.start_time, booking.start_date, booking.end_date]);
    let warning = null;
    try {
      const overlap = await timeOffOverlaps(booking.user_id, booking.start_date, booking.end_date);
      if (overlap.rows.length) warning = 'Medarbejderen har registreret ferie/fravær i denne periode';
    } catch (_) {}
    res.json({ ok: true, id: result.rows[0].id, warning });
  } catch (error) {
    res.status(400).json({ error: error.message });
  }
}));

app.put('/api/assignments/:id', auth, adminOnly, asyncRoute(async (req, res) => {
  const current = await pgOne('SELECT * FROM planning_bookings WHERE id=$1', [Number(req.params.id)]);
  if (!current) return res.status(404).json({ error: 'Bookingen blev ikke fundet' });
  try {
    const booking = await normalizeBooking({ ...current, ...(req.body || {}), task_id: current.task_id });
    await pool.query(`
      UPDATE planning_bookings
      SET user_id=$1,week_key=$2,days=$3,capacity_days=$4,notes=$5,start_time=$6,start_date=$7,end_date=$8,updated_at=${nowTextSQL()}
      WHERE id=$9
    `, [booking.user_id, booking.week_key, booking.days, booking.capacity_days, booking.notes, booking.start_time, booking.start_date, booking.end_date, current.id]);
    res.json({ ok: true });
  } catch (error) {
    res.status(400).json({ error: error.message });
  }
}));

app.delete('/api/assignments/:id', auth, adminOnly, asyncRoute(async (req, res) => {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const current = await client.query('SELECT * FROM planning_bookings WHERE id=$1', [Number(req.params.id)]);
    if (!current.rowCount) {
      await client.query('ROLLBACK');
      return res.status(404).json({ error: 'Bookingen blev ikke fundet' });
    }
    const row = current.rows[0];
    await client.query('DELETE FROM planning_bookings WHERE id=$1', [row.id]);
    // A manually created capacity block owns a hidden helper task. Remove it when
    // the last reservation is deleted so the database does not collect ghosts.
    if (String(row.planning_mode || 'daily') === 'capacity') {
      await client.query(`
        DELETE FROM jt_tasks t
        WHERE t.id=$1 AND t.source='capacity'
          AND NOT EXISTS (SELECT 1 FROM planning_bookings b WHERE b.task_id=t.id)
      `, [row.task_id]);
    }
    await client.query('COMMIT');
    res.json({ ok: true });
  } catch (error) {
    try { await client.query('ROLLBACK'); } catch (_) {}
    throw error;
  } finally {
    client.release();
  }
}));

app.delete('/api/plan', auth, adminOnly, asyncRoute(async (req, res) => {
  // Do not erase long-range capacity reservations when clearing the day-to-day plan.
  await pool.query("DELETE FROM planning_bookings WHERE COALESCE(planning_mode,'daily') <> 'capacity'");
  res.json({ ok: true });
}));

// ── TIME LOGS (legacy support) ───────────────────────────────
app.post('/api/time/start', auth, asyncRoute(async (req, res) => {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query(`
      UPDATE time_logs
      SET stopped_at=${nowTextSQL()},
          duration_minutes=GREATEST(0, FLOOR(EXTRACT(EPOCH FROM (CURRENT_TIMESTAMP - started_at::timestamptz))/60)::int)
      WHERE user_id=$1 AND stopped_at IS NULL
    `, [req.user.id]);
    const result = await client.query(`
      INSERT INTO time_logs (user_id,task_id,started_at)
      VALUES ($1,$2,${nowTextSQL()})
      RETURNING id
    `, [req.user.id, (req.body || {}).task_id]);
    await client.query('COMMIT');
    res.json({ ok: true, id: result.rows[0].id });
  } catch (error) {
    try { await client.query('ROLLBACK'); } catch (_) {}
    throw error;
  } finally {
    client.release();
  }
}));

app.post('/api/time/stop', auth, asyncRoute(async (req, res) => {
  const log = await pgOne('SELECT * FROM time_logs WHERE id=$1 AND user_id=$2', [Number((req.body || {}).log_id), req.user.id]);
  if (!log) return res.status(404).json({ error: 'Not found' });
  await pool.query(`
    UPDATE time_logs
    SET stopped_at=${nowTextSQL()},
        duration_minutes=GREATEST(0, FLOOR(EXTRACT(EPOCH FROM (CURRENT_TIMESTAMP - started_at::timestamptz))/60)::int),
        notes=$1
    WHERE id=$2
  `, [(req.body || {}).notes || null, log.id]);
  const updated = await pgOne('SELECT duration_minutes FROM time_logs WHERE id=$1', [log.id]);
  res.json({ ok: true, duration_minutes: updated.duration_minutes });
}));

app.get('/api/time/active', auth, asyncRoute(async (req, res) => {
  const result = await pool.query(`
    SELECT tl.*,t.job_name,t.name AS task_name
    FROM time_logs tl
    JOIN jt_tasks t ON tl.task_id=t.id
    WHERE tl.user_id=$1 AND tl.stopped_at IS NULL
    ORDER BY tl.id DESC
    LIMIT 1
  `, [req.user.id]);
  res.json(result.rows[0] || null);
}));

app.get('/api/time/all', auth, adminOnly, asyncRoute(async (req, res) => {
  const result = await pool.query(`
    SELECT tl.*,u.name AS user_name,t.job_name,t.name AS task_name
    FROM time_logs tl
    JOIN users u ON tl.user_id=u.id
    JOIN jt_tasks t ON tl.task_id=t.id
    ORDER BY tl.id DESC
    LIMIT 200
  `);
  res.json(result.rows);
}));

// ── DASHBOARD ─────────────────────────────────────────────────
app.get('/api/dashboard', auth, adminOnly, asyncRoute(async (req, res) => {
  const result = await pgOne(`
    SELECT
      (SELECT COUNT(*)::int FROM jt_tasks) AS "totalTasks",
      (SELECT COUNT(DISTINCT task_id)::int FROM planning_bookings) AS assigned,
      (SELECT COUNT(*)::int FROM planning_bookings) AS bookings,
      (SELECT COUNT(*)::int FROM users WHERE active=1 AND role='employee' AND COALESCE(worker_type,'employee')!='vendor') AS employees,
      (SELECT COUNT(*)::int FROM users WHERE active=1 AND role='employee' AND worker_type='vendor') AS vendors,
      (SELECT COUNT(*)::int FROM jt_tasks WHERE source='manual') AS manual
  `);
  const lastSync = await pgOne('SELECT * FROM sync_log ORDER BY id DESC LIMIT 1');
  res.json({
    ...result,
    unassigned: Math.max(0, Number(result.totalTasks || 0) - Number(result.assigned || 0)),
    lastSync
  });
}));

app.get('/api/health', asyncRoute(async (req, res) => {
  await pool.query('SELECT 1');
  res.json({ ok: true, database: 'postgres' });
}));

// ── PAGES ─────────────────────────────────────────────────────
// no-store: sikrer at browseren ALTID henter den nyeste version af siden
// efter en deploy, i stedet for evt. at vise en cachet, forældet udgave.
function sendPage(filename) {
  return (req, res) => {
    res.set('Cache-Control', 'no-store, no-cache, must-revalidate');
    res.sendFile(path.join(__dirname, filename));
  };
}
app.get('/migrate', sendPage('migrate.html'));
app.get('/admin', sendPage('admin.html'));
app.get('/employee', sendPage('employee.html'));
app.get('/', sendPage('index.html'));
app.get('*', sendPage('index.html'));

app.use((error, req, res, next) => {
  console.error('Unhandled error:', error);
  if (res.headersSent) return next(error);
  const message = error instanceof multer.MulterError ? 'Upload fejlede: filen er for stor eller ugyldig.' : (error.message || 'Serverfejl');
  res.status(500).json({ error: message });
});

async function start() {
  await pool.query('SELECT 1 AS connected');
  await initSchema();
  app.listen(PORT, () => {
    console.log(`Gulv Master PostgreSQL kører på port ${PORT}`);
    console.log('JobTread-synk er read-only: den kan aldrig ændre planning_bookings.');
  });
  // During the first SQLite → Postgres migration, the database must stay empty.
  // Otherwise a startup JobTread sync could add tasks and make the protected import
  // stop to avoid duplicates. Sync is enabled automatically after the migration exists.
  const migrationState = await pgOne("SELECT 1 FROM app_migrations WHERE name='sqlite_initial_import_20260702'");
  const migrationPending = Boolean(MIGRATION_SECRET) && !migrationState;
  if (JT_GRANT && JT_ORG && JT_AUTO_SYNC && !migrationPending) {
    setTimeout(() => syncFromJT().catch(error => console.error('Startup sync failed:', error.message)), 5000);
    cron.schedule('0 * * * *', () => syncFromJT().catch(error => console.error('Scheduled sync failed:', error.message)));
  } else if (migrationPending) {
    console.log('JobTread-sync er sat på pause, indtil den første SQLite-import er færdig.');
  }
}

start().catch(error => {
  console.error('FATAL STARTUP ERROR:', error.message);
  process.exit(1);
});
