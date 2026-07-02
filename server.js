const express = require('express');
const Database = require('better-sqlite3');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const cors = require('cors');
const path = require('path');
const cron = require('node-cron');

const app = express();
const PORT = process.env.PORT || 3000;
const JWT_SECRET = process.env.JWT_SECRET || 'gulvmaster2026hemmelig';
const JT_ORG = process.env.JT_ORG_ID || '22PZCGuGrJnQ';
const JT_GRANT = process.env.JT_GRANT_KEY || '';
const JT_API = 'https://api.jobtread.com/pave';

app.use(cors());
app.use(express.json());
app.use(express.static(__dirname));

// ── DATABASE ──────────────────────────────────────────
const db = new Database(path.join(__dirname, 'gulvmaster.db'));

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

const adminExists = db.prepare("SELECT id FROM users WHERE role = 'admin'").get();
if (!adminExists) {
  const hash = bcrypt.hashSync('admin123', 10);
  db.prepare("INSERT OR IGNORE INTO users (name, email, password_hash, role, color, initials) VALUES (?, ?, ?, ?, ?, ?)")
    .run('Martin Breinbjerg', 'martin@gulvmaster.dk', hash, 'admin', '#0F2240', 'MB');
  console.log('Admin oprettet: martin@gulvmaster.dk / admin123');
}

// ── AUTH MIDDLEWARE ───────────────────────────────────
function auth(req, res, next) {
  const header = req.headers.authorization;
  if (!header) return res.status(401).json({ error: 'No token' });
  try {
    req.user = jwt.verify(header.replace('Bearer ', ''), JWT_SECRET);
    next();
  } catch (e) {
    res.status(401).json({ error: 'Invalid token' });
  }
}

function adminOnly(req, res, next) {
  if (req.user.role !== 'admin') return res.status(403).json({ error: 'Admin only' });
  next();
}

// ── AUTH ROUTES ───────────────────────────────────────
app.post('/api/auth/login', function(req, res) {
  var email = req.body.email;
  var password = req.body.password;
  var user = db.prepare('SELECT * FROM users WHERE email = ? AND active = 1').get(email);
  if (!user || !bcrypt.compareSync(password, user.password_hash)) {
    return res.status(401).json({ error: 'Forkert email eller adgangskode' });
  }
  var token = jwt.sign(
    { id: user.id, name: user.name, role: user.role, email: user.email },
    JWT_SECRET,
    { expiresIn: '30d' }
  );
  res.json({
    token: token,
    user: { id: user.id, name: user.name, role: user.role, email: user.email, color: user.color, initials: user.initials }
  });
});

app.get('/api/auth/me', auth, function(req, res) {
  var user = db.prepare('SELECT id, name, email, role, color, initials FROM users WHERE id = ?').get(req.user.id);
  res.json(user);
});

// ── USER ROUTES ───────────────────────────────────────
app.get('/api/users', auth, adminOnly, function(req, res) {
  res.json(db.prepare('SELECT id, name, email, role, color, initials, jobtread_member_id, active FROM users ORDER BY name').all());
});

app.post('/api/users', auth, adminOnly, function(req, res) {
  var name = req.body.name;
  var email = req.body.email;
  var password = req.body.password;
  var role = req.body.role || 'employee';
  var color = req.body.color || '#2563EB';
  var initials = req.body.initials || name.split(' ').map(function(w) { return w[0]; }).join('').substring(0, 2).toUpperCase();
  var jtid = req.body.jobtread_member_id || null;
  if (!name || !email || !password) return res.status(400).json({ error: 'Navn, email og kode er påkrævet' });
  try {
    var hash = bcrypt.hashSync(password, 10);
    var result = db.prepare('INSERT INTO users (name, email, password_hash, role, color, initials, jobtread_member_id) VALUES (?, ?, ?, ?, ?, ?, ?)')
      .run(name, email, hash, role, color, initials, jtid);
    res.json({ id: result.lastInsertRowid, name: name, email: email, role: role, ok: true });
  } catch (e) {
    if (e.message.includes('UNIQUE')) return res.status(400).json({ error: 'Email er allerede i brug' });
    res.status(500).json({ error: e.message });
  }
});

app.put('/api/users/:id', auth, adminOnly, function(req, res) {
  var user = db.prepare('SELECT * FROM users WHERE id = ?').get(req.params.id);
  if (!user) return res.status(404).json({ error: 'Ikke fundet' });
  var newHash = req.body.password ? bcrypt.hashSync(req.body.password, 10) : user.password_hash;
  var active = req.body.active !== undefined ? req.body.active : user.active;
  db.prepare('UPDATE users SET name=?, email=?, password_hash=?, role=?, color=?, initials=?, jobtread_member_id=?, active=? WHERE id=?')
    .run(
      req.body.name || user.name,
      req.body.email || user.email,
      newHash,
      req.body.role || user.role,
      req.body.color || user.color,
      req.body.initials || user.initials,
      req.body.jobtread_member_id || user.jobtread_member_id,
      active,
      req.params.id
    );
  res.json({ ok: true });
});

// ── JOBTREAD SYNC ─────────────────────────────────────
async function jtQuery(query) {
  var key = JT_GRANT;
  if (!key) throw new Error('Ingen Grant Key konfigureret');
  var nodeFetch = await import('node-fetch');
  var fetch = nodeFetch.default;
  var resp = await fetch(JT_API, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ query: Object.assign({ $: { grantKey: key } }, query) })
  });
  if (!resp.ok) throw new Error('HTTP ' + resp.status);
  var data = await resp.json();
  if (data.error) throw new Error(JSON.stringify(data.error));
  return data;
}

function guessType(name) {
  var t = name.toLowerCase();
  if (t.includes('slib') || t.includes('behandling')) return 'sand';
  if (t.includes('mal') || t.includes('lak') || t.includes('maling')) return 'paint';
  if (t.includes('vvs') || t.includes('varme')) return 'sub';
  if (t.includes('læg') || t.includes('parket') || t.includes('afmontering') || t.includes('spånplade') || t.includes('strøer') || t.includes('gulv')) return 'lay';
  return 'other';
}

function wkeyFromDate(dateStr) {
  var d = new Date(dateStr);
  var day = d.getDay() || 7;
  d.setDate(d.getDate() + 4 - day);
  var y = new Date(Date.UTC(d.getFullYear(), 0, 1));
  var wn = Math.ceil((((d - y) / 86400000) + 1) / 7);
  var mon = new Date(dateStr);
  var md = mon.getDay();
  mon.setDate(mon.getDate() - (md || 7) + 1);
  return 'w' + mon.getFullYear() + '-' + String(wn).padStart(2, '0');
}

async function syncFromJT() {
  console.log('Syncing from JobTread...');
  try {
    var from = new Date().toISOString().split('T')[0];
    var toDate = new Date(Date.now() + 84 * 86400000);
    var to = toDate.toISOString().split('T')[0];

    var whereClause = {
      and: [
        ['isToDo', false],
        ['targetType', 'job'],
        ['startDate', '>=', from],
        ['startDate', '<=', to],
        ['isGroup', false]
      ]
    };

    // Call 1: Task names and dates
    var r1 = await jtQuery({
      organization: {
        $: { id: JT_ORG },
        tasks: {
          $: { size: 80, where: whereClause },
          nodes: { id: {}, name: {}, startDate: {}, endDate: {} }
        }
      }
    });
    var tasks = (r1 && r1.query && r1.query.organization && r1.query.organization.tasks && r1.query.organization.tasks.nodes) || [];
    console.log('Tasks found: ' + tasks.length);

    // Call 2: Assignments
    var r2 = await jtQuery({
      organization: {
        $: { id: JT_ORG },
        tasks: {
          $: { size: 80, where: whereClause },
          nodes: {
            id: {},
            taskAssignments: {
              nodes: {
                membership: { user: { name: {} } }
              }
            }
          }
        }
      }
    });
    var assignMap = {};
    var assignNodes = (r2 && r2.query && r2.query.organization && r2.query.organization.tasks && r2.query.organization.tasks.nodes) || [];
    assignNodes.forEach(function(t) {
      var nodes = t.taskAssignments && t.taskAssignments.nodes;
      if (nodes && nodes[0] && nodes[0].membership && nodes[0].membership.user) {
        assignMap[t.id] = nodes[0].membership.user.name;
      }
    });

    // Call 3: Jobs
    var r3 = await jtQuery({
      organization: {
        $: { id: JT_ORG },
        jobs: {
          $: { size: 50 },
          nodes: { id: {}, name: {}, location: { address: {}, name: {} } }
        }
      }
    });
    var jobMap = {};
    var jobNodes = (r3 && r3.query && r3.query.organization && r3.query.organization.jobs && r3.query.organization.jobs.nodes) || [];
    jobNodes.forEach(function(j) {
      jobMap[j.id] = {
        name: j.name,
        address: (j.location && (j.location.address || j.location.name)) || ''
      };
    });

    // Call 4: Task to job links
    var r4 = await jtQuery({
      organization: {
        $: { id: JT_ORG },
        tasks: {
          $: { size: 80, where: whereClause },
          nodes: { id: {}, targetId: {} }
        }
      }
    });
    var taskJobMap = {};
    var linkNodes = (r4 && r4.query && r4.query.organization && r4.query.organization.tasks && r4.query.organization.tasks.nodes) || [];
    linkNodes.forEach(function(t) {
      taskJobMap[t.id] = t.targetId;
    });

    // Upsert all tasks
    var upsert = db.prepare(
      "INSERT OR REPLACE INTO jt_tasks (id, name, job_id, job_name, job_address, start_date, end_date, type_guess, raw_assignee_name, jt_url, synced_at) " +
      "VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, datetime('now'))"
    );
    var upsertAll = db.transaction(function(taskList) {
      taskList.forEach(function(t) {
        var jid = taskJobMap[t.id];
        var ji = jobMap[jid] || {};
        var customer = (ji.name || '').replace(/\s*[-\u2013]\s*(gulvl[aæ]gning|gulvslib|maler.*|slibning|service|renovering|t[oø]mrer).*/i, '').trim();
        upsert.run(
          t.id, t.name, jid || null,
          customer || ji.name || '',
          ji.address || '',
          t.startDate, t.endDate || t.startDate,
          guessType(t.name),
          assignMap[t.id] || null,
          'https://app.jobtread.com/jobs/' + jid
        );
      });
    });
    upsertAll(tasks);

    db.prepare("INSERT INTO sync_log (tasks_imported, status, message) VALUES (?, ?, ?)").run(tasks.length, 'ok', tasks.length + ' tasks synced');
    console.log('Synced ' + tasks.length + ' tasks');
    return { ok: true, count: tasks.length };
  } catch (e) {
    console.error('Sync error: ' + e.message);
    db.prepare("INSERT INTO sync_log (tasks_imported, status, message) VALUES (?, ?, ?)").run(0, 'error', e.message);
    return { ok: false, error: e.message };
  }
}

app.post('/api/sync', auth, adminOnly, function(req, res) {
  syncFromJT().then(function(result) { res.json(result); });
});

app.get('/api/sync/log', auth, adminOnly, function(req, res) {
  res.json(db.prepare('SELECT * FROM sync_log ORDER BY synced_at DESC LIMIT 20').all());
});

cron.schedule('0 * * * *', function() { syncFromJT(); });

// ── TASK ROUTES ───────────────────────────────────────
app.get('/api/tasks', auth, function(req, res) {
  res.json(db.prepare('SELECT * FROM jt_tasks ORDER BY start_date ASC').all());
});

// ── ASSIGNMENT ROUTES ─────────────────────────────────
app.get('/api/assignments', auth, function(req, res) {
  var q = 'SELECT a.*, u.name as user_name, u.color as user_color, u.initials as user_initials, ' +
    't.name as task_name, t.job_name, t.job_address, t.start_date, t.end_date, t.type_guess, t.jt_url, t.job_id ' +
    'FROM assignments a JOIN users u ON a.user_id = u.id JOIN jt_tasks t ON a.task_id = t.id';
  var params = [];
  if (req.user.role !== 'admin') {
    q += ' WHERE a.user_id = ?';
    params.push(req.user.id);
  }
  q += ' ORDER BY t.start_date ASC';
  res.json(db.prepare(q).all(params));
});

app.get('/api/assignments/my', auth, function(req, res) {
  var rows = db.prepare(
    'SELECT a.*, t.name as task_name, t.job_name, t.job_address, t.start_date, t.end_date, t.type_guess, t.jt_url, t.job_id ' +
    'FROM assignments a JOIN jt_tasks t ON a.task_id = t.id WHERE a.user_id = ? ORDER BY t.start_date ASC'
  ).all(req.user.id);
  res.json(rows);
});

app.post('/api/assignments', auth, adminOnly, function(req, res) {
  var task_id = req.body.task_id;
  var user_id = req.body.user_id;
  var week_key = req.body.week_key;
  var days = req.body.days || 1;
  var notes = req.body.notes || null;
  try {
    var result = db.prepare('INSERT OR REPLACE INTO assignments (task_id, user_id, week_key, days, notes) VALUES (?, ?, ?, ?, ?)')
      .run(task_id, user_id, week_key, days, notes);
    res.json({ id: result.lastInsertRowid, ok: true });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.put('/api/assignments/:id', auth, adminOnly, function(req, res) {
  db.prepare('UPDATE assignments SET user_id=?, week_key=?, days=?, notes=? WHERE id=?')
    .run(req.body.user_id, req.body.week_key, req.body.days, req.body.notes || null, req.params.id);
  res.json({ ok: true });
});

app.delete('/api/assignments/:id', auth, adminOnly, function(req, res) {
  db.prepare('DELETE FROM assignments WHERE id = ?').run(req.params.id);
  res.json({ ok: true });
});

// ── TIME TRACKING ─────────────────────────────────────
app.post('/api/time/start', auth, function(req, res) {
  var task_id = req.body.task_id;
  db.prepare("UPDATE time_logs SET stopped_at = datetime('now'), duration_minutes = CAST((julianday('now') - julianday(started_at)) * 1440 AS INTEGER) WHERE user_id = ? AND stopped_at IS NULL")
    .run(req.user.id);
  var result = db.prepare("INSERT INTO time_logs (user_id, task_id, started_at) VALUES (?, ?, datetime('now'))")
    .run(req.user.id, task_id);
  res.json({ id: result.lastInsertRowid, ok: true });
});

app.post('/api/time/stop', auth, function(req, res) {
  var log_id = req.body.log_id;
  var notes = req.body.notes || null;
  var log = db.prepare('SELECT * FROM time_logs WHERE id = ? AND user_id = ?').get(log_id, req.user.id);
  if (!log) return res.status(404).json({ error: 'Not found' });
  db.prepare("UPDATE time_logs SET stopped_at = datetime('now'), duration_minutes = CAST((julianday('now') - julianday(started_at)) * 1440 AS INTEGER), notes = ? WHERE id = ?")
    .run(notes, log_id);
  var updated = db.prepare('SELECT * FROM time_logs WHERE id = ?').get(log_id);
  res.json({ ok: true, duration_minutes: updated.duration_minutes });
});

app.get('/api/time/active', auth, function(req, res) {
  var log = db.prepare(
    'SELECT tl.*, t.job_name, t.name as task_name FROM time_logs tl ' +
    'JOIN jt_tasks t ON tl.task_id = t.id WHERE tl.user_id = ? AND tl.stopped_at IS NULL'
  ).get(req.user.id);
  res.json(log || null);
});

app.get('/api/time/all', auth, adminOnly, function(req, res) {
  res.json(db.prepare(
    'SELECT tl.*, u.name as user_name, t.job_name, t.name as task_name ' +
    'FROM time_logs tl JOIN users u ON tl.user_id = u.id JOIN jt_tasks t ON tl.task_id = t.id ' +
    'ORDER BY tl.started_at DESC LIMIT 200'
  ).all());
});

// ── DASHBOARD ─────────────────────────────────────────
app.get('/api/dashboard', auth, adminOnly, function(req, res) {
  var today = new Date().toISOString().split('T')[0];
  var totalTasks = db.prepare('SELECT COUNT(*) as n FROM jt_tasks WHERE start_date >= ?').get(today);
  var assigned = db.prepare('SELECT COUNT(DISTINCT task_id) as n FROM assignments').get();
  var users = db.prepare("SELECT COUNT(*) as n FROM users WHERE active = 1 AND role = 'employee'").get();
  var lastSync = db.prepare('SELECT * FROM sync_log ORDER BY synced_at DESC LIMIT 1').get();
  res.json({
    totalTasks: totalTasks.n,
    assigned: assigned.n,
    unassigned: totalTasks.n - assigned.n,
    employees: users.n,
    lastSync: lastSync
  });
});

// ── PAGE ROUTING ──────────────────────────────────────
app.get('/admin', function(req, res) {
  res.sendFile(path.join(__dirname, 'admin.html'));
});
app.get('/employee', function(req, res) {
  res.sendFile(path.join(__dirname, 'employee.html'));
});
app.get('*', function(req, res) {
  res.sendFile(path.join(__dirname, 'index.html'));
});

// ── START ─────────────────────────────────────────────
app.listen(PORT, function() {
  console.log('Gulv Master korer pa port ' + PORT);
  if (JT_GRANT) {
    setTimeout(function() { syncFromJT(); }, 3000);
  }
});
 
