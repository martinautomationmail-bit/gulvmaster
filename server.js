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
app.use(express.json({ limit: '1mb' }));
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
  res.json({ token, user: { id: user.id, name: user.name, role: user.role, email: user.email, color: user.color, initials: user.initials } });
}));

app.get('/api/auth/me', auth, asyncRoute(async (req, res) => {
  const user = await pgOne('SELECT id,name,email,role,color,initials FROM users WHERE id=$1', [req.user.id]);
  if (!user) return res.status(401).json({ error: 'Bruger ikke fundet' });
  res.json(user);
}));

// ── USERS / WORKFORCE ───────────────────────────────────────
app.get('/api/users', auth, adminOnly, asyncRoute(async (req, res) => {
  const result = await pool.query(`
    SELECT id,name,email,role,color,initials,jobtread_name,active,worker_type,vendor_group,trade,weekly_capacity,COALESCE(can_login,1) AS can_login
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
      INSERT INTO users (name,email,password_hash,role,color,initials,jobtread_name,active,worker_type,vendor_group,trade,weekly_capacity,can_login)
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13)
      RETURNING id
    `, [String(body.name).trim(), email, bcrypt.hashSync(password, 10), role, body.color || '#2563EB', initials, body.jobtread_name || null, body.active === 0 ? 0 : 1, workerType, body.vendor_group || null, body.trade || null, weeklyCapacity, canLogin ? 1 : 0]);
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
    can_login: canLogin
  };
  if (canLogin && !next.email) return res.status(400).json({ error: 'Email mangler for login-bruger' });
  try {
    await pool.query(`
      UPDATE users SET name=$1,email=$2,password_hash=$3,role=$4,color=$5,initials=$6,jobtread_name=$7,active=$8,worker_type=$9,vendor_group=$10,trade=$11,weekly_capacity=$12,can_login=$13
      WHERE id=$14
    `, [next.name, next.email, next.password_hash, next.role, next.color, next.initials, next.jobtread_name, next.active, next.worker_type, next.vendor_group, next.trade, next.weekly_capacity, next.can_login, id]);
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

async function jtFetch(body, label = 'JobTread-kald') {
  const response = await fetch(JT_API, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body)
  });

  const raw = await response.text();
  let data = null;
  try { data = raw ? JSON.parse(raw) : null; } catch (_) {}

  if (!response.ok) {
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

async function syncFromJT() {
  if (!JT_GRANT) {
    await writeSyncLog(0, 'error', 'Grant Key ikke sat. Tilføj JT_GRANT_KEY i Render Environment.');
    return { ok: false, error: 'Ingen Grant Key' };
  }
  if (!JT_ORG) {
    await writeSyncLog(0, 'error', 'Organisation ID ikke sat. Tilføj JT_ORG_ID i Render Environment.');
    return { ok: false, error: 'Ingen Organisation ID' };
  }

  try {
    const allTasks = [];
    const assigneeByTask = new Map();
    const seenTaskIds = new Set();
    const seenCursors = new Set();
    let cursor = null; // null = first page: no `page` parameter at all
    let pagesFetched = 0;

    // Pass 1: fetch all task dates + job info (no assignments — keeps each page small)
    while (pagesFetched < JT_MAX_PAGES) {
      const cursorKey = cursor === null ? '__first__' : String(cursor);
      if (seenCursors.has(cursorKey)) break;
      seenCursors.add(cursorKey);

      const label = pagesFetched === 0 ? 'Tasks første side (job-info)' : `Tasks side ${pagesFetched + 1} (job-info)`;
      const taskData = await jtFetch(taskPagePayload(cursor), label);
      const connection = taskConnectionFrom(taskData);
      const pageTasks = Array.isArray(connection.nodes) ? connection.nodes : [];

      for (const task of pageTasks) {
        if (!task?.id || seenTaskIds.has(task.id)) continue;
        seenTaskIds.add(task.id);
        allTasks.push(task);
      }

      pagesFetched += 1;
      const nextCursor = connection.nextPage;
      if (nextCursor === null || nextCursor === undefined || nextCursor === '' || nextCursor === false) {
        cursor = null;
        break;
      }
      cursor = nextCursor;
    }

    // Pass 2: fetch assignments separately (avoids 413 from combined payload)
    let assignCursor = null;
    const seenAssignCursors = new Set();
    let assignPages = 0;
    while (assignPages < JT_MAX_PAGES) {
      const cursorKey = assignCursor === null ? '__first__' : String(assignCursor);
      if (seenAssignCursors.has(cursorKey)) break;
      seenAssignCursors.add(cursorKey);

      const label = assignPages === 0 ? 'Assignments første side' : `Assignments side ${assignPages + 1}`;
      const assignData = await jtFetch(taskAssignPagePayload(assignCursor), label);
      const conn2 = taskConnectionFrom(assignData);
      const pageNodes = Array.isArray(conn2.nodes) ? conn2.nodes : [];

      for (const task of pageNodes) {
        if (!task?.id) continue;
        const first = task?.taskAssignments?.nodes?.[0]?.membership?.user?.name;
        if (first) assigneeByTask.set(task.id, first);
      }

      assignPages += 1;
      const nextAssignCursor = conn2.nextPage;
      if (nextAssignCursor === null || nextAssignCursor === undefined || nextAssignCursor === '' || nextAssignCursor === false) break;
      assignCursor = nextAssignCursor;
    }

    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      for (const task of allTasks) {
        const job = task.job || {};
        const customerName = String(job.name || '')
          .replace(/\s*[-–]\s*(gulvl.gning|gulvslib|maler.*|slibning|service|renovering|t.mrer).*/i, '')
          .trim();

        // Read-only JobTread import. This upsert touches jt_tasks only and
        // intentionally never changes customer_phone, planning_bookings,
        // users, notes, dates chosen in the portal, vendors, or capacity.
        await client.query(`
          INSERT INTO jt_tasks (id,name,job_id,job_name,job_address,start_date,end_date,type_guess,raw_assignee_name,jt_url,synced_at,source)
          VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,${nowTextSQL()},'jobtread')
          ON CONFLICT (id) DO UPDATE SET
            name=EXCLUDED.name,
            job_id=EXCLUDED.job_id,
            job_name=EXCLUDED.job_name,
            job_address=EXCLUDED.job_address,
            start_date=EXCLUDED.start_date,
            end_date=EXCLUDED.end_date,
            type_guess=EXCLUDED.type_guess,
            raw_assignee_name=EXCLUDED.raw_assignee_name,
            jt_url=EXCLUDED.jt_url,
            synced_at=EXCLUDED.synced_at,
            source='jobtread'
        `, [
          task.id,
          task.name || '',
          job.id || null,
          customerName || job.name || '',
          job.location?.address || '',
          task.startDate || null,
          task.endDate || task.startDate || null,
          guessType(task.name),
          assigneeByTask.get(task.id) || null,
          job.id ? `https://app.jobtread.com/jobs/${job.id}/schedule` : null
        ]);
      }
      await client.query('COMMIT');
    } catch (error) {
      try { await client.query('ROLLBACK'); } catch (_) {}
      throw error;
    } finally {
      client.release();
    }

    const undated = allTasks.filter(task => !task.startDate).length;
    const capped = pagesFetched >= JT_MAX_PAGES && cursor !== null;
    const capNotice = capped ? ` · stoppet efter sikkerhedsgrænse på ${JT_MAX_PAGES} sider` : '';
    const message = `${allTasks.length} tasks synced fra ${pagesFetched} sider · ${undated} uden JobTread-dato${capNotice}`;
    await writeSyncLog(allTasks.length, 'ok', message);
    return { ok: true, count: allTasks.length, undated, pages: pagesFetched, pageSize: JT_PAGE_SIZE, capped };
  } catch (error) {
    const safeMessage = redactSecret(error?.message || 'Ukendt JobTread-fejl').slice(0, 1000);
    await writeSyncLog(0, 'error', safeMessage);
    return { ok: false, error: safeMessage };
  }
}

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
    SELECT t.*, COUNT(b.id)::int AS assignment_count
    FROM jt_tasks t
    LEFT JOIN planning_bookings b ON b.task_id=t.id
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
    INSERT INTO jt_tasks (id,name,job_id,job_name,job_address,customer_phone,start_date,end_date,type_guess,raw_assignee_name,jt_url,synced_at,source,created_at)
    VALUES ($1,$2,NULL,$3,$4,$5,$6,$7,$8,NULL,NULL,${nowTextSQL()},'manual',${nowTextSQL()})
  `, [id, String(body.name).trim(), String(body.job_name).trim(), body.job_address || '', body.customer_phone || null, body.start_date, endDate, cleanTaskType(body.type_guess)]);
  res.json({ ok: true, id });
}));

app.put('/api/tasks/:id/customer-contact', auth, adminOnly, asyncRoute(async (req, res) => {
  const task = await pgOne('SELECT id FROM jt_tasks WHERE id=$1', [req.params.id]);
  if (!task) return res.status(404).json({ error: 'Opgaven blev ikke fundet' });
  const phone = String((req.body || {}).customer_phone || '').trim().slice(0, 60);
  await pool.query('UPDATE jt_tasks SET customer_phone=$1 WHERE id=$2', [phone || null, req.params.id]);
  res.json({ ok: true, customer_phone: phone || null });
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

async function normalizeBooking(body) {
  const booking = body || {};
  const task = await pgOne('SELECT id FROM jt_tasks WHERE id=$1', [booking.task_id]);
  if (!task) throw new Error('Opgaven blev ikke fundet');
  const user = await pgOne("SELECT id FROM users WHERE id=$1 AND active=1 AND role='employee'", [Number(booking.user_id)]);
  if (!user) throw new Error('Medarbejderen eller holdet blev ikke fundet');
  if (!validDate(booking.start_date)) throw new Error('Vælg en gyldig startdato');
  const days = Math.max(0.25, Math.min(60, Number(booking.days) || 1));
  const start = booking.start_date;
  return {
    task_id: booking.task_id,
    user_id: Number(booking.user_id),
    week_key: getWeekKey(start),
    days,
    notes: booking.notes ? String(booking.notes).slice(0, 1000) : null,
    start_time: booking.start_time || null,
    start_date: start,
    end_date: validDate(booking.end_date) ? booking.end_date : addWorkingDays(start, days)
  };
}

function bookingSelect(where = '') {
  return `
    SELECT b.*,u.name AS user_name,u.color AS user_color,u.initials AS user_initials,u.worker_type,u.vendor_group,u.trade,u.weekly_capacity,u.can_login,
           t.name AS task_name,t.job_name,t.job_address,t.customer_phone,t.start_date AS task_start_date,t.end_date AS task_end_date,t.type_guess,t.jt_url,t.job_id,t.source AS task_source
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
  const result = await pool.query(`${bookingSelect('WHERE b.user_id=$1')} ORDER BY b.start_date ASC,b.id ASC`, [req.user.id]);
  res.json(result.rows);
}));

app.post('/api/assignments', auth, adminOnly, asyncRoute(async (req, res) => {
  try {
    const booking = await normalizeBooking(req.body);
    const result = await pool.query(`
      INSERT INTO planning_bookings (task_id,user_id,week_key,days,notes,start_time,start_date,end_date,updated_at)
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8,${nowTextSQL()})
      RETURNING id
    `, [booking.task_id, booking.user_id, booking.week_key, booking.days, booking.notes, booking.start_time, booking.start_date, booking.end_date]);
    res.json({ ok: true, id: result.rows[0].id });
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
      SET user_id=$1,week_key=$2,days=$3,notes=$4,start_time=$5,start_date=$6,end_date=$7,updated_at=${nowTextSQL()}
      WHERE id=$8
    `, [booking.user_id, booking.week_key, booking.days, booking.notes, booking.start_time, booking.start_date, booking.end_date, current.id]);
    res.json({ ok: true });
  } catch (error) {
    res.status(400).json({ error: error.message });
  }
}));

app.delete('/api/assignments/:id', auth, adminOnly, asyncRoute(async (req, res) => {
  await pool.query('DELETE FROM planning_bookings WHERE id=$1', [Number(req.params.id)]);
  res.json({ ok: true });
}));

app.delete('/api/plan', auth, adminOnly, asyncRoute(async (req, res) => {
  await pool.query('DELETE FROM planning_bookings');
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
function sendPage(filename) {
  return (req, res) => res.sendFile(path.join(__dirname, filename));
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
