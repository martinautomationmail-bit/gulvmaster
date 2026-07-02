const express = require('express');
const Database = require('better-sqlite3');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const cors = require('cors');
const fetch = (...args) => import('node-fetch').then(({default: f}) => f(...args));
const path = require('path');
const cron = require('node-cron');
 
const app = express();
const PORT = process.env.PORT || 3000;
const JWT_SECRET = process.env.JWT_SECRET || 'gulvmaster-secret-2026';
const JT_ORG = process.env.JT_ORG_ID || '22PZCGuGrJnQ';
const JT_GRANT = process.env.JT_GRANT_KEY || '';
const JT_API = 'https://api.jobtread.com/pave';
 
app.use(cors());
app.use(express.json());
 
// Serve HTML files from same directory as server.js
const PUBLIC = __dirname;
app.use(express.static(PUBLIC));
 
// Database
const db = new Database(process.env.DB_PATH || path.join(__dirname, 'gulvmaster.db'));
 
db.exec(`
  CREATE TABLE IF NOT EXISTS users (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL,
    email TEXT UNIQUE NOT NULL,
    password_hash TEXT NOT NULL,
    role TEXT DEFAULT 'employee',
    color TEXT DEFAULT '#2563EB',
    initials TEXT,
    jobtread_member_id TEXT,
    active INTEGER DEFAULT 1,
    created_at TEXT DEFAULT (datetime('now'))
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
    synced_at TEXT DEFAULT (datetime('now'))
  );
  CREATE TABLE IF NOT EXISTS assignments (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    task_id TEXT NOT NULL,
    user_id INTEGER NOT NULL,
    week_key TEXT NOT NULL,
    days REAL DEFAULT 1,
    notes TEXT,
    created_at TEXT DEFAULT (datetime('now')),
    FOREIGN KEY(task_id) REFERENCES jt_tasks(id),
    FOREIGN KEY(user_id) REFERENCES users(id),
    UNIQUE(task_id, user_id, week_key)
  );
  CREATE TABLE IF NOT EXISTS time_logs (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id INTEGER NOT NULL,
    task_id TEXT NOT NULL,
    started_at TEXT,
    stopped_at TEXT,
    duration_minutes INTEGER,
    notes TEXT,
    created_at TEXT DEFAULT (datetime('now')),
    FOREIGN KEY(user_id) REFERENCES users(id)
  );
  CREATE TABLE IF NOT EXISTS sync_log (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    synced_at TEXT DEFAULT (datetime('now')),
    tasks_imported INTEGER DEFAULT 0,
    status TEXT,
    message TEXT
  );
`);
 
// Seed admin
const adminExists = db.prepare('SELECT id FROM users WHERE role = ?').get('admin');
if (!adminExists) {
  const hash = bcrypt.hashSync('admin123', 10);
  db.prepare(`INSERT OR IGNORE INTO users (name, email, password_hash, role, color, initials) VALUES (?, ?, ?, ?, ?, ?)`)
    .run('Martin Breinbjerg', 'martin@gulvmaster.dk', hash, 'admin', '#0F2240', 'MB');
  console.log('✅ Admin oprettet: martin@gulvmaster.dk / admin123');
}
 
// Auth middleware
function auth(req, res, next) {
  const header = req.headers.authorization;
  if (!header) return res.status(401).json({ error: 'No token' });
  try { req.user = jwt.verify(header.replace('Bearer ', ''), JWT_SECRET); next(); }
  catch { res.status(401).json({ error: 'Invalid token' }); }
}
function adminOnly(req, res, next) {
  if (req.user.role !== 'admin') return res.status(403).json({ error: 'Admin only' });
  next();
}
 
// ── AUTH ──────────────────────────────────────────────
app.post('/api/auth/login', (req, res) => {
  const { email, password } = req.body;
  const user = db.prepare('SELECT * FROM users WHERE email = ? AND active = 1').get(email);
  if (!user || !bcrypt.compareSync(password, user.password_hash))
    return res.status(401).json({ error: 'Forkert email eller adgangskode' });
  const token = jwt.sign({ id: user.id, name: user.name, role: user.role, email: user.email }, JWT_SECRET, { expiresIn: '30d' });
  res.json({ token, user: { id: user.id, name: user.name, role: user.role, email: user.email, color: user.color, initials: user.initials } });
});
 
app.get('/api/auth/me', auth, (req, res) => {
  const user = db.prepare('SELECT id, name, email, role, color, initials FROM users WHERE id = ?').get(req.user.id);
  res.json(user);
});
 
// ── USERS ─────────────────────────────────────────────
app.get('/api/users', auth, adminOnly, (req, res) => {
  res.json(db.prepare('SELECT id, name, email, role, color, initials, jobtread_member_id, active FROM users ORDER BY role DESC, name').all());
});
 
app.post('/api/users', auth, adminOnly, (req, res) => {
  const { name, email, password, role, color, initials, jobtread_member_id } = req.body;
  if (!name || !email || !password) return res.status(400).json({ error: 'Navn, email og kode er påkrævet' });
  try {
    const hash = bcrypt.hashSync(password, 10);
    const ini = initials || name.split(' ').map(w => w[0]).join('').substring(0, 2).toUpperCase();
    const result = db.prepare(`INSERT INTO users (name, email, password_hash, role, color, initials, jobtread_member_id) VALUES (?, ?, ?, ?, ?, ?, ?)`)
      .run(name, email, hash, role || 'employee', color || '#2563EB', ini, jobtread_member_id || null);
    res.json({ id: result.lastInsertRowid, name, email, role: role || 'employee' });
  } catch (e) {
    if (e.message.includes('UNIQUE')) return res.status(400).json({ error: 'Email er allerede i brug' });
    res.status(500).json({ error: e.message });
  }
});
 
app.put('/api/users/:id', auth, adminOnly, (req, res) => {
  const { name, email, role, color, initials, jobtread_member_id, active, password } = req.body;
  const user = db.prepare('SELECT * FROM users WHERE id = ?').get(req.params.id);
  if (!user) return res.status(404).json({ error: 'Ikke fundet' });
  const newHash = password ? bcrypt.hashSync(password, 10) : user.password_hash;
  db.prepare(`UPDATE users SET name=?, email=?, password_hash=?, role=?, color=?, initials=?, jobtread_member_id=?, active=? WHERE id=?`)
    .run(name || user.name, email || user.email, newHash, role || user.role, color || user.color,
      initials || user.initials, jobtread_member_id || user.jobtread_member_id,
      active !== undefined ? active : user.active, req.params.id);
  res.json({ ok: true });
});
 
app.delete('/api/users/:id', auth, adminOnly, (req, res) => {
  if (parseInt(req.params.id) === req.user.id) return res.status(400).json({ error: 'Kan ikke slette dig selv' });
  db.prepare('UPDATE users SET active = 0 WHERE id = ?').run(req.params.id);
  res.json({ ok: true });
});
 
// ── JOBTREAD SYNC ─────────────────────────────────────
async function jtQuery(query) {
  const key = JT_GRANT || process.env.JT_GRANT_KEY;
  if (!key) throw new Error('Ingen Grant Key');
  const resp = await fetch(JT_API, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ query: { $: { grantKey: key }, ...query } })
  });
  if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
  const data = await resp.json();
  if (data.error) throw new Error(JSON.stringify(data.error));
  return data;
}
 
function guessType(name) {
  const t = name.toLowerCase();
  if (t.includes('slib') || t.includes('behandling')) return 'sand';
  if (t.includes('mal') || t.includes('lak') || t.includes('maling')) return 'paint';
  if (t.includes('vvs') || t.includes(' el ') || t.includes('varme')) return 'sub';
  if (t.includes('læg') || t.includes('parket') || t.includes('afmontering') || t.includes('spånplade') || t.includes('strøer') || t.includes('gulv')) return 'lay';
  return 'other';
}
 
function wkeyFromDate(dateStr) {
  const d = new Date(dateStr);
  const day = d.getDay() || 7;
  d.setDate(d.getDate() + 4 - day);
  const y = new Date(Date.UTC(d.getFullYear(), 0, 1));
  const wn = Math.ceil((((d - y) / 86400000) + 1) / 7);
  const mon = new Date(dateStr);
  const md = mon.getDay();
  mon.setDate(mon.getDate() - (md || 7) + 1);
  return `w${mon.getFullYear()}-${String(wn).padStart(2, '0')}`;
}
 
async function syncFromJT() {
  console.log('🔄 Syncing from JobTread...');
  try {
    const from = new Date().toISOString().split('T')[0];
    const to = new Date(Date.now() + 84 * 86400000).toISOString().split('T')[0];
    const where = { and: [['isToDo', false], ['targetType', 'job'], ['startDate', '>=', from], ['startDate', '<=', to], ['isGroup', false]] };
 
    const [r1, r2, r3, r4] = await Promise.all([
      jtQuery({ organization: { $: { id: JT_ORG }, tasks: { $: { size: 80, where }, nodes: { id: {}, name: {}, startDate: {}, endDate: {} } } } }),
      jtQuery({ organization: { $: { id: JT_ORG }, tasks: { $: { size: 80, where }, nodes: { id: {}, taskAssignments: { nodes: { membership: { user: { name: {} } } } } } } }),
      jtQuery({ organization: { $: { id: JT_ORG }, jobs: { $: { size: 50 }, nodes: { id: {}, name: {}, location: { address: {}, name: {} } } } } }),
      jtQuery({ organization: { $: { id: JT_ORG }, tasks: { $: { size: 80, where }, nodes: { id: {}, targetId: {} } } } }),
    ]);
 
    const tasks = r1?.query?.organization?.tasks?.nodes || [];
    const assignMap = {};
    (r2?.query?.organization?.tasks?.nodes || []).forEach(t => { assignMap[t.id] = t.taskAssignments?.nodes?.[0]?.membership?.user?.name || null; });
    const jobMap = {};
    (r3?.query?.organization?.jobs?.nodes || []).forEach(j => { jobMap[j.id] = { name: j.name, address: j.location?.address || j.location?.name || '' }; });
    const taskJobMap = {};
    (r4?.query?.organization?.tasks?.nodes || []).forEach(t => { taskJobMap[t.id] = t.targetId; });
 
    const upsert = db.prepare(`INSERT OR REPLACE INTO jt_tasks (id, name, job_id, job_name, job_address, start_date, end_date, type_guess, raw_assignee_name, jt_url, synced_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, datetime('now'))`);
    const upsertAll = db.transaction(tasks => {
      for (const t of tasks) {
        const jid = taskJobMap[t.id];
        const ji = jobMap[jid] || {};
        const customer = (ji.name || '').replace(/\s*[-–]\s*(gulvlægning|gulvslib|maler.*|slibning|service|renovering|tømrer).*/i, '').trim();
        upsert.run(t.id, t.name, jid || null, customer || ji.name || '', ji.address || '', t.startDate, t.endDate || t.startDate, guessType(t.name), assignMap[t.id] || null, `https://app.jobtread.com/jobs/${jid}`);
      }
    });
    upsertAll(tasks);
    db.prepare(`INSERT INTO sync_log (tasks_imported, status, message) VALUES (?, ?, ?)`).run(tasks.length, 'ok', `${tasks.length} tasks`);
    console.log(`✅ Synced ${tasks.length} tasks`);
    return { ok: true, count: tasks.length };
  } catch (e) {
    console.error('❌', e.message);
    db.prepare(`INSERT INTO sync_log (tasks_imported, status, message) VALUES (?, ?, ?)`).run(0, 'error', e.message);
    return { ok: false, error: e.message };
  }
}
 
app.post('/api/sync', auth, adminOnly, async (req, res) => res.json(await syncFromJT()));
app.get('/api/sync/log', auth, adminOnly, (req, res) => res.json(db.prepare('SELECT * FROM sync_log ORDER BY synced_at DESC LIMIT 20').all()));
 
cron.schedule('0 * * * *', () => syncFromJT());
 
// ── TASKS ─────────────────────────────────────────────
app.get('/api/tasks', auth, (req, res) => res.json(db.prepare('SELECT * FROM jt_tasks ORDER BY start_date ASC').all()));
 
// ── ASSIGNMENTS ───────────────────────────────────────
app.get('/api/assignments', auth, (req, res) => {
  let q = `SELECT a.*, u.name as user_name, u.color as user_color, u.initials as user_initials,
    t.name as task_name, t.job_name, t.job_address, t.start_date, t.end_date, t.type_guess, t.jt_url, t.job_id
    FROM assignments a JOIN users u ON a.user_id = u.id JOIN jt_tasks t ON a.task_id = t.id`;
  const params = [];
  if (req.user.role !== 'admin') { q += ' WHERE a.user_id = ?'; params.push(req.user.id); }
  q += ' ORDER BY t.start_date ASC';
  res.json(db.prepare(q).all(...params));
});
 
app.get('/api/assignments/my', auth, (req, res) => {
  res.json(db.prepare(`SELECT a.*, t.name as task_name, t.job_name, t.job_address, t.start_date, t.end_date, t.type_guess, t.jt_url, t.job_id
    FROM assignments a JOIN jt_tasks t ON a.task_id = t.id WHERE a.user_id = ? ORDER BY t.start_date ASC`).all(req.user.id));
});
 
app.post('/api/assignments', auth, adminOnly, (req, res) => {
  const { task_id, user_id, week_key, days, notes } = req.body;
  try {
    const result = db.prepare(`INSERT OR REPLACE INTO assignments (task_id, user_id, week_key, days, notes) VALUES (?, ?, ?, ?, ?)`)
      .run(task_id, user_id, week_key, days || 1, notes || null);
    res.json({ id: result.lastInsertRowid, ok: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});
 
app.put('/api/assignments/:id', auth, adminOnly, (req, res) => {
  const { user_id, week_key, days, notes } = req.body;
  db.prepare(`UPDATE assignments SET user_id=?, week_key=?, days=?, notes=? WHERE id=?`).run(user_id, week_key, days, notes || null, req.params.id);
  res.json({ ok: true });
});
 
app.delete('/api/assignments/:id', auth, adminOnly, (req, res) => {
  db.prepare('DELETE FROM assignments WHERE id = ?').run(req.params.id);
  res.json({ ok: true });
});
 
// ── TIME TRACKING ─────────────────────────────────────
app.post('/api/time/start', auth, (req, res) => {
  const { task_id } = req.body;
  db.prepare(`UPDATE time_logs SET stopped_at = datetime('now'), duration_minutes = CAST((julianday('now') - julianday(started_at)) * 1440 AS INTEGER) WHERE user_id = ? AND stopped_at IS NULL`).run(req.user.id);
  const result = db.prepare(`INSERT INTO time_logs (user_id, task_id, started_at) VALUES (?, ?, datetime('now'))`).run(req.user.id, task_id);
  res.json({ id: result.lastInsertRowid, ok: true });
});
 
app.post('/api/time/stop', auth, (req, res) => {
  const { log_id, notes } = req.body;
  const log = db.prepare('SELECT * FROM time_logs WHERE id = ? AND user_id = ?').get(log_id, req.user.id);
  if (!log) return res.status(404).json({ error: 'Not found' });
  db.prepare(`UPDATE time_logs SET stopped_at = datetime('now'), duration_minutes = CAST((julianday('now') - julianday(started_at)) * 1440 AS INTEGER), notes = ? WHERE id = ?`).run(notes || null, log_id);
  const updated = db.prepare('SELECT * FROM time_logs WHERE id = ?').get(log_id);
  res.json({ ok: true, duration_minutes: updated.duration_minutes });
});
 
app.get('/api/time/active', auth, (req, res) => {
  const log = db.prepare(`SELECT tl.*, t.job_name, t.name as task_name FROM time_logs tl JOIN jt_tasks t ON tl.task_id = t.id WHERE tl.user_id = ? AND tl.stopped_at IS NULL`).get(req.user.id);
  res.json(log || null);
});
 
app.get('/api/time/all', auth, adminOnly, (req, res) => {
  res.json(db.prepare(`SELECT tl.*, u.name as user_name, t.job_name, t.name as task_name FROM time_logs tl JOIN users u ON tl.user_id = u.id JOIN jt_tasks t ON tl.task_id = t.id ORDER BY tl.started_at DESC LIMIT 200`).all());
});
 
// ── DASHBOARD ─────────────────────────────────────────
app.get('/api/dashboard', auth, adminOnly, (req, res) => {
  const totalTasks = db.prepare(`SELECT COUNT(*) as n FROM jt_tasks WHERE start_date >= date('now')`).get();
  const assigned = db.prepare('SELECT COUNT(DISTINCT task_id) as n FROM assignments').get();
  const users = db.prepare(`SELECT COUNT(*) as n FROM users WHERE active = 1 AND role = 'employee'`).get();
  const lastSync = db.prepare('SELECT * FROM sync_log ORDER BY synced_at DESC LIMIT 1').get();
  res.json({ totalTasks: totalTasks.n, assigned: assigned.n, unassigned: totalTasks.n - assigned.n, employees: users.n, lastSync });
});
 
// ── ROUTING ───────────────────────────────────────────
app.get('/admin', (req, res) => res.sendFile(path.join(PUBLIC, 'admin.html')));
app.get('/employee', (req, res) => res.sendFile(path.join(PUBLIC, 'employee.html')));
app.get('/', (req, res) => res.sendFile(path.join(PUBLIC, 'index.html')));
app.get('*', (req, res) => res.sendFile(path.join(PUBLIC, 'index.html')));
 
app.listen(PORT, () => {
  console.log(`🚀 Gulv Master kører på port ${PORT}`);
  if (JT_GRANT) setTimeout(() => syncFromJT(), 3000);
});
 
