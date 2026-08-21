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
const nodemailer = require('nodemailer');
// FEJLSIKRING: hvis xlsx eller pdf-parse af en eller anden grund ikke kunne installeres
// korrekt på serveren (fx en afvigelse i build-miljøet), skal det IKKE vælte hele
// appen — kun bankafstemnings-featuren, som i så fald simpelthen ikke er tilgængelig.
let XLSX = null, pdfParse = null;
try { XLSX = require('xlsx'); } catch (e) { console.error('ADVARSEL: xlsx kunne ikke indlæses — bankafstemning (Excel/CSV) er utilgængelig:', e.message); }
try { pdfParse = require('pdf-parse'); } catch (e) { console.error('ADVARSEL: pdf-parse kunne ikke indlæses — bankafstemning (PDF) er utilgængelig:', e.message); }
const DEFAULT_CLEANING_PDF_BASE64 = require('./cleaning-pdf-base64');
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
// Separat upload-håndtering til bankudtog (PDF/Excel/CSV) — bruges af den automatiske
// bankafstemning under Økonomi → Fakturaer.
const uploadBankStatement = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 8 * 1024 * 1024, files: 1 },
  fileFilter: (req, file, cb) => {
    const lower = String(file.originalname || '').toLowerCase();
    if (!/\.(pdf|xlsx|xls|csv)$/.test(lower)) {
      return cb(new Error('Vælg en PDF-, Excel- (.xlsx/.xls) eller CSV-fil.'));
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
    ALTER TABLE users ADD COLUMN IF NOT EXISTS personal_email TEXT;
    ALTER TABLE users ADD COLUMN IF NOT EXISTS notify_schedule_changes INTEGER DEFAULT 0;
    ALTER TABLE users ADD COLUMN IF NOT EXISTS jt_vendor_account_id TEXT;
    ALTER TABLE users ADD COLUMN IF NOT EXISTS password_reset_token TEXT;
    ALTER TABLE users ADD COLUMN IF NOT EXISTS password_reset_expires TEXT;
    ALTER TABLE users ADD COLUMN IF NOT EXISTS is_finance_admin INTEGER DEFAULT 0;

    -- ØKONOMI: kun synligt/tilgængeligt for brugere med is_finance_admin=1 (se
    -- financeOnly-middleware). Alt her er bevidst adskilt fra den almindelige
    -- planlægning, så en almindelig admin ikke ved et uheld kan se/ændre det.
    CREATE TABLE IF NOT EXISTS finance_expense_categories (
      id SERIAL PRIMARY KEY,
      name TEXT NOT NULL,
      sort_order INTEGER DEFAULT 0
    );
    CREATE TABLE IF NOT EXISTS finance_expenses (
      id SERIAL PRIMARY KEY,
      category_id INTEGER REFERENCES finance_expense_categories(id) ON DELETE CASCADE,
      name TEXT NOT NULL,
      amount DOUBLE PRECISION DEFAULT 0,
      paid INTEGER DEFAULT 0,
      month_key TEXT,
      updated_at TEXT DEFAULT ${nowTextSQL()}
    );
    -- Fandtes allerede uden month_key — tilføj eksplicit (samme fejl som paid_amount
    -- ovenfor: CREATE TABLE IF NOT EXISTS rører ikke en allerede-eksisterende tabel).
    ALTER TABLE finance_expenses ADD COLUMN IF NOT EXISTS month_key TEXT;
    -- Alt der blev oprettet før månedsopdeling fandtes, mærkes med indeværende måned,
    -- så det ikke bare forsvinder fra visningen.
    UPDATE finance_expenses SET month_key=TO_CHAR(CURRENT_DATE,'YYYY-MM') WHERE month_key IS NULL;
    -- HURTIG MÅNEDS-UDGIFT (Martin: "kan jeg bare manuelt indskrive en måned bagud hvad
    -- vores udgifter har været?") — et bevidst LET alternativ til at skulle udspecificere
    -- hver post i Udgifter-fanen for hver tidligere måned. Findes der en række her for en
    -- given måned, VINDER den over den udspecificerede sum for den måned (se
    -- /api/finance/expenses-totals) — så man kan hurtigt proppe ét samlet tal ind for de
    -- måneder man ikke gider/nåede at udspecificere, og stadig gå tilbage og udspecificere
    -- senere ved bare at slette override'en igen.
    CREATE TABLE IF NOT EXISTS finance_expense_month_totals (
      month_key TEXT PRIMARY KEY,
      amount DOUBLE PRECISION DEFAULT 0,
      updated_at TEXT DEFAULT ${nowTextSQL()}
    );

    -- PRIVAT BUDGET: samme mønster som Udgifter, men brugeren må selv oprette/slette
    -- kategorier (ikke kun rette poster i faste kategorier) — det skal kunne udbygges
    -- frit (Indtægt, Opsparing, Gæld, Aktier, Ønskeliste, osv.).
    CREATE TABLE IF NOT EXISTS private_budget_categories (
      id SERIAL PRIMARY KEY,
      name TEXT NOT NULL,
      sort_order INTEGER DEFAULT 0
    );
    CREATE TABLE IF NOT EXISTS private_budget_items (
      id SERIAL PRIMARY KEY,
      category_id INTEGER REFERENCES private_budget_categories(id) ON DELETE CASCADE,
      name TEXT NOT NULL,
      amount DOUBLE PRECISION DEFAULT 0,
      note TEXT,
      updated_at TEXT DEFAULT ${nowTextSQL()}
    );

    CREATE TABLE IF NOT EXISTS finance_bank_snapshots (
      id SERIAL PRIMARY KEY,
      snap_date TEXT UNIQUE NOT NULL,
      hovedkonto DOUBLE PRECISION DEFAULT 0,
      moms DOUBLE PRECISION DEFAULT 0,
      forbrug DOUBLE PRECISION DEFAULT 0,
      tilgodehavende DOUBLE PRECISION DEFAULT 0,
      created_at TEXT DEFAULT ${nowTextSQL()}
    );
    -- Bagudgående måneders "rigtige" udgiftstal — Martin uploader en bank-CSV/Excel
    -- PR. MÅNED (adskilt fra den løbende bankafstemnings-session ovenfor, som kun
    -- husker den nyeste fil og bruges til fakturamatching). Her gemmes hver måneds
    -- upload permanent under sin egen month_key, så tidligere måneder ikke forsvinder
    -- når en ny fil uploades for en anden måned. expense_total = summen af alle
    -- hævninger (negative beløb) i udskriften — bruges som det faktiske udgiftstal
    -- for den måned i stedet for Udgift-modulets planlagte/manuelt indtastede poster.
    CREATE TABLE IF NOT EXISTS finance_bank_month_statements (
      month_key TEXT PRIMARY KEY,
      filename TEXT,
      transactions_json TEXT,
      expense_total DOUBLE PRECISION DEFAULT 0,
      income_total DOUBLE PRECISION DEFAULT 0,
      txn_count INTEGER DEFAULT 0,
      uploaded_at TEXT DEFAULT ${nowTextSQL()}
    );
    -- Manuel status/note pr. JobTread-faktura (dokument-id), da JobTread/Billy ikke
    -- altid er opdateret — det er her admin selv retter "betalt/udestående/uafklaret".
    CREATE TABLE IF NOT EXISTS finance_invoice_overrides (
      document_id TEXT PRIMARY KEY,
      status TEXT DEFAULT 'unpaid',
      note TEXT,
      paid_amount DOUBLE PRECISION,
      updated_at TEXT DEFAULT ${nowTextSQL()}
    );
    -- Tabellen fandtes allerede fra en tidligere version uden paid_amount — CREATE
    -- TABLE IF NOT EXISTS rører ikke en tabel der allerede findes, så kolonnen skal
    -- tilføjes eksplicit her, ellers fejler "delvist betalt" på produktion.
    ALTER TABLE finance_invoice_overrides ADD COLUMN IF NOT EXISTS paid_amount DOUBLE PRECISION;
    -- Manuel korrektion/udelukkelse af en sags budgetværdi i omsætningsberegningen
    -- (fx en tastefejl i JobTread, eller en sag der mangler budget helt).
    CREATE TABLE IF NOT EXISTS finance_job_overrides (
      job_id TEXT PRIMARY KEY,
      amount DOUBLE PRECISION,
      excluded INTEGER DEFAULT 0,
      note TEXT,
      updated_at TEXT DEFAULT ${nowTextSQL()}
    );
    -- Manuelt tilføjede omsætningslinjer under "Omsætning pr. fag" — for sager der
    -- ikke findes i JobTread, eller som admin vil have med af andre grunde.
    CREATE TABLE IF NOT EXISTS finance_manual_revenue (
      id SERIAL PRIMARY KEY,
      month_key TEXT NOT NULL,
      name TEXT NOT NULL,
      fag TEXT DEFAULT 'Ukendt',
      amount DOUBLE PRECISION DEFAULT 0,
      updated_at TEXT DEFAULT ${nowTextSQL()}
    );

    -- RYKKER-MAILS: slået FRA som standard — skal aktivt slås til under Økonomi →
    -- Fakturaer, da automatiske kunde-mails tidligere har skabt problemer (se
    -- "vi kommer i morgen"-hændelsen). Kun ét sæt indstillinger for hele firmaet.
    CREATE TABLE IF NOT EXISTS finance_dunning_settings (
      id INTEGER PRIMARY KEY DEFAULT 1,
      enabled INTEGER DEFAULT 0,
      days_rykker1 INTEGER DEFAULT 14,
      days_rykker2 INTEGER DEFAULT 28,
      fee_amount DOUBLE PRECISION DEFAULT 100,
      updated_at TEXT DEFAULT ${nowTextSQL()}
    );
    CREATE TABLE IF NOT EXISTS finance_dunning_log (
      id SERIAL PRIMARY KEY,
      document_id TEXT NOT NULL,
      level INTEGER NOT NULL,
      to_email TEXT,
      status TEXT,
      error TEXT,
      sent_at TEXT DEFAULT ${nowTextSQL()}
    );
    -- Husker rækkefølgen når Martin trækker rundt på boksene i Oversigt/Udgifter/
    -- Privat budget, så layoutet ikke nulstilles hver gang siden genindlæses.
    CREATE TABLE IF NOT EXISTS finance_panel_order (
      panel TEXT PRIMARY KEY,
      order_json TEXT NOT NULL,
      updated_at TEXT DEFAULT ${nowTextSQL()}
    );
    -- Husker den størrelse Martin selv har trukket en boks til (bredde/højde), så den
    -- ikke springer tilbage til standardstørrelsen ved genindlæsning.
    CREATE TABLE IF NOT EXISTS finance_panel_box_size (
      panel TEXT NOT NULL,
      box_id TEXT NOT NULL,
      width INTEGER,
      height INTEGER,
      updated_at TEXT DEFAULT ${nowTextSQL()},
      PRIMARY KEY (panel, box_id)
    );
    -- Selvvalgte graf-widgets i Oversigt — kan tilføjes/fjernes frit. Seedes én gang
    -- med de to grafer der fandtes i forvejen (trend + year), så ingen mister noget.
    CREATE TABLE IF NOT EXISTS finance_dashboard_widgets (
      id SERIAL PRIMARY KEY,
      widget_type TEXT NOT NULL,
      sort_order INTEGER DEFAULT 0,
      created_at TEXT DEFAULT ${nowTextSQL()}
    );

    -- Manuel farve-markering pr. sag i Omsætning pr. fag (kørende/faktureret/på hold)
    -- — rent visuel hjælp, påvirker ikke selve omsætningstallene.
    CREATE TABLE IF NOT EXISTS finance_job_status_marks (
      job_key TEXT PRIMARY KEY,
      status TEXT NOT NULL,
      updated_at TEXT DEFAULT ${nowTextSQL()}
    );

    -- Flytter en sags omsætning til en anden måned end dens rigtige startdato tilsiger
    -- — fx når en sag udskydes pga. vejret og reelt hører til næste måned i regnskabet.
    CREATE TABLE IF NOT EXISTS finance_job_month_overrides (
      job_id TEXT PRIMARY KEY,
      month_key TEXT NOT NULL,
      updated_at TEXT DEFAULT ${nowTextSQL()}
    );

    -- Husker hvilke bankposteringer der allerede er matchet og anvendt, så de ikke
    -- dukker op som "nye" igen næste gang samme (eller et overlappende) bankudtog
    -- uploades — svarer til Billys "Åbne / Afstemt"-faner. "kind" skelner mellem en
    -- rigtig faktura-match og en postering der bevidst er fjernet som irrelevant
    -- (fx løn, interne overførsler) — begge dele skal huskes på tværs af uploads.
    CREATE TABLE IF NOT EXISTS finance_bank_reconciled (
      external_id TEXT PRIMARY KEY,
      txn_date TEXT,
      txn_text TEXT,
      txn_amount NUMERIC,
      document_id TEXT,
      customer TEXT,
      kind TEXT DEFAULT 'matched',
      reconciled_at TEXT DEFAULT ${nowTextSQL()}
    );
    ALTER TABLE finance_bank_reconciled ADD COLUMN IF NOT EXISTS kind TEXT DEFAULT 'matched';

    -- Gemmer det senest uploadede bankudtog (med alle match-forslag) server-side, så
    -- man kan forlade siden eller genindlæse browseren uden at skulle uploade filen
    -- igen — den ligger her indtil næste fil uploades og overskriver den.
    CREATE TABLE IF NOT EXISTS finance_bank_session (
      id INTEGER PRIMARY KEY DEFAULT 1,
      filename TEXT,
      transactions_json TEXT,
      uploaded_at TEXT DEFAULT ${nowTextSQL()}
    );

    -- SYSTEMLOG: én fælles logbog for alt der kører automatisk i baggrunden (JobTread-
    -- synk hver time, notifikationsscan, m.fl.) — så admin kan se om noget fejler
    -- stille, uden at skulle ind i Renders serverlogs.
    CREATE TABLE IF NOT EXISTS system_log (
      id SERIAL PRIMARY KEY,
      source TEXT NOT NULL,
      level TEXT NOT NULL DEFAULT 'info',
      message TEXT NOT NULL,
      created_at TEXT DEFAULT ${nowTextSQL()}
    );
    CREATE INDEX IF NOT EXISTS idx_system_log_created ON system_log(created_at DESC);

    CREATE INDEX IF NOT EXISTS idx_users_jt_vendor ON users(jt_vendor_account_id);

    CREATE TABLE IF NOT EXISTS gantt_tasks (
      id TEXT PRIMARY KEY,
      job_id TEXT NOT NULL,
      job_name TEXT,
      name TEXT,
      description TEXT,
      start_date TEXT,
      end_date TEXT,
      progress REAL DEFAULT 0,
      is_group INTEGER DEFAULT 0,
      parent_task_id TEXT,
      position TEXT,
      depends_on TEXT,
      job_phone TEXT,
      job_email TEXT,
      synced_at TEXT
    );
    CREATE INDEX IF NOT EXISTS idx_gantt_tasks_job ON gantt_tasks(job_id);
    ALTER TABLE gantt_tasks ADD COLUMN IF NOT EXISTS job_phone TEXT;
    ALTER TABLE gantt_tasks ADD COLUMN IF NOT EXISTS job_email TEXT;
    ALTER TABLE gantt_tasks ADD COLUMN IF NOT EXISTS job_address TEXT;
    ALTER TABLE gantt_tasks ADD COLUMN IF NOT EXISTS type_guess TEXT;
    ALTER TABLE gantt_tasks ADD COLUMN IF NOT EXISTS job_number TEXT;
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
    ALTER TABLE planning_bookings ADD COLUMN IF NOT EXISTS documented_at TEXT;
    ALTER TABLE planning_bookings ADD COLUMN IF NOT EXISTS sort_order INTEGER DEFAULT 0;
    CREATE INDEX IF NOT EXISTS idx_planning_bookings_mode ON planning_bookings(planning_mode);

    CREATE TABLE IF NOT EXISTS app_settings (
      key TEXT PRIMARY KEY,
      value TEXT
    );

    -- SKABELONER: genbrugelige opgave-typer med standard varighed/fag/tjekpunkter,
    -- så en tilbagevendende opgavetype kan trækkes ind i poolen med ét klik.
    CREATE TABLE IF NOT EXISTS task_templates (
      id SERIAL PRIMARY KEY,
      name TEXT NOT NULL,
      type_guess TEXT DEFAULT 'other',
      default_days DOUBLE PRECISION DEFAULT 1,
      checklist_items TEXT DEFAULT '[]',
      notes_template TEXT,
      created_at TEXT DEFAULT ${nowTextSQL()},
      updated_at TEXT DEFAULT ${nowTextSQL()}
    );

    -- MAIL-SKABELONER: forskellige varianter af kunde-mailen (fx "Planlagt", "Haster",
    -- "Genplanlagt"), med variabler ({{kunde}}, {{opgave}}, {{dato}}, {{tidspunkt}},
    -- {{medarbejder}}, {{fag}}, {{adresse}}, {{firma}}) der udfyldes ved afsendelse.
    CREATE TABLE IF NOT EXISTS email_templates (
      id SERIAL PRIMARY KEY,
      name TEXT NOT NULL,
      subject TEXT NOT NULL,
      body TEXT NOT NULL,
      created_at TEXT DEFAULT ${nowTextSQL()},
      updated_at TEXT DEFAULT ${nowTextSQL()}
    );

    -- NOTIFIKATIONER: en simpel regel pr. hændelsestype (event_key), med kanal
    -- (in-app og/eller e-mail) og om den er slået til. Redigeres fra en indstillingsside.
    CREATE TABLE IF NOT EXISTS notification_rules (
      event_key TEXT PRIMARY KEY,
      label TEXT,
      inapp_enabled INTEGER DEFAULT 1,
      email_enabled INTEGER DEFAULT 0,
      email_to TEXT,
      updated_at TEXT DEFAULT ${nowTextSQL()}
    );
    CREATE TABLE IF NOT EXISTS notifications (
      id SERIAL PRIMARY KEY,
      event_key TEXT NOT NULL,
      title TEXT NOT NULL,
      body TEXT,
      link TEXT,
      user_id INTEGER,
      created_at TEXT DEFAULT ${nowTextSQL()},
      read_at TEXT
    );
    CREATE INDEX IF NOT EXISTS idx_notifications_created ON notifications(created_at DESC);

    -- KUNDE-KOMMUNIKATION: log for planlagt/påmindelse-mails til kunden (adskilt fra
    -- completion_emails, som allerede findes til færdig-mailen).
    CREATE TABLE IF NOT EXISTS customer_schedule_emails (
      id SERIAL PRIMARY KEY,
      booking_id INTEGER,
      task_id TEXT,
      kind TEXT NOT NULL, -- 'scheduled' | 'reminder'
      to_email TEXT,
      status TEXT,
      error TEXT,
      sent_at TEXT DEFAULT ${nowTextSQL()}
    );
    ALTER TABLE planning_bookings ADD COLUMN IF NOT EXISTS scheduled_email_sent_at TEXT;
    ALTER TABLE planning_bookings ADD COLUMN IF NOT EXISTS reminder_email_sent_at TEXT;

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
    ALTER TABLE planning_bookings ADD COLUMN IF NOT EXISTS status_flag TEXT;
    ALTER TABLE jt_tasks ADD COLUMN IF NOT EXISTS job_number TEXT;
    ALTER TABLE jt_tasks ADD COLUMN IF NOT EXISTS job_lat DOUBLE PRECISION;
    ALTER TABLE jt_tasks ADD COLUMN IF NOT EXISTS job_lng DOUBLE PRECISION;
    ALTER TABLE jt_tasks ADD COLUMN IF NOT EXISTS customer_email TEXT;
    ALTER TABLE jt_tasks ADD COLUMN IF NOT EXISTS customer_email_source TEXT;
    ALTER TABLE jt_tasks ADD COLUMN IF NOT EXISTS customer_email_synced_at TEXT;

    CREATE TABLE IF NOT EXISTS completion_emails (
      id SERIAL PRIMARY KEY,
      booking_id INTEGER,
      task_id TEXT,
      to_email TEXT,
      status TEXT,
      error TEXT,
      sent_at TEXT DEFAULT ${nowTextSQL()}
    );

    CREATE TABLE IF NOT EXISTS task_checklist_items (
      id SERIAL PRIMARY KEY,
      task_id TEXT NOT NULL,
      title TEXT NOT NULL,
      done INTEGER DEFAULT 0,
      done_by INTEGER,
      done_at TEXT,
      created_by INTEGER,
      created_at TEXT DEFAULT ${nowTextSQL()}
    );
    CREATE INDEX IF NOT EXISTS idx_task_checklist_task ON task_checklist_items(task_id);

    ALTER TABLE jt_tasks ADD COLUMN IF NOT EXISTS is_visit INTEGER DEFAULT 0;
    -- Manuel "færdig"-markering for opgaver der IKKE er booket endnu (ingen booking at
    -- sætte completed_at på) — så ✓-knappen i Opgavepool kan virke på alle opgaver,
    -- ikke kun planlagte.
    ALTER TABLE jt_tasks ADD COLUMN IF NOT EXISTS manually_completed_at TEXT;
    ALTER TABLE notifications ADD COLUMN IF NOT EXISTS user_id INTEGER;
    -- FEJL RETTET: dette index lå tidligere oppe ved CREATE TABLE-blokken, men for en
    -- database hvor "notifications" allerede fandtes (som her), er CREATE TABLE IF NOT
    -- EXISTS en no-op — så kolonnen "user_id" fandtes slet ikke endnu på det tidspunkt
    -- i migrationen. Serveren crashede derfor hver gang med "column user_id does not
    -- exist". Indexet oprettes nu EFTER ALTER TABLE her, hvor kolonnen med sikkerhed
    -- findes, uanset om tabellen er ny eller eksisterede i forvejen.
    CREATE INDEX IF NOT EXISTS idx_notifications_user ON notifications(user_id, created_at DESC);

    CREATE TABLE IF NOT EXISTS customer_visits (
      id SERIAL PRIMARY KEY,
      task_id TEXT NOT NULL,
      booking_id INTEGER,
      customer_name TEXT,
      address TEXT,
      phone TEXT,
      email TEXT,
      room_size TEXT,
      floor_type_wanted TEXT,
      notes TEXT,
      recommended_solution TEXT,
      estimated_price TEXT,
      filled_by INTEGER,
      created_at TEXT DEFAULT ${nowTextSQL()},
      updated_at TEXT DEFAULT ${nowTextSQL()}
    );
    CREATE INDEX IF NOT EXISTS idx_customer_visits_task ON customer_visits(task_id);

    CREATE TABLE IF NOT EXISTS note_tabs (
      id SERIAL PRIMARY KEY,
      user_id INTEGER NOT NULL,
      title TEXT DEFAULT 'Note',
      content TEXT,
      sort_order INTEGER DEFAULT 0,
      created_at TEXT DEFAULT ${nowTextSQL()},
      updated_at TEXT DEFAULT ${nowTextSQL()}
    );
    CREATE INDEX IF NOT EXISTS idx_note_tabs_user ON note_tabs(user_id, sort_order);

    CREATE TABLE IF NOT EXISTS notes_widget (
      user_id INTEGER PRIMARY KEY,
      content TEXT,
      pos_x INTEGER DEFAULT 80,
      pos_y INTEGER DEFAULT 80,
      width INTEGER DEFAULT 320,
      height INTEGER DEFAULT 320,
      updated_at TEXT DEFAULT ${nowTextSQL()}
    );

    -- Fag/faggrupper og deres farve — styrer opgave-farverne i Daglig plan/Ugeplan og på
    -- opgavekortene. Kapacitetsboardet bruger bevidst ÉN ensartet farve uanset fag.
    CREATE TABLE IF NOT EXISTS task_types (
      key TEXT PRIMARY KEY,
      label TEXT NOT NULL,
      color TEXT NOT NULL,
      sort_order INTEGER DEFAULT 0
    );
    INSERT INTO task_types (key,label,color,sort_order) VALUES
      ('lay','Gulvlægning','#3B82F6',1),
      ('sand','Gulvslibning','#22C55E',2),
      ('paint','Malerservice','#EAB308',3),
      ('sub','Underlev.','#8B5CF6',4),
      ('other','Andet','#94A3B8',99)
    ON CONFLICT (key) DO NOTHING;

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

  // Seed standard pleje-/rengørings-PDF'en og en dansk standardtekst, så
  // færdig-mailen er klar til brug uden at admin skal uploade noget manuelt.
  // Parametriseret (ikke string-interpolation), fordi base64-strengen er stor.
  await pool.query(`
    INSERT INTO app_settings (key, value) VALUES ('cleaning_pdf_base64', $1)
    ON CONFLICT (key) DO NOTHING;
  `, [DEFAULT_CLEANING_PDF_BASE64]);
  await pool.query(`
    INSERT INTO app_settings (key, value) VALUES ('cleaning_pdf_filename', 'Pleje-og-vedligeholdelsesvejledning-Gulv-Master.pdf')
    ON CONFLICT (key) DO NOTHING;
  `);
  await pool.query(`
    INSERT INTO app_settings (key, value) VALUES ('completion_email_subject', 'Vi er færdige hos dig — {kunde}')
    ON CONFLICT (key) DO NOTHING;
  `);
  await pool.query(`
    INSERT INTO app_settings (key, value) VALUES ('completion_email_body', $1)
    ON CONFLICT (key) DO NOTHING;
  `, [
    'Hej,\n\nVi vil gerne informere dig om, at vi nu er færdige med arbejdet hos dig ({opgave}).\n\n' +
    'Vedhæftet finder du vores pleje- og vedligeholdelsesvejledning, som beskriver hvordan du bedst passer på dit nybehandlede gulv den første tid.\n\n' +
    'Mange tak for denne gang — vi håber du bliver glad for resultatet!\n\nVenlig hilsen\n{firma}'
  ]);

  // ── ØKONOMI: engangs-bootstrap ──────────────────────────────
  // Ingen har adgang til Økonomi-sektionen som standard. Første gang serveren
  // starter uden at NOGEN har flaget, gives det automatisk til den admin med
  // lavest id (typisk den oprindelige ejer-konto) — så der er nogen der kan
  // tildele/fjerne adgang til andre via brugerfladen bagefter. Kører kun én
  // gang: så snart én bruger har flaget, rører dette aldrig ved det igen.
  const financeAdminCount = await pgOne('SELECT COUNT(*)::int AS n FROM users WHERE is_finance_admin=1');
  if (financeAdminCount && financeAdminCount.n === 0) {
    const firstAdmin = await pgOne("SELECT id FROM users WHERE role='admin' ORDER BY id ASC LIMIT 1");
    if (firstAdmin) {
      await pool.query('UPDATE users SET is_finance_admin=1 WHERE id=$1', [firstAdmin.id]);
      console.log(`Økonomi-adgang tildelt automatisk til bruger #${firstAdmin.id} (første admin) — kan ændres under Hold & vendors.`);
    }
  }

  // Seed standard udgiftskategorier/-poster, kun hvis tabellen er helt tom —
  // rører aldrig ved data admin selv har rettet siden.
  const expenseCatCount = await pgOne('SELECT COUNT(*)::int AS n FROM finance_expense_categories');
  if (expenseCatCount && expenseCatCount.n === 0) {
    const seedCats = [
      ['Faste udgifter', ['Bank gebyrer:399', 'Jobtread:2100', 'Chat GPT:150', 'Shopify:920', 'Close:1400', 'Microsoft Drive:70', 'Google Drive/Gmail:500', 'Billy & Økonomic (regn.):600', 'Wordpress:350', 'Internet og telefoni:999', 'Forsikring:8000', 'Husleje:14000', 'Revisor:4250', 'Løn – Kontor/admin:60000']],
      ['Samarbejdspartner', ['Dania VVS:0', 'MK gulvservice:5000', 'Præsidentgulve:0', 'Patrick Nørager:0', 'JAHTEK (maj):5000', 'Marcin Amagerbyg:0', 'Amir:10000', 'Novo:10000']],
      ['Leverandør', ['Scandinovia:85000', 'Cmv:5000', 'Stark:90000', 'Floorcoat:5000', 'PPG:25000']],
      ['Løn & Personale', ['Løn – gulvsliber:45000', 'Løn – maler:25000', 'Forsikring:8000', 'Løn – gulvlæggere:100000', 'Forsikring:8000']],
      ['Marketing', ['Google Ads:26000', 'Nordic Ad Partner:9000', 'Esben:5000', 'Amplifly Marketing:30000']],
      ['Transport', ['Benzin:10000', 'Parkering:6000', 'Parkering:6000', 'Forsikring:5000', 'Bro:3500']],
    ];
    for (let ci = 0; ci < seedCats.length; ci++) {
      const [catName, items] = seedCats[ci];
      const catResult = await pool.query('INSERT INTO finance_expense_categories (name, sort_order) VALUES ($1,$2) RETURNING id', [catName, ci]);
      const catId = catResult.rows[0].id;
      for (const item of items) {
        const [itemName, amountStr] = item.split(':');
        await pool.query('INSERT INTO finance_expenses (category_id, name, amount, month_key) VALUES ($1,$2,$3,$4)', [catId, itemName, Number(amountStr) || 0, new Date().toISOString().slice(0, 7)]);
      }
    }
    console.log('Standard udgiftskategorier oprettet under Økonomi.');
  }

  const privateBudgetCatCount = await pgOne('SELECT COUNT(*)::int AS n FROM private_budget_categories');
  if (privateBudgetCatCount && privateBudgetCatCount.n === 0) {
    const seedPrivateCats = [
      ['Indtægt', ['Løn:11200', 'Dubai:15000']],
      ['Faste udgifter', ['Mad:3500', 'Intrum:400', 'SU gæld:250', 'Eos:500', 'Fitness:599', 'Travling:1000', 'Sjov og ballade:1000', 'Tennis:100', 'Boksning:399']],
      ['Malta', ['Husleje:9400', 'Sundhedsforsikring Malta:0', 'Internet:150', 'scooter:50']],
      ['Opsparing & Cash', ['Konto:5000', 'Demets Account:4500', 'Opsparing:5000', 'Tøj:15000', 'Adrian:50000', 'Cashgulvmaster:0', 'Cash me:46000', 'Dubai:16000']],
      ['Gælds poster', ['September rejse:3000', 'December/Januar rejse:15000', 'Maltetisk ID:2500', 'Mor:28000', 'air bnb extra:30000']],
    ];
    for (let ci = 0; ci < seedPrivateCats.length; ci++) {
      const [catName, items] = seedPrivateCats[ci];
      const catResult = await pool.query('INSERT INTO private_budget_categories (name, sort_order) VALUES ($1,$2) RETURNING id', [catName, ci]);
      const catId = catResult.rows[0].id;
      for (const item of items) {
        const [itemName, amountStr] = item.split(':');
        await pool.query('INSERT INTO private_budget_items (category_id, name, amount) VALUES ($1,$2,$3)', [catId, itemName, Number(amountStr) || 0]);
      }
    }
    console.log('Privat budget-startdata oprettet — tilføj/ret/slet frit under Økonomi → Privat budget.');
  }

  await pool.query('INSERT INTO finance_dunning_settings (id) VALUES (1) ON CONFLICT (id) DO NOTHING');

  const widgetCount = await pgOne('SELECT COUNT(*)::int AS n FROM finance_dashboard_widgets');
  if (widgetCount && widgetCount.n === 0) {
    await pool.query("INSERT INTO finance_dashboard_widgets (widget_type, sort_order) VALUES ('trend', 0), ('year', 1)");
  }
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

// ── UGENTLIG KAPACITETS-BEREGNING (server-side, matcher klientens weeklyLoad) ──
function workDatesForBooking(startDate, endDate) {
  const s = new Date(`${startDate}T12:00:00`);
  const e = new Date(`${endDate || startDate}T12:00:00`);
  const out = [];
  for (let d = new Date(s); d <= e; d.setDate(d.getDate() + 1)) {
    if (d.getDay() !== 0 && d.getDay() !== 6) {
      out.push(`${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`);
    }
  }
  return out.length ? out : [startDate];
}

function weekdayDates(weekMonday) {
  const d = new Date(`${weekMonday}T12:00:00`);
  const out = [];
  for (let i = 0; i < 5; i++) {
    const x = new Date(d);
    x.setDate(d.getDate() + i);
    out.push(`${x.getFullYear()}-${String(x.getMonth() + 1).padStart(2, '0')}-${String(x.getDate()).padStart(2, '0')}`);
  }
  return out;
}

async function weeklyLoadForUser(userId, weekMonday, excludeBookingId) {
  const days = weekdayDates(weekMonday);
  const rows = await pool.query('SELECT id,days,capacity_days,start_date,end_date FROM planning_bookings WHERE user_id=$1', [userId]);
  let load = 0;
  for (const b of rows.rows) {
    if (excludeBookingId && Number(b.id) === Number(excludeBookingId)) continue;
    const wd = workDatesForBooking(b.start_date, b.end_date);
    const overlap = wd.filter(d => days.includes(d)).length;
    if (overlap > 0) {
      const capDays = b.capacity_days != null && b.capacity_days !== '' ? Number(b.capacity_days) : (Number(b.days) || 1);
      load += (capDays / wd.length) * overlap;
    }
  }
  return load;
}

// Fordeler et ønsket antal kapacitetsdage ud over så mange uger som nødvendigt,
// og fylder hver uges RESTERENDE kapacitet op før resten rykker videre til
// næste uge — i stedet for at proppe alle dagene ind i den første uge.
async function splitCapacityAcrossWeeks(userId, weeklyCapacity, startDate, totalDays, excludeBookingId) {
  const segments = [];
  let remaining = Math.max(0.25, Number(totalDays) || 1);
  let weekStart = mondayOfDate(startDate);
  let guard = 0;
  while (remaining > 0.001 && guard < 26) { // sikkerhedsloft: maks ~ét halvt år frem
    guard++;
    const alreadyBooked = await weeklyLoadForUser(userId, weekStart, excludeBookingId);
    const capThisWeek = Math.max(0, weeklyCapacity - alreadyBooked);
    const takeThisWeek = Math.min(remaining, capThisWeek > 0.001 ? capThisWeek : remaining);
    if (takeThisWeek > 0.001) {
      const segmentStart = segments.length === 0 ? startDate : weekStart;
      // Slutdatoen er altid ugens fredag. capacity_days er en belastnings-mængde
      // (kan sagtens være >5 for en medarbejder med høj ugekapacitet), ikke et
      // bogstaveligt antal kalenderdage — matcher hvordan udnyttelsen allerede
      // beregnes proportionalt (capacity_days / antal hverdage i intervallet).
      const fri = new Date(`${weekStart}T12:00:00`);
      fri.setDate(fri.getDate() + 4);
      const segmentEnd = `${fri.getFullYear()}-${String(fri.getMonth() + 1).padStart(2, '0')}-${String(fri.getDate()).padStart(2, '0')}`;
      segments.push({ start_date: segmentStart, end_date: segmentEnd, capacity_days: Math.round(takeThisWeek * 4) / 4, week_key: getWeekKey(weekStart) });
      remaining -= takeThisWeek;
    }
    const next = new Date(`${weekStart}T12:00:00`);
    next.setDate(next.getDate() + 7);
    weekStart = `${next.getFullYear()}-${String(next.getMonth() + 1).padStart(2, '0')}-${String(next.getDate()).padStart(2, '0')}`;
  }
  // Hvis medarbejderen aldrig har ledig kapacitet (fx alt allerede overbooket),
  // så læg i det mindste ÉN samlet blok ind i stedet for slet ingenting.
  if (!segments.length) {
    segments.push({ start_date: startDate, end_date: addWorkingDays(startDate, totalDays), capacity_days: totalDays, week_key: getWeekKey(startDate) });
  }
  return segments;
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

// JobTreads eget job-niveau custom field "Projekt Type" (id 22PZehK6FjNh) er den
// RIGTIGE faggruppe, sat af sælgeren på sagen — langt mere pålidelig end at gætte
// ud fra opgavenavnet. Bruges når den findes; ellers falder vi tilbage til guessType().
const PROJEKT_TYPE_FIELD_ID = '22PZehK6FjNh';
const PROJEKT_TYPE_TO_TYPE_GUESS = { 'Gulvslibning': 'sand', 'Gulvlægning': 'lay', 'Maler': 'paint', 'Enterprise': 'other' };
function projektTypeFromJob(job) {
  const nodes = listNodes(job?.customFieldValues);
  for (const fv of nodes) {
    const label = fv?.customField?.name;
    if (label === 'Projekt Type' && fv?.value) return PROJEKT_TYPE_TO_TYPE_GUESS[fv.value] || null;
  }
  return null;
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

// Økonomi er bevidst strengere end almindelig adminOnly: den slår altid databasen
// op live i stedet for at stole på JWT'en (som kan være op til 30 dage gammel og
// derfor ikke nødvendigvis afspejler at nogens adgang lige er blevet fjernet).
async function financeOnly(req, res, next) {
  try {
    const row = await pgOne('SELECT is_finance_admin FROM users WHERE id=$1 AND active=1', [req.user.id]);
    if (!row || !row.is_finance_admin) return res.status(403).json({ error: 'Ingen adgang til Økonomi' });
    next();
  } catch (error) {
    res.status(500).json({ error: 'Kunne ikke tjekke adgang' });
  }
}

async function pgOne(sql, values = []) {
  const result = await pool.query(sql, values);
  return result.rows[0] || null;
}

// Skriver til systemloggen, så admin kan se hvad der er kørt automatisk i baggrunden
// — synk, notifikationsscan osv. — uden at skulle ind i Renders serverlogs. Fejler
// den selv, printes bare en konsol-advarsel; systemloggen må aldrig kunne vælte en
// baggrundsopgave.
async function logSystemEvent(source, level, message) {
  try {
    await pool.query('INSERT INTO system_log (source, level, message) VALUES ($1,$2,$3)', [source, level, String(message).slice(0, 2000)]);
  } catch (e) {
    console.error('Kunne ikke skrive til systemlog:', e.message);
  }
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
  res.json({ token, user: { id: user.id, name: user.name, role: user.role, email: user.email, color: user.color, initials: user.initials, avatar_url: user.avatar_url, is_finance_admin: !!user.is_finance_admin } });
}));

app.get('/api/auth/me', auth, asyncRoute(async (req, res) => {
  const user = await pgOne('SELECT id,name,email,role,color,initials,avatar_url,is_finance_admin FROM users WHERE id=$1', [req.user.id]);
  if (!user) return res.status(401).json({ error: 'Bruger ikke fundet' });
  res.json(user);
}));

// Kun en eksisterende Økonomi-bruger kan give/fjerne adgang for andre — forhindrer
// at en almindelig admin selv kan tildele sig selv adgang til de følsomme tal.
app.put('/api/users/:id/finance-access', auth, financeOnly, asyncRoute(async (req, res) => {
  const grant = !!(req.body || {}).grant;
  const target = await pgOne('SELECT id,role FROM users WHERE id=$1', [req.params.id]);
  if (!target) return res.status(404).json({ error: 'Brugeren blev ikke fundet' });
  if (target.role !== 'admin') return res.status(400).json({ error: 'Kun admin-brugere kan få adgang til Økonomi' });
  await pool.query('UPDATE users SET is_finance_admin=$1 WHERE id=$2', [grant ? 1 : 0, target.id]);
  res.json({ ok: true });
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
  if (body.completion_email_subject !== undefined) entries.push(['completion_email_subject', String(body.completion_email_subject).slice(0, 300)]);
  if (body.completion_email_body !== undefined) entries.push(['completion_email_body', String(body.completion_email_body).slice(0, 5000)]);
  if (body.cleaning_pdf_base64 !== undefined) entries.push(['cleaning_pdf_base64', body.cleaning_pdf_base64 ? String(body.cleaning_pdf_base64).slice(0, 15000000) : null]);
  if (body.cleaning_pdf_filename !== undefined) entries.push(['cleaning_pdf_filename', body.cleaning_pdf_filename ? String(body.cleaning_pdf_filename).slice(0, 200) : null]);
  for (const [key, value] of entries) {
    await pool.query(`
      INSERT INTO app_settings (key, value) VALUES ($1,$2)
      ON CONFLICT (key) DO UPDATE SET value=EXCLUDED.value
    `, [key, value]);
  }
  res.json({ ok: true });
}));

app.get('/api/settings/completion-email', auth, adminOnly, asyncRoute(async (req, res) => {
  const rows = await pool.query(
    "SELECT key,value FROM app_settings WHERE key IN ('completion_email_subject','completion_email_body','cleaning_pdf_filename')"
  );
  const map = {};
  rows.rows.forEach(r => { map[r.key] = r.value; });
  const pdfRow = await pgOne("SELECT value FROM app_settings WHERE key='cleaning_pdf_base64'");
  res.json({
    subject: map.completion_email_subject || 'Vi er færdige hos dig — {kunde}',
    body: map.completion_email_body || 'Hej,\n\nVi vil gerne informere dig om, at vi nu er færdige med arbejdet hos dig ({opgave}).\n\nVedhæftet finder du en vejledning til efterbehandling/rengøring.\n\nMange tak for denne gang!\n\nVenlig hilsen\n{firma}',
    has_pdf: !!(pdfRow && pdfRow.value),
    pdf_filename: map.cleaning_pdf_filename || null,
    mail_configured: mailIsConfigured()
  });
}));

app.post('/api/settings/test-completion-email', auth, adminOnly, asyncRoute(async (req, res) => {
  const toEmail = String((req.body || {}).to || '').trim();
  if (!toEmail) return res.status(400).json({ error: 'Skriv en e-mailadresse at teste med' });
  if (!mailIsConfigured()) return res.status(400).json({ error: 'Hverken Resend eller SMTP er sat op endnu (mangler miljøvariabler på serveren)' });
  try {
    // Til en ren test sender vi direkte med skabelonen, uden at kræve en rigtig opgave:
    const settingsRows = await pool.query(
      "SELECT key,value FROM app_settings WHERE key IN ('company_name','completion_email_subject','completion_email_body','cleaning_pdf_base64','cleaning_pdf_filename')"
    );
    const settings = {};
    settingsRows.rows.forEach(r => { settings[r.key] = r.value; });
    const companyName = settings.company_name || 'Gulv Master Enterprise ApS';
    const subject = (settings.completion_email_subject || 'Vi er færdige hos dig — {kunde}').replace('{kunde}', 'Test-kunde').replace('{firma}', companyName);
    const bodyTemplate = settings.completion_email_body || 'Hej,\n\nDette er en TEST af færdig-mailen.\n\nVenlig hilsen\n{firma}';
    const bodyText = bodyTemplate.replace('{opgave}', 'Test-opgave').replace('{kunde}', 'Test-kunde').replace('{firma}', companyName);
    const attachments = [];
    if (settings.cleaning_pdf_base64) {
      attachments.push({ filename: settings.cleaning_pdf_filename || 'test.pdf', content: Buffer.from(settings.cleaning_pdf_base64, 'base64'), contentType: 'application/pdf' });
    }
    await sendMailUniversal({ to: toEmail, subject: '[TEST] ' + subject, text: bodyText, attachments });
    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ error: redactSecret(e.message || 'Ukendt fejl').slice(0, 500) });
  }
}));

// Log over kunde-planlægnings/påmindelsesmails — så du selv kan se PRÆCIS hvornår
// hver mail blev sendt, og bekræfte at "vi kommer i morgen" kun sendes når du selv
// trykker (tidsstemplerne vil klumpe sig om det tidspunkt du trykkede, ikke kl. 15
// hver dag, hvis det virker som det skal).
app.get('/api/customer-schedule-emails', auth, adminOnly, asyncRoute(async (req, res) => {
  const result = await pool.query(`
    SELECT cse.id, cse.booking_id, cse.task_id, cse.kind, cse.to_email, cse.status, cse.error, cse.sent_at,
           t.job_name, t.name AS task_name
    FROM customer_schedule_emails cse
    LEFT JOIN jt_tasks t ON t.id = cse.task_id
    ORDER BY cse.sent_at DESC
    LIMIT 300
  `);
  res.json(result.rows);
}));

// Log over afsendte/fejlede færdig-mails — så man kan se om en kunde-mail
// rent faktisk kom afsted, og hvad fejlen var hvis ikke.
app.get('/api/completion-emails', auth, adminOnly, asyncRoute(async (req, res) => {
  const result = await pool.query(`
    SELECT ce.id, ce.booking_id, ce.task_id, ce.to_email, ce.status, ce.error, ce.sent_at,
           t.job_name, t.name AS task_name, u.name AS user_name
    FROM completion_emails ce
    LEFT JOIN jt_tasks t ON t.id = ce.task_id
    LEFT JOIN planning_bookings pb ON pb.id = ce.booking_id
    LEFT JOIN users u ON u.id = pb.user_id
    ORDER BY ce.sent_at DESC
    LIMIT 300
  `);
  res.json(result.rows);
}));


// ── FAG & FARVER (opgave-typer) ─────────────────────────────
// Styrer hvilke fag/faggrupper der findes, og hvilken farve hver af dem har i
// Daglig plan/Ugeplan og på opgavekortene. Kapacitetsboardet bruger bevidst
// ÉN ensartet farve for alle opgaver (uanset fag), så den forbliver rolig at overskue.
app.get('/api/task-types', auth, asyncRoute(async (req, res) => {
  const result = await pool.query('SELECT key,label,color,sort_order FROM task_types ORDER BY sort_order,label');
  res.json(result.rows);
}));

function slugifyTypeKey(label) {
  return String(label || '').toLowerCase()
    .replace(/[æå]/g, 'a').replace(/ø/g, 'o')
    .replace(/[^a-z0-9]+/g, '-').replace(/(^-+|-+$)/g, '').slice(0, 40) || `fag-${Date.now()}`;
}

app.post('/api/task-types', auth, adminOnly, asyncRoute(async (req, res) => {
  const body = req.body || {};
  const label = String(body.label || '').trim().slice(0, 60);
  if (!label) return res.status(400).json({ error: 'Skriv et navn på faget' });
  const color = /^#[0-9A-Fa-f]{6}$/.test(body.color || '') ? body.color : '#2563EB';
  let key = slugifyTypeKey(body.key || label);
  const existing = await pgOne('SELECT key FROM task_types WHERE key=$1', [key]);
  if (existing) key = `${key}-${Date.now().toString(36)}`;
  const maxOrder = await pgOne('SELECT COALESCE(MAX(sort_order),0) AS m FROM task_types');
  await pool.query(
    'INSERT INTO task_types (key,label,color,sort_order) VALUES ($1,$2,$3,$4)',
    [key, label, color, (Number(maxOrder?.m) || 0) + 1]
  );
  res.json({ ok: true, key });
}));

app.put('/api/task-types/:key', auth, adminOnly, asyncRoute(async (req, res) => {
  const row = await pgOne('SELECT * FROM task_types WHERE key=$1', [req.params.key]);
  if (!row) return res.status(404).json({ error: 'Faget blev ikke fundet' });
  const body = req.body || {};
  const label = body.label !== undefined ? String(body.label).trim().slice(0, 60) || row.label : row.label;
  const color = body.color !== undefined ? (/^#[0-9A-Fa-f]{6}$/.test(body.color) ? body.color : row.color) : row.color;
  await pool.query('UPDATE task_types SET label=$1,color=$2 WHERE key=$3', [label, color, row.key]);
  res.json({ ok: true });
}));

app.delete('/api/task-types/:key', auth, adminOnly, asyncRoute(async (req, res) => {
  if (req.params.key === 'other') return res.status(400).json({ error: '"Andet" kan ikke slettes — den bruges som standardfarve' });
  const inUse = await pgOne('SELECT id FROM jt_tasks WHERE type_guess=$1 LIMIT 1', [req.params.key]);
  if (inUse) return res.status(400).json({ error: 'Faget er i brug på mindst én opgave — skift deres fag først' });
  const result = await pool.query('DELETE FROM task_types WHERE key=$1', [req.params.key]);
  if (!result.rowCount) return res.status(404).json({ error: 'Faget blev ikke fundet' });
  res.json({ ok: true });
}));

// ── USERS / WORKFORCE ───────────────────────────────────────
app.get('/api/users', auth, adminOnly, asyncRoute(async (req, res) => {
  const result = await pool.query(`
    SELECT id,name,email,role,color,initials,jobtread_name,active,worker_type,vendor_group,trade,weekly_capacity,avatar_url,COALESCE(can_login,1) AS can_login,personal_email,COALESCE(notify_schedule_changes,0) AS notify_schedule_changes,COALESCE(is_finance_admin,0) AS is_finance_admin
    FROM users
    ORDER BY CASE WHEN role='admin' THEN 0 ELSE 1 END,
             CASE WHEN worker_type='vendor' THEN 1 ELSE 0 END,
             vendor_group NULLS FIRST,
             name
  `);
  res.json(result.rows);
}));

const PUBLIC_APP_URL = process.env.RENDER_EXTERNAL_URL || process.env.PUBLIC_URL || 'https://gulvmaster.onrender.com';
async function createPasswordResetToken(userId) {
  const rawToken = crypto.randomBytes(32).toString('hex');
  const hashed = crypto.createHash('sha256').update(rawToken).digest('hex');
  const expires = new Date(Date.now() + 72 * 3600 * 1000).toISOString();
  await pool.query('UPDATE users SET password_reset_token=$1, password_reset_expires=$2 WHERE id=$3', [hashed, expires, userId]);
  return rawToken;
}
async function sendLoginGuideEmail(user, rawToken) {
  if (!mailIsConfigured()) return { sent: false, reason: 'E-mail er ikke konfigureret på serveren' };
  const to = user.personal_email || user.email;
  if (!to) return { sent: false, reason: 'Medarbejderen har ingen e-mail' };
  const settingsRows = await pool.query("SELECT key,value FROM app_settings WHERE key='company_name'");
  const companyName = settingsRows.rows[0]?.value || 'Gulv Master Enterprise ApS';
  const link = `${PUBLIC_APP_URL}/set-password?token=${rawToken}`;
  const subject = `Velkommen — sæt din adgangskode (${companyName})`;
  const text = `Hej ${user.name},\n\nDu er nu oprettet i vores planlægningssystem.\n\nLogin: ${user.email}\n\nKlik her for at sætte din egen adgangskode (linket virker i 72 timer):\n${link}\n\nEfter du har sat din adgangskode, kan du logge ind på ${PUBLIC_APP_URL}/employee\n\nVenlig hilsen\n${companyName}`;
  try {
    await sendMailUniversal({ to, subject, text, html: text.split('\n').map(l => l ? `<p>${l.replace(/</g, '&lt;')}</p>` : '<br>').join('') });
    return { sent: true };
  } catch (e) { return { sent: false, reason: redactSecret(e.message || '').slice(0, 500) }; }
}

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
      INSERT INTO users (name,email,password_hash,role,color,initials,jobtread_name,active,worker_type,vendor_group,trade,weekly_capacity,can_login,avatar_url,personal_email,notify_schedule_changes)
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16)
      RETURNING id
    `, [String(body.name).trim(), email, bcrypt.hashSync(password, 10), role, body.color || '#2563EB', initials, body.jobtread_name || null, body.active === 0 ? 0 : 1, workerType, body.vendor_group || null, body.trade || null, weeklyCapacity, canLogin ? 1 : 0, body.avatar_url || null, body.personal_email || null, body.notify_schedule_changes ? 1 : 0]);
    res.json({ ok: true, id: result.rows[0].id });
    // Send login-vejledning, så medarbejderen selv kan sætte sin adgangskode —
    // kun relevant for brugere der faktisk kan logge ind.
    if (canLogin) {
      (async () => {
        const newUser = await pgOne('SELECT * FROM users WHERE id=$1', [result.rows[0].id]);
        const token = await createPasswordResetToken(newUser.id);
        const r = await sendLoginGuideEmail(newUser, token);
        if (!r.sent) console.error('Login-vejledning kunne ikke sendes:', r.reason);
      })().catch(e => console.error('Login-vejledning fejlede:', e.message));
    }
  } catch (error) {
    if (error.code === '23505') return res.status(400).json({ error: 'Email er allerede i brug' });
    throw error;
  }
}));

// Manuel gensendelse af login-vejledningen (fx hvis medarbejderen har mistet mailen).
app.post('/api/users/:id/send-login-guide', auth, adminOnly, asyncRoute(async (req, res) => {
  const user = await pgOne('SELECT * FROM users WHERE id=$1', [req.params.id]);
  if (!user) return res.status(404).json({ error: 'Medarbejderen blev ikke fundet' });
  if (!user.can_login) return res.status(400).json({ error: 'Denne bruger kan ikke logge ind' });
  const token = await createPasswordResetToken(user.id);
  const r = await sendLoginGuideEmail(user, token);
  if (!r.sent) return res.status(400).json({ error: r.reason || 'Kunne ikke sende mailen' });
  res.json({ ok: true });
}));

// Offentligt (uden login) — bruges af set-password-siden til selv at vælge en ny adgangskode.
app.post('/api/set-password', asyncRoute(async (req, res) => {
  const { token, password } = req.body || {};
  if (!token || !password || String(password).length < 6) return res.status(400).json({ error: 'Adgangskoden skal være mindst 6 tegn' });
  const hashed = crypto.createHash('sha256').update(String(token)).digest('hex');
  const user = await pgOne('SELECT * FROM users WHERE password_reset_token=$1', [hashed]);
  if (!user) return res.status(400).json({ error: 'Linket er ugyldigt eller allerede brugt' });
  if (!user.password_reset_expires || new Date(user.password_reset_expires) < new Date()) return res.status(400).json({ error: 'Linket er udløbet — bed om et nyt' });
  await pool.query('UPDATE users SET password_hash=$1, password_reset_token=NULL, password_reset_expires=NULL WHERE id=$2', [bcrypt.hashSync(String(password), 10), user.id]);
  res.json({ ok: true });
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
    avatar_url: body.avatar_url !== undefined ? (body.avatar_url || null) : current.avatar_url,
    personal_email: body.personal_email !== undefined ? (body.personal_email || null) : current.personal_email,
    notify_schedule_changes: body.notify_schedule_changes !== undefined ? (body.notify_schedule_changes ? 1 : 0) : current.notify_schedule_changes
  };
  if (canLogin && !next.email) return res.status(400).json({ error: 'Email mangler for login-bruger' });
  try {
    await pool.query(`
      UPDATE users SET name=$1,email=$2,password_hash=$3,role=$4,color=$5,initials=$6,jobtread_name=$7,active=$8,worker_type=$9,vendor_group=$10,trade=$11,weekly_capacity=$12,can_login=$13,avatar_url=$14,personal_email=$15,notify_schedule_changes=$16
      WHERE id=$17
    `, [next.name, next.email, next.password_hash, next.role, next.color, next.initials, next.jobtread_name, next.active, next.worker_type, next.vendor_group, next.trade, next.weekly_capacity, next.can_login, next.avatar_url, next.personal_email, next.notify_schedule_changes, id]);
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

// ── FÆRDIG-MAIL TIL KUNDEN (afsendes når en medarbejder markerer en opgave færdig) ──
// To måder at sætte det op på — brug den der er nemmest for jer:
//
// A) Resend (anbefales — ingen Workspace-administrator-godkendelse nødvendig):
//    Opret gratis på resend.com, verificér jeres domæne (eller brug deres test-adresse
//    til at komme i gang med det samme), og sæt kun ÉN miljøvariabel på Render:
//      RESEND_API_KEY
//    (valgfrit: RESEND_FROM, ellers bruges "Gulv Master <onboarding@resend.dev>")
//
// B) Almindelig SMTP (kræver at jeres mailudbyder tillader App Passwords):
//      SMTP_HOST, SMTP_PORT, SMTP_USER, SMTP_PASS, SMTP_FROM (valgfri)
//
// Er ingen af delene sat op, er funktionen bevidst en stille no-op.
let mailTransport;
function getMailTransport() {
  if (mailTransport !== undefined) return mailTransport;
  if (!process.env.SMTP_HOST || !process.env.SMTP_USER || !process.env.SMTP_PASS) {
    mailTransport = null;
    return mailTransport;
  }
  mailTransport = nodemailer.createTransport({
    host: process.env.SMTP_HOST,
    port: Number(process.env.SMTP_PORT) || 587,
    secure: Number(process.env.SMTP_PORT) === 465,
    auth: { user: process.env.SMTP_USER, pass: process.env.SMTP_PASS }
  });
  return mailTransport;
}

function mailIsConfigured() {
  return !!process.env.RESEND_API_KEY || !!getMailTransport();
}

async function sendMailUniversal({ to, subject, text, html, attachments }) {
  if (process.env.RESEND_API_KEY) {
    const response = await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${process.env.RESEND_API_KEY}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        from: process.env.RESEND_FROM || 'Gulv Master <onboarding@resend.dev>',
        to: [to],
        subject,
        text,
        html,
        attachments: (attachments || []).map(a => ({
          filename: a.filename,
          content: a.content.toString('base64')
        }))
      })
    });
    if (!response.ok) {
      const raw = await response.text();
      throw new Error(`Resend HTTP ${response.status}: ${raw.slice(0, 400)}`);
    }
    return;
  }
  const transport = getMailTransport();
  if (!transport) throw new Error('Hverken RESEND_API_KEY eller SMTP er sat op');
  await transport.sendMail({ from: process.env.SMTP_FROM || process.env.SMTP_USER, to, subject, text, html, attachments });
}

async function sendCompletionEmail(booking) {
  if (!mailIsConfigured()) {
    // Ikke sat op endnu — log det stille, så det kan ses i mail-loggen i stedet for at forsvinde sporløst.
    await pool.query(
      'INSERT INTO completion_emails (booking_id,task_id,to_email,status,error,sent_at) VALUES ($1,$2,$3,$4,$5,' + nowTextSQL() + ')',
      [booking.id, booking.task_id, null, 'skipped', 'Mail er ikke sat op på serveren (RESEND_API_KEY/SMTP mangler)']
    );
    return;
  }

  const task = await pgOne('SELECT * FROM jt_tasks WHERE id=$1', [booking.task_id]);
  const toEmail = task?.customer_email;
  if (!toEmail) {
    // Ingen e-mail registreret på denne kunde — log det, så man kan opdage manglende kunde-mails.
    await pool.query(
      'INSERT INTO completion_emails (booking_id,task_id,to_email,status,error,sent_at) VALUES ($1,$2,$3,$4,$5,' + nowTextSQL() + ')',
      [booking.id, booking.task_id, null, 'skipped', 'Ingen e-mail registreret på kunden']
    );
    return;
  }

  const settingsRows = await pool.query(
    "SELECT key,value FROM app_settings WHERE key IN ('company_name','completion_email_subject','completion_email_body','cleaning_pdf_base64','cleaning_pdf_filename')"
  );
  const settings = {};
  settingsRows.rows.forEach(r => { settings[r.key] = r.value; });

  const companyName = settings.company_name || 'Gulv Master Enterprise ApS';
  const jobName = task?.job_name || 'din opgave';
  const subject = (settings.completion_email_subject || 'Vi er færdige hos dig — {kunde}')
    .replace('{kunde}', jobName).replace('{firma}', companyName);
  const bodyTemplate = settings.completion_email_body ||
    'Hej,\n\nVi vil gerne informere dig om, at vi nu er færdige med arbejdet hos dig ({opgave}).\n\nVedhæftet finder du en vejledning til efterbehandling/rengøring.\n\nMange tak for denne gang!\n\nVenlig hilsen\n{firma}';
  const bodyText = bodyTemplate.replace('{opgave}', jobName).replace('{kunde}', jobName).replace('{firma}', companyName);
  const bodyHtml = bodyText.split('\n').map(line => line ? `<p>${line.replace(/</g, '&lt;')}</p>` : '<br>').join('');

  const attachments = [];
  if (settings.cleaning_pdf_base64) {
    attachments.push({
      filename: settings.cleaning_pdf_filename || 'Rengoering-og-efterbehandling.pdf',
      content: Buffer.from(settings.cleaning_pdf_base64, 'base64'),
      contentType: 'application/pdf'
    });
  }

  let status = 'sent', error = null;
  try {
    await sendMailUniversal({ to: toEmail, subject, text: bodyText, html: bodyHtml, attachments });
  } catch (e) {
    status = 'error';
    error = redactSecret(e.message || 'Ukendt fejl').slice(0, 500);
    console.error('Kunne ikke sende færdig-mail:', error);
  }
  await pool.query(
    'INSERT INTO completion_emails (booking_id,task_id,to_email,status,error,sent_at) VALUES ($1,$2,$3,$4,$5,' + nowTextSQL() + ')',
    [booking.id, booking.task_id, toEmail, status, error]
  );
}

// ── ZAPIER-WEBHOOK VED FÆRDIG OPGAVE ──
// Alternativ/supplement til den direkte mail — nyttig hvis I hellere vil sende
// rengørings-mailen via jeres eget Gmail/Outlook gennem Zapier (undgår helt
// SMTP-opsætning/Workspace-administrator-godkendelse). Sæt miljøvariablen
// ZAPIER_WEBHOOK_URL til en "Catch Hook"-URL fra en Zapier "Webhooks by
// Zapier"-trigger, så kan I bygge resten af automatiseringen i Zapier selv
// (fx: send Gmail med jeres egen skabelon og vedhæftning).
async function sendCompletionWebhook(booking) {
  const url = process.env.ZAPIER_WEBHOOK_URL;
  if (!url) return; // Ikke sat op — spring stille over.

  const task = await pgOne('SELECT * FROM jt_tasks WHERE id=$1', [booking.task_id]);
  const user = await pgOne('SELECT name FROM users WHERE id=$1', [booking.user_id]);
  const settingsRow = await pgOne("SELECT value FROM app_settings WHERE key='company_name'");

  const payload = {
    event: 'task_completed',
    company_name: settingsRow?.value || 'Gulv Master Enterprise ApS',
    task_id: booking.task_id,
    booking_id: booking.id,
    job_name: task?.job_name || null,
    job_number: task?.job_number || null,
    job_address: task?.job_address || null,
    customer_email: task?.customer_email || null,
    customer_phone: task?.customer_phone || null,
    completed_by: user?.name || null,
    completed_at: new Date().toISOString(),
    jobtread_url: task?.jt_url || null
  };

  try {
    const response = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload)
    });
    if (!response.ok) throw new Error(`Zapier webhook HTTP ${response.status}`);
  } catch (e) {
    console.error('Kunne ikke sende Zapier-webhook:', e.message);
  }
}

// ── MAIL TIL MEDARBEJDER/VENDOR VED ÆNDRING AF DERES KALENDER ──
// Kun aktiv hvis den enkelte medarbejder har slået det til (notify_schedule_changes)
// OG har en privat mailadresse registreret. Sendes stille i baggrunden — påvirker
// aldrig selve gemningen af bookingen, uanset om mailen lykkes eller ej.
async function sendScheduleChangeEmail(userId, summary) {
  try {
    if (!mailIsConfigured()) return;
    const user = await pgOne('SELECT * FROM users WHERE id=$1', [userId]);
    if (!user || !user.notify_schedule_changes || !user.personal_email) return;
    const settingsRow = await pgOne("SELECT value FROM app_settings WHERE key='company_name'");
    const companyName = settingsRow?.value || 'Gulv Master Enterprise ApS';
    const subject = `Din kalender er blevet opdateret — ${companyName}`;
    const text = `Hej ${user.name},\n\n${summary}\n\nLog ind på din side for at se hele din kalender.\n\nVenlig hilsen\n${companyName}`;
    const html = text.split('\n').map(line => line ? `<p>${line.replace(/</g, '&lt;')}</p>` : '<br>').join('');
    await sendMailUniversal({ to: user.personal_email, subject, text, html });
  } catch (e) {
    console.error('Kunne ikke sende kalender-ændrings-mail:', e.message);
  }
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
          description: {},
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
        tasks: { $: args, nextPage: {}, nodes: { id: {}, name: {}, description: {}, startDate: {}, endDate: {}, job: { id: {} } } }
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
          INSERT INTO jt_tasks (id,name,job_id,job_name,job_address,job_number,description,start_date,end_date,type_guess,raw_assignee_name,jt_url,synced_at,source)
          VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,${nowTextSQL()},'jobtread')
          ON CONFLICT (id) DO UPDATE SET
            name=EXCLUDED.name, job_id=EXCLUDED.job_id, job_name=EXCLUDED.job_name,
            job_address=EXCLUDED.job_address,
            job_number=COALESCE(EXCLUDED.job_number, jt_tasks.job_number),
            description=COALESCE(NULLIF(EXCLUDED.description,''), jt_tasks.description),
            start_date=EXCLUDED.start_date,
            end_date=EXCLUDED.end_date, type_guess=EXCLUDED.type_guess,
            raw_assignee_name=EXCLUDED.raw_assignee_name, jt_url=EXCLUDED.jt_url,
            synced_at=EXCLUDED.synced_at, source='jobtread'
        `, [
          task.id, task.name || '', jobId,
          customerName || ji.name || '', ji.address || '', ji.number || null,
          task.description || '',
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
    syncVendorsFromJT().catch(e => console.error('Baggrunds-vendor-synk fejlede:', e.message));

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

function possibleEmail(value) {
  const text = String(value == null ? '' : value).trim();
  if (!text) return '';
  const match = text.match(/[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}/);
  return match ? match[0].toLowerCase() : '';
}

function isEmailFieldLabel(label) {
  const normalized = String(label || '').toLowerCase().replace(/[._-]+/g, ' ').replace(/\s+/g, ' ').trim();
  return /(?:^|\s)(email|e mail|mail)(?:\s|$)/.test(normalized);
}

function emailsFromValue(value, output = [], seen = new Set()) {
  if (value == null || seen.has(value)) return output;
  if (typeof value === 'string' || typeof value === 'number') {
    const text = String(value).trim();
    const direct = possibleEmail(text);
    if (direct) output.push(direct);
    if (typeof value === 'string' && /^[{[]/.test(text)) {
      try { emailsFromValue(JSON.parse(text), output, seen); } catch (_) {}
    }
    return output;
  }
  if (typeof value !== 'object') return output;
  seen.add(value);
  if (Array.isArray(value)) {
    value.forEach(item => emailsFromValue(item, output, seen));
    return output;
  }
  ['email', 'emailAddress', 'value', 'formattedValue', 'rawValue'].forEach(key => {
    if (Object.prototype.hasOwnProperty.call(value, key)) emailsFromValue(value[key], output, seen);
  });
  return output;
}

function firstEmailFromFields(fieldValues, stats) {
  for (const fieldValue of listNodes(fieldValues)) {
    const label = phoneFieldLabel(fieldValue);
    if (!isEmailFieldLabel(label)) continue;
    stats.email_fields_matched = (stats.email_fields_matched || 0) + 1;
    const candidate = emailsFromValue(fieldValue?.value)[0] || '';
    if (candidate) return { email: candidate, label };
  }
  return null;
}

function emailFromJobContact(job, stats) {
  const containers = [];
  const location = job?.location || {};
  if (location?.contact) containers.push(location.contact);
  const account = location?.account || {};
  if (account?.primaryContact) containers.push(account.primaryContact);
  listNodes(account?.contacts).forEach(contact => containers.push(contact));

  for (const contact of containers) {
    const match = firstEmailFromFields(contact?.customFieldValues, stats);
    if (match) return match;
  }
  return null;
}

async function syncCustomerPhonesFromJT() {
  if (phoneSyncRunning) return { ok: false, error: 'Der kører allerede et telefonopslag' };
  if (!JT_GRANT || !JT_ORG) return { ok: false, error: 'JobTread Grant Key eller Organisation ID mangler' };

  phoneSyncRunning = true;
  const phoneByJob = new Map();
  const emailByJob = new Map();
  const stats = { jobs_scanned: 0, contacts_scanned: 0, fields_scanned: 0, phone_fields_matched: 0, email_fields_matched: 0, pages: 0 };

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
        const phoneMatch = phoneFromJobContact(job, stats);
        if (phoneMatch?.phone) phoneByJob.set(String(job.id), phoneMatch);
        const emailMatch = emailFromJobContact(job, stats);
        if (emailMatch?.email) emailByJob.set(String(job.id), emailMatch);
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
      let emailUpdated = 0;
      for (const [jobId, contact] of emailByJob.entries()) {
        const result = await client.query(`
          UPDATE jt_tasks
          SET customer_email=$1,
              customer_email_source='jobtread',
              customer_email_synced_at=${nowTextSQL()}
          WHERE job_id=$2
            AND source='jobtread'
            AND COALESCE(customer_email_source,'') <> 'manual'
            AND (
              customer_email IS NULL OR customer_email='' OR
              customer_email_source='jobtread' OR customer_email <> $1
            )
        `, [contact.email, jobId]);
        emailUpdated += result.rowCount;
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
      email_found: emailByJob.size,
      jobs_scanned: stats.jobs_scanned,
      contacts_scanned: stats.contacts_scanned,
      phone_fields_matched: stats.phone_fields_matched,
      email_fields_matched: stats.email_fields_matched,
      pages: stats.pages
    };
    await writeSyncLog(0, 'ok', `Kundetelefon: ${result.found} jobs med nummer, ${updated} task(s) opdateret. Kunde-e-mail: ${emailByJob.size} jobs med e-mail fundet. ${stats.jobs_scanned} jobs / ${stats.contacts_scanned} kontakter gennemgået.`);
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

// ── AUTOMATISK VENDOR-SYNK ──
// Henter alle "vendor"-konti fra JobTread og opretter/opdaterer dem som
// underleverandører i Hold & vendors, så de ikke skal oprettes manuelt to
// steder. Rører ALDRIG en vendor, der allerede findes og er redigeret manuelt
// (fx tilføjet Fag, kapacitet, privat mail) — opdaterer kun navnet, hvis det
// er ændret i JobTread, og opretter aldrig dubletter.
let vendorSyncRunning = false;
async function syncVendorsFromJT() {
  if (vendorSyncRunning) return { ok: false, skipped: true };
  if (!JT_GRANT || !JT_ORG) return { ok: false, error: 'JobTread er ikke sat op' };
  vendorSyncRunning = true;
  let created = 0, renamed = 0;
  try {
    let cursor, page = 0;
    const seen = [];
    while (page < 20) {
      const args = { size: 100, where: ['type', 'vendor'] };
      if (cursor) args.page = cursor;
      const data = await jtFetch({
        query: { $: { grantKey: JT_GRANT }, organization: { $: { id: JT_ORG }, accounts: { $: args, nextPage: {}, nodes: { id: {}, name: {} } } } }
      }, `Vendor-synk s.${page + 1}`);
      const conn = data?.organization?.accounts || data?.query?.organization?.accounts || {};
      const nodes = Array.isArray(conn.nodes) ? conn.nodes : [];
      for (const acc of nodes) {
        if (!acc?.id || !acc?.name) continue;
        seen.push(acc.id);
        const name = String(acc.name).trim().slice(0, 200);
        const existing = await pgOne('SELECT id,name FROM users WHERE jt_vendor_account_id=$1', [acc.id]);
        if (existing) {
          if (existing.name !== name) {
            await pool.query('UPDATE users SET name=$1, vendor_group=$1 WHERE id=$2', [name, existing.id]);
            renamed++;
          }
        } else {
          // Undgå dubletter hvis en vendor med samme navn allerede blev oprettet manuelt
          // (før denne funktion fandtes) — kobl den til JobTread i stedet for at lave en ny.
          const byName = await pgOne("SELECT id FROM users WHERE worker_type='vendor' AND jt_vendor_account_id IS NULL AND lower(name)=lower($1)", [name]);
          if (byName) {
            await pool.query('UPDATE users SET jt_vendor_account_id=$1 WHERE id=$2', [acc.id, byName.id]);
          } else {
            const initials = name.split(/\s+/).map(w => w[0]).filter(Boolean).slice(0, 2).join('').toUpperCase() || 'VE';
            await pool.query(`
              INSERT INTO users (name,role,color,initials,active,worker_type,vendor_group,weekly_capacity,can_login,jt_vendor_account_id)
              VALUES ($1,'employee','#7C3AED',$2,1,'vendor',$1,5,0,$3)
            `, [name, initials, acc.id]);
            created++;
          }
        }
      }
      page++;
      const next = conn.nextPage;
      if (!next || next === '') break;
      cursor = next;
    }
    if (created || renamed) await writeSyncLog(0, 'ok', `Vendor-synk: ${created} nye underleverandører oprettet, ${renamed} omdøbt.`);
    return { ok: true, created, renamed };
  } catch (error) {
    console.error('Vendor-synk fejlede:', error.message);
    return { ok: false, error: error.message };
  } finally {
    vendorSyncRunning = false;
  }
}

// ── GANTT-KORT (1:1 med et JobTread-job, tovejs-synkroniseret) ──
// Uafhængig af Daglig plan / Kapacitet — arbejder direkte på selve JobTread-jobbets
// egne opgaver, datoer og afhængigheder (taskDependencies), og skriver ændringer
// tilbage til JobTread med det samme via updateTask/createTask.
function safeJsonParse(text, fallback) {
  try { return JSON.parse(text); } catch (_) { return fallback; }
}

async function fetchGanttTasksFromJT(jobId) {
  let jobName = '';
  let phone = null, email = null, address = null, jobTypeGuess = null;
  const allTasks = [];
  let cursor, page = 0;
  const stats = {};
  while (page < 10) {
    const args = { size: 100, where: ['isToDo', false] };
    if (cursor) args.page = cursor;
    const data = await jtFetch({
      query: {
        $: { grantKey: JT_GRANT },
        job: {
          $: { id: jobId },
          id: {}, name: {},
          ...(page === 0 ? jobContactFields() : {}),
          ...(page === 0 ? { customFieldValues: { $: { size: 3, where: [['customField', 'name'], 'Projekt Type'] }, nodes: { value: {}, customField: { name: {} } } } } : {}),
          tasks: {
            $: args,
            nextPage: {},
            nodes: {
              id: {}, name: {}, description: {}, startDate: {}, endDate: {},
              progress: {}, isGroup: {}, position: {},
              parentTask: { id: {} },
              taskDependencies: { $: { size: 20 }, nodes: { dependsOnTask: { id: {} } } }
            }
          }
        }
      }
    }, `Gantt: hent job-opgaver s.${page + 1}`);
    const job = data?.job || data?.query?.job;
    if (!job) throw new Error('Jobbet blev ikke fundet i JobTread');
    jobName = job.name || jobName;
    if (page === 0) {
      phone = phoneFromJobContact(job, stats)?.phone || null;
      email = emailFromJobContact(job, stats)?.email || null;
      address = job?.location?.address || null;
      jobTypeGuess = projektTypeFromJob(job);
    }
    const nodes = job.tasks?.nodes || [];
    allTasks.push(...nodes);
    page++;
    const next = job.tasks?.nextPage;
    if (!next || next === '') break;
    cursor = next;
  }
  const tasks = allTasks.map(t => ({
    id: t.id,
    name: t.name || '',
    description: t.description || '',
    start_date: t.startDate || null,
    end_date: t.endDate || t.startDate || null,
    progress: t.progress != null ? Number(t.progress) : 0,
    is_group: !!t.isGroup,
    parent_task_id: t.parentTask?.id || null,
    position: t.position || '',
    depends_on: (t.taskDependencies?.nodes || []).map(d => d.dependsOnTask?.id).filter(Boolean),
    type_guess: jobTypeGuess || guessType(t.name)
  }));
  return { jobName, tasks, phone, email, address };
}

// Henter og cacher ALLE opgaver på tværs af HELE organisationen (ikke kun ét
// job), inkl. rigtige before/after-afhængigheder og fremgang, til "Se alle
// opgaver"-visningen. Bruger samme upsert-lager (gantt_tasks) som det
// enkelte jobs Gantt-kort, så begge visninger nyder godt af hinandens data.
let ganttAllSyncRunning = false;
async function syncAllGanttTasksFromJT() {
  if (ganttAllSyncRunning) return { ok: false, skipped: true };
  if (!JT_GRANT || !JT_ORG) return { ok: false, error: 'JobTread er ikke sat op' };
  ganttAllSyncRunning = true;
  let count = 0;
  try {
    let cursor, page = 0;
    while (page < JT_MAX_PAGES) {
      const args = { size: JT_PAGE_SIZE, where: { and: [['targetType', 'job'], ['isGroup', false], ['isToDo', false]] } };
      if (cursor) args.page = cursor;
      const data = await jtFetch({
        query: {
          $: { grantKey: JT_GRANT },
          organization: {
            $: { id: JT_ORG },
            tasks: {
              $: args,
              nextPage: {},
              nodes: {
                id: {}, name: {}, description: {}, startDate: {}, endDate: {},
                progress: {}, isGroup: {}, position: {},
                parentTask: { id: {} },
                job: { id: {}, name: {}, number: {}, location: { address: {} }, customFieldValues: { $: { size: 3, where: [['customField', 'name'], 'Projekt Type'] }, nodes: { value: {}, customField: { name: {} } } } },
                taskDependencies: { $: { size: 20 }, nodes: { dependsOnTask: { id: {} } } }
              }
            }
          }
        }
      }, `Gantt: hent alle opgaver s.${page + 1}`);
      const conn = data?.organization?.tasks || data?.query?.organization?.tasks || {};
      const nodes = Array.isArray(conn.nodes) ? conn.nodes : [];
      for (const t of nodes) {
        if (!t?.id || !t?.job?.id || !t.startDate) continue;
        const dependsOn = (t.taskDependencies?.nodes || []).map(d => d.dependsOnTask?.id).filter(Boolean);
        const jobAddress = t.job?.location?.address || null;
        const jobType = projektTypeFromJob(t.job) || guessType(t.name);
        await pool.query(`
          INSERT INTO gantt_tasks (id,job_id,job_name,job_number,name,description,start_date,end_date,progress,is_group,parent_task_id,position,depends_on,type_guess,job_address,synced_at)
          VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,${nowTextSQL()})
          ON CONFLICT (id) DO UPDATE SET
            job_id=EXCLUDED.job_id, job_name=EXCLUDED.job_name, job_number=EXCLUDED.job_number,
            name=EXCLUDED.name, description=EXCLUDED.description,
            start_date=EXCLUDED.start_date, end_date=EXCLUDED.end_date, progress=EXCLUDED.progress,
            is_group=EXCLUDED.is_group, parent_task_id=EXCLUDED.parent_task_id, position=EXCLUDED.position,
            depends_on=EXCLUDED.depends_on, type_guess=EXCLUDED.type_guess, job_address=EXCLUDED.job_address, synced_at=${nowTextSQL()}
        `, [t.id, t.job.id, t.job.name || '', t.job.number != null ? String(t.job.number) : null, t.name || '', t.description || '', t.startDate, t.endDate || t.startDate, t.progress != null ? Number(t.progress) : 0, t.isGroup ? 1 : 0, t.parentTask?.id || null, t.position || '', JSON.stringify(dependsOn), jobType, jobAddress]);
        count++;
      }
      page++;
      const next = conn.nextPage;
      if (!next || next === '') break;
      cursor = next;
    }
    return { ok: true, count };
  } catch (error) {
    console.error('Gantt: alle-opgaver-synk fejlede:', error.message);
    return { ok: false, error: error.message };
  } finally {
    ganttAllSyncRunning = false;
  }
}

async function syncGanttJob(jobId) {
  const { jobName, tasks, phone, email, address } = await fetchGanttTasksFromJT(jobId);
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query('DELETE FROM gantt_tasks WHERE job_id=$1', [jobId]);
    for (const t of tasks) {
      await client.query(`
        INSERT INTO gantt_tasks (id,job_id,job_name,name,description,start_date,end_date,progress,is_group,parent_task_id,position,depends_on,job_phone,job_email,job_address,type_guess,synced_at)
        VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,${nowTextSQL()})
      `, [t.id, jobId, jobName, t.name, t.description, t.start_date, t.end_date, t.progress, t.is_group ? 1 : 0, t.parent_task_id, t.position, JSON.stringify(t.depends_on), phone, email, address, t.type_guess]);
    }
    await client.query('COMMIT');
  } catch (error) {
    try { await client.query('ROLLBACK'); } catch (_) {}
    throw error;
  } finally {
    client.release();
  }
  return { jobName, count: tasks.length, phone, email, address };
}

app.get('/api/gantt/jobs', auth, asyncRoute(async (req, res) => {
  // Henter ALLE kendte sager på én gang (ikke kun søgeresultater), inkl. det
  // fag der oftest går igen på sagens opgaver — så admin kan bladre/gruppere
  // med det samme uden at skulle vide/skrive kundens navn i forvejen.
  const rows = await pool.query(`
    SELECT
      job_id,
      MAX(job_name) AS job_name,
      MAX(job_number) AS job_number,
      MAX(job_address) AS job_address,
      MODE() WITHIN GROUP (ORDER BY type_guess) AS trade,
      COUNT(*)::int AS task_count,
      MAX(synced_at) AS last_synced
    FROM jt_tasks
    WHERE job_id IS NOT NULL AND job_id <> ''
    GROUP BY job_id
    ORDER BY MAX(job_name) ASC
  `);
  res.json(rows.rows);
}));

app.get('/api/gantt/all-tasks', auth, asyncRoute(async (req, res) => {
  let count = await pgOne('SELECT COUNT(*)::int AS n FROM gantt_tasks');
  if (!count || !count.n) {
    const r = await syncAllGanttTasksFromJT();
    if (!r.ok && !r.skipped) return res.status(400).json({ error: r.error || 'Kunne ikke hente opgaverne' });
  }
  const rows = await pool.query(`
    SELECT g.*, COALESCE(g.job_phone, t.customer_phone) AS resolved_phone, COALESCE(g.job_email, t.customer_email) AS resolved_email,
           COALESCE(g.job_address, t.job_address) AS resolved_address
    FROM gantt_tasks g
    LEFT JOIN jt_tasks t ON t.job_id = g.job_id AND t.customer_phone IS NOT NULL
    ORDER BY g.job_name ASC, g.start_date ASC
    LIMIT 2000
  `);
  const seen = new Set();
  const out = [];
  for (const r of rows.rows) {
    if (seen.has(r.id)) continue; // LEFT JOIN kan give flere rækker pr. opgave — behold kun én
    seen.add(r.id);
    out.push({
      id: r.id, job_id: r.job_id, job_name: r.job_name, job_number: r.job_number,
      name: r.name, description: r.description, start_date: r.start_date, end_date: r.end_date,
      progress: r.progress, is_group: !!r.is_group, parent_task_id: r.parent_task_id,
      depends_on: safeJsonParse(r.depends_on, []), type_guess: r.type_guess,
      job_phone: r.resolved_phone, job_email: r.resolved_email, job_address: r.resolved_address
    });
  }
  // SIKKERHED: viser tydeligt hvor friske data er, så man aldrig er i tvivl om man
  // kigger på noget der blev flyttet i JobTread for nyligt, men endnu ikke er hentet
  // ned hertil — i stedet for at det bare stille viser forældede datoer.
  const lastSynced = await pgOne('SELECT MAX(synced_at) AS t FROM gantt_tasks');
  res.json({ tasks: out, lastSyncedAt: lastSynced?.t || null });
}));

app.post('/api/gantt/sync-all', auth, adminOnly, asyncRoute(async (req, res) => {
  const r = await syncAllGanttTasksFromJT();
  if (!r.ok) return res.status(400).json({ error: r.error || 'Synk fejlede' });
  res.json(r);
}));

app.get('/api/gantt/job/:jobId', auth, asyncRoute(async (req, res) => {
  let rows = await pool.query('SELECT * FROM gantt_tasks WHERE job_id=$1 ORDER BY position ASC, id ASC', [req.params.jobId]);
  if (!rows.rowCount) {
    // Første gang dette job åbnes — hent live fra JobTread med det samme.
    try {
      await syncGanttJob(req.params.jobId);
      rows = await pool.query('SELECT * FROM gantt_tasks WHERE job_id=$1 ORDER BY position ASC, id ASC', [req.params.jobId]);
    } catch (error) {
      return res.status(400).json({ error: error.message });
    }
  }
  res.json(rows.rows.map(r => ({ ...r, depends_on: safeJsonParse(r.depends_on, []) })));
}));

app.post('/api/gantt/job/:jobId/sync', auth, adminOnly, asyncRoute(async (req, res) => {
  try {
    const result = await syncGanttJob(req.params.jobId);
    res.json({ ok: true, ...result });
  } catch (error) {
    res.status(400).json({ error: error.message });
  }
}));

app.put('/api/gantt/tasks/:id', auth, adminOnly, asyncRoute(async (req, res) => {
  const current = await pgOne('SELECT * FROM gantt_tasks WHERE id=$1', [req.params.id]);
  if (!current) return res.status(404).json({ error: 'Opgaven blev ikke fundet' });
  const body = req.body || {};
  const next = {
    name: body.name !== undefined ? String(body.name).trim() : current.name,
    start_date: body.start_date !== undefined ? body.start_date : current.start_date,
    end_date: body.end_date !== undefined ? body.end_date : current.end_date,
    progress: body.progress !== undefined ? Math.max(0, Math.min(1, Number(body.progress))) : current.progress
  };
  // Skriv til JobTread FØRST — hvis det fejler, skal vi ikke gemme en lokal
  // version der er ude af trit med den rigtige sag.
  try {
    await jtFetch({
      query: {
        $: { grantKey: JT_GRANT },
        updateTask: {
          $: { id: current.id, name: next.name, startDate: next.start_date, endDate: next.end_date, progress: next.progress, notify: false, updateDependentTasks: true }
        }
      }
    }, 'Gantt: opdatér opgave i JobTread');
  } catch (error) {
    return res.status(400).json({ error: 'Kunne ikke opdatere i JobTread: ' + error.message });
  }
  // JobTread rykker automatisk afhængige opgaver (updateDependentTasks:true) —
  // så vi genhenter HELE jobbet i stedet for kun at rette denne ene opgave
  // lokalt, ellers ville de kaskade-flyttede opgaver ikke opdatere sig i vores
  // eget Gantt-kort før næste manuelle synk.
  try {
    await syncGanttJob(current.job_id);
  } catch (error) {
    // Selve JobTread-opdateringen lykkedes — kun genhentningen fejlede. Gem i
    // det mindste denne ene opgave lokalt, så UI'en ikke falder helt tilbage.
    await pool.query(`
      UPDATE gantt_tasks SET name=$1, start_date=$2, end_date=$3, progress=$4, synced_at=${nowTextSQL()} WHERE id=$5
    `, [next.name, next.start_date, next.end_date, next.progress, current.id]);
  }
  res.json({ ok: true });
}));

app.post('/api/gantt/job/:jobId/tasks', auth, adminOnly, asyncRoute(async (req, res) => {
  const body = req.body || {};
  const name = String(body.name || '').trim();
  if (!name) return res.status(400).json({ error: 'Skriv et navn til opgaven' });
  if (!validDate(body.start_date)) return res.status(400).json({ error: 'Vælg en gyldig startdato' });
  let createdId;
  try {
    const result = await jtFetch({
      query: {
        $: { grantKey: JT_GRANT },
        createTask: {
          $: {
            targetId: req.params.jobId, targetType: 'job', name,
            startDate: body.start_date, endDate: body.end_date || body.start_date,
            isToDo: false, notify: false,
            ...(body.depends_on ? { dependsOnTasks: [{ id: body.depends_on }] } : {})
          },
          createdTask: { id: {} }
        }
      }
    }, 'Gantt: opret opgave i JobTread');
    createdId = result?.createTask?.createdTask?.id;
    if (!createdId) throw new Error('JobTread returnerede intet id');
  } catch (error) {
    return res.status(400).json({ error: 'Kunne ikke oprette i JobTread: ' + error.message });
  }
  await pool.query(`
    INSERT INTO gantt_tasks (id,job_id,job_name,name,description,start_date,end_date,progress,is_group,parent_task_id,position,depends_on,synced_at)
    VALUES ($1,$2,(SELECT job_name FROM gantt_tasks WHERE job_id=$2 LIMIT 1),$3,'',$4,$5,0,0,NULL,'',$6,${nowTextSQL()})
  `, [createdId, req.params.jobId, name, body.start_date, body.end_date || body.start_date, JSON.stringify(body.depends_on ? [body.depends_on] : [])]);
  res.json({ ok: true, id: createdId });
}));

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

// Samlet systemlog: JobTread-synk + alt andet der kører automatisk i baggrunden
// (notifikationsscan m.fl.), sorteret nyest først, så det hele kan ses ét sted.
app.get('/api/system-log', auth, adminOnly, asyncRoute(async (req, res) => {
  const syncRows = await pool.query('SELECT id, synced_at AS created_at, status AS level, message, tasks_imported FROM sync_log ORDER BY id DESC LIMIT 100');
  const eventRows = await pool.query('SELECT id, created_at, level, message, source FROM system_log ORDER BY id DESC LIMIT 100');
  const combined = [
    ...syncRows.rows.map(r => ({ source: 'jobtread_sync', level: r.level === 'ok' ? 'info' : r.level, message: r.message + (r.tasks_imported ? ` (${r.tasks_imported} opgaver)` : ''), created_at: r.created_at })),
    ...eventRows.rows.map(r => ({ source: r.source, level: r.level, message: r.message, created_at: r.created_at }))
  ].sort((a, b) => String(b.created_at).localeCompare(String(a.created_at)));
  res.json(combined.slice(0, 150));
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
  const customerEmail = String(body.customer_email || '').trim().slice(0, 200) || null;
  await pool.query(`
    INSERT INTO jt_tasks (id,name,job_id,job_name,job_address,job_number,customer_phone,customer_email,customer_email_source,start_date,end_date,type_guess,raw_assignee_name,jt_url,synced_at,source,created_at)
    VALUES ($1,$2,NULL,$3,$4,$5,$6,$7,$8,$9,$10,$11,NULL,NULL,${nowTextSQL()},'manual',${nowTextSQL()})
  `, [id, String(body.name).trim(), String(body.job_name).trim(), body.job_address || '', body.job_number || null, body.customer_phone || null, customerEmail, customerEmail ? 'manual' : null, body.start_date, endDate, cleanTaskType(body.type_guess)]);
  res.json({ ok: true, id });
}));

// Skabelon-træk direkte ud på en dag: opretter opgaven (som ovenfor) OG booker den på
// den medarbejder/dato den blev sluppet på, i én omgang — så man undgår to separate
// trin når man trækker en skabelon ud i Daglig plan.
app.post('/api/tasks/manual-and-book', auth, adminOnly, asyncRoute(async (req, res) => {
  const body = req.body || {};
  // FEJL RETTET: krævede tidligere at ALLE felter var udfyldt for at gemme en
  // skabelon-drop, selv i Kapacitet hvor kun navn + medarbejder + startdato reelt
  // giver mening — adresse/telefon/e-mail er valgfrit, ligesom i den almindelige
  // "+ Manuel opgave"-formular.
  if (!body.job_name || !body.name || !validDate(body.start_date) || !body.user_id) {
    return res.status(400).json({ error: 'Kunde/projekt, opgave, medarbejder og startdato skal udfyldes' });
  }
  const days = Math.max(0.25, Math.min(60, Number(body.days) || 1));
  const endDate = validDate(body.end_date) ? body.end_date : addWorkingDays(body.start_date, days);
  const id = `manual-${crypto.randomUUID ? crypto.randomUUID() : `${Date.now()}-${Math.random().toString(16).slice(2)}`}`;
  const customerEmail = String(body.customer_email || '').trim().slice(0, 200) || null;
  await pool.query(`
    INSERT INTO jt_tasks (id,name,job_id,job_name,job_address,job_number,customer_phone,customer_email,customer_email_source,start_date,end_date,type_guess,raw_assignee_name,jt_url,synced_at,source,created_at)
    VALUES ($1,$2,NULL,$3,$4,$5,$6,$7,$8,$9,$10,$11,NULL,NULL,${nowTextSQL()},'manual',${nowTextSQL()})
  `, [id, String(body.name).trim(), String(body.job_name).trim(), body.job_address || '', body.job_number || null, body.customer_phone || null, customerEmail, customerEmail ? 'manual' : null, body.start_date, endDate, cleanTaskType(body.type_guess)]);
  try {
    if (body.is_capacity) {
      // Booker som kapacitetsreservation (blokerer dage, ingen bestemt mødetid) i
      // stedet for en almindelig dags-booking — matcher at skabelonen blev trukket
      // ind i Kapacitet, ikke Daglig plan.
      const user = await pgOne("SELECT id,weekly_capacity FROM users WHERE id=$1 AND active=1 AND role='employee'", [Number(body.user_id)]);
      if (!user) throw new Error('Medarbejderen blev ikke fundet');
      const weeklyCapacity = Number(user.weekly_capacity) || 5;
      const segments = await splitCapacityAcrossWeeks(user.id, weeklyCapacity, body.start_date, days);
      let firstBookingId = null;
      for (const seg of segments) {
        const result = await pool.query(`
          INSERT INTO planning_bookings (task_id,user_id,week_key,days,capacity_days,notes,start_date,end_date,planning_mode,updated_at)
          VALUES ($1,$2,$3,5,$4,$5,$6,$7,'capacity',${nowTextSQL()}) RETURNING id
        `, [id, user.id, seg.week_key, seg.capacity_days, body.notes || null, seg.start_date, seg.end_date]);
        if (!firstBookingId) firstBookingId = result.rows[0].id;
      }
      return res.json({ ok: true, id, booking_id: firstBookingId });
    }
    const booking = await normalizeBooking({ task_id: id, user_id: body.user_id, start_date: body.start_date, days, notes: body.notes || null }, true);
    const result = await pool.query(`
      INSERT INTO planning_bookings (task_id,user_id,week_key,days,notes,start_date,end_date,updated_at)
      VALUES ($1,$2,$3,$4,$5,$6,$7,${nowTextSQL()}) RETURNING id
    `, [booking.task_id, booking.user_id, booking.week_key, booking.days, booking.notes, booking.start_date, booking.end_date]);
    res.json({ ok: true, id, booking_id: result.rows[0].id });
    sendScheduleChangeEmail(booking.user_id, `Du har fået en ny opgave sat på din kalender: ${String(booking.start_date).slice(0,10)}.`)
      .catch(e => console.error('Kalender-mail fejlede:', e.message));
    // OBS: kunde-mailen sendes IKKE automatisk længere — admin sender den bevidst
    // via "Send planlægningsmail"-knappen, så en opgave der planlægges flere gange
    // ikke spammer kunden med gentagne mails.
  } catch (error) {
    res.json({ ok: true, id, warning: 'Opgaven blev oprettet, men kunne ikke bookes automatisk: ' + error.message });
  }
}));

// ── CAPACITY-ONLY RESERVATIONS ────────────────────────────────
// These blocks are intentionally separate from Daily plan / Employee schedule.
// They reserve a person's weekly availability without creating a meeting time,
// address, telephone number or JobTread case number.
app.post('/api/capacity-reservations', auth, adminOnly, asyncRoute(async (req, res) => {
  const body = req.body || {};
  const startDate = validDate(String(body.week_start || '')) ? String(body.week_start) : null;
  if (!startDate) return res.status(400).json({ error: 'Vælg en gyldig startdato' });
  const user = await pgOne("SELECT id,weekly_capacity FROM users WHERE id=$1 AND active=1 AND role='employee'", [Number(body.user_id)]);
  if (!user) return res.status(400).json({ error: 'Medarbejderen eller holdet blev ikke fundet' });
  const capacityDays = Math.max(0.25, Math.min(60, Number(body.capacity_days) || 1));
  const weeklyCapacity = Number(user.weekly_capacity) || 5;
  const note = body.notes ? String(body.notes).slice(0, 1000) : null;
  const requestedLabel = String(body.label || '').trim().slice(0, 120);
  const existingTaskId = body.task_id ? String(body.task_id) : null;

  // Fordel dagene ud over lige så mange uger som nødvendigt — fylder hver uges
  // resterende kapacitet op først, i stedet for at proppe alt ind i uge 1.
  const segments = await splitCapacityAcrossWeeks(user.id, weeklyCapacity, startDate, capacityDays);

  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    let taskId = existingTaskId;
    let taskLabel = requestedLabel;
    const overallEnd = segments[segments.length - 1].end_date;
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
      `, [taskId, taskLabel, startDate, overallEnd]);
    }
    const insertedIds = [];
    for (const seg of segments) {
      const result = await client.query(`
        INSERT INTO planning_bookings (task_id,user_id,week_key,days,capacity_days,notes,start_time,start_date,end_date,planning_mode,capacity_label,updated_at)
        VALUES ($1,$2,$3,5,$4,$5,NULL,$6,$7,'capacity',$8,${nowTextSQL()})
        RETURNING id
      `, [taskId, user.id, seg.week_key, seg.capacity_days, note, seg.start_date, seg.end_date, taskLabel]);
      insertedIds.push(result.rows[0].id);
    }
    await client.query('COMMIT');
    const splitNote = segments.length > 1
      ? `Fordelt over ${segments.length} uger (${segments.map(s => s.capacity_days + 'd').join(' + ')}), da medarbejderens uge-kapacitet ikke rakte til det hele på én gang.`
      : null;
    res.json({ ok: true, id: insertedIds[0], ids: insertedIds, weeks: segments.length, split_note: splitNote });
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
  const task = await pgOne('SELECT id, job_id FROM jt_tasks WHERE id=$1', [req.params.id]);
  if (!task) return res.status(404).json({ error: 'Opgaven blev ikke fundet' });
  const body = req.body || {};
  const phone = String(body.customer_phone || '').trim().slice(0, 60);
  const emailProvided = body.customer_email !== undefined;
  const email = String(body.customer_email || '').trim().slice(0, 200);
  if (emailProvided) {
    await pool.query(`
      UPDATE jt_tasks
      SET customer_phone=$1,
          customer_phone_source=CASE WHEN $1='' THEN NULL ELSE 'manual' END,
          customer_phone_synced_at=NULL,
          customer_email=$2,
          customer_email_source=CASE WHEN $2='' THEN NULL ELSE 'manual' END,
          customer_email_synced_at=NULL
      WHERE id=$3
    `, [phone || '', email || '', req.params.id]);
  } else {
    await pool.query(`
      UPDATE jt_tasks
      SET customer_phone=$1,
          customer_phone_source=CASE WHEN $1='' THEN NULL ELSE 'manual' END,
          customer_phone_synced_at=NULL
      WHERE id=$2
    `, [phone || '', req.params.id]);
  }
  // AUTO-UDFYLDNING: se samme forklaring ved /api/tasks/:id ovenfor — telefon og
  // e-mail hører til kunden/sagen, ikke den enkelte opgave, så det spredes til alle
  // andre opgaver under samme sag med det samme.
  if (task.job_id) {
    if (phone) {
      await pool.query(`UPDATE jt_tasks SET customer_phone=$1, customer_phone_source='manual', customer_phone_synced_at=NULL WHERE job_id=$2 AND id<>$3`, [phone, task.job_id, req.params.id]);
    }
    if (emailProvided && email) {
      await pool.query(`UPDATE jt_tasks SET customer_email=$1, customer_email_source='manual', customer_email_synced_at=NULL WHERE job_id=$2 AND id<>$3`, [email, task.job_id, req.params.id]);
    }
  }
  res.json({ ok: true, customer_phone: phone || null, customer_phone_source: phone ? 'manual' : null, customer_email: emailProvided ? (email || null) : undefined });
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
    customer_phone: body.customer_phone !== undefined ? String(body.customer_phone).trim().slice(0, 60) : current.customer_phone,
    customer_email: body.customer_email !== undefined ? String(body.customer_email).trim().slice(0, 200) : current.customer_email
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
        job_number=$7,
        customer_email=$10,
        customer_email_source=CASE
          WHEN $11::boolean AND COALESCE($10,'')<>'' THEN 'manual'
          WHEN $11::boolean THEN NULL
          ELSE customer_email_source
        END,
        customer_email_synced_at=CASE WHEN $11::boolean THEN NULL ELSE customer_email_synced_at END
    WHERE id=$8
  `, [
    next.job_name, next.name, next.job_address, next.type_guess, next.description,
    next.customer_phone || null, next.job_number || null, current.id,
    body.customer_phone !== undefined,
    next.customer_email || null,
    body.customer_email !== undefined
  ]);
  // AUTO-UDFYLDNING: telefon, adresse og e-mail hører til KUNDEN/sagen, ikke den
  // enkelte opgave — så når en admin selv udfylder ét af disse felter manuelt på én
  // opgave, spredes det automatisk til alle andre opgaver under samme sag (job_id),
  // så man ikke skal indtaste det samme flere gange for hver enkelt opgave.
  if (current.job_id) {
    const propagateSets = [];
    const propagateValues = [];
    if (body.customer_phone !== undefined && next.customer_phone) {
      propagateValues.push(next.customer_phone);
      propagateSets.push(`customer_phone=$${propagateValues.length}`, `customer_phone_source='manual'`, `customer_phone_synced_at=NULL`);
    }
    if (body.job_address !== undefined && next.job_address) {
      propagateValues.push(next.job_address);
      propagateSets.push(`job_address=$${propagateValues.length}`);
    }
    if (body.customer_email !== undefined && next.customer_email) {
      propagateValues.push(next.customer_email);
      propagateSets.push(`customer_email=$${propagateValues.length}`, `customer_email_source='manual'`, `customer_email_synced_at=NULL`);
    }
    if (propagateSets.length) {
      propagateValues.push(current.job_id, current.id);
      await pool.query(`UPDATE jt_tasks SET ${propagateSets.join(', ')} WHERE job_id=$${propagateValues.length - 1} AND id<>$${propagateValues.length}`, propagateValues);
    }
  }
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

// ── TJEKPUNKTER PÅ EN OPGAVE (sub-opgaver, fx krav om dokumentation) ──
app.get('/api/tasks/:id/checklist', auth, asyncRoute(async (req, res) => {
  const rows = await pool.query('SELECT * FROM task_checklist_items WHERE task_id=$1 ORDER BY id ASC', [req.params.id]);
  res.json(rows.rows);
}));

app.post('/api/tasks/:id/checklist', auth, adminOnly, asyncRoute(async (req, res) => {
  const title = String((req.body || {}).title || '').trim();
  if (!title) return res.status(400).json({ error: 'Skriv hvad tjekpunktet handler om' });
  const task = await pgOne('SELECT id FROM jt_tasks WHERE id=$1', [req.params.id]);
  if (!task) return res.status(404).json({ error: 'Opgaven blev ikke fundet' });
  const result = await pool.query(`
    INSERT INTO task_checklist_items (task_id,title,created_by,created_at) VALUES ($1,$2,$3,${nowTextSQL()}) RETURNING id
  `, [req.params.id, title.slice(0, 300), req.user.id]);
  res.json({ ok: true, id: result.rows[0].id });
}));

app.put('/api/checklist/:id', auth, asyncRoute(async (req, res) => {
  const item = await pgOne('SELECT * FROM task_checklist_items WHERE id=$1', [req.params.id]);
  if (!item) return res.status(404).json({ error: 'Tjekpunktet blev ikke fundet' });
  const done = !!(req.body || {}).done;
  await pool.query(
    `UPDATE task_checklist_items SET done=$1, done_by=$2, done_at=${done ? nowTextSQL() : 'NULL'} WHERE id=$3`,
    [done ? 1 : 0, done ? req.user.id : null, item.id]
  );
  res.json({ ok: true });
}));

app.delete('/api/checklist/:id', auth, adminOnly, asyncRoute(async (req, res) => {
  await pool.query('DELETE FROM task_checklist_items WHERE id=$1', [req.params.id]);
  res.json({ ok: true });
}));

// ── KUNDEBESØG (hurtig booking + fast opfølgningsformular) ──
app.post('/api/customer-visits/book', auth, adminOnly, asyncRoute(async (req, res) => {
  const body = req.body || {};
  const customerName = String(body.customer_name || '').trim();
  if (!customerName) return res.status(400).json({ error: 'Skriv kundens navn' });
  if (!validDate(String(body.date || ''))) return res.status(400).json({ error: 'Vælg en gyldig dato' });
  const user = await pgOne("SELECT id FROM users WHERE id=$1 AND active=1 AND role='employee'", [Number(body.user_id)]);
  if (!user) return res.status(400).json({ error: 'Vælg hvem der tager besøget' });

  const taskId = `visit-${crypto.randomUUID ? crypto.randomUUID() : `${Date.now()}-${Math.random().toString(16).slice(2)}`}`;
  const address = body.address ? String(body.address).trim().slice(0, 300) : '';
  const phone = body.phone ? String(body.phone).trim().slice(0, 60) : '';

  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query(`
      INSERT INTO jt_tasks (id,name,job_id,job_name,job_address,customer_phone,start_date,end_date,type_guess,raw_assignee_name,jt_url,synced_at,source,is_visit,created_at)
      VALUES ($1,'Kundebesøg',NULL,$2,$3,$4,$5,$5,'other',NULL,NULL,${nowTextSQL()},'manual',1,${nowTextSQL()})
    `, [taskId, customerName, address, phone || null, body.date]);
    const booking = await client.query(`
      INSERT INTO planning_bookings (task_id,user_id,week_key,days,capacity_days,notes,start_time,start_date,end_date,planning_mode,updated_at)
      VALUES ($1,$2,$3,1,1,$4,$5,$6,$6,'daily',${nowTextSQL()})
      RETURNING id
    `, [taskId, user.id, getWeekKey(body.date), body.notes ? String(body.notes).slice(0, 500) : null, body.time || null, body.date]);
    await client.query(`
      INSERT INTO customer_visits (task_id,booking_id,customer_name,address,phone,created_at,updated_at)
      VALUES ($1,$2,$3,$4,$5,${nowTextSQL()},${nowTextSQL()})
    `, [taskId, booking.rows[0].id, customerName, address, phone]);
    await client.query('COMMIT');
    res.json({ ok: true, task_id: taskId, booking_id: booking.rows[0].id });
  } catch (error) {
    try { await client.query('ROLLBACK'); } catch (_) {}
    res.status(400).json({ error: error.message || 'Kundebesøget kunne ikke oprettes' });
  } finally {
    client.release();
  }
}));

app.get('/api/customer-visits/:taskId', auth, asyncRoute(async (req, res) => {
  const row = await pgOne('SELECT * FROM customer_visits WHERE task_id=$1', [req.params.taskId]);
  res.json(row || null);
}));

app.put('/api/customer-visits/:taskId', auth, asyncRoute(async (req, res) => {
  const body = req.body || {};
  const existing = await pgOne('SELECT * FROM customer_visits WHERE task_id=$1', [req.params.taskId]);
  const fields = {
    customer_name: body.customer_name !== undefined ? String(body.customer_name).trim().slice(0, 200) : existing?.customer_name || '',
    address: body.address !== undefined ? String(body.address).trim().slice(0, 300) : existing?.address || '',
    phone: body.phone !== undefined ? String(body.phone).trim().slice(0, 60) : existing?.phone || '',
    email: body.email !== undefined ? String(body.email).trim().slice(0, 200) : existing?.email || '',
    room_size: body.room_size !== undefined ? String(body.room_size).trim().slice(0, 100) : existing?.room_size || '',
    floor_type_wanted: body.floor_type_wanted !== undefined ? String(body.floor_type_wanted).trim().slice(0, 200) : existing?.floor_type_wanted || '',
    notes: body.notes !== undefined ? String(body.notes).slice(0, 3000) : existing?.notes || '',
    recommended_solution: body.recommended_solution !== undefined ? String(body.recommended_solution).slice(0, 2000) : existing?.recommended_solution || '',
    estimated_price: body.estimated_price !== undefined ? String(body.estimated_price).trim().slice(0, 100) : existing?.estimated_price || ''
  };
  if (existing) {
    await pool.query(`
      UPDATE customer_visits SET customer_name=$1,address=$2,phone=$3,email=$4,room_size=$5,floor_type_wanted=$6,notes=$7,recommended_solution=$8,estimated_price=$9,filled_by=$10,updated_at=${nowTextSQL()}
      WHERE task_id=$11
    `, [fields.customer_name, fields.address, fields.phone, fields.email, fields.room_size, fields.floor_type_wanted, fields.notes, fields.recommended_solution, fields.estimated_price, req.user.id, req.params.taskId]);
  } else {
    await pool.query(`
      INSERT INTO customer_visits (task_id,customer_name,address,phone,email,room_size,floor_type_wanted,notes,recommended_solution,estimated_price,filled_by,created_at,updated_at)
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,${nowTextSQL()},${nowTextSQL()})
    `, [req.params.taskId, fields.customer_name, fields.address, fields.phone, fields.email, fields.room_size, fields.floor_type_wanted, fields.notes, fields.recommended_solution, fields.estimated_price, req.user.id]);
  }
  // Hold også selve opgaven (jt_tasks) opdateret, så navn/adresse/telefon følger med overalt i appen.
  await pool.query(`UPDATE jt_tasks SET job_name=$1, job_address=$2, customer_phone=$3 WHERE id=$4 AND is_visit=1`, [fields.customer_name, fields.address, fields.phone || null, req.params.taskId]);
  res.json({ ok: true });
}));

// ── FLYDENDE NOTE-BLOK (personlig scratch-pad, gemmes pr. bruger) ──
// notes-widget holder kun position/størrelse på selve boksen.
// Indholdet ligger i note_tabs — én bruger kan have flere faner.
app.get('/api/notes-widget', auth, asyncRoute(async (req, res) => {
  const row = await pgOne('SELECT * FROM notes_widget WHERE user_id=$1', [req.user.id]);
  res.json(row || { user_id: req.user.id, pos_x: 80, pos_y: 80, width: 320, height: 320 });
}));

app.put('/api/notes-widget', auth, asyncRoute(async (req, res) => {
  const body = req.body || {};
  const posX = Number.isFinite(Number(body.pos_x)) ? Math.round(Number(body.pos_x)) : 80;
  const posY = Number.isFinite(Number(body.pos_y)) ? Math.round(Number(body.pos_y)) : 80;
  const width = Number.isFinite(Number(body.width)) ? Math.round(Number(body.width)) : 320;
  const height = Number.isFinite(Number(body.height)) ? Math.round(Number(body.height)) : 320;
  await pool.query(`
    INSERT INTO notes_widget (user_id,content,pos_x,pos_y,width,height,updated_at)
    VALUES ($1,'',$2,$3,$4,$5,${nowTextSQL()})
    ON CONFLICT (user_id) DO UPDATE SET pos_x=EXCLUDED.pos_x, pos_y=EXCLUDED.pos_y, width=EXCLUDED.width, height=EXCLUDED.height, updated_at=${nowTextSQL()}
  `, [req.user.id, posX, posY, width, height]);
  res.json({ ok: true });
}));

app.get('/api/note-tabs', auth, asyncRoute(async (req, res) => {
  const rows = await pool.query('SELECT * FROM note_tabs WHERE user_id=$1 ORDER BY sort_order ASC, id ASC', [req.user.id]);
  if (!rows.rows.length) {
    // Migrer evt. gammelt enkelt-note-indhold ind som første fane, hvis det findes.
    const old = await pgOne('SELECT content FROM notes_widget WHERE user_id=$1', [req.user.id]);
    const created = await pool.query(`
      INSERT INTO note_tabs (user_id,title,content,sort_order,created_at,updated_at)
      VALUES ($1,'Note 1',$2,0,${nowTextSQL()},${nowTextSQL()}) RETURNING *
    `, [req.user.id, old?.content || '']);
    return res.json(created.rows);
  }
  res.json(rows.rows);
}));

app.post('/api/note-tabs', auth, asyncRoute(async (req, res) => {
  const existing = await pool.query('SELECT COALESCE(MAX(sort_order),-1) AS m FROM note_tabs WHERE user_id=$1', [req.user.id]);
  const nextOrder = Number(existing.rows[0].m) + 1;
  const title = String((req.body || {}).title || ('Note ' + (nextOrder + 1))).slice(0, 60);
  const result = await pool.query(`
    INSERT INTO note_tabs (user_id,title,content,sort_order,created_at,updated_at)
    VALUES ($1,$2,'',$3,${nowTextSQL()},${nowTextSQL()}) RETURNING *
  `, [req.user.id, title, nextOrder]);
  res.json(result.rows[0]);
}));

app.put('/api/note-tabs/:id', auth, asyncRoute(async (req, res) => {
  const tab = await pgOne('SELECT * FROM note_tabs WHERE id=$1 AND user_id=$2', [req.params.id, req.user.id]);
  if (!tab) return res.status(404).json({ error: 'Fanen blev ikke fundet' });
  const body = req.body || {};
  const title = body.title !== undefined ? String(body.title).slice(0, 60) : tab.title;
  const content = body.content !== undefined ? String(body.content).slice(0, 200000) : tab.content;
  await pool.query(`UPDATE note_tabs SET title=$1, content=$2, updated_at=${nowTextSQL()} WHERE id=$3`, [title, content, tab.id]);
  res.json({ ok: true });
}));

app.delete('/api/note-tabs/:id', auth, asyncRoute(async (req, res) => {
  const result = await pool.query('DELETE FROM note_tabs WHERE id=$1 AND user_id=$2', [req.params.id, req.user.id]);
  if (!result.rowCount) return res.status(404).json({ error: 'Fanen blev ikke fundet' });
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

// Redigér en eksisterende ferie-/fraværsperiode direkte (bruges fra hurtig-redigering
// i Daglig plan / Kapacitet, hvor man vil kunne ændre dage, skifte til syg, osv. med det samme).
app.put('/api/time-off/:id', auth, adminOnly, asyncRoute(async (req, res) => {
  const row = await pgOne('SELECT * FROM time_off WHERE id=$1', [req.params.id]);
  if (!row) return res.status(404).json({ error: 'Blev ikke fundet' });
  const body = req.body || {};
  const startDate = body.start_date !== undefined ? String(body.start_date) : row.start_date;
  const endDate = body.end_date !== undefined ? String(body.end_date) : row.end_date;
  if (!validDate(startDate) || !validDate(endDate)) return res.status(400).json({ error: 'Vælg gyldige datoer' });
  if (endDate < startDate) return res.status(400).json({ error: 'Slutdato skal være efter startdato' });
  const type = body.type !== undefined ? (['vacation', 'sick', 'other'].includes(body.type) ? body.type : 'vacation') : row.type;
  const note = body.note !== undefined ? (body.note ? String(body.note).slice(0, 1000) : null) : row.note;
  await pool.query(
    `UPDATE time_off SET start_date=$1, end_date=$2, type=$3, note=$4, status='approved', resolved_at=${nowTextSQL()} WHERE id=$5`,
    [startDate, endDate, type, note, row.id]
  );
  res.json({ ok: true });
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
  const documented = !!(req.body || {}).documented;
  const docNote = (req.body || {}).doc_note ? String((req.body || {}).doc_note).slice(0, 500) : null;
  await pool.query(
    `UPDATE planning_bookings SET completed_at=${completed ? nowTextSQL() : 'NULL'}, documented_at=${completed && documented ? nowTextSQL() : (completed ? 'documented_at' : 'NULL')}${completed ? ", status_flag=NULL" : ""} WHERE id=$1`,
    [current.id]
  );
  if (completed && docNote) {
    await pool.query(
      `UPDATE planning_bookings SET notes=TRIM(BOTH E'\n' FROM COALESCE(notes,'') || E'\n\nDokumentation: ' || $1) WHERE id=$2`,
      [docNote, current.id]
    );
  }
  res.json({ ok: true });
  if (completed) {
    // FEJL RETTET: kunden fik "Vi er færdige hos dig"-mailen to gange — fordi begge
    // metoder kørte samtidig: den direkte mail OG Zapier-webhook'en (som i praksis er
    // sat op til selv at sende en færdig-mail via Gmail/Outlook). De to var tænkt som
    // ALTERNATIVER til hinanden, ikke noget der skulle køre parallelt. Nu bruges kun
    // Zapier når den er konfigureret; ellers sendes mailen direkte som normalt.
    if (process.env.ZAPIER_WEBHOOK_URL) {
      sendCompletionWebhook(current).catch(e => console.error('Zapier-webhook fejlede:', e.message));
    } else {
      sendCompletionEmail(current).catch(e => console.error('Færdig-mail fejlede:', e.message));
    }
  }
}));

// Manuel færdig-markering for en UPLANLAGT opgave (ingen booking findes endnu at
// sætte completed_at på). Bruges af ✓-knappen i Opgavepool for opgaver der aldrig
// er blevet booket.
app.put('/api/tasks/:id/manual-complete', auth, adminOnly, asyncRoute(async (req, res) => {
  const completed = !!(req.body || {}).completed;
  await pool.query(`UPDATE jt_tasks SET manually_completed_at=${completed ? nowTextSQL() : 'NULL'} WHERE id=$1`, [req.params.id]);
  res.json({ ok: true });
}));

// En booking kan flyttes manuelt op/ned i rækkefølgen for én bestemt dag. Bruges når
// admin selv vil bestemme rækkefølgen medarbejderen ser opgaverne i den dag — uafhængigt
// af mødetidspunkt. Sætter man et mødetidspunkt (start_time), tager visningen automatisk
// over og sorterer efter klokkeslæt i stedet (håndteres i frontend'en).
app.put('/api/assignments/:id/move', auth, adminOnly, asyncRoute(async (req, res) => {
  const current = await pgOne('SELECT * FROM planning_bookings WHERE id=$1', [req.params.id]);
  if (!current) return res.status(404).json({ error: 'Bookingen blev ikke fundet' });
  const dir = (req.body || {}).direction === 'down' ? 1 : -1;
  const forDate = (req.body || {}).date || current.start_date;
  const siblings = await pool.query(`
    SELECT id,sort_order FROM planning_bookings
    WHERE user_id=$1 AND start_date<=$2 AND end_date>=$2 AND COALESCE(planning_mode,'daily')='daily'
    ORDER BY COALESCE(start_time,'99:99') ASC, COALESCE(sort_order,0) ASC, id ASC
  `, [current.user_id, forDate]);
  const list = siblings.rows;
  const idx = list.findIndex(r => +r.id === +current.id);
  const swapIdx = idx + dir;
  if (idx < 0 || swapIdx < 0 || swapIdx >= list.length) return res.json({ ok: true });
  const a = list[idx], b = list[swapIdx];
  await pool.query('UPDATE planning_bookings SET sort_order=$1 WHERE id=$2', [b.sort_order, a.id]);
  await pool.query('UPDATE planning_bookings SET sort_order=$1 WHERE id=$2', [a.sort_order, b.id]);
  res.json({ ok: true });
}));

// En booking kan have én af tre "opmærksomheds"-statusser der ikke betyder færdig:
// venter (afvent), bagud, eller aflyst. Færdig håndteres stadig af /complete ovenfor,
// da den også trigger faktura-flowet og færdig-mailen — de to systemer må ikke blandes.
const BOOKING_STATUS_FLAGS = ['waiting', 'behind', 'cancelled'];
app.put('/api/assignments/:id/status', auth, adminOnly, asyncRoute(async (req, res) => {
  const current = await pgOne('SELECT * FROM planning_bookings WHERE id=$1', [req.params.id]);
  if (!current) return res.status(404).json({ error: 'Bookingen blev ikke fundet' });
  const raw = (req.body || {}).status_flag;
  const value = BOOKING_STATUS_FLAGS.includes(raw) ? raw : null;
  await pool.query('UPDATE planning_bookings SET status_flag=$1 WHERE id=$2', [value, current.id]);
  res.json({ ok: true, status_flag: value });
}));

app.put('/api/assignments/:id/invoice', auth, adminOnly, asyncRoute(async (req, res) => {
  const current = await pgOne('SELECT * FROM planning_bookings WHERE id=$1', [req.params.id]);
  if (!current) return res.status(404).json({ error: 'Bookingen blev ikke fundet' });
  if (String(current.planning_mode || 'daily') === 'capacity') return res.status(400).json({ error: 'En kapacitetsreservation kan ikke faktureres' });
  const invoiced = !!(req.body || {}).invoiced;
  await pool.query('UPDATE planning_bookings SET invoiced=$1 WHERE id=$2', [invoiced ? 1 : 0, req.params.id]);
  res.json({ ok: true });
}));

async function normalizeBooking(body, isNew) {
  const booking = body || {};
  const task = await pgOne('SELECT id,description FROM jt_tasks WHERE id=$1', [booking.task_id]);
  if (!task) throw new Error('Opgaven blev ikke fundet');
  const user = await pgOne("SELECT id FROM users WHERE id=$1 AND active=1", [Number(booking.user_id)]);
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
  // Ingen note angivet af admin, OG dette er en helt ny booking? Så lægger vi
  // automatisk JobTreads egen opgavebeskrivelse ind i stedet, så den følger med
  // ned til medarbejderen uden manuel indtastning. Ved redigering af en
  // eksisterende booking rører vi ALDRIG noten uopfordret (så en admin altid
  // kan slette/tømme en note uden at den bliver genskabt).
  const explicitNote = booking.notes !== undefined && booking.notes !== null ? String(booking.notes).trim() : '';
  const fallbackNote = (isNew && !explicitNote && task.description) ? String(task.description).trim() : '';
  const finalNote = explicitNote || fallbackNote;
  return {
    task_id: booking.task_id,
    user_id: Number(booking.user_id),
    week_key: getWeekKey(start),
    days,
    capacity_days: capacityDays,
    notes: finalNote ? finalNote.slice(0, 1000) : null,
    start_time: booking.start_time || null,
    start_date: start,
    end_date: validDate(booking.end_date) ? booking.end_date : addWorkingDays(start, days)
  };
}

function bookingSelect(where = '') {
  return `
    SELECT b.*,u.name AS user_name,u.color AS user_color,u.initials AS user_initials,u.avatar_url AS user_avatar_url,u.worker_type,u.vendor_group,u.trade,u.weekly_capacity,u.can_login,
           t.name AS task_name,t.job_name,t.job_address,t.job_number,t.job_lat,t.job_lng,t.customer_phone,t.customer_email,t.is_visit,t.description AS task_description,t.start_date AS task_start_date,t.end_date AS task_end_date,t.type_guess,t.jt_url,t.job_id,t.source AS task_source
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

// Medarbejdere kan selv hente en opgave fra poolen ind på deres egen dag —
// uden om admin. Kan KUN booke sig selv (user_id tvinges til den loggede ind
// bruger), uanset hvad der evt. sendes med i request'en.
app.post('/api/assignments/self', auth, asyncRoute(async (req, res) => {
  try {
    const booking = await normalizeBooking({ ...(req.body || {}), user_id: req.user.id }, true);
    const result = await pool.query(`
      INSERT INTO planning_bookings (task_id,user_id,week_key,days,capacity_days,notes,start_time,start_date,end_date,updated_at)
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,${nowTextSQL()})
      RETURNING id
    `, [booking.task_id, booking.user_id, booking.week_key, booking.days, booking.capacity_days, booking.notes, booking.start_time, booking.start_date, booking.end_date]);
    res.json({ ok: true, id: result.rows[0].id });
  } catch (error) {
    res.status(400).json({ error: error.message });
  }
}));

app.post('/api/assignments', auth, adminOnly, asyncRoute(async (req, res) => {
  try {
    const booking = await normalizeBooking(req.body, true);
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
    sendScheduleChangeEmail(booking.user_id, `Du har fået en ny opgave sat på din kalender: ${String(booking.start_date).slice(0,10)}.`)
      .catch(e => console.error('Kalender-mail fejlede:', e.message));
    // OBS: kunde-mailen sendes IKKE automatisk længere — se /send-scheduled-email nedenfor.
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
    if (String(current.planning_mode || 'daily') !== 'capacity') {
      sendScheduleChangeEmail(booking.user_id, `Din kalender er blevet opdateret: opgaven den ${String(booking.start_date).slice(0,10)} er ændret.`)
        .catch(e => console.error('Kalender-mail fejlede:', e.message));
      if (Number(current.user_id) !== Number(booking.user_id)) {
        sendScheduleChangeEmail(current.user_id, `En opgave er blevet flyttet væk fra din kalender.`)
          .catch(e => console.error('Kalender-mail fejlede:', e.message));
      }
      // SKUB-LIGNENDE IN-APP BESKED: rammer kun medarbejderens eget kontrolpanel, og
      // kun hvis ændringen reelt påvirker I DAG eller I MORGEN — en mail kan ligge
      // uåbnet, men en besked i selve appen fanger dem næste gang de kigger på deres
      // dag, uden at spamme dem med ændringer langt ude i fremtiden.
      const affectsNearTerm = isTodayOrTomorrow(current.start_date) || isTodayOrTomorrow(booking.start_date);
      if (affectsNearTerm) {
        const dayChanged = String(current.start_date) !== String(booking.start_date);
        const timeChanged = String(current.start_time || '') !== String(booking.start_time || '');
        const whenLabel = dayLabelForNotif(booking.start_date);
        let msg;
        if (dayChanged) msg = `Din opgave er flyttet til ${whenLabel} (${String(booking.start_date).slice(0,10)}).`;
        else if (timeChanged) msg = `Din opgave ${whenLabel} er flyttet til kl. ${booking.start_time || '?'}.`;
        else msg = `Din opgave ${whenLabel} er blevet opdateret.`;
        notifyEmployee(booking.user_id, 'Din plan er ændret', msg, '#plan').catch(() => {});
        if (Number(current.user_id) !== Number(booking.user_id) && isTodayOrTomorrow(current.start_date)) {
          notifyEmployee(current.user_id, 'Opgave fjernet fra din plan', `En opgave ${dayLabelForNotif(current.start_date)} er flyttet væk fra din kalender.`, '#plan').catch(() => {});
        }
      }
    }
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
    const scope = String(req.query.scope || 'all');
    const targetDate = validDate(String(req.query.date || '')) ? String(req.query.date) : null;

    if (scope === 'day' && targetDate && String(row.planning_mode || 'daily') !== 'capacity') {
      const workDates = workDatesForBooking(row.start_date, row.end_date);
      const idx = workDates.indexOf(targetDate);
      if (idx === -1 || workDates.length <= 1) {
        // Kun én dag i alt, eller datoen findes slet ikke i intervallet — så er der
        // reelt intet at splitte, slet hele bookingen som normalt.
        await client.query('DELETE FROM planning_bookings WHERE id=$1', [row.id]);
      } else {
        const originalDays = Number(row.days) || workDates.length;
        const perDay = originalDays / workDates.length;
        const before = workDates.slice(0, idx);
        const after = workDates.slice(idx + 1);
        if (before.length) {
          await client.query(
            `UPDATE planning_bookings SET end_date=$1, days=$2, updated_at=${nowTextSQL()} WHERE id=$3`,
            [before[before.length - 1], Math.round(before.length * perDay * 4) / 4, row.id]
          );
        }
        if (after.length) {
          if (before.length) {
            // Begge sider har dage tilbage — den ene bevares (opdateret ovenfor),
            // den anden oprettes som en ny, selvstændig booking.
            await client.query(`
              INSERT INTO planning_bookings (task_id,user_id,week_key,days,capacity_days,notes,start_time,start_date,end_date,planning_mode,updated_at)
              VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,${nowTextSQL()})
            `, [row.task_id, row.user_id, getWeekKey(after[0]), Math.round(after.length * perDay * 4) / 4, row.capacity_days, row.notes, row.start_time, after[0], after[after.length - 1], row.planning_mode || 'daily']);
          } else {
            // Den slettede dag var den FØRSTE — hele bookingen rykkes bare til at
            // starte efter den, ingen splitning nødvendig.
            await client.query(
              `UPDATE planning_bookings SET start_date=$1, week_key=$2, days=$3, updated_at=${nowTextSQL()} WHERE id=$4`,
              [after[0], getWeekKey(after[0]), Math.round(after.length * perDay * 4) / 4, row.id]
            );
          }
        } else if (!before.length) {
          // Bælte-tilfælde (bør ikke ske givet tjekket ovenfor) — slet for en sikkerheds skyld.
          await client.query('DELETE FROM planning_bookings WHERE id=$1', [row.id]);
        }
      }
    } else {
      await client.query('DELETE FROM planning_bookings WHERE id=$1', [row.id]);
    }

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
    if (String(row.planning_mode || 'daily') !== 'capacity') {
      sendScheduleChangeEmail(row.user_id, `En opgave er blevet fjernet fra din kalender (${String(row.start_date).slice(0,10)}).`)
        .catch(e => console.error('Kalender-mail fejlede:', e.message));
      if (isTodayOrTomorrow(row.start_date)) {
        notifyEmployee(row.user_id, 'Opgave fjernet fra din plan', `Din opgave ${dayLabelForNotif(row.start_date)} er fjernet fra din kalender.`, '#plan').catch(() => {});
      }
    }
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
// ══════════════════════════════════════════════════════════════
// SKABELONER — genbrugelige opgavetyper
// ══════════════════════════════════════════════════════════════
// ══════════════════════════════════════════════════════════════
// KUNDESØGNING — til manuel opgave-oprettelse: slå en tidligere kunde op på navn og
// få adresse/telefon/e-mail med det samme, i stedet for at skrive det hele selv.
// Bygger på allerede synkroniserede JobTread-sager (jt_tasks), da der ikke findes en
// selvstændig "kunde"-tabel i dag — job_name er reelt kundenavnet på sagen.
// ══════════════════════════════════════════════════════════════
app.get('/api/customers/search', auth, adminOnly, asyncRoute(async (req, res) => {
  const q = String(req.query.q || '').trim();
  if (q.length < 2) return res.json([]);
  const rows = await pool.query(`
    SELECT DISTINCT ON (job_name, job_address) job_name, job_address, job_number, customer_phone, customer_email, job_lat, job_lng
    FROM jt_tasks
    WHERE job_name ILIKE $1 AND job_name IS NOT NULL AND job_name <> ''
    ORDER BY job_name, job_address, created_at DESC
    LIMIT 12
  `, [`%${q}%`]);
  res.json(rows.rows);
}));

app.get('/api/templates', auth, asyncRoute(async (req, res) => {
  const rows = await pool.query('SELECT * FROM task_templates ORDER BY name ASC');
  res.json(rows.rows.map(r => ({ ...r, checklist_items: safeJsonParse(r.checklist_items, []) })));
}));
app.post('/api/templates', auth, adminOnly, asyncRoute(async (req, res) => {
  const body = req.body || {};
  if (!body.name) return res.status(400).json({ error: 'Navn skal udfyldes' });
  const days = Math.max(0.25, Math.min(60, Number(body.default_days) || 1));
  const checklist = Array.isArray(body.checklist_items) ? body.checklist_items.map(x => String(x).slice(0, 200)) : [];
  const r = await pool.query(`
    INSERT INTO task_templates (name,type_guess,default_days,checklist_items,notes_template,updated_at)
    VALUES ($1,$2,$3,$4,$5,${nowTextSQL()}) RETURNING id
  `, [String(body.name).trim().slice(0, 200), cleanTaskType(body.type_guess), days, JSON.stringify(checklist), body.notes_template ? String(body.notes_template).slice(0, 1000) : null]);
  res.json({ ok: true, id: r.rows[0].id });
}));
app.put('/api/templates/:id', auth, adminOnly, asyncRoute(async (req, res) => {
  const body = req.body || {};
  const days = Math.max(0.25, Math.min(60, Number(body.default_days) || 1));
  const checklist = Array.isArray(body.checklist_items) ? body.checklist_items.map(x => String(x).slice(0, 200)) : [];
  const r = await pool.query(`
    UPDATE task_templates SET name=$1,type_guess=$2,default_days=$3,checklist_items=$4,notes_template=$5,updated_at=${nowTextSQL()}
    WHERE id=$6
  `, [String(body.name || '').trim().slice(0, 200), cleanTaskType(body.type_guess), days, JSON.stringify(checklist), body.notes_template ? String(body.notes_template).slice(0, 1000) : null, req.params.id]);
  if (!r.rowCount) return res.status(404).json({ error: 'Skabelonen blev ikke fundet' });
  res.json({ ok: true });
}));
app.delete('/api/templates/:id', auth, adminOnly, asyncRoute(async (req, res) => {
  await pool.query('DELETE FROM task_templates WHERE id=$1', [req.params.id]);
  res.json({ ok: true });
}));

// ══════════════════════════════════════════════════════════════
// MAIL-SKABELONER — varianter af kunde-mailen
// ══════════════════════════════════════════════════════════════
const DEFAULT_EMAIL_VARS = ['{{kunde}}', '{{opgave}}', '{{fag}}', '{{dato}}', '{{tidspunkt}}', '{{medarbejder}}', '{{adresse}}', '{{firma}}'];
app.get('/api/email-templates', auth, asyncRoute(async (req, res) => {
  const rows = await pool.query('SELECT * FROM email_templates ORDER BY name ASC');
  res.json(rows.rows);
}));
app.post('/api/email-templates', auth, adminOnly, asyncRoute(async (req, res) => {
  const body = req.body || {};
  if (!body.name || !body.subject || !body.body) return res.status(400).json({ error: 'Navn, emne og indhold skal udfyldes' });
  const r = await pool.query(`
    INSERT INTO email_templates (name,subject,body,updated_at) VALUES ($1,$2,$3,${nowTextSQL()}) RETURNING id
  `, [String(body.name).trim().slice(0, 200), String(body.subject).trim().slice(0, 300), String(body.body).slice(0, 5000)]);
  res.json({ ok: true, id: r.rows[0].id });
}));
app.put('/api/email-templates/:id', auth, adminOnly, asyncRoute(async (req, res) => {
  const body = req.body || {};
  const r = await pool.query(`
    UPDATE email_templates SET name=$1,subject=$2,body=$3,updated_at=${nowTextSQL()} WHERE id=$4
  `, [String(body.name || '').trim().slice(0, 200), String(body.subject || '').trim().slice(0, 300), String(body.body || '').slice(0, 5000), req.params.id]);
  if (!r.rowCount) return res.status(404).json({ error: 'Skabelonen blev ikke fundet' });
  res.json({ ok: true });
}));
app.delete('/api/email-templates/:id', auth, adminOnly, asyncRoute(async (req, res) => {
  await pool.query('DELETE FROM email_templates WHERE id=$1', [req.params.id]);
  res.json({ ok: true });
}));

// ══════════════════════════════════════════════════════════════
// NOTIFIKATIONER — konfigurerbare regler + log
// ══════════════════════════════════════════════════════════════
const NOTIFICATION_EVENTS = [
  { event_key: 'pool_aging', label: 'Opgave har ligget uplanlagt i mere end 5 dage' },
  { event_key: 'booking_behind', label: 'En booking er markeret "Bagud"' },
  { event_key: 'booking_waiting', label: 'En booking er markeret "Afvent" i mere end 3 dage' },
  { event_key: 'employee_overbooked', label: 'En medarbejder er overbooket i en kommende uge' },
  { event_key: 'unbilled_completed', label: 'Færdigmeldt opgave venter stadig på fakturering' },
  { event_key: 'jt_sync_failed', label: 'JobTread-synkronisering fejlede' }
];
async function ensureNotificationRulesSeeded() {
  for (const ev of NOTIFICATION_EVENTS) {
    await pool.query(
      `INSERT INTO notification_rules (event_key,label,inapp_enabled,email_enabled) VALUES ($1,$2,1,0) ON CONFLICT (event_key) DO UPDATE SET label=EXCLUDED.label`,
      [ev.event_key, ev.label]
    );
  }
}
async function createNotification(eventKey, title, body, link) {
  const rule = await pgOne('SELECT * FROM notification_rules WHERE event_key=$1', [eventKey]);
  if (!rule || rule.inapp_enabled) {
    await pool.query('INSERT INTO notifications (event_key,title,body,link) VALUES ($1,$2,$3,$4)', [eventKey, title, body || null, link || null]);
  }
  if (rule && rule.email_enabled && rule.email_to && mailIsConfigured()) {
    try {
      await sendMailUniversal({ to: rule.email_to, subject: '[Gulv Master] ' + title, text: body || title, html: '<p>' + (body || title).replace(/</g, '&lt;') + '</p>' });
    } catch (e) { console.error('Notifikations-mail fejlede:', e.message); }
  }
}
// Skub-lignende in-app besked direkte til ÉN medarbejder (fx "din opgave i morgen er
// flyttet") — adskilt fra de admin-brede notifikationer ovenfor, som styres af
// notification_rules og vises i admin-panelets klokke. Denne rammer kun medarbejderens
// eget kontrolpanel.
function isTodayOrTomorrow(dateStr) {
  if (!dateStr) return false;
  const today = new Date(); today.setHours(0, 0, 0, 0);
  const tomorrow = new Date(today); tomorrow.setDate(tomorrow.getDate() + 1);
  const d = new Date(String(dateStr).slice(0, 10) + 'T00:00:00');
  return d.getTime() === today.getTime() || d.getTime() === tomorrow.getTime();
}
function dayLabelForNotif(dateStr) {
  const today = new Date(); today.setHours(0, 0, 0, 0);
  const d = new Date(String(dateStr).slice(0, 10) + 'T00:00:00');
  const diffDays = Math.round((d - today) / 86400000);
  if (diffDays === 0) return 'i dag';
  if (diffDays === 1) return 'i morgen';
  return 'den ' + String(dateStr).slice(0, 10);
}
async function notifyEmployee(userId, title, body, link) {
  if (!userId) return;
  try {
    await pool.query('INSERT INTO notifications (event_key,title,body,link,user_id) VALUES ($1,$2,$3,$4,$5)', ['employee_schedule_change', title, body || null, link || null, userId]);
  } catch (e) { console.error('Medarbejder-notifikation fejlede:', e.message); }
}
app.get('/api/notification-settings', auth, adminOnly, asyncRoute(async (req, res) => {
  await ensureNotificationRulesSeeded();
  const rows = await pool.query('SELECT * FROM notification_rules ORDER BY event_key ASC');
  res.json(rows.rows);
}));
app.put('/api/notification-settings/:eventKey', auth, adminOnly, asyncRoute(async (req, res) => {
  const body = req.body || {};
  const r = await pool.query(`
    UPDATE notification_rules SET inapp_enabled=$1,email_enabled=$2,email_to=$3,updated_at=${nowTextSQL()} WHERE event_key=$4
  `, [body.inapp_enabled ? 1 : 0, body.email_enabled ? 1 : 0, body.email_to ? String(body.email_to).trim().slice(0, 200) : null, req.params.eventKey]);
  if (!r.rowCount) return res.status(404).json({ error: 'Ukendt hændelsestype' });
  res.json({ ok: true });
}));
app.get('/api/notifications', auth, asyncRoute(async (req, res) => {
  // Kun de admin-brede notifikationer her — medarbejder-rettede beskeder (user_id sat)
  // hentes i stedet via /api/my-notifications, så de to ikke blandes sammen.
  const rows = await pool.query('SELECT * FROM notifications WHERE user_id IS NULL ORDER BY created_at DESC LIMIT 100');
  res.json(rows.rows);
}));
app.put('/api/notifications/:id/read', auth, asyncRoute(async (req, res) => {
  await pool.query(`UPDATE notifications SET read_at=${nowTextSQL()} WHERE id=$1`, [req.params.id]);
  res.json({ ok: true });
}));
app.put('/api/notifications/read-all', auth, asyncRoute(async (req, res) => {
  await pool.query(`UPDATE notifications SET read_at=${nowTextSQL()} WHERE read_at IS NULL AND user_id IS NULL`);
  res.json({ ok: true });
}));
// Medarbejderens egne beskeder (fx planændringer der rammer i dag/i morgen).
app.get('/api/my-notifications', auth, asyncRoute(async (req, res) => {
  const rows = await pool.query('SELECT * FROM notifications WHERE user_id=$1 ORDER BY created_at DESC LIMIT 50', [req.user.id]);
  res.json(rows.rows);
}));
app.put('/api/my-notifications/:id/read', auth, asyncRoute(async (req, res) => {
  await pool.query(`UPDATE notifications SET read_at=${nowTextSQL()} WHERE id=$1 AND user_id=$2`, [req.params.id, req.user.id]);
  res.json({ ok: true });
}));
app.put('/api/my-notifications/read-all', auth, asyncRoute(async (req, res) => {
  await pool.query(`UPDATE notifications SET read_at=${nowTextSQL()} WHERE read_at IS NULL AND user_id=$1`, [req.user.id]);
  res.json({ ok: true });
}));

// Scanner der kigger på tilstanden af poolen/bookinger og opretter notifikationer for
// det den finder — kaldes af et cron-job. Undgår dubletter ved kun at kigge på nye
// tilfælde siden sidste scan (simpel — ingen "allerede notificeret"-tabel endnu, så
// den kører med en vis grad af "kan gentage sig" fremfor at risikere at overse noget).
async function runNotificationScan() {
  await ensureNotificationRulesSeeded();
  try {
    const agingPool = await pool.query(`
      SELECT t.id, t.job_name, t.name FROM jt_tasks t
      WHERE t.start_date IS NOT NULL
        AND NOT EXISTS (SELECT 1 FROM planning_bookings b WHERE b.task_id=t.id AND COALESCE(b.planning_mode,'daily')='daily')
        AND t.created_at < ${nowTextSQL()} - INTERVAL '5 days'
      LIMIT 20
    `).catch(() => ({ rows: [] }));
    if (agingPool.rows.length) {
      await createNotification('pool_aging', agingPool.rows.length + ' opgave(r) har ligget uplanlagt i over 5 dage', agingPool.rows.slice(0, 5).map(t => t.job_name + ' — ' + t.name).join(', '), '#plan');
    }
  } catch (e) { console.error('Notifikationsscan (pool_aging) fejlede:', e.message); }

  try {
    const behind = await pool.query(`SELECT COUNT(*)::int AS n FROM planning_bookings WHERE status_flag='behind'`);
    if (behind.rows[0].n > 0) await createNotification('booking_behind', behind.rows[0].n + ' booking(er) er markeret "Bagud"', null, '#timeline');
  } catch (e) { console.error('Notifikationsscan (behind) fejlede:', e.message); }

  try {
    const unbilled = await pool.query(`SELECT COUNT(*)::int AS n FROM planning_bookings WHERE completed_at IS NOT NULL AND COALESCE(invoiced,0)=0`);
    if (unbilled.rows[0].n > 0) await createNotification('unbilled_completed', unbilled.rows[0].n + ' færdigmeldt(e) opgave(r) venter på fakturering', null, '#plan');
  } catch (e) { console.error('Notifikationsscan (unbilled) fejlede:', e.message); }

  try {
    const overbooked = await pool.query(`
      SELECT u.id,u.name,u.weekly_capacity,b.week_key,SUM(b.days) AS booked
      FROM planning_bookings b JOIN users u ON b.user_id=u.id
      WHERE COALESCE(b.planning_mode,'daily')='daily' AND b.week_key >= TO_CHAR(CURRENT_DATE,'IYYY-"W"IW')
      GROUP BY u.id,u.name,u.weekly_capacity,b.week_key
      HAVING SUM(b.days) > COALESCE(u.weekly_capacity,5)
      LIMIT 20
    `).catch(() => ({ rows: [] }));
    if (overbooked.rows.length) {
      await createNotification('employee_overbooked', overbooked.rows.length + ' medarbejder(e) er overbooket i en kommende uge',
        overbooked.rows.slice(0, 5).map(r => r.name + ' (' + r.week_key + ')').join(', '), '#capacity');
    }
  } catch (e) { console.error('Notifikationsscan (overbooked) fejlede:', e.message); logSystemEvent('notification_scan', 'error', 'Delvist fejl (overbooked): ' + e.message); }
  await logSystemEvent('notification_scan', 'info', 'Scan gennemført uden fejl.');
}

// ══════════════════════════════════════════════════════════════
// KOMMANDOCENTER — samlet overblik, kapacitetsprognose, nøgletal
// ══════════════════════════════════════════════════════════════
app.get('/api/dashboard/overview', auth, adminOnly, asyncRoute(async (req, res) => {
  const poolOpen = await pool.query(`
    SELECT COUNT(*)::int AS n, MIN(t.created_at) AS oldest FROM jt_tasks t
    WHERE t.start_date IS NOT NULL
      AND NOT EXISTS (SELECT 1 FROM planning_bookings b WHERE b.task_id=t.id AND COALESCE(b.planning_mode,'daily')='daily')
  `);
  const statusCounts = await pool.query(`
    SELECT COALESCE(status_flag,'none') AS status_flag, COUNT(*)::int AS n
    FROM planning_bookings WHERE completed_at IS NULL AND COALESCE(planning_mode,'daily')='daily' AND status_flag IS NOT NULL
    GROUP BY status_flag
  `);
  const unbilled = await pool.query(`SELECT COUNT(*)::int AS n FROM planning_bookings WHERE completed_at IS NOT NULL AND COALESCE(invoiced,0)=0`);
  const overbooked = await pool.query(`
    SELECT u.id,u.name,u.color,u.initials,b.week_key,SUM(b.days) AS booked,COALESCE(u.weekly_capacity,5) AS capacity
    FROM planning_bookings b JOIN users u ON b.user_id=u.id
    WHERE COALESCE(b.planning_mode,'daily')='daily' AND b.week_key >= TO_CHAR(CURRENT_DATE,'IYYY-"W"IW')
    GROUP BY u.id,u.name,u.color,u.initials,b.week_key,u.weekly_capacity
    HAVING SUM(b.days) > COALESCE(u.weekly_capacity,5)
    ORDER BY b.week_key ASC LIMIT 20
  `);
  const notif = await pool.query('SELECT COUNT(*)::int AS n FROM notifications WHERE read_at IS NULL');
  res.json({
    pool_open_count: poolOpen.rows[0].n,
    pool_oldest: poolOpen.rows[0].oldest,
    status_counts: statusCounts.rows,
    unbilled_completed_count: unbilled.rows[0].n,
    overbooked_employees: overbooked.rows,
    unread_notifications: notif.rows[0].n
  });
}));

app.get('/api/dashboard/capacity-forecast', auth, adminOnly, asyncRoute(async (req, res) => {
  // 8 uger frem, grupperet pr. fag: samlet teamkapacitet (dage/uge) vs. bookede dage.
  const weeks = [];
  const today = new Date();
  for (let i = 0; i < 8; i++) {
    const d = new Date(today); d.setDate(d.getDate() + i * 7);
    const iso = d.toISOString().slice(0, 10);
    weeks.push(iso);
  }
  const capByTrade = await pool.query(`
    SELECT COALESCE(NULLIF(trade,''),'Ukendt fag') AS trade, SUM(COALESCE(weekly_capacity,5)) AS capacity
    FROM users WHERE active=1 AND role='employee' GROUP BY trade
  `);
  const bookedByTradeWeek = await pool.query(`
    SELECT COALESCE(NULLIF(u.trade,''),'Ukendt fag') AS trade, b.week_key, SUM(b.days) AS booked
    FROM planning_bookings b JOIN users u ON b.user_id=u.id
    WHERE COALESCE(b.planning_mode,'daily')='daily'
    GROUP BY trade, b.week_key
  `);
  res.json({ weeks, capacity_by_trade: capByTrade.rows, booked_by_trade_week: bookedByTradeWeek.rows });
}));

app.get('/api/dashboard/kpis', auth, adminOnly, asyncRoute(async (req, res) => {
  const utilization = await pool.query(`
    SELECT u.id,u.name,u.color,COALESCE(u.weekly_capacity,5) AS capacity,
           COALESCE(SUM(b.days) FILTER (WHERE b.week_key = TO_CHAR(CURRENT_DATE,'IYYY-"W"IW')),0) AS booked_this_week
    FROM users u LEFT JOIN planning_bookings b ON b.user_id=u.id AND COALESCE(b.planning_mode,'daily')='daily'
    WHERE u.active=1 AND u.role='employee'
    GROUP BY u.id,u.name,u.color,u.weekly_capacity ORDER BY u.name ASC
  `);
  const avgTurnaround = await pool.query(`
    SELECT AVG(EXTRACT(EPOCH FROM (completed_at::timestamp - start_date::timestamp)) / 86400.0) AS avg_days
    FROM planning_bookings WHERE completed_at IS NOT NULL AND start_date IS NOT NULL
  `).catch(() => ({ rows: [{ avg_days: null }] }));
  const statusBreakdown = await pool.query(`
    SELECT COALESCE(status_flag,CASE WHEN completed_at IS NOT NULL THEN 'completed' ELSE 'normal' END) AS status, COUNT(*)::int AS n
    FROM planning_bookings WHERE COALESCE(planning_mode,'daily')='daily' GROUP BY status
  `);
  const tradeVolume = await pool.query(`
    SELECT COALESCE(NULLIF(type_guess,''),'other') AS type_guess, COUNT(*)::int AS n
    FROM planning_bookings WHERE COALESCE(planning_mode,'daily')='daily' AND start_date >= (CURRENT_DATE - INTERVAL '60 days')
    GROUP BY type_guess
  `).catch(() => ({ rows: [] }));
  res.json({
    utilization: utilization.rows,
    avg_turnaround_days: avgTurnaround.rows[0]?.avg_days ? Number(avgTurnaround.rows[0].avg_days).toFixed(1) : null,
    status_breakdown: statusBreakdown.rows,
    trade_volume_60d: tradeVolume.rows
  });
}));

// ══════════════════════════════════════════════════════════════
// GEOGRAFISK FORSLAG — hvilken medarbejder er tættest på i forvejen
// (afstandsberegning, ikke fuld rute-optimering — se svar i chatten)
// ══════════════════════════════════════════════════════════════
function haversineKm(lat1, lng1, lat2, lng2) {
  const R = 6371, dLat = (lat2 - lat1) * Math.PI / 180, dLng = (lng2 - lng1) * Math.PI / 180;
  const a = Math.sin(dLat / 2) ** 2 + Math.cos(lat1 * Math.PI / 180) * Math.cos(lat2 * Math.PI / 180) * Math.sin(dLng / 2) ** 2;
  return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}
app.get('/api/geo-suggest', auth, adminOnly, asyncRoute(async (req, res) => {
  const taskId = req.query.taskId;
  const date = req.query.date;
  const task = await pgOne('SELECT * FROM jt_tasks WHERE id=$1', [taskId]);
  if (!task || !task.job_lat || !task.job_lng) return res.json({ suggestions: [] });
  const nearby = await pool.query(`
    SELECT b.user_id, u.name, u.color, t.job_lat, t.job_lng, t.job_name
    FROM planning_bookings b JOIN users u ON b.user_id=u.id JOIN jt_tasks t ON b.task_id=t.id
    WHERE COALESCE(b.planning_mode,'daily')='daily' AND b.start_date=$1 AND t.job_lat IS NOT NULL AND t.job_lng IS NOT NULL
  `, [date || task.start_date]);
  const byUser = {};
  for (const r of nearby.rows) {
    const dist = haversineKm(Number(task.job_lat), Number(task.job_lng), Number(r.job_lat), Number(r.job_lng));
    if (!byUser[r.user_id] || dist < byUser[r.user_id].distance_km) {
      byUser[r.user_id] = { user_id: r.user_id, name: r.name, color: r.color, distance_km: Math.round(dist * 10) / 10, near_job: r.job_name };
    }
  }
  const suggestions = Object.values(byUser).sort((a, b) => a.distance_km - b.distance_km).slice(0, 5);
  res.json({ suggestions });
}));

// ══════════════════════════════════════════════════════════════
// KUNDE-KOMMUNIKATION — planlagt-mail og påmindelse dagen før
// ══════════════════════════════════════════════════════════════
function fillEmailVars(str, vars) {
  return String(str || '').replace(/\{\{\s*(\w+)\s*\}\}/g, (m, key) => (vars[key] !== undefined && vars[key] !== null && vars[key] !== '') ? vars[key] : m);
}
async function sendScheduledEmail(booking, templateId) {
  if (!mailIsConfigured()) return { sent: false, reason: 'E-mail er ikke konfigureret på serveren' };
  const task = await pgOne('SELECT * FROM jt_tasks WHERE id=$1', [booking.task_id]);
  const toEmail = task?.customer_email;
  if (!toEmail) return { sent: false, reason: 'Kunden har ingen e-mail registreret' };
  const settingsRows = await pool.query("SELECT key,value FROM app_settings WHERE key='company_name'");
  const companyName = settingsRows.rows[0]?.value || 'Gulv Master Enterprise ApS';
  const dateLabel = new Date(booking.start_date).toLocaleDateString('da-DK', { weekday: 'long', day: 'numeric', month: 'long' });
  let userName = '';
  if (booking.user_id) {
    const u = await pgOne('SELECT name FROM users WHERE id=$1', [booking.user_id]);
    userName = u?.name || '';
  }
  let tradeLabel = '';
  if (task?.type_guess) {
    const tt = await pgOne('SELECT label FROM task_types WHERE key=$1', [task.type_guess]);
    tradeLabel = tt?.label || task.type_guess;
  }
  const vars = {
    kunde: task?.job_name || '', opgave: task?.name || '', fag: tradeLabel,
    dato: dateLabel, tidspunkt: booking.start_time || '', medarbejder: userName,
    adresse: task?.job_address || '', firma: companyName
  };
  let subject, text;
  if (templateId) {
    const tpl = await pgOne('SELECT * FROM email_templates WHERE id=$1', [templateId]);
    if (!tpl) return { sent: false, reason: 'Mail-skabelonen blev ikke fundet' };
    subject = fillEmailVars(tpl.subject, vars);
    text = fillEmailVars(tpl.body, vars);
  } else {
    subject = `Din opgave er planlagt til ${dateLabel} — ${companyName}`;
    text = `Hej,\n\nVi har planlagt din opgave (${task?.job_name || ''}) til ${dateLabel}${booking.start_time ? ' kl. ' + booking.start_time : ''}.\n\nVi giver besked igen dagen før vi kommer, og når vi er færdige.\n\nVenlig hilsen\n${companyName}`;
  }
  let status = 'sent', error = null;
  try { await sendMailUniversal({ to: toEmail, subject, text, html: text.split('\n').map(l => l ? `<p>${l.replace(/</g, '&lt;')}</p>` : '<br>').join('') }); }
  catch (e) { status = 'error'; error = redactSecret(e.message || '').slice(0, 500); }
  await pool.query('INSERT INTO customer_schedule_emails (booking_id,task_id,kind,to_email,status,error) VALUES ($1,$2,$3,$4,$5,$6)', [booking.id, booking.task_id, 'scheduled', toEmail, status, error]);
  await pool.query(`UPDATE planning_bookings SET scheduled_email_sent_at=${nowTextSQL()} WHERE id=$1`, [booking.id]);
  return status === 'sent' ? { sent: true } : { sent: false, reason: error };
}

// Manuel udsendelse — admin trykker selv, i stedet for at hver booking automatisk
// sender en mail. Undgår at kunden får 5 mails hvis sagen bliver planlagt/redigeret
// flere gange. Kræver et bekræftende klik igen hvis der allerede er sendt én (se
// scheduled_email_sent_at i svaret, som frontend'en bruger til at vise en advarsel).
// Body kan indeholde template_id, hvis admin har valgt en bestemt mail-skabelon.
app.post('/api/assignments/:id/send-scheduled-email', auth, adminOnly, asyncRoute(async (req, res) => {
  const current = await pgOne('SELECT * FROM planning_bookings WHERE id=$1', [req.params.id]);
  if (!current) return res.status(404).json({ error: 'Bookingen blev ikke fundet' });
  const result = await sendScheduledEmail(current, (req.body || {}).template_id || null);
  if (!result.sent) return res.status(400).json({ error: result.reason || 'Kunne ikke sende mailen' });
  res.json({ ok: true });
}));

async function sendReminderEmails() {
  if (!mailIsConfigured()) return { sent: 0, reason: 'E-mail er ikke konfigureret på serveren' };
  const tomorrow = new Date(); tomorrow.setDate(tomorrow.getDate() + 1);
  const iso = tomorrow.toISOString().slice(0, 10);
  // DISTINCT ON (task_id): hvis samme opgave ved en fejl er booket flere gange samme
  // dag, skal kunden kun have ÉN påmindelse, ikke én pr. duplikeret booking-række.
  const rows = await pool.query(`
    SELECT DISTINCT ON (b.task_id) b.*, t.job_name, t.customer_email FROM planning_bookings b JOIN jt_tasks t ON b.task_id=t.id
    WHERE b.start_date=$1 AND COALESCE(b.planning_mode,'daily')='daily' AND b.reminder_email_sent_at IS NULL AND t.customer_email IS NOT NULL
    ORDER BY b.task_id, b.id ASC
  `, [iso]);
  const settingsRows = await pool.query("SELECT key,value FROM app_settings WHERE key='company_name'");
  const companyName = settingsRows.rows[0]?.value || 'Gulv Master Enterprise ApS';
  let sentCount = 0;
  for (const b of rows.rows) {
    const subject = `Vi kommer i morgen — ${companyName}`;
    const text = `Hej,\n\nVi vil bare give dig besked om, at vi kommer i morgen${b.start_time ? ' kl. ' + b.start_time : ''} og udfører (${b.job_name}).\n\nVenlig hilsen\n${companyName}`;
    let status = 'sent', error = null;
    try { await sendMailUniversal({ to: b.customer_email, subject, text, html: text.split('\n').map(l => l ? `<p>${l.replace(/</g, '&lt;')}</p>` : '<br>').join('') }); sentCount++; }
    catch (e) { status = 'error'; error = redactSecret(e.message || '').slice(0, 500); }
    await pool.query('INSERT INTO customer_schedule_emails (booking_id,task_id,kind,to_email,status,error) VALUES ($1,$2,$3,$4,$5,$6)', [b.id, b.task_id, 'reminder', b.customer_email, status, error]);
    // Marker ALLE bookinger for samme opgave+dato som sendt, ikke kun den ene, så en
    // evt. duplikeret booking ikke selv trigger endnu en påmindelse i morgen.
    await pool.query(`UPDATE planning_bookings SET reminder_email_sent_at=${nowTextSQL()} WHERE task_id=$1 AND start_date=$2`, [b.task_id, iso]);
  }
  return { sent: sentCount, candidates: rows.rows.length };
}

// Manuel udløser — admin trykker selv når de vil sende "vi kommer i morgen" til alle
// kunder der er booket i morgen og ikke allerede har fået den. Ingen automatisk cron.
app.post('/api/customer-emails/send-reminders', auth, adminOnly, asyncRoute(async (req, res) => {
  const result = await sendReminderEmails();
  res.json({ ok: true, ...result });
}));

// ══════════════════════════════════════════════════════════════
// ØKONOMI — kun for brugere med is_finance_admin=1 (se financeOnly)
// ══════════════════════════════════════════════════════════════

// Henter alle opgaver med planlagt startdato i et vindue omkring nu, og bygger
// "hvilke sager har arbejde i gang i måned X" pr. faggruppe — samme metode som
// blev aftalt manuelt: aktiv måned = opgavens startdato, ikke JobTreads eget
// Status-felt (som i praksis ikke bliver opdateret løbende).
async function fetchFinanceJobsByMonth(monthsBack, monthsForward) {
  monthsBack = monthsBack != null ? monthsBack : 1;
  monthsForward = monthsForward != null ? monthsForward : 1;
  const today = new Date();
  const todayIso = today.toISOString().slice(0, 10);
  const currentMonthKey = todayIso.slice(0, 7);
  const rangeStart = new Date(today.getFullYear(), today.getMonth() - monthsBack, 1);
  const rangeEnd = new Date(today.getFullYear(), today.getMonth() + monthsForward + 1, 0);
  const fmt = d => d.toISOString().slice(0, 10);
  const allTasks = [];
  let cursor, page = 0;
  while (page < 20) {
    const args = { size: 100, where: { and: [['startDate', '>=', fmt(rangeStart)], ['startDate', '<=', fmt(rangeEnd)], ['isGroup', false]] } };
    if (cursor) args.page = cursor;
    // Let opgave-forespørgsel uden cost items — det er det der holder den hurtig og
    // fejlfri, ligesom før. Selve budget-beregningen hentes i et separat trin nedenfor.
    const data = await jtFetch({
      query: { $: { grantKey: JT_GRANT }, organization: { $: { id: JT_ORG }, tasks: {
        $: args, nextPage: {},
        nodes: {
          startDate: {}, endDate: {},
          job: { id: {}, name: {}, customFieldValues: { $: { size: 5, where: [['customField', 'name'], 'Projekt Type'] }, nodes: { value: {} } } }
        }
      } } }
    }, 'Økonomi: hent opgaver i vindue');
    const nodes = data?.organization?.tasks?.nodes || [];
    allTasks.push(...nodes);
    const next = data?.organization?.tasks?.nextPage;
    if (!next) break;
    cursor = next;
    page++;
  }

  // Byg ét sæt data pr. sag (ikke pr. opgave) — bruges til placeringslogikken nedenfor.
  // "isActiveNow": har sagen en opgave der løber henover i dag, uanset hvornår den startede.
  const jobInfo = {};
  for (const t of allTasks) {
    if (!t.job || !t.startDate) continue;
    const jobId = t.job.id;
    if (!jobInfo[jobId]) jobInfo[jobId] = { name: t.job.name, fag: t.job.customFieldValues?.nodes?.[0]?.value || 'Ukendt', earliestStart: t.startDate, isActiveNow: false };
    else if (t.startDate < jobInfo[jobId].earliestStart) jobInfo[jobId].earliestStart = t.startDate;
    if (t.startDate <= todayIso && (!t.endDate || t.endDate >= todayIso)) jobInfo[jobId].isActiveNow = true;
  }
  const uniqueJobIds = Object.keys(jobInfo);

  // Henter fakturadatoer pr. sag — bruges til at placere FÆRDIGE (tidligere) måneder
  // efter hvornår sagen faktisk blev faktureret, ikke hvornår opgaven oprindeligt stod
  // til at starte (fx pga. udskydelser undervejs).
  const invoiceMonthsByJob = {};
  let invCursor, invPage = 0;
  while (invPage < 20) {
    const invArgs = { size: 100, where: { and: [['type', 'customerInvoice'], ['createdAt', '>=', fmt(rangeStart)], ['createdAt', '<=', fmt(rangeEnd)]] } };
    if (invCursor) invArgs.page = invCursor;
    const invData = await jtFetch({ query: { $: { grantKey: JT_GRANT }, organization: { $: { id: JT_ORG }, documents: {
      $: invArgs, nextPage: {}, nodes: { createdAt: {}, job: { id: {} } }
    } } } }, 'Økonomi: fakturadatoer i vindue');
    const invNodes = invData?.organization?.documents?.nodes || [];
    for (const d of invNodes) {
      if (!d.job || !d.createdAt) continue;
      const mk = d.createdAt.slice(0, 7);
      if (!invoiceMonthsByJob[d.job.id]) invoiceMonthsByJob[d.job.id] = new Set();
      invoiceMonthsByJob[d.job.id].add(mk);
    }
    const invNext = invData?.organization?.documents?.nextPage;
    if (!invNext) break;
    invCursor = invNext;
    invPage++;
  }

  // FEJL RETTET (tre fejl fundet, seneste den vigtigste): (1) at hente hver enkelt
  // cost item pr. opgave gav "Request Entity Too Large" hos JobTread så snart der var
  // mere end en håndfuld opgaver i vinduet. (2) at summere cost items filtreret på
  // "document.status=approved" tæller forkert, fordi EN sag typisk har FLERE godkendte
  // dokumenter i sit forløb (tilbud → ordre → faktura), og JobTread kopierer linjerne
  // over på hvert nyt dokument — så samme linjer bliver talt 2-3 gange, fordi de findes
  // på flere godkendte dokumenter samtidig (set direkte i data for "Mie Deign", hvor
  // reelt 25.060 kr blev vist som 50.120 kr fordi ordre + faktura begge var "approved").
  // LØSNING: brug dokumentets EGET price-felt i stedet for at summere linjer på tværs
  // af dokumenter. Prioritet: (a) godkendt/approved FAKTURA — det er det der faktisk er
  // faktureret, og kan afvige fra tilbuddet hvis der blev lavet mere/mindre end aftalt;
  // (b) hvis ingen faktura endnu, brug den godkendte/accepterede ORDRE (tilbud); (c) hvis
  // intet af det findes, fald tilbage til rå cost-item-sum (interne linjer uden dokument).
  // Hvis både ordre og faktura findes men beløbene afviger markant (>15%), flages sagen
  // (priceMismatch) i stedet for stiltiende at vælge det ene — så det kan tjekkes manuelt.
  const jobRevenueInfo = {}, totalSumByJob = {};
  const BATCH = 50;
  for (let i = 0; i < uniqueJobIds.length; i += BATCH) {
    const idBatch = uniqueJobIds.slice(i, i + BATCH);
    const docsData = await jtFetch({ query: { $: { grantKey: JT_GRANT }, organization: { $: { id: JT_ORG }, jobs: {
      $: { size: idBatch.length, where: ['id', 'in', idBatch] },
      nodes: { id: {}, documents: { $: { size: 20, where: ['type', 'in', ['customerOrder', 'customerInvoice']] }, nodes: { type: {}, status: {}, price: {}, priceWithTax: {} } } }
    } } } }, 'Økonomi: tilbud/ordre/faktura pr. sag');
    for (const j of docsData?.organization?.jobs?.nodes || []) {
      const docs = j.documents?.nodes || [];
      const invoices = docs.filter(d => d.type === 'customerInvoice' && d.status === 'approved');
      const orders = docs.filter(d => d.type === 'customerOrder' && d.status === 'approved');
      // Martin vil have tallene INKL. moms (priceWithTax), ikke ekskl. (price) — bruges
      // konsekvent til både summen og mismatch-tjekket herunder.
      const invSum = invoices.reduce((s, d) => s + (d.priceWithTax != null ? d.priceWithTax : (d.price || 0)), 0);
      const orderSum = orders.reduce((s, d) => s + (d.priceWithTax != null ? d.priceWithTax : (d.price || 0)), 0);
      let value = null, source = null;
      if (invoices.length) { value = invSum; source = 'invoice'; }
      else if (orders.length) { value = orderSum; source = 'order'; }
      const priceMismatch = !!(invoices.length && orders.length && orderSum > 0 && Math.abs(invSum - orderSum) / orderSum > 0.15);
      jobRevenueInfo[j.id] = { value, source, hasDocument: invoices.length > 0 || orders.length > 0, priceMismatch };
    }
  }
  // Fald tilbage til rå cost-item-sum KUN for sager der slet ikke har nogen godkendt
  // ordre eller faktura endnu (interne linjer uden formelt dokument) — ellers ville de
  // altid vise "intet budget".
  const fallbackJobIds = uniqueJobIds.filter(id => !jobRevenueInfo[id]?.hasDocument);
  for (let i = 0; i < fallbackJobIds.length; i += BATCH) {
    const idBatch = fallbackJobIds.slice(i, i + BATCH);
    const totalData = await jtFetch({ query: { $: { grantKey: JT_GRANT }, organization: { $: { id: JT_ORG }, jobs: {
      $: { size: idBatch.length, where: ['id', 'in', idBatch] },
      nodes: { id: {}, costItems: { sum: { $: 'price' } } }
    } } } }, 'Økonomi: rå sum pr. sag uden tilbud');
    // Cost items har ikke deres eget moms-felt (de er interne budgetlinjer, ikke et
    // kundevendt dokument) — her er der intet godkendt tilbud/faktura at læse momsen fra
    // endnu, så beløbet estimeres med 25% moms lagt til, så det stemmer overens med resten
    // af tallene, der nu alle er inkl. moms.
    for (const j of totalData?.organization?.jobs?.nodes || []) totalSumByJob[j.id] = j.costItems.sum != null ? j.costItems.sum * 1.25 : null;
  }

  const overridesResult = await pool.query('SELECT * FROM finance_job_overrides');
  const overrides = {};
  for (const row of overridesResult.rows) overrides[row.job_id] = row;
  const monthOverridesResult = await pool.query('SELECT * FROM finance_job_month_overrides');
  const monthOverrides = {};
  for (const row of monthOverridesResult.rows) monthOverrides[row.job_id] = row.month_key;

  const monthKeys = [];
  for (let offset = -monthsBack; offset <= monthsForward; offset++) {
    const d = new Date(today.getFullYear(), today.getMonth() + offset, 1);
    monthKeys.push(d.toISOString().slice(0, 7));
  }
  // En sag der er flyttet til en måned uden for det normale vindue (fx langt frem i
  // tiden) skal stadig kunne ses — udvider derfor vinduet med den måned i stedet for
  // stille at ignorere flytningen.
  for (const mk of Object.values(monthOverrides)) if (!monthKeys.includes(mk)) monthKeys.push(mk);
  monthKeys.sort();
  const buckets = {};
  for (const mk of monthKeys) buckets[mk] = {};

  // PLACERINGSLOGIK — tre forskellige regler afhængig af om måneden er fortid, nutid
  // eller fremtid, fordi "hvornår hører denne sag til" betyder noget forskelligt alt
  // efter hvor i forløbet sagen er:
  //  • Tidligere måneder: placeres efter hvornår sagen rent faktisk blev FAKTURERET
  //    (ikke hvornår opgaven oprindeligt stod til at starte).
  //  • Denne måned: aktive sager lige nu, sager der starter denne måned, ELLER sager
  //    der er blevet faktureret denne måned.
  //  • Fremtidige måneder: kun sager med et godkendt (accepteret) tilbud planlagt til
  //    den måned — et upåbegyndt/ikke-godkendt tilbud skal ikke tælle med i en
  //    fremtidig omsætningsprognose.
  for (const jobId of uniqueJobIds) {
    const info = jobInfo[jobId];
    const naturalMk = info.isActiveNow ? currentMonthKey : info.earliestStart.slice(0, 7);
    const invoiceMonths = invoiceMonthsByJob[jobId] ? Array.from(invoiceMonthsByJob[jobId]).sort() : [];
    const revInfo = jobRevenueInfo[jobId] || {};
    const hasAnyDocument = !!revInfo.hasDocument;
    const hasApprovedBudget = hasAnyDocument && revInfo.value != null;

    // PLACERINGSÅRSAG — en klar, læsbar sætning der forklarer PRÆCIS hvorfor sagen
    // landede i denne måned, så Martin hurtigt kan validere om det er korrekt (i stedet
    // for at skulle regne den komplicerede logik ovenfor ud i hovedet hver gang).
    let bucketMk, reason;
    if (invoiceMonths.includes(currentMonthKey)) {
      bucketMk = currentMonthKey;
      reason = 'Der er lavet en faktura på sagen i denne måned.';
    } else if (naturalMk < currentMonthKey) {
      const pastInvoiceMonths = invoiceMonths.filter(m => m < currentMonthKey);
      if (pastInvoiceMonths.length) {
        bucketMk = pastInvoiceMonths[pastInvoiceMonths.length - 1];
        reason = 'Placeret efter seneste faktura (' + bucketMk + ') — sagens opgaver startede oprindeligt ' + naturalMk + '.';
      } else {
        bucketMk = naturalMk;
        reason = 'Ingen faktura fundet endnu — placeret efter sagens oprindelige startdato (' + naturalMk + ').';
      }
    } else if (naturalMk === currentMonthKey) {
      bucketMk = currentMonthKey;
      reason = info.isActiveNow ? 'Sagen har en opgave der kører lige nu (henover dags dato).' : 'Sagens tidligste opgave starter denne måned (' + naturalMk + ').';
    } else {
      bucketMk = hasApprovedBudget ? naturalMk : null;
      reason = hasApprovedBudget ? 'Fremtidig måned — medtaget fordi der er et godkendt tilbud/faktura på sagen (' + (revInfo.source === 'invoice' ? 'faktura' : 'tilbud') + ').' : 'Fremtidig måned uden godkendt tilbud endnu — sagen vises ikke.';
    }

    const manualOverrideMk = monthOverrides[jobId];
    const mk = manualOverrideMk || bucketMk;
    if (mk == null || !buckets[mk]) continue;
    if (manualOverrideMk) reason = 'Manuelt flyttet hertil af dig. (Ville ellers automatisk have ligget i ' + bucketMk + ': ' + reason.charAt(0).toLowerCase() + reason.slice(1) + ')';
    const override = overrides[jobId];
    let value = hasAnyDocument ? (revInfo.value ?? null) : (totalSumByJob[jobId] ?? null);
    let excluded = false;
    if (override) {
      if (override.excluded) excluded = true;
      else if (override.amount !== null && override.amount !== undefined) value = override.amount;
    }
    buckets[mk][jobId] = { jobId, name: info.name, fag: info.fag, value, excluded, hasOverride: !!override, startDate: info.earliestStart, monthMoved: mk !== bucketMk, naturalMonth: bucketMk, valueSource: hasAnyDocument ? revInfo.source : (value != null ? 'costItems' : null), priceMismatch: !!revInfo.priceMismatch, placementReason: reason };
  }

  const manualRows = await pool.query('SELECT * FROM finance_manual_revenue WHERE month_key = ANY($1)', [monthKeys]);

  const result = {};
  for (const mk of monthKeys) {
    let jobs = Object.values(buckets[mk]).filter(j => !j.excluded);
    // BAGUDGÅENDE MÅNEDER = FAKTISKE TAL, IKKE FORECAST. En måned der allerede er
    // overstået skal kun vise sager der reelt ER faktureret — ikke et budget/tilbud-
    // estimat der aldrig blev til en rigtig faktura. Fremtidige/indeværende måneder
    // beholder budget/tilbud-estimatet som forecast, som før.
    if (mk < currentMonthKey) jobs = jobs.filter(j => j.valueSource === 'invoice');
    const manualForMonth = manualRows.rows.filter(r => r.month_key === mk).map(r => ({ jobId: 'manual-' + r.id, manualId: r.id, name: r.name, fag: r.fag, value: r.amount, excluded: false, hasOverride: false, manual: true, placementReason: 'Tilføjet manuelt direkte i denne måned af dig.' }));
    const allJobs = jobs.concat(manualForMonth);
    const byFag = {};
    let total = 0;
    for (const j of allJobs) {
      byFag[j.fag] = byFag[j.fag] || { count: 0, sum: 0 };
      byFag[j.fag].count++;
      byFag[j.fag].sum += j.value || 0;
      total += j.value || 0;
    }
    result[mk] = { jobs: allJobs, byFag, total, missingBudgetCount: allJobs.filter(j => j.value === null).length };
  }
  return result;
}

// ── RYKKER-MAILS (dunning) — kun aktiv hvis admin selv har slået den til under
// Økonomi → Fakturaer. Sender Rykker 1 efter X dage, Rykker 2 efter Y dage, med et
// gebyr lagt til hver gang. Sender aldrig samme niveau to gange for samme faktura.
async function sendDunningEmailForInvoice(inv, targetLevel, settings, companyName) {
  let toEmail = null;
  if (inv.jobId) {
    const taskRow = await pgOne('SELECT customer_email FROM jt_tasks WHERE job_id=$1 AND customer_email IS NOT NULL LIMIT 1', [inv.jobId]);
    toEmail = taskRow?.customer_email || null;
  }
  if (!toEmail) return { sent: false, reason: 'Ingen kunde-e-mail fundet for denne sag' };

  const owed = inv.overrideStatus === 'partial' && inv.remaining != null ? inv.remaining : inv.priceWithTax;
  const totalWithFee = owed + settings.fee_amount;
  const subject = `Rykker ${targetLevel} — ${inv.fullName} — ${companyName}`;
  const text = `Hej,\n\nVi kan se at ${inv.fullName} på ${Math.round(owed).toLocaleString('da-DK')} kr. stadig ikke er betalt.\n\n` +
    `Dette er rykker ${targetLevel}. Der er tillagt et rykkergebyr på ${Math.round(settings.fee_amount).toLocaleString('da-DK')} kr.\n\n` +
    `Nyt beløb i alt: ${Math.round(totalWithFee).toLocaleString('da-DK')} kr.\n\nBetal venligst hurtigst muligt.\n\nVenlig hilsen\n${companyName}`;
  let status = 'sent', error = null;
  try {
    await sendMailUniversal({ to: toEmail, subject, text, html: text.split('\n').map(l => l ? `<p>${l.replace(/</g, '&lt;')}</p>` : '<br>').join('') });
  } catch (e) { status = 'error'; error = redactSecret(e.message || '').slice(0, 500); }
  await pool.query('INSERT INTO finance_dunning_log (document_id,level,to_email,status,error) VALUES ($1,$2,$3,$4,$5)', [inv.id, targetLevel, toEmail, status, error]);
  return status === 'sent' ? { sent: true, level: targetLevel, toEmail } : { sent: false, reason: error };
}

async function runDunningScan(triggeredManually) {
  const settings = await pgOne('SELECT * FROM finance_dunning_settings WHERE id=1');
  if (!settings || (!settings.enabled && !triggeredManually)) return { ran: false, reason: 'Slået fra' };
  if (!mailIsConfigured()) return { ran: false, reason: 'E-mail er ikke konfigureret' };
  const invoices = await fetchFinanceInvoices();
  const today = new Date();
  const settingsRows = await pool.query("SELECT key,value FROM app_settings WHERE key='company_name'");
  const companyName = settingsRows.rows[0]?.value || 'Gulv Master Enterprise ApS';
  let sent1 = 0, sent2 = 0, skippedNoEmail = 0;
  for (const inv of invoices) {
    if (inv.overrideStatus !== 'unpaid' && inv.overrideStatus !== 'partial') continue;
    if (!inv.createdAt) continue;
    const daysOld = Math.floor((today - new Date(inv.createdAt)) / 86400000);
    const logRows = await pool.query('SELECT level FROM finance_dunning_log WHERE document_id=$1 AND status=$2', [inv.id, 'sent']);
    const sentLevels = logRows.rows.map(r => r.level);
    let targetLevel = null;
    if (daysOld >= settings.days_rykker2 && !sentLevels.includes(2) && sentLevels.includes(1)) targetLevel = 2;
    else if (daysOld >= settings.days_rykker1 && !sentLevels.includes(1)) targetLevel = 1;
    if (!targetLevel) continue;
    const result = await sendDunningEmailForInvoice(inv, targetLevel, settings, companyName);
    if (result.sent) { if (targetLevel === 1) sent1++; else sent2++; }
    else if (result.reason === 'Ingen kunde-e-mail fundet for denne sag') skippedNoEmail++;
  }
  await logSystemEvent('dunning_scan', 'info', `Rykker-scan: ${sent1} rykker 1, ${sent2} rykker 2 sendt, ${skippedNoEmail} sprunget over (ingen e-mail).`);
  return { ran: true, sent1, sent2, skippedNoEmail };
}

// Manuel afsendelse for ÉN faktura — uanset dag-tærskler, og uanset til/fra-knappen.
// Vælger automatisk næste niveau (1 hvis intet sendt endnu, ellers 2).
app.post('/api/finance/dunning-send/:documentId', auth, financeOnly, asyncRoute(async (req, res) => {
  if (!mailIsConfigured()) return res.status(400).json({ error: 'E-mail er ikke konfigureret på serveren' });
  const invoices = await fetchFinanceInvoices();
  const inv = invoices.find(i => i.id === req.params.documentId);
  if (!inv) return res.status(404).json({ error: 'Faktura ikke fundet' });
  const settings = await pgOne('SELECT * FROM finance_dunning_settings WHERE id=1');
  const settingsRows = await pool.query("SELECT key,value FROM app_settings WHERE key='company_name'");
  const companyName = settingsRows.rows[0]?.value || 'Gulv Master Enterprise ApS';
  const logRows = await pool.query('SELECT level FROM finance_dunning_log WHERE document_id=$1 AND status=$2', [inv.id, 'sent']);
  const sentLevels = logRows.rows.map(r => r.level);
  const targetLevel = !sentLevels.includes(1) ? 1 : (!sentLevels.includes(2) ? 2 : null);
  if (!targetLevel) return res.status(400).json({ error: 'Der er allerede sendt både rykker 1 og 2 for denne faktura' });
  const result = await sendDunningEmailForInvoice(inv, targetLevel, settings, companyName);
  if (!result.sent) return res.status(400).json({ error: result.reason });
  res.json({ ok: true, level: targetLevel, toEmail: result.toEmail });
}));

app.get('/api/finance/dunning-settings', auth, financeOnly, asyncRoute(async (req, res) => {
  res.json(await pgOne('SELECT * FROM finance_dunning_settings WHERE id=1'));
}));
app.put('/api/finance/dunning-settings', auth, financeOnly, asyncRoute(async (req, res) => {
  const body = req.body || {};
  await pool.query(`
    UPDATE finance_dunning_settings SET enabled=$1,days_rykker1=$2,days_rykker2=$3,fee_amount=$4,updated_at=${nowTextSQL()} WHERE id=1
  `, [body.enabled ? 1 : 0, Number(body.days_rykker1) || 14, Number(body.days_rykker2) || 28, Number(body.fee_amount) || 100]);
  res.json({ ok: true });
}));
app.get('/api/finance/dunning-log', auth, financeOnly, asyncRoute(async (req, res) => {
  const rows = await pool.query('SELECT * FROM finance_dunning_log ORDER BY id DESC LIMIT 100');
  res.json(rows.rows);
}));
app.post('/api/finance/dunning-run', auth, financeOnly, asyncRoute(async (req, res) => {
  res.json(await runDunningScan(true));
}));

app.get('/api/finance/panel-order/:panel', auth, financeOnly, asyncRoute(async (req, res) => {
  const row = await pgOne('SELECT order_json FROM finance_panel_order WHERE panel=$1', [req.params.panel]);
  res.json({ order: row ? JSON.parse(row.order_json) : null });
}));
app.put('/api/finance/panel-order', auth, financeOnly, asyncRoute(async (req, res) => {
  const body = req.body || {};
  if (!body.panel || !Array.isArray(body.order)) return res.status(400).json({ error: 'panel og order skal udfyldes' });
  await pool.query(`
    INSERT INTO finance_panel_order (panel,order_json,updated_at) VALUES ($1,$2,${nowTextSQL()})
    ON CONFLICT (panel) DO UPDATE SET order_json=$2,updated_at=${nowTextSQL()}
  `, [body.panel, JSON.stringify(body.order)]);
  res.json({ ok: true });
}));

app.get('/api/finance/panel-box-size/:panel', auth, financeOnly, asyncRoute(async (req, res) => {
  const rows = await pool.query('SELECT box_id,width,height FROM finance_panel_box_size WHERE panel=$1', [req.params.panel]);
  const out = {};
  for (const r of rows.rows) out[r.box_id] = { width: r.width, height: r.height };
  res.json(out);
}));
app.put('/api/finance/panel-box-size', auth, financeOnly, asyncRoute(async (req, res) => {
  const body = req.body || {};
  if (!body.panel || !body.boxId || !body.width || !body.height) return res.status(400).json({ error: 'panel, boxId, width og height skal udfyldes' });
  await pool.query(`
    INSERT INTO finance_panel_box_size (panel,box_id,width,height,updated_at) VALUES ($1,$2,$3,$4,${nowTextSQL()})
    ON CONFLICT (panel,box_id) DO UPDATE SET width=$3,height=$4,updated_at=${nowTextSQL()}
  `, [body.panel, body.boxId, Math.round(body.width), Math.round(body.height)]);
  res.json({ ok: true });
}));

app.post('/api/finance/manual-revenue', auth, financeOnly, asyncRoute(async (req, res) => {
  const body = req.body || {};
  if (!body.month_key || !body.name) return res.status(400).json({ error: 'Måned og navn skal udfyldes' });
  const r = await pool.query('INSERT INTO finance_manual_revenue (month_key,name,fag,amount) VALUES ($1,$2,$3,$4) RETURNING id', [body.month_key, String(body.name).slice(0, 200), body.fag || 'Ukendt', Number(body.amount) || 0]);
  res.json({ ok: true, id: r.rows[0].id });
}));
app.put('/api/finance/manual-revenue/:id', auth, financeOnly, asyncRoute(async (req, res) => {
  const body = req.body || {};
  await pool.query(`UPDATE finance_manual_revenue SET name=$1,fag=$2,amount=$3,updated_at=${nowTextSQL()} WHERE id=$4`, [String(body.name || '').slice(0, 200), body.fag || 'Ukendt', Number(body.amount) || 0, req.params.id]);
  res.json({ ok: true });
}));
app.delete('/api/finance/manual-revenue/:id', auth, financeOnly, asyncRoute(async (req, res) => {
  await pool.query('DELETE FROM finance_manual_revenue WHERE id=$1', [req.params.id]);
  res.json({ ok: true });
}));

app.put('/api/finance/job-month-override/:jobId', auth, financeOnly, asyncRoute(async (req, res) => {
  const monthKey = String(req.body?.monthKey || '').trim();
  if (!monthKey) {
    await pool.query('DELETE FROM finance_job_month_overrides WHERE job_id=$1', [req.params.jobId]);
    return res.json({ ok: true });
  }
  if (!/^\d{4}-\d{2}$/.test(monthKey)) return res.status(400).json({ error: 'Ugyldig måned' });
  await pool.query(`
    INSERT INTO finance_job_month_overrides (job_id,month_key,updated_at) VALUES ($1,$2,${nowTextSQL()})
    ON CONFLICT (job_id) DO UPDATE SET month_key=$2,updated_at=${nowTextSQL()}
  `, [req.params.jobId, monthKey]);
  res.json({ ok: true });
}));
app.get('/api/finance/job-status-marks', auth, financeOnly, asyncRoute(async (req, res) => {
  const rows = await pool.query('SELECT job_key, status FROM finance_job_status_marks');
  const out = {};
  for (const r of rows.rows) out[r.job_key] = r.status;
  res.json(out);
}));
app.put('/api/finance/job-status-marks/:jobKey', auth, financeOnly, asyncRoute(async (req, res) => {
  const status = String(req.body?.status || '').trim();
  if (!status) {
    await pool.query('DELETE FROM finance_job_status_marks WHERE job_key=$1', [req.params.jobKey]);
    return res.json({ ok: true });
  }
  if (!['running', 'invoiced', 'hold', 'done'].includes(status)) return res.status(400).json({ error: 'Ugyldig status' });
  await pool.query(`
    INSERT INTO finance_job_status_marks (job_key,status,updated_at) VALUES ($1,$2,${nowTextSQL()})
    ON CONFLICT (job_key) DO UPDATE SET status=$2,updated_at=${nowTextSQL()}
  `, [req.params.jobKey, status]);
  res.json({ ok: true });
}));
app.get('/api/finance/revenue', auth, financeOnly, asyncRoute(async (req, res) => {
  const monthsBack = Math.min(12, Math.max(0, Number(req.query.monthsBack) || 0));
  const monthsForward = Math.min(6, Math.max(1, Number(req.query.monthsForward) || 1));
  const data = await fetchFinanceJobsByMonth(monthsBack, monthsForward);
  res.json(data);
}));

// Hele kalenderåret (januar-december) i ét kald — bruges af årsgrafen i Oversigt.
// Omsætning er sagsbudget-baseret (samme metode som resten af Omsætning pr. fag),
// så fag-opdelingen er tilgængelig for alle 12 måneder ensartet. Udgifter hentes fra
// de månedsopdelte udgiftsposter under Udgifter-fanen.
app.get('/api/finance/year-overview', auth, financeOnly, asyncRoute(async (req, res) => {
  const today = new Date();
  const year = Math.min(today.getFullYear() + 1, Math.max(today.getFullYear() - 3, Number(req.query.year) || today.getFullYear()));
  const isCurrentYear = year === today.getFullYear();
  const monthsBack = isCurrentYear ? today.getMonth() : (year < today.getFullYear() ? 11 : 0);
  const monthsForward = isCurrentYear ? (11 - today.getMonth()) : (year > today.getFullYear() ? 11 : 0);
  const revenue = await fetchFinanceJobsByMonth(monthsBack, monthsForward);
  const monthKeys = [];
  for (let m = 0; m < 12; m++) monthKeys.push(`${year}-${String(m + 1).padStart(2, '0')}`);
  const expenseRows = await pool.query('SELECT month_key, COALESCE(SUM(amount),0)::float AS total FROM finance_expenses WHERE month_key = ANY($1) GROUP BY month_key', [monthKeys]);
  const expenseByMonth = {};
  for (const r of expenseRows.rows) expenseByMonth[r.month_key] = r.total;
  const result = {};
  for (const mk of monthKeys) {
    const m = revenue[mk];
    result[mk] = { total: m ? m.total : null, byFag: m ? m.byFag : {}, jobs: m ? m.jobs : [], expenses: expenseByMonth[mk] || 0, hasData: !!m };
  }
  res.json({ year, months: result });
}));

// ── Selvvalgte graf-widgets i Oversigt ──
app.get('/api/finance/dashboard-widgets', auth, financeOnly, asyncRoute(async (req, res) => {
  const rows = await pool.query('SELECT * FROM finance_dashboard_widgets ORDER BY sort_order ASC, id ASC');
  res.json(rows.rows);
}));
app.post('/api/finance/dashboard-widgets', auth, financeOnly, asyncRoute(async (req, res) => {
  const body = req.body || {};
  const allowed = ['trend', 'year', 'fag_pie', 'invoice_status', 'expense_pie', 'vat_deadline', 'todo_today'];
  if (!allowed.includes(body.widget_type)) return res.status(400).json({ error: 'Ukendt graftype' });
  const maxOrder = await pgOne('SELECT COALESCE(MAX(sort_order),-1)::int AS m FROM finance_dashboard_widgets');
  const r = await pool.query('INSERT INTO finance_dashboard_widgets (widget_type, sort_order) VALUES ($1,$2) RETURNING id', [body.widget_type, (maxOrder ? maxOrder.m : -1) + 1]);
  res.json({ ok: true, id: r.rows[0].id });
}));
app.delete('/api/finance/dashboard-widgets/:id', auth, financeOnly, asyncRoute(async (req, res) => {
  await pool.query('DELETE FROM finance_dashboard_widgets WHERE id=$1', [req.params.id]);
  res.json({ ok: true });
}));


app.put('/api/finance/job-override/:jobId', auth, financeOnly, asyncRoute(async (req, res) => {
  const body = req.body || {};
  const amount = body.amount === '' || body.amount === null || body.amount === undefined ? null : Number(body.amount);
  const excluded = !!body.excluded;
  const note = body.note ? String(body.note).slice(0, 500) : null;
  await pool.query(`
    INSERT INTO finance_job_overrides (job_id,amount,excluded,note,updated_at) VALUES ($1,$2,$3,$4,${nowTextSQL()})
    ON CONFLICT (job_id) DO UPDATE SET amount=$2,excluded=$3,note=$4,updated_at=${nowTextSQL()}
  `, [req.params.jobId, amount, excluded ? 1 : 0, note]);
  res.json({ ok: true });
}));

// ── Fakturaer: live fra JobTread + manuel status-override (Billy/bank er ikke
// tilgængelig via API, så status rettes manuelt af admin og gemmes her).
async function fetchFinanceInvoices() {
  // FIK KUN DE NYESTE 100 FAKTURAER FØR — uden sideskift (nextPage) faldt alt ældre end
  // faktura #101 helt ud af datasættet. Det gjorde bl.a. moms-estimatet og Resultat-grafen
  // stille og roligt forkerte for alle måneder der lå længere tilbage end de ~100 seneste
  // fakturaer (fx viste et helt kvartal 0 kr, selvom der var fakturaer i det). Nu bladres
  // der igennem alle sider ligesom de øvrige JobTread-forespørgsler i denne fil.
  let cursor, page = 0, nodes = [];
  while (page < 30) {
    const args = { size: 100, sortBy: [{ field: 'createdAt', order: 'desc' }], where: ['type', 'customerInvoice'] };
    if (cursor) args.page = cursor;
    const data = await jtFetch({
      query: { $: { grantKey: JT_GRANT }, organization: { $: { id: JT_ORG }, documents: {
        $: args,
        nextPage: {},
        nodes: { id: {}, fullName: {}, createdAt: {}, price: {}, priceWithTax: {}, balance: {}, status: {}, job: { id: {}, name: {}, number: {}, location: { account: { id: {}, name: {} } } } }
      } } }
    }, `Økonomi: hent fakturaer s.${page + 1}`);
    const conn = data?.organization?.documents || {};
    const pageNodes = Array.isArray(conn.nodes) ? conn.nodes : [];
    nodes = nodes.concat(pageNodes);
    page++;
    const next = conn.nextPage;
    if (!next || next === '' || !pageNodes.length) break;
    cursor = next;
  }
  const overridesResult = await pool.query('SELECT * FROM finance_invoice_overrides');
  const overrides = {};
  for (const row of overridesResult.rows) overrides[row.document_id] = row;
  return nodes.filter(d => d.status !== 'denied').map(d => {
    const ov = overrides[d.id];
    const remaining = ov?.status === 'partial' && ov?.paid_amount != null ? Math.max(0, (d.priceWithTax || 0) - ov.paid_amount) : null;
    return {
      id: d.id, fullName: d.fullName, customer: d.job?.location?.account?.name || d.job?.name || '', accountId: d.job?.location?.account?.id || null, jobId: d.job?.id || null, jobNumber: d.job?.number || '',
      createdAt: d.createdAt, price: d.price, priceWithTax: d.priceWithTax, balance: d.balance, jtStatus: d.status,
      overrideStatus: ov?.status || (d.balance === 0 ? 'paid' : 'unpaid'),
      note: ov?.note || '', paidAmount: ov?.paid_amount ?? null, remaining
    };
  });
}
// SKRIV BETALING TILBAGE TIL JOBTREAD — bevidst en 2-trins proces der matcher deres
// egen API: (1) opret selve betalingen ("credit"), (2) knyt den til den specifikke
// faktura med et beløb. Bruges KUN når admin selv har afkrydset det — aldrig
// automatisk — fordi det skriver rigtige, permanente finansielle data i JobTread.
async function writePaymentToJobTread(documentId, accountId, amount, note) {
  if (!accountId) throw new Error('Fakturaen har ingen tilknyttet kundekonto i JobTread — kan ikke registrere betaling der.');
  const paidAt = new Date().toISOString();
  const paymentData = await jtFetch({
    query: {
      $: { grantKey: JT_GRANT },
      createPayment: {
        $: {
          organizationId: JT_ORG,
          accountId,
          amount,
          paidAt,
          type: 'credit',
          source: 'Gulv Master-portal',
          description: note || 'Registreret via Gulv Master-portalen',
          attemptAutoMatch: false
        },
        createdPayment: { id: {} }
      }
    }
  }, 'Økonomi: opret betaling i JobTread');
  const paymentId = paymentData?.createPayment?.createdPayment?.id;
  if (!paymentId) throw new Error('JobTread returnerede ikke et betalings-id');
  await jtFetch({
    query: {
      $: { grantKey: JT_GRANT },
      createDocumentPayment: {
        $: { documentId, paymentId, amount, isLinkedToQbo: false },
        createdDocumentPayment: { id: {} }
      }
    }
  }, 'Økonomi: knyt betaling til faktura i JobTread');
  return paymentId;
}
app.get('/api/finance/invoices', auth, financeOnly, asyncRoute(async (req, res) => {
  res.json(await fetchFinanceInvoices());
}));

app.put('/api/finance/invoices/:documentId', auth, financeOnly, asyncRoute(async (req, res) => {
  const body = req.body || {};
  const status = ['paid', 'unpaid', 'unclear', 'partial'].includes(body.status) ? body.status : 'unpaid';
  const note = body.note ? String(body.note).slice(0, 500) : null;
  const paidAmount = status === 'partial' && body.paidAmount !== '' && body.paidAmount != null ? Number(body.paidAmount) : null;
  await pool.query(`
    INSERT INTO finance_invoice_overrides (document_id,status,note,paid_amount,updated_at) VALUES ($1,$2,$3,$4,${nowTextSQL()})
    ON CONFLICT (document_id) DO UPDATE SET status=$2,note=$3,paid_amount=$4,updated_at=${nowTextSQL()}
  `, [req.params.documentId, status, note, paidAmount]);
  // Kun hvis admin selv har bedt om det — se writePaymentToJobTread ovenfor for hvorfor.
  if (body.syncToJobtread && (status === 'paid' || status === 'partial')) {
    try {
      const invoices = await fetchFinanceInvoices();
      const inv = invoices.find(i => i.id === req.params.documentId);
      if (!inv) throw new Error('Fakturaen blev ikke fundet');
      const amountToWrite = status === 'paid' ? inv.priceWithTax : paidAmount;
      if (!(amountToWrite > 0)) throw new Error('Ugyldigt beløb at registrere');
      await writePaymentToJobTread(req.params.documentId, inv.accountId, amountToWrite, note);
      return res.json({ ok: true, jobtreadSynced: true });
    } catch (error) {
      // Status-ændringen i vores egen database er allerede gemt og lykkedes — kun
      // selve JobTread-delen fejlede, så det rapporteres tydeligt, ikke skjules.
      return res.json({ ok: true, jobtreadSynced: false, jobtreadError: error.message });
    }
  }
  res.json({ ok: true });
}));

// ══════════════════════════════════════════════════════════════
// AUTOMATISK BANKAFSTEMNING — upload et bankudtog (PDF/Excel/CSV fra fx Lunar), få det
// læst og matchet mod udestående fakturaer på beløb, kundenavn og sagsnummer. Intet
// anvendes automatisk — Martin bekræfter hvert match, før en faktura markeres betalt.
function parseDanishAmount(raw) {
  if (raw === null || raw === undefined) return null;
  let s = String(raw).trim().replace(/kr\.?/i, '').replace(/\s/g, '').replace(/^\+/, '');
  if (!s) return null;
  if (s.includes(',') && s.includes('.')) s = s.replace(/\./g, '').replace(',', '.');
  else if (s.includes(',')) s = s.replace(',', '.');
  const n = parseFloat(s);
  return Number.isFinite(n) ? n : null;
}
function parseDanishDate(raw) {
  if (raw === null || raw === undefined) return null;
  const s = String(raw).trim();
  let m = s.match(/^(\d{4})-(\d{1,2})-(\d{1,2})/);
  if (m) return `${m[1]}-${m[2].padStart(2, '0')}-${m[3].padStart(2, '0')}`;
  m = s.match(/^(\d{1,2})[.\-\/](\d{1,2})[.\-\/](\d{2,4})/);
  if (!m) return null;
  let [, d, mo, y] = m;
  if (y.length === 2) y = (Number(y) > 50 ? '19' : '20') + y;
  const iso = `${y}-${mo.padStart(2, '0')}-${d.padStart(2, '0')}`;
  return /^\d{4}-\d{2}-\d{2}$/.test(iso) ? iso : null;
}
function parseBankStatementPdfText(text) {
  const lines = String(text || '').split('\n').map(l => l.trim()).filter(Boolean);
  const lineRe = /^(\d{1,2}[.\-\/]\d{1,2}[.\-\/]\d{2,4})\s+(.+?)\s+(-?[\d.,]+)\s*(?:kr\.?)?$/i;
  const txns = [];
  for (const line of lines) {
    const m = line.match(lineRe);
    if (!m) continue;
    const dateIso = parseDanishDate(m[1]);
    const amount = parseDanishAmount(m[3]);
    const txnText = m[2].trim();
    if (dateIso && amount !== null) txns.push({ date: dateIso, text: txnText, amount, externalId: bankTxnFingerprint(dateIso, txnText, amount) });
  }
  return txns;
}
function parseBankStatementSpreadsheet(buffer) {
  if (!XLSX) throw new Error('Excel/CSV-læsning er ikke tilgængelig på serveren lige nu — kontakt support.');
  const wb = XLSX.read(buffer, { type: 'buffer', cellDates: false });
  const sheet = wb.Sheets[wb.SheetNames[0]];
  const rows = XLSX.utils.sheet_to_json(sheet, { header: 1, raw: false, defval: '' });
  let headerRowIdx = -1, dateCol = -1, textCol = -1, amountCol = -1, idCol = -1;
  for (let i = 0; i < Math.min(rows.length, 10); i++) {
    const row = (rows[i] || []).map(c => String(c).toLowerCase());
    const dIdx = row.findIndex(c => /dato|date/.test(c));
    const tIdx = row.findIndex(c => /tekst|beskrivelse|besked|text|title|narrative|memo|reference/.test(c));
    const aIdx = row.findIndex(c => /bel[øo]b|amount/.test(c));
    const iIdx = row.findIndex(c => /transaction ?id|transaktions?id|reference ?nr/.test(c));
    if (dIdx > -1 && aIdx > -1) { headerRowIdx = i; dateCol = dIdx; textCol = tIdx; amountCol = aIdx; idCol = iIdx; break; }
  }
  const startRow = headerRowIdx > -1 ? headerRowIdx + 1 : 0;
  const dc = dateCol > -1 ? dateCol : 0, tc = textCol > -1 ? textCol : 1, ac = amountCol > -1 ? amountCol : 2;
  const txns = [];
  for (let i = startRow; i < rows.length; i++) {
    const row = rows[i];
    if (!row || !row.length) continue;
    const dateIso = parseDanishDate(row[dc]);
    const amount = parseDanishAmount(row[ac]);
    const text = String(row[tc] || '').trim();
    // Brug bankens egen transaktions-id hvis den findes i filen — ellers en stabil
    // "fingeraftryk" af dato+tekst+beløb, så vi kan genkende samme postering igen
    // ved en senere upload og huske at den allerede er bogført.
    const externalId = (idCol > -1 && row[idCol]) ? String(row[idCol]).trim() : null;
    if (dateIso && amount !== null) txns.push({ date: dateIso, text, amount, externalId: externalId || bankTxnFingerprint(dateIso, text, amount) });
  }
  return txns;
}
function bankTxnFingerprint(date, text, amount) {
  return crypto.createHash('sha1').update(`${date}|${text}|${amount}`).digest('hex').slice(0, 24);
}
function normalizeForMatch(s) {
  return String(s || '').toLowerCase()
    .replace(/æ/g, 'ae').replace(/ø/g, 'oe').replace(/å/g, 'aa')
    .replace(/[^a-z0-9]+/g, ' ').trim();
}
function matchTransactionsToInvoices(transactions, invoices) {
  // FEJL RETTET: udelukkede tidligere alle allerede-betalte fakturaer fra matchningen
  // — så en indbetaling der reelt hørte til en faktura JobTread allerede havde
  // registreret som betalt, viste bare "intet forslag" i stedet for at blive
  // genkendt. Det gjorde bankudtoget langt mere forvirrende end nødvendigt, fordi
  // størstedelen af "uforklarede" posteringer reelt bare var allerede afklarede.
  const candidates = invoices;
  return transactions.map(txn => {
    if (!(txn.amount > 0)) return { ...txn, matches: [] }; // kun indbetalinger (positive beløb) giver mening at matche
    const txnNorm = normalizeForMatch(txn.text);
    const sagsMatch = txn.text.match(/GM[-\s]?(\d{2,4})[-\s]?(\d+)/i);
    const sagsNorm = sagsMatch ? sagsMatch[0].toUpperCase().replace(/\s/g, '') : null;
    const scored = candidates.map(inv => {
      let score = 0; const reasons = [];
      const invAmount = inv.remaining !== null && inv.remaining !== undefined ? inv.remaining : inv.priceWithTax;
      const diff = Math.abs((invAmount || 0) - txn.amount);
      if (diff < 1) { score += 45; reasons.push('Beløb matcher præcist'); }
      else if (diff < 5) { score += 35; reasons.push('Beløb matcher (lille afvigelse)'); }
      else if (invAmount > 0) {
        // Fanger delvise betalinger/krediteringer — beløbet behøver ikke matche
        // præcist, kunden kan have betalt for lidt eller fået en delvis kreditering.
        // Jo tættere de to beløb er, jo mere point, men det stopper aldrig helt en
        // ellers stærk navne-match, bare fordi beløbet afviger.
        const ratio = Math.min(txn.amount, invAmount) / Math.max(txn.amount, invAmount);
        if (ratio >= 0.25) {
          score += Math.round(ratio * 22);
          reasons.push(txn.amount < invAmount ? 'Beløb lavere end fakturaen — muligvis delvis betaling' : 'Beløb højere end forventet — tjek for kreditering/flere fakturaer');
        }
      }
      const custNorm = normalizeForMatch(inv.customer);
      if (custNorm && txnNorm.includes(custNorm)) { score += 35; reasons.push('Kundenavn fundet i teksten'); }
      else if (custNorm) {
        const words = custNorm.split(' ').filter(w => w.length >= 3);
        const hits = words.filter(w => txnNorm.includes(w)).length;
        if (words.length && hits) { score += Math.round(20 * hits / words.length); reasons.push('Delvist kundenavn-match'); }
      }
      const fullNameNorm = normalizeForMatch(inv.fullName);
      if (fullNameNorm && txnNorm.includes(fullNameNorm)) { score += 22; reasons.push('Fakturanavn fundet i teksten'); }
      else if (fullNameNorm) {
        const words = fullNameNorm.split(' ').filter(w => w.length >= 3);
        const hits = words.filter(w => txnNorm.includes(w)).length;
        if (words.length && hits) { score += Math.round(16 * hits / words.length); reasons.push('Delvist fakturanavn-match'); }
      }
      if (sagsNorm && inv.jobNumber && sagsNorm.replace('GM-', '').includes(String(inv.jobNumber).replace(/^GM-?/i, ''))) {
        score += 30; reasons.push('Sagsnummer fundet i teksten');
      }
      if (inv.overrideStatus === 'paid') { score -= 10; reasons.push('Fakturaen er allerede registreret betalt'); }
      return { documentId: inv.id, customer: inv.customer, fullName: inv.fullName, jobId: inv.jobId, jobNumber: inv.jobNumber, priceWithTax: inv.priceWithTax, remaining: inv.remaining, overrideStatus: inv.overrideStatus, accountId: inv.accountId, score, reasons };
    }).filter(m => m.score >= 22).sort((a, b) => b.score - a.score).slice(0, 3);
    return { ...txn, matches: scored };
  });
}
app.post('/api/finance/bank-statement/parse', auth, financeOnly, uploadBankStatement.single('file'), asyncRoute(async (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'Ingen fil modtaget' });
  const lower = String(req.file.originalname || '').toLowerCase();
  let transactions = [];
  try {
    if (lower.endsWith('.pdf')) {
      if (!pdfParse) return res.status(400).json({ error: 'PDF-læsning er ikke tilgængelig på serveren lige nu — prøv en Excel/CSV-eksport i stedet.' });
      const parsed = await pdfParse(req.file.buffer);
      transactions = parseBankStatementPdfText(parsed.text);
    } else {
      transactions = parseBankStatementSpreadsheet(req.file.buffer);
    }
  } catch (e) {
    return res.status(400).json({ error: 'Kunne ikke læse filen: ' + e.message });
  }
  if (!transactions.length) {
    return res.status(400).json({ error: 'Fandt ingen genkendelige transaktioner i filen. Prøv evt. en Excel/CSV-eksport i stedet for PDF — det læses langt mere pålideligt.' });
  }
  const reconciledRows = await pool.query('SELECT * FROM finance_bank_reconciled WHERE external_id = ANY($1)', [transactions.map(t => t.externalId)]);
  const reconciledByExternalId = {};
  for (const row of reconciledRows.rows) reconciledByExternalId[row.external_id] = row;
  const invoices = await fetchFinanceInvoices();
  const matched = matchTransactionsToInvoices(transactions, invoices).map(t => {
    const rec = reconciledByExternalId[t.externalId];
    return rec ? { ...t, alreadyReconciled: { customer: rec.customer, reconciledAt: rec.reconciled_at, documentId: rec.document_id, kind: rec.kind || 'matched' } } : t;
  });
  // Gemmer filen server-side, så man kan forlade siden eller genindlæse browseren
  // uden at skulle uploade den samme fil igen — den ligger her indtil næste upload.
  await pool.query(`
    INSERT INTO finance_bank_session (id,filename,transactions_json,uploaded_at) VALUES (1,$1,$2,${nowTextSQL()})
    ON CONFLICT (id) DO UPDATE SET filename=$1,transactions_json=$2,uploaded_at=${nowTextSQL()}
  `, [req.file.originalname || null, JSON.stringify(matched)]);
  res.json({ transactions: matched, count: transactions.length, filename: req.file.originalname });
}));
app.get('/api/finance/bank-statement/session', auth, financeOnly, asyncRoute(async (req, res) => {
  const row = await pgOne('SELECT * FROM finance_bank_session WHERE id=1');
  if (!row) return res.json({ transactions: null });
  let transactions = [];
  try { transactions = JSON.parse(row.transactions_json || '[]'); } catch (e) { transactions = []; }
  res.json({ transactions, filename: row.filename, uploadedAt: row.uploaded_at });
}));

// ── Bagudgående måneders "rigtige" udgifter fra bank-CSV/Excel — se kommentar ved
// CREATE TABLE finance_bank_month_statements. Bevidst ADSKILT fra
// /api/finance/bank-statement/parse ovenfor (som kun husker én fil ad
// gangen og bruges til fakturamatching) — her uploader man én fil PR. MÅNED, og den
// gemmes permanent under den måned, så man kan bygge et helt års rigtige udgiftstal op
// måned for måned uden at nyere uploads sletter ældre måneders data.
app.post('/api/finance/bank-statement/upload-month', auth, financeOnly, uploadBankStatement.single('file'), asyncRoute(async (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'Ingen fil modtaget' });
  const monthKey = String(req.body?.month || req.query?.month || '');
  if (!/^\d{4}-\d{2}$/.test(monthKey)) return res.status(400).json({ error: 'Ugyldig eller manglende måned' });
  const lower = String(req.file.originalname || '').toLowerCase();
  let transactions = [];
  try {
    if (lower.endsWith('.pdf')) {
      if (!pdfParse) return res.status(400).json({ error: 'PDF-læsning er ikke tilgængelig på serveren lige nu — prøv en Excel/CSV-eksport i stedet.' });
      const parsed = await pdfParse(req.file.buffer);
      transactions = parseBankStatementPdfText(parsed.text);
    } else {
      transactions = parseBankStatementSpreadsheet(req.file.buffer);
    }
  } catch (e) {
    return res.status(400).json({ error: 'Kunne ikke læse filen: ' + e.message });
  }
  if (!transactions.length) {
    return res.status(400).json({ error: 'Fandt ingen genkendelige transaktioner i filen. Prøv evt. en Excel/CSV-eksport i stedet for PDF.' });
  }
  // "Alle hævninger tæller" — summerer samtlige negative posteringer (penge ud af
  // kontoen) i den valgte måned som udgifter, uanset hvad de dækker over. Simpelt og
  // hurtigt, men bemærk at det derfor også inkluderer fx moms-betalinger, lån og
  // interne overførsler — ikke kun "rene" driftsudgifter.
  let expenseTotal = 0, incomeTotal = 0;
  transactions.forEach(t => { if (t.amount < 0) expenseTotal += Math.abs(t.amount); else incomeTotal += t.amount; });
  await pool.query(`
    INSERT INTO finance_bank_month_statements (month_key,filename,transactions_json,expense_total,income_total,txn_count,uploaded_at)
    VALUES ($1,$2,$3,$4,$5,$6,${nowTextSQL()})
    ON CONFLICT (month_key) DO UPDATE SET filename=$2,transactions_json=$3,expense_total=$4,income_total=$5,txn_count=$6,uploaded_at=${nowTextSQL()}
  `, [monthKey, req.file.originalname || null, JSON.stringify(transactions), expenseTotal, incomeTotal, transactions.length]);
  res.json({ ok: true, month: monthKey, expenseTotal, incomeTotal, count: transactions.length, filename: req.file.originalname });
}));
app.get('/api/finance/bank-statement/month-totals', auth, financeOnly, asyncRoute(async (req, res) => {
  const months = String(req.query.months || '').split(',').filter(m => /^\d{4}-\d{2}$/.test(m));
  const out = {};
  if (!months.length) return res.json(out);
  const rows = await pool.query('SELECT month_key,filename,expense_total,income_total,txn_count,uploaded_at FROM finance_bank_month_statements WHERE month_key = ANY($1)', [months]);
  for (const r of rows.rows) out[r.month_key] = { filename: r.filename, expenseTotal: r.expense_total, incomeTotal: r.income_total, count: r.txn_count, uploadedAt: r.uploaded_at };
  res.json(out);
}));
app.delete('/api/finance/bank-statement/month/:month', auth, financeOnly, asyncRoute(async (req, res) => {
  await pool.query('DELETE FROM finance_bank_month_statements WHERE month_key=$1', [req.params.month]);
  res.json({ ok: true });
}));

app.post('/api/finance/bank-statement/mark-reconciled', auth, financeOnly, asyncRoute(async (req, res) => {
  const body = req.body || {};
  if (!body.externalId) return res.status(400).json({ error: 'Mangler transaktions-id' });
  const kind = body.kind === 'ignored' ? 'ignored' : 'matched';
  await pool.query(`
    INSERT INTO finance_bank_reconciled (external_id,txn_date,txn_text,txn_amount,document_id,customer,kind,reconciled_at)
    VALUES ($1,$2,$3,$4,$5,$6,$7,${nowTextSQL()})
    ON CONFLICT (external_id) DO UPDATE SET document_id=$5,customer=$6,kind=$7,reconciled_at=${nowTextSQL()}
  `, [body.externalId, body.date || null, body.text || null, body.amount || null, body.documentId || null, body.customer || null, kind]);
  res.json({ ok: true });
}));
app.post('/api/finance/bank-statement/unreconcile', auth, financeOnly, asyncRoute(async (req, res) => {
  const externalId = String(req.body?.externalId || '');
  if (!externalId) return res.status(400).json({ error: 'Mangler transaktions-id' });
  await pool.query('DELETE FROM finance_bank_reconciled WHERE external_id=$1', [externalId]);
  res.json({ ok: true });
}));
// ── Faste udgifter ──
app.get('/api/finance/expenses', auth, financeOnly, asyncRoute(async (req, res) => {
  const monthKey = /^\d{4}-\d{2}$/.test(req.query.month) ? req.query.month : new Date().toISOString().slice(0, 7);
  const cats = await pool.query('SELECT * FROM finance_expense_categories ORDER BY sort_order ASC');
  let items = await pool.query('SELECT * FROM finance_expenses WHERE month_key=$1 ORDER BY id ASC', [monthKey]);
  // Ny/tom måned: klon poster (navn + beløb) fra den seneste tidligere måned der HAR
  // data, som udgangspunkt — undgår at skulle genindtaste 30 linjer hver måned. Betalt-
  // status nulstilles altid, da det er en ny måneds regninger.
  if (items.rows.length === 0) {
    const prior = await pgOne("SELECT month_key FROM finance_expenses WHERE month_key < $1 ORDER BY month_key DESC LIMIT 1", [monthKey]);
    if (prior) {
      const priorItems = await pool.query('SELECT * FROM finance_expenses WHERE month_key=$1', [prior.month_key]);
      for (const it of priorItems.rows) {
        await pool.query('INSERT INTO finance_expenses (category_id,name,amount,paid,month_key) VALUES ($1,$2,$3,0,$4)', [it.category_id, it.name, it.amount, monthKey]);
      }
      items = await pool.query('SELECT * FROM finance_expenses WHERE month_key=$1 ORDER BY id ASC', [monthKey]);
    }
  }
  const byCategory = cats.rows.map(c => ({ ...c, items: items.rows.filter(i => i.category_id === c.id) }));
  res.json({ month: monthKey, categories: byCategory });
}));
// Bruges af Oversigt-graffen til at hente det rigtige udgiftstal pr. måned, i stedet
// for at antage samme beløb hver måned.
app.get('/api/finance/expenses-totals', auth, financeOnly, asyncRoute(async (req, res) => {
  const months = String(req.query.months || '').split(',').filter(m => /^\d{4}-\d{2}$/.test(m));
  const out = {};
  if (!months.length) return res.json(out);
  const currentMonthKey = new Date().toISOString().slice(0, 7);
  const overrideRows = await pool.query('SELECT month_key, amount FROM finance_expense_month_totals WHERE month_key = ANY($1)', [months]);
  const overrides = {};
  for (const r of overrideRows.rows) overrides[r.month_key] = r.amount;
  // Bagudgående måneders faktiske udgifter fra en uploadet bank-CSV/Excel (se
  // finance_bank_month_statements) — kun relevant for måneder der allerede er
  // overstået. Prioritet: manuel override > bank-CSV (kun bagud) > udspecificerede
  // poster fra Udgifter-fanen. Fremtidige/indeværende måneder rører aldrig CSV-tallet,
  // da det jo netop er forecast (planlagte/manuelt indtastede poster).
  const pastMonths = months.filter(mk => mk < currentMonthKey && overrides[mk] == null);
  const bankTotals = {};
  if (pastMonths.length) {
    const bankRows = await pool.query('SELECT month_key, expense_total FROM finance_bank_month_statements WHERE month_key = ANY($1)', [pastMonths]);
    for (const r of bankRows.rows) bankTotals[r.month_key] = r.expense_total;
  }
  for (const mk of months) {
    if (overrides[mk] != null) { out[mk] = overrides[mk]; continue; }
    if (bankTotals[mk] != null) { out[mk] = bankTotals[mk]; continue; }
    const row = await pgOne('SELECT COALESCE(SUM(amount),0)::float AS total FROM finance_expenses WHERE month_key=$1', [mk]);
    out[mk] = row ? row.total : 0;
  }
  res.json(out);
}));
// HURTIG MÅNEDS-UDGIFT — se kommentar ved CREATE TABLE finance_expense_month_totals.
// Returnerer BÅDE override-beløbet (hvis sat) OG den udspecificerede sum, så frontenden
// kan vise "X kr (manuelt sat) — ville ellers have været Y kr fra Udgifter-fanen".
app.get('/api/finance/expense-month-totals', auth, financeOnly, asyncRoute(async (req, res) => {
  const months = String(req.query.months || '').split(',').filter(m => /^\d{4}-\d{2}$/.test(m));
  const out = {};
  if (!months.length) return res.json(out);
  const overrideRows = await pool.query('SELECT month_key, amount FROM finance_expense_month_totals WHERE month_key = ANY($1)', [months]);
  const overrides = {};
  for (const r of overrideRows.rows) overrides[r.month_key] = r.amount;
  for (const mk of months) {
    const row = await pgOne('SELECT COALESCE(SUM(amount),0)::float AS total FROM finance_expenses WHERE month_key=$1', [mk]);
    out[mk] = { override: overrides[mk] != null ? overrides[mk] : null, itemized: row ? row.total : 0 };
  }
  res.json(out);
}));
app.put('/api/finance/expense-month-totals/:month', auth, financeOnly, asyncRoute(async (req, res) => {
  const mk = req.params.month;
  if (!/^\d{4}-\d{2}$/.test(mk)) return res.status(400).json({ error: 'Ugyldig måned' });
  const amount = Number((req.body || {}).amount);
  if (!Number.isFinite(amount)) return res.status(400).json({ error: 'Ugyldigt beløb' });
  await pool.query(`
    INSERT INTO finance_expense_month_totals (month_key,amount,updated_at) VALUES ($1,$2,${nowTextSQL()})
    ON CONFLICT (month_key) DO UPDATE SET amount=$2,updated_at=${nowTextSQL()}
  `, [mk, amount]);
  res.json({ ok: true });
}));
app.delete('/api/finance/expense-month-totals/:month', auth, financeOnly, asyncRoute(async (req, res) => {
  const mk = req.params.month;
  await pool.query('DELETE FROM finance_expense_month_totals WHERE month_key=$1', [mk]);
  res.json({ ok: true });
}));
app.post('/api/finance/expenses', auth, financeOnly, asyncRoute(async (req, res) => {
  const body = req.body || {};
  if (!body.category_id || !body.name || !body.month_key) return res.status(400).json({ error: 'Kategori, navn og måned skal udfyldes' });
  const r = await pool.query('INSERT INTO finance_expenses (category_id,name,amount,paid,month_key) VALUES ($1,$2,$3,$4,$5) RETURNING id', [body.category_id, String(body.name).slice(0, 200), Number(body.amount) || 0, body.paid ? 1 : 0, body.month_key]);
  res.json({ ok: true, id: r.rows[0].id });
}));
app.put('/api/finance/expenses/:id', auth, financeOnly, asyncRoute(async (req, res) => {
  const body = req.body || {};
  await pool.query(`UPDATE finance_expenses SET name=$1,amount=$2,paid=$3,updated_at=${nowTextSQL()} WHERE id=$4`, [String(body.name || '').slice(0, 200), Number(body.amount) || 0, body.paid ? 1 : 0, req.params.id]);
  res.json({ ok: true });
}));
app.delete('/api/finance/expenses/:id', auth, financeOnly, asyncRoute(async (req, res) => {
  await pool.query('DELETE FROM finance_expenses WHERE id=$1', [req.params.id]);
  res.json({ ok: true });
}));

// ── Privat budget: fuldt frit redigerbart — kategorier kan oprettes/omdøbes/slettes,
// ikke kun poster inde i faste kategorier (modsat den almindelige Udgifter-fane).
app.get('/api/finance/private-budget', auth, financeOnly, asyncRoute(async (req, res) => {
  const cats = await pool.query('SELECT * FROM private_budget_categories ORDER BY sort_order ASC, id ASC');
  const items = await pool.query('SELECT * FROM private_budget_items ORDER BY id ASC');
  const byCategory = cats.rows.map(c => ({ ...c, items: items.rows.filter(i => i.category_id === c.id) }));
  res.json(byCategory);
}));
app.put('/api/finance/private-budget/reorder', auth, financeOnly, asyncRoute(async (req, res) => {
  const order = (req.body || {}).order || [];
  for (let i = 0; i < order.length; i++) {
    await pool.query('UPDATE private_budget_categories SET sort_order=$1 WHERE id=$2', [i, order[i]]);
  }
  res.json({ ok: true });
}));
app.post('/api/finance/private-budget/category', auth, financeOnly, asyncRoute(async (req, res) => {
  const body = req.body || {};
  if (!body.name) return res.status(400).json({ error: 'Navn skal udfyldes' });
  const maxOrder = await pgOne('SELECT COALESCE(MAX(sort_order),0)::int AS m FROM private_budget_categories');
  const r = await pool.query('INSERT INTO private_budget_categories (name, sort_order) VALUES ($1,$2) RETURNING id', [String(body.name).slice(0, 200), (maxOrder ? maxOrder.m : 0) + 1]);
  res.json({ ok: true, id: r.rows[0].id });
}));
app.put('/api/finance/private-budget/category/:id', auth, financeOnly, asyncRoute(async (req, res) => {
  const body = req.body || {};
  if (!body.name) return res.status(400).json({ error: 'Navn skal udfyldes' });
  await pool.query('UPDATE private_budget_categories SET name=$1 WHERE id=$2', [String(body.name).slice(0, 200), req.params.id]);
  res.json({ ok: true });
}));
app.delete('/api/finance/private-budget/category/:id', auth, financeOnly, asyncRoute(async (req, res) => {
  await pool.query('DELETE FROM private_budget_categories WHERE id=$1', [req.params.id]);
  res.json({ ok: true });
}));
app.post('/api/finance/private-budget/item', auth, financeOnly, asyncRoute(async (req, res) => {
  const body = req.body || {};
  if (!body.category_id || !body.name) return res.status(400).json({ error: 'Kategori og navn skal udfyldes' });
  const r = await pool.query('INSERT INTO private_budget_items (category_id,name,amount,note) VALUES ($1,$2,$3,$4) RETURNING id', [body.category_id, String(body.name).slice(0, 200), Number(body.amount) || 0, body.note ? String(body.note).slice(0, 500) : null]);
  res.json({ ok: true, id: r.rows[0].id });
}));
app.put('/api/finance/private-budget/item/:id', auth, financeOnly, asyncRoute(async (req, res) => {
  const body = req.body || {};
  await pool.query(`UPDATE private_budget_items SET name=$1,amount=$2,note=$3,updated_at=${nowTextSQL()} WHERE id=$4`, [String(body.name || '').slice(0, 200), Number(body.amount) || 0, body.note ? String(body.note).slice(0, 500) : null, req.params.id]);
  res.json({ ok: true });
}));
app.delete('/api/finance/private-budget/item/:id', auth, financeOnly, asyncRoute(async (req, res) => {
  await pool.query('DELETE FROM private_budget_items WHERE id=$1', [req.params.id]);
  res.json({ ok: true });
}));

// ── Bank-snapshots (erstatter manuel indtastning hver gang — gemmes rigtigt i databasen) ──
app.get('/api/finance/bank-snapshots', auth, financeOnly, asyncRoute(async (req, res) => {
  const rows = await pool.query('SELECT * FROM finance_bank_snapshots ORDER BY snap_date DESC LIMIT 24');
  res.json(rows.rows);
}));
app.post('/api/finance/bank-snapshots', auth, financeOnly, asyncRoute(async (req, res) => {
  const body = req.body || {};
  const today = new Date().toISOString().slice(0, 10);
  await pool.query(`
    INSERT INTO finance_bank_snapshots (snap_date,hovedkonto,moms,forbrug,tilgodehavende) VALUES ($1,$2,$3,$4,$5)
    ON CONFLICT (snap_date) DO UPDATE SET hovedkonto=$2,moms=$3,forbrug=$4,tilgodehavende=$5
  `, [today, Number(body.hovedkonto) || 0, Number(body.moms) || 0, Number(body.forbrug) || 0, Number(body.tilgodehavende) || 0]);
  res.json({ ok: true });
}));

// ── Send dagens rapport til egen mail — genbruger den eksisterende mail-opsætning ──
app.post('/api/finance/email-report', auth, financeOnly, asyncRoute(async (req, res) => {
  const to = req.user.email;
  if (!mailIsConfigured()) return res.status(400).json({ error: 'E-mail er ikke konfigureret på serveren' });
  const revenue = await fetchFinanceJobsByMonth();
  const expensesRows = await pool.query('SELECT fe.name,fe.amount,fe.paid,fc.name AS cat FROM finance_expenses fe JOIN finance_expense_categories fc ON fe.category_id=fc.id');
  const totalExpenses = expensesRows.rows.reduce((s, r) => s + Number(r.amount || 0), 0);
  const months = Object.keys(revenue).sort();
  const lines = ['Økonomi-rapport — Gulv Master', ''];
  for (const mk of months) {
    const m = revenue[mk];
    lines.push(`${mk}: omsætning ${Math.round(m.total).toLocaleString('da-DK')} kr (${m.jobs.length} sager, ${m.missingBudgetCount} uden budget)`);
  }
  lines.push('', `Faste udgifter i alt: ${Math.round(totalExpenses).toLocaleString('da-DK')} kr`);
  const text = lines.join('\n');
  try {
    await sendMailUniversal({ to, subject: 'Økonomi-rapport — Gulv Master', text, html: '<pre style="font-family:inherit">' + text.replace(/</g, '&lt;') + '</pre>' });
    res.json({ ok: true });
  } catch (error) {
    res.status(500).json({ error: 'Kunne ikke sende mailen: ' + error.message });
  }
}));

function sendPage(filename) {
  return (req, res) => {
    res.set('Cache-Control', 'no-store, no-cache, must-revalidate');
    res.sendFile(path.join(__dirname, filename));
  };
}
app.get('/migrate', sendPage('migrate.html'));
app.get('/set-password', sendPage('set-password.html'));
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
    setTimeout(() => syncFromJT().catch(error => { console.error('Startup sync failed:', error.message); logSystemEvent('jobtread_sync', 'error', 'Opstarts-synk fejlede: ' + error.message); }), 5000);
    cron.schedule('0 * * * *', () => syncFromJT().catch(error => { console.error('Scheduled sync failed:', error.message); logSystemEvent('jobtread_sync', 'error', 'Planlagt synk (hver time) fejlede: ' + error.message); }));
  } else if (migrationPending) {
    console.log('JobTread-sync er sat på pause, indtil den første SQLite-import er færdig.');
  }
  // OBS: kunde-påmindelsen ("vi kommer i morgen") sendes IKKE automatisk længere —
  // kun når admin selv trykker på knappen (se POST /api/customer-emails/send-reminders
  // nedenfor). Notifikationsscanneren kører stadig automatisk, det er intern info,
  // ikke noget der går ud til kunder.
  cron.schedule('15 * * * *', () => runNotificationScan().catch(e => { console.error('Notifikationsscan fejlede:', e.message); logSystemEvent('notification_scan', 'error', 'Notifikationsscan fejlede: ' + e.message); }));
  // Rykker-scan kl. 10 hver dag — runDunningScan tjekker selv om det er slået til.
  cron.schedule('0 10 * * *', () => runDunningScan(false).catch(e => { console.error('Rykker-scan fejlede:', e.message); logSystemEvent('dunning_scan', 'error', 'Rykker-scan fejlede: ' + e.message); }));
}

start().catch(error => {
  console.error('FATAL STARTUP ERROR:', error.message);
  process.exit(1);
});
