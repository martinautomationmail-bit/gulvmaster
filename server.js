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
    created_at TEXT DEFAULT (datetime('now'))
  );
  CREATE TABLE IF NOT EXISTS sync_log (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    synced_at TEXT DEFAULT (datetime('now')),
    tasks_imported INTEGER DEFAULT 0,
    status TEXT,
    message TEXT
  );
`);

// Seed default users
const adminExists = db.prepare("SELECT id FROM users WHERE role='admin'").get();
if (!adminExists) {
  const hash = bcrypt.hashSync('admin123', 10);
  db.prepare("INSERT OR IGNORE INTO users (name,email,password_hash,role,color,initials) VALUES (?,?,?,?,?,?)")
    .run('Martin Breinbjerg','martin@gulvmaster.dk',hash,'admin','#0F2240','MB');
  // Pre-seed employees from JobTread
  const employees = [
    ['Ahmed Chaib Elharouzi','ahmed@gulvmaster.dk','ahmed123','employee','#2563EB','AC'],
    ['Adrian Sobon','adrian@gulvmaster.dk','adrian123','employee','#16A34A','AS'],
    ['Kacper Michalski','kacper@gulvmaster.dk','kacper123','employee','#7C3AED','KM'],
    ['Rafal Prus','rafal@gulvmaster.dk','rafal123','employee','#EA580C','RP'],
    ['Martin Rinik','mrinik@gulvmaster.dk','martin123','employee','#0891B2','MR'],
    ['Sarah K','sarah@gulvmaster.dk','sarah123','employee','#DB2777','SK'],
    ['Laerke Raschat','laerke@gulvmaster.dk','laerke123','employee','#65A30D','LR'],
  ];
  employees.forEach(function(e) {
    var h = bcrypt.hashSync(e[2], 10);
    db.prepare("INSERT OR IGNORE INTO users (name,email,password_hash,role,color,initials) VALUES (?,?,?,?,?,?)")
      .run(e[0],e[1],h,e[3],e[4],e[5]);
  });
  console.log('Default users created');
}

// ── AUTH ──────────────────────────────────────────────
function auth(req, res, next) {
  var h = req.headers.authorization;
  if (!h) return res.status(401).json({error:'No token'});
  try { req.user = jwt.verify(h.replace('Bearer ',''), JWT_SECRET); next(); }
  catch(e) { res.status(401).json({error:'Invalid token'}); }
}
function adminOnly(req, res, next) {
  if (req.user.role !== 'admin') return res.status(403).json({error:'Admin only'});
  next();
}

app.post('/api/auth/login', function(req, res) {
  var user = db.prepare('SELECT * FROM users WHERE email=? AND active=1').get(req.body.email);
  if (!user || !bcrypt.compareSync(req.body.password, user.password_hash))
    return res.status(401).json({error:'Forkert email eller adgangskode'});
  var token = jwt.sign({id:user.id,name:user.name,role:user.role,email:user.email}, JWT_SECRET, {expiresIn:'30d'});
  res.json({token:token, user:{id:user.id,name:user.name,role:user.role,email:user.email,color:user.color,initials:user.initials}});
});

app.get('/api/auth/me', auth, function(req, res) {
  res.json(db.prepare('SELECT id,name,email,role,color,initials FROM users WHERE id=?').get(req.user.id));
});

// ── USERS ─────────────────────────────────────────────
app.get('/api/users', auth, adminOnly, function(req, res) {
  res.json(db.prepare('SELECT id,name,email,role,color,initials,jobtread_member_id,active FROM users ORDER BY role DESC,name').all());
});

app.post('/api/users', auth, adminOnly, function(req, res) {
  var b = req.body;
  if (!b.name||!b.email||!b.password) return res.status(400).json({error:'Navn, email og kode påkrævet'});
  try {
    var ini = b.initials || b.name.split(' ').map(function(w){return w[0];}).join('').substring(0,2).toUpperCase();
    var r = db.prepare('INSERT INTO users (name,email,password_hash,role,color,initials,jobtread_member_id) VALUES (?,?,?,?,?,?,?)')
      .run(b.name, b.email, bcrypt.hashSync(b.password,10), b.role||'employee', b.color||'#2563EB', ini, b.jobtread_member_id||null);
    res.json({id:r.lastInsertRowid,ok:true});
  } catch(e) {
    if (e.message.includes('UNIQUE')) return res.status(400).json({error:'Email allerede i brug'});
    res.status(500).json({error:e.message});
  }
});

app.put('/api/users/:id', auth, adminOnly, function(req, res) {
  var u = db.prepare('SELECT * FROM users WHERE id=?').get(req.params.id);
  if (!u) return res.status(404).json({error:'Ikke fundet'});
  var b = req.body;
  db.prepare('UPDATE users SET name=?,email=?,password_hash=?,role=?,color=?,initials=?,jobtread_member_id=?,active=? WHERE id=?')
    .run(b.name||u.name, b.email||u.email, b.password?bcrypt.hashSync(b.password,10):u.password_hash,
      b.role||u.role, b.color||u.color, b.initials||u.initials, b.jobtread_member_id||u.jobtread_member_id,
      b.active!==undefined?b.active:u.active, req.params.id);
  res.json({ok:true});
});

// ── JOBTREAD SYNC — sequential calls to avoid 413 ────
async function jtFetch(body) {
  var nodeFetch = await import('node-fetch');
  var fetch = nodeFetch.default;
  var resp = await fetch(JT_API, {
    method: 'POST',
    headers: {'Content-Type':'application/json'},
    body: JSON.stringify(body)
  });
  if (!resp.ok) throw new Error('HTTP ' + resp.status);
  var data = await resp.json();
  if (data.error) throw new Error(JSON.stringify(data.error));
  return data;
}

function guessType(name) {
  var t = (name||'').toLowerCase();
  if (t.includes('slib')||t.includes('behandling')) return 'sand';
  if (t.includes('mal')||t.includes('lak')||t.includes('maling')) return 'paint';
  if (t.includes('vvs')||t.includes('varme')) return 'sub';
  if (t.includes('gulv')||t.includes('parket')||t.includes('afmontering')||t.includes('spaan')||t.includes('stroer')||t.includes('laeg')) return 'lay';
  return 'other';
}

async function syncFromJT() {
  console.log('=== Starting JT sync ===');
  var key = JT_GRANT;
  if (!key) {
    console.log('No grant key — skipping sync');
    db.prepare("INSERT INTO sync_log (tasks_imported,status,message) VALUES (?,?,?)").run(0,'error','Ingen Grant Key konfigureret i Environment Variables');
    return {ok:false, error:'Ingen Grant Key'};
  }

  try {
    var from = new Date().toISOString().split('T')[0];
    var toD = new Date(Date.now() + 84*86400000);
    var to = toD.toISOString().split('T')[0];
    console.log('Date range: ' + from + ' to ' + to);

    var where = {and:[['isToDo',false],['targetType','job'],['startDate','>=',from],['startDate','<=',to],['isGroup',false]]};
    var taskFields = {$:{size:60, where:where}};

    // Step 1: task dates + names (small query)
    console.log('Step 1: fetching task dates...');
    var d1 = await jtFetch({query:{$:{grantKey:key}, organization:{$:{id:JT_ORG},
      tasks:Object.assign({},taskFields,{nodes:{id:{},name:{},startDate:{},endDate:{}}})}}});
    var tasks = (d1&&d1.query&&d1.query.organization&&d1.query.organization.tasks&&d1.query.organization.tasks.nodes)||[];
    console.log('Step 1 done: ' + tasks.length + ' tasks');

    // Step 2: task→job links (separate small query)
    console.log('Step 2: fetching task-job links...');
    var d2 = await jtFetch({query:{$:{grantKey:key}, organization:{$:{id:JT_ORG},
      tasks:Object.assign({},taskFields,{nodes:{id:{},targetId:{}}})}}});
    var taskJobMap = {};
    var d2nodes = (d2&&d2.query&&d2.query.organization&&d2.query.organization.tasks&&d2.query.organization.tasks.nodes)||[];
    d2nodes.forEach(function(t){ taskJobMap[t.id]=t.targetId; });
    console.log('Step 2 done');

    // Step 3: assignments (separate small query)
    console.log('Step 3: fetching assignments...');
    var d3 = await jtFetch({query:{$:{grantKey:key}, organization:{$:{id:JT_ORG},
      tasks:Object.assign({},taskFields,{nodes:{id:{},taskAssignments:{nodes:{membership:{user:{name:{}}}}}}})}}});
    var assignMap = {};
    var d3nodes = (d3&&d3.query&&d3.query.organization&&d3.query.organization.tasks&&d3.query.organization.tasks.nodes)||[];
    d3nodes.forEach(function(t){
      if (t.taskAssignments&&t.taskAssignments.nodes&&t.taskAssignments.nodes[0]) {
        var u = t.taskAssignments.nodes[0].membership&&t.taskAssignments.nodes[0].membership.user;
        if (u) assignMap[t.id] = u.name;
      }
    });
    console.log('Step 3 done: ' + Object.keys(assignMap).length + ' assignments');

    // Step 4: job names + addresses
    console.log('Step 4: fetching job names...');
    var d4 = await jtFetch({query:{$:{grantKey:key}, organization:{$:{id:JT_ORG},
      jobs:{$:{size:50}, nodes:{id:{},name:{},location:{address:{},name:{}}}}}}});
    var jobMap = {};
    var d4nodes = (d4&&d4.query&&d4.query.organization&&d4.query.organization.jobs&&d4.query.organization.jobs.nodes)||[];
    d4nodes.forEach(function(j){
      jobMap[j.id]={name:j.name, address:(j.location&&(j.location.address||j.location.name))||''};
    });
    console.log('Step 4 done: ' + d4nodes.length + ' jobs');

    // Upsert into DB
    var upsert = db.prepare(
      "INSERT OR REPLACE INTO jt_tasks (id,name,job_id,job_name,job_address,start_date,end_date,type_guess,raw_assignee_name,jt_url,synced_at) "+
      "VALUES (?,?,?,?,?,?,?,?,?,?,datetime('now'))"
    );
    var doAll = db.transaction(function(list) {
      list.forEach(function(t) {
        var jid = taskJobMap[t.id];
        var ji = jobMap[jid]||{};
        var customer = (ji.name||'').replace(/\s*[-\u2013]\s*(gulvl.gning|gulvslib|maler.*|slibning|service|renovering|t.mrer).*/i,'').trim();
        upsert.run(
          t.id, t.name, jid||null,
          customer||ji.name||'',
          ji.address||'',
          t.startDate, t.endDate||t.startDate,
          guessType(t.name),
          assignMap[t.id]||null,
          'https://app.jobtread.com/jobs/'+(jid||'')
        );
      });
    });
    doAll(tasks);

    db.prepare("INSERT INTO sync_log (tasks_imported,status,message) VALUES (?,?,?)").run(tasks.length,'ok',tasks.length+' tasks synced OK');
    console.log('=== Sync complete: ' + tasks.length + ' tasks ===');
    return {ok:true, count:tasks.length};

  } catch(e) {
    console.error('Sync error: '+e.message);
    db.prepare("INSERT INTO sync_log (tasks_imported,status,message) VALUES (?,?,?)").run(0,'error',e.message);
    return {ok:false, error:e.message};
  }
}

app.post('/api/sync', auth, adminOnly, function(req, res) {
  syncFromJT().then(function(r){ res.json(r); }).catch(function(e){ res.status(500).json({error:e.message}); });
});

app.get('/api/sync/log', auth, adminOnly, function(req, res) {
  res.json(db.prepare('SELECT * FROM sync_log ORDER BY synced_at DESC LIMIT 20').all());
});

// Auto-sync every hour
cron.schedule('0 * * * *', function(){ syncFromJT(); });

// ── TASKS ─────────────────────────────────────────────
app.get('/api/tasks', auth, function(req, res) {
  res.json(db.prepare('SELECT * FROM jt_tasks ORDER BY start_date ASC').all());
});

// ── ASSIGNMENTS ───────────────────────────────────────
app.get('/api/assignments', auth, function(req, res) {
  var q = 'SELECT a.*, u.name as user_name, u.color as user_color, u.initials as user_initials, '+
    't.name as task_name, t.job_name, t.job_address, t.start_date, t.end_date, t.type_guess, t.jt_url, t.job_id '+
    'FROM assignments a JOIN users u ON a.user_id=u.id JOIN jt_tasks t ON a.task_id=t.id';
  if (req.user.role !== 'admin') q += ' WHERE a.user_id='+req.user.id;
  q += ' ORDER BY t.start_date ASC';
  res.json(db.prepare(q).all());
});

app.get('/api/assignments/my', auth, function(req, res) {
  res.json(db.prepare(
    'SELECT a.*, t.name as task_name, t.job_name, t.job_address, t.start_date, t.end_date, t.type_guess, t.jt_url, t.job_id '+
    'FROM assignments a JOIN jt_tasks t ON a.task_id=t.id WHERE a.user_id=? ORDER BY t.start_date ASC'
  ).all(req.user.id));
});

app.post('/api/assignments', auth, adminOnly, function(req, res) {
  try {
    var r = db.prepare('INSERT OR REPLACE INTO assignments (task_id,user_id,week_key,days,notes) VALUES (?,?,?,?,?)')
      .run(req.body.task_id, req.body.user_id, req.body.week_key, req.body.days||1, req.body.notes||null);
    res.json({id:r.lastInsertRowid,ok:true});
  } catch(e){ res.status(500).json({error:e.message}); }
});

app.put('/api/assignments/:id', auth, adminOnly, function(req, res) {
  db.prepare('UPDATE assignments SET user_id=?,week_key=?,days=?,notes=? WHERE id=?')
    .run(req.body.user_id, req.body.week_key, req.body.days, req.body.notes||null, req.params.id);
  res.json({ok:true});
});

app.delete('/api/assignments/:id', auth, adminOnly, function(req, res) {
  db.prepare('DELETE FROM assignments WHERE id=?').run(req.params.id);
  res.json({ok:true});
});

// ── TIME TRACKING ─────────────────────────────────────
app.post('/api/time/start', auth, function(req, res) {
  db.prepare("UPDATE time_logs SET stopped_at=datetime('now'), duration_minutes=CAST((julianday('now')-julianday(started_at))*1440 AS INTEGER) WHERE user_id=? AND stopped_at IS NULL")
    .run(req.user.id);
  var r = db.prepare("INSERT INTO time_logs (user_id,task_id,started_at) VALUES (?,?,datetime('now'))").run(req.user.id,req.body.task_id);
  res.json({id:r.lastInsertRowid,ok:true});
});

app.post('/api/time/stop', auth, function(req, res) {
  var log = db.prepare('SELECT * FROM time_logs WHERE id=? AND user_id=?').get(req.body.log_id,req.user.id);
  if (!log) return res.status(404).json({error:'Not found'});
  db.prepare("UPDATE time_logs SET stopped_at=datetime('now'), duration_minutes=CAST((julianday('now')-julianday(started_at))*1440 AS INTEGER), notes=? WHERE id=?")
    .run(req.body.notes||null, req.body.log_id);
  var u = db.prepare('SELECT * FROM time_logs WHERE id=?').get(req.body.log_id);
  res.json({ok:true,duration_minutes:u.duration_minutes});
});

app.get('/api/time/active', auth, function(req, res) {
  res.json(db.prepare('SELECT tl.*, t.job_name, t.name as task_name FROM time_logs tl JOIN jt_tasks t ON tl.task_id=t.id WHERE tl.user_id=? AND tl.stopped_at IS NULL').get(req.user.id)||null);
});

app.get('/api/time/all', auth, adminOnly, function(req, res) {
  res.json(db.prepare('SELECT tl.*, u.name as user_name, t.job_name, t.name as task_name FROM time_logs tl JOIN users u ON tl.user_id=u.id JOIN jt_tasks t ON tl.task_id=t.id ORDER BY tl.started_at DESC LIMIT 200').all());
});

// ── DASHBOARD ─────────────────────────────────────────
app.get('/api/dashboard', auth, adminOnly, function(req, res) {
  var today = new Date().toISOString().split('T')[0];
  var total = db.prepare('SELECT COUNT(*) as n FROM jt_tasks WHERE start_date>=?').get(today);
  var assigned = db.prepare('SELECT COUNT(DISTINCT task_id) as n FROM assignments').get();
  var emps = db.prepare("SELECT COUNT(*) as n FROM users WHERE active=1 AND role='employee'").get();
  var lastSync = db.prepare('SELECT * FROM sync_log ORDER BY synced_at DESC LIMIT 1').get();
  res.json({totalTasks:total.n, assigned:assigned.n, unassigned:total.n-assigned.n, employees:emps.n, lastSync:lastSync});
});

// ── ROUTING ───────────────────────────────────────────
app.get('/admin', function(req,res){ res.sendFile(path.join(__dirname,'admin.html')); });
app.get('/employee', function(req,res){ res.sendFile(path.join(__dirname,'employee.html')); });
app.get('*', function(req,res){ res.sendFile(path.join(__dirname,'index.html')); });

app.listen(PORT, function() {
  console.log('Gulv Master korer pa port ' + PORT);
  if (JT_GRANT) {
    setTimeout(function(){ syncFromJT(); }, 5000);
  } else {
    console.log('ADVARSEL: JT_GRANT_KEY er ikke sat i Environment Variables!');
  }
});
 
