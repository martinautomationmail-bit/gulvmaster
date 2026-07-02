const express = require('express');
const Database = require('better-sqlite3');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const cors = require('cors');
const path = require('path');
const cron = require('node-cron');
const crypto = require('crypto');

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
    jobtread_name TEXT,
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
    start_time TEXT,
    start_date TEXT,
    end_date TEXT,
    created_at TEXT DEFAULT (datetime('now')),
    UNIQUE(task_id, user_id, week_key)
  );
  -- Legacy assignments stays untouched for backwards compatibility.
  -- All new manual planning lives in planning_bookings.
  CREATE TABLE IF NOT EXISTS planning_bookings (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    task_id TEXT NOT NULL,
    user_id INTEGER NOT NULL,
    week_key TEXT NOT NULL,
    days REAL DEFAULT 1,
    notes TEXT,
    start_time TEXT,
    start_date TEXT NOT NULL,
    end_date TEXT NOT NULL,
    created_at TEXT DEFAULT (datetime('now')),
    updated_at TEXT DEFAULT (datetime('now'))
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

// ── SAFE SCHEMA MIGRATIONS ─────────────────────────────
// Existing data is preserved. JobTread data is only copied into the task pool;
// it never creates or overwrites a manual plan.
function hasColumn(table, column) {
  return db.prepare('PRAGMA table_info(' + table + ')').all().some(function(c){ return c.name === column; });
}
function addColumn(table, column, definition) {
  if (!hasColumn(table, column)) db.exec('ALTER TABLE ' + table + ' ADD COLUMN ' + column + ' ' + definition);
}
addColumn('users', 'worker_type', "TEXT DEFAULT 'employee'"); // employee | vendor
addColumn('users', 'vendor_group', 'TEXT');
addColumn('users', 'trade', 'TEXT');
addColumn('users', 'weekly_capacity', 'REAL DEFAULT 5');
addColumn('users', 'can_login', 'INTEGER DEFAULT 1');
addColumn('jt_tasks', 'source', "TEXT DEFAULT 'jobtread'"); // jobtread | manual
addColumn('jt_tasks', 'created_at', 'TEXT');
addColumn('assignments', 'updated_at', 'TEXT');
db.exec("CREATE INDEX IF NOT EXISTS idx_assignments_user_start ON assignments(user_id, start_date)");
db.exec("CREATE INDEX IF NOT EXISTS idx_assignments_task ON assignments(task_id)");
db.exec("CREATE INDEX IF NOT EXISTS idx_planning_bookings_user_start ON planning_bookings(user_id, start_date)");
db.exec("CREATE INDEX IF NOT EXISTS idx_planning_bookings_task ON planning_bookings(task_id)");
db.exec("CREATE INDEX IF NOT EXISTS idx_tasks_source_start ON jt_tasks(source, start_date)");

// ── SEED USERS ────────────────────────────────────────
var defaultUsers = [
  {name:'Martin Breinbjerg',    email:'martin@gulvmaster.dk', pw:'admin123',   role:'admin',     color:'#0F2240', ini:'MB', jtname:'Martin Breinbjerg'},
  {name:'Ahmed Chaib Elharouzi',email:'ahmed@gulvmaster.dk',  pw:'ahmed123',   role:'employee',  color:'#2563EB', ini:'AC', jtname:'Ahmed Chaib Elharouzi'},
  {name:'Adrian Sobon',         email:'adrian@gulvmaster.dk', pw:'adrian123',  role:'employee',  color:'#16A34A', ini:'AS', jtname:'Adrian Sobon'},
  {name:'Kacper Michalski',     email:'kacper@gulvmaster.dk', pw:'kacper123',  role:'employee',  color:'#7C3AED', ini:'KM', jtname:'Kacper Pawel Michalski'},
  {name:'Rafal Prus',           email:'rafal@gulvmaster.dk',  pw:'rafal123',   role:'employee',  color:'#EA580C', ini:'RP', jtname:'Rafal Prus'},
  {name:'Martin Rinik',         email:'mrinik@gulvmaster.dk', pw:'martin123',  role:'employee',  color:'#0891B2', ini:'MR', jtname:'Martin Rinik'},
  {name:'Sarah K',              email:'sarah@gulvmaster.dk',  pw:'sarah123',   role:'employee',  color:'#DB2777', ini:'SK', jtname:'Sarah K'},
  {name:'Laerke Raschat',       email:'laerke@gulvmaster.dk', pw:'laerke123',  role:'employee',  color:'#65A30D', ini:'LR', jtname:'Laerke Raschat'},
  {name:'AJB Gruppen APS',      email:'ajb@gulvmaster.dk',    pw:'ajb123',     role:'employee',  color:'#DC2626', ini:'AG', jtname:'AJB GRUPPEN APS'},
  {name:'Novo-Gulvservice ApS', email:'novo@gulvmaster.dk',   pw:'novo123',    role:'employee',  color:'#9333EA', ini:'NG', jtname:'Novo-Gulvservice Aps'},
  {name:'Mohammed (Ahmed)',      email:'mohammed@gulvmaster.dk',pw:'mo123',     role:'employee',  color:'#92400E', ini:'MA', jtname:'Mohammed ( Ahmed'},
];
defaultUsers.forEach(function(u) {
  var exists = db.prepare('SELECT id FROM users WHERE email=?').get(u.email);
  if (!exists) {
    db.prepare('INSERT INTO users (name,email,password_hash,role,color,initials,jobtread_name) VALUES (?,?,?,?,?,?,?)')
      .run(u.name, u.email, bcrypt.hashSync(u.pw,10), u.role, u.color, u.ini, u.jtname);
  }
});
console.log('Users ready');

// Workforce metadata used by the capacity board.
db.prepare("UPDATE users SET worker_type='employee', weekly_capacity=COALESCE(NULLIF(weekly_capacity,0),5) WHERE worker_type IS NULL OR worker_type=''").run();
db.prepare("UPDATE users SET worker_type='vendor', vendor_group='AJB Gruppen APS', trade='Gulvlægning', weekly_capacity=5 WHERE email='ajb@gulvmaster.dk'").run();
db.prepare("UPDATE users SET worker_type='vendor', vendor_group='Novo-Gulvservice ApS', trade='Gulvslibning', weekly_capacity=5 WHERE email='novo@gulvmaster.dk'").run();


// ── SEED TASKS FROM JOBTREAD (fetched 2026-07-02) ─────
var seedTasks = [
  {id:'22PZhrywxeiv',name:'Slibning og behandling',job_id:'22PZhSyGmL3U',job_name:'Kasper Høybye',job_address:'Asminderødgade 19 Nørrebro',start_date:'2026-07-13',end_date:'2026-07-15',type_guess:'sand',raw_assignee_name:'Adrian Sobon'},
  {id:'22PZsV988nDs',name:'Gulvslibning',job_id:'22PZsUbJq3RY',job_name:'Emma Hallsenius',job_address:'Vedbendvej 11, hellerup',start_date:'2026-07-06',end_date:'2026-07-08',type_guess:'sand',raw_assignee_name:null},
  {id:'22Pa2BWcpzHy',name:'2-3 x maling af vægge',job_id:'22Pa29X6Kvjh',job_name:'Mikael Tümmler',job_address:'4262',start_date:'2026-07-02',end_date:'2026-07-05',type_guess:'paint',raw_assignee_name:'Rafal Prus'},
  {id:'22Pa2BWcqNCH',name:'2-3 x maling af lofter',job_id:'22Pa29X6Kvjh',job_name:'Mikael Tümmler',job_address:'4262',start_date:'2026-07-06',end_date:'2026-07-08',type_guess:'paint',raw_assignee_name:'Rafal Prus'},
  {id:'22Pa2BWcqNCJ',name:'Let slib & 2-3 maling af fodpaneler',job_id:'22Pa29X6Kvjh',job_name:'Mikael Tümmler',job_address:'4262',start_date:'2026-07-09',end_date:'2026-07-10',type_guess:'paint',raw_assignee_name:'Rafal Prus'},
  {id:'22Pa2BWcqNCK',name:'Let slib & 2-3 maling af gerigter',job_id:'22Pa29X6Kvjh',job_name:'Mikael Tümmler',job_address:'4262',start_date:'2026-07-11',end_date:'2026-07-13',type_guess:'paint',raw_assignee_name:'Rafal Prus'},
  {id:'22Pa2BWcqNCL',name:'Let slib & 2-3 maling af døre',job_id:'22Pa29X6Kvjh',job_name:'Mikael Tümmler',job_address:'4262',start_date:'2026-07-14',end_date:'2026-07-14',type_guess:'paint',raw_assignee_name:'Rafal Prus'},
  {id:'22Pa56SC3G5D',name:'Slibning af trappetrin',job_id:'22Pa56C5qCh9',job_name:'Lejlighedsrenovering Nynnevej',job_address:'Sølvgade 102, 1307 København',start_date:'2026-07-24',end_date:'2026-07-25',type_guess:'sand',raw_assignee_name:'Adrian Sobon'},
  {id:'22Pa7JR635Xp',name:'Slibning x oliering (Første sal)',job_id:'22Pa7JMyYntv',job_name:'Heidi Moon',job_address:'Hattensens Alle 21, 2000 Frederiksberg',start_date:'2026-07-20',end_date:'2026-07-22',type_guess:'sand',raw_assignee_name:'Adrian Sobon'},
  {id:'22Pa7Jfq2xkf',name:'Gulvslibning x3 Matlak',job_id:'22Pa7JdC64d7',job_name:'Richard Bonner',job_address:'Borups alle 132, 4.1',start_date:'2026-07-06',end_date:'2026-07-09',type_guess:'sand',raw_assignee_name:'Adrian Sobon'},
  {id:'22Pa7K6zSphZ',name:'Gulvslibning x3matlak',job_id:'22Pa7K56LXub',job_name:'Mathilde E',job_address:'Hundshøjvej 20, 3660 Stenløse',start_date:'2026-07-10',end_date:'2026-07-13',type_guess:'sand',raw_assignee_name:'Adrian Sobon'},
  {id:'22Pa7KRpu5cv',name:'Susanne Ring - Gulvslibning',job_id:'22Pa7KPFFBSc',job_name:'Susan Ring',job_address:'Ukendt',start_date:'2026-07-10',end_date:'2026-07-13',type_guess:'sand',raw_assignee_name:'Adrian Sobon'},
  {id:'22Pa7KwGPmzM',name:'Jesper - Gulvslibning',job_id:'22Pa7KcHJ9Q2',job_name:'Jesper Marcussen',job_address:'Holtegade 12, 5',start_date:'2026-07-08',end_date:'2026-07-10',type_guess:'sand',raw_assignee_name:'Novo-Gulvservice Aps'},
  {id:'22Pa7LK6wFW4',name:'Karin winther - Gulvslibning',job_id:'22Pa7LGavCgQ',job_name:'Karin Winther',job_address:'Borups alle 6, 2200 kbh n',start_date:'2026-07-13',end_date:'2026-07-14',type_guess:'sand',raw_assignee_name:'Adrian Sobon'},
  {id:'22Pa7M9XxBgK',name:'Peter Thorn - Gulvslib',job_id:'22Pa7M7pbc4F',job_name:'Peter Thorn',job_address:'2680',start_date:'2026-07-16',end_date:'2026-07-20',type_guess:'sand',raw_assignee_name:'Adrian Sobon'},
  {id:'22Pa7SFws6CR',name:'Afmontering',job_id:'22Pa7QvHbzfT',job_name:'Per Bo Austin',job_address:'Lundemarken 13, 4000 Roskilde',start_date:'2026-07-01',end_date:'2026-07-02',type_guess:'lay',raw_assignee_name:null},
  {id:'22Pa7SFws6CT',name:'Opretning af strøer',job_id:'22Pa7QvHbzfT',job_name:'Per Bo Austin',job_address:'Lundemarken 13, 4000 Roskilde',start_date:'2026-07-02',end_date:'2026-07-03',type_guess:'lay',raw_assignee_name:'AJB GRUPPEN APS'},
  {id:'22Pa7SFws6CU',name:'Lægning af gulvspånplade',job_id:'22Pa7QvHbzfT',job_name:'Per Bo Austin',job_address:'Lundemarken 13, 4000 Roskilde',start_date:'2026-07-04',end_date:'2026-07-10',type_guess:'lay',raw_assignee_name:'AJB GRUPPEN APS'},
  {id:'22Pa7SFws6CW',name:'Lægning af sildebensparket',job_id:'22Pa7QvHbzfT',job_name:'Per Bo Austin',job_address:'Lundemarken 13, 4000 Roskilde',start_date:'2026-07-21',end_date:'2026-07-28',type_guess:'lay',raw_assignee_name:'Martin Rinik'},
  {id:'22Pa7SFwsT6s',name:'Finish & Afslutning',job_id:'22Pa7QvHbzfT',job_name:'Per Bo Austin',job_address:'Lundemarken 13, 4000 Roskilde',start_date:'2026-07-29',end_date:'2026-07-29',type_guess:'lay',raw_assignee_name:'Ahmed Chaib Elharouzi'},
  {id:'22Pa7SFwspzB',name:'Gennemgang af projektet',job_id:'22Pa7QvHbzfT',job_name:'Per Bo Austin',job_address:'Lundemarken 13, 4000 Roskilde',start_date:'2026-07-30',end_date:'2026-07-30',type_guess:'lay',raw_assignee_name:'Ahmed Chaib Elharouzi'},
  {id:'22Pa7SFwspzC',name:'Installation af gulvvarme',job_id:'22Pa7QvHbzfT',job_name:'Per Bo Austin',job_address:'Lundemarken 13, 4000 Roskilde',start_date:'2026-07-13',end_date:'2026-07-15',type_guess:'sub',raw_assignee_name:null},
  {id:'22Pa7SFwspzD',name:'Lægning af 12mm gulvspånplade',job_id:'22Pa7QvHbzfT',job_name:'Per Bo Austin',job_address:'Lundemarken 13, 4000 Roskilde',start_date:'2026-07-16',end_date:'2026-07-20',type_guess:'lay',raw_assignee_name:'AJB GRUPPEN APS'},
  {id:'22Pa7Tx8MjTK',name:'Lægning af sildebensparket',job_id:'22Pa7TuuF2Ju',job_name:'Rebecca Elmin',job_address:'Rahbeks Alle 16 st',start_date:'2026-07-10',end_date:'2026-07-19',type_guess:'lay',raw_assignee_name:'Kacper Pawel Michalski'},
  {id:'22Pa7Tx8N8Mc',name:'Slibning & Behandling',job_id:'22Pa7TuuF2Ju',job_name:'Rebecca Elmin',job_address:'Rahbeks Alle 16 st',start_date:'2026-07-20',end_date:'2026-07-25',type_guess:'sand',raw_assignee_name:'Adrian Sobon'},
  {id:'22Pa7Tx8N8Md',name:'Opsætning af Fejelister',job_id:'22Pa7TuuF2Ju',job_name:'Rebecca Elmin',job_address:'Rahbeks Alle 16 st',start_date:'2026-07-27',end_date:'2026-07-28',type_guess:'lay',raw_assignee_name:'Ahmed Chaib Elharouzi'},
  {id:'22Pa7Tx8N8Mf',name:'Finish & Afslutning',job_id:'22Pa7TuuF2Ju',job_name:'Rebecca Elmin',job_address:'Rahbeks Alle 16 st',start_date:'2026-07-29',end_date:'2026-07-29',type_guess:'lay',raw_assignee_name:'Ahmed Chaib Elharouzi'},
  {id:'22Pa7Tx8NVFy',name:'Gennemgang af projektet',job_id:'22Pa7TuuF2Ju',job_name:'Rebecca Elmin',job_address:'Rahbeks Alle 16 st',start_date:'2026-07-30',end_date:'2026-07-30',type_guess:'lay',raw_assignee_name:'Ahmed Chaib Elharouzi'},
  {id:'22Pa7VJ7xVwC',name:'Opsætning af døre/fodpaneler',job_id:'22Pa7VGwXWVu',job_name:'Simon Tue',job_address:'Lillegade 33, Greve',start_date:'2026-07-13',end_date:'2026-07-15',type_guess:'lay',raw_assignee_name:'Martin Rinik'},
  {id:'22Pa7WbmakYm',name:'Lægning af sildebensparket',job_id:'22Pa7VmGA26S',job_name:'Marie Louise Heneberg',job_address:'Nordstrands alle 19',start_date:'2026-07-09',end_date:'2026-07-13',type_guess:'lay',raw_assignee_name:'AJB GRUPPEN APS'},
  {id:'22Pa7WbmakYn',name:'Slibning & Behandling',job_id:'22Pa7VmGA26S',job_name:'Marie Louise Heneberg',job_address:'Nordstrands alle 19',start_date:'2026-07-14',end_date:'2026-07-16',type_guess:'sand',raw_assignee_name:'Adrian Sobon'},
  {id:'22Pa7aAmE78g',name:'Afmontering',job_id:'22Pa7a83UQtG',job_name:'Sara Pryds',job_address:'Engmarken 15, 2. Tv',start_date:'2026-07-06',end_date:'2026-07-06',type_guess:'lay',raw_assignee_name:'Mohammed ( Ahmed'},
  {id:'22Pa7aAmE78i',name:'Opretning af strøer',job_id:'22Pa7a83UQtG',job_name:'Sara Pryds',job_address:'Engmarken 15, 2. Tv',start_date:'2026-07-07',end_date:'2026-07-08',type_guess:'lay',raw_assignee_name:'Mohammed ( Ahmed'},
  {id:'22Pa7aAmE78j',name:'Lægning af gulvspånplade',job_id:'22Pa7a83UQtG',job_name:'Sara Pryds',job_address:'Engmarken 15, 2. Tv',start_date:'2026-07-09',end_date:'2026-07-10',type_guess:'lay',raw_assignee_name:'Mohammed ( Ahmed'},
  {id:'22Pa7aAmEU35',name:'Lægning af lvt gulv',job_id:'22Pa7a83UQtG',job_name:'Sara Pryds',job_address:'Engmarken 15, 2. Tv',start_date:'2026-07-11',end_date:'2026-07-13',type_guess:'lay',raw_assignee_name:'Mohammed ( Ahmed'},
  {id:'22Pa7aAmEqvP',name:'Opsætning af fodpaneler',job_id:'22Pa7a83UQtG',job_name:'Sara Pryds',job_address:'Engmarken 15, 2. Tv',start_date:'2026-07-13',end_date:'2026-07-14',type_guess:'lay',raw_assignee_name:'Ahmed Chaib Elharouzi'},
  {id:'22Pa7aAmFDph',name:'Finish & Afslutning',job_id:'22Pa7a83UQtG',job_name:'Sara Pryds',job_address:'Engmarken 15, 2. Tv',start_date:'2026-07-15',end_date:'2026-07-15',type_guess:'lay',raw_assignee_name:'Ahmed Chaib Elharouzi'},
  {id:'22Pa7aAmFDpi',name:'Gennemgang af projektet',job_id:'22Pa7a83UQtG',job_name:'Sara Pryds',job_address:'Engmarken 15, 2. Tv',start_date:'2026-07-15',end_date:'2026-07-15',type_guess:'lay',raw_assignee_name:'Ahmed Chaib Elharouzi'},
  {id:'22Pa7b7DhVaM',name:'Lægning af sildebensparket',job_id:'22Pa7b25vDxb',job_name:'Sara Stief',job_address:'Oehlenschlægersgade 7 stth',start_date:'2026-07-06',end_date:'2026-07-08',type_guess:'lay',raw_assignee_name:'Martin Rinik'},
  {id:'22Pa7b7DhVaN',name:'Slibning & Behandling',job_id:'22Pa7b25vDxb',job_name:'Sara Stief',job_address:'Oehlenschlægersgade 7 stth',start_date:'2026-07-10',end_date:'2026-07-13',type_guess:'sand',raw_assignee_name:'Adrian Sobon'},
];

var upsertTask = db.prepare("INSERT OR REPLACE INTO jt_tasks (id,name,job_id,job_name,job_address,start_date,end_date,type_guess,raw_assignee_name,jt_url,synced_at) VALUES (?,?,?,?,?,?,?,?,?,?,datetime('now'))");
var seedAll = db.transaction(function(list) {
  list.forEach(function(t) {
    upsertTask.run(t.id,t.name,t.job_id,t.job_name,t.job_address,t.start_date,t.end_date,t.type_guess,t.raw_assignee_name,'https://app.jobtread.com/jobs/'+t.job_id);
  });
});
seedAll(seedTasks);
console.log('Tasks seeded: ' + seedTasks.length);

// JobTread assignees are kept as suggestions only. Manual planning is never overwritten.
function getWeekKey(dateStr) {
  var d = new Date(dateStr);
  var day = d.getDay()||7;
  d.setDate(d.getDate()+4-day);
  var y = new Date(Date.UTC(d.getFullYear(),0,1));
  var wn = Math.ceil((((d-y)/86400000)+1)/7);
  var mon = new Date(dateStr);
  var md = mon.getDay();
  mon.setDate(mon.getDate()-(md||7)+1);
  return 'w'+mon.getFullYear()+'-'+String(wn).padStart(2,'0');
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
  var user = db.prepare("SELECT * FROM users WHERE email=? AND active=1 AND COALESCE(can_login,1)=1").get(req.body.email);
  if (!user || !bcrypt.compareSync(req.body.password, user.password_hash))
    return res.status(401).json({error:'Forkert email eller adgangskode'});
  var token = jwt.sign({id:user.id,name:user.name,role:user.role,email:user.email}, JWT_SECRET, {expiresIn:'30d'});
  res.json({token:token, user:{id:user.id,name:user.name,role:user.role,email:user.email,color:user.color,initials:user.initials}});
});

app.get('/api/auth/me', auth, function(req, res) {
  res.json(db.prepare('SELECT id,name,email,role,color,initials FROM users WHERE id=?').get(req.user.id));
});

// ── USERS / WORKFORCE ─────────────────────────────────
app.get('/api/users', auth, adminOnly, function(req, res) {
  res.json(db.prepare("SELECT id,name,email,role,color,initials,jobtread_name,active,worker_type,vendor_group,trade,weekly_capacity,COALESCE(can_login,1) AS can_login FROM users ORDER BY CASE WHEN role='admin' THEN 0 ELSE 1 END, CASE WHEN worker_type='vendor' THEN 1 ELSE 0 END, vendor_group, name").all());
});
function generatedPlanningEmail(name) {
  var slug=String(name||'vendor').toLowerCase().replace(/[^a-z0-9]+/g,'-').replace(/^-|-$/g,'').slice(0,35)||'vendor';
  return slug+'-'+Date.now()+'-'+Math.random().toString(36).slice(2,7)+'@planning.local';
}
app.post('/api/users', auth, adminOnly, function(req, res) {
  var b=req.body || {}, canLogin=b.can_login !== false;
  if (!b.name) return res.status(400).json({error:'Navn mangler'});
  if (canLogin && (!b.email || !b.password)) return res.status(400).json({error:'Email og adgangskode mangler for en bruger med login'});
  try {
    var ini=b.initials||b.name.split(' ').map(function(w){return w[0];}).join('').substring(0,3).toUpperCase();
    var email=canLogin ? String(b.email).trim().toLowerCase() : generatedPlanningEmail(b.name);
    var password=canLogin ? b.password : crypto.randomBytes(24).toString('hex');
    var workerType=b.worker_type==='vendor'?'vendor':'employee';
    var role=canLogin ? (b.role||'employee') : 'employee';
    var r=db.prepare('INSERT INTO users (name,email,password_hash,role,color,initials,jobtread_name,active,worker_type,vendor_group,trade,weekly_capacity,can_login) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)')
      .run(String(b.name).trim(),email,bcrypt.hashSync(password,10),role,b.color||'#2563EB',ini,b.jobtread_name||null,b.active===0?0:1,workerType,b.vendor_group||null,b.trade||null,Math.max(0,Number(b.weekly_capacity)||5),canLogin?1:0);
    res.json({id:r.lastInsertRowid,ok:true});
  } catch(e) {
    if (e.message.includes('UNIQUE')) return res.status(400).json({error:'Email er allerede i brug'});
    res.status(500).json({error:e.message});
  }
});
app.put('/api/users/:id', auth, adminOnly, function(req, res) {
  var u=db.prepare('SELECT * FROM users WHERE id=?').get(req.params.id);
  if (!u) return res.status(404).json({error:'Bruger blev ikke fundet'});
  var b=req.body || {}, canLogin=b.can_login !== undefined ? (b.can_login?1:0) : (u.can_login===undefined?1:u.can_login);
  var next={
    name:b.name !== undefined ? String(b.name).trim() : u.name,
    email:canLogin && b.email !== undefined ? String(b.email).trim().toLowerCase() : u.email,
    password_hash:b.password ? bcrypt.hashSync(b.password,10) : u.password_hash,
    role:canLogin ? (b.role || u.role) : 'employee',
    color:b.color || u.color,
    initials:b.initials !== undefined ? b.initials : u.initials,
    jobtread_name:b.jobtread_name !== undefined ? b.jobtread_name : u.jobtread_name,
    active:b.active !== undefined ? (b.active?1:0) : u.active,
    worker_type:b.worker_type === 'vendor' ? 'vendor' : (b.worker_type ? 'employee' : (u.worker_type || 'employee')),
    vendor_group:b.vendor_group !== undefined ? b.vendor_group : u.vendor_group,
    trade:b.trade !== undefined ? b.trade : u.trade,
    weekly_capacity:b.weekly_capacity !== undefined ? Math.max(0,Number(b.weekly_capacity)||0) : (u.weekly_capacity || 5),
    can_login:canLogin
  };
  if (canLogin && !next.email) return res.status(400).json({error:'Email mangler for login-bruger'});
  db.prepare('UPDATE users SET name=?,email=?,password_hash=?,role=?,color=?,initials=?,jobtread_name=?,active=?,worker_type=?,vendor_group=?,trade=?,weekly_capacity=?,can_login=? WHERE id=?')
    .run(next.name,next.email,next.password_hash,next.role,next.color,next.initials,next.jobtread_name,next.active,next.worker_type,next.vendor_group,next.trade,next.weekly_capacity,next.can_login,req.params.id);
  res.json({ok:true});
});

// ── JOBTREAD LIVE SYNC (sekventielle kald) ────────────
async function jtFetch(bodyObj) {
  var mod = await import('node-fetch');
  var fetch = mod.default;
  var resp = await fetch(JT_API, {
    method:'POST', headers:{'Content-Type':'application/json'},
    body: JSON.stringify(bodyObj)
  });
  if (!resp.ok) throw new Error('HTTP '+resp.status);
  var data = await resp.json();
  if (data.error) throw new Error(JSON.stringify(data.error));
  return data;
}

function guessType(n) {
  var t=(n||'').toLowerCase();
  if (t.includes('slib')||t.includes('behandling')) return 'sand';
  if (t.includes('mal')||t.includes('lak')||t.includes('maling')) return 'paint';
  if (t.includes('vvs')||t.includes('varme')) return 'sub';
  if (t.includes('gulv')||t.includes('parket')||t.includes('afmontering')||t.includes('spaan')||t.includes('stroer')||t.includes('laeg')) return 'lay';
  return 'other';
}

async function syncFromJT() {
  var key = JT_GRANT;
  if (!key) {
    console.log('No grant key set');
    db.prepare("INSERT INTO sync_log (tasks_imported,status,message) VALUES (?,?,?)").run(0,'error','Grant Key ikke sat. Gå til Render Settings → Environment og tilføj JT_GRANT_KEY');
    return {ok:false,error:'Ingen Grant Key'};
  }
  console.log('=== JT Sync start ===');
  try {
    var from = new Date().toISOString().split('T')[0];
    var to = new Date(Date.now()+84*86400000).toISOString().split('T')[0];
    var where = {and:[['isToDo',false],['targetType','job'],['startDate','>=',from],['startDate','<=',to],['isGroup',false]]};

    // Step 1: tasks med job info
    console.log('Step 1: tasks...');
    var d1 = await jtFetch({query:{$:{grantKey:key},organization:{$:{id:JT_ORG},tasks:{$:{size:40,where:where},nodes:{id:{},name:{},startDate:{},endDate:{},job:{id:{},name:{},location:{address:{}}}}}}}});
    var tasks = (d1&&d1.query&&d1.query.organization&&d1.query.organization.tasks&&d1.query.organization.tasks.nodes)||[];
    console.log('Tasks: '+tasks.length);

    // Step 2: assignments
    console.log('Step 2: assignments...');
    var d2 = await jtFetch({query:{$:{grantKey:key},organization:{$:{id:JT_ORG},tasks:{$:{size:40,where:where},nodes:{id:{},taskAssignments:{nodes:{membership:{user:{name:{}}}}}}}}}});
    var assignMap = {};
    var d2n = (d2&&d2.query&&d2.query.organization&&d2.query.organization.tasks&&d2.query.organization.tasks.nodes)||[];
    d2n.forEach(function(t) {
      if (t.taskAssignments&&t.taskAssignments.nodes&&t.taskAssignments.nodes[0]&&t.taskAssignments.nodes[0].membership&&t.taskAssignments.nodes[0].membership.user)
        assignMap[t.id]=t.taskAssignments.nodes[0].membership.user.name;
    });
    console.log('Assignments: '+Object.keys(assignMap).length);

    // Upsert
    var ups = db.prepare("INSERT INTO jt_tasks (id,name,job_id,job_name,job_address,start_date,end_date,type_guess,raw_assignee_name,jt_url,synced_at,source) VALUES (?,?,?,?,?,?,?,?,?,?,datetime('now'),'jobtread') ON CONFLICT(id) DO UPDATE SET name=excluded.name,job_id=excluded.job_id,job_name=excluded.job_name,job_address=excluded.job_address,start_date=excluded.start_date,end_date=excluded.end_date,type_guess=excluded.type_guess,raw_assignee_name=excluded.raw_assignee_name,jt_url=excluded.jt_url,synced_at=datetime('now'),source='jobtread'");
    var doAll = db.transaction(function(list) {
      list.forEach(function(t) {
        var ji = t.job||{};
        var customer = (ji.name||'').replace(/\s*[-\u2013]\s*(gulvl.gning|gulvslib|maler.*|slibning|service|renovering|t.mrer).*/i,'').trim();
        ups.run(t.id,t.name,ji.id||null,customer||ji.name||'',ji.location&&ji.location.address||'',t.startDate,t.endDate||t.startDate,guessType(t.name),assignMap[t.id]||null,'https://app.jobtread.com/jobs/'+(ji.id||''));
      });
    });
    doAll(tasks);

    // JobTread sync updates task data only; it never changes manual assignments.

    db.prepare("INSERT INTO sync_log (tasks_imported,status,message) VALUES (?,?,?)").run(tasks.length,'ok',tasks.length+' tasks synced');
    console.log('=== Sync done: '+tasks.length+' ===');
    return {ok:true,count:tasks.length};
  } catch(e) {
    console.error('Sync error: '+e.message);
    db.prepare("INSERT INTO sync_log (tasks_imported,status,message) VALUES (?,?,?)").run(0,'error',e.message);
    return {ok:false,error:e.message};
  }
}

app.post('/api/sync', auth, adminOnly, function(req,res) {
  syncFromJT().then(function(r){res.json(r);}).catch(function(e){res.status(500).json({error:e.message});});
});
app.get('/api/sync/log', auth, adminOnly, function(req,res) {
  res.json(db.prepare('SELECT * FROM sync_log ORDER BY synced_at DESC LIMIT 20').all());
});
if (JT_GRANT) cron.schedule('0 * * * *', function(){syncFromJT();});

// ── TASK POOL + INDEPENDENT MANUAL PLAN ───────────────
// JobTread is read-only input. `planning_bookings` is intentionally a separate
// table with no unique task/user/week rule: a task can be planned on several
// people and dates. Old automatic assignments are deliberately not used.
app.get('/api/tasks', auth, function(req,res) {
  var rows=db.prepare(`
    SELECT t.*, COUNT(b.id) AS assignment_count
    FROM jt_tasks t
    LEFT JOIN planning_bookings b ON b.task_id=t.id
    GROUP BY t.id
    ORDER BY CASE WHEN t.source='manual' THEN 0 ELSE 1 END, t.start_date ASC, t.job_name ASC
  `).all();
  res.json(rows);
});
function validDate(value) { return typeof value==='string' && /^\d{4}-\d{2}-\d{2}$/.test(value); }
function addWorkingDays(startDate, durationDays) {
  var d=new Date(startDate+'T12:00:00'); if (Number.isNaN(d.getTime())) return startDate;
  var days=Math.max(1,Math.ceil(Number(durationDays)||1)), count=1;
  while (count<days) { d.setDate(d.getDate()+1); if (d.getDay()!==0 && d.getDay()!==6) count++; }
  return d.getFullYear()+'-'+String(d.getMonth()+1).padStart(2,'0')+'-'+String(d.getDate()).padStart(2,'0');
}
function cleanTaskType(type) { return ['lay','sand','paint','sub','other'].includes(type) ? type : 'other'; }
app.post('/api/tasks/manual', auth, adminOnly, function(req,res) {
  var b=req.body||{};
  if (!b.job_name || !b.name || !validDate(b.start_date)) return res.status(400).json({error:'Kunde/projekt, opgave og startdato skal udfyldes'});
  var days=Math.max(.25,Math.min(60,Number(b.days)||1)), end=validDate(b.end_date)?b.end_date:addWorkingDays(b.start_date,days);
  var id='manual-'+(crypto.randomUUID?crypto.randomUUID():Date.now()+'-'+Math.random().toString(16).slice(2));
  db.prepare("INSERT INTO jt_tasks (id,name,job_id,job_name,job_address,start_date,end_date,type_guess,raw_assignee_name,jt_url,synced_at,source,created_at) VALUES (?,?,?,?,?,?,?,?,?,?,?, 'manual', datetime('now'))")
    .run(id,String(b.name).trim(),null,String(b.job_name).trim(),b.job_address||'',b.start_date,end,cleanTaskType(b.type_guess),null,null,new Date().toISOString());
  res.json({ok:true,id:id});
});
app.delete('/api/tasks/manual/:id', auth, adminOnly, function(req,res) {
  var task=db.prepare("SELECT id FROM jt_tasks WHERE id=? AND source='manual'").get(req.params.id);
  if (!task) return res.status(404).json({error:'Kun manuelle opgaver kan slettes her'});
  db.transaction(function(){ db.prepare('DELETE FROM planning_bookings WHERE task_id=?').run(req.params.id); db.prepare('DELETE FROM jt_tasks WHERE id=?').run(req.params.id); })();
  res.json({ok:true});
});
function normalizeBooking(body) {
  var b=body||{};
  var task=db.prepare('SELECT id FROM jt_tasks WHERE id=?').get(b.task_id); if(!task) throw new Error('Opgaven blev ikke fundet');
  var user=db.prepare("SELECT id FROM users WHERE id=? AND active=1 AND role='employee'").get(b.user_id); if(!user) throw new Error('Medarbejderen eller holdet blev ikke fundet');
  if(!validDate(b.start_date)) throw new Error('Vælg en gyldig startdato');
  var days=Math.max(.25,Math.min(60,Number(b.days)||1)), start=b.start_date;
  return {task_id:b.task_id,user_id:Number(b.user_id),week_key:getWeekKey(start),days:days,notes:b.notes?String(b.notes).slice(0,1000):null,start_time:b.start_time||null,start_date:start,end_date:validDate(b.end_date)?b.end_date:addWorkingDays(start,days)};
}
function bookingSelect(where) {
  return `SELECT b.*,u.name AS user_name,u.color AS user_color,u.initials AS user_initials,u.worker_type,u.vendor_group,u.trade,u.weekly_capacity,u.can_login,
    t.name AS task_name,t.job_name,t.job_address,t.start_date AS task_start_date,t.end_date AS task_end_date,t.type_guess,t.jt_url,t.job_id,t.source AS task_source
    FROM planning_bookings b JOIN users u ON b.user_id=u.id JOIN jt_tasks t ON b.task_id=t.id ${where||''}`;
}
app.get('/api/assignments', auth, function(req,res) {
  var where=req.user.role!=='admin'?'WHERE b.user_id=?':'', q=bookingSelect(where)+' ORDER BY b.start_date ASC,b.id ASC';
  res.json(req.user.role!=='admin'?db.prepare(q).all(req.user.id):db.prepare(q).all());
});
app.get('/api/assignments/my', auth, function(req,res) { res.json(db.prepare(bookingSelect('WHERE b.user_id=?')+' ORDER BY b.start_date ASC,b.id ASC').all(req.user.id)); });
app.post('/api/assignments', auth, adminOnly, function(req,res) {
  try { var b=normalizeBooking(req.body); var r=db.prepare("INSERT INTO planning_bookings (task_id,user_id,week_key,days,notes,start_time,start_date,end_date,updated_at) VALUES (?,?,?,?,?,?,?,?,datetime('now'))").run(b.task_id,b.user_id,b.week_key,b.days,b.notes,b.start_time,b.start_date,b.end_date); res.json({ok:true,id:r.lastInsertRowid}); }
  catch(e){res.status(400).json({error:e.message});}
});
app.put('/api/assignments/:id', auth, adminOnly, function(req,res) {
  try { var old=db.prepare('SELECT * FROM planning_bookings WHERE id=?').get(req.params.id); if(!old) return res.status(404).json({error:'Bookingen blev ikke fundet'}); var b=normalizeBooking(Object.assign({},old,req.body,{task_id:old.task_id})); db.prepare("UPDATE planning_bookings SET user_id=?,week_key=?,days=?,notes=?,start_time=?,start_date=?,end_date=?,updated_at=datetime('now') WHERE id=?").run(b.user_id,b.week_key,b.days,b.notes,b.start_time,b.start_date,b.end_date,req.params.id); res.json({ok:true}); }
  catch(e){res.status(400).json({error:e.message});}
});
app.delete('/api/assignments/:id', auth, adminOnly, function(req,res) { db.prepare('DELETE FROM planning_bookings WHERE id=?').run(req.params.id); res.json({ok:true}); });
app.delete('/api/plan', auth, adminOnly, function(req,res) { db.prepare('DELETE FROM planning_bookings').run(); res.json({ok:true}); });

// ── TIME ──────────────────────────────────────────────
app.post('/api/time/start', auth, function(req,res) {
  db.prepare("UPDATE time_logs SET stopped_at=datetime('now'),duration_minutes=CAST((julianday('now')-julianday(started_at))*1440 AS INTEGER) WHERE user_id=? AND stopped_at IS NULL").run(req.user.id);
  var r=db.prepare("INSERT INTO time_logs (user_id,task_id,started_at) VALUES (?,?,datetime('now'))").run(req.user.id,req.body.task_id);
  res.json({id:r.lastInsertRowid,ok:true});
});
app.post('/api/time/stop', auth, function(req,res) {
  var log=db.prepare('SELECT * FROM time_logs WHERE id=? AND user_id=?').get(req.body.log_id,req.user.id);
  if (!log) return res.status(404).json({error:'Not found'});
  db.prepare("UPDATE time_logs SET stopped_at=datetime('now'),duration_minutes=CAST((julianday('now')-julianday(started_at))*1440 AS INTEGER),notes=? WHERE id=?").run(req.body.notes||null,req.body.log_id);
  res.json({ok:true,duration_minutes:db.prepare('SELECT duration_minutes FROM time_logs WHERE id=?').get(req.body.log_id).duration_minutes});
});
app.get('/api/time/active', auth, function(req,res) {
  res.json(db.prepare('SELECT tl.*,t.job_name,t.name as task_name FROM time_logs tl JOIN jt_tasks t ON tl.task_id=t.id WHERE tl.user_id=? AND tl.stopped_at IS NULL').get(req.user.id)||null);
});
app.get('/api/time/all', auth, adminOnly, function(req,res) {
  res.json(db.prepare('SELECT tl.*,u.name as user_name,t.job_name,t.name as task_name FROM time_logs tl JOIN users u ON tl.user_id=u.id JOIN jt_tasks t ON tl.task_id=t.id ORDER BY tl.started_at DESC LIMIT 200').all());
});

// ── DASHBOARD ─────────────────────────────────────────
app.get('/api/dashboard', auth, adminOnly, function(req,res) {
  var today=new Date().toISOString().split('T')[0];
  var total=db.prepare('SELECT COUNT(*) as n FROM jt_tasks WHERE start_date>=?').get(today);
  var assigned=db.prepare('SELECT COUNT(DISTINCT task_id) as n FROM planning_bookings').get();
  var bookings=db.prepare('SELECT COUNT(*) as n FROM planning_bookings').get();
  var emps=db.prepare("SELECT COUNT(*) as n FROM users WHERE active=1 AND role='employee' AND COALESCE(worker_type,'employee')!='vendor'").get();
  var vendors=db.prepare("SELECT COUNT(*) as n FROM users WHERE active=1 AND role='employee' AND worker_type='vendor'").get();
  var manual=db.prepare("SELECT COUNT(*) as n FROM jt_tasks WHERE source='manual'").get();
  var lastSync=db.prepare('SELECT * FROM sync_log ORDER BY synced_at DESC LIMIT 1').get();
  res.json({totalTasks:total.n,assigned:assigned.n,bookings:bookings.n,unassigned:Math.max(0,total.n-assigned.n),manual:manual.n,employees:emps.n,vendors:vendors.n,lastSync:lastSync});
});

// ── ROUTING ───────────────────────────────────────────
app.get('/admin', function(req,res){res.sendFile(path.join(__dirname,'admin.html'));});
app.get('/employee', function(req,res){res.sendFile(path.join(__dirname,'employee.html'));});
app.get('*', function(req,res){res.sendFile(path.join(__dirname,'index.html'));});

app.listen(PORT, function() {
  console.log('Gulv Master korer pa port '+PORT);
  if (JT_GRANT) setTimeout(function(){syncFromJT();},5000);
});
