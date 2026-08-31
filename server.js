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
const webpush = require('web-push');
const PDFDocument = require('pdfkit');
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
// Render sidder bag en proxy — uden dette ville req.ip altid vise proxyens
// IP i stedet for kundens rigtige IP (bruges som bevis ved e-signatur).
app.set('trust proxy', true);
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
// 20mb: rummer base64 logo/avatar-billeder OG op til 8 note-vedhæftninger
// (billeder/PDF'er, maks ~15mb tekst i alt, se cleanNoteAttachments) sendt som
// data-URI'er fra admin-UI'et.
app.use(express.json({ limit: '20mb' }));
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

    -- PROFIT-ANALYSE — et fast snapshot pr. måned (typisk taget d. 15., se cron
    -- nedenfor), så tidligere måneders tal IKKE ændrer sig bagefter, selvom fx flere
    -- fakturaer eller udgifter registreres senere. Det giver Martin et ærligt
    -- måned-for-måned-sammenligningsgrundlag, i stedet for at historikken bevæger sig
    -- under fødderne på ham hver gang han kigger tilbage.
    CREATE TABLE IF NOT EXISTS profit_snapshots (
      id SERIAL PRIMARY KEY,
      month_key TEXT UNIQUE NOT NULL,
      snap_date TEXT NOT NULL,
      expenses DOUBLE PRECISION DEFAULT 0,
      bank_cash DOUBLE PRECISION,
      invoices_sent DOUBLE PRECISION DEFAULT 0,
      invoices_pending DOUBLE PRECISION DEFAULT 0,
      bottom_line DOUBLE PRECISION DEFAULT 0,
      created_at TEXT DEFAULT ${nowTextSQL()},
      updated_at TEXT DEFAULT ${nowTextSQL()}
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
    -- En sags-opgave (gantt_tasks med project_id) får en "spejl"-række herinde med
    -- SAMME id, så den automatisk optræder i Opgavepool/Kapacitet/Daglig plan
    -- ligesom en JobTread-opgave — se mirrorProjectTaskToPool() i server.js.
    -- project_id lader poolens kort vise "🔗 Åbn sagen" og linke tilbage.
    ALTER TABLE jt_tasks ADD COLUMN IF NOT EXISTS project_id INTEGER;
    ALTER TABLE planning_bookings ADD COLUMN IF NOT EXISTS capacity_days DOUBLE PRECISION;
    -- Capacity-only reservations deliberately live outside the daily plan.
    -- Existing bookings stay daily by default, so this upgrade has no effect on prior plans.
    ALTER TABLE planning_bookings ADD COLUMN IF NOT EXISTS planning_mode TEXT DEFAULT 'daily';
    ALTER TABLE planning_bookings ADD COLUMN IF NOT EXISTS capacity_label TEXT;
    ALTER TABLE planning_bookings ADD COLUMN IF NOT EXISTS documented_at TEXT;
    ALTER TABLE planning_bookings ADD COLUMN IF NOT EXISTS sort_order INTEGER DEFAULT 0;
    -- Link + billede på noten til medarbejderen (fx tegning, foto, video-link) — vist
    -- i "Note til medarbejder"-popup'en i Daglig plan og i medarbejderens eget system.
    ALTER TABLE planning_bookings ADD COLUMN IF NOT EXISTS note_link TEXT;
    -- Vedhæftninger (billeder + PDF'er) på noten, gemt som en JSON-liste af
    -- {name,type,data} — data er en base64 data-URI, ligesom logo/avatar-billeder,
    -- da der ikke er permanent fil-lager på Render.
    ALTER TABLE planning_bookings ADD COLUMN IF NOT EXISTS note_attachments TEXT;
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
    ALTER TABLE planning_bookings ADD COLUMN IF NOT EXISTS sms_reminder_sent_at TEXT;

    -- PUSH/SMS-NOTIFIKATIONER (medarbejder-push + kunde-SMS "din montør kommer").
    ALTER TABLE users ADD COLUMN IF NOT EXISTS phone TEXT;

    -- HOLDOVERBLIK & KORT I MEDARBEJDER-APPEN: kun medarbejdere Martin selv har
    -- krydset af (fx en mester) kan åbne kortet og se hvor kollegerne er booket,
    -- og hvad de er tilknyttet resten af ugen. Admin har altid adgang uanset dette flag.
    ALTER TABLE users ADD COLUMN IF NOT EXISTS can_view_team_overview INTEGER DEFAULT 0;

    CREATE TABLE IF NOT EXISTS push_subscriptions (
      id SERIAL PRIMARY KEY,
      user_id INTEGER NOT NULL,
      endpoint TEXT NOT NULL,
      p256dh TEXT NOT NULL,
      auth TEXT NOT NULL,
      created_at TEXT DEFAULT ${nowTextSQL()}
    );
    CREATE UNIQUE INDEX IF NOT EXISTS idx_push_subs_endpoint ON push_subscriptions(endpoint);
    CREATE INDEX IF NOT EXISTS idx_push_subs_user ON push_subscriptions(user_id);

    -- KUNDEPORTAL 2.0 — ét permanent link pr. kunde (identificeret ved job_name,
    -- samme konvention som Kundehistorik og kundesøgning bruger), i stedet for det
    -- gamle link der kun dækkede én enkelt booking. customer_key er den normaliserede
    -- (lowercase/trimmet) nøgle vi matcher på; job_name er visningsnavnet.
    CREATE TABLE IF NOT EXISTS customer_portal_tokens (
      id SERIAL PRIMARY KEY,
      customer_key TEXT NOT NULL,
      job_name TEXT NOT NULL,
      token TEXT NOT NULL,
      created_at TEXT DEFAULT ${nowTextSQL()}
    );
    CREATE UNIQUE INDEX IF NOT EXISTS idx_customer_portal_key ON customer_portal_tokens(customer_key);
    CREATE UNIQUE INDEX IF NOT EXISTS idx_customer_portal_token ON customer_portal_tokens(token);

    CREATE TABLE IF NOT EXISTS customer_schedule_sms (
      id SERIAL PRIMARY KEY,
      booking_id INTEGER,
      task_id TEXT,
      kind TEXT NOT NULL, -- 'reminder'
      to_phone TEXT,
      status TEXT,
      error TEXT,
      sent_at TEXT DEFAULT ${nowTextSQL()}
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
    ALTER TABLE planning_bookings ADD COLUMN IF NOT EXISTS status_flag TEXT;
    -- KUNDEPORTAL: unik, uigætteligt token pr. booking — giver adgang til en
    -- offentlig statusside (dato/tidspunkt/status) uden login. Oprettes først når
    -- nogen rent faktisk beder om linket (se getOrCreateBookingToken).
    ALTER TABLE planning_bookings ADD COLUMN IF NOT EXISTS public_token TEXT;
    CREATE UNIQUE INDEX IF NOT EXISTS idx_planning_bookings_public_token ON planning_bookings(public_token) WHERE public_token IS NOT NULL;
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

    -- ═══════════════════════════════════════════════════════════════════
    -- TILBUD & FAKTURA — eget produktkatalog (cost/salgspris/avance), egne
    -- tilbud/fakturaer med linjer, og delbetalinger pr. faktura. Bevidst
    -- adskilt fra JobTread's egne dokumenter (customerOrder/customerInvoice) —
    -- JobTread understøtter ikke delbetalinger, som er hele pointen her.
    -- Produktkataloget kan engangs-importeres fra JobTread's costItems, men
    -- lever og redigeres derefter 100% lokalt.
    -- ═══════════════════════════════════════════════════════════════════
    CREATE TABLE IF NOT EXISTS products (
      id SERIAL PRIMARY KEY,
      name TEXT NOT NULL,
      description TEXT,
      sku TEXT,
      unit TEXT DEFAULT 'stk',
      cost_price NUMERIC NOT NULL DEFAULT 0,
      sell_price NUMERIC NOT NULL DEFAULT 0,
      category TEXT,
      active INTEGER DEFAULT 1,
      jt_cost_item_id TEXT,
      created_at TEXT DEFAULT ${nowTextSQL()},
      updated_at TEXT DEFAULT ${nowTextSQL()}
    );
    CREATE INDEX IF NOT EXISTS idx_products_active ON products(active);
    CREATE INDEX IF NOT EXISTS idx_products_jt_cost_item ON products(jt_cost_item_id);
    ALTER TABLE products ADD COLUMN IF NOT EXISTS product_type TEXT DEFAULT 'service'; -- 'materialer' eller 'service'

    CREATE TABLE IF NOT EXISTS quote_templates (
      id SERIAL PRIMARY KEY,
      name TEXT NOT NULL,
      description TEXT,
      lines JSONB NOT NULL DEFAULT '[]',
      created_at TEXT DEFAULT ${nowTextSQL()},
      updated_at TEXT DEFAULT ${nowTextSQL()}
    );

    CREATE TABLE IF NOT EXISTS doc_counters (
      kind TEXT NOT NULL,
      year INTEGER NOT NULL,
      seq INTEGER NOT NULL DEFAULT 0,
      PRIMARY KEY (kind, year)
    );

    CREATE TABLE IF NOT EXISTS quotes (
      id SERIAL PRIMARY KEY,
      quote_number TEXT UNIQUE,
      job_name TEXT,
      job_id TEXT,
      customer_address TEXT,
      customer_phone TEXT,
      customer_email TEXT,
      status TEXT NOT NULL DEFAULT 'draft', -- draft, sent, accepted, declined, converted
      subtotal NUMERIC NOT NULL DEFAULT 0,
      tax_rate NUMERIC NOT NULL DEFAULT 25,
      tax_amount NUMERIC NOT NULL DEFAULT 0,
      total NUMERIC NOT NULL DEFAULT 0,
      notes TEXT,
      valid_until TEXT,
      created_by INTEGER,
      converted_invoice_id INTEGER,
      created_at TEXT DEFAULT ${nowTextSQL()},
      updated_at TEXT DEFAULT ${nowTextSQL()}
    );
    CREATE INDEX IF NOT EXISTS idx_quotes_status ON quotes(status);
    CREATE INDEX IF NOT EXISTS idx_quotes_job_name ON quotes(job_name);
    ALTER TABLE quotes ADD COLUMN IF NOT EXISTS discount_pct NUMERIC NOT NULL DEFAULT 0;
    -- 'pct' (procent, 0-100) eller 'fixed' (fast kronebeløb) — styrer hvordan
    -- discount_pct-værdien ovenfor skal fortolkes. Se komment ved computeTotals().
    ALTER TABLE quotes ADD COLUMN IF NOT EXISTS discount_type TEXT NOT NULL DEFAULT 'pct';
    -- Intern note — vises KUN i admin (team), aldrig på PDF/kunde-side/mails.
    -- Til forskel fra "notes" som er kunde-synlig.
    ALTER TABLE quotes ADD COLUMN IF NOT EXISTS internal_note TEXT;

    CREATE TABLE IF NOT EXISTS quote_lines (
      id SERIAL PRIMARY KEY,
      quote_id INTEGER NOT NULL REFERENCES quotes(id) ON DELETE CASCADE,
      product_id INTEGER,
      description TEXT NOT NULL,
      unit TEXT DEFAULT 'stk',
      quantity NUMERIC NOT NULL DEFAULT 1,
      cost_price NUMERIC NOT NULL DEFAULT 0,
      sell_price NUMERIC NOT NULL DEFAULT 0,
      position INTEGER NOT NULL DEFAULT 0
    );
    CREATE INDEX IF NOT EXISTS idx_quote_lines_quote ON quote_lines(quote_id);
    ALTER TABLE quote_lines ADD COLUMN IF NOT EXISTS product_type TEXT DEFAULT 'service';
    ALTER TABLE quote_lines ADD COLUMN IF NOT EXISTS discount_pct NUMERIC NOT NULL DEFAULT 0;
    ALTER TABLE quote_lines ADD COLUMN IF NOT EXISTS discount_type TEXT NOT NULL DEFAULT 'pct';

    CREATE TABLE IF NOT EXISTS invoices (
      id SERIAL PRIMARY KEY,
      invoice_number TEXT UNIQUE,
      quote_id INTEGER,
      job_name TEXT,
      job_id TEXT,
      customer_address TEXT,
      customer_phone TEXT,
      customer_email TEXT,
      status TEXT NOT NULL DEFAULT 'unpaid', -- unpaid, partial, paid, void
      subtotal NUMERIC NOT NULL DEFAULT 0,
      tax_rate NUMERIC NOT NULL DEFAULT 25,
      tax_amount NUMERIC NOT NULL DEFAULT 0,
      total NUMERIC NOT NULL DEFAULT 0,
      notes TEXT,
      due_date TEXT,
      created_at TEXT DEFAULT ${nowTextSQL()},
      updated_at TEXT DEFAULT ${nowTextSQL()}
    );
    CREATE INDEX IF NOT EXISTS idx_invoices_status ON invoices(status);
    CREATE INDEX IF NOT EXISTS idx_invoices_job_name ON invoices(job_name);
    ALTER TABLE invoices ADD COLUMN IF NOT EXISTS discount_pct NUMERIC NOT NULL DEFAULT 0;

    CREATE TABLE IF NOT EXISTS invoice_lines (
      id SERIAL PRIMARY KEY,
      invoice_id INTEGER NOT NULL REFERENCES invoices(id) ON DELETE CASCADE,
      product_id INTEGER,
      description TEXT NOT NULL,
      unit TEXT DEFAULT 'stk',
      quantity NUMERIC NOT NULL DEFAULT 1,
      cost_price NUMERIC NOT NULL DEFAULT 0,
      sell_price NUMERIC NOT NULL DEFAULT 0,
      position INTEGER NOT NULL DEFAULT 0
    );
    CREATE INDEX IF NOT EXISTS idx_invoice_lines_invoice ON invoice_lines(invoice_id);
    ALTER TABLE invoice_lines ADD COLUMN IF NOT EXISTS product_type TEXT DEFAULT 'service';
    ALTER TABLE invoice_lines ADD COLUMN IF NOT EXISTS discount_pct NUMERIC NOT NULL DEFAULT 0;

    CREATE TABLE IF NOT EXISTS invoice_payments (
      id SERIAL PRIMARY KEY,
      invoice_id INTEGER NOT NULL REFERENCES invoices(id) ON DELETE CASCADE,
      amount NUMERIC NOT NULL,
      paid_at TEXT NOT NULL,
      method TEXT,
      note TEXT,
      created_at TEXT DEFAULT ${nowTextSQL()}
    );
    CREATE INDEX IF NOT EXISTS idx_invoice_payments_invoice ON invoice_payments(invoice_id);

    -- KREDITNOTAER — selvstændigt nummereret dokument (KN-ÅÅÅÅ-NNNN) knyttet til
    -- én faktura, med et valgfrit (helt eller delvist) beløb. Trækkes fra
    -- fakturaens "rest" ligesom betalinger, men vises adskilt.
    CREATE TABLE IF NOT EXISTS credit_notes (
      id SERIAL PRIMARY KEY,
      credit_note_number TEXT UNIQUE,
      invoice_id INTEGER NOT NULL REFERENCES invoices(id) ON DELETE CASCADE,
      amount NUMERIC NOT NULL,
      reason TEXT,
      created_by INTEGER,
      created_at TEXT DEFAULT ${nowTextSQL()}
    );
    CREATE INDEX IF NOT EXISTS idx_credit_notes_invoice ON credit_notes(invoice_id);

    -- AKTIVITETS-TIDSLINJE — hvem redigerede/sendte tilbud og fakturaer, og
    -- hvornår kunden selv åbnede dem. Fælles tabel for begge dokumenttyper
    -- (doc_type 'quote'|'invoice') så vi kun skal bygge/vedligeholde ét system.
    CREATE TABLE IF NOT EXISTS document_activity (
      id SERIAL PRIMARY KEY,
      doc_type TEXT NOT NULL,
      doc_id INTEGER NOT NULL,
      event_type TEXT NOT NULL,
      actor TEXT,
      detail TEXT,
      created_at TEXT DEFAULT ${nowTextSQL()}
    );
    CREATE INDEX IF NOT EXISTS idx_document_activity_doc ON document_activity(doc_type, doc_id);

    -- ── CRM: eget kundekartotek (parallelt med JobTread-sagssøgningen, som
    -- Tilbud/Faktura-editoren stadig kan bruge) — så Martin kan oprette kunder
    -- direkte og booke/tilbyde dem uden en JobTread-sag i forvejen. ──────
    CREATE TABLE IF NOT EXISTS customers (
      id SERIAL PRIMARY KEY,
      name TEXT NOT NULL,
      email TEXT,
      phone TEXT,
      address TEXT,
      notes TEXT,
      created_at TEXT DEFAULT ${nowTextSQL()},
      updated_at TEXT DEFAULT ${nowTextSQL()}
    );
    CREATE INDEX IF NOT EXISTS idx_customers_name ON customers(name);
    -- Firmakunder: "Navn" bruges som firmanavn når is_company er sat, plus et
    -- CVR-nummer. Frivilligt for private kunder (is_company=0, cvr=NULL).
    ALTER TABLE customers ADD COLUMN IF NOT EXISTS is_company INTEGER DEFAULT 0;
    ALTER TABLE customers ADD COLUMN IF NOT EXISTS cvr TEXT;

    -- ── E-SIGNATUR på tilbud: fast link pr. tilbud kunden kan acceptere og
    -- underskrive (tegnet signatur + navn + IP/tidspunkt som bevis). ────
    ALTER TABLE quotes ADD COLUMN IF NOT EXISTS customer_id INTEGER;
    ALTER TABLE quotes ADD COLUMN IF NOT EXISTS accept_token TEXT;
    ALTER TABLE quotes ADD COLUMN IF NOT EXISTS signed_name TEXT;
    ALTER TABLE quotes ADD COLUMN IF NOT EXISTS signed_at TEXT;
    ALTER TABLE quotes ADD COLUMN IF NOT EXISTS signed_ip TEXT;
    ALTER TABLE quotes ADD COLUMN IF NOT EXISTS signature_data TEXT;
    CREATE UNIQUE INDEX IF NOT EXISTS idx_quotes_accept_token ON quotes(accept_token) WHERE accept_token IS NOT NULL;

    -- MAIL-SKABELONER TIL TILBUD/FAKTURA (HTML) — adskilt fra email_templates
    -- ovenfor (som er til booking-/planlægningsmails med andre variabler).
    -- body_html er RÅ HTML som skrives direkte i mailen, ikke tekst der
    -- auto-konverteres til <p>-tags.
    CREATE TABLE IF NOT EXISTS document_email_templates (
      id SERIAL PRIMARY KEY, name TEXT NOT NULL, subject TEXT NOT NULL, body_html TEXT NOT NULL,
      created_at TEXT DEFAULT ${nowTextSQL()}, updated_at TEXT DEFAULT ${nowTextSQL()}
    );

    -- ── PRISFORESPØRGSLER til leverandører (kun materiale-linjer, uden priser)
    -- og BLANKE TILBUD til underleverandører (alle linjer, uden priser) — samme
    -- mekanik, forskellig linje-udvælgelse og modtager-antal. ──────────────
    CREATE TABLE IF NOT EXISTS quote_requests (
      id SERIAL PRIMARY KEY,
      quote_id INTEGER NOT NULL REFERENCES quotes(id) ON DELETE CASCADE,
      kind TEXT NOT NULL, -- 'supplier' eller 'subcontractor'
      note TEXT,
      created_at TEXT DEFAULT ${nowTextSQL()}
    );
    CREATE INDEX IF NOT EXISTS idx_quote_requests_quote ON quote_requests(quote_id);
    CREATE TABLE IF NOT EXISTS quote_request_lines (
      id SERIAL PRIMARY KEY,
      request_id INTEGER NOT NULL REFERENCES quote_requests(id) ON DELETE CASCADE,
      description TEXT NOT NULL,
      unit TEXT,
      quantity NUMERIC,
      position INTEGER NOT NULL DEFAULT 0
    );
    CREATE TABLE IF NOT EXISTS quote_request_recipients (
      id SERIAL PRIMARY KEY,
      request_id INTEGER NOT NULL REFERENCES quote_requests(id) ON DELETE CASCADE,
      name TEXT,
      email TEXT NOT NULL,
      token TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'sent', -- sent, responded
      responses JSONB,
      responded_at TEXT,
      created_at TEXT DEFAULT ${nowTextSQL()}
    );
    CREATE UNIQUE INDEX IF NOT EXISTS idx_quote_request_recipients_token ON quote_request_recipients(token);

    -- ── PROJEKTER: oprettes (typisk) fra et accepteret tilbud. Samler
    -- sags-Gantt (gantt_tasks scopet via project_id), tidsregistrering,
    -- kvalitetssikring og billeder ét sted. ─────────────────────────
    CREATE TABLE IF NOT EXISTS projects (
      id SERIAL PRIMARY KEY,
      quote_id INTEGER,
      invoice_id INTEGER,
      name TEXT NOT NULL,
      customer_id INTEGER,
      customer_address TEXT,
      customer_phone TEXT,
      customer_email TEXT,
      status TEXT NOT NULL DEFAULT 'active', -- active, done, archived
      created_at TEXT DEFAULT ${nowTextSQL()},
      updated_at TEXT DEFAULT ${nowTextSQL()}
    );
    CREATE INDEX IF NOT EXISTS idx_projects_status ON projects(status);
    ALTER TABLE gantt_tasks ADD COLUMN IF NOT EXISTS project_id INTEGER;
    ALTER TABLE gantt_tasks ADD COLUMN IF NOT EXISTS source_quote_line_id INTEGER;
    CREATE INDEX IF NOT EXISTS idx_gantt_tasks_project ON gantt_tasks(project_id);

    -- ── KVALITETSSIKRING: Martin bygger skabeloner (ordnet liste af felter),
    -- medarbejdere udfylder dem pr. projekt. ────────────────────────────
    CREATE TABLE IF NOT EXISTS qa_templates (
      id SERIAL PRIMARY KEY,
      name TEXT NOT NULL,
      fields JSONB NOT NULL DEFAULT '[]', -- [{label,type:'check'|'text'|'number'|'photo'}]
      created_at TEXT DEFAULT ${nowTextSQL()},
      updated_at TEXT DEFAULT ${nowTextSQL()}
    );
    CREATE TABLE IF NOT EXISTS qa_submissions (
      id SERIAL PRIMARY KEY,
      project_id INTEGER NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
      template_id INTEGER,
      template_name TEXT,
      answers JSONB NOT NULL DEFAULT '[]', -- [{label,type,value}]
      submitted_by INTEGER,
      submitted_at TEXT DEFAULT ${nowTextSQL()}
    );
    CREATE INDEX IF NOT EXISTS idx_qa_submissions_project ON qa_submissions(project_id);

    -- ── TIDSREGISTRERING: note + billede er obligatorisk, indkøbte
    -- materialer og tilbudspost er valgfrit, men gør det hurtigt at se
    -- hvad der reelt skal faktureres. ────────────────────────────────
    CREATE TABLE IF NOT EXISTS time_entries (
      id SERIAL PRIMARY KEY,
      project_id INTEGER NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
      user_id INTEGER NOT NULL,
      minutes INTEGER NOT NULL DEFAULT 0,
      note TEXT NOT NULL,
      photo_url TEXT,
      bought_materials TEXT,
      quote_line_id INTEGER,
      entry_date TEXT NOT NULL,
      created_at TEXT DEFAULT ${nowTextSQL()}
    );
    CREATE INDEX IF NOT EXISTS idx_time_entries_project ON time_entries(project_id);

    -- ── MATERIALER: strukturerede indkøb (kvitteringsbillede + pris + butik)
    -- knyttet til en sag — erstatter det gamle "Upload Bill"-link ud til
    -- JobTread på sags-opgaver, som der intet rigtigt JobTread-job er for.
    CREATE TABLE IF NOT EXISTS project_materials (
      id SERIAL PRIMARY KEY,
      project_id INTEGER NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
      user_id INTEGER NOT NULL,
      price NUMERIC NOT NULL DEFAULT 0,
      store TEXT,
      note TEXT,
      receipt_photo_url TEXT NOT NULL,
      created_at TEXT DEFAULT ${nowTextSQL()}
    );
    CREATE INDEX IF NOT EXISTS idx_project_materials_project ON project_materials(project_id);
    CREATE TABLE IF NOT EXISTS project_photos (
      id SERIAL PRIMARY KEY,
      project_id INTEGER NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
      url TEXT NOT NULL,
      uploaded_by INTEGER,
      caption TEXT,
      created_at TEXT DEFAULT ${nowTextSQL()}
    );
    CREATE INDEX IF NOT EXISTS idx_project_photos_project ON project_photos(project_id);

    -- ── KONTAKTFORMULAR: samme mønster som KS-skabeloner ovenfor —
    -- Martin bygger felterne, medarbejdere udfylder pr. projekt (fx
    -- kundens kontaktoplysninger indhentet på stedet). ─────────────────
    CREATE TABLE IF NOT EXISTS contact_form_templates (
      id SERIAL PRIMARY KEY,
      name TEXT NOT NULL,
      fields JSONB NOT NULL DEFAULT '[]',
      created_at TEXT DEFAULT ${nowTextSQL()},
      updated_at TEXT DEFAULT ${nowTextSQL()}
    );
    CREATE TABLE IF NOT EXISTS contact_form_submissions (
      id SERIAL PRIMARY KEY,
      project_id INTEGER NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
      template_id INTEGER,
      template_name TEXT,
      answers JSONB NOT NULL DEFAULT '[]',
      submitted_by INTEGER,
      submitted_at TEXT DEFAULT ${nowTextSQL()}
    );
    CREATE INDEX IF NOT EXISTS idx_contact_form_submissions_project ON contact_form_submissions(project_id);
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
  res.json({ token, user: { id: user.id, name: user.name, role: user.role, email: user.email, color: user.color, initials: user.initials, avatar_url: user.avatar_url, is_finance_admin: !!user.is_finance_admin, can_view_team_overview: !!user.can_view_team_overview } });
}));

app.get('/api/auth/me', auth, asyncRoute(async (req, res) => {
  const user = await pgOne('SELECT id,name,email,role,color,initials,avatar_url,is_finance_admin,can_view_team_overview FROM users WHERE id=$1', [req.user.id]);
  if (!user) return res.status(401).json({ error: 'Bruger ikke fundet' });
  res.json({ ...user, is_finance_admin: !!user.is_finance_admin, can_view_team_overview: !!user.can_view_team_overview });
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
    logo_url: map.logo_url || null,
    company_address: map.company_address || '',
    company_cvr: map.company_cvr || '',
    company_phone: map.company_phone || '',
    company_email: map.company_email || '',
    company_bank_reg: map.company_bank_reg || '',
    company_bank_account: map.company_bank_account || '',
    invoice_footer_note: map.invoice_footer_note || '',
    default_tax_rate: map.default_tax_rate || '25'
  });
}));

app.put('/api/settings', auth, adminOnly, asyncRoute(async (req, res) => {
  const body = req.body || {};
  const entries = [];
  if (body.company_name !== undefined) entries.push(['company_name', String(body.company_name).trim().slice(0, 200)]);
  if (body.logo_url !== undefined) entries.push(['logo_url', body.logo_url ? String(body.logo_url).slice(0, 3000000) : null]);
  if (body.company_address !== undefined) entries.push(['company_address', String(body.company_address).slice(0, 500)]);
  if (body.company_cvr !== undefined) entries.push(['company_cvr', String(body.company_cvr).slice(0, 50)]);
  if (body.company_phone !== undefined) entries.push(['company_phone', String(body.company_phone).slice(0, 50)]);
  if (body.company_email !== undefined) entries.push(['company_email', String(body.company_email).slice(0, 200)]);
  if (body.company_bank_reg !== undefined) entries.push(['company_bank_reg', String(body.company_bank_reg).slice(0, 20)]);
  if (body.company_bank_account !== undefined) entries.push(['company_bank_account', String(body.company_bank_account).slice(0, 30)]);
  if (body.invoice_footer_note !== undefined) entries.push(['invoice_footer_note', String(body.invoice_footer_note).slice(0, 1000)]);
  if (body.default_tax_rate !== undefined) entries.push(['default_tax_rate', String(Number(body.default_tax_rate) || 25)]);
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

// SMS & PUSH — status-panel i indstillinger, så det er tydeligt hvad der virker
// uden konfiguration (push, gratis) og hvad der kræver en SMS-udbyder (betalt).
app.get('/api/settings/notification-channels', auth, adminOnly, asyncRoute(async (req, res) => {
  res.json({
    push_configured: true, // web push kræver ingen ekstern konto — virker altid
    sms_configured: smsIsConfigured(),
    sms_provider: process.env.GATEWAYAPI_API_TOKEN ? 'GatewayAPI' : (process.env.TWILIO_ACCOUNT_SID ? 'Twilio' : null)
  });
}));
app.post('/api/settings/test-sms', auth, adminOnly, asyncRoute(async (req, res) => {
  const to = String((req.body || {}).to || '').trim();
  if (!to) return res.status(400).json({ error: 'Skriv et telefonnummer at teste med' });
  if (!smsIsConfigured()) return res.status(400).json({ error: 'SMS er ikke sat op endnu (mangler GATEWAYAPI_API_TOKEN eller TWILIO_* i Render Environment)' });
  try {
    await sendSmsUniversal({ to, message: 'Gulv Master: Dette er en test-SMS fra jeres planlægningssystem.' });
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
    SELECT id,name,email,role,color,initials,jobtread_name,active,worker_type,vendor_group,trade,weekly_capacity,avatar_url,COALESCE(can_login,1) AS can_login,personal_email,phone,COALESCE(notify_schedule_changes,0) AS notify_schedule_changes,COALESCE(is_finance_admin,0) AS is_finance_admin,COALESCE(can_view_team_overview,0) AS can_view_team_overview
    FROM users
    ORDER BY CASE WHEN role='admin' THEN 0 ELSE 1 END,
             CASE WHEN worker_type='vendor' THEN 1 ELSE 0 END,
             vendor_group NULLS FIRST,
             name
  `);
  res.json(result.rows);
}));

const PUBLIC_APP_URL = process.env.RENDER_EXTERNAL_URL || process.env.PUBLIC_URL || 'https://gulvmaster.onrender.com';

// ══════════════════════════════════════════════════════════════
// WEB PUSH — push-notifikationer til medarbejdere (fx "din plan er ændret")
// direkte i browseren/telefonen, uden nogen ekstern konto eller omkostning.
// VAPID-nøglerne herunder identificerer BARE denne server som afsender — de er
// ikke hemmelige på samme måde som et API-nøgle-login, men kan override's via
// miljøvariabler hvis Martin nogensinde vil rotere dem. Genereret én gang med
// `npx web-push generate-vapid-keys`.
// ══════════════════════════════════════════════════════════════
const VAPID_PUBLIC_KEY = process.env.VAPID_PUBLIC_KEY || 'BBJi09LVC9PlnJte2pPDqvp599AnTmDROKayvISt1tgEU-J2n6rt3VotnnZ2SdG1AIujyudIpSU2r3huVy39aHE';
const VAPID_PRIVATE_KEY = process.env.VAPID_PRIVATE_KEY || 'Z8TUYwi6XOfHLqxKSoSDlEZN8gEnZLlOQBoM1HlAH2o';
webpush.setVapidDetails('mailto:info@gulvmaster.dk', VAPID_PUBLIC_KEY, VAPID_PRIVATE_KEY);

// Sender en push-besked til ALLE enheder én medarbejder har tilmeldt (kan sagtens
// være flere — telefon + pc). Rydder selv op i døde abonnementer (410/404 = bruger
// har afinstalleret/blokeret notifikationer på den enhed).
async function sendPushToUser(userId, title, body, url) {
  if (!userId) return;
  let subs;
  try { subs = await pool.query('SELECT * FROM push_subscriptions WHERE user_id=$1', [userId]); }
  catch (e) { console.error('Kunne ikke hente push-abonnementer:', e.message); return; }
  const payload = JSON.stringify({ title, body: body || '', url: url || '/employee' });
  for (const s of subs.rows) {
    try {
      await webpush.sendNotification({ endpoint: s.endpoint, keys: { p256dh: s.p256dh, auth: s.auth } }, payload);
    } catch (e) {
      if (e.statusCode === 404 || e.statusCode === 410) {
        await pool.query('DELETE FROM push_subscriptions WHERE id=$1', [s.id]).catch(() => {});
      } else {
        console.error('Push-afsendelse fejlede:', e.message);
      }
    }
  }
}

app.get('/api/push/public-key', auth, (req, res) => res.json({ publicKey: VAPID_PUBLIC_KEY }));

app.post('/api/push/subscribe', auth, asyncRoute(async (req, res) => {
  const sub = req.body || {};
  if (!sub.endpoint || !sub.keys || !sub.keys.p256dh || !sub.keys.auth) {
    return res.status(400).json({ error: 'Ugyldigt push-abonnement' });
  }
  await pool.query(`
    INSERT INTO push_subscriptions (user_id,endpoint,p256dh,auth) VALUES ($1,$2,$3,$4)
    ON CONFLICT (endpoint) DO UPDATE SET user_id=EXCLUDED.user_id, p256dh=EXCLUDED.p256dh, auth=EXCLUDED.auth
  `, [req.user.id, sub.endpoint, sub.keys.p256dh, sub.keys.auth]);
  res.json({ ok: true });
}));

app.post('/api/push/unsubscribe', auth, asyncRoute(async (req, res) => {
  const endpoint = (req.body || {}).endpoint;
  if (endpoint) await pool.query('DELETE FROM push_subscriptions WHERE endpoint=$1 AND user_id=$2', [endpoint, req.user.id]);
  res.json({ ok: true });
}));

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
      INSERT INTO users (name,email,password_hash,role,color,initials,jobtread_name,active,worker_type,vendor_group,trade,weekly_capacity,can_login,avatar_url,personal_email,notify_schedule_changes,phone,can_view_team_overview)
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18)
      RETURNING id
    `, [String(body.name).trim(), email, bcrypt.hashSync(password, 10), role, body.color || '#2563EB', initials, body.jobtread_name || null, body.active === 0 ? 0 : 1, workerType, body.vendor_group || null, body.trade || null, weeklyCapacity, canLogin ? 1 : 0, body.avatar_url || null, body.personal_email || null, body.notify_schedule_changes ? 1 : 0, body.phone ? String(body.phone).trim().slice(0, 30) : null, body.can_view_team_overview ? 1 : 0]);
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
    notify_schedule_changes: body.notify_schedule_changes !== undefined ? (body.notify_schedule_changes ? 1 : 0) : current.notify_schedule_changes,
    phone: body.phone !== undefined ? (body.phone ? String(body.phone).trim().slice(0, 30) : null) : current.phone,
    can_view_team_overview: body.can_view_team_overview !== undefined ? (body.can_view_team_overview ? 1 : 0) : Number(current.can_view_team_overview || 0)
  };
  if (canLogin && !next.email) return res.status(400).json({ error: 'Email mangler for login-bruger' });
  try {
    await pool.query(`
      UPDATE users SET name=$1,email=$2,password_hash=$3,role=$4,color=$5,initials=$6,jobtread_name=$7,active=$8,worker_type=$9,vendor_group=$10,trade=$11,weekly_capacity=$12,can_login=$13,avatar_url=$14,personal_email=$15,notify_schedule_changes=$16,phone=$17,can_view_team_overview=$18
      WHERE id=$19
    `, [next.name, next.email, next.password_hash, next.role, next.color, next.initials, next.jobtread_name, next.active, next.worker_type, next.vendor_group, next.trade, next.weekly_capacity, next.can_login, next.avatar_url, next.personal_email, next.notify_schedule_changes, next.phone, next.can_view_team_overview, id]);
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

// ══════════════════════════════════════════════════════════════
// SMS — samme "graceful degradation"-mønster som mail ovenfor: virker slet
// ikke før nogen sætter miljøvariabler på serveren, men fejler aldrig hårdt.
// To udbydere understøttet (den første fundne miljøvariabel vinder):
//   A) GatewayAPI (dansk, billig, simpel REST-API) — GATEWAYAPI_API_TOKEN, valgfri GATEWAYAPI_SENDER
//   B) Twilio (international) — TWILIO_ACCOUNT_SID, TWILIO_AUTH_TOKEN, TWILIO_FROM_NUMBER
// Ingen SDK'er tilføjet — begge kaldes direkte via fetch, ligesom Resend ovenfor.
// ══════════════════════════════════════════════════════════════
function smsIsConfigured() {
  return !!process.env.GATEWAYAPI_API_TOKEN || !!(process.env.TWILIO_ACCOUNT_SID && process.env.TWILIO_AUTH_TOKEN && process.env.TWILIO_FROM_NUMBER);
}
// Normaliserer til E.164. Antager dansk nummer (8 cifre, intet landekode) hvis
// intet andet er angivet — dækker langt de fleste kunder/medarbejdere her.
function normalizePhone(raw) {
  let p = String(raw || '').trim().replace(/[\s.\-()]/g, '');
  if (!p) return null;
  if (p.startsWith('00')) p = '+' + p.slice(2);
  if (!p.startsWith('+')) p = (p.replace(/\D/g, '').length === 8) ? '+45' + p.replace(/\D/g, '') : '+' + p.replace(/\D/g, '');
  return /^\+\d{8,15}$/.test(p) ? p : null;
}
async function sendSmsUniversal({ to, message }) {
  const phone = normalizePhone(to);
  if (!phone) throw new Error('Ugyldigt eller manglende telefonnummer');
  if (process.env.GATEWAYAPI_API_TOKEN) {
    const response = await fetch('https://gatewayapi.com/rest/mtsms', {
      method: 'POST',
      headers: {
        'Authorization': 'Basic ' + Buffer.from(process.env.GATEWAYAPI_API_TOKEN + ':').toString('base64'),
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        sender: (process.env.GATEWAYAPI_SENDER || 'GulvMaster').slice(0, 11),
        message,
        recipients: [{ msisdn: Number(phone.replace('+', '')) }]
      })
    });
    if (!response.ok) {
      const raw = await response.text().catch(() => '');
      throw new Error(`GatewayAPI HTTP ${response.status}: ${raw.slice(0, 300)}`);
    }
    return;
  }
  if (process.env.TWILIO_ACCOUNT_SID && process.env.TWILIO_AUTH_TOKEN) {
    const sid = process.env.TWILIO_ACCOUNT_SID;
    const auth = Buffer.from(sid + ':' + process.env.TWILIO_AUTH_TOKEN).toString('base64');
    const params = new URLSearchParams({ To: phone, From: process.env.TWILIO_FROM_NUMBER, Body: message });
    const response = await fetch(`https://api.twilio.com/2010-04-01/Accounts/${sid}/Messages.json`, {
      method: 'POST',
      headers: { 'Authorization': 'Basic ' + auth, 'Content-Type': 'application/x-www-form-urlencoded' },
      body: params
    });
    if (!response.ok) {
      const raw = await response.text().catch(() => '');
      throw new Error(`Twilio HTTP ${response.status}: ${raw.slice(0, 300)}`);
    }
    return;
  }
  throw new Error('Hverken GATEWAYAPI_API_TOKEN eller TWILIO_* er sat op på serveren');
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
async function syncJobGeocodesInBackground(limit) {
  if (geocodeSyncRunning) return { ok: false, skipped: true, error: 'Geokodning kører allerede' };
  geocodeSyncRunning = true;
  let geocoded = 0;
  try {
    // FEJL RETTET: filtrerede tidligere på "job_id IS NOT NULL", dvs. kun
    // JobTread-synkede jobs blev nogensinde geokodet — manuelle opgaver og
    // kundebesøg (job_id IS NULL) manglede derfor helt på "alle projekter"-
    // kortet i Ruter & kort. Grupperer nu i stedet efter selve adressen, så
    // ÉN geokodning dækker alle rækker (JobTread-job ELLER manuel) der deler
    // den samme adresse — det sparer også kald til Nominatim.
    const needsGeocode = await pool.query(`
      SELECT DISTINCT job_address
      FROM jt_tasks
      WHERE job_address IS NOT NULL
        AND trim(job_address)<>''
        AND (job_lat IS NULL OR job_lng IS NULL)
    `);
    const batch = needsGeocode.rows.slice(0, limit || 60);

    for (const row of batch) {
      try {
        const geoRes = await fetch('https://nominatim.openstreetmap.org/search?format=json&limit=1&countrycodes=dk&q=' + encodeURIComponent(row.job_address), {
          headers: { 'User-Agent': 'GulvMasterEnterprise/1.0 (internal scheduling tool)' }
        });
        const geoData = await geoRes.json();
        if (Array.isArray(geoData) && geoData[0]) {
          await pool.query(`UPDATE jt_tasks SET job_lat=$1, job_lng=$2 WHERE job_address=$3 AND (job_lat IS NULL OR job_lng IS NULL)`, [+geoData[0].lat, +geoData[0].lon, row.job_address]);
          geocoded++;
        }
      } catch (_) {
        // One bad address must never stop the contact sync.
      }
      // Nominatims brugsvilkår tillader maks. 1 opslag i sekundet — denne pause
      // gælder uanset om kaldet kommer fra telefon-synk eller "Hent flere
      // adresser"-knappen på rutekortet, så vi aldrig kan overskride den.
      await new Promise(resolve => setTimeout(resolve, 1100));
    }
    if (geocoded) await writeSyncLog(0, 'ok', `Geokodning: ${geocoded} adresse(r) opdateret.`);
    return { ok: true, geocoded, remaining: Math.max(0, needsGeocode.rows.length - batch.length) };
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
    notifyEmployee(booking.user_id, 'Ny opgave i din plan', `Du er sat på en opgave ${dayLabelForNotif(booking.start_date)} (${String(booking.start_date).slice(0,10)}).`, '#plan').catch(() => {});
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
  const rawStartDate = validDate(String(body.week_start || current.start_date || '')) ? String(body.week_start || current.start_date) : null;
  if (!rawStartDate) return res.status(400).json({ error: 'Vælg en gyldig startdato' });
  // Kapacitet planlægges pr. uge, aldrig en bestemt ugedag — snap altid til ugens
  // mandag her, uanset hvad klienten sender, ligesom oprettelsen (splitCapacityAcrossWeeks) gør.
  const startDate = mondayOfDate(rawStartDate) || rawStartDate;
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
  // opgave, spredes det automatisk til alle andre opgaver under samme sag, så man
  // ikke skal indtaste det samme flere gange for hver enkelt opgave/booking.
  // FEJL RETTET: spredte tidligere KUN til andre opgaver med samme job_id — men
  // manuelt oprettede opgaver (almindelig "opret opgave manuelt", "Book kundebesøg",
  // skabelon-træk) har ALTID job_id=NULL, så for dem virkede spredningen aldrig,
  // selvom det er størstedelen af Martins daglige opgaver. Har opgaven intet job_id,
  // spreder vi nu i stedet til andre job_id-løse opgaver med samme kundenavn
  // (job_name) — den bedste tilgængelige "samme sag"-nøgle uden et rigtigt job_id.
  {
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
      if (current.job_id) {
        const values = propagateValues.slice();
        values.push(current.job_id, current.id);
        await pool.query(`UPDATE jt_tasks SET ${propagateSets.join(', ')} WHERE job_id=$${values.length - 1} AND id<>$${values.length}`, values);
      } else if (current.job_name && current.job_name.trim()) {
        const values = propagateValues.slice();
        values.push(current.job_name.trim(), current.id);
        await pool.query(`UPDATE jt_tasks SET ${propagateSets.join(', ')} WHERE job_id IS NULL AND lower(trim(job_name))=lower($${values.length - 1}) AND id<>$${values.length}`, values);
      }
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
// FEJL RETTET (dobbelt registrering): denne route bookede tidligere opgaven på en
// medarbejder/dato med det samme (planning_bookings-række), OG opgaven blev samtidig
// vist i Opgavepoolen som alt andet — trak man den ud derfra på en medarbejder/dag
// bagefter (helt normal brug af poolen), oprettede det en ANDEN booking af samme
// opgave oveni. Nu opretter "Book kundebesøg" kun selve jt_tasks-opgaven (ligesom en
// almindelig manuel opgave) — den rigtige booking sker først (og kun én gang) når
// opgaven trækkes ud på den medarbejder/dag den faktisk skal ligge hos.
app.post('/api/customer-visits/book', auth, adminOnly, asyncRoute(async (req, res) => {
  const body = req.body || {};
  const customerName = String(body.customer_name || '').trim();
  if (!customerName) return res.status(400).json({ error: 'Skriv kundens navn' });
  if (!validDate(String(body.date || ''))) return res.status(400).json({ error: 'Vælg en gyldig dato' });

  const taskId = `visit-${crypto.randomUUID ? crypto.randomUUID() : `${Date.now()}-${Math.random().toString(16).slice(2)}`}`;
  const address = body.address ? String(body.address).trim().slice(0, 300) : '';
  const phone = body.phone ? String(body.phone).trim().slice(0, 60) : '';
  const notes = body.notes ? String(body.notes).trim().slice(0, 500) : '';

  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query(`
      INSERT INTO jt_tasks (id,name,job_id,job_name,job_address,customer_phone,start_date,end_date,type_guess,raw_assignee_name,jt_url,synced_at,source,is_visit,created_at)
      VALUES ($1,'Kundebesøg',NULL,$2,$3,$4,$5,$5,'other',NULL,NULL,${nowTextSQL()},'manual',1,${nowTextSQL()})
    `, [taskId, customerName, address, phone || null, body.date]);
    await client.query(`
      INSERT INTO customer_visits (task_id,customer_name,address,phone,notes,created_at,updated_at)
      VALUES ($1,$2,$3,$4,$5,${nowTextSQL()},${nowTextSQL()})
    `, [taskId, customerName, address, phone, notes || null]);
    await client.query('COMMIT');
    res.json({ ok: true, task_id: taskId });
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

// Renser et link fra "Note til medarbejder"-feltet: tilføjer https:// hvis
// admin har glemt protokollen, og afviser stille og roligt værdier der
// tydeligvis ikke er et link (fx bare tekst) i stedet for at fejle hele gemningen.
function cleanNoteLink(value) {
  if (value === undefined) return undefined;
  if (!value) return null;
  let s = String(value).trim();
  if (!s) return null;
  if (!/^https?:\/\//i.test(s)) s = 'https://' + s;
  if (!/^https?:\/\/[^\s]+\.[^\s]+/i.test(s)) return null;
  return s.slice(0, 1000);
}

// Renser vedhæftninger (billeder/PDF'er) på "Note til medarbejder". Accepterer enten
// et array (friskt fra klienten ved gem) eller en allerede-gemt JSON-streng (når
// PUT-endpointet merger den eksisterende booking ind, se normalizeBooking nedenfor)
// — begge dele normaliseres til den samme, rensede JSON-streng. Grænserne (8 filer,
// ~15MB tekst i alt) matcher den samme størrelsesorden appen allerede bruger til
// base64-filer andre steder (fx cleaning_pdf_base64), så én tung note ikke selv
// bliver en del af den langsomhed vi lige har rettet andre steder i appen.
function cleanNoteAttachments(value) {
  if (value === undefined) return undefined;
  if (value === null) return null;
  let arr;
  if (Array.isArray(value)) {
    arr = value;
  } else if (typeof value === 'string') {
    if (!value.trim()) return null;
    try { arr = JSON.parse(value); } catch (e) { return null; }
  } else {
    return null;
  }
  if (!Array.isArray(arr)) return null;
  const MAX_ITEMS = 8;
  const MAX_ITEM_CHARS = 9000000;
  const MAX_TOTAL_CHARS = 15000000;
  const cleaned = [];
  let total = 0;
  for (const a of arr) {
    if (cleaned.length >= MAX_ITEMS) break;
    if (!a || typeof a !== 'object' || !a.data) continue;
    const data = String(a.data).slice(0, MAX_ITEM_CHARS);
    if (total + data.length > MAX_TOTAL_CHARS) break;
    total += data.length;
    cleaned.push({ name: String(a.name || '').slice(0, 200), type: a.type === 'pdf' ? 'pdf' : 'image', data });
  }
  return cleaned.length ? JSON.stringify(cleaned) : null;
}

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
  // Link + vedhæftninger der hører til noten (fx et link til en tegning, eller
  // billeder/PDF'er). Rører ALDRIG uopfordret, ligesom noteteksten ovenfor — sendes
  // de ikke med i request'en (fx fra en af de andre hurtig-popups), bevares den
  // eksisterende værdi fordi kaldene til normalizeBooking() ved redigering allerede
  // har merget dem ind.
  const noteLink = cleanNoteLink(booking.note_link);
  const noteAttachments = cleanNoteAttachments(booking.note_attachments);
  return {
    task_id: booking.task_id,
    user_id: Number(booking.user_id),
    week_key: getWeekKey(start),
    days,
    capacity_days: capacityDays,
    notes: finalNote ? finalNote.slice(0, 1000) : null,
    note_link: noteLink === undefined ? null : noteLink,
    note_attachments: noteAttachments === undefined ? null : noteAttachments,
    start_time: booking.start_time || null,
    start_date: start,
    end_date: validDate(booking.end_date) ? booking.end_date : addWorkingDays(start, days)
  };
}

function bookingSelect(where = '') {
  return `
    SELECT b.*,u.name AS user_name,u.color AS user_color,u.initials AS user_initials,u.avatar_url AS user_avatar_url,u.worker_type,u.vendor_group,u.trade,u.weekly_capacity,u.can_login,
           t.name AS task_name,t.job_name,t.job_address,t.job_number,t.job_lat,t.job_lng,t.customer_phone,t.customer_email,t.is_visit,t.description AS task_description,t.start_date AS task_start_date,t.end_date AS task_end_date,t.type_guess,t.jt_url,t.job_id,t.source AS task_source,
           -- Sat når opgaven kommer fra en sag (mirrorProjectTaskToPool i stedet for
           -- en rigtig JobTread-synk) — bruges af employee-demo.html til at vise
           -- "spor tid"/"kvalitetssikring" som en formular i selve appen (mod sagen)
           -- i stedet for et link ud til JobTread, som der intet rigtigt job er for.
           t.project_id AS task_project_id
    FROM planning_bookings b
    JOIN users u ON b.user_id=u.id
    JOIN jt_tasks t ON b.task_id=t.id
    ${where}
  `;
}

// FEJL RETTET (Daglig plan brugte 30-60 sek. om at åbne): denne route hentede FØR
// hele "note_attachments"-feltet (billeder/PDF'er som base64, op til ~15MB PR.
// booking) med for HVER ENESTE booking der nogensinde er oprettet — hver gang appen
// gør noget som helst (loadAll() kaldes efter stort set enhver handling i hele
// appen). Med bare en håndfuld bookinger med vedhæftede billeder bliver den samlede
// JSON-besked kæmpestor, og det er den — ikke selve antallet af bookinger — der reelt
// stod for de lange ventetider. Selve vedhæftningerne bruges kun ét sted i admin-UI'et
// (redigér-booking-popup'en), så de sendes nu KUN med der, via en ny, lille
// GET /api/assignments/:id/note — resten af appen nøjes med et let "has_note_attachments"-
// flag, der er nok til fx et 📎-ikon, uden at slæbe selve billeddataen med hele tiden.
app.get('/api/assignments', auth, asyncRoute(async (req, res) => {
  const isAdmin = req.user.role === 'admin';
  const sql = `${bookingSelect(isAdmin ? '' : 'WHERE b.user_id=$1')} ORDER BY b.start_date ASC,b.id ASC`;
  const result = await pool.query(sql, isAdmin ? [] : [req.user.id]);
  const rows = result.rows.map(r => {
    const hasAttachments = !!(r.note_attachments && String(r.note_attachments).trim() && String(r.note_attachments).trim() !== 'null');
    return { ...r, note_attachments: null, has_note_attachments: hasAttachments };
  });
  res.json(rows);
}));

// HOLDOVERBLIK & KORT — læst-adgang for admin ELLER for de medarbejdere Martin har
// krydset af (can_view_team_overview), typisk en mester. Returnerer, for én uge ad
// gangen: hvor hver medarbejder er booket i dag (til kortet, med koordinater) og hvad
// de er tilknyttet resten af ugen (til listen) — bevidst afgrænset til én uge i stedet
// for at sende hele appens bookinger, som /api/assignments gør for admin.
app.get('/api/team/overview', auth, asyncRoute(async (req, res) => {
  const requester = await pgOne('SELECT id, role, can_view_team_overview FROM users WHERE id=$1', [req.user.id]);
  if (!requester || (requester.role !== 'admin' && !requester.can_view_team_overview)) {
    return res.status(403).json({ error: 'You do not have access to the team overview' });
  }
  const dateStr = validDate(String(req.query.date || '')) ? String(req.query.date) : new Date().toISOString().slice(0, 10);
  const weekStart = mondayOfDate(dateStr) || dateStr;
  const weekStartDate = new Date(`${weekStart}T12:00:00`);
  const weekEndDate = new Date(weekStartDate);
  weekEndDate.setDate(weekEndDate.getDate() + 6);
  const weekEnd = weekEndDate.toISOString().slice(0, 10);

  const employeesRes = await pool.query("SELECT id,name,color,initials,avatar_url,trade FROM users WHERE active=1 AND role='employee' ORDER BY name");
  const byUser = {};
  employeesRes.rows.forEach(u => { byUser[u.id] = { ...u, today: [], week: {} }; });

  const bookingsRes = await pool.query(bookingSelect(`
    WHERE COALESCE(b.planning_mode,'daily')='daily' AND b.start_date <= $2 AND COALESCE(b.end_date, b.start_date) >= $1
  `), [weekStart, weekEnd]);

  for (const b of bookingsRes.rows) {
    const bucket = byUser[b.user_id];
    if (!bucket) continue; // vendor/inaktiv medarbejder — vises ikke i holdoverblikket
    const item = { job_name: b.job_name, task_name: b.task_name, job_address: b.job_address, job_lat: b.job_lat, job_lng: b.job_lng, start_time: b.start_time };
    let d = new Date(`${String(b.start_date).slice(0, 10)}T12:00:00`);
    const endD = new Date(`${String(b.end_date || b.start_date).slice(0, 10)}T12:00:00`);
    while (d <= endD) {
      if (d.getDay() !== 0 && d.getDay() !== 6) { // spring weekender over, ligesom admins egen workDates()
        const ds = d.toISOString().slice(0, 10);
        if (ds >= weekStart && ds <= weekEnd) {
          (bucket.week[ds] = bucket.week[ds] || []).push(item);
          if (ds === dateStr) bucket.today.push(item);
        }
      }
      d.setDate(d.getDate() + 1);
    }
  }
  res.json({ date: dateStr, weekStart, weekEnd, employees: Object.values(byUser) });
}));

// Henter den fulde note (tekst + link + vedhæftninger) for ÉN booking — bruges når
// admin rent faktisk åbner "Rediger booking"-popup'en, i stedet for at slæbe alle
// vedhæftninger med i den store liste ovenfor.
app.get('/api/assignments/:id/note', auth, adminOnly, asyncRoute(async (req, res) => {
  const row = await pgOne('SELECT notes, note_link, note_attachments FROM planning_bookings WHERE id=$1', [Number(req.params.id)]);
  if (!row) return res.status(404).json({ error: 'Bookingen blev ikke fundet' });
  res.json(row);
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
      INSERT INTO planning_bookings (task_id,user_id,week_key,days,capacity_days,notes,note_link,note_attachments,start_time,start_date,end_date,updated_at)
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,${nowTextSQL()})
      RETURNING id
    `, [booking.task_id, booking.user_id, booking.week_key, booking.days, booking.capacity_days, booking.notes, booking.note_link, booking.note_attachments, booking.start_time, booking.start_date, booking.end_date]);
    res.json({ ok: true, id: result.rows[0].id });
  } catch (error) {
    res.status(400).json({ error: error.message });
  }
}));

app.post('/api/assignments', auth, adminOnly, asyncRoute(async (req, res) => {
  try {
    const booking = await normalizeBooking(req.body, true);
    const result = await pool.query(`
      INSERT INTO planning_bookings (task_id,user_id,week_key,days,capacity_days,notes,note_link,note_attachments,start_time,start_date,end_date,updated_at)
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,${nowTextSQL()})
      RETURNING id
    `, [booking.task_id, booking.user_id, booking.week_key, booking.days, booking.capacity_days, booking.notes, booking.note_link, booking.note_attachments, booking.start_time, booking.start_date, booking.end_date]);
    let warning = null;
    try {
      const overlap = await timeOffOverlaps(booking.user_id, booking.start_date, booking.end_date);
      if (overlap.rows.length) warning = 'Medarbejderen har registreret ferie/fravær i denne periode';
    } catch (_) {}
    res.json({ ok: true, id: result.rows[0].id, warning });
    sendScheduleChangeEmail(booking.user_id, `Du har fået en ny opgave sat på din kalender: ${String(booking.start_date).slice(0,10)}.`)
      .catch(e => console.error('Kalender-mail fejlede:', e.message));
    // Push/in-app-besked om den nye tildeling — i modsætning til selve
    // plan-ÆNDRINGER (se PUT nedenfor) sendes denne ALTID, uanset hvor langt ude i
    // fremtiden opgaven ligger, fordi det er første gang medarbejderen overhovedet
    // ser den. En dags-booking langt ude i fremtiden er stadig ny information nu.
    notifyEmployee(booking.user_id, 'Ny opgave i din plan', `Du er sat på en opgave ${dayLabelForNotif(booking.start_date)} (${String(booking.start_date).slice(0,10)}).`, '#plan').catch(() => {});
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
      SET user_id=$1,week_key=$2,days=$3,capacity_days=$4,notes=$5,note_link=$6,note_attachments=$7,start_time=$8,start_date=$9,end_date=$10,updated_at=${nowTextSQL()}
      WHERE id=$11
    `, [booking.user_id, booking.week_key, booking.days, booking.capacity_days, booking.notes, booking.note_link, booking.note_attachments, booking.start_time, booking.start_date, booking.end_date, current.id]);
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
  // Matcher på tværs af BÅDE det nye CRM-kartotek (customers) og de historiske
  // JobTread-sager (jt_tasks) — CRM-kunder vises først, da de er dem Martin
  // selv har oprettet med vilje. customer_id er sat for CRM-rækker, ellers null.
  const [crmRows, jtRows] = await Promise.all([
    pool.query(`
      SELECT id AS customer_id, name AS job_name, address AS job_address, NULL::TEXT AS job_number,
        phone AS customer_phone, email AS customer_email, NULL::DOUBLE PRECISION AS job_lat, NULL::DOUBLE PRECISION AS job_lng
      FROM customers WHERE name ILIKE $1 ORDER BY name LIMIT 8
    `, [`%${q}%`]),
    pool.query(`
      SELECT DISTINCT ON (job_name, job_address) NULL::INTEGER AS customer_id, job_name, job_address, job_number,
        customer_phone, customer_email, job_lat, job_lng
      FROM jt_tasks
      WHERE job_name ILIKE $1 AND job_name IS NOT NULL AND job_name <> ''
      ORDER BY job_name, job_address, created_at DESC
      LIMIT 12
    `, [`%${q}%`])
  ]);
  res.json([...crmRows.rows, ...jtRows.rows]);
}));

// ── CRM: KUNDEKARTOTEK — eget kundekartotek Martin kan oprette kunder i
// direkte, uafhængigt af om der findes en JobTread-sag på dem endnu. ────
app.get('/api/crm/customers', auth, financeOnly, asyncRoute(async (req, res) => {
  const q = String(req.query.q || '').trim();
  const rows = q
    ? await pool.query('SELECT * FROM customers WHERE name ILIKE $1 OR email ILIKE $1 OR phone ILIKE $1 ORDER BY name', [`%${q}%`])
    : await pool.query('SELECT * FROM customers ORDER BY name');
  res.json(rows.rows);
}));
app.post('/api/crm/customers', auth, financeOnly, asyncRoute(async (req, res) => {
  const b = req.body || {};
  if (!b.name) return res.status(400).json({ error: 'Navn mangler' });
  const isCompany = !!b.is_company;
  const cvr = isCompany && b.cvr ? String(b.cvr).trim().slice(0, 20) : null;
  const r = await pool.query(`
    INSERT INTO customers (name,email,phone,address,notes,is_company,cvr) VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING id
  `, [String(b.name).trim(), b.email || null, b.phone || null, b.address || null, b.notes || null, isCompany ? 1 : 0, cvr]);
  res.json({ ok: true, id: r.rows[0].id });
}));
app.put('/api/crm/customers/:id', auth, financeOnly, asyncRoute(async (req, res) => {
  const current = await pgOne('SELECT * FROM customers WHERE id=$1', [req.params.id]);
  if (!current) return res.status(404).json({ error: 'Kunden blev ikke fundet' });
  const b = req.body || {};
  const isCompany = b.is_company !== undefined ? !!b.is_company : !!current.is_company;
  const cvr = b.cvr !== undefined ? (isCompany && b.cvr ? String(b.cvr).trim().slice(0, 20) : null) : current.cvr;
  await pool.query(`
    UPDATE customers SET name=$1,email=$2,phone=$3,address=$4,notes=$5,is_company=$6,cvr=$7,updated_at=${nowTextSQL()} WHERE id=$8
  `, [
    b.name !== undefined ? String(b.name).trim() : current.name,
    b.email !== undefined ? b.email : current.email,
    b.phone !== undefined ? b.phone : current.phone,
    b.address !== undefined ? b.address : current.address,
    b.notes !== undefined ? b.notes : current.notes,
    isCompany ? 1 : 0,
    cvr,
    req.params.id
  ]);
  res.json({ ok: true });
}));
app.delete('/api/crm/customers/:id', auth, financeOnly, asyncRoute(async (req, res) => {
  await pool.query('DELETE FROM customers WHERE id=$1', [req.params.id]);
  res.json({ ok: true });
}));

// ══════════════════════════════════════════════════════════════
// PROJEKTER — oprettes automatisk når en kunde underskriver et tilbud (se
// /api/public/quotes/:token/accept), og indeholder: et let sags-Gantt (lokale
// opgaver, IKKE synkroniseret med JobTread — derfor egne endpoints i stedet
// for at genbruge /api/gantt/*), billeder, tidsregistrering og KS-formularer.
// ══════════════════════════════════════════════════════════════
// Bevidst KUN 'auth' (ikke financeOnly) — medarbejdere skal kunne se listen af
// projekter i employee.html for at vælge hvilken sag de tidsregistrerer på.
// Svaret indeholder ingen priser/tilbudsbeløb, kun navn/status/tæller.
//
// Spejler en sags-opgave (gantt_tasks-række med project_id) ind i jt_tasks med
// SAMME id, så den automatisk dukker op i Opgavepool/Kapacitet/Daglig plan —
// helt gratis får den dermed også tjekpunkter (task_checklist_items er allerede
// id-agnostisk, ingen FK) og "Tilføj til Kapacitetsbordet" (openCapacityModal på
// klienten slår bare taskId op i den delte tasks-liste). UPSERT, så både opret
// og redigér kan kalde samme funktion uden at skulle vide om rækken findes.
async function mirrorProjectTaskToPool(id, project, fields) {
  await pool.query(`
    INSERT INTO jt_tasks (id,name,job_id,job_name,job_address,customer_phone,customer_email,customer_email_source,start_date,end_date,description,synced_at,source,created_at,project_id)
    VALUES ($1,$2,NULL,$3,$4,$5,$6,$7,$8,$9,$10,${nowTextSQL()},'project',${nowTextSQL()},$11)
    ON CONFLICT (id) DO UPDATE SET
      name=EXCLUDED.name, job_name=EXCLUDED.job_name, job_address=EXCLUDED.job_address,
      customer_phone=EXCLUDED.customer_phone, customer_email=EXCLUDED.customer_email,
      start_date=EXCLUDED.start_date, end_date=EXCLUDED.end_date, description=EXCLUDED.description,
      synced_at=${nowTextSQL()}
  `, [
    id, fields.name, project.name, project.customer_address || null,
    project.customer_phone || null, project.customer_email || null,
    project.customer_email ? 'project' : null,
    fields.start_date, fields.end_date || fields.start_date, fields.description || '',
    project.id
  ]);
}
app.get('/api/projects', auth, asyncRoute(async (req, res) => {
  const rows = await pool.query(`
    SELECT p.*, q.quote_number,
      (SELECT COUNT(*)::int FROM gantt_tasks WHERE project_id=p.id) AS task_count,
      (SELECT COUNT(*)::int FROM time_entries WHERE project_id=p.id) AS time_entry_count,
      (SELECT COUNT(*)::int FROM project_photos WHERE project_id=p.id) AS photo_count
    FROM projects p LEFT JOIN quotes q ON q.id = p.quote_id
    ORDER BY p.created_at DESC
  `);
  res.json(rows.rows);
}));

app.get('/api/projects/:id', auth, asyncRoute(async (req, res) => {
  const project = await pgOne('SELECT * FROM projects WHERE id=$1', [req.params.id]);
  if (!project) return res.status(404).json({ error: 'Projektet blev ikke fundet' });
  const [tasks, photos, timeEntries, materials, qaSubmissions, contactSubmissions, quoteLines] = await Promise.all([
    pool.query('SELECT * FROM gantt_tasks WHERE project_id=$1 ORDER BY position ASC, id ASC', [req.params.id]).then(r => r.rows),
    pool.query('SELECT * FROM project_photos WHERE project_id=$1 ORDER BY created_at DESC', [req.params.id]).then(r => r.rows),
    pool.query('SELECT * FROM time_entries WHERE project_id=$1 ORDER BY entry_date DESC, id DESC', [req.params.id]).then(r => r.rows),
    pool.query('SELECT * FROM project_materials WHERE project_id=$1 ORDER BY created_at DESC', [req.params.id]).then(r => r.rows),
    pool.query('SELECT * FROM qa_submissions WHERE project_id=$1 ORDER BY submitted_at DESC', [req.params.id]).then(r => r.rows),
    pool.query('SELECT * FROM contact_form_submissions WHERE project_id=$1 ORDER BY submitted_at DESC', [req.params.id]).then(r => r.rows),
    project.quote_id
      ? pool.query('SELECT id, description FROM quote_lines WHERE quote_id=$1 ORDER BY position ASC, id ASC', [project.quote_id]).then(r => r.rows)
      : Promise.resolve([])
  ]);
  res.json({ ...project, tasks, photos, time_entries: timeEntries, materials, qa_submissions: qaSubmissions, contact_form_submissions: contactSubmissions, quote_line_options: quoteLines });
}));

app.put('/api/projects/:id', auth, financeOnly, asyncRoute(async (req, res) => {
  const current = await pgOne('SELECT * FROM projects WHERE id=$1', [req.params.id]);
  if (!current) return res.status(404).json({ error: 'Projektet blev ikke fundet' });
  const b = req.body || {};
  await pool.query(`
    UPDATE projects SET name=$1, status=$2, customer_address=$3, customer_phone=$4, customer_email=$5, updated_at=${nowTextSQL()}
    WHERE id=$6
  `, [
    b.name !== undefined ? String(b.name).trim() : current.name,
    b.status !== undefined ? b.status : current.status,
    b.customer_address !== undefined ? b.customer_address : current.customer_address,
    b.customer_phone !== undefined ? b.customer_phone : current.customer_phone,
    b.customer_email !== undefined ? b.customer_email : current.customer_email,
    req.params.id
  ]);
  res.json({ ok: true });
}));

// 1-KLIKS: opret én sags-opgave pr. tilbudslinje. Kan trykkes flere gange uden
// at lave dubletter — springer linjer over der allerede har en opgave.
app.post('/api/projects/:id/convert-quote-lines', auth, financeOnly, asyncRoute(async (req, res) => {
  const project = await pgOne('SELECT * FROM projects WHERE id=$1', [req.params.id]);
  if (!project) return res.status(404).json({ error: 'Projektet blev ikke fundet' });
  if (!project.quote_id) return res.status(400).json({ error: 'Dette projekt har intet tilknyttet tilbud' });
  const lines = (await pool.query('SELECT * FROM quote_lines WHERE quote_id=$1 ORDER BY position ASC, id ASC', [project.quote_id])).rows;
  const existing = (await pool.query('SELECT source_quote_line_id FROM gantt_tasks WHERE project_id=$1 AND source_quote_line_id IS NOT NULL', [req.params.id])).rows;
  const already = new Set(existing.map(r => r.source_quote_line_id));
  let countRes = await pgOne('SELECT COUNT(*)::int AS n FROM gantt_tasks WHERE project_id=$1', [req.params.id]);
  let pos = countRes ? countRes.n : 0;
  const today = new Date().toISOString().slice(0, 10);
  let created = 0;
  for (const l of lines) {
    if (already.has(l.id)) continue;
    const id = 'p' + crypto.randomBytes(12).toString('hex');
    await pool.query(`
      INSERT INTO gantt_tasks (id,job_id,job_name,name,description,start_date,end_date,progress,is_group,position,project_id,source_quote_line_id,synced_at)
      VALUES ($1,$2,$3,$4,'',$5,$5,0,0,$6,$7,$8,${nowTextSQL()})
    `, [id, 'project-' + project.id, project.name, l.description, today, String(pos), req.params.id, l.id]);
    await mirrorProjectTaskToPool(id, project, { name: l.description, start_date: today, end_date: today, description: '' });
    pos++;
    created++;
  }
  res.json({ ok: true, created });
}));

app.post('/api/projects/:id/tasks', auth, financeOnly, asyncRoute(async (req, res) => {
  const project = await pgOne('SELECT * FROM projects WHERE id=$1', [req.params.id]);
  if (!project) return res.status(404).json({ error: 'Projektet blev ikke fundet' });
  const b = req.body || {};
  const name = String(b.name || '').trim();
  if (!name) return res.status(400).json({ error: 'Skriv et navn til opgaven' });
  if (!validDate(b.start_date)) return res.status(400).json({ error: 'Vælg en gyldig startdato' });
  const countRes = await pgOne('SELECT COUNT(*)::int AS n FROM gantt_tasks WHERE project_id=$1', [req.params.id]);
  const id = 'p' + crypto.randomBytes(12).toString('hex');
  const startDate = b.start_date, endDate = b.end_date || b.start_date;
  await pool.query(`
    INSERT INTO gantt_tasks (id,job_id,job_name,name,description,start_date,end_date,progress,is_group,position,project_id,synced_at)
    VALUES ($1,$2,$3,$4,'',$5,$6,0,0,$7,$8,${nowTextSQL()})
  `, [id, 'project-' + project.id, project.name, name, startDate, endDate, String(countRes ? countRes.n : 0), req.params.id]);
  await mirrorProjectTaskToPool(id, project, { name, start_date: startDate, end_date: endDate, description: '' });
  res.json({ ok: true, id });
}));

app.put('/api/projects/:id/tasks/:taskId', auth, financeOnly, asyncRoute(async (req, res) => {
  const current = await pgOne('SELECT * FROM gantt_tasks WHERE id=$1 AND project_id=$2', [req.params.taskId, req.params.id]);
  if (!current) return res.status(404).json({ error: 'Opgaven blev ikke fundet' });
  const project = await pgOne('SELECT * FROM projects WHERE id=$1', [req.params.id]);
  const b = req.body || {};
  const merged = {
    name: b.name !== undefined ? String(b.name).trim() : current.name,
    start_date: b.start_date !== undefined ? b.start_date : current.start_date,
    end_date: b.end_date !== undefined ? b.end_date : current.end_date,
    progress: b.progress !== undefined ? Math.max(0, Math.min(1, Number(b.progress))) : current.progress,
    // "Note" på opgaven — samme description-felt der bruges i det almindelige
    // Gantt-opgave-detaljevindue (gd-desc), vist i sagens opgave-detaljer.
    description: b.description !== undefined ? String(b.description).slice(0, 2000) : (current.description || '')
  };
  await pool.query(`
    UPDATE gantt_tasks SET name=$1, start_date=$2, end_date=$3, progress=$4, description=$5, synced_at=${nowTextSQL()} WHERE id=$6
  `, [merged.name, merged.start_date, merged.end_date, merged.progress, merged.description, req.params.taskId]);
  if (project) await mirrorProjectTaskToPool(req.params.taskId, project, merged);
  res.json({ ok: true });
}));

app.delete('/api/projects/:id/tasks/:taskId', auth, financeOnly, asyncRoute(async (req, res) => {
  // Rydder også op i poolen (og alt der peger på opgaven dér) — ellers ville en
  // slettet sags-opgave blive hængende som en "spøgelses"-opgave i Opgavepool/
  // Kapacitet/Daglig plan, siden de tabeller ikke har nogen FK til gantt_tasks.
  await pool.query('DELETE FROM task_checklist_items WHERE task_id=$1', [req.params.taskId]);
  await pool.query('DELETE FROM planning_bookings WHERE task_id=$1', [req.params.taskId]);
  await pool.query('DELETE FROM assignments WHERE task_id=$1', [req.params.taskId]);
  await pool.query('DELETE FROM jt_tasks WHERE id=$1 AND project_id=$2', [req.params.taskId, req.params.id]);
  await pool.query('DELETE FROM gantt_tasks WHERE id=$1 AND project_id=$2', [req.params.taskId, req.params.id]);
  res.json({ ok: true });
}));

app.post('/api/projects/:id/photos', auth, asyncRoute(async (req, res) => {
  const project = await pgOne('SELECT id FROM projects WHERE id=$1', [req.params.id]);
  if (!project) return res.status(404).json({ error: 'Projektet blev ikke fundet' });
  const b = req.body || {};
  if (!b.url) return res.status(400).json({ error: 'Intet billede angivet' });
  const r = await pool.query('INSERT INTO project_photos (project_id,url,uploaded_by,caption) VALUES ($1,$2,$3,$4) RETURNING id',
    [req.params.id, b.url, req.user.id, b.caption || null]);
  res.json({ ok: true, id: r.rows[0].id });
}));

app.delete('/api/projects/:id/photos/:photoId', auth, financeOnly, asyncRoute(async (req, res) => {
  await pool.query('DELETE FROM project_photos WHERE id=$1 AND project_id=$2', [req.params.photoId, req.params.id]);
  res.json({ ok: true });
}));

// ── TIDSREGISTRERING — hver registrering KRÆVER en note og et billede
// (dokumentation for det udførte arbejde), og kan valgfrit tagges med hvilken
// tilbudslinje/post arbejdet hører til, samt om der er købt materialer. ────
app.post('/api/projects/:id/time-entries', auth, asyncRoute(async (req, res) => {
  const project = await pgOne('SELECT id FROM projects WHERE id=$1', [req.params.id]);
  if (!project) return res.status(404).json({ error: 'Projektet blev ikke fundet' });
  const b = req.body || {};
  const note = String(b.note || '').trim();
  const minutes = Number(b.minutes);
  if (!note) return res.status(400).json({ error: 'Skriv en note om det udførte arbejde' });
  if (!b.photo_url) return res.status(400).json({ error: 'Upload et billede som dokumentation' });
  if (!minutes || minutes <= 0) return res.status(400).json({ error: 'Angiv hvor mange minutter der er brugt' });
  const entryDate = validDate(b.entry_date) ? b.entry_date : new Date().toISOString().slice(0, 10);
  const r = await pool.query(`
    INSERT INTO time_entries (project_id,user_id,minutes,note,photo_url,bought_materials,quote_line_id,entry_date)
    VALUES ($1,$2,$3,$4,$5,$6,$7,$8) RETURNING id
  `, [req.params.id, req.user.id, Math.round(minutes), note, b.photo_url, b.bought_materials || null, b.quote_line_id || null, entryDate]);
  res.json({ ok: true, id: r.rows[0].id });
}));

app.delete('/api/projects/:id/time-entries/:entryId', auth, financeOnly, asyncRoute(async (req, res) => {
  await pool.query('DELETE FROM time_entries WHERE id=$1 AND project_id=$2', [req.params.entryId, req.params.id]);
  res.json({ ok: true });
}));

// ── MATERIALER — erstatter det gamle "Upload Bill"-link ud til JobTread på
// sags-opgaver (der findes intet rigtigt JobTread-job at koble en regning på).
// Kræver et kvitteringsbillede, pris og butik/leverandør, så Martin bagefter
// kan trække posten ind som en fakturalinje med ét klik (se .../invoice nedenfor,
// som følger nøjagtig samme mønster som .../time-entries/:entryId/invoice).
app.post('/api/projects/:id/materials', auth, asyncRoute(async (req, res) => {
  const project = await pgOne('SELECT id FROM projects WHERE id=$1', [req.params.id]);
  if (!project) return res.status(404).json({ error: 'Projektet blev ikke fundet' });
  const b = req.body || {};
  const price = Number(b.price);
  const store = String(b.store || '').trim();
  if (!b.receipt_photo_url) return res.status(400).json({ error: 'Upload et billede af regningen/fakturaen' });
  if (!price || price <= 0) return res.status(400).json({ error: 'Angiv prisen' });
  if (!store) return res.status(400).json({ error: 'Angiv hvilken butik/leverandør' });
  const r = await pool.query(`
    INSERT INTO project_materials (project_id,user_id,price,store,note,receipt_photo_url)
    VALUES ($1,$2,$3,$4,$5,$6) RETURNING id
  `, [req.params.id, req.user.id, price, store, b.note || null, b.receipt_photo_url]);
  res.json({ ok: true, id: r.rows[0].id });
}));

app.delete('/api/projects/:id/materials/:materialId', auth, financeOnly, asyncRoute(async (req, res) => {
  await pool.query('DELETE FROM project_materials WHERE id=$1 AND project_id=$2', [req.params.materialId, req.params.id]);
  res.json({ ok: true });
}));

// ── HURTIG FAKTURERING FRA MATERIALER — samme mønster som
// .../time-entries/:entryId/invoice: lægger materialeposten som ny linje på
// sagens faktura. Modsat tidsregistreringer (hvor beløbet sættes til 0/0, fordi
// timeprisen skal fastsættes af Martin) sætter vi her både cost- og salgspris
// til den registrerede pris, da den ER den faktiske udgift — Martin kan justere
// avancen bagefter på selve fakturalinjen, hvis materialerne skal videresælges
// med tillæg.
app.post('/api/projects/:id/materials/:materialId/invoice', auth, financeOnly, asyncRoute(async (req, res) => {
  const project = await pgOne('SELECT * FROM projects WHERE id=$1', [req.params.id]);
  if (!project) return res.status(404).json({ error: 'Sagen blev ikke fundet' });
  if (!project.invoice_id) return res.status(400).json({ error: 'Sagen har endnu ingen faktura — konvertér tilbuddet til faktura under Tilbud & Faktura først' });
  const mat = await pgOne('SELECT * FROM project_materials WHERE id=$1 AND project_id=$2', [req.params.materialId, req.params.id]);
  if (!mat) return res.status(404).json({ error: 'Materiale-posten blev ikke fundet' });
  const invoice = await pgOne('SELECT * FROM invoices WHERE id=$1', [project.invoice_id]);
  const posRes = await pgOne('SELECT COALESCE(MAX(position),-1)::int AS maxpos FROM invoice_lines WHERE invoice_id=$1', [invoice.id]);
  const pos = posRes.maxpos + 1;
  const desc = 'Materialer' + (mat.store ? ' — ' + mat.store : '') + (mat.note ? ' (' + mat.note + ')' : '');
  await pool.query(`
    INSERT INTO invoice_lines (invoice_id,description,unit,quantity,cost_price,sell_price,position,product_type)
    VALUES ($1,$2,'stk',1,$3,$3,$4,'materialer')
  `, [invoice.id, desc, mat.price, pos]);
  const lines = (await pool.query('SELECT * FROM invoice_lines WHERE invoice_id=$1', [invoice.id])).rows;
  const totals = computeTotals(lines, Number(invoice.tax_rate), Number(invoice.discount_pct) || 0);
  await pool.query(`UPDATE invoices SET subtotal=$1, tax_amount=$2, total=$3, updated_at=${nowTextSQL()} WHERE id=$4`, [totals.subtotal, totals.taxAmount, totals.total, invoice.id]);
  await refreshInvoiceStatus(invoice.id);
  res.json({ ok: true, invoice_id: invoice.id });
}));

// ── KVALITETSSIKRING — Martin bygger formularer (skabeloner med felter),
// medarbejdere udfylder dem under et projekt. ──────
app.get('/api/qa-templates', auth, asyncRoute(async (req, res) => {
  const rows = await pool.query('SELECT * FROM qa_templates ORDER BY name');
  res.json(rows.rows.map(r => ({ ...r, fields: typeof r.fields === 'string' ? safeJsonParse(r.fields, []) : (r.fields || []) })));
}));

app.post('/api/qa-templates', auth, financeOnly, asyncRoute(async (req, res) => {
  const b = req.body || {};
  const name = String(b.name || '').trim();
  if (!name) return res.status(400).json({ error: 'Skriv et navn til skabelonen' });
  const fields = Array.isArray(b.fields) ? b.fields : [];
  const r = await pool.query('INSERT INTO qa_templates (name,fields) VALUES ($1,$2) RETURNING id', [name, JSON.stringify(fields)]);
  res.json({ ok: true, id: r.rows[0].id });
}));

app.put('/api/qa-templates/:id', auth, financeOnly, asyncRoute(async (req, res) => {
  const current = await pgOne('SELECT * FROM qa_templates WHERE id=$1', [req.params.id]);
  if (!current) return res.status(404).json({ error: 'Skabelonen blev ikke fundet' });
  const b = req.body || {};
  await pool.query(`UPDATE qa_templates SET name=$1, fields=$2, updated_at=${nowTextSQL()} WHERE id=$3`, [
    b.name !== undefined ? String(b.name).trim() : current.name,
    b.fields !== undefined ? JSON.stringify(b.fields) : current.fields,
    req.params.id
  ]);
  res.json({ ok: true });
}));

app.delete('/api/qa-templates/:id', auth, financeOnly, asyncRoute(async (req, res) => {
  await pool.query('DELETE FROM qa_templates WHERE id=$1', [req.params.id]);
  res.json({ ok: true });
}));

app.post('/api/projects/:id/qa-submissions', auth, asyncRoute(async (req, res) => {
  const project = await pgOne('SELECT id FROM projects WHERE id=$1', [req.params.id]);
  if (!project) return res.status(404).json({ error: 'Projektet blev ikke fundet' });
  const b = req.body || {};
  const answers = Array.isArray(b.answers) ? b.answers : [];
  if (!answers.length) return res.status(400).json({ error: 'Udfyld mindst ét felt' });
  const r = await pool.query(`
    INSERT INTO qa_submissions (project_id,template_id,template_name,answers,submitted_by)
    VALUES ($1,$2,$3,$4,$5) RETURNING id
  `, [req.params.id, b.template_id || null, b.template_name || null, JSON.stringify(answers), req.user.id]);
  res.json({ ok: true, id: r.rows[0].id });
}));

app.delete('/api/qa-submissions/:id', auth, financeOnly, asyncRoute(async (req, res) => {
  await pool.query('DELETE FROM qa_submissions WHERE id=$1', [req.params.id]);
  res.json({ ok: true });
}));

// ── KONTAKTFORMULAR — samme mønster som KS-skabeloner ovenfor, blot en
// separat skabelon-/besvarelses-tabel så de to formål ikke blandes sammen. ──
app.get('/api/contact-form-templates', auth, asyncRoute(async (req, res) => {
  const rows = await pool.query('SELECT * FROM contact_form_templates ORDER BY name');
  res.json(rows.rows.map(r => ({ ...r, fields: typeof r.fields === 'string' ? safeJsonParse(r.fields, []) : (r.fields || []) })));
}));

app.post('/api/contact-form-templates', auth, financeOnly, asyncRoute(async (req, res) => {
  const b = req.body || {};
  const name = String(b.name || '').trim();
  if (!name) return res.status(400).json({ error: 'Skriv et navn til formularen' });
  const fields = Array.isArray(b.fields) ? b.fields : [];
  const r = await pool.query('INSERT INTO contact_form_templates (name,fields) VALUES ($1,$2) RETURNING id', [name, JSON.stringify(fields)]);
  res.json({ ok: true, id: r.rows[0].id });
}));

app.put('/api/contact-form-templates/:id', auth, financeOnly, asyncRoute(async (req, res) => {
  const current = await pgOne('SELECT * FROM contact_form_templates WHERE id=$1', [req.params.id]);
  if (!current) return res.status(404).json({ error: 'Formularen blev ikke fundet' });
  const b = req.body || {};
  await pool.query(`UPDATE contact_form_templates SET name=$1, fields=$2, updated_at=${nowTextSQL()} WHERE id=$3`, [
    b.name !== undefined ? String(b.name).trim() : current.name,
    b.fields !== undefined ? JSON.stringify(b.fields) : current.fields,
    req.params.id
  ]);
  res.json({ ok: true });
}));

app.delete('/api/contact-form-templates/:id', auth, financeOnly, asyncRoute(async (req, res) => {
  await pool.query('DELETE FROM contact_form_templates WHERE id=$1', [req.params.id]);
  res.json({ ok: true });
}));

app.post('/api/projects/:id/contact-form-submissions', auth, asyncRoute(async (req, res) => {
  const project = await pgOne('SELECT id FROM projects WHERE id=$1', [req.params.id]);
  if (!project) return res.status(404).json({ error: 'Projektet blev ikke fundet' });
  const b = req.body || {};
  const answers = Array.isArray(b.answers) ? b.answers : [];
  if (!answers.length) return res.status(400).json({ error: 'Udfyld mindst ét felt' });
  const r = await pool.query(`
    INSERT INTO contact_form_submissions (project_id,template_id,template_name,answers,submitted_by)
    VALUES ($1,$2,$3,$4,$5) RETURNING id
  `, [req.params.id, b.template_id || null, b.template_name || null, JSON.stringify(answers), req.user.id]);
  res.json({ ok: true, id: r.rows[0].id });
}));

app.delete('/api/contact-form-submissions/:id', auth, financeOnly, asyncRoute(async (req, res) => {
  await pool.query('DELETE FROM contact_form_submissions WHERE id=$1', [req.params.id]);
  res.json({ ok: true });
}));

// ── HURTIG FAKTURERING FRA TIDSREGISTRERING — tager en registrering (evt.
// med indkøbte materialer) og lægger den som ny linje/linjer på sagens
// faktura, klar til Martin blot skal sætte prisen og sende. Kræver at
// tilbuddet allerede er konverteret til faktura — der findes bevidst ingen
// "opret tom faktura"-vej i systemet, faktura skabes altid fra et tilbud. ──
app.post('/api/projects/:id/time-entries/:entryId/invoice', auth, financeOnly, asyncRoute(async (req, res) => {
  const project = await pgOne('SELECT * FROM projects WHERE id=$1', [req.params.id]);
  if (!project) return res.status(404).json({ error: 'Projektet blev ikke fundet' });
  if (!project.invoice_id) return res.status(400).json({ error: 'Sagen har endnu ingen faktura — konvertér tilbuddet til faktura under Tilbud & Faktura først' });
  const entry = await pgOne('SELECT * FROM time_entries WHERE id=$1 AND project_id=$2', [req.params.entryId, req.params.id]);
  if (!entry) return res.status(404).json({ error: 'Tidsregistreringen blev ikke fundet' });
  const invoice = await pgOne('SELECT * FROM invoices WHERE id=$1', [project.invoice_id]);
  if (!invoice) return res.status(404).json({ error: 'Fakturaen blev ikke fundet' });
  const posRes = await pgOne('SELECT COALESCE(MAX(position),-1)::int AS maxpos FROM invoice_lines WHERE invoice_id=$1', [invoice.id]);
  let pos = posRes.maxpos + 1;
  const hours = Math.round((Number(entry.minutes) / 60) * 100) / 100;
  await pool.query(`
    INSERT INTO invoice_lines (invoice_id,description,unit,quantity,cost_price,sell_price,position,product_type)
    VALUES ($1,$2,'timer',$3,0,0,$4,'service')
  `, [invoice.id, entry.note, hours, pos]);
  pos++;
  if (entry.bought_materials) {
    await pool.query(`
      INSERT INTO invoice_lines (invoice_id,description,unit,quantity,cost_price,sell_price,position,product_type)
      VALUES ($1,$2,'stk',1,0,0,$3,'materialer')
    `, [invoice.id, 'Materialer: ' + entry.bought_materials, pos]);
  }
  const lines = (await pool.query('SELECT * FROM invoice_lines WHERE invoice_id=$1', [invoice.id])).rows;
  const totals = computeTotals(lines, Number(invoice.tax_rate), Number(invoice.discount_pct) || 0);
  await pool.query(`UPDATE invoices SET subtotal=$1, tax_amount=$2, total=$3, updated_at=${nowTextSQL()} WHERE id=$4`,
    [totals.subtotal, totals.taxAmount, totals.total, invoice.id]);
  await refreshInvoiceStatus(invoice.id);
  res.json({ ok: true, invoice_id: invoice.id });
}));

// ══════════════════════════════════════════════════════════════
// KUNDEHISTORIK — samler ALT vi har på én kunde (identificeret ved job_name,
// præcis som /api/customers/search ovenfor — der findes ikke en selvstændig
// "kunde"-tabel). Henter hvert job/sag kunden nogensinde har haft, og alle
// bookinger/noter under dem, på tværs af tid. Fakturering/økonomi er BEVIDST
// ikke forsøgt genskabt her — Økonomi-modulet er et separat, komplekst system
// (bankafstemning, manuel omsætning, overstyringer m.m.), og et forkert tal på
// en kundeside er værre end intet tal. I stedet linkes der ud til JobTread
// (jt_url), som er den faktiske kilde til fakturaer, pr. job.
// ══════════════════════════════════════════════════════════════
app.get('/api/customers/history', auth, adminOnly, asyncRoute(async (req, res) => {
  const name = String(req.query.name || '').trim();
  if (!name) return res.status(400).json({ error: 'Mangler kundenavn' });
  const tasks = await pool.query(`
    SELECT id,name,job_id,job_name,job_address,job_number,customer_phone,customer_email,
           is_visit,type_guess,start_date,end_date,jt_url,source,created_at
    FROM jt_tasks
    WHERE lower(trim(job_name))=lower(trim($1))
    ORDER BY start_date DESC NULLS LAST, created_at DESC
  `, [name]);
  if (!tasks.rows.length) return res.json({ tasks: [], bookings: [] });
  const taskIds = tasks.rows.map(t => t.id);
  const bookings = await pool.query(`
    SELECT b.id,b.task_id,b.user_id,b.start_date,b.end_date,b.days,b.start_time,b.notes,b.note_link,
           b.completed_at,b.planning_mode,b.capacity_label,
           (b.note_attachments IS NOT NULL AND trim(b.note_attachments)<>'' AND trim(b.note_attachments)<>'null') AS has_note_attachments,
           u.name AS user_name, u.color AS user_color
    FROM planning_bookings b
    JOIN users u ON b.user_id=u.id
    WHERE b.task_id = ANY($1::text[])
    ORDER BY b.start_date DESC NULLS LAST, b.id DESC
  `, [taskIds]);
  res.json({ tasks: tasks.rows, bookings: bookings.rows });
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

// ── MAIL-SKABELONER TIL TILBUD/FAKTURA (HTML) ──
app.get('/api/document-email-templates', auth, financeOnly, asyncRoute(async (req, res) => {
  const rows = await pool.query('SELECT * FROM document_email_templates ORDER BY name ASC');
  res.json(rows.rows);
}));
app.post('/api/document-email-templates', auth, financeOnly, asyncRoute(async (req, res) => {
  const body = req.body || {};
  if (!body.name || !body.subject || !body.body_html) return res.status(400).json({ error: 'Navn, emne og indhold skal udfyldes' });
  const r = await pool.query(`
    INSERT INTO document_email_templates (name,subject,body_html,updated_at) VALUES ($1,$2,$3,${nowTextSQL()}) RETURNING id
  `, [String(body.name).trim().slice(0, 200), String(body.subject).trim().slice(0, 300), String(body.body_html).slice(0, 40000)]);
  res.json({ ok: true, id: r.rows[0].id });
}));
app.put('/api/document-email-templates/:id', auth, financeOnly, asyncRoute(async (req, res) => {
  const body = req.body || {};
  const r = await pool.query(`
    UPDATE document_email_templates SET name=$1,subject=$2,body_html=$3,updated_at=${nowTextSQL()} WHERE id=$4
  `, [String(body.name || '').trim().slice(0, 200), String(body.subject || '').trim().slice(0, 300), String(body.body_html || '').slice(0, 40000), req.params.id]);
  if (!r.rowCount) return res.status(404).json({ error: 'Skabelonen blev ikke fundet' });
  res.json({ ok: true });
}));
app.delete('/api/document-email-templates/:id', auth, financeOnly, asyncRoute(async (req, res) => {
  await pool.query('DELETE FROM document_email_templates WHERE id=$1', [req.params.id]);
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
// Sender IKKE kun en in-app-besked mere — rammer nu også push (altid, hvis
// medarbejderen har tilmeldt en enhed) og SMS (kun hvis medarbejderen selv har
// slået "notify_schedule_changes" til OG har et telefonnummer registreret —
// samme opt-in-logik der allerede styrer den personlige e-mail-besked ovenfor).
async function notifyEmployee(userId, title, body, link) {
  if (!userId) return;
  try {
    await pool.query('INSERT INTO notifications (event_key,title,body,link,user_id) VALUES ($1,$2,$3,$4,$5)', ['employee_schedule_change', title, body || null, link || null, userId]);
  } catch (e) { console.error('Medarbejder-notifikation fejlede:', e.message); }
  sendPushToUser(userId, title, body, PUBLIC_APP_URL + '/employee' + (link || '')).catch(e => console.error('Push til medarbejder fejlede:', e.message));
  if (smsIsConfigured()) {
    try {
      const user = await pgOne('SELECT phone, notify_schedule_changes FROM users WHERE id=$1', [userId]);
      if (user && user.notify_schedule_changes && user.phone) {
        await sendSmsUniversal({ to: user.phone, message: `Gulv Master: ${title}${body ? ' — ' + body : ''}` });
      }
    } catch (e) { console.error('SMS til medarbejder fejlede:', e.message); }
  }
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
// RUTEKORT — "Dagens ruter" bruger job_lat/job_lng der allerede følger med på
// hver booking via bookingSelect() (ingen ny endpoint nødvendig for den del).
// De to endpoints herunder dækker resten: at hente flere adressers placering
// på forespørgsel (i stedet for kun som bivirkning af telefon-synk), og at
// vise ALLE projekt-adresser nogensinde til "Alle projekter"-kortet.
// ══════════════════════════════════════════════════════════════
app.post('/api/geocode-jobs', auth, adminOnly, asyncRoute(async (req, res) => {
  const limit = Math.min(40, Math.max(1, +(req.body && req.body.limit) || 25));
  const result = await syncJobGeocodesInBackground(limit);
  res.status(result.ok || result.skipped ? 200 : 500).json(result);
}));
app.get('/api/geo-all-jobs', auth, adminOnly, asyncRoute(async (req, res) => {
  const jobs = await pool.query(`
    SELECT job_address, job_lat, job_lng,
           array_agg(DISTINCT job_name) FILTER (WHERE job_name IS NOT NULL AND job_name<>'') AS job_names,
           COUNT(*)::int AS cnt,
           MAX(start_date) AS last_date
    FROM jt_tasks
    WHERE job_lat IS NOT NULL AND job_lng IS NOT NULL
    GROUP BY job_address, job_lat, job_lng
    ORDER BY last_date DESC NULLS LAST
  `);
  const missing = await pgOne(`
    SELECT COUNT(DISTINCT job_address)::int AS n FROM jt_tasks
    WHERE job_address IS NOT NULL AND trim(job_address)<>'' AND (job_lat IS NULL OR job_lng IS NULL)
  `);
  res.json({ jobs: jobs.rows, missing_count: missing ? missing.n : 0 });
}));

// ══════════════════════════════════════════════════════════════
// KUNDE-KOMMUNIKATION — planlagt-mail og påmindelse dagen før
// ══════════════════════════════════════════════════════════════
function fillEmailVars(str, vars) {
  return String(str || '').replace(/\{\{\s*(\w+)\s*\}\}/g, (m, key) => (vars[key] !== undefined && vars[key] !== null && vars[key] !== '') ? vars[key] : m);
}
// KUNDEPORTAL — opretter (kun første gang) et uigætteligt token for en booking,
// så den offentlige statusside (/portal/:token) kan slå den op uden login.
// Bruges både når en mail til kunden sendes (linket flettes ind som {{link}})
// og når admin selv beder om linket via "🔗 Hent kunde-status-link" i popup'en.
async function getOrCreateBookingToken(bookingId) {
  const row = await pgOne('SELECT public_token FROM planning_bookings WHERE id=$1', [bookingId]);
  if (!row) return null;
  if (row.public_token) return row.public_token;
  const token = crypto.randomBytes(20).toString('hex');
  await pool.query('UPDATE planning_bookings SET public_token=$1 WHERE id=$2', [token, bookingId]);
  return token;
}
function portalLinkFor(token) {
  return `${PUBLIC_APP_URL}/portal/${token}`;
}

// KUNDEPORTAL 2.0 — ét PERMANENT link pr. kunde (i modsætning til linket ovenfor,
// som kun dækker én booking). Kunden identificeres ved job_name, præcis som
// Kundehistorik og kundesøgning allerede gør — der findes ikke en selvstændig
// "kunde"-tabel i dag. Linket oprettes automatisk første gang det bliver brugt
// (enten når admin trykker "Hent kundeportal-link", eller stille i baggrunden når
// en planlægnings-/påmindelsesbesked sendes) og er derefter det SAMME for alle
// kundens fremtidige opgaver — admin skal ikke længere selv hente et nyt link
// hver gang der bookes noget nyt.
async function getOrCreateCustomerPortalToken(jobName) {
  const key = String(jobName || '').trim().toLowerCase();
  if (!key) return null;
  const existing = await pgOne('SELECT token FROM customer_portal_tokens WHERE customer_key=$1', [key]);
  if (existing) return existing.token;
  const token = crypto.randomBytes(20).toString('hex');
  try {
    await pool.query(
      'INSERT INTO customer_portal_tokens (customer_key,job_name,token) VALUES ($1,$2,$3) ON CONFLICT (customer_key) DO NOTHING',
      [key, String(jobName).trim(), token]
    );
  } catch (e) { console.error('Kunne ikke oprette kundeportal-token:', e.message); }
  // Læs tilbage i stedet for blot at antage vores eget token vandt — hvis to kald
  // ramte samtidig (usandsynligt, men billigt at være sikker), skal begge ende med
  // det SAMME link, ikke to forskellige.
  const row = await pgOne('SELECT token FROM customer_portal_tokens WHERE customer_key=$1', [key]);
  return row ? row.token : token;
}
function customerPortalLinkFor(token) {
  return `${PUBLIC_APP_URL}/kunde/${token}`;
}
app.get('/api/customers/portal-link', auth, adminOnly, asyncRoute(async (req, res) => {
  const name = String(req.query.name || '').trim();
  if (!name) return res.status(400).json({ error: 'Mangler kundenavn' });
  const token = await getOrCreateCustomerPortalToken(name);
  if (!token) return res.status(400).json({ error: 'Kunne ikke oprette link' });
  res.json({ ok: true, url: customerPortalLinkFor(token) });
}));

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
  // Sender nu det PERMANENTE kundeportal-link (dækker alle kundens opgaver,
  // pipeline + timeline) i stedet for det gamle link der kun viste denne ene
  // booking — kunden får dermed automatisk sin faste side, uden admin skal gøre
  // noget særligt, første gang der overhovedet sendes en mail til dem.
  const portalToken = task?.job_name ? await getOrCreateCustomerPortalToken(task.job_name) : null;
  const portalLink = portalToken ? customerPortalLinkFor(portalToken) : '';
  const vars = {
    kunde: task?.job_name || '', opgave: task?.name || '', fag: tradeLabel,
    dato: dateLabel, tidspunkt: booking.start_time || '', medarbejder: userName,
    adresse: task?.job_address || '', firma: companyName, link: portalLink
  };
  let subject, text;
  if (templateId) {
    const tpl = await pgOne('SELECT * FROM email_templates WHERE id=$1', [templateId]);
    if (!tpl) return { sent: false, reason: 'Mail-skabelonen blev ikke fundet' };
    subject = fillEmailVars(tpl.subject, vars);
    text = fillEmailVars(tpl.body, vars);
  } else {
    subject = `Din opgave er planlagt til ${dateLabel} — ${companyName}`;
    text = `Hej,\n\nVi har planlagt din opgave (${task?.job_name || ''}) til ${dateLabel}${booking.start_time ? ' kl. ' + booking.start_time : ''}.\n\nVi giver besked igen dagen før vi kommer, og når vi er færdige.` +
      (portalLink ? `\n\nDu kan altid se status på din opgave her: ${portalLink}` : '') +
      `\n\nVenlig hilsen\n${companyName}`;
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

// Henter (og opretter ved behov) det offentlige kundelink for én booking, til
// "🔗 Hent kunde-status-link"-knappen i booking-popup'en — uafhængigt af om der
// nogensinde sendes en mail, så du fx også kan sende linket manuelt via SMS.
app.get('/api/assignments/:id/portal-link', auth, adminOnly, asyncRoute(async (req, res) => {
  const current = await pgOne('SELECT id FROM planning_bookings WHERE id=$1', [req.params.id]);
  if (!current) return res.status(404).json({ error: 'Bookingen blev ikke fundet' });
  const token = await getOrCreateBookingToken(current.id);
  res.json({ ok: true, url: portalLinkFor(token) });
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
    const portalToken = b.job_name ? await getOrCreateCustomerPortalToken(b.job_name) : null;
    const portalLink = portalToken ? customerPortalLinkFor(portalToken) : '';
    const subject = `Vi kommer i morgen — ${companyName}`;
    const text = `Hej,\n\nVi vil bare give dig besked om, at vi kommer i morgen${b.start_time ? ' kl. ' + b.start_time : ''} og udfører (${b.job_name}).` +
      (portalLink ? `\n\nDu kan altid se status på din opgave her: ${portalLink}` : '') +
      `\n\nVenlig hilsen\n${companyName}`;
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

// "Din montør kommer i morgen"-SMS — samme kandidat-logik som mail-påmindelsen
// ovenfor (én pr. opgave, kun i morgens bookinger, kun daglige bookinger — ikke
// kapacitetsblokke), men kræver customer_phone i stedet for customer_email, og
// har sit eget "allerede sendt"-flag (sms_reminder_sent_at) så de to kanaler ikke
// blokerer hinanden — en kunde med både e-mail og telefon skal gerne have begge.
async function sendReminderSms() {
  if (!smsIsConfigured()) return { sent: 0, reason: 'SMS er ikke konfigureret på serveren (GATEWAYAPI_API_TOKEN/TWILIO_*)' };
  const tomorrow = new Date(); tomorrow.setDate(tomorrow.getDate() + 1);
  const iso = tomorrow.toISOString().slice(0, 10);
  const rows = await pool.query(`
    SELECT DISTINCT ON (b.task_id) b.*, t.job_name, t.customer_phone, u.name AS user_name
    FROM planning_bookings b
    JOIN jt_tasks t ON b.task_id=t.id
    LEFT JOIN users u ON b.user_id=u.id
    WHERE b.start_date=$1 AND COALESCE(b.planning_mode,'daily')='daily' AND b.sms_reminder_sent_at IS NULL AND t.customer_phone IS NOT NULL AND trim(t.customer_phone)<>''
    ORDER BY b.task_id, b.id ASC
  `, [iso]);
  const settingsRows = await pool.query("SELECT key,value FROM app_settings WHERE key='company_name'");
  const companyName = settingsRows.rows[0]?.value || 'Gulv Master Enterprise';
  let sentCount = 0;
  for (const b of rows.rows) {
    const portalToken = b.job_name ? await getOrCreateCustomerPortalToken(b.job_name) : null;
    const portalLink = portalToken ? customerPortalLinkFor(portalToken) : '';
    const montorLine = b.user_name ? `Din montør ${b.user_name} kommer` : 'Vi kommer';
    const message = `${companyName}: ${montorLine} i morgen${b.start_time ? ' kl. ' + b.start_time : ''} og udfører "${b.job_name}".${portalLink ? ' Status: ' + portalLink : ''}`;
    let status = 'sent', error = null;
    try { await sendSmsUniversal({ to: b.customer_phone, message }); sentCount++; }
    catch (e) { status = 'error'; error = redactSecret(e.message || '').slice(0, 500); }
    await pool.query('INSERT INTO customer_schedule_sms (booking_id,task_id,kind,to_phone,status,error) VALUES ($1,$2,$3,$4,$5,$6)', [b.id, b.task_id, 'reminder', b.customer_phone, status, error]);
    await pool.query(`UPDATE planning_bookings SET sms_reminder_sent_at=${nowTextSQL()} WHERE task_id=$1 AND start_date=$2`, [b.task_id, iso]);
  }
  return { sent: sentCount, candidates: rows.rows.length };
}

// Manuel udløser — admin trykker selv når de vil sende "vi kommer i morgen" til alle
// kunder der er booket i morgen og ikke allerede har fået den. Ingen automatisk cron.
// Sender BÅDE mail og SMS i samme kald (hver kanal er selvstændigt fejlsikret —
// mangler SMS-opsætning, sendes mailen stadig, og omvendt).
app.post('/api/customer-emails/send-reminders', auth, adminOnly, asyncRoute(async (req, res) => {
  const emailResult = await sendReminderEmails();
  let smsResult = { sent: 0, reason: 'SMS er ikke konfigureret på serveren (GATEWAYAPI_API_TOKEN/TWILIO_*)' };
  try { smsResult = await sendReminderSms(); } catch (e) { smsResult = { sent: 0, reason: e.message }; }
  res.json({ ok: true, ...emailResult, sms_sent: smsResult.sent, sms_candidates: smsResult.candidates || 0, sms_reason: smsResult.reason || null });
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
  let subject, html, text;
  const templateId = await getAssignedTemplateId('dunning');
  const tpl = templateId ? await pgOne('SELECT * FROM document_email_templates WHERE id=$1', [templateId]) : null;
  if (tpl) {
    // Rykkere har ikke et rigtigt tilbuds-/fakturanummer i JobTread-modellen — {{dokument_nr}}
    // fyldes derfor med sagsnavnet, og {{restbeloeb}} med beløbet inkl. rykkergebyret.
    const vars = {
      kunde: inv.fullName || inv.customer || '', dokument_nr: inv.jobNumber || inv.fullName || '', total: krFmtServer(owed),
      gyldig_til: '', forfald: '', restbeloeb: krFmtServer(totalWithFee), firma: companyName, link: '', underskriv_link: ''
    };
    subject = fillDocEmailVars(tpl.subject, vars);
    html = fillDocEmailVars(tpl.body_html, vars);
    text = stripHtmlToText(html);
  } else {
    subject = `Rykker ${targetLevel} — ${inv.fullName} — ${companyName}`;
    text = `Hej,\n\nVi kan se at ${inv.fullName} på ${Math.round(owed).toLocaleString('da-DK')} kr. stadig ikke er betalt.\n\n` +
      `Dette er rykker ${targetLevel}. Der er tillagt et rykkergebyr på ${Math.round(settings.fee_amount).toLocaleString('da-DK')} kr.\n\n` +
      `Nyt beløb i alt: ${Math.round(totalWithFee).toLocaleString('da-DK')} kr.\n\nBetal venligst hurtigst muligt.\n\nVenlig hilsen\n${companyName}`;
    html = text.split('\n').map(l => l ? `<p>${l.replace(/</g, '&lt;')}</p>` : '<br>').join('');
  }
  let status = 'sent', error = null;
  try {
    await sendMailUniversal({ to: toEmail, subject, text, html });
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

// ── PROFIT-ANALYSE — månedligt snapshot til bunden af Oversigt-dashboardet ──
// Samler fire tal for indeværende måned: udgifter, cash i banken (seneste snapshot),
// fakturaer der REELT er sendt denne måned (rigtige JobTread-fakturaer), og fakturaer
// der ifølge Omsætning pr. fag-pipelinen STADIG mangler at blive sendt denne måned
// (sager med et godkendt tilbud/budget, men endnu ingen godkendt faktura). Bundlinje
// = (sendt + mangler at sende) − udgifter, altså den fulde forventede måned, ikke kun
// det der allerede er faktureret.
async function computeMonthlyProfitSnapshot() {
  const monthKey = new Date().toISOString().slice(0, 7);

  const expRow = await pgOne('SELECT COALESCE(SUM(amount),0)::float AS total FROM finance_expenses WHERE month_key=$1', [monthKey]);
  const expenses = expRow ? expRow.total : 0;

  const bankSnap = await pgOne('SELECT * FROM finance_bank_snapshots ORDER BY snap_date DESC LIMIT 1');
  const bankCash = bankSnap ? (Number(bankSnap.hovedkonto) || 0) + (Number(bankSnap.moms) || 0) + (Number(bankSnap.forbrug) || 0) : null;

  const invoices = await fetchFinanceInvoices();
  const invoicesSent = invoices
    .filter(i => i.createdAt && i.createdAt.slice(0, 7) === monthKey)
    .reduce((s, i) => s + (i.priceWithTax || 0), 0);

  const revenue = await fetchFinanceJobsByMonth(0, 0);
  const monthJobs = (revenue[monthKey] && revenue[monthKey].jobs) || [];
  const invoicesPending = monthJobs
    .filter(j => j.valueSource !== 'invoice')
    .reduce((s, j) => s + (j.value || 0), 0);

  const bottomLine = (invoicesSent + invoicesPending) - expenses;

  return { monthKey, expenses, bankCash, invoicesSent, invoicesPending, bottomLine };
}
async function saveMonthlyProfitSnapshot() {
  const snap = await computeMonthlyProfitSnapshot();
  const today = new Date().toISOString().slice(0, 10);
  await pool.query(`
    INSERT INTO profit_snapshots (month_key,snap_date,expenses,bank_cash,invoices_sent,invoices_pending,bottom_line,updated_at)
    VALUES ($1,$2,$3,$4,$5,$6,$7,${nowTextSQL()})
    ON CONFLICT (month_key) DO UPDATE SET snap_date=$2,expenses=$3,bank_cash=$4,invoices_sent=$5,invoices_pending=$6,bottom_line=$7,updated_at=${nowTextSQL()}
  `, [snap.monthKey, today, snap.expenses, snap.bankCash, snap.invoicesSent, snap.invoicesPending, snap.bottomLine]);
  return snap;
}
app.get('/api/finance/profit-snapshots', auth, financeOnly, asyncRoute(async (req, res) => {
  const rows = await pool.query('SELECT * FROM profit_snapshots ORDER BY month_key ASC');
  res.json(rows.rows);
}));
// Manuel "Gem nu"-knap — bruges også automatisk af den månedlige cron nedenfor d. 15.
// Idempotent: kører man den flere gange samme måned, opdateres blot samme række.
app.post('/api/finance/profit-snapshots/save-now', auth, financeOnly, asyncRoute(async (req, res) => {
  const snap = await saveMonthlyProfitSnapshot();
  res.json({ ok: true, snapshot: snap });
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

// ══════════════════════════════════════════════════════════════
// TILBUD & FAKTURA — eget produktkatalog + tilbud/faktura-system med
// delbetalinger, adskilt fra JobTread's egne dokumenter (se financeOnly
// ovenfor). Kun for brugere med is_finance_admin=1, ligesom resten af Økonomi.
// ══════════════════════════════════════════════════════════════
// ── AKTIVITETS-TIDSLINJE — logger aldrig fejl videre til kalderen: en fejlet
// log-indsættelse må ikke vælte selve tilbuds/faktura-handlingen. 'viewed' er
// throttlet til højst ét hak pr. minut pr. dokument, så en kunde der genindlæser
// siden nogle gange ikke oversvømmer tidslinjen med identiske rækker.
async function logDocActivity(docType, docId, eventType, actor, detail) {
  try {
    if (eventType === 'viewed') {
      const recent = await pgOne(
        `SELECT id FROM document_activity WHERE doc_type=$1 AND doc_id=$2 AND event_type='viewed' AND created_at > ((CURRENT_TIMESTAMP AT TIME ZONE 'UTC') - interval '60 seconds')::text ORDER BY id DESC LIMIT 1`,
        [docType, docId]
      ).catch(() => null);
      if (recent) return;
    }
    await pool.query(
      'INSERT INTO document_activity (doc_type,doc_id,event_type,actor,detail) VALUES ($1,$2,$3,$4,$5)',
      [docType, docId, eventType, actor || null, detail || null]
    );
  } catch (e) { /* tidslinjen er et nice-to-have — fejler den, må hoved-handlingen ikke fejle med */ }
}
app.get('/api/quotes/:id/activity', auth, financeOnly, asyncRoute(async (req, res) => {
  const rows = await pool.query('SELECT * FROM document_activity WHERE doc_type=$1 AND doc_id=$2 ORDER BY id DESC', ['quote', req.params.id]);
  res.json(rows.rows);
}));
app.get('/api/invoices/:id/activity', auth, financeOnly, asyncRoute(async (req, res) => {
  const rows = await pool.query('SELECT * FROM document_activity WHERE doc_type=$1 AND doc_id=$2 ORDER BY id DESC', ['invoice', req.params.id]);
  res.json(rows.rows);
}));

async function nextDocNumber(kind, prefix) {
  const year = new Date().getFullYear();
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const row = await client.query('SELECT seq FROM doc_counters WHERE kind=$1 AND year=$2 FOR UPDATE', [kind, year]);
    const seq = (row.rows[0]?.seq || 0) + 1;
    await client.query(`
      INSERT INTO doc_counters (kind, year, seq) VALUES ($1,$2,$3)
      ON CONFLICT (kind, year) DO UPDATE SET seq=$3
    `, [kind, year, seq]);
    await client.query('COMMIT');
    return `${prefix}-${year}-${String(seq).padStart(4, '0')}`;
  } catch (error) {
    await client.query('ROLLBACK').catch(() => {});
    throw error;
  } finally {
    client.release();
  }
}

// rawSubtotal = sum efter evt. rabat PR. LINJE, men før rabat på hele dokumentet.
// subtotal (det der gemmes i DB, og vises som "Subtotal" på PDF'en) = efter BEGGE rabatter, før moms.
//
// Rabat-type (Martin ønsker rabat enten som % eller som et fast kronebeløb, både
// pr. linje og for hele tilbuddet): for at undgå en migrering af eksisterende
// data genbruges den eksisterende discount_pct-kolonne til at holde VÆRDIEN
// uanset type (enten en procentsats 0-100, eller et rent kronebeløb), og en ny
// sideløbende discount_type-kolonne ('pct'|'fixed') styrer fortolkningen.
// Rækker/dokumenter uden discount_type (fx eksisterende tilbud fra før denne
// funktion, eller fakturaer — som slet ikke har fået denne udvidelse) falder
// automatisk tilbage til 'pct', så al tidligere opførsel er uændret.
function lineDiscountAmount(l, gross) {
  const type = l && l.discount_type === 'fixed' ? 'fixed' : 'pct';
  const val = Number(l && l.discount_pct) || 0;
  if (type === 'fixed') return Math.max(0, Math.min(val, gross));
  return gross * Math.max(0, Math.min(val, 100)) / 100;
}
// equivalentLinePct: bruges når en linje med fast kronerabat skal repræsenteres
// et sted der kun forstår procent-rabat (pt. kun ved konvertering til faktura).
function equivalentLinePct(l) {
  if (!l || l.discount_type !== 'fixed') return Number(l && l.discount_pct) || 0;
  const gross = (Number(l.quantity) || 0) * (Number(l.sell_price) || 0);
  if (gross <= 0) return 0;
  return lineDiscountAmount(l, gross) / gross * 100;
}
function computeTotals(lines, taxRate, discount) {
  // discount kan enten være et rent tal (bagudkompatibelt — tolkes som %), eller
  // et objekt {value,type} hvor type er 'pct' eller 'fixed'.
  let dValue, dType;
  if (discount && typeof discount === 'object') {
    dValue = Number(discount.value) || 0;
    dType = discount.type === 'fixed' ? 'fixed' : 'pct';
  } else {
    dValue = Number(discount) || 0;
    dType = 'pct';
  }
  let rawSubtotal = 0, costTotal = 0;
  for (const l of (lines || [])) {
    const qty = Number(l.quantity) || 0, sell = Number(l.sell_price) || 0, cost = Number(l.cost_price) || 0;
    const gross = qty * sell;
    rawSubtotal += gross - lineDiscountAmount(l, gross);
    costTotal += qty * cost;
  }
  const discountAmount = dType === 'fixed'
    ? Math.max(0, Math.min(dValue, rawSubtotal))
    : rawSubtotal * Math.max(0, Math.min(dValue, 100)) / 100;
  const subtotal = rawSubtotal - discountAmount;
  const taxAmount = subtotal * (Number(taxRate) || 0) / 100;
  return { subtotal, rawSubtotal, discountAmount, taxAmount, total: subtotal + taxAmount, costTotal };
}

async function getCompanyInfo() {
  const rows = await pool.query(`
    SELECT key,value FROM app_settings WHERE key IN
    ('company_name','logo_url','company_address','company_cvr','company_phone','company_email','company_bank_reg','company_bank_account','invoice_footer_note','default_tax_rate')
  `);
  const map = {};
  rows.rows.forEach(r => { map[r.key] = r.value; });
  return {
    name: map.company_name || 'Gulv Master Enterprise ApS',
    logoUrl: map.logo_url || null,
    address: map.company_address || '',
    cvr: map.company_cvr || '',
    phone: map.company_phone || '',
    email: map.company_email || '',
    bankReg: map.company_bank_reg || '',
    bankAccount: map.company_bank_account || '',
    footerNote: map.invoice_footer_note || '',
    defaultTaxRate: Number(map.default_tax_rate) || 25
  };
}

// ── BILLED-UPLOAD (Cloudinary) — bruges af tidsregistrering, kvalitetssikring
// og projekt-billeder. Render har ikke permanent fil-lager, så billeder kan
// IKKE bare gemmes lokalt på serveren — de forsvinder ved næste deploy. ────
function cloudinaryConfigured() {
  return !!(process.env.CLOUDINARY_CLOUD_NAME && process.env.CLOUDINARY_API_KEY && process.env.CLOUDINARY_API_SECRET);
}
async function uploadPhotoToCloudinary(dataUri, folder) {
  if (!cloudinaryConfigured()) throw new Error('Cloudinary er ikke konfigureret på serveren');
  const cloudName = process.env.CLOUDINARY_CLOUD_NAME;
  const apiKey = process.env.CLOUDINARY_API_KEY;
  const apiSecret = process.env.CLOUDINARY_API_SECRET;
  const timestamp = Math.floor(Date.now() / 1000);
  const params = { timestamp, folder: folder || 'gulvmaster' };
  const toSign = Object.keys(params).sort().map(k => `${k}=${params[k]}`).join('&');
  const signature = crypto.createHash('sha1').update(toSign + apiSecret).digest('hex');
  const form = new URLSearchParams();
  form.set('file', dataUri);
  form.set('api_key', apiKey);
  form.set('timestamp', String(timestamp));
  form.set('signature', signature);
  form.set('folder', params.folder);
  const resp = await fetch(`https://api.cloudinary.com/v1_1/${cloudName}/image/upload`, { method: 'POST', body: form });
  const data = await resp.json().catch(() => ({}));
  if (!resp.ok) throw new Error((data.error && data.error.message) || 'Cloudinary-upload fejlede');
  return data.secure_url;
}
app.post('/api/photos/upload', auth, asyncRoute(async (req, res) => {
  const b = req.body || {};
  if (!b.image) return res.status(400).json({ error: 'Intet billede modtaget' });
  if (!cloudinaryConfigured()) return res.status(400).json({ error: 'Billedlager er ikke konfigureret på serveren endnu — kontakt admin' });
  try {
    const url = await uploadPhotoToCloudinary(b.image, b.folder);
    res.json({ ok: true, url });
  } catch (e) {
    res.status(400).json({ error: 'Kunne ikke uploade billedet: ' + e.message });
  }
}));

// ── PRODUKTER ────────────────────────────────────────────────
app.get('/api/products', auth, financeOnly, asyncRoute(async (req, res) => {
  const rows = await pool.query('SELECT * FROM products WHERE active=1 ORDER BY category NULLS LAST, name');
  res.json(rows.rows);
}));

app.post('/api/products', auth, financeOnly, asyncRoute(async (req, res) => {
  const b = req.body || {};
  if (!b.name) return res.status(400).json({ error: 'Navn mangler' });
  const r = await pool.query(`
    INSERT INTO products (name,description,sku,unit,cost_price,sell_price,category,product_type)
    VALUES ($1,$2,$3,$4,$5,$6,$7,$8) RETURNING id
  `, [String(b.name).trim(), b.description || null, b.sku || null, b.unit || 'stk', Number(b.cost_price) || 0, Number(b.sell_price) || 0, b.category || null, b.product_type === 'materialer' ? 'materialer' : 'service']);
  res.json({ ok: true, id: r.rows[0].id });
}));

app.put('/api/products/:id', auth, financeOnly, asyncRoute(async (req, res) => {
  const b = req.body || {};
  const current = await pgOne('SELECT * FROM products WHERE id=$1', [req.params.id]);
  if (!current) return res.status(404).json({ error: 'Produktet blev ikke fundet' });
  await pool.query(`
    UPDATE products SET name=$1,description=$2,sku=$3,unit=$4,cost_price=$5,sell_price=$6,category=$7,product_type=$8,updated_at=${nowTextSQL()}
    WHERE id=$9
  `, [
    b.name !== undefined ? String(b.name).trim() : current.name,
    b.description !== undefined ? b.description : current.description,
    b.sku !== undefined ? b.sku : current.sku,
    b.unit !== undefined ? b.unit : current.unit,
    b.cost_price !== undefined ? Number(b.cost_price) || 0 : current.cost_price,
    b.sell_price !== undefined ? Number(b.sell_price) || 0 : current.sell_price,
    b.category !== undefined ? b.category : current.category,
    b.product_type !== undefined ? (b.product_type === 'materialer' ? 'materialer' : 'service') : current.product_type,
    req.params.id
  ]);
  res.json({ ok: true });
}));

app.delete('/api/products/:id', auth, financeOnly, asyncRoute(async (req, res) => {
  // Slet ikke rigtigt — historiske tilbud/fakturaer refererer stadig til product_id,
  // og skal blive ved med at vise korrekt selv efter produktet er "slettet".
  await pool.query('UPDATE products SET active=0 WHERE id=$1', [req.params.id]);
  res.json({ ok: true });
}));

// Engangs-import fra JobTread's costItems — bevidst IKKE en løbende synkronisering
// (se svar i chatten): henter alt organisationen har brugt af cost items på tværs af
// jobs, og lægger de unikke navne ind som et udgangspunkt for jeres eget katalog.
// Køres kun når admin selv trykker på knappen, aldrig automatisk.
app.post('/api/products/import-from-jobtread', auth, financeOnly, asyncRoute(async (req, res) => {
  if (!JT_ORG || !JT_GRANT) return res.status(400).json({ error: 'JobTread er ikke sat op på serveren' });
  // JobTread har ikke en selvstændig "produktkatalog"-type — cost items på tværs
  // af alle jobs bruges i stedet, hvor en cost item enten ER en genbrugelig skabelon
  // (organizationCostItem er tom, og den har sin egen unitCost/unitPrice), eller er
  // en KOPI af én, brugt på et konkret job (organizationCostItem peger på skabelonen,
  // og har typisk ikke sin egen pris). Vi importerer kun items med reelle pris-data,
  // dedupliceret på navn — kopier uden egen pris springes over, da skabelonen med
  // samme navn allerede giver den rigtige cost/salgspris.
  const seen = new Map(); // navn (lowercase) -> {name,unit,cost,price,jtId,isTemplate}
  let page = null;
  let guard = 0;
  try {
    do {
      guard++;
      const data = await jtFetch({
        query: { $: { grantKey: JT_GRANT }, organization: { $: { id: JT_ORG }, costItems: {
          $: { size: 100, page: page || undefined },
          nextPage: {},
          nodes: { id: {}, name: {}, unit: { name: {} }, unitCost: {}, unitPrice: {}, organizationCostItem: { id: {} } }
        } } }
      }, 'Produktimport: hent cost items fra JobTread');
      const conn = data?.organization?.costItems;
      for (const n of conn?.nodes || []) {
        if (!n.name) continue;
        if (n.unitCost == null && n.unitPrice == null) continue; // job-kopi uden egen pris — spring over
        const key = n.name.toLowerCase().trim();
        const isTemplate = !n.organizationCostItem;
        const existing = seen.get(key);
        if (!existing || (isTemplate && !existing.isTemplate)) {
          seen.set(key, { name: n.name, unit: n.unit?.name || 'stk', cost: Number(n.unitCost) || 0, price: Number(n.unitPrice) || 0, jtId: n.id, isTemplate });
        }
      }
      page = conn?.nextPage || null;
    } while (page && guard < 200);
  } catch (error) {
    return res.status(400).json({ error: 'Kunne ikke hente fra JobTread: ' + error.message });
  }
  let imported = 0, skipped = 0;
  for (const item of seen.values()) {
    const existing = item.jtId
      ? await pgOne('SELECT id FROM products WHERE jt_cost_item_id=$1', [item.jtId])
      : await pgOne('SELECT id FROM products WHERE lower(trim(name))=lower(trim($1)) AND jt_cost_item_id IS NULL', [item.name]);
    if (existing) { skipped++; continue; }
    await pool.query(`
      INSERT INTO products (name,unit,cost_price,sell_price,jt_cost_item_id) VALUES ($1,$2,$3,$4,$5)
    `, [item.name, item.unit, item.cost, item.price, item.jtId]);
    imported++;
  }
  res.json({ ok: true, imported, skipped, total_found: seen.size });
}));

// ── TILBUDSSKABELONER — gemte linjesæt til hurtigt at starte et nyt tilbud fra ──
app.get('/api/quote-templates', auth, financeOnly, asyncRoute(async (req, res) => {
  const rows = await pool.query('SELECT * FROM quote_templates ORDER BY name ASC');
  res.json(rows.rows);
}));

app.post('/api/quote-templates', auth, financeOnly, asyncRoute(async (req, res) => {
  const b = req.body || {};
  if (!b.name) return res.status(400).json({ error: 'Navn mangler' });
  const r = await pool.query(`
    INSERT INTO quote_templates (name,description,lines) VALUES ($1,$2,$3) RETURNING id
  `, [String(b.name).trim(), b.description || null, JSON.stringify(b.lines || [])]);
  res.json({ ok: true, id: r.rows[0].id });
}));

app.put('/api/quote-templates/:id', auth, financeOnly, asyncRoute(async (req, res) => {
  const current = await pgOne('SELECT * FROM quote_templates WHERE id=$1', [req.params.id]);
  if (!current) return res.status(404).json({ error: 'Skabelonen blev ikke fundet' });
  const b = req.body || {};
  await pool.query(`
    UPDATE quote_templates SET name=$1,description=$2,lines=$3,updated_at=${nowTextSQL()} WHERE id=$4
  `, [
    b.name !== undefined ? String(b.name).trim() : current.name,
    b.description !== undefined ? b.description : current.description,
    b.lines !== undefined ? JSON.stringify(b.lines) : JSON.stringify(current.lines),
    req.params.id
  ]);
  res.json({ ok: true });
}));

app.delete('/api/quote-templates/:id', auth, financeOnly, asyncRoute(async (req, res) => {
  await pool.query('DELETE FROM quote_templates WHERE id=$1', [req.params.id]);
  res.json({ ok: true });
}));

// ── TILBUD ───────────────────────────────────────────────────
async function loadQuoteFull(id) {
  const quote = await pgOne('SELECT * FROM quotes WHERE id=$1', [id]);
  if (!quote) return null;
  const lines = await pool.query('SELECT * FROM quote_lines WHERE quote_id=$1 ORDER BY position ASC, id ASC', [id]);
  return { ...quote, lines: lines.rows };
}

app.get('/api/quotes', auth, financeOnly, asyncRoute(async (req, res) => {
  const rows = await pool.query('SELECT * FROM quotes ORDER BY created_at DESC, id DESC');
  res.json(rows.rows);
}));

app.get('/api/quotes/:id', auth, financeOnly, asyncRoute(async (req, res) => {
  const quote = await loadQuoteFull(req.params.id);
  if (!quote) return res.status(404).json({ error: 'Tilbuddet blev ikke fundet' });
  res.json(quote);
}));

async function saveQuoteLines(quoteId, lines) {
  await pool.query('DELETE FROM quote_lines WHERE quote_id=$1', [quoteId]);
  let pos = 0;
  for (const l of (lines || [])) {
    if (!l.description) continue;
    await pool.query(`
      INSERT INTO quote_lines (quote_id,product_id,description,unit,quantity,cost_price,sell_price,position,product_type,discount_pct,discount_type)
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)
    `, [quoteId, l.product_id || null, String(l.description).trim(), l.unit || 'stk', Number(l.quantity) || 1, Number(l.cost_price) || 0, Number(l.sell_price) || 0, pos++, l.product_type === 'materialer' ? 'materialer' : 'service', Number(l.discount_pct) || 0, l.discount_type === 'fixed' ? 'fixed' : 'pct']);
  }
}

app.post('/api/quotes', auth, financeOnly, asyncRoute(async (req, res) => {
  const b = req.body || {};
  const company = await getCompanyInfo();
  const taxRate = b.tax_rate !== undefined ? Number(b.tax_rate) : company.defaultTaxRate;
  const discountPct = Number(b.discount_pct) || 0;
  const discountType = b.discount_type === 'fixed' ? 'fixed' : 'pct';
  const totals = computeTotals(b.lines || [], taxRate, { value: discountPct, type: discountType });
  const quoteNumber = await nextDocNumber('quote', 'TIL');
  const acceptToken = crypto.randomBytes(20).toString('hex');
  const r = await pool.query(`
    INSERT INTO quotes (quote_number,job_name,job_id,customer_id,customer_address,customer_phone,customer_email,status,subtotal,tax_rate,tax_amount,total,notes,internal_note,valid_until,created_by,discount_pct,discount_type,accept_token)
    VALUES ($1,$2,$3,$4,$5,$6,$7,'draft',$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18) RETURNING id
  `, [quoteNumber, b.job_name || null, b.job_id || null, b.customer_id || null, b.customer_address || null, b.customer_phone || null, b.customer_email || null, totals.subtotal, taxRate, totals.taxAmount, totals.total, b.notes || null, b.internal_note || null, b.valid_until || null, req.user.id, discountPct, discountType, acceptToken]);
  await saveQuoteLines(r.rows[0].id, b.lines);
  logDocActivity('quote', r.rows[0].id, 'created', req.user.name, null);
  res.json({ ok: true, id: r.rows[0].id, quote_number: quoteNumber });
}));

app.put('/api/quotes/:id', auth, financeOnly, asyncRoute(async (req, res) => {
  const current = await pgOne('SELECT * FROM quotes WHERE id=$1', [req.params.id]);
  if (!current) return res.status(404).json({ error: 'Tilbuddet blev ikke fundet' });
  const b = req.body || {};
  const taxRate = b.tax_rate !== undefined ? Number(b.tax_rate) : current.tax_rate;
  const discountPct = b.discount_pct !== undefined ? Number(b.discount_pct) || 0 : Number(current.discount_pct) || 0;
  const discountType = b.discount_type !== undefined ? (b.discount_type === 'fixed' ? 'fixed' : 'pct') : (current.discount_type === 'fixed' ? 'fixed' : 'pct');
  const totals = computeTotals(b.lines !== undefined ? b.lines : await pool.query('SELECT * FROM quote_lines WHERE quote_id=$1', [req.params.id]).then(r => r.rows), taxRate, { value: discountPct, type: discountType });
  await pool.query(`
    UPDATE quotes SET job_name=$1,job_id=$2,customer_id=$3,customer_address=$4,customer_phone=$5,customer_email=$6,subtotal=$7,tax_rate=$8,tax_amount=$9,total=$10,notes=$11,internal_note=$12,valid_until=$13,discount_pct=$14,discount_type=$15,updated_at=${nowTextSQL()}
    WHERE id=$16
  `, [
    b.job_name !== undefined ? b.job_name : current.job_name,
    b.job_id !== undefined ? b.job_id : current.job_id,
    b.customer_id !== undefined ? b.customer_id : current.customer_id,
    b.customer_address !== undefined ? b.customer_address : current.customer_address,
    b.customer_phone !== undefined ? b.customer_phone : current.customer_phone,
    b.customer_email !== undefined ? b.customer_email : current.customer_email,
    totals.subtotal, taxRate, totals.taxAmount, totals.total,
    b.notes !== undefined ? b.notes : current.notes,
    b.internal_note !== undefined ? b.internal_note : current.internal_note,
    b.valid_until !== undefined ? b.valid_until : current.valid_until,
    discountPct,
    discountType,
    req.params.id
  ]);
  if (b.lines !== undefined) await saveQuoteLines(req.params.id, b.lines);
  logDocActivity('quote', req.params.id, 'edited', req.user.name, null);
  res.json({ ok: true });
}));

app.put('/api/quotes/:id/status', auth, financeOnly, asyncRoute(async (req, res) => {
  const status = String((req.body || {}).status || '');
  if (!['draft', 'sent', 'accepted', 'declined'].includes(status)) return res.status(400).json({ error: 'Ugyldig status' });
  const r = await pool.query(`UPDATE quotes SET status=$1, updated_at=${nowTextSQL()} WHERE id=$2 AND status <> 'converted'`, [status, req.params.id]);
  if (!r.rowCount) return res.status(400).json({ error: 'Tilbuddet findes ikke, eller er allerede konverteret til en faktura' });
  logDocActivity('quote', req.params.id, 'status_changed', req.user.name, status);
  res.json({ ok: true });
}));

app.delete('/api/quotes/:id', auth, financeOnly, asyncRoute(async (req, res) => {
  const r = await pool.query(`DELETE FROM quotes WHERE id=$1 AND status <> 'converted'`, [req.params.id]);
  if (!r.rowCount) return res.status(400).json({ error: 'Kan ikke slette et tilbud der er konverteret til faktura' });
  res.json({ ok: true });
}));

app.post('/api/quotes/:id/convert-to-invoice', auth, financeOnly, asyncRoute(async (req, res) => {
  const quote = await loadQuoteFull(req.params.id);
  if (!quote) return res.status(404).json({ error: 'Tilbuddet blev ikke fundet' });
  if (quote.status === 'converted') return res.status(400).json({ error: 'Tilbuddet er allerede konverteret' });
  const invoiceNumber = await nextDocNumber('invoice', 'FAK');
  const dueDate = new Date(); dueDate.setDate(dueDate.getDate() + 14);
  // Fakturaer understøtter (endnu) kun rabat i %, så en evt. fast kronerabat fra
  // tilbuddet omregnes her til den procentsats der giver samme kronebeløb. De
  // faktiske beløb (subtotal/moms/total) kopieres uændret fra tilbuddet
  // nedenfor, så fakturaens totaler er korrekte uanset rabat-type — kun
  // rabat-TEKSTEN og linjetotalerne på selve fakturaen regnes om til procent.
  const quoteTotalsForInvoice = computeTotals(quote.lines, quote.tax_rate, { value: Number(quote.discount_pct) || 0, type: quote.discount_type });
  const equivDocDiscountPct = quoteTotalsForInvoice.rawSubtotal > 0
    ? (quoteTotalsForInvoice.discountAmount / quoteTotalsForInvoice.rawSubtotal * 100)
    : 0;
  const r = await pool.query(`
    INSERT INTO invoices (invoice_number,quote_id,job_name,job_id,customer_address,customer_phone,customer_email,status,subtotal,tax_rate,tax_amount,total,notes,due_date,discount_pct)
    VALUES ($1,$2,$3,$4,$5,$6,$7,'unpaid',$8,$9,$10,$11,$12,$13,$14) RETURNING id
  `, [invoiceNumber, quote.id, quote.job_name, quote.job_id, quote.customer_address, quote.customer_phone, quote.customer_email, quote.subtotal, quote.tax_rate, quote.tax_amount, quote.total, quote.notes, dueDate.toISOString().slice(0, 10), equivDocDiscountPct]);
  const invoiceId = r.rows[0].id;
  let pos = 0;
  for (const l of quote.lines) {
    await pool.query(`
      INSERT INTO invoice_lines (invoice_id,product_id,description,unit,quantity,cost_price,sell_price,position,product_type,discount_pct)
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)
    `, [invoiceId, l.product_id, l.description, l.unit, l.quantity, l.cost_price, l.sell_price, pos++, l.product_type || 'service', equivalentLinePct(l)]);
  }
  await pool.query(`UPDATE quotes SET status='converted', converted_invoice_id=$1, updated_at=${nowTextSQL()} WHERE id=$2`, [invoiceId, quote.id]);
  // Sagen (projektet) blev oprettet da kunden underskrev tilbuddet — nu hvor
  // der findes en faktura, kobles den på projektet, så "Tilføj til faktura"
  // fra tidsregistreringer og "Se faktura"-linket i sags-dashboardet virker.
  await pool.query(`UPDATE projects SET invoice_id=$1, updated_at=${nowTextSQL()} WHERE quote_id=$2`, [invoiceId, quote.id]);
  logDocActivity('quote', quote.id, 'converted', req.user.name, invoiceNumber);
  logDocActivity('invoice', invoiceId, 'created', req.user.name, `fra tilbud ${quote.quote_number}`);
  res.json({ ok: true, invoice_id: invoiceId, invoice_number: invoiceNumber });
}));

// ── FAKTURA + DELBETALINGER + KREDITNOTAER ───────────────────
// "Rest" på en faktura = total minus BÅDE betalinger OG kreditnotaer — en
// kreditnota reducerer hvad kunden skylder, ligesom en betaling gør, men vises
// og bogføres adskilt (den er jo ikke penge kunden har betalt).
async function loadInvoiceFull(id) {
  const invoice = await pgOne('SELECT * FROM invoices WHERE id=$1', [id]);
  if (!invoice) return null;
  const lines = await pool.query('SELECT * FROM invoice_lines WHERE invoice_id=$1 ORDER BY position ASC, id ASC', [id]);
  const payments = await pool.query('SELECT * FROM invoice_payments WHERE invoice_id=$1 ORDER BY paid_at ASC, id ASC', [id]);
  const creditNotes = await pool.query('SELECT * FROM credit_notes WHERE invoice_id=$1 ORDER BY created_at ASC, id ASC', [id]);
  const paidTotal = payments.rows.reduce((s, p) => s + Number(p.amount), 0);
  const creditedTotal = creditNotes.rows.reduce((s, c) => s + Number(c.amount), 0);
  return {
    ...invoice, lines: lines.rows, payments: payments.rows, credit_notes: creditNotes.rows,
    paid_total: paidTotal, credited_total: creditedTotal, remaining: Number(invoice.total) - paidTotal - creditedTotal
  };
}
async function refreshInvoiceStatus(invoiceId) {
  const invoice = await pgOne('SELECT total FROM invoices WHERE id=$1', [invoiceId]);
  if (!invoice) return;
  const sum = await pgOne('SELECT COALESCE(SUM(amount),0) AS paid FROM invoice_payments WHERE invoice_id=$1', [invoiceId]);
  const creditSum = await pgOne('SELECT COALESCE(SUM(amount),0) AS credited FROM credit_notes WHERE invoice_id=$1', [invoiceId]);
  const settled = Number(sum.paid) + Number(creditSum.credited);
  const total = Number(invoice.total);
  const status = settled <= 0 ? 'unpaid' : (settled >= total ? 'paid' : 'partial');
  await pool.query(`UPDATE invoices SET status=$1, updated_at=${nowTextSQL()} WHERE id=$2 AND status <> 'void'`, [status, invoiceId]);
}

app.get('/api/invoices', auth, financeOnly, asyncRoute(async (req, res) => {
  const rows = await pool.query(`
    SELECT i.*, COALESCE((SELECT SUM(amount) FROM invoice_payments p WHERE p.invoice_id=i.id),0) AS paid_total,
           COALESCE((SELECT SUM(amount) FROM credit_notes c WHERE c.invoice_id=i.id),0) AS credited_total
    FROM invoices i ORDER BY i.created_at DESC, i.id DESC
  `);
  res.json(rows.rows.map(r => ({ ...r, remaining: Number(r.total) - Number(r.paid_total) - Number(r.credited_total) })));
}));

app.get('/api/invoices/:id', auth, financeOnly, asyncRoute(async (req, res) => {
  const invoice = await loadInvoiceFull(req.params.id);
  if (!invoice) return res.status(404).json({ error: 'Fakturaen blev ikke fundet' });
  res.json(invoice);
}));

app.put('/api/invoices/:id', auth, financeOnly, asyncRoute(async (req, res) => {
  const current = await pgOne('SELECT * FROM invoices WHERE id=$1', [req.params.id]);
  if (!current) return res.status(404).json({ error: 'Fakturaen blev ikke fundet' });
  const b = req.body || {};
  await pool.query(`
    UPDATE invoices SET notes=$1, due_date=$2, customer_address=$3, customer_phone=$4, customer_email=$5, updated_at=${nowTextSQL()}
    WHERE id=$6
  `, [
    b.notes !== undefined ? b.notes : current.notes,
    b.due_date !== undefined ? b.due_date : current.due_date,
    b.customer_address !== undefined ? b.customer_address : current.customer_address,
    b.customer_phone !== undefined ? b.customer_phone : current.customer_phone,
    b.customer_email !== undefined ? b.customer_email : current.customer_email,
    req.params.id
  ]);
  logDocActivity('invoice', req.params.id, 'edited', req.user.name, null);
  res.json({ ok: true });
}));

app.post('/api/invoices/:id/payments', auth, financeOnly, asyncRoute(async (req, res) => {
  const b = req.body || {};
  const amount = Number(b.amount);
  if (!amount || amount <= 0) return res.status(400).json({ error: 'Angiv et gyldigt beløb' });
  const invoice = await pgOne('SELECT id FROM invoices WHERE id=$1', [req.params.id]);
  if (!invoice) return res.status(404).json({ error: 'Fakturaen blev ikke fundet' });
  await pool.query(`
    INSERT INTO invoice_payments (invoice_id,amount,paid_at,method,note) VALUES ($1,$2,$3,$4,$5)
  `, [req.params.id, amount, validDate(b.paid_at) ? b.paid_at : new Date().toISOString().slice(0, 10), b.method || null, b.note || null]);
  await refreshInvoiceStatus(req.params.id);
  logDocActivity('invoice', req.params.id, 'payment_added', req.user.name, krFmtServer(amount));
  res.json({ ok: true });
}));

app.delete('/api/invoices/:id/payments/:paymentId', auth, financeOnly, asyncRoute(async (req, res) => {
  await pool.query('DELETE FROM invoice_payments WHERE id=$1 AND invoice_id=$2', [req.params.paymentId, req.params.id]);
  await refreshInvoiceStatus(req.params.id);
  logDocActivity('invoice', req.params.id, 'payment_removed', req.user.name, null);
  res.json({ ok: true });
}));

app.put('/api/invoices/:id/void', auth, financeOnly, asyncRoute(async (req, res) => {
  await pool.query(`UPDATE invoices SET status='void', updated_at=${nowTextSQL()} WHERE id=$1`, [req.params.id]);
  logDocActivity('invoice', req.params.id, 'void', req.user.name, null);
  res.json({ ok: true });
}));

// ── KREDITNOTAER ──────────────────────────────────────────────
// Selvstændigt nummereret dokument (KN-ÅÅÅÅ-NNNN) knyttet til én faktura, med
// et valgfrit beløb — kan dække hele eller kun en del af fakturaen (fx en
// reklamation over én linje). Beløbet kan ikke overstige det der er tilbage at
// kreditere (total minus allerede krediterede kreditnotaer).
app.get('/api/invoices/:id/credit-notes', auth, financeOnly, asyncRoute(async (req, res) => {
  const rows = await pool.query('SELECT * FROM credit_notes WHERE invoice_id=$1 ORDER BY created_at ASC, id ASC', [req.params.id]);
  res.json(rows.rows);
}));
app.post('/api/invoices/:id/credit-notes', auth, financeOnly, asyncRoute(async (req, res) => {
  const b = req.body || {};
  const amount = Number(b.amount);
  if (!amount || amount <= 0) return res.status(400).json({ error: 'Angiv et gyldigt beløb' });
  const invoice = await pgOne('SELECT * FROM invoices WHERE id=$1', [req.params.id]);
  if (!invoice) return res.status(404).json({ error: 'Fakturaen blev ikke fundet' });
  const existing = await pgOne('SELECT COALESCE(SUM(amount),0) AS credited FROM credit_notes WHERE invoice_id=$1', [req.params.id]);
  const alreadyCredited = Number(existing.credited);
  const maxCreditable = Number(invoice.total) - alreadyCredited;
  if (amount > maxCreditable + 0.001) {
    return res.status(400).json({ error: `Beløbet overstiger hvad der er tilbage at kreditere (maks ${krFmtServer(Math.max(0, maxCreditable))})` });
  }
  const creditNoteNumber = await nextDocNumber('credit_note', 'KN');
  const r = await pool.query(
    'INSERT INTO credit_notes (credit_note_number,invoice_id,amount,reason,created_by) VALUES ($1,$2,$3,$4,$5) RETURNING id',
    [creditNoteNumber, req.params.id, amount, b.reason || null, req.user.id]
  );
  await refreshInvoiceStatus(req.params.id);
  logDocActivity('invoice', req.params.id, 'credit_note_added', req.user.name, `${creditNoteNumber} · ${krFmtServer(amount)}`);
  res.json({ ok: true, id: r.rows[0].id, credit_note_number: creditNoteNumber });
}));
app.delete('/api/credit-notes/:id', auth, financeOnly, asyncRoute(async (req, res) => {
  const cn = await pgOne('SELECT * FROM credit_notes WHERE id=$1', [req.params.id]);
  if (!cn) return res.status(404).json({ error: 'Kreditnotaen blev ikke fundet' });
  await pool.query('DELETE FROM credit_notes WHERE id=$1', [req.params.id]);
  await refreshInvoiceStatus(cn.invoice_id);
  logDocActivity('invoice', cn.invoice_id, 'credit_note_removed', req.user.name, cn.credit_note_number);
  res.json({ ok: true });
}));
app.get('/api/credit-notes/:id/pdf', auth, financeOnly, asyncRoute(async (req, res) => {
  const cn = await pgOne('SELECT * FROM credit_notes WHERE id=$1', [req.params.id]);
  if (!cn) return res.status(404).json({ error: 'Kreditnotaen blev ikke fundet' });
  const invoice = await loadInvoiceFull(cn.invoice_id);
  const company = await getCompanyInfo();
  res.set('Content-Type', 'application/pdf');
  res.set('Content-Disposition', `inline; filename="${cn.credit_note_number}.pdf"`);
  const doc = new PDFDocument({ size: 'A4', margin: 40 });
  doc.pipe(res);
  drawCreditNotePdf(doc, cn, invoice, company);
  doc.end();
}));
app.post('/api/credit-notes/:id/send', auth, financeOnly, asyncRoute(async (req, res) => {
  const cn = await pgOne('SELECT * FROM credit_notes WHERE id=$1', [req.params.id]);
  if (!cn) return res.status(404).json({ error: 'Kreditnotaen blev ikke fundet' });
  const invoice = await loadInvoiceFull(cn.invoice_id);
  if (!invoice) return res.status(404).json({ error: 'Fakturaen blev ikke fundet' });
  const b = req.body || {};
  const to = String(b.to || invoice.customer_email || '').trim();
  if (!to) return res.status(400).json({ error: 'Ingen modtager-mail angivet — udfyld kundens e-mail på fakturaen, eller angiv en her' });
  if (!mailIsConfigured()) return res.status(400).json({ error: 'E-mail er ikke konfigureret på serveren' });
  const company = await getCompanyInfo();
  const portalToken = invoice.job_name ? await getOrCreateCustomerPortalToken(invoice.job_name) : null;
  const portalLink = portalToken ? customerPortalLinkFor(portalToken) : PUBLIC_APP_URL;
  const vars = {
    kunde: invoice.job_name || '', dokument_nr: cn.credit_note_number, total: krFmtServer(cn.amount),
    gyldig_til: '', forfald: '', restbeloeb: krFmtServer(invoice.remaining), firma: company.name,
    link: portalLink, underskriv_link: ''
  };
  let templateId = b.template_id || null;
  if (!templateId) templateId = await getAssignedTemplateId('credit_note');
  let subject, bodyHtml, tpl = null;
  if (templateId) {
    tpl = await pgOne('SELECT * FROM document_email_templates WHERE id=$1', [templateId]);
    if (!tpl && b.template_id) return res.status(404).json({ error: 'Mail-skabelonen blev ikke fundet' });
  }
  if (tpl) {
    subject = fillDocEmailVars(tpl.subject, vars);
    bodyHtml = fillDocEmailVars(tpl.body_html, vars);
  } else {
    subject = `Kreditnota ${cn.credit_note_number} fra ${company.name}`;
    bodyHtml = `<p>Hej ${escPublic(invoice.job_name || '')},</p><p>Vi har udstedt en kreditnota <b>${escPublic(cn.credit_note_number)}</b> på <b>${krFmtServer(cn.amount)}</b> vedr. faktura ${escPublic(invoice.invoice_number)} — vedhæftet som PDF.</p>${cn.reason ? `<p>Begrundelse: ${escPublic(cn.reason)}</p>` : ''}<p>Du kan altid se alle dine tilbud, fakturaer og planlagte opgaver på din side: <a href="${portalLink}">${portalLink}</a></p><p>Mvh<br>${escPublic(company.name)}</p>`;
  }
  let pdfBuffer;
  try { pdfBuffer = await renderCreditNotePdfBuffer(cn, invoice, company); }
  catch (e) { return res.status(500).json({ error: 'Kunne ikke generere PDF: ' + e.message }); }
  try {
    await sendMailUniversal({
      to, subject, html: bodyHtml, text: stripHtmlToText(bodyHtml),
      attachments: [{ filename: cn.credit_note_number + '.pdf', content: pdfBuffer }]
    });
  } catch (e) {
    return res.status(400).json({ error: 'Kunne ikke sende mailen: ' + e.message });
  }
  logDocActivity('invoice', cn.invoice_id, 'credit_note_sent', req.user.name, `${cn.credit_note_number} til ${to}`);
  res.json({ ok: true });
}));

// ── PDF-GENERERING (tilbud + faktura) — pdfkit, ingen headless browser
// nødvendig, så det er hurtigt og virker uden ekstra opsætning på serveren. ──
// Logoet gemmes som en data-URI (base64) i indstillingerne — PDFKit kan tegne
// det direkte fra en Buffer, så vi udpakker base64-delen. Returnerer null hvis
// der ikke er noget logo, eller hvis data-URI'en er ugyldig (fx delvist
// korrupt upload) — så falder dokumentet bare tilbage til kun tekst.
function logoDataUriToBuffer(logoUrl) {
  if (!logoUrl || typeof logoUrl !== 'string') return null;
  const m = logoUrl.match(/^data:image\/(png|jpe?g);base64,(.+)$/);
  if (!m) return null;
  try { return Buffer.from(m[2], 'base64'); } catch (e) { return null; }
}
function drawDocumentPdf(doc, kind, record, company) {
  const isInvoice = kind === 'invoice';
  const accent = '#4F46E5';
  const logoBuf = logoDataUriToBuffer(company.logoUrl);
  const textX = logoBuf ? 96 : 40;
  if (logoBuf) {
    try { doc.image(logoBuf, 40, 36, { fit: [48, 48] }); } catch (e) { /* korrupt billede — spring logoet over */ }
  }
  doc.fontSize(20).fillColor('#111318').text(company.name, textX, 40);
  doc.fontSize(9).fillColor('#6B7280');
  const addrLines = [company.address, company.cvr ? `CVR ${company.cvr}` : '', company.phone, company.email].filter(Boolean);
  addrLines.forEach((l, i) => doc.text(l, textX, 66 + i * 12));

  doc.fontSize(22).fillColor(accent).text(isInvoice ? 'FAKTURA' : 'TILBUD', 350, 40, { width: 200, align: 'right' });
  doc.fontSize(10).fillColor('#111318').text(isInvoice ? record.invoice_number : record.quote_number, 350, 68, { width: 200, align: 'right' });
  doc.fontSize(9).fillColor('#6B7280').text(`Dato: ${String(record.created_at || '').slice(0, 10)}`, 350, 84, { width: 200, align: 'right' });
  if (isInvoice && record.due_date) doc.text(`Forfaldsdato: ${record.due_date}`, 350, 98, { width: 200, align: 'right' });
  if (!isInvoice && record.valid_until) doc.text(`Gyldig til: ${record.valid_until}`, 350, 98, { width: 200, align: 'right' });

  let y = 140;
  doc.fontSize(10).fillColor('#111318').text('Til:', 40, y);
  y += 14;
  if (record.job_name) { doc.fontSize(11).text(record.job_name, 40, y); y += 14; }
  if (record.customer_address) { doc.fontSize(9).fillColor('#6B7280').text(record.customer_address, 40, y); y += 12; }
  if (record.customer_phone) { doc.fontSize(9).fillColor('#6B7280').text('Tlf. ' + record.customer_phone, 40, y); y += 12; }
  if (record.customer_email) { doc.fontSize(9).fillColor('#6B7280').text(record.customer_email, 40, y); y += 12; }

  y = Math.max(y + 20, 210);
  doc.rect(40, y, 515, 20).fill('#F4F6FB');
  doc.fontSize(9).fillColor('#374151');
  doc.text('Beskrivelse', 48, y + 6);
  doc.text('Antal', 320, y + 6, { width: 50, align: 'right' });
  doc.text('Enhedspris', 380, y + 6, { width: 80, align: 'right' });
  doc.text('I alt', 470, y + 6, { width: 75, align: 'right' });
  y += 26;
  doc.fontSize(9.5).fillColor('#111318');
  let rawSubtotal = 0;
  (record.lines || []).forEach(l => {
    const lineDiscType = l.discount_type === 'fixed' ? 'fixed' : 'pct';
    const lineDiscVal = Number(l.discount_pct) || 0;
    const gross = Number(l.quantity) * Number(l.sell_price);
    const lineDiscAmt = lineDiscountAmount(l, gross);
    const lineTotal = gross - lineDiscAmt;
    rawSubtotal += lineTotal;
    const lineDiscLabel = lineDiscVal ? (lineDiscType === 'fixed' ? ` (-${Math.round(lineDiscVal).toLocaleString('da-DK')} kr)` : ` (-${lineDiscVal}%)`) : '';
    const nameHeight = doc.heightOfString(l.description, { width: 260 });
    doc.text(l.description, 48, y, { width: 260 });
    doc.text(String(l.quantity) + ' ' + (l.unit || '') + lineDiscLabel, 320, y, { width: 50, align: 'right' });
    doc.text(Math.round(Number(l.sell_price)).toLocaleString('da-DK') + ' kr', 380, y, { width: 80, align: 'right' });
    doc.text(Math.round(lineTotal).toLocaleString('da-DK') + ' kr', 470, y, { width: 75, align: 'right' });
    y += Math.max(nameHeight, 14) + 6;
    doc.moveTo(40, y - 3).lineTo(555, y - 3).strokeColor('#EEF0F3').stroke();
  });

  y += 10;
  const totalsX = 380;
  const docDiscountType = record.discount_type === 'fixed' ? 'fixed' : 'pct';
  const docDiscountPct = Number(record.discount_pct) || 0;
  const docDiscountAmount = docDiscountType === 'fixed' ? Math.max(0, Math.min(docDiscountPct, rawSubtotal)) : (docDiscountPct ? rawSubtotal * docDiscountPct / 100 : 0);
  const docDiscountLabel = docDiscountType === 'fixed' ? `${Math.round(docDiscountPct).toLocaleString('da-DK')} kr` : `${docDiscountPct}%`;
  if (docDiscountAmount > 0) {
    doc.fontSize(9.5).fillColor('#6B7280').text(`Rabat (${docDiscountLabel})`, totalsX, y, { width: 80, align: 'right' });
    doc.fillColor('#DC2626').text('-' + Math.round(docDiscountAmount).toLocaleString('da-DK') + ' kr', 470, y, { width: 75, align: 'right' });
    y += 16;
  }
  doc.fontSize(9.5).fillColor('#6B7280').text('Subtotal', totalsX, y, { width: 80, align: 'right' });
  doc.fillColor('#111318').text(Math.round(Number(record.subtotal)).toLocaleString('da-DK') + ' kr', 470, y, { width: 75, align: 'right' });
  y += 16;
  doc.fillColor('#6B7280').text(`Moms (${record.tax_rate}%)`, totalsX, y, { width: 80, align: 'right' });
  doc.fillColor('#111318').text(Math.round(Number(record.tax_amount)).toLocaleString('da-DK') + ' kr', 470, y, { width: 75, align: 'right' });
  y += 18;
  doc.rect(totalsX, y - 3, 165, 22).fill(accent);
  doc.fillColor('#fff').fontSize(11).text('Total', totalsX + 8, y + 3);
  doc.text(Math.round(Number(record.total)).toLocaleString('da-DK') + ' kr', 470, y + 3, { width: 75, align: 'right' });
  y += 30;

  if (isInvoice && record.paid_total > 0) {
    doc.fontSize(9.5).fillColor('#15803D').text('Betalt', totalsX, y, { width: 80, align: 'right' });
    doc.text('-' + Math.round(Number(record.paid_total)).toLocaleString('da-DK') + ' kr', 470, y, { width: 75, align: 'right' });
    y += 16;
    doc.fontSize(10).fillColor('#B91C1C').text('Restbeløb', totalsX, y, { width: 80, align: 'right' });
    doc.text(Math.round(Number(record.remaining)).toLocaleString('da-DK') + ' kr', 470, y, { width: 75, align: 'right' });
    y += 20;
  }

  if (record.notes) {
    y += 16;
    doc.fontSize(9).fillColor('#6B7280').text(record.notes, 40, y, { width: 515 });
    y += doc.heightOfString(record.notes, { width: 515 }) + 10;
  }

  if (!isInvoice && record.status === 'accepted' && record.signed_name) {
    y += 8;
    doc.fontSize(9).fillColor('#15803D').text(`✓ Accepteret af ${record.signed_name} den ${String(record.signed_at || '').slice(0, 16).replace('T', ' ')}`, 40, y, { width: 515 });
    y += 15;
    if (record.signature_data && /^data:image\/(png|jpeg);base64,/.test(record.signature_data)) {
      try {
        const imgBuf = Buffer.from(record.signature_data.split(',')[1], 'base64');
        doc.image(imgBuf, 40, y, { width: 150 });
        y += 55;
      } catch (e) { /* ugyldigt billede — spring underskriften over på PDF'en */ }
    }
  }

  if (isInvoice && (company.bankReg || company.bankAccount)) {
    y += 10;
    doc.fontSize(9).fillColor('#6B7280').text(`Betaling: Reg. ${company.bankReg}  Konto ${company.bankAccount}`, 40, y);
    y += 14;
  }
  if (company.footerNote) {
    doc.fontSize(8).fillColor('#9CA3AF').text(company.footerNote, 40, 780, { width: 515, align: 'center' });
  }
}
// Kreditnotaer er beløbs-/begrundelses-baserede (ikke linje-baserede som
// tilbud/faktura), så de har deres egen, langt enklere tegne-funktion frem for
// at genbruge drawDocumentPdf's linje-tabel.
function drawCreditNotePdf(doc, creditNote, invoice, company) {
  const accent = '#DC2626';
  const logoBuf = logoDataUriToBuffer(company.logoUrl);
  const textX = logoBuf ? 96 : 40;
  if (logoBuf) {
    try { doc.image(logoBuf, 40, 36, { fit: [48, 48] }); } catch (e) { /* korrupt billede — spring logoet over */ }
  }
  doc.fontSize(20).fillColor('#111318').text(company.name, textX, 40);
  doc.fontSize(9).fillColor('#6B7280');
  const addrLines = [company.address, company.cvr ? `CVR ${company.cvr}` : '', company.phone, company.email].filter(Boolean);
  addrLines.forEach((l, i) => doc.text(l, textX, 66 + i * 12));

  doc.fontSize(22).fillColor(accent).text('KREDITNOTA', 350, 40, { width: 200, align: 'right' });
  doc.fontSize(10).fillColor('#111318').text(creditNote.credit_note_number, 350, 68, { width: 200, align: 'right' });
  doc.fontSize(9).fillColor('#6B7280').text(`Dato: ${String(creditNote.created_at || '').slice(0, 10)}`, 350, 84, { width: 200, align: 'right' });
  doc.text(`Vedr. faktura: ${invoice ? invoice.invoice_number : ''}`, 350, 98, { width: 200, align: 'right' });

  let y = 140;
  doc.fontSize(10).fillColor('#111318').text('Til:', 40, y);
  y += 14;
  if (invoice && invoice.job_name) { doc.fontSize(11).text(invoice.job_name, 40, y); y += 14; }
  if (invoice && invoice.customer_address) { doc.fontSize(9).fillColor('#6B7280').text(invoice.customer_address, 40, y); y += 12; }

  y = Math.max(y + 30, 210);
  doc.rect(40, y, 515, 60).fill('#FEF2F2');
  doc.fontSize(9.5).fillColor('#6B7280').text('Krediteret beløb', 56, y + 12);
  doc.fontSize(20).fillColor(accent).text(Math.round(Number(creditNote.amount)).toLocaleString('da-DK') + ' kr', 56, y + 28);
  y += 80;

  if (creditNote.reason) {
    doc.fontSize(9).fillColor('#374151').text('Begrundelse:', 40, y);
    y += 14;
    doc.fontSize(9.5).fillColor('#111318').text(creditNote.reason, 40, y, { width: 515 });
    y += doc.heightOfString(creditNote.reason, { width: 515 }) + 10;
  }

  if (company.footerNote) {
    doc.fontSize(8).fillColor('#9CA3AF').text(company.footerNote, 40, 780, { width: 515, align: 'center' });
  }
}
// Samler PDF'en i hukommelsen i stedet for at streame den direkte til et
// HTTP-svar — bruges når PDF'en skal vedhæftes en mail i stedet for vises i
// browseren.
function renderDocumentPdfBuffer(kind, record, company) {
  return new Promise((resolve, reject) => {
    try {
      const doc = new PDFDocument({ size: 'A4', margin: 40 });
      const chunks = [];
      doc.on('data', (c) => chunks.push(c));
      doc.on('end', () => resolve(Buffer.concat(chunks)));
      doc.on('error', reject);
      drawDocumentPdf(doc, kind, record, company);
      doc.end();
    } catch (e) { reject(e); }
  });
}
function renderCreditNotePdfBuffer(creditNote, invoice, company) {
  return new Promise((resolve, reject) => {
    try {
      const doc = new PDFDocument({ size: 'A4', margin: 40 });
      const chunks = [];
      doc.on('data', (c) => chunks.push(c));
      doc.on('end', () => resolve(Buffer.concat(chunks)));
      doc.on('error', reject);
      drawCreditNotePdf(doc, creditNote, invoice, company);
      doc.end();
    } catch (e) { reject(e); }
  });
}
function stripHtmlToText(html) {
  return String(html || '')
    .replace(/<style[\s\S]*?<\/style>/gi, '')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/p>/gi, '\n\n')
    .replace(/<[^>]+>/g, '')
    .replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>')
    .replace(/[ \t]+\n/g, '\n').replace(/\n{3,}/g, '\n\n').trim();
}

app.get('/api/quotes/:id/pdf', auth, financeOnly, asyncRoute(async (req, res) => {
  const quote = await loadQuoteFull(req.params.id);
  if (!quote) return res.status(404).json({ error: 'Tilbuddet blev ikke fundet' });
  const company = await getCompanyInfo();
  res.set('Content-Type', 'application/pdf');
  res.set('Content-Disposition', `inline; filename="${quote.quote_number}.pdf"`);
  const doc = new PDFDocument({ size: 'A4', margin: 40 });
  doc.pipe(res);
  drawDocumentPdf(doc, 'quote', quote, company);
  doc.end();
}));

app.get('/api/invoices/:id/pdf', auth, financeOnly, asyncRoute(async (req, res) => {
  const invoice = await loadInvoiceFull(req.params.id);
  if (!invoice) return res.status(404).json({ error: 'Fakturaen blev ikke fundet' });
  const company = await getCompanyInfo();
  res.set('Content-Type', 'application/pdf');
  res.set('Content-Disposition', `inline; filename="${invoice.invoice_number}.pdf"`);
  const doc = new PDFDocument({ size: 'A4', margin: 40 });
  doc.pipe(res);
  drawDocumentPdf(doc, 'invoice', invoice, company);
  doc.end();
}));

// ══════════════════════════════════════════════════════════════
// E-SIGNATUR PÅ TILBUD — kunden kan acceptere et tilbud ved at tegne en
// underskrift + skrive sit navn på en offentlig side (intet login). Det er
// IKKE en "kvalificeret" e-signatur (eIDAS/NemID-niveau) — det er en tegnet
// underskrift + navn + IP-adresse + tidsstempel som bevis, ligesom man
// kender det fra fx pakkeleveringer. Kommunikeres ærligt til Martin.
// ══════════════════════════════════════════════════════════════
function krFmtServer(n) {
  if (n === null || n === undefined || isNaN(Number(n))) return '–';
  return Math.round(Number(n)).toLocaleString('da-DK') + ' kr';
}
function escPublic(s) {
  return String(s === null || s === undefined ? '' : s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#039;' }[c]));
}

app.get('/api/quotes/:id/share-link', auth, financeOnly, asyncRoute(async (req, res) => {
  const quote = await pgOne('SELECT id, accept_token FROM quotes WHERE id=$1', [req.params.id]);
  if (!quote) return res.status(404).json({ error: 'Tilbuddet blev ikke fundet' });
  let token = quote.accept_token;
  if (!token) {
    token = crypto.randomBytes(20).toString('hex');
    await pool.query('UPDATE quotes SET accept_token=$1 WHERE id=$2', [token, req.params.id]);
  }
  res.json({ ok: true, url: `${PUBLIC_APP_URL}/tilbud/${token}` });
}));

// Til forskel fra fillEmailVars (bruges til booking-mails, se ovenfor) skriver
// denne TOM streng når nøglen findes men er tom/irrelevant for dokumenttypen
// (fx {{forfald}} på et tilbud) — ellers ville skabelonen vise "{{forfald}}"
// bogstaveligt i mailen, hvis en admin bruger samme skabelon til begge typer.
function fillDocEmailVars(str, vars) {
  return String(str || '').replace(/\{\{\s*(\w+)\s*\}\}/g, (m, key) => (key in vars) ? String(vars[key]) : m);
}
const DOC_EMAIL_VARS = [
  ['{{kunde}}', 'Kunde/sagsnavn'], ['{{dokument_nr}}', 'Tilbuds-/fakturanummer'], ['{{total}}', 'Totalbeløb'],
  ['{{gyldig_til}}', 'Gyldig til (kun tilbud)'], ['{{forfald}}', 'Forfaldsdato (kun faktura)'], ['{{restbeloeb}}', 'Restbeløb (kun faktura)'],
  ['{{firma}}', 'Firmanavn'], ['{{link}}', 'Link til kundens portal (alle tilbud/fakturaer/opgaver)'],
  ['{{underskriv_link}}', 'Direkte link til at underskrive (kun tilbud)']
];

// ── FASTE MAIL-SKABELON-KOBLINGER PR. HÆNDELSESTYPE ──
// Martin vil have faste standard-koblinger (tilbud/faktura/kreditnota/rykker → en
// bestemt mail-skabelon), men altid frit kunne ændre koblingen manuelt i Indstillinger.
// Gemmes som almindelige app_settings-nøgler (email_tpl_event_<type>), så en admin altid
// selv kan overskrive den ved at sende et eksplicit template_id ved selve afsendelsen.
const DOC_EMAIL_EVENT_TYPES = ['quote', 'invoice', 'credit_note', 'dunning'];
async function getEmailTemplateAssignments() {
  const rows = await pool.query("SELECT key,value FROM app_settings WHERE key LIKE 'email_tpl_event_%'");
  const map = {}; DOC_EMAIL_EVENT_TYPES.forEach(evt => { map[evt] = null; });
  rows.rows.forEach(r => {
    const evt = r.key.replace('email_tpl_event_', '');
    if (evt in map && r.value) map[evt] = Number(r.value);
  });
  return map;
}
async function getAssignedTemplateId(eventType) {
  const row = await pgOne('SELECT value FROM app_settings WHERE key=$1', ['email_tpl_event_' + eventType]);
  return (row && row.value) ? Number(row.value) : null;
}
app.get('/api/settings/email-template-assignments', auth, financeOnly, asyncRoute(async (req, res) => {
  res.json(await getEmailTemplateAssignments());
}));
app.put('/api/settings/email-template-assignments', auth, financeOnly, asyncRoute(async (req, res) => {
  const b = req.body || {};
  for (const evt of DOC_EMAIL_EVENT_TYPES) {
    if (!(evt in b)) continue;
    const val = b[evt] ? String(Number(b[evt])) : '';
    await pool.query(
      'INSERT INTO app_settings (key,value) VALUES ($1,$2) ON CONFLICT (key) DO UPDATE SET value=$2',
      ['email_tpl_event_' + evt, val]
    );
  }
  res.json({ ok: true, assignments: await getEmailTemplateAssignments() });
}));

app.post('/api/quotes/:id/send', auth, financeOnly, asyncRoute(async (req, res) => {
  const quote = await loadQuoteFull(req.params.id);
  if (!quote) return res.status(404).json({ error: 'Tilbuddet blev ikke fundet' });
  const b = req.body || {};
  const to = String(b.to || quote.customer_email || '').trim();
  if (!to) return res.status(400).json({ error: 'Ingen modtager-mail angivet — udfyld kundens e-mail på tilbuddet, eller angiv en her' });
  if (!mailIsConfigured()) return res.status(400).json({ error: 'E-mail er ikke konfigureret på serveren' });
  let acceptToken = quote.accept_token;
  if (!acceptToken) {
    acceptToken = crypto.randomBytes(20).toString('hex');
    await pool.query('UPDATE quotes SET accept_token=$1 WHERE id=$2', [acceptToken, quote.id]);
  }
  const company = await getCompanyInfo();
  const portalToken = quote.job_name ? await getOrCreateCustomerPortalToken(quote.job_name) : null;
  const signLink = `${PUBLIC_APP_URL}/tilbud/${acceptToken}`;
  const portalLink = portalToken ? customerPortalLinkFor(portalToken) : signLink;
  const vars = {
    kunde: quote.job_name || '', dokument_nr: quote.quote_number, total: krFmtServer(quote.total),
    gyldig_til: quote.valid_until || '', forfald: '', restbeloeb: '', firma: company.name,
    link: portalLink, underskriv_link: signLink
  };
  let templateId = b.template_id || null;
  if (!templateId) templateId = await getAssignedTemplateId('quote');
  let subject, bodyHtml, tpl = null;
  if (templateId) {
    tpl = await pgOne('SELECT * FROM document_email_templates WHERE id=$1', [templateId]);
    if (!tpl && b.template_id) return res.status(404).json({ error: 'Mail-skabelonen blev ikke fundet' });
  }
  if (tpl) {
    subject = fillDocEmailVars(tpl.subject, vars);
    bodyHtml = fillDocEmailVars(tpl.body_html, vars);
  } else {
    subject = `Dit tilbud ${quote.quote_number} fra ${company.name}`;
    bodyHtml = `<p>Hej ${escPublic(quote.job_name || '')},</p><p>Her er dit tilbud <b>${escPublic(quote.quote_number)}</b> på <b>${krFmtServer(quote.total)}</b> — vedhæftet som PDF.</p><p>Du kan se og underskrive tilbuddet online her: <a href="${signLink}">${signLink}</a></p><p>Du kan altid se alle dine tilbud, fakturaer og planlagte opgaver på din side: <a href="${portalLink}">${portalLink}</a></p><p>Mvh<br>${escPublic(company.name)}</p>`;
  }
  let pdfBuffer;
  try { pdfBuffer = await renderDocumentPdfBuffer('quote', quote, company); }
  catch (e) { return res.status(500).json({ error: 'Kunne ikke generere PDF: ' + e.message }); }
  try {
    await sendMailUniversal({
      to, subject, html: bodyHtml, text: stripHtmlToText(bodyHtml),
      attachments: [{ filename: quote.quote_number + '.pdf', content: pdfBuffer }]
    });
  } catch (e) {
    return res.status(400).json({ error: 'Kunne ikke sende mailen: ' + e.message });
  }
  if (quote.status === 'draft') await pool.query(`UPDATE quotes SET status='sent', updated_at=${nowTextSQL()} WHERE id=$1`, [quote.id]);
  logDocActivity('quote', quote.id, 'sent', req.user.name, `til ${to}`);
  res.json({ ok: true });
}));

app.post('/api/invoices/:id/send', auth, financeOnly, asyncRoute(async (req, res) => {
  const invoice = await loadInvoiceFull(req.params.id);
  if (!invoice) return res.status(404).json({ error: 'Fakturaen blev ikke fundet' });
  const b = req.body || {};
  const to = String(b.to || invoice.customer_email || '').trim();
  if (!to) return res.status(400).json({ error: 'Ingen modtager-mail angivet — udfyld kundens e-mail på fakturaen, eller angiv en her' });
  if (!mailIsConfigured()) return res.status(400).json({ error: 'E-mail er ikke konfigureret på serveren' });
  const company = await getCompanyInfo();
  const portalToken = invoice.job_name ? await getOrCreateCustomerPortalToken(invoice.job_name) : null;
  const portalLink = portalToken ? customerPortalLinkFor(portalToken) : PUBLIC_APP_URL;
  const vars = {
    kunde: invoice.job_name || '', dokument_nr: invoice.invoice_number, total: krFmtServer(invoice.total),
    gyldig_til: '', forfald: invoice.due_date || '', restbeloeb: krFmtServer(invoice.remaining), firma: company.name,
    link: portalLink, underskriv_link: ''
  };
  let templateId = b.template_id || null;
  if (!templateId) templateId = await getAssignedTemplateId('invoice');
  let subject, bodyHtml, tpl = null;
  if (templateId) {
    tpl = await pgOne('SELECT * FROM document_email_templates WHERE id=$1', [templateId]);
    if (!tpl && b.template_id) return res.status(404).json({ error: 'Mail-skabelonen blev ikke fundet' });
  }
  if (tpl) {
    subject = fillDocEmailVars(tpl.subject, vars);
    bodyHtml = fillDocEmailVars(tpl.body_html, vars);
  } else {
    subject = `Din faktura ${invoice.invoice_number} fra ${company.name}`;
    bodyHtml = `<p>Hej ${escPublic(invoice.job_name || '')},</p><p>Her er din faktura <b>${escPublic(invoice.invoice_number)}</b> på <b>${krFmtServer(invoice.total)}</b>${invoice.due_date ? ', med forfald ' + escPublic(invoice.due_date) : ''} — vedhæftet som PDF.</p><p>Du kan altid se alle dine tilbud, fakturaer og planlagte opgaver på din side: <a href="${portalLink}">${portalLink}</a></p><p>Mvh<br>${escPublic(company.name)}</p>`;
  }
  let pdfBuffer;
  try { pdfBuffer = await renderDocumentPdfBuffer('invoice', invoice, company); }
  catch (e) { return res.status(500).json({ error: 'Kunne ikke generere PDF: ' + e.message }); }
  try {
    await sendMailUniversal({
      to, subject, html: bodyHtml, text: stripHtmlToText(bodyHtml),
      attachments: [{ filename: invoice.invoice_number + '.pdf', content: pdfBuffer }]
    });
  } catch (e) {
    return res.status(400).json({ error: 'Kunne ikke sende mailen: ' + e.message });
  }
  logDocActivity('invoice', invoice.id, 'sent', req.user.name, `til ${to}`);
  res.json({ ok: true });
}));

app.get('/tilbud/:token', asyncRoute(async (req, res) => {
  res.set('Cache-Control', 'no-store');
  const esc = escPublic;
  const quote = await pgOne('SELECT * FROM quotes WHERE accept_token=$1', [req.params.token]);
  if (!quote) return res.status(404).send(portalNotFoundPage());
  logDocActivity('quote', quote.id, 'viewed', 'Kunde', null);
  const lines = (await pool.query('SELECT * FROM quote_lines WHERE quote_id=$1 ORDER BY position ASC, id ASC', [quote.id])).rows;
  const company = await getCompanyInfo();
  const rawSubtotal = lines.reduce((s, l) => s + (Number(l.quantity) * Number(l.sell_price) - lineDiscountAmount(l, Number(l.quantity) * Number(l.sell_price))), 0);
  const docDiscType = quote.discount_type === 'fixed' ? 'fixed' : 'pct';
  const discountAmount = docDiscType === 'fixed' ? Math.max(0, Math.min(Number(quote.discount_pct) || 0, rawSubtotal)) : (Number(quote.discount_pct) ? rawSubtotal * Number(quote.discount_pct) / 100 : 0);
  const docDiscLabel = docDiscType === 'fixed' ? `${Math.round(Number(quote.discount_pct) || 0).toLocaleString('da-DK')} kr` : `${Number(quote.discount_pct) || 0}%`;
  const rowsHtml = lines.map(l => {
    const discType = l.discount_type === 'fixed' ? 'fixed' : 'pct';
    const disc = Number(l.discount_pct) || 0;
    const gross = Number(l.quantity) * Number(l.sell_price);
    const lineTotal = gross - lineDiscountAmount(l, gross);
    const discLabel = disc ? (discType === 'fixed' ? ` (-${Math.round(disc).toLocaleString('da-DK')} kr)` : ` (-${disc}%)`) : '';
    return `<tr><td>${esc(l.description)}</td><td class="num">${Number(l.quantity)} ${esc(l.unit || '')}${discLabel}</td><td class="num">${krFmtServer(l.sell_price)}</td><td class="num">${krFmtServer(lineTotal)}</td></tr>`;
  }).join('');
  const statusBlock = (() => {
    if (quote.status === 'accepted') {
      return `<div class="accepted-box">✅ Accepteret af <b>${esc(quote.signed_name)}</b> den ${esc(String(quote.signed_at || '').slice(0, 16).replace('T', ' '))}${quote.signature_data ? `<div class="sig-preview"><img src="${esc(quote.signature_data)}" alt="Underskrift"></div>` : ''}</div>`;
    }
    if (quote.status === 'declined') return `<div class="declined-box">Dette tilbud er markeret som afvist.</div>`;
    if (quote.status === 'converted') return `<div class="declined-box">Dette tilbud er allerede godkendt og faktureret.</div>`;
    return `
      <div class="accept-box">
        <h3>Accepter tilbuddet</h3>
        <label>Dit fulde navn</label>
        <input id="accept-name" type="text" placeholder="Fornavn Efternavn">
        <label>Underskrift <span class="sig-hint">— tegn med musen eller fingeren</span></label>
        <canvas id="sigpad" width="600" height="180"></canvas>
        <button type="button" id="sig-clear" class="btn-link">Ryd underskrift</button>
        <button type="button" id="accept-btn" class="accept-btn" onclick="submitAccept()">Jeg accepterer tilbuddet</button>
        <p class="legal-note">Ved at underskrive bekræfter du at have læst og accepteret tilbuddet. Din underskrift, dit navn, din IP-adresse og tidspunktet gemmes som bevis for accepten.</p>
      </div>`;
  })();
  const html = `<!doctype html><html lang="da"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>${esc(quote.quote_number)} — ${esc(company.name)}</title>
<style>
  * { box-sizing:border-box; }
  body{font-family:-apple-system,Segoe UI,Roboto,Arial,sans-serif;background:#F4F6FB;color:#111318;margin:0;padding:24px 16px 60px}
  .wrap{max-width:640px;margin:0 auto}
  .card{background:#fff;border-radius:16px;padding:28px 24px;box-shadow:0 8px 30px rgba(15,17,24,.08);margin-bottom:16px}
  .head{display:flex;justify-content:space-between;align-items:flex-start;margin-bottom:20px;flex-wrap:wrap;gap:10px}
  .company{font-size:18px;font-weight:800}
  .company-sub{font-size:11px;color:#6B7280;margin-top:4px;line-height:1.6}
  .doctype{font-size:20px;font-weight:800;color:#4F46E5;text-align:right}
  .docmeta{font-size:11px;color:#6B7280;text-align:right;margin-top:2px}
  table{width:100%;border-collapse:collapse;font-size:13px;margin:14px 0}
  th{text-align:left;background:#F4F6FB;padding:8px 10px;font-size:11px;color:#374151}
  th.num,td.num{text-align:right}
  td{padding:8px 10px;border-bottom:1px solid #EEF0F3}
  .totals{margin-left:auto;width:240px;margin-top:10px}
  .totals-row{display:flex;justify-content:space-between;padding:3px 0;font-size:12.5px;color:#6B7280}
  .totals-row.grand{font-size:15px;font-weight:800;color:#111318;border-top:1px solid #EEF0F3;margin-top:6px;padding-top:8px}
  .accept-box h3{margin:0 0 12px;font-size:15px}
  .accept-box label{display:block;font-size:11px;font-weight:700;color:#6B7280;text-transform:uppercase;margin:12px 0 4px}
  .accept-box input{width:100%;border:1px solid #E5E7EB;border-radius:8px;padding:10px 12px;font-size:14px}
  #sigpad{width:100%;height:180px;border:2px dashed #CBD5E1;border-radius:12px;touch-action:none;background:#FAFAFB}
  .sig-hint{text-transform:none;font-weight:400}
  .btn-link{background:none;border:0;color:#6B7280;font-size:11px;text-decoration:underline;cursor:pointer;padding:6px 0;display:block}
  .accept-btn{width:100%;margin-top:10px;background:#4F46E5;color:#fff;border:0;border-radius:10px;padding:14px;font-size:15px;font-weight:700;cursor:pointer}
  .accept-btn:disabled{opacity:.6}
  .legal-note{font-size:10.5px;color:#9CA3AF;margin-top:10px;line-height:1.5}
  .accepted-box{background:#F0FDF4;border:1px solid #BBF7D0;color:#15803D;border-radius:12px;padding:16px;font-size:13.5px}
  .sig-preview{margin-top:10px;background:#fff;border-radius:8px;padding:8px;display:inline-block}
  .sig-preview img{max-width:280px;display:block}
  .declined-box{background:#FEF2F2;border:1px solid #FECACA;color:#B91C1C;border-radius:12px;padding:16px;font-size:13.5px}
  .notes{margin-top:16px;font-size:12px;color:#6B7280;white-space:pre-wrap}
  .company-head{display:flex;align-items:center;gap:10px}
  .company-logo{width:44px;height:44px;border-radius:9px;object-fit:cover;flex-shrink:0}
</style></head><body><div class="wrap">
<div class="card">
  <div class="head">
    <div class="company-head">${company.logoUrl ? `<img class="company-logo" src="${esc(company.logoUrl)}" alt="">` : ''}<div><div class="company">${esc(company.name)}</div><div class="company-sub">${[company.address, company.cvr ? ('CVR ' + company.cvr) : '', company.phone, company.email].filter(Boolean).map(esc).join('<br>')}</div></div></div>
    <div><div class="doctype">TILBUD</div><div class="docmeta">${esc(quote.quote_number)}<br>Dato: ${esc(String(quote.created_at || '').slice(0, 10))}${quote.valid_until ? `<br>Gyldig til: ${esc(quote.valid_until)}` : ''}</div></div>
  </div>
  ${quote.job_name ? `<div style="font-size:13px;margin-bottom:14px"><b>Til:</b> ${esc(quote.job_name)}${quote.customer_address ? '<br>' + esc(quote.customer_address) : ''}</div>` : ''}
  <table><thead><tr><th>Beskrivelse</th><th class="num">Antal</th><th class="num">Enhedspris</th><th class="num">I alt</th></tr></thead><tbody>${rowsHtml}</tbody></table>
  <div class="totals">
    ${discountAmount > 0 ? `<div class="totals-row"><span>Rabat (${docDiscLabel})</span><span>-${krFmtServer(discountAmount)}</span></div>` : ''}
    <div class="totals-row"><span>Subtotal</span><span>${krFmtServer(quote.subtotal)}</span></div>
    <div class="totals-row"><span>Moms (${quote.tax_rate}%)</span><span>${krFmtServer(quote.tax_amount)}</span></div>
    <div class="totals-row grand"><span>Total</span><span>${krFmtServer(quote.total)}</span></div>
  </div>
  ${quote.notes ? `<div class="notes">${esc(quote.notes)}</div>` : ''}
</div>
<div class="card">${statusBlock}</div>
</div>
<script>
var TOKEN=${JSON.stringify(req.params.token)};
(function(){
  var canvas=document.getElementById('sigpad');
  if(!canvas)return;
  var ctx=canvas.getContext('2d');
  ctx.strokeStyle='#111318';ctx.lineWidth=2.5;ctx.lineCap='round';
  var drawing=false,last=null;
  function pos(e){var r=canvas.getBoundingClientRect();var t=e.touches?e.touches[0]:e;return {x:(t.clientX-r.left)*(canvas.width/r.width),y:(t.clientY-r.top)*(canvas.height/r.height)};}
  function start(e){drawing=true;last=pos(e);e.preventDefault();}
  function move(e){if(!drawing)return;var p=pos(e);ctx.beginPath();ctx.moveTo(last.x,last.y);ctx.lineTo(p.x,p.y);ctx.stroke();last=p;e.preventDefault();}
  function end(){drawing=false;}
  canvas.addEventListener('mousedown',start);canvas.addEventListener('mousemove',move);window.addEventListener('mouseup',end);
  canvas.addEventListener('touchstart',start,{passive:false});canvas.addEventListener('touchmove',move,{passive:false});canvas.addEventListener('touchend',end);
  var clearBtn=document.getElementById('sig-clear');
  if(clearBtn)clearBtn.onclick=function(){ctx.clearRect(0,0,canvas.width,canvas.height);};
})();
async function submitAccept(){
  var nameEl=document.getElementById('accept-name');
  var name=nameEl?nameEl.value.trim():'';
  if(!name){alert('Skriv dit navn');return;}
  var canvas=document.getElementById('sigpad');
  var blank=document.createElement('canvas');blank.width=canvas.width;blank.height=canvas.height;
  if(canvas.toDataURL()===blank.toDataURL()){alert('Tegn din underskrift i feltet');return;}
  var btn=document.getElementById('accept-btn');btn.disabled=true;btn.textContent='Sender...';
  try{
    var r=await fetch('/api/public/quotes/'+TOKEN+'/accept',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({signed_name:name,signature_data:canvas.toDataURL('image/png')})});
    var d=await r.json().catch(function(){return{};});
    if(r.ok&&d.ok){window.location.reload();}
    else{alert(d.error||'Der skete en fejl');btn.disabled=false;btn.textContent='Jeg accepterer tilbuddet';}
  }catch(e){alert('Netværksfejl — prøv igen');btn.disabled=false;btn.textContent='Jeg accepterer tilbuddet';}
}
</script>
</body></html>`;
  res.send(html);
}));

app.post('/api/public/quotes/:token/accept', asyncRoute(async (req, res) => {
  const quote = await pgOne('SELECT * FROM quotes WHERE accept_token=$1', [req.params.token]);
  if (!quote) return res.status(404).json({ error: 'Tilbuddet blev ikke fundet' });
  if (['accepted', 'declined', 'converted'].includes(quote.status)) return res.status(400).json({ error: 'Dette tilbud er allerede behandlet' });
  const b = req.body || {};
  const name = String(b.signed_name || '').trim();
  const sig = String(b.signature_data || '');
  if (!name || !sig.startsWith('data:image/')) return res.status(400).json({ error: 'Navn og underskrift er påkrævet' });
  const ip = (req.headers['x-forwarded-for'] || req.ip || '').toString().split(',')[0].trim();
  await pool.query(`
    UPDATE quotes SET status='accepted', signed_name=$1, signed_at=${nowTextSQL()}, signed_ip=$2, signature_data=$3, updated_at=${nowTextSQL()}
    WHERE id=$4
  `, [name, ip, sig, quote.id]);
  // Opret automatisk et projekt/sags-dashboard så snart kunden har underskrevet —
  // det er selve pointen med e-signaturen ift. projektplanlægningen.
  let projectId = null;
  try {
    const existingProject = await pgOne('SELECT id FROM projects WHERE quote_id=$1', [quote.id]);
    if (existingProject) {
      projectId = existingProject.id;
    } else {
      const p = await pgOne(`
        INSERT INTO projects (quote_id, name, customer_id, customer_address, customer_phone, customer_email)
        VALUES ($1,$2,$3,$4,$5,$6) RETURNING id
      `, [quote.id, quote.job_name || quote.quote_number, quote.customer_id, quote.customer_address, quote.customer_phone, quote.customer_email]);
      projectId = p.id;
    }
  } catch (e) {
    // Selve accepten er allerede gemt — en fejl her må ikke vælte kundens kvittering.
  }
  res.json({ ok: true, project_id: projectId });
}));

// ══════════════════════════════════════════════════════════════
// PRISFORESPØRGSLER (RFQ) — send tilbuddets materiale-linjer til leverandører
// ("supplier", uden priser) for at indhente sammenlignelige priser, eller send
// hele tilbuddet til en underleverandør ("subcontractor") med blanke pris-felter
// de selv udfylder online. Systemet sender selv e-mails via sendMailUniversal.
// ══════════════════════════════════════════════════════════════
app.post('/api/quotes/:id/requests', auth, financeOnly, asyncRoute(async (req, res) => {
  const quote = await pgOne('SELECT * FROM quotes WHERE id=$1', [req.params.id]);
  if (!quote) return res.status(404).json({ error: 'Tilbuddet blev ikke fundet' });
  const b = req.body || {};
  const kind = b.kind === 'subcontractor' ? 'subcontractor' : 'supplier';
  const recipients = Array.isArray(b.recipients) ? b.recipients.filter(r => r && r.email && String(r.email).trim()) : [];
  if (!recipients.length) return res.status(400).json({ error: 'Angiv mindst én modtager med e-mail' });
  if (!mailIsConfigured()) return res.status(400).json({ error: 'E-mail er ikke konfigureret på serveren' });
  const allLines = (await pool.query('SELECT * FROM quote_lines WHERE quote_id=$1 ORDER BY position ASC, id ASC', [req.params.id])).rows;
  const selectedLines = kind === 'supplier' ? allLines.filter(l => l.product_type === 'materialer') : allLines;
  if (!selectedLines.length) return res.status(400).json({ error: kind === 'supplier' ? 'Tilbuddet indeholder ingen materiale-linjer at sende' : 'Tilbuddet indeholder ingen linjer at sende' });

  const reqRow = await pgOne('INSERT INTO quote_requests (quote_id,kind,note) VALUES ($1,$2,$3) RETURNING *', [req.params.id, kind, b.note || null]);
  for (const l of selectedLines) {
    await pool.query('INSERT INTO quote_request_lines (request_id,description,unit,quantity,position) VALUES ($1,$2,$3,$4,$5)',
      [reqRow.id, l.description, l.unit, l.quantity, l.position]);
  }
  const kindLabel = kind === 'supplier' ? 'Prisforespørgsel' : 'Forespørgsel til underleverandør';
  const sent = [], failed = [];
  for (const r of recipients) {
    const token = crypto.randomBytes(20).toString('hex');
    await pool.query('INSERT INTO quote_request_recipients (request_id,name,email,token) VALUES ($1,$2,$3,$4)',
      [reqRow.id, r.name || null, String(r.email).trim(), token]);
    const link = `${PUBLIC_APP_URL}/forespoergsel/${token}`;
    try {
      await sendMailUniversal({
        to: String(r.email).trim(),
        subject: `${kindLabel} — ${quote.quote_number}${quote.job_name ? ' (' + quote.job_name + ')' : ''}`,
        text: `Hej${r.name ? ' ' + r.name : ''},\n\nVi vil gerne bede om en pris. Se detaljer og udfyld direkte her:\n${link}\n\nMvh`,
        html: `<p>Hej${r.name ? ' ' + escPublic(r.name) : ''},</p><p>Vi vil gerne bede om en pris. Se detaljer og udfyld direkte via linket:</p><p><a href="${link}">${link}</a></p><p>Mvh</p>`
      });
      sent.push(r.email);
    } catch (e) {
      failed.push({ email: r.email, error: e.message });
    }
  }
  res.json({ ok: true, id: reqRow.id, sent, failed });
}));

app.get('/api/quotes/:id/requests', auth, financeOnly, asyncRoute(async (req, res) => {
  const requests = (await pool.query('SELECT * FROM quote_requests WHERE quote_id=$1 ORDER BY created_at DESC', [req.params.id])).rows;
  for (const r of requests) {
    r.lines = (await pool.query('SELECT * FROM quote_request_lines WHERE request_id=$1 ORDER BY position ASC, id ASC', [r.id])).rows;
    r.recipients = (await pool.query('SELECT * FROM quote_request_recipients WHERE request_id=$1 ORDER BY created_at ASC', [r.id])).rows;
  }
  res.json(requests);
}));

app.delete('/api/quote-requests/:id', auth, financeOnly, asyncRoute(async (req, res) => {
  await pool.query('DELETE FROM quote_requests WHERE id=$1', [req.params.id]);
  res.json({ ok: true });
}));

app.get('/forespoergsel/:token', asyncRoute(async (req, res) => {
  res.set('Cache-Control', 'no-store');
  const esc = escPublic;
  const recipient = await pgOne('SELECT * FROM quote_request_recipients WHERE token=$1', [req.params.token]);
  if (!recipient) return res.status(404).send(portalNotFoundPage());
  const reqRow = await pgOne('SELECT * FROM quote_requests WHERE id=$1', [recipient.request_id]);
  if (!reqRow) return res.status(404).send(portalNotFoundPage());
  const quote = await pgOne('SELECT quote_number, job_name FROM quotes WHERE id=$1', [reqRow.quote_id]);
  const lines = (await pool.query('SELECT * FROM quote_request_lines WHERE request_id=$1 ORDER BY position ASC, id ASC', [reqRow.id])).rows;
  const company = await getCompanyInfo();
  const isSupplier = reqRow.kind === 'supplier';
  const title = isSupplier ? 'Prisforespørgsel' : 'Forespørgsel til underleverandør';
  const intro = isSupplier
    ? 'Vi beder om en pris på følgende materialer. Udfyld enhedspris pr. linje herunder.'
    : 'Vi beder om et pristilbud på nedenstående opgave. Udfyld din pris pr. linje herunder.';

  let bodyHtml;
  if (recipient.status === 'responded') {
    const resp = recipient.responses || { lines: [] };
    const byId = {}; (resp.lines || []).forEach(l => { byId[l.line_id] = l; });
    const rowsHtml = lines.map(l => {
      const v = byId[l.id] || {};
      return `<tr><td>${esc(l.description)}</td><td class="num">${Number(l.quantity)} ${esc(l.unit || '')}</td><td class="num">${v.unit_price !== undefined && v.unit_price !== null && v.unit_price !== '' ? krFmtServer(v.unit_price) : '–'}</td></tr>`;
    }).join('');
    bodyHtml = `
      <div class="accepted-box">✅ Tak — vi har modtaget dit svar den ${esc(String(recipient.responded_at || '').slice(0, 16).replace('T', ' '))}.</div>
      <table><thead><tr><th>Beskrivelse</th><th class="num">Antal</th><th class="num">Din pris</th></tr></thead><tbody>${rowsHtml}</tbody></table>
      ${resp.message ? `<div class="notes"><b>Din besked:</b><br>${esc(resp.message)}</div>` : ''}`;
  } else {
    const rowsHtml = lines.map(l => `
      <tr>
        <td>${esc(l.description)}</td>
        <td class="num">${Number(l.quantity)} ${esc(l.unit || '')}</td>
        <td class="num"><input type="number" step="0.01" min="0" class="line-price" data-line-id="${l.id}" placeholder="0,00"></td>
      </tr>`).join('');
    bodyHtml = `
      <p class="intro">${esc(intro)}</p>
      <table><thead><tr><th>Beskrivelse</th><th class="num">Antal</th><th class="num">Din pris (kr, ekskl. moms)</th></tr></thead><tbody>${rowsHtml}</tbody></table>
      <label>Besked (valgfrit)</label>
      <textarea id="resp-message" rows="3" placeholder="Fx leveringstid, forbehold m.m."></textarea>
      <button type="button" id="resp-btn" class="accept-btn" onclick="submitResponse()">Send din pris</button>`;
  }

  const html = `<!doctype html><html lang="da"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>${esc(title)} — ${esc(company.name)}</title>
<style>
  * { box-sizing:border-box; }
  body{font-family:-apple-system,Segoe UI,Roboto,Arial,sans-serif;background:#F4F6FB;color:#111318;margin:0;padding:24px 16px 60px}
  .wrap{max-width:640px;margin:0 auto}
  .card{background:#fff;border-radius:16px;padding:28px 24px;box-shadow:0 8px 30px rgba(15,17,24,.08);margin-bottom:16px}
  .company{font-size:16px;font-weight:800}
  .company-sub{font-size:11px;color:#6B7280;margin-top:4px}
  h1{font-size:19px;margin:14px 0 4px}
  .meta{font-size:12px;color:#6B7280;margin-bottom:14px}
  .intro{font-size:13px;color:#374151;margin-bottom:14px}
  table{width:100%;border-collapse:collapse;font-size:13px;margin:14px 0}
  th{text-align:left;background:#F4F6FB;padding:8px 10px;font-size:11px;color:#374151}
  th.num,td.num{text-align:right}
  td{padding:8px 10px;border-bottom:1px solid #EEF0F3}
  .line-price{width:100px;border:1px solid #E5E7EB;border-radius:6px;padding:6px 8px;font-size:13px;text-align:right}
  label{display:block;font-size:11px;font-weight:700;color:#6B7280;text-transform:uppercase;margin:12px 0 4px}
  textarea{width:100%;border:1px solid #E5E7EB;border-radius:8px;padding:10px 12px;font-size:14px;font-family:inherit;resize:vertical}
  .accept-btn{width:100%;margin-top:14px;background:#4F46E5;color:#fff;border:0;border-radius:10px;padding:14px;font-size:15px;font-weight:700;cursor:pointer}
  .accept-btn:disabled{opacity:.6}
  .accepted-box{background:#F0FDF4;border:1px solid #BBF7D0;color:#15803D;border-radius:12px;padding:16px;font-size:13.5px;margin-bottom:8px}
  .notes{margin-top:14px;font-size:12.5px;color:#374151;background:#F4F6FB;border-radius:8px;padding:12px;white-space:pre-wrap}
  .company-head{display:flex;align-items:center;gap:10px;margin-bottom:2px}
  .company-logo{width:40px;height:40px;border-radius:8px;object-fit:cover;flex-shrink:0}
</style></head><body><div class="wrap">
<div class="card">
  <div class="company-head">${company.logoUrl ? `<img class="company-logo" src="${esc(company.logoUrl)}" alt="">` : ''}<div><div class="company">${esc(company.name)}</div>
  <div class="company-sub">${[company.address, company.phone, company.email].filter(Boolean).map(esc).join(' · ')}</div></div></div>
  <h1>${esc(title)}</h1>
  <div class="meta">${esc(quote ? quote.quote_number : '')}${quote && quote.job_name ? ' — ' + esc(quote.job_name) : ''}${recipient.name ? ' · Til ' + esc(recipient.name) : ''}</div>
  ${bodyHtml}
</div>
</div>
<script>
var TOKEN=${JSON.stringify(req.params.token)};
async function submitResponse(){
  var inputs=document.querySelectorAll('.line-price');
  var lines=[];
  inputs.forEach(function(el){
    var v=el.value.trim();
    lines.push({line_id:Number(el.getAttribute('data-line-id')), unit_price: v===''?null:Number(v)});
  });
  var msgEl=document.getElementById('resp-message');
  var btn=document.getElementById('resp-btn');btn.disabled=true;btn.textContent='Sender...';
  try{
    var r=await fetch('/api/public/requests/'+TOKEN+'/respond',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({lines:lines, message: msgEl?msgEl.value.trim():''})});
    var d=await r.json().catch(function(){return{};});
    if(r.ok&&d.ok){window.location.reload();}
    else{alert(d.error||'Der skete en fejl');btn.disabled=false;btn.textContent='Send din pris';}
  }catch(e){alert('Netværksfejl — prøv igen');btn.disabled=false;btn.textContent='Send din pris';}
}
</script>
</body></html>`;
  res.send(html);
}));

app.post('/api/public/requests/:token/respond', asyncRoute(async (req, res) => {
  const recipient = await pgOne('SELECT * FROM quote_request_recipients WHERE token=$1', [req.params.token]);
  if (!recipient) return res.status(404).json({ error: 'Linket blev ikke fundet' });
  if (recipient.status === 'responded') return res.status(400).json({ error: 'Der er allerede sendt et svar via dette link' });
  const b = req.body || {};
  const lines = Array.isArray(b.lines) ? b.lines.filter(l => l && l.line_id) : [];
  await pool.query(`
    UPDATE quote_request_recipients SET status='responded', responses=$1, responded_at=${nowTextSQL()}
    WHERE id=$2
  `, [JSON.stringify({ lines, message: b.message || '' }), recipient.id]);
  res.json({ ok: true });
}));

// ══════════════════════════════════════════════════════════════
// DATABACKUP — admin trykker selv på "Download backup" i Timer & log-siden;
// ingen automatisk skema/e-mail (bevidst valg, se svar i chatten). Finder ALLE
// tabeller dynamisk via Postgres' egen katalog i stedet for en hårdkodet liste,
// så en tabel der tilføjes senere automatisk kommer med i backuppen uden at
// nogen skal huske at opdatere denne kode. Meget store felter (fx base64-
// vedhæftninger på noter) erstattes med en kort note i stedet for at blive
// taget med, så filen altid er hurtig at generere og hente.
// ══════════════════════════════════════════════════════════════
app.get('/api/backup/export', auth, adminOnly, asyncRoute(async (req, res) => {
  const MAX_FIELD_LEN = 200000;
  let truncatedFields = 0;
  const tablesResult = await pool.query(`
    SELECT table_name FROM information_schema.tables
    WHERE table_schema='public' AND table_type='BASE TABLE'
    ORDER BY table_name
  `);
  const data = {};
  for (const { table_name } of tablesResult.rows) {
    const rows = await pool.query(`SELECT * FROM "${table_name}"`);
    data[table_name] = rows.rows.map((row) => {
      const out = {};
      for (const [key, value] of Object.entries(row)) {
        if (typeof value === 'string' && value.length > MAX_FIELD_LEN) {
          out[key] = `[UDELADT FRA BACKUP — ${value.length} tegn, sandsynligvis en vedhæftet fil eller stort dokument]`;
          truncatedFields++;
        } else {
          out[key] = value;
        }
      }
      return out;
    });
  }
  const payload = {
    app: 'Gulv Master Enterprise',
    generated_at: new Date().toISOString(),
    generated_by: req.user.email || req.user.id,
    table_count: Object.keys(data).length,
    truncated_fields: truncatedFields,
    data
  };
  const filename = `gulvmaster-backup-${new Date().toISOString().slice(0, 10)}.json`;
  res.setHeader('Content-Type', 'application/json');
  res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
  res.send(JSON.stringify(payload));
}));

// ══════════════════════════════════════════════════════════════
// KUNDEPORTAL — offentlig statusside, ingen login. Skal stå FØR de generelle
// sendPage/catch-all-ruter nedenfor (ellers ville "app.get('*', ...)" allerede
// have grebet '/portal/:token' og altid returneret index.html i stedet).
// ══════════════════════════════════════════════════════════════
function portalNotFoundPage() {
  return `<!doctype html><html lang="da"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Link ikke fundet</title><style>
body{font-family:-apple-system,Segoe UI,Roboto,Arial,sans-serif;background:#F4F6FB;color:#111318;display:flex;align-items:center;justify-content:center;min-height:100vh;margin:0;padding:24px;text-align:center}
.card{background:#fff;border-radius:16px;padding:32px 24px;max-width:380px;box-shadow:0 8px 30px rgba(15,17,24,.08)}
h1{font-size:18px;margin:0 0 8px}
p{font-size:13.5px;color:#6B7280;line-height:1.5;margin:0}
</style></head><body><div class="card"><h1>🔍 Linket blev ikke fundet</h1><p>Dette link er enten forkert, eller booking er blevet slettet. Kontakt os hvis du er i tvivl.</p></div></body></html>`;
}
app.get('/portal/:token', asyncRoute(async (req, res) => {
  const row = await pgOne(`
    SELECT b.id,b.start_date,b.end_date,b.start_time,b.completed_at,
           t.job_name,t.job_address,
           u.name AS user_name
    FROM planning_bookings b
    JOIN jt_tasks t ON b.task_id=t.id
    LEFT JOIN users u ON b.user_id=u.id
    WHERE b.public_token=$1
  `, [req.params.token]);
  res.set('Cache-Control', 'no-store');
  if (!row) return res.status(404).send(portalNotFoundPage());
  const settingsRow = await pgOne("SELECT value FROM app_settings WHERE key='company_name'");
  const companyName = settingsRow?.value || 'Gulv Master Enterprise';
  const todayIso = new Date().toISOString().slice(0, 10);
  const startIso = String(row.start_date).slice(0, 10), endIso = String(row.end_date || row.start_date).slice(0, 10);
  let statusLabel, statusBg, statusFg;
  if (row.completed_at) { statusLabel = '✅ Afsluttet'; statusBg = '#DCFCE7'; statusFg = '#15803D'; }
  else if (todayIso >= startIso && todayIso <= endIso) { statusLabel = '🔧 Vi er hos dig i dag'; statusBg = '#FEF3C7'; statusFg = '#92400E'; }
  else { statusLabel = '📅 Planlagt'; statusBg = '#DBEAFE'; statusFg = '#1D4ED8'; }
  const fmt = (d) => new Date(d).toLocaleDateString('da-DK', { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric' });
  const dateLabel = startIso === endIso ? fmt(startIso) : `${fmt(startIso)} – ${fmt(endIso)}`;
  const esc = (s) => String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#039;' }[c]));
  const html = `<!doctype html><html lang="da"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Status på din opgave — ${esc(companyName)}</title><style>
:root{--ink:#111318;--sub:#6B7280;--border:#E5E7EB;--accent:#4F46E5}
*{box-sizing:border-box}
body{font-family:-apple-system,Segoe UI,Roboto,Arial,sans-serif;background:#F4F6FB;color:var(--ink);margin:0;padding:28px 16px;min-height:100vh}
.wrap{max-width:440px;margin:0 auto}
.brand{font-size:12.5px;font-weight:800;color:var(--accent);letter-spacing:.02em;text-transform:uppercase;margin-bottom:14px;text-align:center}
.card{background:#fff;border-radius:18px;padding:26px 22px;box-shadow:0 10px 34px rgba(15,17,24,.09)}
.status{display:inline-block;font-size:13px;font-weight:800;padding:6px 14px;border-radius:999px;background:${statusBg};color:${statusFg};margin-bottom:16px}
h1{font-size:19px;margin:0 0 4px;line-height:1.3}
.row{display:flex;gap:10px;padding:12px 0;border-top:1px solid var(--border)}
.row:first-of-type{border-top:none;margin-top:6px}
.row .ico{font-size:16px;width:22px;flex-shrink:0;text-align:center}
.row .lbl{font-size:10.5px;color:var(--sub);font-weight:700;text-transform:uppercase;letter-spacing:.03em;margin-bottom:2px}
.row .val{font-size:14px;font-weight:600}
.foot{text-align:center;font-size:11.5px;color:var(--sub);margin-top:18px}
</style></head><body><div class="wrap">
<div class="brand">${esc(companyName)}</div>
<div class="card">
<span class="status">${statusLabel}</span>
<h1>${esc(row.job_name || 'Din opgave')}</h1>
<div class="row"><div class="ico">📅</div><div><div class="lbl">Dato</div><div class="val">${esc(dateLabel)}</div></div></div>
<div class="row"><div class="ico">🕒</div><div><div class="lbl">Tidspunkt</div><div class="val">${row.start_time ? esc(row.start_time) : 'Vi kontakter dig med et præcist tidspunkt'}</div></div></div>
${row.job_address ? `<div class="row"><div class="ico">📍</div><div><div class="lbl">Adresse</div><div class="val">${esc(row.job_address)}</div></div></div>` : ''}
${row.user_name ? `<div class="row"><div class="ico">👷</div><div><div class="lbl">Din montør</div><div class="val">${esc(row.user_name)}</div></div></div>` : ''}
</div>
<div class="foot">Spørgsmål? Kontakt ${esc(companyName)} direkte.</div>
</div></body></html>`;
  res.send(html);
}));

// ══════════════════════════════════════════════════════════════
// KUNDEPORTAL 2.0 — /kunde/:token. Modsat /portal/:token ovenfor (som kun viser ÉN
// booking) viser denne siden ALT hvad kunden nogensinde har haft hos os, med et
// pipeline-overblik og en kronologisk timeline — samme data og samme
// status-logik som den interne Kundehistorik-side i admin, bare kundevendt og
// uden login. Linket er permanent: samme kunde, samme link, for altid.
// ══════════════════════════════════════════════════════════════
app.get('/kunde/:token', asyncRoute(async (req, res) => {
  res.set('Cache-Control', 'no-store');
  const esc = (s) => String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#039;' }[c]));
  const tokenRow = await pgOne('SELECT job_name FROM customer_portal_tokens WHERE token=$1', [req.params.token]);
  if (!tokenRow) return res.status(404).send(portalNotFoundPage());
  const settingsRow = await pgOne("SELECT value FROM app_settings WHERE key='company_name'");
  const companyName = settingsRow?.value || 'Gulv Master Enterprise';

  const tasksRes = await pool.query(`
    SELECT id,name,job_id,job_name,job_address,job_number,start_date,end_date,created_at
    FROM jt_tasks
    WHERE lower(trim(job_name))=lower(trim($1))
    ORDER BY start_date DESC NULLS LAST, created_at DESC
  `, [tokenRow.job_name]);
  const tasks = tasksRes.rows;
  let bookings = [];
  if (tasks.length) {
    const bookingsRes = await pool.query(`
      SELECT b.id,b.task_id,b.start_date,b.end_date,b.start_time,b.completed_at,u.name AS user_name
      FROM planning_bookings b
      LEFT JOIN users u ON b.user_id=u.id
      WHERE b.task_id = ANY($1::text[]) AND COALESCE(b.planning_mode,'daily')='daily'
      ORDER BY b.start_date DESC NULLS LAST, b.id DESC
    `, [tasks.map(t => t.id)]);
    bookings = bookingsRes.rows;
  }

  // FAKTURAER & TILBUD — hentes LIVE fra JobTread hver gang siden åbnes (ligesom
  // Økonomi-modulet i admin gør), i stedet for at bygge en helt ny synk-pipeline
  // bare for denne side. Fejler JobTread-kaldet (nede, timeout osv.), skal resten
  // af portalsiden stadig virke — derfor er dette pakket for sig selv.
  const jobIds = [...new Set(tasks.map(t => t.job_id).filter(Boolean))];
  let documents = [], documentsError = null;
  if (jobIds.length && JT_ORG && JT_GRANT) {
    try {
      const docsData = await jtFetch({ query: { $: { grantKey: JT_GRANT }, organization: { $: { id: JT_ORG }, jobs: {
        $: { size: jobIds.length, where: ['id', 'in', jobIds] },
        nodes: { id: {}, name: {}, documents: { $: { size: 20, where: ['type', 'in', ['customerOrder', 'customerInvoice']] }, nodes: { type: {}, status: {}, price: {}, priceWithTax: {}, createdAt: {} } } }
      } } } }, 'Kundeportal: hent tilbud/fakturaer');
      for (const j of docsData?.organization?.jobs?.nodes || []) {
        for (const d of j.documents?.nodes || []) documents.push({ ...d, jobName: j.name });
      }
    } catch (e) { documentsError = e.message; console.error('Kundeportal: kunne ikke hente tilbud/fakturaer:', e.message); }
  }

  // EGNE TILBUD & FAKTURAER (vores Postgres-tabeller, se Tilbud & Faktura-modulet
  // i admin) — matchet på samme normaliserede job_name som resten af portalen.
  // Dette er nu den PRIMÆRE kilde; JobTread-dokumenterne ovenfor vises kun som
  // fallback for sager der endnu ikke bruger det nye tilbuds-/fakturamodul.
  const ourQuotes = (await pool.query(
    `SELECT * FROM quotes WHERE lower(trim(job_name))=lower(trim($1)) ORDER BY created_at DESC`,
    [tokenRow.job_name]
  )).rows;
  const ourInvoices = (await pool.query(
    `SELECT * FROM invoices WHERE lower(trim(job_name))=lower(trim($1)) ORDER BY created_at DESC`,
    [tokenRow.job_name]
  )).rows;

  // PROJEKT-TIDSLINJE — læses direkte fra gantt_tasks (samme tabel som admins
  // Gantt-kort), IKKE fra planning_bookings. Det er bevidst: kunden skal se det
  // samme projektforløb Martin selv redigerer i Gantt-kortet, og det skal opdatere
  // sig selv, næste gang han synker det job i admin — uden at kundeportalen selv
  // rammer JobTread (det gør admin allerede, når han trykker "Synk").
  let projectTasks = [];
  if (jobIds.length) {
    const ganttRes = await pool.query('SELECT * FROM gantt_tasks WHERE job_id = ANY($1::text[]) ORDER BY job_id, position ASC, id ASC', [jobIds]);
    projectTasks = ganttRes.rows;
  }

  const byTask = {};
  bookings.forEach(b => { (byTask[b.task_id] = byTask[b.task_id] || []).push(b); });
  const todayIso = new Date().toISOString().slice(0, 10);
  function statusForTask(tb) {
    if (!tb.length) return { key: 'pending', label: '🕓 Afventer planlægning', bg: '#F1F5F9', fg: '#475569' };
    if (tb.every(b => b.completed_at)) return { key: 'done', label: '✅ Afsluttet', bg: '#DCFCE7', fg: '#15803D' };
    if (tb.some(b => !b.completed_at && todayIso >= String(b.start_date).slice(0, 10) && todayIso <= String(b.end_date || b.start_date).slice(0, 10))) {
      return { key: 'active', label: '🔧 I gang', bg: '#FEF3C7', fg: '#92400E' };
    }
    if (tb.some(b => !b.completed_at && String(b.start_date).slice(0, 10) > todayIso)) return { key: 'planned', label: '📅 Planlagt', bg: '#DBEAFE', fg: '#1D4ED8' };
    return { key: 'active', label: '🔧 I gang', bg: '#FEF3C7', fg: '#92400E' };
  }
  const fmt = (d) => new Date(d).toLocaleDateString('da-DK', { weekday: 'short', day: 'numeric', month: 'long', year: 'numeric' });
  const doneCount = tasks.filter(t => { const tb = byTask[t.id] || []; return tb.length && tb.every(b => b.completed_at); }).length;

  const pipelineGroups = [
    { key: 'active', label: '🔧 I gang' },
    { key: 'planned', label: '📅 Planlagt' },
    { key: 'pending', label: '🕓 Afventer planlægning' },
    { key: 'done', label: '✅ Afsluttet' }
  ];
  const pipelineHtml = pipelineGroups.map(group => {
    const jobsInGroup = tasks.filter(t => statusForTask(byTask[t.id] || []).key === group.key);
    if (!jobsInGroup.length) return '';
    const cards = jobsInGroup.map(t => {
      const tb = (byTask[t.id] || []).slice().sort((a, b) => String(b.start_date || '').localeCompare(String(a.start_date || '')));
      const st = statusForTask(tb);
      const dateRange = t.start_date ? (t.end_date && t.end_date !== t.start_date ? `${fmt(t.start_date)} – ${fmt(t.end_date)}` : fmt(t.start_date)) : '';
      const montor = tb.find(b => b.user_name)?.user_name;
      return `<div class="job-card">
        <div class="job-top"><div class="job-title">${esc(t.job_name || t.name || 'Opgave')}</div><span class="pill" style="background:${st.bg};color:${st.fg}">${st.label}</span></div>
        ${dateRange ? `<div class="job-meta">📅 ${esc(dateRange)}</div>` : ''}
        ${t.job_address ? `<div class="job-meta">📍 ${esc(t.job_address)}</div>` : ''}
        ${montor ? `<div class="job-meta">👷 ${esc(montor)}</div>` : ''}
      </div>`;
    }).join('');
    return `<div class="group"><div class="group-label">${group.label} <span class="group-count">${jobsInGroup.length}</span></div>${cards}</div>`;
  }).join('') || '<div class="empty">Ingen opgaver fundet endnu.</div>';

  // TIDSLINJE — bygget som en statisk (skrivebeskyttet) udgave af det samme
  // Gantt-kort-layout som admin bruger (dag/uge-gitter + vandrette bjælker),
  // så kunden ser "samme tidslinje, samme layout" som i admin, bare uden
  // træk/slip eller afhængighedspile som ikke giver mening for en kunde.
  let ganttScrollToday = 0, ganttDayWidth = 34;
  const ganttHtml = (() => {
    const tasksWithDates = projectTasks.filter(t => t.start_date);
    if (!tasksWithDates.length) {
      return '<div class="empty">Projektets tidslinje er ikke synkroniseret endnu — kontakt ' + esc(companyName) + ' hvis den mangler i et stykke tid.</div>';
    }
    const multiJob = new Set(tasksWithDates.map(t => t.job_id)).size > 1;
    const jobNameById = {};
    tasks.forEach(t => { if (t.job_id) jobNameById[t.job_id] = t.job_name; });
    const parseIso = (s) => new Date(String(s).slice(0, 10) + 'T00:00:00');
    const starts = tasksWithDates.map(t => parseIso(t.start_date));
    const ends = tasksWithDates.map(t => parseIso(t.end_date || t.start_date));
    const today = new Date(todayIso + 'T00:00:00');
    let rangeStart = new Date(Math.min(...starts, today));
    let rangeEnd = new Date(Math.max(...ends, today));
    rangeStart.setDate(rangeStart.getDate() - 3);
    rangeEnd.setDate(rangeEnd.getDate() + 5);
    const totalDays = Math.max(1, Math.round((rangeEnd - rangeStart) / 86400000) + 1);
    const dw = totalDays <= 45 ? 34 : (totalDays <= 90 ? 20 : 10);
    ganttDayWidth = dw;
    const showDayLabels = dw >= 20;
    const DAYABBR = ['Sø', 'Ma', 'Ti', 'On', 'To', 'Fr', 'Lø'];
    const weekNoOf = (d) => {
      const dt = new Date(Date.UTC(d.getFullYear(), d.getMonth(), d.getDate()));
      const dayNum = dt.getUTCDay() || 7;
      dt.setUTCDate(dt.getUTCDate() + 4 - dayNum);
      const yearStart = new Date(Date.UTC(dt.getUTCFullYear(), 0, 1));
      return Math.ceil((((dt - yearStart) / 86400000) + 1) / 7);
    };
    let headCols = '', weekCols = '', bgCols = '', curWeekSpan = 0, curWeekLabel = '';
    const flushWeek = () => { if (curWeekSpan > 0) weekCols += `<div class="g-week-col" style="width:${curWeekSpan * dw}px">${curWeekLabel}</div>`; };
    for (let i = 0; i < totalDays; i++) {
      const d = new Date(rangeStart); d.setDate(d.getDate() + i);
      const iso = d.toISOString().slice(0, 10);
      const isWeekend = d.getDay() === 0 || d.getDay() === 6;
      const isToday = iso === todayIso;
      if (isToday) ganttScrollToday = i * dw;
      headCols += `<div class="g-day-col${isWeekend ? ' weekend' : ''}${isToday ? ' today' : ''}" style="width:${dw}px">${showDayLabels ? DAYABBR[d.getDay()] + '<br>' + d.getDate() : ''}</div>`;
      bgCols += `<div class="g-bg-col${isWeekend ? ' weekend' : ''}${isToday ? ' today' : ''}" style="width:${dw}px"></div>`;
      if (d.getDay() === 1 || i === 0) { flushWeek(); curWeekSpan = 0; curWeekLabel = 'Uge ' + weekNoOf(d); }
      curWeekSpan++;
    }
    flushWeek();
    const sorted = tasksWithDates.slice().sort((a, b) => String(a.start_date || '').localeCompare(String(b.start_date || '')));
    let listRows = '';
    let barRows = '';
    sorted.forEach(t => {
      const label = t.name || 'Opgave';
      const jobLabel = multiJob ? (jobNameById[t.job_id] || '') : '';
      listRows += `<div class="g-list-row"><div class="g-list-row-title">${esc(label)}</div>${jobLabel ? `<div class="g-list-row-sub">${esc(jobLabel)}</div>` : ''}</div>`;
      const s = parseIso(t.start_date), e = parseIso(t.end_date || t.start_date);
      const offset = Math.round((s - rangeStart) / 86400000);
      const span = Math.max(1, Math.round((e - s) / 86400000) + 1);
      // Kun to farver, bevidst — kunden skal ikke bruge tid på at afkode nuancer:
      // grøn når opgaven er markeret 100% færdig i Gantt-kortet, ellers grå.
      const done = Number(t.progress || 0) >= 1;
      const barColor = done ? '#22C55E' : '#94A3B8';
      barRows += `<div class="g-row"><div class="g-row-bg">${bgCols}</div><div class="g-bar" style="left:${offset * dw}px;width:${Math.max(dw - 4, span * dw - 4)}px;background:${barColor}" title="${esc(label)}${jobLabel ? ' · ' + esc(jobLabel) : ''} (${t.start_date} – ${t.end_date || t.start_date})">${dw >= 22 ? `<span class="g-bar-label">${esc(label)}</span>` : ''}</div></div>`;
    });
    return `<div class="gantt-scroll" id="gantt-scroll"><div class="g-chart">
      <div class="g-list"><div class="g-list-head">Projektforløb</div>${listRows}</div>
      <div class="g-timeline" style="width:${totalDays * dw}px">
        <div class="g-week-head">${weekCols}</div>
        <div class="g-timeline-head">${headCols}</div>
        <div>${barRows}</div>
      </div>
    </div></div>
    <div class="gantt-legend"><span><i style="background:#22C55E"></i> Færdig</span><span><i style="background:#94A3B8"></i> Ikke færdig endnu</span></div>`;
  })();

  // FAKTURAER & TILBUD-fanen
  const STATUS_LABELS = {
    approved: { label: 'Godkendt', bg: '#DCFCE7', fg: '#15803D' },
    pending: { label: 'Afventer', bg: '#FEF3C7', fg: '#92400E' },
    denied: { label: 'Afvist', bg: '#FEE2E2', fg: '#B91C1C' }
  };
  const fmtKr = (n) => (n == null ? '' : Math.round(n).toLocaleString('da-DK') + ' kr.');
  const QUOTE_STATUS_LABELS = {
    draft: { label: 'Kladde', bg: '#F1F5F9', fg: '#475569' },
    sent: { label: 'Afventer din accept', bg: '#FEF3C7', fg: '#92400E' },
    accepted: { label: '✅ Underskrevet', bg: '#DCFCE7', fg: '#15803D' },
    declined: { label: 'Afvist', bg: '#FEE2E2', fg: '#B91C1C' },
    converted: { label: '✅ Godkendt & faktureret', bg: '#DCFCE7', fg: '#15803D' }
  };
  const INVOICE_STATUS_LABELS = {
    unpaid: { label: 'Ikke betalt', bg: '#FEF3C7', fg: '#92400E' },
    partial: { label: 'Delvist betalt', bg: '#FEF3C7', fg: '#92400E' },
    paid: { label: '✅ Betalt', bg: '#DCFCE7', fg: '#15803D' },
    void: { label: 'Annulleret', bg: '#FEE2E2', fg: '#B91C1C' }
  };
  const ourQuotesHtml = ourQuotes.map(q => {
    const st = QUOTE_STATUS_LABELS[q.status] || { label: q.status, bg: '#F1F5F9', fg: '#475569' };
    const needsSignature = q.status === 'draft' || q.status === 'sent';
    return `<div class="job-card">
      <div class="job-top"><div class="job-title">📄 Tilbud ${esc(q.quote_number)}</div><span class="pill" style="background:${st.bg};color:${st.fg}">${st.label}</span></div>
      <div class="job-meta doc-price">${fmtKr(Number(q.total))}</div>
      <div class="job-meta">📅 ${esc(fmt(q.created_at))}${q.valid_until ? ' · Gyldig til ' + esc(q.valid_until) : ''}</div>
      ${needsSignature && q.accept_token
        ? `<a class="doc-action doc-action-sign" href="/tilbud/${esc(q.accept_token)}">✍️ Se &amp; underskriv tilbud →</a>`
        : `<a class="doc-action" href="/kunde/${esc(req.params.token)}/tilbud/${q.id}/pdf" target="_blank" rel="noopener">📄 Se PDF →</a>`}
    </div>`;
  }).join('');
  const ourInvoicesHtml = ourInvoices.map(inv => {
    const st = INVOICE_STATUS_LABELS[inv.status] || { label: inv.status, bg: '#F1F5F9', fg: '#475569' };
    return `<div class="job-card">
      <div class="job-top"><div class="job-title">🧾 Faktura ${esc(inv.invoice_number)}</div><span class="pill" style="background:${st.bg};color:${st.fg}">${st.label}</span></div>
      <div class="job-meta doc-price">${fmtKr(Number(inv.total))}${Number(inv.paid_total) > 0 ? ' · betalt ' + fmtKr(Number(inv.paid_total)) : ''}</div>
      <div class="job-meta">📅 ${esc(fmt(inv.created_at))}${inv.due_date ? ' · Forfald ' + esc(inv.due_date) : ''}</div>
      <a class="doc-action" href="/kunde/${esc(req.params.token)}/faktura/${inv.id}/pdf" target="_blank" rel="noopener">📄 Se PDF →</a>
    </div>`;
  }).join('');
  const hasOwnDocs = ourQuotes.length > 0 || ourInvoices.length > 0;
  const docsHtml = (() => {
    if (hasOwnDocs) {
      return (ourQuotes.length ? `<div class="group"><div class="group-label">Tilbud <span class="group-count">${ourQuotes.length}</span></div>${ourQuotesHtml}</div>` : '')
        + (ourInvoices.length ? `<div class="group"><div class="group-label">Fakturaer <span class="group-count">${ourInvoices.length}</span></div>${ourInvoicesHtml}</div>` : '');
    }
    if (!documents.length) {
      if (documentsError) return '<div class="empty">Kunne ikke hente tilbud/fakturaer lige nu. Prøv at genindlæse siden om lidt.</div>';
      return '<div class="empty">Ingen tilbud eller fakturaer endnu.</div>';
    }
    return documents.slice().sort((a, b) => String(b.createdAt || '').localeCompare(String(a.createdAt || ''))).map(d => {
      const st = STATUS_LABELS[d.status] || { label: d.status || '', bg: '#F1F5F9', fg: '#475569' };
      const isInvoice = d.type === 'customerInvoice';
      const price = d.priceWithTax != null ? d.priceWithTax : d.price;
      return `<div class="job-card">
        <div class="job-top"><div class="job-title">${isInvoice ? '🧾 Faktura' : '📄 Tilbud'}</div><span class="pill" style="background:${st.bg};color:${st.fg}">${st.label}</span></div>
        ${d.jobName ? `<div class="job-meta">${esc(d.jobName)}</div>` : ''}
        ${price != null ? `<div class="job-meta doc-price">${fmtKr(price)}</div>` : ''}
        ${d.createdAt ? `<div class="job-meta">📅 ${esc(fmt(d.createdAt))}</div>` : ''}
      </div>`;
    }).join('');
  })();

  const html = `<!doctype html><html lang="da"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Din side hos ${esc(companyName)}</title><style>
:root{--ink:#111318;--sub:#6B7280;--border:#E5E7EB;--accent:#4F46E5;--accent-soft:#EEF2FF}
*{box-sizing:border-box}
body{font-family:-apple-system,Segoe UI,Roboto,Arial,sans-serif;background:#F4F6FB;color:var(--ink);margin:0;padding:24px 14px 40px;min-height:100vh}
.wrap{max-width:520px;margin:0 auto}
.brand{font-size:12.5px;font-weight:800;color:var(--accent);letter-spacing:.02em;text-transform:uppercase;margin-bottom:10px;text-align:center}
h1{font-size:20px;margin:0 0 14px;text-align:center}
.stats{display:flex;gap:8px;margin-bottom:16px}
.stat{flex:1;background:#fff;border-radius:14px;padding:12px;text-align:center;box-shadow:0 6px 20px rgba(15,17,24,.06)}
.stat b{display:block;font-size:20px}
.stat span{font-size:10.5px;color:var(--sub);font-weight:700;text-transform:uppercase;letter-spacing:.02em}
.tabs{display:flex;gap:6px;background:#E9ECF5;border-radius:12px;padding:4px;margin-bottom:16px}
.tab{flex:1;text-align:center;padding:9px;border-radius:9px;font-size:12.5px;font-weight:800;cursor:pointer;color:var(--sub)}
.tab.active{background:#fff;color:var(--accent);box-shadow:0 2px 8px rgba(15,17,24,.08)}
.panel{display:none}.panel.active{display:block}
.group{margin-bottom:18px}
.group-label{font-size:11.5px;font-weight:800;color:var(--sub);text-transform:uppercase;letter-spacing:.03em;margin-bottom:8px}
.group-count{background:#E5E7EB;border-radius:999px;padding:1px 7px;font-size:10px}
.job-card{background:#fff;border-radius:14px;padding:14px;margin-bottom:8px;box-shadow:0 4px 16px rgba(15,17,24,.06)}
.job-top{display:flex;align-items:flex-start;justify-content:space-between;gap:8px;margin-bottom:4px}
.job-title{font-weight:800;font-size:14px}
.pill{font-size:10.5px;font-weight:800;padding:3px 9px;border-radius:999px;white-space:nowrap}
.job-meta{font-size:12px;color:var(--sub);margin-top:3px}
.doc-price{font-weight:800;color:var(--ink);font-size:13px}
.doc-action{display:inline-block;margin-top:9px;font-size:12px;font-weight:800;color:var(--accent);text-decoration:none}
.doc-action:hover{text-decoration:underline}
.doc-action-sign{background:var(--accent-soft);color:var(--accent);padding:7px 12px;border-radius:9px;margin-top:10px}
.empty{text-align:center;color:var(--sub);font-size:13px;padding:24px 0}
.foot{text-align:center;font-size:11.5px;color:var(--sub);margin-top:20px}
.gantt-scroll{overflow-x:auto;-webkit-overflow-scrolling:touch;border:1px solid var(--border);border-radius:14px;background:#fff}
.g-chart{display:flex;min-width:max-content}
.g-list{width:150px;flex-shrink:0;border-right:1px solid #F0F1F4;position:sticky;left:0;background:#fff;z-index:3}
.g-list-head{height:56px;box-sizing:border-box;display:flex;align-items:flex-end;padding:0 10px 8px;font-size:9.5px;font-weight:800;text-transform:uppercase;letter-spacing:.02em;color:#A1A8B3;border-bottom:1px solid #F0F1F4}
.g-list-row{height:38px;box-sizing:border-box;display:flex;flex-direction:column;justify-content:center;padding:0 10px;border-bottom:1px solid #F5F6F8;overflow:hidden}
.g-list-row-title{font-size:11px;font-weight:800;color:#1F2937;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.g-list-row-sub{font-size:9.5px;color:var(--sub);white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.g-timeline{position:relative}
.g-week-head{height:22px;box-sizing:border-box;display:flex;background:#FAFBFC;border-bottom:1px solid #F0F1F4}
.g-week-col{flex-shrink:0;box-sizing:border-box;display:flex;align-items:center;justify-content:center;font-size:9.5px;font-weight:700;color:#3D4759;border-left:1px solid #F0F1F4}
.g-timeline-head{height:34px;box-sizing:border-box;display:flex;background:#fff;border-bottom:1px solid #F0F1F4}
.g-day-col{flex-shrink:0;box-sizing:border-box;display:flex;align-items:center;justify-content:center;font-size:8.5px;color:#A1A8B3;font-weight:700;line-height:1.15;border-right:1px solid #F5F6F8;text-align:center}
.g-day-col.weekend{background:#FAFBFC}
.g-day-col.today{color:var(--accent)}
.g-row{height:38px;position:relative}
.g-row-bg{position:absolute;inset:0;display:flex;border-bottom:1px solid #F5F6F8}
.g-bg-col{flex-shrink:0;box-sizing:border-box;border-right:1px solid #FAFBFC}
.g-bg-col.weekend{background:#FAFBFC}
.g-bg-col.today{background:#EEF2FF}
.g-bar{position:absolute;top:6px;height:26px;border-radius:13px;display:flex;align-items:center;padding:0 10px;box-shadow:0 2px 6px rgba(15,17,24,.12)}
.g-bar-label{color:#fff;font-size:10px;font-weight:700;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.gantt-legend{display:flex;gap:16px;justify-content:center;margin-top:8px;font-size:11px;color:var(--sub)}
.gantt-legend i{display:inline-block;width:9px;height:9px;border-radius:3px;margin-right:5px;vertical-align:middle}
</style></head><body><div class="wrap">
<div class="brand">${esc(companyName)}</div>
<h1>Hej ${esc(tokenRow.job_name)} 👋</h1>
<div class="stats">
  <div class="stat"><b>${tasks.length}</b><span>Opgaver</span></div>
  <div class="stat"><b>${doneCount}</b><span>Afsluttet</span></div>
  <div class="stat"><b>${bookings.length}</b><span>Besøg</span></div>
</div>
<div class="tabs">
  <div class="tab active" id="tab-pipeline" onclick="showTab('pipeline')">Oversigt</div>
  <div class="tab" id="tab-timeline" onclick="showTab('timeline')">Timeline</div>
  <div class="tab" id="tab-docs" onclick="showTab('docs')">Tilbud &amp; Faktura</div>
</div>
<div class="panel active" id="panel-pipeline">${pipelineHtml}</div>
<div class="panel" id="panel-timeline">${ganttHtml}</div>
<div class="panel" id="panel-docs">${docsHtml}</div>
<div class="foot">Spørgsmål? Kontakt ${esc(companyName)} direkte.</div>
</div>
<script>
function showTab(name){
  ['pipeline','timeline','docs'].forEach(function(n){
    document.getElementById('tab-'+n).classList.toggle('active',n===name);
    document.getElementById('panel-'+n).classList.toggle('active',n===name);
  });
  if(name==='timeline'){
    var sc=document.getElementById('gantt-scroll');
    if(sc) sc.scrollLeft=Math.max(0,${ganttScrollToday}-${ganttDayWidth}*2);
  }
}
</script>
</body></html>`;
  res.send(html);
}));

// PDF-download scopet til kundeportal-tokenet — kunden har allerede det trygge
// link, så vi tjekker blot at tilbuddet/fakturaen faktisk hører til SAMME
// job_name som portalen, før vi sender PDF'en, i stedet for at kræve login.
app.get('/kunde/:token/tilbud/:quoteId/pdf', asyncRoute(async (req, res) => {
  const tokenRow = await pgOne('SELECT job_name FROM customer_portal_tokens WHERE token=$1', [req.params.token]);
  if (!tokenRow) return res.status(404).send(portalNotFoundPage());
  const quote = await loadQuoteFull(req.params.quoteId);
  if (!quote || String(quote.job_name || '').trim().toLowerCase() !== String(tokenRow.job_name || '').trim().toLowerCase()) {
    return res.status(404).send(portalNotFoundPage());
  }
  const company = await getCompanyInfo();
  logDocActivity('quote', quote.id, 'viewed', 'Kunde', 'PDF via kundeportal');
  res.set('Content-Type', 'application/pdf');
  res.set('Content-Disposition', `inline; filename="${quote.quote_number}.pdf"`);
  const doc = new PDFDocument({ size: 'A4', margin: 40 });
  doc.pipe(res);
  drawDocumentPdf(doc, 'quote', quote, company);
  doc.end();
}));
app.get('/kunde/:token/faktura/:invoiceId/pdf', asyncRoute(async (req, res) => {
  const tokenRow = await pgOne('SELECT job_name FROM customer_portal_tokens WHERE token=$1', [req.params.token]);
  if (!tokenRow) return res.status(404).send(portalNotFoundPage());
  const invoice = await loadInvoiceFull(req.params.invoiceId);
  if (!invoice || String(invoice.job_name || '').trim().toLowerCase() !== String(tokenRow.job_name || '').trim().toLowerCase()) {
    return res.status(404).send(portalNotFoundPage());
  }
  const company = await getCompanyInfo();
  logDocActivity('invoice', invoice.id, 'viewed', 'Kunde', 'PDF via kundeportal');
  res.set('Content-Type', 'application/pdf');
  res.set('Content-Disposition', `inline; filename="${invoice.invoice_number}.pdf"`);
  const doc = new PDFDocument({ size: 'A4', margin: 40 });
  doc.pipe(res);
  drawDocumentPdf(doc, 'invoice', invoice, company);
  doc.end();
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
// DEMO — viser hvordan employee.html kunne se ud hvis "⏱ Track your time" og
// "🛡 Kvalitetskontrol form" åbnede en formular i selve appen (mod den sag
// opgaven hører til) i stedet for at sende medarbejderen ud til JobTread. Helt
// separat fil/rute fra /employee, så det rigtige medarbejder-login er 100%
// upåvirket — kun til Martins egen gennemgang.
app.get('/employee-demo', sendPage('employee-demo.html'));
// Service worker skal ligge på roden (ikke i en undermappe) for at få lov til at
// kontrollere hele sitet ("scope") — ellers kan den kun styre /sw-mappen.
app.get('/sw.js', (req, res) => {
  res.set('Content-Type', 'application/javascript; charset=utf-8');
  res.set('Cache-Control', 'no-store, no-cache, must-revalidate');
  res.set('Service-Worker-Allowed', '/');
  res.sendFile(path.join(__dirname, 'sw.js'));
});
app.get('/manifest.webmanifest', (req, res) => {
  res.set('Content-Type', 'application/manifest+json; charset=utf-8');
  res.sendFile(path.join(__dirname, 'manifest.webmanifest'));
});
app.get('/icon-192.png', (req, res) => res.sendFile(path.join(__dirname, 'icon-192.png')));
app.get('/icon-512.png', (req, res) => res.sendFile(path.join(__dirname, 'icon-512.png')));
app.get('/', sendPage('index.html'));
app.get('*', sendPage('index.html'));

app.use((error, req, res, next) => {
  console.error('Unhandled error:', error);
  if (res.headersSent) return next(error);
  const message = error instanceof multer.MulterError ? 'Upload fejlede: filen er for stor eller ugyldig.' : (error.message || 'Serverfejl');
  res.status(500).json({ error: message });
});

// ÉNGANGS-EFTERUDFYLDNING: sags-opgaver (gantt_tasks med project_id) der blev
// oprettet FØR mirrorProjectTaskToPool() fandtes, har ingen spejl-række i
// jt_tasks — så de kan hverken ses i Opgavepool eller bookes på Kapacitetsboardet
// ("Opgaven blev ikke fundet"). Kører ved hver opstart, men er billig og
// no-op'er for alt der allerede er spejlet (LEFT JOIN ... WHERE jt.id IS NULL).
async function backfillProjectTaskMirrors() {
  // OBS: "gt.id" og "p.id" hedder begge "id" — de må IKKE begge selectes som
  // p.*/gt.* uden alias, for så vinder den sidste af de to i det resulterende
  // JS-objekt (node-postgres kollapser dubletnavne), og man ender med at
  // "opgavens id" i virkeligheden er sagens id. Derfor eksplicitte aliaser her.
  const rows = await pool.query(`
    SELECT gt.id AS gt_id, gt.name AS gt_name, gt.start_date AS gt_start, gt.end_date AS gt_end, gt.description AS gt_desc,
           p.id AS p_id, p.name AS p_name, p.customer_address AS p_address, p.customer_phone AS p_phone, p.customer_email AS p_email
    FROM gantt_tasks gt
    JOIN projects p ON p.id = gt.project_id
    LEFT JOIN jt_tasks jt ON jt.id = gt.id
    WHERE gt.project_id IS NOT NULL AND jt.id IS NULL
  `);
  for (const r of rows.rows) {
    const project = { id: r.p_id, name: r.p_name, customer_address: r.p_address, customer_phone: r.p_phone, customer_email: r.p_email };
    await mirrorProjectTaskToPool(r.gt_id, project, { name: r.gt_name, start_date: r.gt_start, end_date: r.gt_end, description: r.gt_desc || '' });
  }
  if (rows.rowCount) console.log(`Efterudfyldte ${rows.rowCount} sags-opgave(r) i Opgavepoolen (oprettet før dette fandtes).`);
}

async function start() {
  await pool.query('SELECT 1 AS connected');
  await initSchema();
  await backfillProjectTaskMirrors().catch(error => console.error('Efterudfyldning af sags-opgaver fejlede:', error.message));
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
  // Profit-analyse — gemmer et fast snapshot af indeværende måned kl. 08 d. 15. hver
  // måned, så Martin kan sammenligne måned for måned uden at tallene ændrer sig
  // bagefter. Kan også udløses manuelt via "Gem nu"-knappen i Oversigt.
  cron.schedule('0 8 15 * *', () => saveMonthlyProfitSnapshot().catch(e => { console.error('Profit-snapshot fejlede:', e.message); logSystemEvent('profit_snapshot', 'error', 'Månedligt profit-snapshot fejlede: ' + e.message); }));
}

start().catch(error => {
  console.error('FATAL STARTUP ERROR:', error.message);
  process.exit(1);
});
