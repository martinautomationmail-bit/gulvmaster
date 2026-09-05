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
// verify: gemmer den RÅ request-body på req.rawBody, udelukkende brugt til at
// verificere Close CRM-webhookets signatur (se CLOSE-integrationen nederst i
// filen) — Close signerer den originale byte-for-byte body, ikke den
// genparsede/genserialiserede JSON, så den skal fanges her inden parsing.
app.use(express.json({ limit: '20mb', verify: (req, res, buf) => { req.rawBody = buf; } }));
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
// Éngangsimport af Martins historiske Close CRM-data (leads.csv + opportunities.csv-
// eksport) — se POST /api/admin/import/close. 25mb pr. fil er rigeligt til flere
// tusinde rækker Close-eksport (de rigtige filer er 4-5mb hver).
const uploadCloseImport = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 25 * 1024 * 1024, files: 2 },
  fileFilter: (req, file, cb) => {
    const lower = String(file.originalname || '').toLowerCase();
    if (!lower.endsWith('.csv')) return cb(new Error('Vælg en CSV-fil eksporteret fra Close.'));
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

    -- ROLLER & ADGANG (sep. 2026, Martins ønske): et selvstændigt lag ved siden
    -- af den eksisterende role-kolonne ('admin'/'employee', som bruges vidt
    -- omkring til "er dette en planlægbar medarbejder"-filtrering og IKKE må
    -- ændres af dette) og is_finance_admin (som fortsætter helt uændret).
    -- panel_roles = de brugerdefinerede roller Martin selv opretter (fx
    -- "Kontor", "Mester") med et sæt sider hver. panel_role_id på en bruger er
    -- valgfri og UAFHÆNGIG af role/is_finance_admin — en "Mester" kan sagtens
    -- beholde role='employee' (så vedkommende stadig kan planlægges/tildeles
    -- opgaver som normalt og fortsat bruger den rigtige medarbejder-app) OG
    -- samtidig få adgang til nogle få sider i admin-panelet oveni.
    CREATE TABLE IF NOT EXISTS panel_roles (
      id SERIAL PRIMARY KEY,
      name TEXT NOT NULL UNIQUE,
      is_builtin INTEGER NOT NULL DEFAULT 0,
      position INTEGER NOT NULL DEFAULT 0,
      created_at TEXT DEFAULT ${nowTextSQL()}
    );
    CREATE TABLE IF NOT EXISTS panel_role_pages (
      role_id INTEGER NOT NULL REFERENCES panel_roles(id) ON DELETE CASCADE,
      page_key TEXT NOT NULL,
      PRIMARY KEY (role_id, page_key)
    );
    -- Undtagelser pr. person, oveni rollens standardsæt — allowed=1 giver ekstra
    -- adgang udover rollen, allowed=0 fjerner en side rollen ellers ville give.
    CREATE TABLE IF NOT EXISTS panel_user_overrides (
      user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      page_key TEXT NOT NULL,
      allowed INTEGER NOT NULL,
      PRIMARY KEY (user_id, page_key)
    );
    ALTER TABLE users ADD COLUMN IF NOT EXISTS panel_role_id INTEGER REFERENCES panel_roles(id) ON DELETE SET NULL;
    CREATE INDEX IF NOT EXISTS idx_users_panel_role ON users(panel_role_id);

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
    -- Eget "allerede sendt"-flag til "Vi kommer i DAG"-mailen (adskilt fra
    -- reminder_email_sent_at ovenfor, som er til "i morgen"), så de to
    -- påmindelser ikke blokerer hinanden.
    ALTER TABLE planning_bookings ADD COLUMN IF NOT EXISTS reminder_today_email_sent_at TEXT;

    -- PUSH/SMS-NOTIFIKATIONER (medarbejder-push + kunde-SMS "din montør kommer").
    ALTER TABLE users ADD COLUMN IF NOT EXISTS phone TEXT;

    -- HOLDOVERBLIK & KORT I MEDARBEJDER-APPEN: kun medarbejdere Martin selv har
    -- krydset af (fx en mester) kan åbne kortet og se hvor kollegerne er booket,
    -- og hvad de er tilknyttet resten af ugen. Admin har altid adgang uanset dette flag.
    ALTER TABLE users ADD COLUMN IF NOT EXISTS can_view_team_overview INTEGER DEFAULT 0;

    -- LØN & AKKORD (sep. 2026, Martins ønske): pay_type styrer om en medarbejder aflønnes
    -- pr. time (hourly_wage, kr/time) eller pr. akkord (stykpris fra akkord_items, se
    -- nedenfor) — akkord ERSTATTER timeløn helt for den medarbejder, jf. Martins valg.
    -- Bruges til projektets budget-dashboard til at trække reelle lønomkostninger fra
    -- fortjenesten. Tomt/0 som standard, påvirker intet før Martin selv udfylder det.
    ALTER TABLE users ADD COLUMN IF NOT EXISTS pay_type TEXT NOT NULL DEFAULT 'hourly'; -- 'hourly' | 'akkord'
    ALTER TABLE users ADD COLUMN IF NOT EXISTS hourly_wage NUMERIC NOT NULL DEFAULT 0;

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
    -- Note (sep. 2026, Martins ønske): adskilt fra 'description' — vises på tilbud/faktura i
    -- sin egen fremhævede boks UNDER beskrivelsen (fx forbehold/vigtige bemærkninger), i
    -- stedet for at blande sig ind i selve produktbeskrivelsen. Arves til quote_lines/
    -- invoice_lines.note når produktet vælges på en linje (se qzMakeBlankLine i admin.html).
    ALTER TABLE products ADD COLUMN IF NOT EXISTS note TEXT;

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
    -- 'item' (almindelig linje med antal/pris) eller 'text' (ren tekst-/overskriftslinje,
    -- ingen antal/pris — bruges til at bryde et langt tilbud op med overskrifter/noter).
    ALTER TABLE quote_lines ADD COLUMN IF NOT EXISTS line_type TEXT NOT NULL DEFAULT 'item';
    -- Note pr. linje (sep. 2026, Martins ønske) — se kommentar ved products.note. Vises i
    -- egen boks under beskrivelsen på både tilbuds-PDF'en og kundens tilbudsside.
    ALTER TABLE quote_lines ADD COLUMN IF NOT EXISTS note TEXT;
    -- Note i TOPPEN af tilbuddet (under kundeoplysninger) — adskilt fra "notes" som vises
    -- i BUNDEN (typisk betingelser). Begge kan forudfyldes fra en standardtekst i
    -- Indstillinger (quote_top_note_default/quote_bottom_note_default), men redigeres frit
    -- pr. tilbud herfra.
    ALTER TABLE quotes ADD COLUMN IF NOT EXISTS top_note TEXT;

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
    -- customer_id: kobler fakturaen til vores eget kundekartotek (customers), samme
    -- idé som quotes.customer_id nedenfor. Manglede tidligere helt — fakturaer var
    -- kun denormaliseret tekst (navn/adresse/telefon/email), uden reel kobling.
    -- Sættes ved konvertering fra tilbud (se POST /api/quotes/:id/convert-to-invoice).
    ALTER TABLE invoices ADD COLUMN IF NOT EXISTS customer_id INTEGER;
    CREATE INDEX IF NOT EXISTS idx_invoices_customer ON invoices(customer_id);

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
    -- Samme 'item'/'text' skelnen som quote_lines (se ovenfor) — nødvendig fordi en
    -- tekst-/overskriftslinje på et tilbud kan konverteres videre til en faktura, og
    -- skal blive ved med at vises som ren tekst dér også, ikke som en 0 kr.-varelinje.
    ALTER TABLE invoice_lines ADD COLUMN IF NOT EXISTS line_type TEXT NOT NULL DEFAULT 'item';
    -- Note pr. linje (sep. 2026) — kopieres fra quote_lines.note ved konvertering til
    -- faktura (se POST /api/quotes/:id/convert-to-invoice), samme visning som på tilbuddet.
    ALTER TABLE invoice_lines ADD COLUMN IF NOT EXISTS note TEXT;

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

    -- ARKIVEREDE TILBUDSVERSIONER — hver gang et tilbud sendes til kunden, gemmes den
    -- PRÆCISE PDF (som byte-blob) og et JSON-øjebliksbillede af data på det tidspunkt,
    -- så et tilbud altid kan redigeres og gensendes (uden at skulle oprette et nyt tilbud
    -- hver gang kunden ændrer mening) UDEN at en tidligere given pris/version nogensinde
    -- kan gå tabt eller ændres i baglommen. Render har intet permanent fillager, så
    -- PDF'en gemmes direkte i databasen (BYTEA), ikke som en fil på disken.
    CREATE TABLE IF NOT EXISTS quote_sends (
      id SERIAL PRIMARY KEY,
      quote_id INTEGER NOT NULL REFERENCES quotes(id) ON DELETE CASCADE,
      version_number INTEGER NOT NULL,
      sent_at TEXT DEFAULT ${nowTextSQL()},
      sent_by TEXT,
      recipient TEXT,
      pdf_snapshot BYTEA,
      snapshot_data JSONB
    );
    CREATE INDEX IF NOT EXISTS idx_quote_sends_quote ON quote_sends(quote_id);

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

    -- customer_notes: rigtig, redigerbar/sletbar note-liste på kundekortet
    -- (i stedet for det gamle enkelt-felt customers.notes, som stadig findes
    -- og bruges i "✎ Redigér kunde"-modalen til en kort fritekst-beskrivelse,
    -- men IKKE er velegnet til løbende arbejdsnoter man vil kunne rette/slette
    -- enkeltvis). Vist øverst på #page-customer-detail.
    CREATE TABLE IF NOT EXISTS customer_notes (
      id SERIAL PRIMARY KEY,
      customer_id INTEGER NOT NULL REFERENCES customers(id) ON DELETE CASCADE,
      body TEXT NOT NULL,
      user_id INTEGER REFERENCES users(id) ON DELETE SET NULL,
      created_at TEXT DEFAULT ${nowTextSQL()},
      updated_at TEXT DEFAULT ${nowTextSQL()}
    );
    CREATE INDEX IF NOT EXISTS idx_customer_notes_customer ON customer_notes(customer_id);

    -- ══════════════════════════════════════════════════════════════
    -- GMAIL-INTEGRATION — Martins ønske om at kunne se al mailkorrespondance
    -- med en kunde direkte på kundens kort. ÉN fælles firma-postkasse forbindes
    -- (ikke én pr. bruger) via Google OAuth, se GET /api/gmail/auth-url m.fl.
    -- gmail_connection: singleton-række (id altid 1) med de krypterede tokens.
    -- customer_emails: metadata-cache af synkroniserede mails pr. kunde (selve
    -- brødtekst/vedhæftninger hentes IKKE gemt herind, kun live fra Gmail når
    -- man åbner en mail — se GET /api/gmail/messages/:id — for at undgå at
    -- duplikere store mailarkiver i databasen).
    -- ══════════════════════════════════════════════════════════════
    CREATE TABLE IF NOT EXISTS gmail_connection (
      id INTEGER PRIMARY KEY DEFAULT 1,
      email TEXT,
      access_token_enc TEXT,
      refresh_token_enc TEXT,
      token_expiry BIGINT,
      connected_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
      connected_at TEXT,
      last_synced_at TEXT,
      last_sync_error TEXT,
      CONSTRAINT gmail_connection_singleton CHECK (id = 1)
    );
    CREATE TABLE IF NOT EXISTS customer_emails (
      id SERIAL PRIMARY KEY,
      customer_id INTEGER NOT NULL REFERENCES customers(id) ON DELETE CASCADE,
      gmail_message_id TEXT NOT NULL UNIQUE,
      gmail_thread_id TEXT,
      subject TEXT,
      snippet TEXT,
      from_email TEXT,
      from_name TEXT,
      to_emails TEXT,
      direction TEXT,
      internal_date BIGINT,
      synced_at TEXT DEFAULT ${nowTextSQL()}
    );
    CREATE INDEX IF NOT EXISTS idx_customer_emails_customer ON customer_emails(customer_id, internal_date DESC);
    -- has_attachments sættes ved synk ud fra en "has:attachment"-søgning (billigt),
    -- så "Filer"-fanen (se GET /api/crm/customers/:id/files) kun behøver at hente
    -- fulde mail-detaljer live for de mails der reelt har vedhæftninger, i stedet
    -- for at gennemgå ALLE kundens mails hver gang fanen åbnes.
    ALTER TABLE customer_emails ADD COLUMN IF NOT EXISTS has_attachments INTEGER NOT NULL DEFAULT 0;

    -- ── CLOSE CRM-INTEGRATION: undgår at oprette samme kunde to gange, hvis
    -- Close afsender det samme webhook-event flere gange (Close retrier selv
    -- ved alt andet end 2xx-svar). Se app.post('/api/integrations/close/webhook').
    CREATE TABLE IF NOT EXISTS close_customer_links (
      close_lead_id TEXT PRIMARY KEY,
      customer_id INTEGER NOT NULL REFERENCES customers(id) ON DELETE CASCADE,
      created_at TEXT DEFAULT ${nowTextSQL()}
    );
    -- Close-webhooken opretter fra sep. 2026 OGSÅ et rigtigt salg i Sales-
    -- pipelinen (crm_opportunities), ikke kun en kunde-række — se
    -- app.post('/api/integrations/close/webhook'). opportunity_id er bevidst
    -- NULLABLE: rækker oprettet af den GAMLE kode (kun kunde) har den tom, og
    -- webhooken selvhelbreder dem ved næste udløsning på samme Close-lead
    -- (opretter salget der mangler). NULL bruges altså som "mangler stadig sit
    -- salg", og er samtidig det der forhindrer at et salg oprettes to gange.
    -- Ingen FOREIGN KEY: sletter Martin selv salget igen i CRM'et, skal linket
    -- blive stående som "behandlet" i stedet for at genoprette salget ved
    -- næste webhook-gentagelse fra Close.
    ALTER TABLE close_customer_links ADD COLUMN IF NOT EXISTS opportunity_id INTEGER;

    -- ══════════════════════════════════════════════════════════════
    -- INDBYGGET CRM — samme grund-idé som Close (Leads → Kontakt + Opportunity
    -- i en salgs-pipeline), men bygget direkte ind i programmet i Billy-stil,
    -- efter Martins eget ønske i stedet for kun at synkronisere udefra.
    -- crm_pipelines: de "borde" man kan se (fx "Leads", "Sales") — helt
    -- brugeroprettede/redigerbare, ikke hardkodede.
    -- crm_stages: kolonnerne i et pipeline-bord (ordnet via "position").
    -- crm_leads: raw indkommende interesse, ligger i en lead-pipeline-stage.
    -- crm_opportunities: en konkret salgsmulighed i en opportunity-pipeline-
    -- stage, knyttet til én crm_contact.
    -- crm_contacts: en person — oprettes automatisk ved lead-konvertering,
    -- men kan også oprettes/redigeres direkte.
    -- crm_custom_fields/-values: Martins eget ønske om selv at kunne lave
    -- felter til senere dataanalyse, i stedet for faste hardkodede kolonner.
    -- crm_activities: fælles note-/hændelses-tidslinje (som Close's egen "Log"
    -- man ser på et lead — statusskift logges automatisk, noter manuelt).
    -- ══════════════════════════════════════════════════════════════
    CREATE TABLE IF NOT EXISTS crm_pipelines (
      id SERIAL PRIMARY KEY,
      name TEXT NOT NULL,
      type TEXT NOT NULL DEFAULT 'opportunity', -- 'lead' | 'opportunity' — styrer hvor konvertering lander
      position INTEGER NOT NULL DEFAULT 0,
      created_at TEXT DEFAULT ${nowTextSQL()}
    );
    CREATE TABLE IF NOT EXISTS crm_stages (
      id SERIAL PRIMARY KEY,
      pipeline_id INTEGER NOT NULL REFERENCES crm_pipelines(id) ON DELETE CASCADE,
      name TEXT NOT NULL,
      color TEXT NOT NULL DEFAULT '#6366F1',
      position INTEGER NOT NULL DEFAULT 0,
      is_won INTEGER NOT NULL DEFAULT 0,  -- markerer en "vundet"-slut-stage (til statistik/filtrering senere)
      is_lost INTEGER NOT NULL DEFAULT 0, -- markerer en "tabt"-slut-stage
      created_at TEXT DEFAULT ${nowTextSQL()}
    );
    CREATE INDEX IF NOT EXISTS idx_crm_stages_pipeline ON crm_stages(pipeline_id);
    -- SMS/email-automatik pr. stage — Martins ønske om at flytte det, han i dag
    -- gør via Close + inMobile, ind i vores eget system: rykker man et lead/en
    -- sag TIL en stage der har dette slået til, sendes beskeden automatisk til
    -- leadet/kunden. Se crmFireStageAutomation().
    ALTER TABLE crm_stages ADD COLUMN IF NOT EXISTS sms_enabled INTEGER NOT NULL DEFAULT 0;
    ALTER TABLE crm_stages ADD COLUMN IF NOT EXISTS sms_template TEXT;
    ALTER TABLE crm_stages ADD COLUMN IF NOT EXISTS email_enabled INTEGER NOT NULL DEFAULT 0;
    ALTER TABLE crm_stages ADD COLUMN IF NOT EXISTS email_subject TEXT;
    ALTER TABLE crm_stages ADD COLUMN IF NOT EXISTS email_body TEXT;
    -- Tidsbaserede opfølgninger pr. stage (adskilt fra sms_enabled/email_enabled
    -- ovenfor, som kun fyrer ÉN gang når man LANDER i stagen) — Martins ønske om
    -- fx "7 dage i Tilbud Afgivet uden bevægelse: SMS+mail, 14 dage: mail,
    -- 30 dage: mail", med dag-tærskler HAN selv kan ændre løbende. Flere rækker
    -- pr. stage. Generisk — virker for enhver stage i enhver pipeline, ikke kun
    -- Tilbud Afgivet. Se runStageFollowupScan().
    CREATE TABLE IF NOT EXISTS crm_stage_followup_rules (
      id SERIAL PRIMARY KEY,
      stage_id INTEGER NOT NULL REFERENCES crm_stages(id) ON DELETE CASCADE,
      days_after INTEGER NOT NULL,
      enabled INTEGER NOT NULL DEFAULT 1,
      sms_enabled INTEGER NOT NULL DEFAULT 0,
      sms_template TEXT,
      email_enabled INTEGER NOT NULL DEFAULT 0,
      email_subject TEXT,
      email_body TEXT,
      position INTEGER NOT NULL DEFAULT 0,
      created_at TEXT DEFAULT ${nowTextSQL()}
    );
    CREATE INDEX IF NOT EXISTS idx_crm_stage_followup_rules_stage ON crm_stage_followup_rules(stage_id);
    CREATE TABLE IF NOT EXISTS crm_contacts (
      id SERIAL PRIMARY KEY,
      name TEXT NOT NULL,
      email TEXT,
      phone TEXT,
      address TEXT,
      customer_id INTEGER REFERENCES customers(id) ON DELETE SET NULL, -- sat når kontakten er koblet til en rigtig kunde i Kunder-modulet
      created_at TEXT DEFAULT ${nowTextSQL()},
      updated_at TEXT DEFAULT ${nowTextSQL()}
    );
    CREATE TABLE IF NOT EXISTS crm_leads (
      id SERIAL PRIMARY KEY,
      name TEXT NOT NULL,
      email TEXT,
      phone TEXT,
      address TEXT,
      source TEXT,
      note TEXT,
      pipeline_id INTEGER NOT NULL REFERENCES crm_pipelines(id),
      stage_id INTEGER NOT NULL REFERENCES crm_stages(id),
      owner_id INTEGER REFERENCES users(id) ON DELETE SET NULL,
      converted_opportunity_id INTEGER, -- sat når leadet er konverteret (FK tilføjes efter crm_opportunities findes)
      position INTEGER NOT NULL DEFAULT 0,
      created_at TEXT DEFAULT ${nowTextSQL()},
      updated_at TEXT DEFAULT ${nowTextSQL()}
    );
    CREATE INDEX IF NOT EXISTS idx_crm_leads_stage ON crm_leads(stage_id);
    -- stage_changed_at: ADSKILT fra updated_at (som opdateres ved ALT, inkl.
    -- autogem af et telefonnummer) — sættes KUN når stage_id rent faktisk
    -- ændres. Bruges af den tidsbaserede "ligget X dage i Tabt"-mail-automatik
    -- (runLostFollowupScan), som ellers ville nulstille sit ur ved enhver
    -- redigering af leadet.
    ALTER TABLE crm_leads ADD COLUMN IF NOT EXISTS stage_changed_at TEXT;
    UPDATE crm_leads SET stage_changed_at=created_at WHERE stage_changed_at IS NULL;
    -- contact_id: sat allerede ved OPRETTELSE af et lead (ikke kun ved konvertering),
    -- så Lead → Kunde/Kontakt/Sales hænger sammen fra dag ét. Se
    -- crmFindOrCreateContactAndCustomer() kaldt fra POST /api/crm/leads.
    ALTER TABLE crm_leads ADD COLUMN IF NOT EXISTS contact_id INTEGER REFERENCES crm_contacts(id) ON DELETE SET NULL;
    CREATE TABLE IF NOT EXISTS crm_opportunities (
      id SERIAL PRIMARY KEY,
      name TEXT NOT NULL,
      contact_id INTEGER REFERENCES crm_contacts(id) ON DELETE SET NULL,
      pipeline_id INTEGER NOT NULL REFERENCES crm_pipelines(id),
      stage_id INTEGER NOT NULL REFERENCES crm_stages(id),
      value NUMERIC,
      probability INTEGER,
      owner_id INTEGER REFERENCES users(id) ON DELETE SET NULL,
      source_lead_id INTEGER REFERENCES crm_leads(id) ON DELETE SET NULL,
      position INTEGER NOT NULL DEFAULT 0,
      created_at TEXT DEFAULT ${nowTextSQL()},
      updated_at TEXT DEFAULT ${nowTextSQL()}
    );
    CREATE INDEX IF NOT EXISTS idx_crm_opp_stage ON crm_opportunities(stage_id);
    ALTER TABLE crm_leads ADD COLUMN IF NOT EXISTS converted_opportunity_id INTEGER REFERENCES crm_opportunities(id) ON DELETE SET NULL;
    -- Se tilsvarende kommentar ved crm_leads.stage_changed_at ovenfor.
    ALTER TABLE crm_opportunities ADD COLUMN IF NOT EXISTS stage_changed_at TEXT;
    UPDATE crm_opportunities SET stage_changed_at=created_at WHERE stage_changed_at IS NULL;
    -- Close CRM-historikimport (POST /api/admin/import/close): close_id er Close's
    -- EGET lead-/opportunity-id fra CSV-eksporten, brugt som idempotens-nøgle så
    -- Martin trygt kan genkøre importen flere gange (fx efter en datarettelse) uden
    -- at oprette dubletter — se lookup'et FØR hver INSERT i import-endpointet.
    -- Delvist unikt index (WHERE close_id IS NOT NULL) fordi almindelige, manuelt
    -- oprettede leads/opportunities ikke har nogen close_id.
    ALTER TABLE crm_leads ADD COLUMN IF NOT EXISTS close_id TEXT;
    CREATE UNIQUE INDEX IF NOT EXISTS idx_crm_leads_close_id ON crm_leads(close_id) WHERE close_id IS NOT NULL;
    ALTER TABLE crm_opportunities ADD COLUMN IF NOT EXISTS close_id TEXT;
    CREATE UNIQUE INDEX IF NOT EXISTS idx_crm_opportunities_close_id ON crm_opportunities(close_id) WHERE close_id IS NOT NULL;
    -- RETTELSE (sep. 2026) — SIKKERHEDSKRITISK: den ÆLDRE migration et par
    -- linjer ovenfor ("UPDATE crm_leads/crm_opportunities SET
    -- stage_changed_at=created_at WHERE stage_changed_at IS NULL") kører ved
    -- HVER serverstart og blev skrevet længe før Close-importen fandtes. Den
    -- kan ikke se forskel på "kolonnen er lige tilføjet" og "importen satte
    -- BEVIDST NULL for at beskytte historiske rækker mod runStageFollowupScan/
    -- runLostFollowupScan" — så den overskrev stille importens NULL med
    -- Close's årgamle created_at ved allerførste genstart efter enhver import,
    -- hvilket ville gøre op til ~1700+ historiske sager/leads berettiget til
    -- automatisk opfølgnings-SMS/mail. Denne rettelse gendanner beskyttelsen
    -- ved HVER opstart for enhver close_id-mærket række der stadig ser
    -- urørt ud (stage_changed_at er stadig lig sin egen created_at — en
    -- rigtig manuel stage-ændring via PUT .../:id sætter stage_changed_at til
    -- NU, aldrig til den gamle created_at, så denne test kan ikke fejlagtigt
    -- ramme noget Martin selv har rørt).
    UPDATE crm_leads SET stage_changed_at=NULL WHERE close_id IS NOT NULL AND stage_changed_at=created_at;
    UPDATE crm_opportunities SET stage_changed_at=NULL WHERE close_id IS NOT NULL AND stage_changed_at=created_at;
    -- crm_opportunities havde ingen fritekst-note (kun crm_activities-tidslinjen) —
    -- Close's opportunity-notefelt importeres direkte hertil, som ÉT samlet felt
    -- i stedet for en aktivitets-logline pr. importeret sag (se importens
    -- kommentar om at springe crmLogActivity over for importerede rækker).
    ALTER TABLE crm_opportunities ADD COLUMN IF NOT EXISTS note TEXT;
    -- Automatisk "opfølgning ved tabt tilbud" — én global regel (ikke pr.
    -- pipeline/stage), se runLostFollowupScan(). Enkelt-række-tabel, samme
    -- mønster som finance_dunning_settings.
    CREATE TABLE IF NOT EXISTS crm_lost_followup_settings (
      id INTEGER PRIMARY KEY DEFAULT 1,
      enabled INTEGER NOT NULL DEFAULT 0,
      days_threshold INTEGER NOT NULL DEFAULT 5,
      require_quote INTEGER NOT NULL DEFAULT 1,
      subject TEXT,
      body TEXT,
      updated_at TEXT DEFAULT ${nowTextSQL()}
    );
    INSERT INTO crm_lost_followup_settings (id, enabled, days_threshold, require_quote, subject, body)
    VALUES (1, 0, 5, 1,
      'Er du stadig interesseret, {{navn}}?',
      'Hej {{navn}},<br><br>Vi kan se at vi ikke har hørt fra dig i et stykke tid vedrørende dit tilbud. Er du stadig interesseret, eller har du spørgsmål vi kan hjælpe med?<br><br>Du er altid velkommen til at svare på denne mail eller ringe til os.<br><br>Venlig hilsen<br>{{firma}}'
    ) ON CONFLICT (id) DO NOTHING;
    -- Delt hemmelig nøgle til lead-modtage-webhooken (Elementor/Facebook Ads via
    -- Make.com) — genereres én gang ved første opstart, ligger derefter fast
    -- indtil nogen trykker "Generér ny nøgle" i UI'en. Se POST /api/leads/webhook/:source.
    INSERT INTO app_settings (key, value) VALUES ('lead_webhook_secret', '${crypto.randomBytes(20).toString('hex')}') ON CONFLICT (key) DO NOTHING;
    CREATE TABLE IF NOT EXISTS crm_custom_fields (
      id SERIAL PRIMARY KEY,
      entity_type TEXT NOT NULL, -- 'lead' | 'opportunity' | 'contact'
      key TEXT NOT NULL,
      label TEXT NOT NULL,
      field_type TEXT NOT NULL DEFAULT 'text', -- text | number | select | date | checkbox
      options JSONB DEFAULT '[]', -- kun brugt af 'select'
      position INTEGER NOT NULL DEFAULT 0,
      created_at TEXT DEFAULT ${nowTextSQL()},
      UNIQUE(entity_type, key)
    );
    -- Kort-visning i pipeline (sep. 2026, Martins ønske): admin vælger selv hvilke felter
    -- der vises på et lead/opportunity-kort, i stedet for automatisk "de første 2 med en
    -- værdi". option_colors er kun brugt af 'select'-felter: {"Website form":"#2563EB",...}
    -- — et separat map i stedet for at ændre selve 'options'-formatet, så alt eksisterende
    -- der læser 'options' som en ren tekst-liste forbliver uændret.
    ALTER TABLE crm_custom_fields ADD COLUMN IF NOT EXISTS show_on_card INTEGER NOT NULL DEFAULT 0;
    ALTER TABLE crm_custom_fields ADD COLUMN IF NOT EXISTS option_colors JSONB DEFAULT '{}';
    CREATE TABLE IF NOT EXISTS crm_custom_field_values (
      id SERIAL PRIMARY KEY,
      field_id INTEGER NOT NULL REFERENCES crm_custom_fields(id) ON DELETE CASCADE,
      entity_type TEXT NOT NULL,
      entity_id INTEGER NOT NULL,
      value TEXT,
      UNIQUE(field_id, entity_type, entity_id)
    );
    CREATE INDEX IF NOT EXISTS idx_crm_cfv_entity ON crm_custom_field_values(entity_type, entity_id);
    CREATE TABLE IF NOT EXISTS crm_activities (
      id SERIAL PRIMARY KEY,
      entity_type TEXT NOT NULL, -- 'lead' | 'opportunity' | 'contact'
      entity_id INTEGER NOT NULL,
      kind TEXT NOT NULL DEFAULT 'note', -- note | stage_change | created | converted
      body TEXT,
      user_id INTEGER REFERENCES users(id) ON DELETE SET NULL,
      created_at TEXT DEFAULT ${nowTextSQL()}
    );
    CREATE INDEX IF NOT EXISTS idx_crm_activities_entity ON crm_activities(entity_type, entity_id);
    -- Noter i tidslinjen kan nu redigeres (se PUT /api/crm/activities/:id) — sættes
    -- kun når en note rent faktisk er rettet, så "redigeret"-mærket i UI'et kan vises
    -- præcis som på kunde-noterne (customer_notes.updated_at).
    ALTER TABLE crm_activities ADD COLUMN IF NOT EXISTS updated_at TEXT;

    -- Engangs-migrering (idempotent, pga. NOT EXISTS — kan trygt køre ved hver
    -- opstart uden at gøre noget efter første gang): da vi tilføjede once-per-
    -- stage-dedup til crmFireStageAutomation (sep. 2026), skiftede vi de loggede
    -- aktivitetstyper fra det generiske 'sms_sent'/'email_sent' til stage-
    -- specifikke 'sms_sent_stage<ID>'/'email_sent_stage<ID>'. Uden denne
    -- backfill ville ethvert lead/enhver sag, der allerede havde fået en
    -- automatisk SMS/mail i sin NUVÆRENDE stage under den gamle ordning,
    -- pludselig få den samme besked igen den dag rettelsen går i drift.
    INSERT INTO crm_activities (entity_type, entity_id, kind, body, created_at)
    SELECT 'lead', l.id, 'sms_sent_stage' || l.stage_id::text, 'Automatisk migreret dedup-markering (SMS allerede sendt i denne stage under tidligere ordning)', ${nowTextSQL()}
    FROM crm_leads l
    WHERE EXISTS (SELECT 1 FROM crm_activities a WHERE a.entity_type='lead' AND a.entity_id=l.id AND a.kind='sms_sent')
      AND NOT EXISTS (SELECT 1 FROM crm_activities a2 WHERE a2.entity_type='lead' AND a2.entity_id=l.id AND a2.kind='sms_sent_stage' || l.stage_id::text);
    INSERT INTO crm_activities (entity_type, entity_id, kind, body, created_at)
    SELECT 'lead', l.id, 'email_sent_stage' || l.stage_id::text, 'Automatisk migreret dedup-markering (email allerede sendt i denne stage under tidligere ordning)', ${nowTextSQL()}
    FROM crm_leads l
    WHERE EXISTS (SELECT 1 FROM crm_activities a WHERE a.entity_type='lead' AND a.entity_id=l.id AND a.kind='email_sent')
      AND NOT EXISTS (SELECT 1 FROM crm_activities a2 WHERE a2.entity_type='lead' AND a2.entity_id=l.id AND a2.kind='email_sent_stage' || l.stage_id::text);
    INSERT INTO crm_activities (entity_type, entity_id, kind, body, created_at)
    SELECT 'opportunity', o.id, 'sms_sent_stage' || o.stage_id::text, 'Automatisk migreret dedup-markering (SMS allerede sendt i denne stage under tidligere ordning)', ${nowTextSQL()}
    FROM crm_opportunities o
    WHERE EXISTS (SELECT 1 FROM crm_activities a WHERE a.entity_type='opportunity' AND a.entity_id=o.id AND a.kind='sms_sent')
      AND NOT EXISTS (SELECT 1 FROM crm_activities a2 WHERE a2.entity_type='opportunity' AND a2.entity_id=o.id AND a2.kind='sms_sent_stage' || o.stage_id::text);
    INSERT INTO crm_activities (entity_type, entity_id, kind, body, created_at)
    SELECT 'opportunity', o.id, 'email_sent_stage' || o.stage_id::text, 'Automatisk migreret dedup-markering (email allerede sendt i denne stage under tidligere ordning)', ${nowTextSQL()}
    FROM crm_opportunities o
    WHERE EXISTS (SELECT 1 FROM crm_activities a WHERE a.entity_type='opportunity' AND a.entity_id=o.id AND a.kind='email_sent')
      AND NOT EXISTS (SELECT 1 FROM crm_activities a2 WHERE a2.entity_type='opportunity' AND a2.entity_id=o.id AND a2.kind='email_sent_stage' || o.stage_id::text);

    -- Default-opsætning af "Tilbud Afgivet"-stagens tidsbaserede opfølgninger
    -- (Martins 7/14/30-dages-ønske) — kun hvis stagen findes (matchet på navn,
    -- case-insensitivt) OG den ikke allerede har nogen regler (så vi aldrig
    -- overskriver noget Martin selv har redigeret). Teksterne er UDKAST — se
    -- leveringsnoten, de bør læses igennem og evt. rettes til i UI'en.
    INSERT INTO crm_stage_followup_rules (stage_id, days_after, sms_enabled, sms_template, email_enabled, email_subject, email_body, position)
    SELECT s.id, 7, 1, 'Hej {{navn}}, har du haft mulighed for at kigge på tilbuddet fra {{firma}}? Sig endelig til hvis du har spørgsmål 🙂',
                    1, 'Har du set vores tilbud?', '<p>Hej {{navn}},</p><p>Vi sendte for lidt siden et tilbud til dig og ville lige høre om du har haft mulighed for at kigge på det?</p><p>Sig endelig til hvis du har spørgsmål, eller hvis der er noget vi skal justere.</p><p>Mange hilsner<br>{{firma}}</p>', 0
    FROM crm_stages s
    WHERE lower(s.name)='tilbud afgivet'
      AND NOT EXISTS (SELECT 1 FROM crm_stage_followup_rules r WHERE r.stage_id=s.id);
    INSERT INTO crm_stage_followup_rules (stage_id, days_after, email_enabled, email_subject, email_body, position)
    SELECT s.id, 14, 1, 'Stadig interesseret i tilbuddet?', '<p>Hej {{navn}},</p><p>Vi kan se at vores tilbud stadig står åbent. Er du stadig interesseret, eller er der noget der holder dig tilbage?</p><p>Vi hjælper gerne med at justere tilbuddet, hvis det er det der skal til.</p><p>Mange hilsner<br>{{firma}}</p>', 1
    FROM crm_stages s
    WHERE lower(s.name)='tilbud afgivet'
      AND NOT EXISTS (SELECT 1 FROM crm_stage_followup_rules r WHERE r.stage_id=s.id AND r.days_after=14);
    INSERT INTO crm_stage_followup_rules (stage_id, days_after, email_enabled, email_subject, email_body, position)
    SELECT s.id, 30, 1, 'Sidste opfølgning på dit tilbud', '<p>Hej {{navn}},</p><p>Det er nu en måned siden vi sendte vores tilbud, og vi har ikke hørt fra dig. Vi vil meget gerne hjælpe, hvis projektet stadig er aktuelt — sig endelig til.</p><p>Mange hilsner<br>{{firma}}</p>', 2
    FROM crm_stages s
    WHERE lower(s.name)='tilbud afgivet'
      AND NOT EXISTS (SELECT 1 FROM crm_stage_followup_rules r WHERE r.stage_id=s.id AND r.days_after=30);

    -- crm_tasks: lille opgave-tjekliste pr. lead/opportunity (samme idé som
    -- Close's "Tasks"-panel på lead-/kontaktsiden — ikke koblet til det store
    -- Daglig planlægning/Gantt-system, bevidst holdt simpelt).
    CREATE TABLE IF NOT EXISTS crm_tasks (
      id SERIAL PRIMARY KEY,
      entity_type TEXT NOT NULL,
      entity_id INTEGER NOT NULL,
      title TEXT NOT NULL,
      done INTEGER NOT NULL DEFAULT 0,
      created_at TEXT DEFAULT ${nowTextSQL()}
    );
    CREATE INDEX IF NOT EXISTS idx_crm_tasks_entity ON crm_tasks(entity_type, entity_id);
    -- Udvidet efter Martins ønske om Close-lignende opgaver: ansvarlig medarbejder,
    -- dato/tid for opfølgning, og prioritet — så der kan bygges en fælles
    -- "Opfølgninger"-oversigt på tværs af alle leads/opportunities (se
    -- GET /api/crm/tasks/overview).
    ALTER TABLE crm_tasks ADD COLUMN IF NOT EXISTS assigned_to INTEGER REFERENCES users(id) ON DELETE SET NULL;
    ALTER TABLE crm_tasks ADD COLUMN IF NOT EXISTS created_by INTEGER REFERENCES users(id) ON DELETE SET NULL;
    ALTER TABLE crm_tasks ADD COLUMN IF NOT EXISTS due_date TEXT;
    ALTER TABLE crm_tasks ADD COLUMN IF NOT EXISTS due_time TEXT;
    ALTER TABLE crm_tasks ADD COLUMN IF NOT EXISTS priority INTEGER NOT NULL DEFAULT 0;

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

    -- SAMLET SKABELON-CENTER ("Skabeloner" i topmenuen, ét sted for ALLE
    -- mail-skabeloner) — "singulære" system-mails, dvs. mails der kun findes
    -- i ÉT aktivt eksemplar ad gangen (modsat email_templates/
    -- document_email_templates ovenfor, hvor man vælger mellem FLERE
    -- navngivne varianter). "enabled" bruges reelt kun for skabeloner der
    -- sendes AUTOMATISK (fx ved ny kunde) — manuelt afsendte skabeloner
    -- (Vi kommer i dag/i morgen, Tak for accept) ignorerer feltet ved
    -- afsendelse, men gemmer det alligevel for et ensartet UI.
    CREATE TABLE IF NOT EXISTS system_email_templates (
      key TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      subject TEXT NOT NULL,
      body_html TEXT NOT NULL,
      enabled INTEGER NOT NULL DEFAULT 1,
      updated_at TEXT DEFAULT ${nowTextSQL()}
    );

    -- BRUGERDEFINEREDE SKABELONER — frit oprettede mail-skabeloner uden fast
    -- automatisk handling (endnu), jf. Martins ønske om løbende at kunne
    -- oprette flere skabeloner fra samme sted. Vises i Skabeloner-sidens
    -- "Andre skabeloner"-sektion.
    CREATE TABLE IF NOT EXISTS custom_email_templates (
      id SERIAL PRIMARY KEY,
      name TEXT NOT NULL,
      subject TEXT NOT NULL,
      body_html TEXT NOT NULL,
      created_at TEXT DEFAULT ${nowTextSQL()},
      updated_at TEXT DEFAULT ${nowTextSQL()}
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
    -- Sagsnummer (GM-ÅÅÅÅ-NNNN) — tildeles automatisk når sagen oprettes (se
    -- nextDocNumber('project','GM') ved INSERT INTO projects), men er et helt
    -- almindeligt tekstfelt bagefter, så det evt. kan rettes manuelt ligesom de
    -- andre steder i appen der bruger samme sagsnummer-konvention (Tidslinje mm.).
    ALTER TABLE projects ADD COLUMN IF NOT EXISTS job_number TEXT;
    -- JobTread-sagens id, sat KUN på sager oprettet af "Hent nye sager"-importen
    -- (se jtImportMaterializeJob). Er nøglen der gør knappen tryg at trykke på
    -- igen og igen: en JobTread-sag der allerede er hentet ind springes over i
    -- stedet for at blive oprettet en gang til. Manuelt/normalt oprettede sager
    -- (fra et accepteret tilbud) har NULL her — derfor er unik-indekset delvist,
    -- så de mange NULL'er ikke kolliderer med hinanden.
    ALTER TABLE projects ADD COLUMN IF NOT EXISTS jobtread_job_id TEXT;
    CREATE UNIQUE INDEX IF NOT EXISTS idx_projects_jobtread_job_id ON projects(jobtread_job_id) WHERE jobtread_job_id IS NOT NULL;
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
    ALTER TABLE time_entries ADD COLUMN IF NOT EXISTS photo_urls JSONB NOT NULL DEFAULT '[]';
    ALTER TABLE time_entries ADD COLUMN IF NOT EXISTS created_by INTEGER;
    ALTER TABLE time_entries ADD COLUMN IF NOT EXISTS updated_at TEXT;

    -- AKKORDLISTE (sep. 2026, Martins ønske): global, navngivet prisliste med stykpriser —
    -- fx "Slibning, grundbehandling" til X kr — som akkord-lønnede medarbejdere (fx en
    -- gulvsliber som Adrian, med 10-20 forskellige poster) vælger imellem når de logger
    -- arbejde på en sag, i stedet for timeløn. Global (ikke pr. medarbejder), så alle
    -- akkord-medarbejdere vælger fra samme liste.
    CREATE TABLE IF NOT EXISTS akkord_items (
      id SERIAL PRIMARY KEY,
      name TEXT NOT NULL,
      rate NUMERIC NOT NULL DEFAULT 0,
      active INTEGER NOT NULL DEFAULT 1,
      position INTEGER NOT NULL DEFAULT 0,
      created_at TEXT DEFAULT ${nowTextSQL()}
    );
    -- En tidsregistrering er ENTEN time-baseret (minutes, som hidtil) ELLER akkord-baseret
    -- (akkord_item_id + akkord_quantity, fx "3 stk grundbehandling") — minutes bruges stadig
    -- til at vise hvor lang tid arbejdet reelt tog (planlægning/historik), mens lønbeløbet
    -- for en akkord-lønnet medarbejder udregnes ud fra akkord-linjen, ikke minutter×timeløn.
    ALTER TABLE time_entries ADD COLUMN IF NOT EXISTS akkord_item_id INTEGER REFERENCES akkord_items(id) ON DELETE SET NULL;
    ALTER TABLE time_entries ADD COLUMN IF NOT EXISTS akkord_quantity NUMERIC NOT NULL DEFAULT 0;

    -- ── KS-SKABELON PR. SAG: Martin kan begrænse hvilke KS-skabeloner en
    -- medarbejder må udfylde på en given sag. Ingen rækker for en sag =
    -- alle skabeloner tilladt (bagudkompatibelt), for at undgå at gamle
    -- sager pludselig mister alle deres KS-formularer. ──────────────────
    CREATE TABLE IF NOT EXISTS project_qa_templates (
      project_id INTEGER NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
      qa_template_id INTEGER NOT NULL REFERENCES qa_templates(id) ON DELETE CASCADE,
      PRIMARY KEY (project_id, qa_template_id)
    );
    CREATE INDEX IF NOT EXISTS idx_project_qa_templates_project ON project_qa_templates(project_id);

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

  // ── SAMLET SKABELON-CENTER: engangs-migrering + standardtekster ────────
  // Flytter en evt. tidligere tilpasset færdig-mail-tekst fra de gamle
  // app_settings-nøgler over i den nye system_email_templates-tabel (så intet
  // tabes ved omlægningen til ét samlet Skabeloner-sted, se leveringsnoten),
  // normaliserer variabel-syntaksen til {{var}} som resten af appen bruger,
  // og sår standardtekster for de nye skabeloner (Velkomst til nye kunder,
  // Vi kommer i dag) samt for to hidtil hårdkodede mails der nu bliver
  // redigerbare for første gang (Vi kommer i morgen, Tak for accept).
  {
    const oldCompletionRows = (await pool.query(
      "SELECT key,value FROM app_settings WHERE key IN ('completion_email_subject','completion_email_body')"
    )).rows;
    const oldCompletionMap = {};
    oldCompletionRows.forEach(r => { oldCompletionMap[r.key] = r.value; });
    const toDbl = s => String(s || '').replace(/\{(kunde|firma|opgave|dato|tidspunkt|medarbejder|fag|adresse)\}/g, '{{$1}}');
    const systemEmailDefaults = [
      ['completion', 'Færdig-mail til kunden',
        toDbl(oldCompletionMap.completion_email_subject) || 'Vi er færdige hos dig — {{kunde}}',
        toDbl(oldCompletionMap.completion_email_body) || 'Hej,\n\nVi vil gerne informere dig om, at vi nu er færdige med arbejdet hos dig ({{opgave}}).\n\nVedhæftet finder du vores pleje- og vedligeholdelsesvejledning, som beskriver hvordan du bedst passer på dit nybehandlede gulv den første tid.\n\nMange tak for denne gang — vi håber du bliver glad for resultatet!\n\nVenlig hilsen\n{{firma}}',
        1],
      ['reminder_tomorrow', 'Vi kommer i morgen',
        'Vi kommer i morgen — {{firma}}',
        'Hej,\n\nVi vil bare give dig besked om, at vi kommer i morgen{{tidspunkt}} og udfører ({{opgave}}).\n\nDu kan altid se status på din opgave her: {{link}}\n\nVenlig hilsen\n{{firma}}',
        1],
      ['reminder_today', 'Vi kommer i dag',
        'Vi kommer i dag — {{firma}}',
        'Hej,\n\nVi vil bare give dig besked om, at vi kommer i dag{{tidspunkt}} og udfører ({{opgave}}).\n\nDu kan altid se status på din opgave her: {{link}}\n\nVenlig hilsen\n{{firma}}',
        1],
      ['customer_welcome', 'Velkomst til nye kunder',
        'Velkommen som kunde hos {{firma}}! 🎉',
        '<p>Hej {{kunde}},</p><p>Tusind tak fordi du er blevet kunde hos {{firma}} — vi glæder os til samarbejdet!</p><p>Har du spørgsmål undervejs, er du altid velkommen til at kontakte os.</p><p>Mange hilsner<br>{{firma}}</p>',
        0],
      ['quote_accepted', 'Tak for accept af tilbud',
        'Tak for din accept, {{kunde}}! 🎉',
        '<p>Hej {{kunde}},</p><p>Tusind tak fordi du har accepteret tilbuddet <b>{{dokument_nr}}</b> hos {{firma}} — vi glæder os til at komme i gang! 🛠️</p><p>Du kan altid følge dit projekt og se alle dine tilbud og fakturaer på din helt egen side her, uden at skulle logge ind:</p><p><a href="{{link}}">{{link}}</a></p><p>Gem gerne linket — det er dit permanente overblik fremover.</p><p>Har du spørgsmål, er du altid velkommen til at kontakte os.</p><p>Mange hilsner<br>{{firma}}</p>',
        1],
    ];
    for (const [key, name, subject, body, enabled] of systemEmailDefaults) {
      await pool.query(
        `INSERT INTO system_email_templates (key,name,subject,body_html,enabled) VALUES ($1,$2,$3,$4,$5) ON CONFLICT (key) DO NOTHING`,
        [key, name, subject, body, enabled]
      );
    }
  }

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

  // ── CRM: seed de to standard-pipelines ("Leads" + "Sales") + deres stages,
  // kun hvis der IKKE allerede findes nogen — rører aldrig ved data Martin
  // selv har redigeret/tilføjet siden (samme mønster som udgiftskategorierne
  // ovenfor). Stage-navnene matcher hans eget Close-opsætning som udgangspunkt,
  // men er 100% redigerbare bagefter under CRM → Indstillinger.
  const pipelineCount = await pgOne('SELECT COUNT(*)::int AS n FROM crm_pipelines');
  if (pipelineCount && pipelineCount.n === 0) {
    const leadsPipeline = await pgOne("INSERT INTO crm_pipelines (name, type, position) VALUES ('Leads','lead',0) RETURNING id");
    const leadStages = ['Nyt lead', 'Kontaktet', 'Kvalificeret', 'Konverteret'];
    for (let i = 0; i < leadStages.length; i++) {
      await pool.query('INSERT INTO crm_stages (pipeline_id,name,color,position,is_won) VALUES ($1,$2,$3,$4,$5)',
        [leadsPipeline.id, leadStages[i], ['#6B7280', '#3B82F6', '#8B5CF6', '#16A34A'][i], i, leadStages[i] === 'Konverteret' ? 1 : 0]);
    }
    const salesPipeline = await pgOne("INSERT INTO crm_pipelines (name, type, position) VALUES ('Sales','opportunity',1) RETURNING id");
    const salesStages = [
      ['Manglende data', '#9CA3AF', 0, 0],
      ['Lav Tilbud', '#F59E0B', 0, 0],
      ['Tilbud Afgivet', '#3B82F6', 0, 0],
      ['Hot Lead', '#EF4444', 0, 0],
      ['Vundet', '#16A34A', 1, 0],
      ['Tabt', '#6B7280', 0, 1]
    ];
    for (let i = 0; i < salesStages.length; i++) {
      const [name, color, isWon, isLost] = salesStages[i];
      await pool.query('INSERT INTO crm_stages (pipeline_id,name,color,position,is_won,is_lost) VALUES ($1,$2,$3,$4,$5,$6)',
        [salesPipeline.id, name, color, i, isWon, isLost]);
    }
    console.log('CRM: standard-pipelines "Leads" og "Sales" oprettet med startstages.');
  }

  // Seed et par åbenlyse custom fields fra Martins Close-skærmbilleder, så
  // CRM'et ikke starter helt tomt — kan frit redigeres/slettes bagefter.
  const customFieldCount = await pgOne('SELECT COUNT(*)::int AS n FROM crm_custom_fields');
  if (customFieldCount && customFieldCount.n === 0) {
    const seedFields = [
      ['lead', 'projekt_type', 'Projekt Type', 'select', ['Gulvslibning', 'Gulvlægning', 'Maler', 'Enterprise'], 0],
      ['lead', 'lead_source', 'Lead Source', 'select', ['Website form', 'Facebook/Instagram', 'Telefon', 'Anbefaling'], 1],
      ['opportunity', 'projekt_type', 'Projekt Type', 'select', ['Gulvslibning', 'Gulvlægning', 'Maler', 'Enterprise'], 0],
      ['opportunity', 'sagsnummer', 'Sagsnummer', 'text', [], 1]
    ];
    for (const [entityType, key, label, fieldType, options, position] of seedFields) {
      await pool.query('INSERT INTO crm_custom_fields (entity_type,key,label,field_type,options,position) VALUES ($1,$2,$3,$4,$5,$6) ON CONFLICT DO NOTHING',
        [entityType, key, label, fieldType, JSON.stringify(options), position]);
    }
    console.log('CRM: standard custom fields oprettet (Projekt Type, Lead Source, Sagsnummer).');
  }

  await initSearchTrigrams();
}

// ══════════════════════════════════════════════════════════════
// FUZZY-SØGNING (pg_trgm) — grundlaget under den globale søgning i topbjælken,
// se GET /api/search længere nede. Martins ønske: "søgningen skal ikke være
// 100% korrekt for at finde noget" — altså at "gulvmaester" stadig finder
// "Gulvmester ApS". Det løses med Postgres' indbyggede trigram-udvidelse
// pg_trgm, der sammenligner ord på 3-tegns-stumper i stedet for at kræve et
// eksakt tekstmatch.
//
// FEJLSIKRING: pg_trgm er en "trusted extension" fra Postgres 13 og frem, så
// den kan normalt oprettes af app-brugeren selv (også på Render). Skulle det
// alligevel fejle — ældre Postgres, eller en hosting hvor extensions er
// spærret — MÅ det ikke vælte opstarten: så sættes searchTrgmReady=false, og
// /api/search kører videre med ren ILIKE-søgning (stadig fuldt brugbar, bare
// uden stavefejl-tolerance). Flaget rapporteres i svaret som "fuzzy", så det
// er til at se udefra hvad der faktisk kører.
// ══════════════════════════════════════════════════════════════
let searchTrgmReady = false;

async function initSearchTrigrams() {
  try {
    await pool.query('CREATE EXTENSION IF NOT EXISTS pg_trgm');
    // GIN-trigram-indeks på de navne/adresser vi fuzzy-søger i, så % / <%
    // kan slå op i et indeks i stedet for at scanne hele tabellen når
    // kunde-/lead-listerne vokser.
    await pool.query(`
      CREATE INDEX IF NOT EXISTS idx_customers_name_trgm ON customers USING gin (name gin_trgm_ops);
      CREATE INDEX IF NOT EXISTS idx_customers_address_trgm ON customers USING gin (address gin_trgm_ops);
      CREATE INDEX IF NOT EXISTS idx_crm_leads_name_trgm ON crm_leads USING gin (name gin_trgm_ops);
      CREATE INDEX IF NOT EXISTS idx_crm_leads_address_trgm ON crm_leads USING gin (address gin_trgm_ops);
      CREATE INDEX IF NOT EXISTS idx_crm_contacts_name_trgm ON crm_contacts USING gin (name gin_trgm_ops);
      CREATE INDEX IF NOT EXISTS idx_crm_contacts_address_trgm ON crm_contacts USING gin (address gin_trgm_ops);
      CREATE INDEX IF NOT EXISTS idx_crm_opportunities_name_trgm ON crm_opportunities USING gin (name gin_trgm_ops);
    `);
    searchTrgmReady = true;
    console.log('Global søgning: pg_trgm aktiveret — stavefejl-tolerant (fuzzy) søgning er slået til.');
  } catch (e) {
    searchTrgmReady = false;
    console.error('ADVARSEL: pg_trgm kunne ikke aktiveres — global søgning kører videre med ren ILIKE (ingen stavefejl-tolerance):', e.message);
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

// Bruges når en handling skal tillades ekstra ting FOR økonomi/kontor-brugere
// (fx registrere/rette tid for en anden medarbejder), men uden at hele endpointet
// skal spærres med financeOnly for almindelige medarbejdere der bruger den normale del.
async function isFinanceAdmin(userId) {
  try {
    const row = await pgOne('SELECT is_finance_admin FROM users WHERE id=$1 AND active=1', [userId]);
    return !!(row && row.is_finance_admin);
  } catch (error) {
    return false;
  }
}

// ── ROLLER & ADGANG (sep. 2026) ─────────────────────────────────────────────
// Katalog over de sider Martin kan krydse af pr. rolle/person i admin-panelet.
// 'dashboard' er en særlig nøgle: gives automatisk til enhver med en rolle
// overhovedet (se panelAccess nedenfor) — Kommandocenter er "hjemmesiden", ikke
// noget der skal kunne fravælges. Rækkefølgen her styrer visningsrækkefølgen
// i markerings-UI'en (Hold & vendors → Roller & adgang).
const PANEL_PAGES = [
  { key: 'plan', label: 'Dagligplanlægning', group: 'Planlægning' },
  { key: 'capacity', label: 'Kapacitet', group: 'Planlægning' },
  { key: 'availability', label: 'Ledighedsoversigt', group: 'Planlægning' },
  { key: 'timeline', label: 'Tidslinje', group: 'Planlægning' },
  { key: 'projects', label: 'Projekter (inkl. Gantt, KS-skabeloner, Kontaktformularer)', group: 'Projekter' },
  { key: 'customers', label: 'CRM: Kunder', group: 'CRM' },
  { key: 'crmp_leads', label: 'CRM: Leads', group: 'CRM' },
  { key: 'crmp_sales', label: 'CRM: Sales', group: 'CRM' },
  { key: 'crmp_tasks', label: 'CRM: Opfølgninger', group: 'CRM' },
  { key: 'quotes', label: 'Tilbud & Faktura', group: 'Tilbud & Faktura' },
  { key: 'finance', label: 'Økonomi', group: 'Økonomi' },
  { key: 'templates', label: 'Skabeloner (automatisering)', group: 'Administration' },
  { key: 'email-templates', label: 'Mail-skabeloner', group: 'Administration' },
  { key: 'people', label: 'Hold & vendors', group: 'Administration' },
  { key: 'library', label: 'Bibliotek', group: 'Administration' },
  { key: 'logs', label: 'Log', group: 'Administration' },
  { key: 'notif-settings', label: 'Indstillinger', group: 'Administration' },
  // Gmail har ikke længere sin egen side i admin-panelet — indholdet er en fane
  // under Indstillinger. Nøglen bevares uændret, da den stadig er dét
  // panelAccess() håndhæver på alle /api/gmail/*-ruter (og den indgår i
  // LEGACY_FINANCE_BUNDLE nedenfor); kun labelen er opdateret, så afkrydsningen
  // i "Roller & adgang" fortæller hvor indstillingen nu findes.
  { key: 'gmail-settings', label: 'Gmail-integration (fane under Indstillinger)', group: 'Administration' },
  { key: 'tasklist', label: 'Opgaveliste (Min side)', group: 'Min side' },
  { key: 'requests', label: 'Godkendelser (sygdom)', group: 'Min side' },
  { key: 'completed', label: 'Færdige opgaver', group: 'Min side' },
  { key: 'timer', label: 'Timer', group: 'Min side' },
];
const PANEL_PAGE_KEYS = new Set(PANEL_PAGES.map(p => p.key));

// Bagudkompatibilitet: is_finance_admin=1 (det gamle, brede "Økonomi-adgang"-
// flueben på en bruger) dækkede indtil nu præcis disse sider i sidebaren (se
// den gamle .toggle('hidden',!me.is_finance_admin)-liste i admin.html). En
// eksisterende is_finance_admin-bruger, der ALDRIG får tildelt en panel-rolle,
// skal blive ved med at se nøjagtig det samme som i dag — ingen skal miste
// adgang til noget som helst pga. denne omlægning. Ved beregning af en brugers
// samlede panel_pages foldes dette bundt derfor altid ind, oveni evt. panel-rolle.
const LEGACY_FINANCE_BUNDLE = ['finance', 'quotes', 'customers', 'crmp_leads', 'crmp_sales', 'crmp_tasks', 'projects', 'email-templates', 'gmail-settings'];

// Beregner den fulde liste af side-nøgler en bruger har adgang til: alt ved
// role==='admin', ellers panel-rollens sider + is_finance_admin-bundtet
// (bagudkompatibilitet) + personlige undtagelser (override kan både lægge til
// og trække fra, og vinder altid til sidst).
async function computeUserPanelPages(user) {
  if (user.role === 'admin') return PANEL_PAGES.map(p => p.key);
  const pages = new Set();
  if (user.is_finance_admin) LEGACY_FINANCE_BUNDLE.forEach(k => pages.add(k));
  if (user.panel_role_id) {
    const rows = (await pool.query('SELECT page_key FROM panel_role_pages WHERE role_id=$1', [user.panel_role_id])).rows;
    rows.forEach(r => pages.add(r.page_key));
  }
  if (user.panel_role_id || user.is_finance_admin) pages.add('dashboard');
  const overrides = (await pool.query('SELECT page_key, allowed FROM panel_user_overrides WHERE user_id=$1', [user.id])).rows;
  for (const o of overrides) {
    if (o.allowed) pages.add(o.page_key); else pages.delete(o.page_key);
  }
  return Array.from(pages);
}

// Bruges af routes der hører til ÉN bestemt side i markerings-UI'en (den store
// flertal). role==='admin' passerer altid (uændret adfærd for Martins egen og
// enhver eksisterende admin-login). For alle andre slås brugerens rolle op
// live i databasen — samme "stol ikke på en op til 30 dage gammel JWT"-
// forsigtighed som financeOnly allerede bruger ovenfor — og tjekkes mod den
// samlede sideliste (panel-rolle + evt. is_finance_admin-bundt + undtagelser).
function panelAccess(pageKey) {
  return asyncRoute(async (req, res, next) => {
    const u = await pgOne('SELECT id, role, active, is_finance_admin, panel_role_id FROM users WHERE id=$1', [req.user.id]);
    if (!u || !u.active) return res.status(403).json({ error: 'Ingen adgang' });
    if (u.role === 'admin') return next();
    const pages = await computeUserPanelPages(u);
    if (!pages.includes(pageKey)) return res.status(403).json({ error: 'Ingen adgang til denne side' });
    next();
  });
}

// Samme som panelAccess, men for de fælles CRM-konfigurationsendpoints (pipelines/
// stages/custom fields/opfølgningsregler m.fl.) der bruges fra BÅDE Leads- og
// Sales-siden — kræver blot at brugeren har adgang til MINDST én CRM-side.
function panelAccessAny(pageKeys) {
  return asyncRoute(async (req, res, next) => {
    const u = await pgOne('SELECT id, role, active, is_finance_admin, panel_role_id FROM users WHERE id=$1', [req.user.id]);
    if (!u || !u.active) return res.status(403).json({ error: 'Ingen adgang' });
    if (u.role === 'admin') return next();
    const pages = await computeUserPanelPages(u);
    if (!pageKeys.some(k => pages.includes(k))) return res.status(403).json({ error: 'Ingen adgang til denne side' });
    next();
  });
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
  // panel_role_id/panel_pages tages med i login-svaret så index.html (den fælles
  // login-side for begge apps) kan afgøre om brugeren skal til /admin eller
  // /employee — se "Roller & adgang" (sep. 2026). En almindelig markarbejder uden
  // nogen panel-rolle er 100% uændret: role!=='admin' && !panel_role_id -> /employee,
  // nøjagtig som hele tiden før dette.
  const panelPages = await computeUserPanelPages(user);
  res.json({ token, user: { id: user.id, name: user.name, role: user.role, email: user.email, color: user.color, initials: user.initials, avatar_url: user.avatar_url, is_finance_admin: !!user.is_finance_admin, can_view_team_overview: !!user.can_view_team_overview, panel_role_id: user.panel_role_id || null, panel_pages: panelPages } });
}));

app.get('/api/auth/me', auth, asyncRoute(async (req, res) => {
  const user = await pgOne('SELECT id,name,email,role,color,initials,avatar_url,is_finance_admin,can_view_team_overview,panel_role_id FROM users WHERE id=$1', [req.user.id]);
  if (!user) return res.status(401).json({ error: 'Bruger ikke fundet' });
  const panelPages = await computeUserPanelPages(user);
  res.json({ ...user, is_finance_admin: !!user.is_finance_admin, can_view_team_overview: !!user.can_view_team_overview, panel_pages: panelPages });
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
    company_iban: map.company_iban || '',
    company_swift: map.company_swift || '',
    invoice_footer_note: map.invoice_footer_note || '',
    quote_top_note_default: map.quote_top_note_default || '',
    quote_bottom_note_default: map.quote_bottom_note_default || '',
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
  if (body.company_iban !== undefined) entries.push(['company_iban', String(body.company_iban).slice(0, 40)]);
  if (body.company_swift !== undefined) entries.push(['company_swift', String(body.company_swift).slice(0, 20)]);
  if (body.invoice_footer_note !== undefined) entries.push(['invoice_footer_note', String(body.invoice_footer_note).slice(0, 1000)]);
  if (body.quote_top_note_default !== undefined) entries.push(['quote_top_note_default', sanitizeRichText(String(body.quote_top_note_default).slice(0, 2000))]);
  if (body.quote_bottom_note_default !== undefined) entries.push(['quote_bottom_note_default', sanitizeRichText(String(body.quote_bottom_note_default).slice(0, 2000))]);
  if (body.default_tax_rate !== undefined) entries.push(['default_tax_rate', String(Number(body.default_tax_rate) || 25)]);
  // completion_email_subject/completion_email_body er flyttet til det samlede
  // Skabeloner-center (PUT /api/system-email-templates/completion) — se
  // leveringsnoten om konsolideringen. Kun selve PDF-vedhæftningen bor stadig her.
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
  // Emne/besked er flyttet til det samlede Skabeloner-center (GET
  // /api/system-email-templates) — denne route dækker nu kun selve
  // PDF-vedhæftningen + mail-opsætnings-status, som stadig hører til her.
  const pdfFilenameRow = await pgOne("SELECT value FROM app_settings WHERE key='cleaning_pdf_filename'");
  const pdfRow = await pgOne("SELECT value FROM app_settings WHERE key='cleaning_pdf_base64'");
  res.json({
    has_pdf: !!(pdfRow && pdfRow.value),
    pdf_filename: (pdfFilenameRow && pdfFilenameRow.value) || null,
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
      "SELECT key,value FROM app_settings WHERE key IN ('company_name','cleaning_pdf_base64','cleaning_pdf_filename')"
    );
    const settings = {};
    settingsRows.rows.forEach(r => { settings[r.key] = r.value; });
    const sysTpl = await pgOne("SELECT * FROM system_email_templates WHERE key='completion'");
    const companyName = settings.company_name || 'Gulv Master Enterprise ApS';
    const subject = fillDocEmailVars(sysTpl?.subject || 'Vi er færdige hos dig — {{kunde}}', { kunde: 'Test-kunde', firma: companyName });
    const bodyTemplate = sysTpl?.body_html || 'Hej,\n\nDette er en TEST af færdig-mailen.\n\nVenlig hilsen\n{{firma}}';
    const bodyText = fillDocEmailVars(bodyTemplate, { opgave: 'Test-opgave', kunde: 'Test-kunde', firma: companyName });
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
    sms_provider: smsProviderName()
  });
}));
app.post('/api/settings/test-sms', auth, adminOnly, asyncRoute(async (req, res) => {
  const to = String((req.body || {}).to || '').trim();
  if (!to) return res.status(400).json({ error: 'Skriv et telefonnummer at teste med' });
  if (!smsIsConfigured()) return res.status(400).json({ error: 'SMS er ikke sat op endnu (mangler INMOBILE_API_TOKEN, GATEWAYAPI_API_TOKEN eller TWILIO_* i Render Environment)' });
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

app.post('/api/task-types', auth, panelAccess('plan'), asyncRoute(async (req, res) => {
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

app.put('/api/task-types/:key', auth, panelAccess('plan'), asyncRoute(async (req, res) => {
  const row = await pgOne('SELECT * FROM task_types WHERE key=$1', [req.params.key]);
  if (!row) return res.status(404).json({ error: 'Faget blev ikke fundet' });
  const body = req.body || {};
  const label = body.label !== undefined ? String(body.label).trim().slice(0, 60) || row.label : row.label;
  const color = body.color !== undefined ? (/^#[0-9A-Fa-f]{6}$/.test(body.color) ? body.color : row.color) : row.color;
  await pool.query('UPDATE task_types SET label=$1,color=$2 WHERE key=$3', [label, color, row.key]);
  res.json({ ok: true });
}));

app.delete('/api/task-types/:key', auth, panelAccess('plan'), asyncRoute(async (req, res) => {
  if (req.params.key === 'other') return res.status(400).json({ error: '"Andet" kan ikke slettes — den bruges som standardfarve' });
  const inUse = await pgOne('SELECT id FROM jt_tasks WHERE type_guess=$1 LIMIT 1', [req.params.key]);
  if (inUse) return res.status(400).json({ error: 'Faget er i brug på mindst én opgave — skift deres fag først' });
  const result = await pool.query('DELETE FROM task_types WHERE key=$1', [req.params.key]);
  if (!result.rowCount) return res.status(404).json({ error: 'Faget blev ikke fundet' });
  res.json({ ok: true });
}));

// ── USERS / WORKFORCE ───────────────────────────────────────
// Bemærk (Roller & adgang, sep. 2026): bevidst panelAccess('dashboard') og IKKE
// adminOnly — enhver bruger der overhovedet kan åbne admin-panelet (Kontor,
// Mester, ...) skal kunne se hold-listen, da navn/farve/initialer bruges i ALLE
// planlægnings-/kapacitetsvisninger, ikke kun på "Hold & vendors"-siden. Det er
// nøjagtig den samme fulde brugerliste (inkl. email/telefon) som en admin ser i
// dag — før denne omlægning var admin.html kun tilgængeligt for role==='admin',
// så dette er ikke en indskrænkning, men en bevidst udvidelse til nye panel-roller.
app.get('/api/users', auth, panelAccess('dashboard'), asyncRoute(async (req, res) => {
  // pay_type ('hourly'/'akkord') tages med her, så fx tidsregistrerings-modalen kan vise
  // det rigtige felt pr. valgt medarbejder — men IKKE hourly_wage (den faktiske lønsats),
  // som stadig kun udleveres via det snævre, adminOnly-gatede GET /api/users/:id/pay.
  const result = await pool.query(`
    SELECT id,name,email,role,color,initials,jobtread_name,active,worker_type,vendor_group,trade,weekly_capacity,avatar_url,COALESCE(can_login,1) AS can_login,personal_email,phone,COALESCE(notify_schedule_changes,0) AS notify_schedule_changes,COALESCE(is_finance_admin,0) AS is_finance_admin,COALESCE(can_view_team_overview,0) AS can_view_team_overview,COALESCE(pay_type,'hourly') AS pay_type
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

  // Roller & adgang (sep. 2026): panel_role_id skal kunne sættes allerede ved
  // oprettelse, ikke kun ved efterfølgende redigering — ellers forsvinder valget
  // stille i UI'en, fordi Gem på "Ny medarbejder" bruger denne route (POST), ikke
  // PUT /api/users/:id (som allerede understøtter feltet).
  const panelRoleId = body.panel_role_id ? Number(body.panel_role_id) : null;
  // Løn & akkord (sep. 2026): pay_type/hourly_wage sættes kun her og ved PUT — aldrig
  // udstillet via den brede GET /api/users-liste (bruges alle steder til navne/dropdowns),
  // for ikke at sprede lønoplysninger bredere end nødvendigt. Se GET /api/users/:id/pay.
  const payType = body.pay_type === 'akkord' ? 'akkord' : 'hourly';
  const hourlyWage = Math.max(0, Number(body.hourly_wage) || 0);
  try {
    const result = await pool.query(`
      INSERT INTO users (name,email,password_hash,role,color,initials,jobtread_name,active,worker_type,vendor_group,trade,weekly_capacity,can_login,avatar_url,personal_email,notify_schedule_changes,phone,can_view_team_overview,panel_role_id,pay_type,hourly_wage)
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21)
      RETURNING id
    `, [String(body.name).trim(), email, bcrypt.hashSync(password, 10), role, body.color || '#2563EB', initials, body.jobtread_name || null, body.active === 0 ? 0 : 1, workerType, body.vendor_group || null, body.trade || null, weeklyCapacity, canLogin ? 1 : 0, body.avatar_url || null, body.personal_email || null, body.notify_schedule_changes ? 1 : 0, body.phone ? String(body.phone).trim().slice(0, 30) : null, body.can_view_team_overview ? 1 : 0, panelRoleId, payType, hourlyWage]);
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

// Løn & akkord (sep. 2026) — bevidst sin egen, smalle, adminOnly route: hentes kun
// når "Rediger medarbejder"-modalen faktisk åbnes for én bestemt medarbejder, i stedet
// for at ligge i den brede GET /api/users-liste som alle steder i appen (fx dropdowns,
// holdoversigt) genbruger — så lønoplysninger aldrig sendes med til noget der ikke skal se dem.
app.get('/api/users/:id/pay', auth, adminOnly, asyncRoute(async (req, res) => {
  const row = await pgOne('SELECT pay_type, hourly_wage FROM users WHERE id=$1', [req.params.id]);
  if (!row) return res.status(404).json({ error: 'Bruger blev ikke fundet' });
  res.json(row);
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
    can_view_team_overview: body.can_view_team_overview !== undefined ? (body.can_view_team_overview ? 1 : 0) : Number(current.can_view_team_overview || 0),
    // Roller & adgang (sep. 2026) — hvilken panel-rolle (hvis nogen) brugeren har
    // til admin-panelet, helt uafhængig af role/worker_type ovenfor. null = ingen
    // adgang til admin-panelet overhovedet (kun den almindelige medarbejder-app).
    panel_role_id: body.panel_role_id !== undefined ? (body.panel_role_id || null) : current.panel_role_id,
    // Løn & akkord (sep. 2026) — se GET /api/users/:id/pay for hvorfor disse to ikke
    // står i den brede GET /api/users-liste.
    pay_type: body.pay_type !== undefined ? (body.pay_type === 'akkord' ? 'akkord' : 'hourly') : (current.pay_type || 'hourly'),
    hourly_wage: body.hourly_wage !== undefined ? Math.max(0, Number(body.hourly_wage) || 0) : (Number(current.hourly_wage) || 0)
  };
  if (canLogin && !next.email) return res.status(400).json({ error: 'Email mangler for login-bruger' });
  try {
    await pool.query(`
      UPDATE users SET name=$1,email=$2,password_hash=$3,role=$4,color=$5,initials=$6,jobtread_name=$7,active=$8,worker_type=$9,vendor_group=$10,trade=$11,weekly_capacity=$12,can_login=$13,avatar_url=$14,personal_email=$15,notify_schedule_changes=$16,phone=$17,can_view_team_overview=$18,panel_role_id=$19,pay_type=$20,hourly_wage=$21
      WHERE id=$22
    `, [next.name, next.email, next.password_hash, next.role, next.color, next.initials, next.jobtread_name, next.active, next.worker_type, next.vendor_group, next.trade, next.weekly_capacity, next.can_login, next.avatar_url, next.personal_email, next.notify_schedule_changes, next.phone, next.can_view_team_overview, next.panel_role_id, next.pay_type, next.hourly_wage, id]);
    res.json({ ok: true });
  } catch (error) {
    if (error.code === '23505') return res.status(400).json({ error: 'Email er allerede i brug' });
    throw error;
  }
}));

// ── ROLLER & ADGANG (sep. 2026) ──────────────────────────────
// Alt herunder er BEVIDST kun adminOnly (aldrig panelAccess) — retten til selv
// at oprette/redigere roller og tildele dem må aldrig kunne uddelegeres via
// systemet selv, ellers kunne en bruger med "Hold & vendors"-adgang i teorien
// give sig selv Admin. Kun en ægte role==='admin'-bruger (Martin) kan ændre her.
app.get('/api/panel-pages', auth, adminOnly, asyncRoute(async (req, res) => {
  res.json({ pages: PANEL_PAGES });
}));
app.get('/api/panel-roles', auth, adminOnly, asyncRoute(async (req, res) => {
  const roles = (await pool.query('SELECT * FROM panel_roles ORDER BY position ASC, id ASC')).rows;
  const pageRows = (await pool.query('SELECT role_id, page_key FROM panel_role_pages')).rows;
  const byRole = {};
  pageRows.forEach(r => { (byRole[r.role_id] = byRole[r.role_id] || []).push(r.page_key); });
  res.json(roles.map(r => ({ ...r, is_builtin: !!r.is_builtin, pages: byRole[r.id] || [] })));
}));
app.post('/api/panel-roles', auth, adminOnly, asyncRoute(async (req, res) => {
  const b = req.body || {};
  const name = String(b.name || '').trim();
  if (!name) return res.status(400).json({ error: 'Navn mangler' });
  const posRow = await pgOne('SELECT COALESCE(MAX(position),-1)+1 AS pos FROM panel_roles');
  let r;
  try {
    r = await pgOne('INSERT INTO panel_roles (name, position) VALUES ($1,$2) RETURNING id', [name, posRow.pos]);
  } catch (error) {
    if (error.code === '23505') return res.status(400).json({ error: 'En rolle med det navn findes allerede' });
    throw error;
  }
  const pages = Array.isArray(b.pages) ? b.pages.filter(k => PANEL_PAGE_KEYS.has(k)) : [];
  for (const key of pages) {
    await pool.query('INSERT INTO panel_role_pages (role_id, page_key) VALUES ($1,$2) ON CONFLICT DO NOTHING', [r.id, key]);
  }
  res.json({ ok: true, id: r.id });
}));
app.put('/api/panel-roles/:id', auth, adminOnly, asyncRoute(async (req, res) => {
  const id = Number(req.params.id);
  const current = await pgOne('SELECT * FROM panel_roles WHERE id=$1', [id]);
  if (!current) return res.status(404).json({ error: 'Rolle ikke fundet' });
  const b = req.body || {};
  if (b.name !== undefined) {
    const name = String(b.name).trim();
    if (!name) return res.status(400).json({ error: 'Navn mangler' });
    try {
      await pool.query('UPDATE panel_roles SET name=$1 WHERE id=$2', [name, id]);
    } catch (error) {
      if (error.code === '23505') return res.status(400).json({ error: 'En rolle med det navn findes allerede' });
      throw error;
    }
  }
  // pages: sender den FULDE liste af sider rollen nu skal have — enklest for
  // markerings-UI'en (send alle afkrydsede kasser ved hvert gem, ikke et diff).
  if (Array.isArray(b.pages)) {
    const pages = b.pages.filter(k => PANEL_PAGE_KEYS.has(k));
    await pool.query('DELETE FROM panel_role_pages WHERE role_id=$1', [id]);
    for (const key of pages) {
      await pool.query('INSERT INTO panel_role_pages (role_id, page_key) VALUES ($1,$2) ON CONFLICT DO NOTHING', [id, key]);
    }
  }
  res.json({ ok: true });
}));
app.delete('/api/panel-roles/:id', auth, adminOnly, asyncRoute(async (req, res) => {
  const id = Number(req.params.id);
  const current = await pgOne('SELECT * FROM panel_roles WHERE id=$1', [id]);
  if (!current) return res.status(404).json({ error: 'Rolle ikke fundet' });
  if (current.is_builtin) return res.status(400).json({ error: 'Denne rolle kan ikke slettes' });
  const inUse = await pgOne('SELECT COUNT(*)::int AS n FROM users WHERE panel_role_id=$1', [id]);
  if (inUse && inUse.n > 0) return res.status(400).json({ error: `${inUse.n} bruger(e) har stadig denne rolle — flyt dem til en anden rolle først` });
  await pool.query('DELETE FROM panel_roles WHERE id=$1', [id]);
  res.json({ ok: true });
}));
// Personlige undtagelser oveni en brugers rolle (allowed=true lægger en side
// til, allowed=false fjerner en side rollen ellers ville give).
app.get('/api/users/:id/panel-overrides', auth, adminOnly, asyncRoute(async (req, res) => {
  const rows = (await pool.query('SELECT page_key, allowed FROM panel_user_overrides WHERE user_id=$1', [req.params.id])).rows;
  res.json({ overrides: rows.map(r => ({ page_key: r.page_key, allowed: !!r.allowed })) });
}));
app.put('/api/users/:id/panel-overrides', auth, adminOnly, asyncRoute(async (req, res) => {
  const userId = Number(req.params.id);
  const user = await pgOne('SELECT id FROM users WHERE id=$1', [userId]);
  if (!user) return res.status(404).json({ error: 'Bruger ikke fundet' });
  const overrides = Array.isArray((req.body || {}).overrides) ? req.body.overrides : [];
  await pool.query('DELETE FROM panel_user_overrides WHERE user_id=$1', [userId]);
  for (const o of overrides) {
    if (!PANEL_PAGE_KEYS.has(o.page_key)) continue;
    await pool.query('INSERT INTO panel_user_overrides (user_id, page_key, allowed) VALUES ($1,$2,$3)', [userId, o.page_key, o.allowed ? 1 : 0]);
  }
  res.json({ ok: true });
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
  return !!process.env.INMOBILE_API_TOKEN || !!process.env.GATEWAYAPI_API_TOKEN || !!(process.env.TWILIO_ACCOUNT_SID && process.env.TWILIO_AUTH_TOKEN && process.env.TWILIO_FROM_NUMBER);
}
function smsProviderName() {
  if (process.env.INMOBILE_API_TOKEN) return 'inMobile';
  if (process.env.GATEWAYAPI_API_TOKEN) return 'GatewayAPI';
  if (process.env.TWILIO_ACCOUNT_SID) return 'Twilio';
  return null;
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
  // inMobile (dansk udbyder, Martins eksisterende SMS-leverandør) tjekkes
  // FØRST, så en sat INMOBILE_API_TOKEN altid vinder over de andre uden at
  // man behøver fjerne dem. BEKRÆFTET mod inMobiles egen live REST API-doku-
  // mentation (api.inmobile.com/docs, sep. 2026), efter en rigtig nøgle først
  // gav "Error parsing basic auth" (Bearer-header var forkert) og derefter
  // "Invalid credentials or IP not valid" (nøglen sad som BRUGERNAVN med tomt
  // password — også forkert). inMobiles egen doku siger ordret: "Provide
  // Basic Authentication with an arbitrary username and your api key as
  // PASSWORD, e.g. some_value_to_be_ignored:your_api_key_here" — dvs. nøglen
  // skal stå som PASSWORD, ikke brugernavn. Endpointet forventer desuden en
  // "messages"-liste (ikke et fladt objekt) med de påkrævede felter to/from/
  // text pr. besked — også rettet herunder, jf. https://api.inmobile.com/v4/sms/outgoing.
  if (process.env.INMOBILE_API_TOKEN) {
    const response = await fetch('https://api.inmobile.com/v4/sms/outgoing', {
      method: 'POST',
      headers: {
        'Authorization': 'Basic ' + Buffer.from('gulvmaster:' + process.env.INMOBILE_API_TOKEN).toString('base64'),
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        messages: [{
          to: phone.replace('+', ''),
          from: (process.env.INMOBILE_SENDER || 'GulvMaster').slice(0, 11),
          text: message
        }]
      })
    });
    if (!response.ok) {
      const raw = await response.text().catch(() => '');
      throw new Error(`inMobile HTTP ${response.status}: ${raw.slice(0, 300)}`);
    }
    return;
  }
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
  throw new Error('Ingen SMS-udbyder er sat op på serveren — mangler INMOBILE_API_TOKEN, GATEWAYAPI_API_TOKEN eller TWILIO_*');
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
    "SELECT key,value FROM app_settings WHERE key IN ('company_name','cleaning_pdf_base64','cleaning_pdf_filename')"
  );
  const settings = {};
  settingsRows.rows.forEach(r => { settings[r.key] = r.value; });
  // Emne/besked kommer nu fra det samlede Skabeloner-center (system_email_templates),
  // ikke længere fra app_settings — se leveringsnoten om konsolideringen.
  const sysTpl = await pgOne("SELECT * FROM system_email_templates WHERE key='completion'");
  if (sysTpl && !sysTpl.enabled) {
    await pool.query(
      'INSERT INTO completion_emails (booking_id,task_id,to_email,status,error,sent_at) VALUES ($1,$2,$3,$4,$5,' + nowTextSQL() + ')',
      [booking.id, booking.task_id, null, 'skipped', 'Skabelonen "Færdig-mail til kunden" er slået fra i Skabeloner-centeret']
    );
    return;
  }

  const companyName = settings.company_name || 'Gulv Master Enterprise ApS';
  const jobName = task?.job_name || 'din opgave';
  const subject = fillDocEmailVars(sysTpl?.subject || 'Vi er færdige hos dig — {{kunde}}', { kunde: jobName, firma: companyName });
  const bodyTemplate = sysTpl?.body_html ||
    'Hej,\n\nVi vil gerne informere dig om, at vi nu er færdige med arbejdet hos dig ({{opgave}}).\n\nVedhæftet finder du en vejledning til efterbehandling/rengøring.\n\nMange tak for denne gang!\n\nVenlig hilsen\n{{firma}}';
  const bodyText = fillDocEmailVars(bodyTemplate, { opgave: jobName, kunde: jobName, firma: companyName });
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

// ══ GANTT UNDER PROJEKTER — NU 100% PÅ APPENS EGNE SAGER ═══════════════════
//
// AFKOBLET 05-09-2026: Gantt-fanen hentede og skrev tidligere LIVE til
// JobTread (job-vælger, "Synk med JobTread", og hver eneste rettelse gik
// gennem jtFetch/updateTask FØR den blev gemt lokalt). Martin er flyttet helt
// væk fra JobTread — kunder, sager, tilbud og tidsplaner ligger nu i appens
// egne tabeller (projects/quotes/gantt_tasks) — så fanen kører nu udelukkende
// på Projekter-data via de to nye ruter herunder plus de allerede eksisterende
// /api/projects/:id(/tasks) -ruter, som sags-Gantt'et på sagsdetaljesiden også
// bruger (og som selv holder Opgavepool/Kapacitet/Tidslinje opdateret via
// mirrorProjectTaskToPool).
//
// Rutemonteringerne nedenfor er KOMMENTERET UD, ikke slettet — samme
// reversible mønster som ved JobTread-synkknapperne længere nede. Hjælpe-
// funktionerne fetchGanttTasksFromJT/syncAllGanttTasksFromJT/syncGanttJob står
// stadig defineret lige ovenfor og er urørte; de er nu udelukkende nået fra
// disse udkommenterede ruter (kontrolleret: ingen andre kaldesteder i filen),
// og ligger derfor hen som ubrugt kode indtil videre. Fjern kommentartegnene
// her igen, så virker JobTread-koblingen præcis som før.
//
//   GET  /api/gantt/jobs            → erstattet af GET /api/gantt/projects
//   GET  /api/gantt/all-tasks       → samme sti, men helt ny handler (se nedenfor)
//   POST /api/gantt/sync-all        → udgået, der er intet eksternt system at synke med
//   GET  /api/gantt/job/:jobId      → erstattet af GET /api/projects/:id (.tasks)
//   POST /api/gantt/job/:jobId/sync → udgået, samme grund som sync-all
//   PUT  /api/gantt/tasks/:id       → erstattet af PUT /api/projects/:id/tasks/:taskId
//   POST /api/gantt/job/:jobId/tasks→ erstattet af POST /api/projects/:id/tasks
//
// app.get('/api/gantt/jobs', auth, asyncRoute(async (req, res) => {
//   // Henter ALLE kendte sager på én gang (ikke kun søgeresultater), inkl. det
//   // fag der oftest går igen på sagens opgaver — så admin kan bladre/gruppere
//   // med det samme uden at skulle vide/skrive kundens navn i forvejen.
//   //
//   // is_project/project_id: Martins ønske (sep. 2026) om at Gantt skal "hente
//   // data fra Projekt-delen" — der findes IKKE noget rigtigt job_id-link mellem
//   // JobTread-sager og den lokale `projects`-tabel i dag, kun et løst tekstfelt
//   // (sagsnummer/job_number, samme konvention begge steder), så vi kobler på
//   // DET i stedet for at bygge en ny hård FK. Bevidst en LEFT JOIN, ikke et
//   // filter: at skjule JobTread-sager uden en Projekt-post ville være en reel
//   // regression (Martin bruger stadig Gantt på sager der ikke nødvendigvis er
//   // oprettet som en formel "Projekt" endnu) — se leveringsnoten.
//   const rows = await pool.query(`
//     SELECT
//       j.job_id,
//       MAX(j.job_name) AS job_name,
//       MAX(j.job_number) AS job_number,
//       MAX(j.job_address) AS job_address,
//       MODE() WITHIN GROUP (ORDER BY j.type_guess) AS trade,
//       COUNT(*)::int AS task_count,
//       MAX(j.synced_at) AS last_synced,
//       MAX(p.id) AS project_id
//     FROM jt_tasks j
//     LEFT JOIN projects p ON p.job_number = j.job_number AND j.job_number IS NOT NULL AND j.job_number <> ''
//     WHERE j.job_id IS NOT NULL AND j.job_id <> ''
//     GROUP BY j.job_id
//     ORDER BY (MAX(p.id) IS NOT NULL) DESC, MAX(j.job_name) ASC
//   `);
//   res.json(rows.rows);
// }));
//
// app.get('/api/gantt/all-tasks', auth, asyncRoute(async (req, res) => {
//   let count = await pgOne('SELECT COUNT(*)::int AS n FROM gantt_tasks');
//   if (!count || !count.n) {
//     const r = await syncAllGanttTasksFromJT();
//     if (!r.ok && !r.skipped) return res.status(400).json({ error: r.error || 'Kunne ikke hente opgaverne' });
//   }
//   const rows = await pool.query(`
//     SELECT g.*, COALESCE(g.job_phone, t.customer_phone) AS resolved_phone, COALESCE(g.job_email, t.customer_email) AS resolved_email,
//            COALESCE(g.job_address, t.job_address) AS resolved_address
//     FROM gantt_tasks g
//     LEFT JOIN jt_tasks t ON t.job_id = g.job_id AND t.customer_phone IS NOT NULL
//     ORDER BY g.job_name ASC, g.start_date ASC
//     LIMIT 2000
//   `);
//   const seen = new Set();
//   const out = [];
//   for (const r of rows.rows) {
//     if (seen.has(r.id)) continue; // LEFT JOIN kan give flere rækker pr. opgave — behold kun én
//     seen.add(r.id);
//     out.push({
//       id: r.id, job_id: r.job_id, job_name: r.job_name, job_number: r.job_number,
//       name: r.name, description: r.description, start_date: r.start_date, end_date: r.end_date,
//       progress: r.progress, is_group: !!r.is_group, parent_task_id: r.parent_task_id,
//       depends_on: safeJsonParse(r.depends_on, []), type_guess: r.type_guess,
//       job_phone: r.resolved_phone, job_email: r.resolved_email, job_address: r.resolved_address
//     });
//   }
//   // SIKKERHED: viser tydeligt hvor friske data er, så man aldrig er i tvivl om man
//   // kigger på noget der blev flyttet i JobTread for nyligt, men endnu ikke er hentet
//   // ned hertil — i stedet for at det bare stille viser forældede datoer.
//   const lastSynced = await pgOne('SELECT MAX(synced_at) AS t FROM gantt_tasks');
//   res.json({ tasks: out, lastSyncedAt: lastSynced?.t || null });
// }));
//
// app.post('/api/gantt/sync-all', auth, panelAccess('projects'), asyncRoute(async (req, res) => {
//   const r = await syncAllGanttTasksFromJT();
//   if (!r.ok) return res.status(400).json({ error: r.error || 'Synk fejlede' });
//   res.json(r);
// }));
//
// app.get('/api/gantt/job/:jobId', auth, asyncRoute(async (req, res) => {
//   let rows = await pool.query('SELECT * FROM gantt_tasks WHERE job_id=$1 ORDER BY position ASC, id ASC', [req.params.jobId]);
//   if (!rows.rowCount) {
//     // Første gang dette job åbnes — hent live fra JobTread med det samme.
//     try {
//       await syncGanttJob(req.params.jobId);
//       rows = await pool.query('SELECT * FROM gantt_tasks WHERE job_id=$1 ORDER BY position ASC, id ASC', [req.params.jobId]);
//     } catch (error) {
//       return res.status(400).json({ error: error.message });
//     }
//   }
//   res.json(rows.rows.map(r => ({ ...r, depends_on: safeJsonParse(r.depends_on, []) })));
// }));
//
// app.post('/api/gantt/job/:jobId/sync', auth, panelAccess('projects'), asyncRoute(async (req, res) => {
//   try {
//     const result = await syncGanttJob(req.params.jobId);
//     res.json({ ok: true, ...result });
//   } catch (error) {
//     res.status(400).json({ error: error.message });
//   }
// }));
//
// app.put('/api/gantt/tasks/:id', auth, panelAccess('projects'), asyncRoute(async (req, res) => {
//   const current = await pgOne('SELECT * FROM gantt_tasks WHERE id=$1', [req.params.id]);
//   if (!current) return res.status(404).json({ error: 'Opgaven blev ikke fundet' });
//   const body = req.body || {};
//   const next = {
//     name: body.name !== undefined ? String(body.name).trim() : current.name,
//     start_date: body.start_date !== undefined ? body.start_date : current.start_date,
//     end_date: body.end_date !== undefined ? body.end_date : current.end_date,
//     progress: body.progress !== undefined ? Math.max(0, Math.min(1, Number(body.progress))) : current.progress
//   };
//   // Skriv til JobTread FØRST — hvis det fejler, skal vi ikke gemme en lokal
//   // version der er ude af trit med den rigtige sag.
//   try {
//     await jtFetch({
//       query: {
//         $: { grantKey: JT_GRANT },
//         updateTask: {
//           $: { id: current.id, name: next.name, startDate: next.start_date, endDate: next.end_date, progress: next.progress, notify: false, updateDependentTasks: true }
//         }
//       }
//     }, 'Gantt: opdatér opgave i JobTread');
//   } catch (error) {
//     return res.status(400).json({ error: 'Kunne ikke opdatere i JobTread: ' + error.message });
//   }
//   // JobTread rykker automatisk afhængige opgaver (updateDependentTasks:true) —
//   // så vi genhenter HELE jobbet i stedet for kun at rette denne ene opgave
//   // lokalt, ellers ville de kaskade-flyttede opgaver ikke opdatere sig i vores
//   // eget Gantt-kort før næste manuelle synk.
//   try {
//     await syncGanttJob(current.job_id);
//   } catch (error) {
//     // Selve JobTread-opdateringen lykkedes — kun genhentningen fejlede. Gem i
//     // det mindste denne ene opgave lokalt, så UI'en ikke falder helt tilbage.
//     await pool.query(`
//       UPDATE gantt_tasks SET name=$1, start_date=$2, end_date=$3, progress=$4, synced_at=${nowTextSQL()} WHERE id=$5
//     `, [next.name, next.start_date, next.end_date, next.progress, current.id]);
//   }
//   res.json({ ok: true });
// }));
//
// app.post('/api/gantt/job/:jobId/tasks', auth, panelAccess('projects'), asyncRoute(async (req, res) => {
//   const body = req.body || {};
//   const name = String(body.name || '').trim();
//   if (!name) return res.status(400).json({ error: 'Skriv et navn til opgaven' });
//   if (!validDate(body.start_date)) return res.status(400).json({ error: 'Vælg en gyldig startdato' });
//   let createdId;
//   try {
//     const result = await jtFetch({
//       query: {
//         $: { grantKey: JT_GRANT },
//         createTask: {
//           $: {
//             targetId: req.params.jobId, targetType: 'job', name,
//             startDate: body.start_date, endDate: body.end_date || body.start_date,
//             isToDo: false, notify: false,
//             ...(body.depends_on ? { dependsOnTasks: [{ id: body.depends_on }] } : {})
//           },
//           createdTask: { id: {} }
//         }
//       }
//     }, 'Gantt: opret opgave i JobTread');
//     createdId = result?.createTask?.createdTask?.id;
//     if (!createdId) throw new Error('JobTread returnerede intet id');
//   } catch (error) {
//     return res.status(400).json({ error: 'Kunne ikke oprette i JobTread: ' + error.message });
//   }
//   await pool.query(`
//     INSERT INTO gantt_tasks (id,job_id,job_name,name,description,start_date,end_date,progress,is_group,parent_task_id,position,depends_on,synced_at)
//     VALUES ($1,$2,(SELECT job_name FROM gantt_tasks WHERE job_id=$2 LIMIT 1),$3,'',$4,$5,0,0,NULL,'',$6,${nowTextSQL()})
//   `, [createdId, req.params.jobId, name, body.start_date, body.end_date || body.start_date, JSON.stringify(body.depends_on ? [body.depends_on] : [])]);
//   res.json({ ok: true, id: createdId });
// }));

// Vælgerlisten i Gantt-fanen: appens EGNE sager. Afløser GET /api/gantt/jobs.
// task_count bruger præcis samme delforespørgsel som GET /api/projects, så
// tallet i vælgeren altid stemmer med det Projekter-listen viser.
// Sortering: sager der faktisk HAR en tidsplan først (det er dem man skal have
// fat i her), derefter alfabetisk — rent en UI-beslutning, ingen data afhænger
// af rækkefølgen.
app.get('/api/gantt/projects', auth, asyncRoute(async (req, res) => {
  const rows = await pool.query(`
    SELECT p.id, p.name, p.job_number, p.customer_address, p.status,
      (SELECT COUNT(*)::int FROM gantt_tasks WHERE project_id=p.id) AS task_count
    FROM projects p
    ORDER BY ((SELECT COUNT(*) FROM gantt_tasks WHERE project_id=p.id) > 0) DESC, p.name ASC, p.id ASC
  `);
  res.json(rows.rows);
}));

// "📊 Se alle opgaver" — alle sags-opgaver på tværs af ALLE sager, samlet.
// Helt ny handler; den gamle af samme navn (udkommenteret ovenfor) hentede fra
// JobTread. INNER JOIN på projects, så kun rigtige sags-opgaver kommer med —
// gamle JobTread-rækker i gantt_tasks (project_id IS NULL) hører ikke til her.
//
// project_id følger med på HVER opgave, fordi klienten skal kunne slå den rette
// sag op pr. opgave når man retter noget i denne kombinerede visning (der er
// ingen "nuværende sag" at falde tilbage på her) — se ganttProjectIdForTask()
// i admin.html.
//
// type_guess er ALTID NULL på sags-opgaver (feltet blev kun udfyldt af
// JobTread-synken). Fag-filteret i "Se alle opgaver" lander derfor alt under
// "Andet" — bevidst accepteret begrænsning, ikke noget der gættes på her.
app.get('/api/gantt/all-tasks', auth, asyncRoute(async (req, res) => {
  const rows = await pool.query(`
    SELECT g.id, g.project_id, g.name, g.description, g.start_date, g.end_date,
           g.progress, g.is_group, g.parent_task_id, g.position, g.depends_on, g.type_guess,
           p.name AS project_name, p.job_number, p.status AS project_status,
           p.customer_address, p.customer_phone, p.customer_email
    FROM gantt_tasks g
    JOIN projects p ON p.id = g.project_id
    WHERE g.project_id IS NOT NULL
    ORDER BY p.name ASC, g.start_date ASC, g.position ASC, g.id ASC
    LIMIT 2000
  `);
  res.json({
    tasks: rows.rows.map(r => ({
      id: r.id, project_id: r.project_id, project_name: r.project_name,
      job_number: r.job_number, project_status: r.project_status,
      name: r.name, description: r.description,
      start_date: r.start_date, end_date: r.end_date,
      progress: r.progress, is_group: !!r.is_group, parent_task_id: r.parent_task_id,
      // Sags-opgaver får aldrig sat depends_on (POST/PUT /api/projects/:id/tasks
      // kender ikke afhængigheder), så det bliver reelt altid [] — kolonnen
      // læses alligevel, så en evt. gammel værdi ikke forsvinder lydløst.
      depends_on: safeJsonParse(r.depends_on, []) || [],
      type_guess: r.type_guess,
      customer_phone: r.customer_phone, customer_email: r.customer_email,
      customer_address: r.customer_address
    }))
  });
}));

// ── AFKOBLET 05-09-2026: JOBTREAD-SYNKKNAPPERNE ────────────────────────────
// "⚡ Synk JT" og "📞 Synk telefon & vejr" er fjernet fra Indstillinger, fordi
// opgavepoolen nu kun kører på appens egne data (se det store notat i start()).
// Selve rutemonteringen er kommenteret ud — handler-funktionerne (syncFromJT,
// syncCustomerPhonesFromJT) står stadig defineret længere oppe og er urørte, så
// det hele kan genaktiveres ved bare at fjerne kommentartegnene her igen.
//
// app.post('/api/sync-phones', auth, adminOnly, asyncRoute(async (req, res) => {
//   const result = await syncCustomerPhonesFromJT();
//   // Do not make the admin browser wait for weather. The phone rows have already
//   // been saved before this background process begins.
//   if (result.ok) {
//     syncJobGeocodesInBackground().catch(error => console.error('Baggrunds-geokodning fejlede:', error.message));
//   }
//   res.status(result.ok ? 200 : 500).json({ ...result, weather_sync_started: Boolean(result.ok) });
// }));
//
// app.post('/api/sync', auth, adminOnly, asyncRoute(async (req, res) => {
//   const result = await syncFromJT();
//   res.status(result.ok ? 200 : 500).json(result);
// }));

// ══ JOBTREAD → PROJEKTER: "HENT NYE SAGER" ══════════════════════════════
//
// Martin planlægger fortsat sine sager i JobTread, men vil have dem ind i
// appens EGEN Projekter-sektion, så alt det der hænger på et projekt
// (fakturering, tidsregistrering, kvalitetssikring, billeder, sags-Gantt)
// virker på dem. Indtil nu kunne et projekt KUN opstå som en sidegevinst af at
// en kunde underskrev et internt tilbud (se POST /api/public/quotes/:token/accept)
// — der fandtes slet ingen anden vej ind.
//
// Denne import laver derfor præcis det samme som en accept ville have gjort:
// et fuldt internt tilbud, oprettet direkte som 'accepted' (signed_name =
// 'JobTread-import'), og oven på det et projekt + en sags-Gantt-linje der
// spænder over de datoer sagen er planlagt til i JobTread. Resultatet er en
// helt almindelig sag i appen — ikke en specialsag med huller i.
//
// HVORNÅR TÆLLER EN JOBTREAD-SAG SOM "PLANLAGT"?
// IKKE på sagens eget "Status"-felt. Det er undersøgt i Martins rigtige data:
// feltet bliver ikke holdt opdateret, så massevis af sager der reelt er
// planlagt og i gang står stadig som "Estimating". Det pålidelige signal er
// om sagen har mindst én rigtig kalender-opgave i JobTreads egen planlægning
// (organization.tasks med targetType='job' og isGroup=false). Kun de sager
// hentes ind — på den måde slæber knappen ikke 300 løse tilbudssager med.
//
// Knappen er bygget til at kunne trykkes igen og igen: allerede importerede
// sager kendes på projects.jobtread_job_id og springes over.

// Sagsdetaljer hentes i små bidder. JobTread svarer 413 (Request Entity Too
// Large) når man kombinerer for mange id'er i ét "in"-filter med for mange
// nestede felter pr. sag — målt i Martins portal: 20 id'er med alle felterne
// herunder går igennem, 25-40 gør ikke. Derfor en behersket startstørrelse
// PLUS en fallback der halverer bidden og prøver igen (se jtImportFetchJobChunk),
// så importen tilpasser sig selv i stedet for at vælte hvis grænsen flytter sig.
const JT_IMPORT_JOB_CHUNK = 15;

// Kandidat-navne på JobTreads job-custom-fields. Feltnavne kan variere/omdøbes i
// portalen, så der slås op på flere stavemåder og falder stille tilbage til null
// — værdierne bruges KUN i den interne note på tilbuddet, aldrig til beslutninger
// eller til noget kundevendt, så et manglende felt er harmløst.
const JT_IMPORT_FIELD_ALIASES = {
  statusRaw: ['Status'],
  projektType: ['Projekt Type', 'Projekttype'],
  salesRep: ['Sales Rep', 'Sælger', 'Salgsansvarlig'],
  projectManager: ['Project Manager', 'Projektleder', 'Sagsansvarlig']
};

function jtImportCustomFields(job) {
  const byName = {};
  for (const fv of listNodes(job?.customFieldValues)) {
    const label = fv?.customField?.name;
    if (label && fv?.value != null && fv.value !== '') byName[String(label).trim()] = String(fv.value);
  }
  const out = {};
  for (const key of Object.keys(JT_IMPORT_FIELD_ALIASES)) {
    out[key] = null;
    for (const alias of JT_IMPORT_FIELD_ALIASES[key]) {
      if (byName[alias]) { out[key] = byName[alias]; break; }
    }
  }
  return out;
}

// Sagsnavnet i JobTread er normalt sigende ("Per Bo Austin - Gulvlægning"), men
// nogle sager hedder bare "Job GM-2026-0123" e.l. Er navnet tomt eller kun en
// gentagelse af sagsnummeret, bruges nummeret direkte i stedet for at lave en
// sag der hedder noget intetsigende i Projekter-listen.
function jtImportProjectName(jobData) {
  const name = String(jobData?.name || '').trim();
  const number = String(jobData?.number || '').trim();
  const generic = !name || /^job\s+/i.test(name) || (number && name.toLowerCase() === number.toLowerCase());
  if (generic && number) return number;
  return name || number || 'JobTread-sag';
}

// Hele metadata-sporet fra JobTread lægges i tilbuddets INTERNE note
// (internal_note), aldrig i den kundevendte "notes" — internal_note vises kun i
// admin, mens notes ender på PDF'en og kundesiden. En importeret sag skal ikke
// vise Martins interne JobTread-felter til kunden.
function jtImportInternalNote(jobData) {
  const parts = ['Automatisk oprettet fra JobTread ("Hent nye sager") — kunden har IKKE underskrevet dette tilbud i appen.'];
  if (jobData.jobtreadJobId) parts.push('JobTread-sag: ' + jobData.jobtreadJobId + (jobData.number ? ' (' + jobData.number + ')' : ''));
  if (jobData.statusRaw) parts.push('Status i JobTread: ' + jobData.statusRaw);
  if (jobData.projektType) parts.push('Projekt Type: ' + jobData.projektType);
  if (jobData.salesRep) parts.push('Sælger: ' + jobData.salesRep);
  if (jobData.projectManager) parts.push('Projektleder: ' + jobData.projectManager);
  if (jobData.startDate) parts.push('Planlagt i JobTread: ' + jobData.startDate + (jobData.endDate && jobData.endDate !== jobData.startDate ? ' → ' + jobData.endDate : ''));
  else parts.push('Bemærk: sagen har planlagte opgaver i JobTread, men uden datoer — der er derfor ikke lagt noget i sagens tidsplan.');
  if (jobData.priceSource === 'customerOrder') parts.push('Beløb hentet fra underskrevet kundeordre i JobTread (ekskl. moms).');
  else if (jobData.priceSource === 'costItems') parts.push('Beløb hentet fra JobTreads cost items (ekskl. moms) — der findes endnu ingen underskrevet kundeordre på sagen.');
  else parts.push('OBS: JobTread har ingen prisdata på denne sag (hverken underskrevet kundeordre eller cost items). Tilbuddet er oprettet med 0 kr og skal rettes manuelt.');
  return parts.join('\n');
}

// Henter ÉN bid sagsdetaljer. Rammer vi JobTreads 413-grænse, halveres bidden og
// hver halvdel prøves igen — så tilpasser importen sig selv i stedet for at
// afhænge af én hårdkodet størrelse. Kan selv en enkelt sag ikke hentes med
// pris-felterne, hentes den uden dem (sagen kommer så ind med 0 kr, hvilket er
// langt bedre end at hele importen fejler).
async function jtImportFetchJobChunk(ids) {
  const baseFields = {
    id: {}, name: {}, number: {}, createdAt: {},
    location: { formattedAddress: {}, account: { name: {} } },
    customFieldValues: { $: { size: 20 }, nodes: { customField: { name: {} }, value: {} } }
  };
  const priceFields = {
    documents: { $: { size: 10, sortBy: [{ field: 'signedAt', order: 'desc' }] }, nodes: { type: {}, status: {}, price: {}, signedAt: {} } },
    costItems: { sum: { $: 'price' } }
  };
  const run = async (fields, label) => {
    const data = await jtFetch({ query: { $: { grantKey: JT_GRANT }, organization: { $: { id: JT_ORG }, jobs: {
      $: { size: ids.length, where: ['id', 'in', ids] },
      count: {}, nodes: fields
    } } } }, label);
    return listNodes(data?.organization?.jobs);
  };
  try {
    return await run({ ...baseFields, ...priceFields }, 'Sagsimport: sagsdetaljer (' + ids.length + ' sager)');
  } catch (error) {
    const tooLarge = /HTTP 413/.test(String(error?.message || ''));
    if (!tooLarge) throw error;
    if (ids.length > 1) {
      const mid = Math.ceil(ids.length / 2);
      const first = await jtImportFetchJobChunk(ids.slice(0, mid));
      const second = await jtImportFetchJobChunk(ids.slice(mid));
      return first.concat(second);
    }
    // Sidste udvej for en enkelt tung sag: drop pris-felterne.
    const rows = await run(baseFields, 'Sagsimport: sagsdetaljer uden prisfelter (1 sag)');
    return rows.map(row => ({ ...row, __priceUnavailable: true }));
  }
}

// Bedste tilgængelige pris, i den prioritet Martin har bekræftet:
//   (a) summen af UNDERSKREVNE kundeordrer (customerOrder med signedAt) — det er
//       det kunden faktisk har sagt ja til,
//   (b) ellers JobTreads rå cost-item-sum (interne budgetlinjer uden dokument),
//   (c) ellers 0 — sagen oprettes stadig, med en note om at prisen mangler.
// Alle beløb er EKSKL. moms (JobTreads `price`, ikke `priceWithTax`), fordi det
// er det tilbudslinjens sell_price skal være — computeTotals lægger selv momsen
// oveni bagefter, præcis som ved et normalt tilbud.
function jtImportResolvePrice(job) {
  if (job?.__priceUnavailable) return { price: 0, priceSource: 'none' };
  const signedOrders = listNodes(job?.documents).filter(d => d?.type === 'customerOrder' && d?.signedAt);
  if (signedOrders.length) {
    const sum = signedOrders.reduce((total, d) => total + (Number(d.price) || 0), 0);
    if (sum > 0) return { price: sum, priceSource: 'customerOrder' };
  }
  const costSum = Number(job?.costItems?.sum);
  if (Number.isFinite(costSum) && costSum > 0) return { price: costSum, priceSource: 'costItems' };
  return { price: 0, priceSource: 'none' };
}

// (a) HENT-DELEN — taler UDELUKKENDE med JobTread, rører aldrig databasen.
// Holdt bevidst adskilt fra skrive-delen nedenfor, så skrive-delen kan testes
// fuldt ud uden JobTread-adgang (og omvendt).
async function jtImportFetchPlannedJobs() {
  if (!JT_GRANT || !JT_ORG) {
    return { ok: false, error: 'JobTread er ikke sat op på serveren (Grant Key/Organisation ID mangler) — kan ikke hente sager.' };
  }
  try {
    // ── TRIN 1: alle planlagte kalender-opgaver, side for side. Ud af dem
    // udledes både HVILKE sager der er planlagte, og hvilket datospænd de har.
    const ranges = new Map(); // JobTread-sags-id → {start,end,tasks}
    let cursor, page = 0;
    while (page < JT_MAX_PAGES) {
      const args = { size: 50, where: { and: [['targetType', 'job'], ['isGroup', false]] } };
      if (cursor) args.page = cursor;
      const data = await jtFetch({ query: { $: { grantKey: JT_GRANT }, organization: { $: { id: JT_ORG },
        tasks: { $: args, count: {}, nextPage: {}, nodes: { id: {}, startDate: {}, endDate: {}, job: { id: {} } } }
      } } }, 'Sagsimport: planlagte opgaver s.' + (page + 1));
      const conn = data?.organization?.tasks;
      for (const task of listNodes(conn)) {
        const jobId = task?.job?.id;
        if (!jobId) continue;
        const range = ranges.get(jobId) || { start: null, end: null, tasks: 0 };
        range.tasks++;
        // En opgave uden datoer tæller stadig som "planlagt" (sagen ligger i
        // JobTreads kalender), men kan naturligvis ikke bidrage til datospændet.
        if (validDate(task.startDate) && (!range.start || task.startDate < range.start)) range.start = task.startDate;
        const endCandidate = validDate(task.endDate) ? task.endDate : (validDate(task.startDate) ? task.startDate : null);
        if (endCandidate && (!range.end || endCandidate > range.end)) range.end = endCandidate;
        ranges.set(jobId, range);
      }
      page++;
      cursor = conn?.nextPage;
      if (!cursor) break;
    }
    const jobIds = [...ranges.keys()];
    if (!jobIds.length) return { ok: true, jobs: [], pages: page };

    // ── TRIN 2: sagsdetaljer + pris, i små bidder (se JT_IMPORT_JOB_CHUNK).
    const jobs = [];
    for (let i = 0; i < jobIds.length; i += JT_IMPORT_JOB_CHUNK) {
      const chunk = jobIds.slice(i, i + JT_IMPORT_JOB_CHUNK);
      for (const job of await jtImportFetchJobChunk(chunk)) {
        if (!job?.id) continue;
        const range = ranges.get(job.id) || { start: null, end: null, tasks: 0 };
        const fields = jtImportCustomFields(job);
        const { price, priceSource } = jtImportResolvePrice(job);
        const row = {
          jobtreadJobId: job.id,
          name: String(job.name || '').trim(),
          number: String(job.number || '').trim(),
          customerName: String(job.location?.account?.name || '').trim(),
          address: String(job.location?.formattedAddress || '').trim(),
          statusRaw: fields.statusRaw,
          projektType: fields.projektType,
          salesRep: fields.salesRep,
          projectManager: fields.projectManager,
          notes: null,
          startDate: range.start,
          endDate: range.end || range.start,
          price,
          priceSource
        };
        row.notes = jtImportInternalNote(row);
        jobs.push(row);
      }
    }
    return { ok: true, jobs, pages: page };
  } catch (error) {
    return { ok: false, error: redactSecret(error?.message || 'Ukendt fejl ved hentning fra JobTread').slice(0, 900) };
  }
}

// Kundematch for DENNE import. BEVIDST anderledes end den ellers kanoniske
// crmFindOrCreateContactAndCustomer(), som deduplikerer på telefon/e-mail:
// de oplysninger findes ikke på det niveau vi henter fra JobTread her (de
// kræver dybere opslag pr. kontakt), så der matches i stedet på NAVN — trimmet
// og uden hensyn til store/små bogstaver.
//
// ADVARSEL / KENDT BEGRÆNSNING: navnematch er ikke entydigt. To forskellige
// personer med samme navn bliver samme kunde, og to stavemåder af samme person
// ("Anders Hvisel" på to adresser i Martins JobTread) bliver to kunder. Der er
// bevidst IKKE lagt fuzzy-matching ind — et gæt der rammer forkert ville sammen-
// blande to rigtige kunders sager, hvilket er værre end en dublet man kan se og
// rette. Kunder oprettet her får ingen crm_contacts-række (modsat CRM-helperen),
// netop fordi der ikke er e-mail/telefon at deduplikere kontakten på.
async function jtImportFindOrCreateCustomer(client, jobData) {
  const name = String(jobData?.customerName || '').trim();
  if (!name) return null; // ingen kunde på sagen i JobTread — sagen oprettes uden kundekobling
  const found = await client.query('SELECT id FROM customers WHERE LOWER(TRIM(name)) = LOWER(TRIM($1)) ORDER BY id LIMIT 1', [name]);
  if (found.rows[0]) return found.rows[0].id;
  const created = await client.query(
    'INSERT INTO customers (name,address,notes) VALUES ($1,$2,$3) RETURNING id',
    [name, jobData.address || null, 'Oprettet automatisk ved JobTread-sagsimport.']
  );
  return created.rows[0].id;
}

// (b) SKRIVE-DELEN — én sag ad gangen, alle skrivninger i ÉN transaktion, så en
// fejl halvvejs inde ikke efterlader fx et tilbud uden tilhørende projekt.
// Kaster ALDRIG: en enkelt dårlig sag må ikke stoppe resten af importen, så alt
// leveres tilbage som et resultat-objekt loopet kan tælle på.
async function jtImportMaterializeJob(jobData) {
  try {
    const jobtreadJobId = String(jobData?.jobtreadJobId || '').trim();
    if (!jobtreadJobId) return { ok: false, error: 'JobTread-sagen mangler et id.' };

    // Er sagen hentet ind før, stopper vi HER — før der bruges et tilbuds- eller
    // sagsnummer på den, så genkørsler ikke æder huller i nummerrækkerne.
    const already = await pgOne('SELECT id FROM projects WHERE jobtread_job_id=$1', [jobtreadJobId]);
    if (already) return { ok: true, created: false, reason: 'already_imported', projectId: already.id };

    const company = await getCompanyInfo();
    const taxRate = company.defaultTaxRate;
    const projectName = jtImportProjectName(jobData);
    const price = Number(jobData.price) || 0;
    // Én samlet linje — importen kender ikke JobTreads linjeopdeling, og at gætte
    // den ville give et tilbud der ser rigtigt ud men ikke er det. Én ærlig linje
    // med det beløb der faktisk er belæg for, som Martin kan splitte op manuelt.
    const lines = [{
      description: projectName || 'Jf. JobTread-tilbud',
      quantity: 1,
      sell_price: price,
      cost_price: 0,
      unit: 'stk',
      product_type: 'service',
      line_type: 'item'
    }];
    const totals = computeTotals(lines, taxRate, { value: 0, type: 'pct' });

    // Nummer-tildeling ligger UDEN FOR transaktionen med vilje: nextDocNumber
    // åbner sin egen forbindelse og sin egen transaktion, og poolen har kun 5
    // forbindelser — at hente et nummer mens vi selv holder en klient ville
    // unødigt binde to forbindelser ad gangen.
    const quoteNumber = await nextDocNumber('quote', 'TIL');
    const jobNumber = await nextDocNumber('project', 'GM');
    const acceptToken = crypto.randomBytes(20).toString('hex');
    const startDate = validDate(jobData.startDate) ? jobData.startDate : null;
    const endDate = validDate(jobData.endDate) ? jobData.endDate : startDate;

    const result = await crmWithTransaction(async client => {
      // Samme tjek igen inde i transaktionen — to samtidige klik på knappen må
      // ikke kunne nå at oprette den samme sag to gange. Det delvise unik-indeks
      // på projects.jobtread_job_id er den endelige garanti.
      const raced = await client.query('SELECT id FROM projects WHERE jobtread_job_id=$1', [jobtreadJobId]);
      if (raced.rows[0]) return { created: false, reason: 'already_imported', projectId: raced.rows[0].id };

      const customerId = await jtImportFindOrCreateCustomer(client, jobData);

      // Tilbuddet oprettes direkte som 'accepted' — det er hele pointen: sagen
      // skal opføre sig som om kunden havde underskrevet i appen, så fakturering
      // m.m. virker. signed_ip er null, fordi der ikke ER nogen underskriver-IP;
      // signed_name siger tydeligt at det er en import, ikke en rigtig signatur.
      const quoteRow = await client.query(`
        INSERT INTO quotes (quote_number,job_name,job_id,customer_id,customer_address,customer_phone,customer_email,status,subtotal,tax_rate,tax_amount,total,notes,internal_note,valid_until,created_by,discount_pct,discount_type,accept_token,signed_name,signed_at,signed_ip)
        VALUES ($1,$2,$3,$4,$5,$6,$7,'accepted',$8,$9,$10,$11,NULL,$12,NULL,NULL,0,'pct',$13,'JobTread-import',${nowTextSQL()},NULL) RETURNING id
      `, [quoteNumber, projectName, jobtreadJobId, customerId, jobData.address || null, null, null,
          totals.subtotal, taxRate, totals.taxAmount, totals.total, jobData.notes || jtImportInternalNote(jobData), acceptToken]);
      const quoteId = quoteRow.rows[0].id;
      await saveQuoteLines(quoteId, lines, client);

      const projectRow = await client.query(`
        INSERT INTO projects (quote_id, name, customer_id, customer_address, customer_phone, customer_email, job_number, jobtread_job_id)
        VALUES ($1,$2,$3,$4,$5,$6,$7,$8) RETURNING *
      `, [quoteId, projectName, customerId, jobData.address || null, null, null, jobNumber, jobtreadJobId]);
      const project = projectRow.rows[0];

      // Sagens tidsplan: én linje der spænder over hele det planlagte forløb i
      // JobTread. job_id sættes til 'project-<id>' præcis som alle andre
      // sags-opgaver (IKKE JobTread-sagens id) — kolonnen bruges til at holde en
      // sags egne opgaver sammen, ikke til at pege tilbage på JobTread.
      let scheduled = false;
      if (startDate) {
        const taskId = 'p' + crypto.randomBytes(12).toString('hex');
        await client.query(`
          INSERT INTO gantt_tasks (id,job_id,job_name,name,description,start_date,end_date,progress,is_group,position,project_id,synced_at)
          VALUES ($1,$2,$3,$4,'',$5,$6,0,0,'0',$7,${nowTextSQL()})
        `, [taskId, 'project-' + project.id, project.name, project.name, startDate, endDate, project.id]);
        await mirrorProjectTaskToPool(taskId, project, { name: project.name, start_date: startDate, end_date: endDate, description: '' }, client);
        scheduled = true;
      }
      return { created: true, projectId: project.id, quoteId, quoteNumber, jobNumber, scheduled };
    });
    return { ok: true, ...result };
  } catch (error) {
    return { ok: false, error: redactSecret(error?.message || 'Ukendt fejl').slice(0, 500) };
  }
}

// (c) SELVE KNAPPEN. Samme adgangskrav som POST /api/sync (kun admin).
//
// ── AFKOBLET 05-09-2026 ────────────────────────────────────────────────────
// Martin har bekræftet, at alle sager allerede ER importeret, og at han fra nu
// af opretter dem direkte i appen. "📥 Hent nye sager" er derfor fjernet fra
// Indstillinger, og ruten er kommenteret ud her. jtImportFetchPlannedJobs(),
// jtImportMaterializeJob() og jtImportProjectName() ovenfor er bevidst bevaret
// urørte (de har ingen andre kaldesteder), så importen kan genaktiveres ved at
// fjerne kommentartegnene her igen.
//
// app.post('/api/admin/jobtread-import', auth, adminOnly, asyncRoute(async (req, res) => {
//   const fetched = await jtImportFetchPlannedJobs();
//   if (!fetched.ok) {
//     await writeSyncLog(0, 'error', 'Sagsimport fra JobTread: ' + fetched.error);
//     return res.status(500).json({ ok: false, error: fetched.error });
//   }
//   const summary = { ok: true, found: fetched.jobs.length, created: 0, skipped: 0, without_dates: 0, failed: [] };
//   for (const job of fetched.jobs) {
//     const result = await jtImportMaterializeJob(job);
//     if (!result.ok) summary.failed.push({ name: jtImportProjectName(job), error: result.error });
//     else if (result.created) { summary.created++; if (!result.scheduled) summary.without_dates++; }
//     else summary.skipped++;
//   }
//   const message = `Sagsimport fra JobTread: ...`;
//   await writeSyncLog(summary.created, summary.failed.length ? 'error' : 'ok', message);
//   await logSystemEvent('jobtread_project_import', summary.failed.length ? 'error' : 'info', message);
//   res.json(summary);
// }));

// ── AFKOBLET 05-09-2026 ────────────────────────────────────────────────────
// sync_log fodres kun af JobTread-synken/-importen, som nu er slået fra, så
// tabellen står stille fremover og denne rute havde intet at vise. Tabellen er
// IKKE droppet — de historiske rækker bliver stående og vises stadig i den
// rigtige "🛠 Systemlog" via GET /api/system-log nedenfor, som læser fra både
// sync_log og system_log.
//
// app.get('/api/sync/log', auth, adminOnly, asyncRoute(async (req, res) => {
//   const result = await pool.query('SELECT * FROM sync_log ORDER BY id DESC LIMIT 20');
//   res.json(result.rows);
// }));

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
    SELECT t.*, COUNT(b.id) FILTER (WHERE COALESCE(b.planning_mode,'daily') <> 'capacity')::int AS assignment_count,
           -- Sagens status ('active'/'on_hold'/'done'/'archived') følger med hver
           -- opgave, så Opgavepool/Kapacitet/Tidslinje kan filtrere på "kun
           -- igangværende sager" (se poolProjectStatusFilter i admin.html).
           -- NULL for opgaver uden sag (manuelle/kapacitet/gamle JobTread-rækker) —
           -- de skjules bevidst ALDRIG af det filter.
           p.status AS project_status
    FROM jt_tasks t
    LEFT JOIN planning_bookings b ON b.task_id=t.id
    LEFT JOIN projects p ON p.id = t.project_id
    WHERE COALESCE(t.source,'jobtread') <> 'capacity'
    GROUP BY t.id, p.status
    ORDER BY CASE WHEN t.source='manual' THEN 0 ELSE 1 END,
             CASE WHEN t.start_date IS NULL OR t.start_date='' THEN 1 ELSE 0 END,
             t.start_date ASC NULLS LAST,
             t.job_name ASC
  `);
  res.json(result.rows);
}));

app.post('/api/tasks/manual', auth, panelAccess('plan'), asyncRoute(async (req, res) => {
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
app.post('/api/tasks/manual-and-book', auth, panelAccess('plan'), asyncRoute(async (req, res) => {
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
app.post('/api/capacity-reservations', auth, panelAccess('capacity'), asyncRoute(async (req, res) => {
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

app.put('/api/capacity-reservations/:id', auth, panelAccess('capacity'), asyncRoute(async (req, res) => {
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

app.put('/api/tasks/:id/customer-contact', auth, panelAccess('plan'), asyncRoute(async (req, res) => {
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

app.delete('/api/tasks/manual/:id', auth, panelAccess('plan'), asyncRoute(async (req, res) => {
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
app.put('/api/tasks/bulk', auth, panelAccess('plan'), asyncRoute(async (req, res) => {
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
app.put('/api/tasks/:id', auth, panelAccess('plan'), asyncRoute(async (req, res) => {
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
app.post('/api/tasks/bulk-delete', auth, panelAccess('plan'), asyncRoute(async (req, res) => {
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
app.delete('/api/tasks/:id', auth, panelAccess('plan'), asyncRoute(async (req, res) => {
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

app.post('/api/tasks/:id/files', auth, panelAccess('plan'), asyncRoute(async (req, res) => {
  const body = req.body || {};
  if (!body.name || !body.url) return res.status(400).json({ error: 'Navn og link/fil skal udfyldes' });
  const result = await pool.query(`
    INSERT INTO job_files (task_id,name,url,category) VALUES ($1,$2,$3,$4) RETURNING id
  `, [req.params.id, String(body.name).trim().slice(0, 200), String(body.url), body.category || 'other']);
  res.json({ ok: true, id: result.rows[0].id });
}));

app.delete('/api/files/:id', auth, panelAccess('plan'), asyncRoute(async (req, res) => {
  await pool.query('DELETE FROM job_files WHERE id=$1', [Number(req.params.id)]);
  res.json({ ok: true });
}));

// ── VEJLEDNING / FILBIBLIOTEK (generelle lægningsvejledninger m.m.) ──
app.get('/api/library', auth, asyncRoute(async (req, res) => {
  const result = await pool.query('SELECT * FROM library_files ORDER BY category, name');
  res.json(result.rows);
}));

app.post('/api/library', auth, panelAccess('library'), asyncRoute(async (req, res) => {
  const body = req.body || {};
  if (!body.name || !body.url) return res.status(400).json({ error: 'Navn og link/fil skal udfyldes' });
  const result = await pool.query(`
    INSERT INTO library_files (name,url,category) VALUES ($1,$2,$3) RETURNING id
  `, [String(body.name).trim().slice(0, 200), String(body.url), body.category || 'guide']);
  res.json({ ok: true, id: result.rows[0].id });
}));

app.delete('/api/library/:id', auth, panelAccess('library'), asyncRoute(async (req, res) => {
  await pool.query('DELETE FROM library_files WHERE id=$1', [Number(req.params.id)]);
  res.json({ ok: true });
}));

// ── UGENTLIGE NOTER TIL MEDARBEJDER/VENDOR ───────────────────
app.get('/api/notes/weekly', auth, panelAccess('plan'), asyncRoute(async (req, res) => {
  const weekKey = String(req.query.week_key || '');
  if (!weekKey) return res.status(400).json({ error: 'week_key mangler' });
  const result = await pool.query('SELECT * FROM weekly_notes WHERE week_key=$1', [weekKey]);
  res.json(result.rows);
}));

app.put('/api/notes/weekly', auth, panelAccess('plan'), asyncRoute(async (req, res) => {
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

app.get('/api/task-requests', auth, panelAccess('requests'), asyncRoute(async (req, res) => {
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

app.put('/api/task-requests/:id/approve', auth, panelAccess('requests'), asyncRoute(async (req, res) => {
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

app.put('/api/task-requests/:id/reject', auth, panelAccess('requests'), asyncRoute(async (req, res) => {
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

app.post('/api/tasks/:id/checklist', auth, panelAccess('plan'), asyncRoute(async (req, res) => {
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

app.delete('/api/checklist/:id', auth, panelAccess('plan'), asyncRoute(async (req, res) => {
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
app.post('/api/customer-visits/book', auth, panelAccess('plan'), asyncRoute(async (req, res) => {
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

app.get('/api/time-off', auth, panelAccess('requests'), asyncRoute(async (req, res) => {
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
app.put('/api/time-off/:id', auth, panelAccess('requests'), asyncRoute(async (req, res) => {
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

app.put('/api/time-off/:id/approve', auth, panelAccess('requests'), asyncRoute(async (req, res) => {
  const row = await pgOne('SELECT * FROM time_off WHERE id=$1', [req.params.id]);
  if (!row) return res.status(404).json({ error: 'Anmodningen blev ikke fundet' });
  await pool.query(`UPDATE time_off SET status='approved', resolved_at=${nowTextSQL()} WHERE id=$1`, [row.id]);
  res.json({ ok: true });
}));

app.put('/api/time-off/:id/reject', auth, panelAccess('requests'), asyncRoute(async (req, res) => {
  const row = await pgOne('SELECT * FROM time_off WHERE id=$1', [req.params.id]);
  if (!row) return res.status(404).json({ error: 'Anmodningen blev ikke fundet' });
  const adminNote = req.body && req.body.admin_note ? String(req.body.admin_note).slice(0, 500) : null;
  await pool.query(`UPDATE time_off SET status='rejected', admin_note=$1, resolved_at=${nowTextSQL()} WHERE id=$2`, [adminNote, row.id]);
  res.json({ ok: true });
}));

app.delete('/api/time-off/:id', auth, panelAccess('requests'), asyncRoute(async (req, res) => {
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
app.put('/api/tasks/:id/manual-complete', auth, panelAccess('plan'), asyncRoute(async (req, res) => {
  const completed = !!(req.body || {}).completed;
  await pool.query(`UPDATE jt_tasks SET manually_completed_at=${completed ? nowTextSQL() : 'NULL'} WHERE id=$1`, [req.params.id]);
  res.json({ ok: true });
}));

// En booking kan flyttes manuelt op/ned i rækkefølgen for én bestemt dag. Bruges når
// admin selv vil bestemme rækkefølgen medarbejderen ser opgaverne i den dag — uafhængigt
// af mødetidspunkt. Sætter man et mødetidspunkt (start_time), tager visningen automatisk
// over og sorterer efter klokkeslæt i stedet (håndteres i frontend'en).
app.put('/api/assignments/:id/move', auth, panelAccess('plan'), asyncRoute(async (req, res) => {
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
app.put('/api/assignments/:id/status', auth, panelAccess('plan'), asyncRoute(async (req, res) => {
  const current = await pgOne('SELECT * FROM planning_bookings WHERE id=$1', [req.params.id]);
  if (!current) return res.status(404).json({ error: 'Bookingen blev ikke fundet' });
  const raw = (req.body || {}).status_flag;
  const value = BOOKING_STATUS_FLAGS.includes(raw) ? raw : null;
  await pool.query('UPDATE planning_bookings SET status_flag=$1 WHERE id=$2', [value, current.id]);
  res.json({ ok: true, status_flag: value });
}));

app.put('/api/assignments/:id/invoice', auth, panelAccess('plan'), asyncRoute(async (req, res) => {
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
           t.project_id AS task_project_id,
           -- Sagens status pr. booking — samme formål som project_status i
           -- GET /api/tasks: Tidslinjen grupperer bookinger (ikke pool-opgaver),
           -- så den har brug for statussen her for at kunne filtrere på
           -- igangværende/på hold/afsluttede sager. NULL når bookingen hænger på en
           -- opgave uden sag (manuel/kapacitet) — den skjules aldrig af filteret.
           p.status AS task_project_status
    FROM planning_bookings b
    JOIN users u ON b.user_id=u.id
    JOIN jt_tasks t ON b.task_id=t.id
    LEFT JOIN projects p ON p.id = t.project_id
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
app.get('/api/assignments/:id/note', auth, panelAccess('plan'), asyncRoute(async (req, res) => {
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

app.post('/api/assignments', auth, panelAccess('plan'), asyncRoute(async (req, res) => {
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

app.put('/api/assignments/:id', auth, panelAccess('plan'), asyncRoute(async (req, res) => {
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

app.delete('/api/assignments/:id', auth, panelAccess('plan'), asyncRoute(async (req, res) => {
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

app.delete('/api/plan', auth, panelAccess('plan'), asyncRoute(async (req, res) => {
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

app.get('/api/time/all', auth, panelAccess('plan'), asyncRoute(async (req, res) => {
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
app.get('/api/dashboard', auth, panelAccess('dashboard'), asyncRoute(async (req, res) => {
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
app.get('/api/customers/search', auth, panelAccess('customers'), asyncRoute(async (req, res) => {
  const q = String(req.query.q || '').trim();
  if (q.length < 2) return res.json([]);
  const crmQuery = pool.query(`
    SELECT id AS customer_id, name AS job_name, address AS job_address, NULL::TEXT AS job_number,
      phone AS customer_phone, email AS customer_email, NULL::DOUBLE PRECISION AS job_lat, NULL::DOUBLE PRECISION AS job_lng
    FROM customers WHERE name ILIKE $1 ORDER BY name LIMIT 8
  `, [`%${q}%`]);
  // customers_only=1 (bruges af tilbud/faktura-editoren, se qeRunCustomerSearch i
  // admin.html) — søger KUN i vores eget kundekartotek (customers), uden at
  // blande historiske JobTread-sager ind, efter Martins ønske. De andre steder
  // dette endpoint bruges (manuel opgave/booking, kundehistorik) blander fortsat
  // begge kilder, da det ikke var en del af Martins ønske at ændre det der.
  if (req.query.customers_only === '1') {
    const crmRows = await crmQuery;
    return res.json(crmRows.rows);
  }
  // Matcher på tværs af BÅDE det nye CRM-kartotek (customers) og de historiske
  // JobTread-sager (jt_tasks) — CRM-kunder vises først, da de er dem Martin
  // selv har oprettet med vilje. customer_id er sat for CRM-rækker, ellers null.
  const [crmRows, jtRows] = await Promise.all([
    crmQuery,
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

// ══════════════════════════════════════════════════════════════
// GLOBAL SØGNING — backend til søgefeltet i topbjælken (se
// renderGlobalSearchResults i admin.html).
//
// BAGGRUND: søgefeltet var tidligere 100% frontend — det filtrerede kun i de
// to lister der i forvejen lå i browserens hukommelse (opgaver og
// medarbejdere). Kunder, leads og opportunities blev ALDRIG hentet ind i
// nogen global liste, så de kunne principielt ikke findes derfra. Det er
// hullet Martin ramte. Dette endpoint søger dem direkte i databasen.
//
// STAVEFEJL-TOLERANCE: kombinerer to ting pr. felt —
//   1) ILIKE '%tekst%'  → det eksakte delstrengs-match. Rammer altid, også
//      for meget korte søgeord hvor trigrammer er ubrugelige ("BJ", "Lars").
//   2) pg_trgm's % / <% → trigram-lighed, der fanger stavefejl, bøjninger og
//      ombyttede ord ("gulvmaester" → "Gulvmester ApS"). Slås fra automatisk
//      hvis udvidelsen ikke kunne oprettes, se initSearchTrigrams().
// Resultaterne sorteres derefter: præfiks-match på navnet først (rank 0),
// så øvrige eksakte delstrengs-match (rank 1), og til sidst de rent fuzzy
// (rank 2) sorteret efter lighedsscore. Dvs. skriver man noget der findes
// præcist, ligger det altid øverst — de fuzzy gæt fylder kun op nedenunder.
//
// TELEFON: matches på RENE CIFRE i begge ender, så "20112233" finder
// "+45 20 11 22 33". Samme normalisering som resten af appen bruger.
//
// ADGANG: kun 'auth' på selve ruten (alle indloggede må kalde den — den er
// en del af den fælles topbjælke og må ikke give 403 i ansigtet på en
// medarbejder), men HVER kategori tjekkes bagefter mod præcis den samme
// side-adgang som den tilsvarende side kræver ('customers', 'crmp_leads',
// 'crmp_sales' — se panelAccess). Har man ikke adgang til Kunder, får man
// simpelthen en tom kunde-liste tilbage i stedet for en fejl. Der lækkes
// altså ikke data en bruger ikke i forvejen kunne se på sidene selv.
// ══════════════════════════════════════════════════════════════

// Escaper % og _ i brugerens søgetekst, så de ikke bliver til ILIKE-wildcards.
function searchLikeEscape(text) {
  return String(text).replace(/([\\%_])/g, '\\$1');
}

app.get('/api/search', auth, asyncRoute(async (req, res) => {
  const term = String(req.query.q || '').trim();
  const empty = { q: term, fuzzy: searchTrgmReady, customers: [], leads: [], opportunities: [] };
  // Ét enkelt tegn giver kun støj (og et fuldt tabelscan) — vent til der er to.
  if (term.length < 2) return res.json(empty);

  const u = await pgOne('SELECT id, role, active, is_finance_admin, panel_role_id FROM users WHERE id=$1', [req.user.id]);
  if (!u || !u.active) return res.status(403).json({ error: 'Ingen adgang' });
  const pages = u.role === 'admin' ? null : await computeUserPanelPages(u); // null = admin, alt tilladt
  const may = key => pages === null || pages.includes(key);

  const esc = searchLikeEscape(term);
  const prefixPat = esc + '%';       // $2 — "starter med"
  const containsPat = '%' + esc + '%'; // $3 — "indeholder"
  // $4 — kun cifre. Tom streng = søgeteksten indeholdt ingen cifre, og så
  // springes telefon-matchet helt over (ellers ville '%%' matche alle rækker).
  const digits = term.replace(/[^0-9]/g, '');
  const digitPat = digits.length >= 3 ? '%' + digits + '%' : '';
  const params = [term, prefixPat, containsPat, digitPat];

  const LIMIT = 8;
  // Byggeklodser der kun må komme med når pg_trgm rent faktisk er aktiv.
  const simExpr = cols => searchTrgmReady
    ? 'GREATEST(' + cols.map(c => `similarity(${c},$1), word_similarity($1,${c})`).join(', ') + ')'
    : '0::real';
  const fuzzyWhere = cols => searchTrgmReady
    ? ' OR ' + cols.map(c => `${c} % $1 OR $1 <% ${c}`).join(' OR ')
    : '';
  const phoneWhere = col => `($4 <> '' AND regexp_replace(COALESCE(${col},''),'[^0-9]','','g') LIKE $4)`;

  const queries = {};

  if (may('customers')) {
    queries.customers = pool.query(`
      SELECT c.id, c.name, c.email, c.phone, c.address, c.is_company, c.cvr,
        CASE WHEN c.name ILIKE $2 THEN 0
             WHEN c.name ILIKE $3 OR COALESCE(c.email,'') ILIKE $3 OR COALESCE(c.address,'') ILIKE $3
                  OR ${phoneWhere('c.phone')} THEN 1
             ELSE 2 END AS match_rank,
        ${simExpr(['c.name', "COALESCE(c.address,'')"])} AS score
      FROM customers c
      WHERE c.name ILIKE $3 OR COALESCE(c.email,'') ILIKE $3 OR COALESCE(c.address,'') ILIKE $3
         OR ${phoneWhere('c.phone')}${fuzzyWhere(['c.name', "COALESCE(c.address,'')"])}
      ORDER BY match_rank ASC, score DESC, c.name ASC
      LIMIT ${LIMIT}
    `, params);
  }

  if (may('crmp_leads')) {
    queries.leads = pool.query(`
      SELECT l.id, l.name, l.email, l.phone, l.address, l.source,
             s.name AS stage_name, s.color AS stage_color, p.name AS pipeline_name,
        CASE WHEN l.name ILIKE $2 THEN 0
             WHEN l.name ILIKE $3 OR COALESCE(l.email,'') ILIKE $3 OR COALESCE(l.address,'') ILIKE $3
                  OR ${phoneWhere('l.phone')} THEN 1
             ELSE 2 END AS match_rank,
        ${simExpr(['l.name', "COALESCE(l.address,'')"])} AS score
      FROM crm_leads l
      LEFT JOIN crm_stages s ON s.id = l.stage_id
      LEFT JOIN crm_pipelines p ON p.id = l.pipeline_id
      WHERE l.name ILIKE $3 OR COALESCE(l.email,'') ILIKE $3 OR COALESCE(l.address,'') ILIKE $3
         OR ${phoneWhere('l.phone')}${fuzzyWhere(['l.name', "COALESCE(l.address,'')"])}
      ORDER BY match_rank ASC, score DESC, l.updated_at DESC NULLS LAST, l.name ASC
      LIMIT ${LIMIT}
    `, params);
  }

  if (may('crmp_sales')) {
    // Opportunities har ikke selv navn/tlf/adresse på kunden — de hænger på
    // crm_contacts via contact_id (se skemaet). Vi søger derfor både i sagens
    // eget navn OG i den tilknyttede kontakts felter, og returnerer kontaktens
    // oplysninger som den sekundære linje i dropdownen.
    queries.opportunities = pool.query(`
      SELECT o.id, o.name, o.value,
             ct.name AS contact_name, ct.email AS contact_email,
             ct.phone AS contact_phone, ct.address AS contact_address,
             s.name AS stage_name, s.color AS stage_color, p.name AS pipeline_name,
        CASE WHEN o.name ILIKE $2 OR COALESCE(ct.name,'') ILIKE $2 THEN 0
             WHEN o.name ILIKE $3 OR COALESCE(ct.name,'') ILIKE $3 OR COALESCE(ct.email,'') ILIKE $3
                  OR COALESCE(ct.address,'') ILIKE $3 OR ${phoneWhere('ct.phone')} THEN 1
             ELSE 2 END AS match_rank,
        ${simExpr(['o.name', "COALESCE(ct.name,'')", "COALESCE(ct.address,'')"])} AS score
      FROM crm_opportunities o
      LEFT JOIN crm_contacts ct ON ct.id = o.contact_id
      LEFT JOIN crm_stages s ON s.id = o.stage_id
      LEFT JOIN crm_pipelines p ON p.id = o.pipeline_id
      WHERE o.name ILIKE $3 OR COALESCE(ct.name,'') ILIKE $3 OR COALESCE(ct.email,'') ILIKE $3
         OR COALESCE(ct.address,'') ILIKE $3 OR ${phoneWhere('ct.phone')}${fuzzyWhere(['o.name', "COALESCE(ct.name,'')", "COALESCE(ct.address,'')"])}
      ORDER BY match_rank ASC, score DESC, o.updated_at DESC NULLS LAST, o.name ASC
      LIMIT ${LIMIT}
    `, params);
  }

  const keys = Object.keys(queries);
  const results = await Promise.all(keys.map(k => queries[k]));
  const out = { q: term, fuzzy: searchTrgmReady, customers: [], leads: [], opportunities: [] };
  keys.forEach((k, i) => { out[k] = results[i].rows; });
  res.json(out);
}));

// ── CRM: KUNDEKARTOTEK — eget kundekartotek Martin kan oprette kunder i
// direkte, uafhængigt af om der findes en JobTread-sag på dem endnu. ────
app.get('/api/crm/customers', auth, panelAccess('customers'), asyncRoute(async (req, res) => {
  const q = String(req.query.q || '').trim();
  // Søger også i pris (tilbuds- og faktura-totaler) — så Martin kan skrive fx
  // "15000" og finde kunden med det tilbud/den faktura, ikke kun navn/email/tlf.
  const rows = q
    ? await pool.query(`
        SELECT * FROM customers c WHERE
          c.name ILIKE $1 OR c.email ILIKE $1 OR c.phone ILIKE $1
          OR EXISTS (SELECT 1 FROM quotes qq WHERE qq.customer_id=c.id AND qq.total::text ILIKE $1)
          OR EXISTS (SELECT 1 FROM invoices ii JOIN quotes qq2 ON qq2.id=ii.quote_id WHERE qq2.customer_id=c.id AND ii.total::text ILIKE $1)
        ORDER BY c.name
      `, [`%${q}%`])
    : await pool.query('SELECT * FROM customers ORDER BY name');
  res.json(rows.rows);
}));
// Kundedetalje — alt data på én kunde samlet: sager (projekter), tilbud og
// fakturaer. Fakturaer har ingen customer_id-kolonne (de oprettes altid via
// konverter-fra-tilbud, se /api/quotes/:id/convert-to-invoice), så de findes
// via invoices.quote_id -> quotes.customer_id i stedet.
app.get('/api/crm/customers/:id', auth, panelAccess('customers'), asyncRoute(async (req, res) => {
  const customer = await pgOne('SELECT * FROM customers WHERE id=$1', [req.params.id]);
  if (!customer) return res.status(404).json({ error: 'Kunden blev ikke fundet' });
  const [quotes, invoices, projects] = await Promise.all([
    pool.query(`
      SELECT id, quote_number, job_name, status, total, created_at, updated_at
      FROM quotes WHERE customer_id=$1 ORDER BY created_at DESC
    `, [req.params.id]),
    pool.query(`
      SELECT i.id, i.invoice_number, i.job_name, i.status, i.total, i.due_date, i.created_at
      FROM invoices i JOIN quotes q ON q.id = i.quote_id
      WHERE q.customer_id=$1 ORDER BY i.created_at DESC
    `, [req.params.id]),
    pool.query(`
      SELECT id, name, status, quote_id, invoice_id, created_at
      FROM projects WHERE customer_id=$1 ORDER BY created_at DESC
    `, [req.params.id])
  ]);
  res.json({
    customer,
    quotes: quotes.rows,
    invoices: invoices.rows,
    projects: projects.rows
  });
}));
app.post('/api/crm/customers', auth, panelAccess('customers'), asyncRoute(async (req, res) => {
  const b = req.body || {};
  if (!b.name) return res.status(400).json({ error: 'Navn mangler' });
  const isCompany = !!b.is_company;
  const cvr = isCompany && b.cvr ? String(b.cvr).trim().slice(0, 20) : null;
  const r = await pool.query(`
    INSERT INTO customers (name,email,phone,address,notes,is_company,cvr) VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING id
  `, [String(b.name).trim(), b.email || null, b.phone || null, b.address || null, b.notes || null, isCompany ? 1 : 0, cvr]);
  // AUTOMATISK VELKOMSTMAIL TIL NYE KUNDER — ny funktion (var ikke tidligere
  // muligt), styret af "Aktiv"-knappen på skabelonen i Skabeloner-centeret
  // (system_email_templates, key='customer_welcome'). Slået FRA som standard
  // ved denne omlægning, så ingen kunder pludselig får en uventet mail — se
  // leveringsnoten. Fejler mailen, må det aldrig vælte selve kundeoprettelsen.
  try {
    if (b.email && mailIsConfigured()) {
      const sysTpl = await pgOne("SELECT * FROM system_email_templates WHERE key='customer_welcome' AND enabled=1");
      if (sysTpl) {
        const company = await getCompanyInfo();
        const vars = { kunde: String(b.name).trim(), firma: company.name };
        const subject = fillDocEmailVars(sysTpl.subject, vars);
        const bodyHtml = fillDocEmailVars(sysTpl.body_html, vars);
        await sendMailUniversal({ to: b.email, subject, html: bodyHtml, text: stripHtmlToText(bodyHtml) });
      }
    }
  } catch (e) { console.error('Kunne ikke sende velkomstmail til ny kunde:', e.message); }
  res.json({ ok: true, id: r.rows[0].id });
}));
app.put('/api/crm/customers/:id', auth, panelAccess('customers'), asyncRoute(async (req, res) => {
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
app.delete('/api/crm/customers/:id', auth, panelAccess('customers'), asyncRoute(async (req, res) => {
  await pool.query('DELETE FROM customers WHERE id=$1', [req.params.id]);
  res.json({ ok: true });
}));

// ── KUNDE-NOTER — rigtig, redigerbar/sletbar note-liste (se customer_notes
// ovenfor i initSchema()). Adskilt fra den ældre customers.notes-tekst. ────
app.get('/api/crm/customers/:id/notes', auth, panelAccess('customers'), asyncRoute(async (req, res) => {
  const rows = (await pool.query('SELECT n.*, u.name AS user_name FROM customer_notes n LEFT JOIN users u ON u.id=n.user_id WHERE n.customer_id=$1 ORDER BY n.created_at DESC, n.id DESC', [req.params.id])).rows;
  res.json(rows);
}));
app.post('/api/crm/customers/:id/notes', auth, panelAccess('customers'), asyncRoute(async (req, res) => {
  const b = req.body || {};
  if (!b.body || !String(b.body).trim()) return res.status(400).json({ error: 'Note mangler' });
  const customer = await pgOne('SELECT id FROM customers WHERE id=$1', [req.params.id]);
  if (!customer) return res.status(404).json({ error: 'Kunde ikke fundet' });
  const r = await pgOne('INSERT INTO customer_notes (customer_id,body,user_id) VALUES ($1,$2,$3) RETURNING id', [req.params.id, String(b.body).trim(), req.user.id]);
  res.json({ ok: true, id: r.id });
}));
app.put('/api/crm/customers/:id/notes/:noteId', auth, panelAccess('customers'), asyncRoute(async (req, res) => {
  const b = req.body || {};
  if (!b.body || !String(b.body).trim()) return res.status(400).json({ error: 'Note mangler' });
  const note = await pgOne('SELECT * FROM customer_notes WHERE id=$1 AND customer_id=$2', [req.params.noteId, req.params.id]);
  if (!note) return res.status(404).json({ error: 'Note ikke fundet' });
  await pool.query(`UPDATE customer_notes SET body=$1, updated_at=${nowTextSQL()} WHERE id=$2`, [String(b.body).trim(), req.params.noteId]);
  res.json({ ok: true });
}));
app.delete('/api/crm/customers/:id/notes/:noteId', auth, panelAccess('customers'), asyncRoute(async (req, res) => {
  const note = await pgOne('SELECT * FROM customer_notes WHERE id=$1 AND customer_id=$2', [req.params.noteId, req.params.id]);
  if (!note) return res.status(404).json({ error: 'Note ikke fundet' });
  await pool.query('DELETE FROM customer_notes WHERE id=$1', [req.params.noteId]);
  res.json({ ok: true });
}));

// ══════════════════════════════════════════════════════════════
// GMAIL-INTEGRATION — punkt 2 i Martins Round C-ønske: "kan man indbygge gmail
// ind i det? så den trækker alle mails tilkoblet den givende kunde ind på
// kundens sag". Bygget som Martin selv bad om: fuld 2-vejs OAuth-forbindelse
// til ÉN firma-postkasse, som løbende synkroniseres og matches til kunder på
// email-adresse. Kræver at Martin selv opretter et Google Cloud-projekt og
// sætter GOOGLE_CLIENT_ID/GOOGLE_CLIENT_SECRET som miljøvariabler på Render —
// se leveringsnoten for den præcise fremgangsmåde, det kan jeg ikke gøre for
// ham herfra.
//
// Scope er bevidst kun "gmail.readonly" — appen kan altså LÆSE/synkronisere
// mails, men aldrig sende eller slette noget i Martins rigtige Gmail. At sende
// en mail til en kunde sker stadig via Gmail-knappen der åbner Gmails egen
// web-compose (se gmailComposeUrl i admin.html) — simplere, sikrere, og kræver
// ingen udvidet tilladelse fra Google.
//
// Tokens gemmes krypteret (AES-256-GCM, nøgle udledt af JWT_SECRET — samme
// hemmelighed serveren allerede kræver er sat, så der ikke skal endnu en
// hemmelighed til bare for dette).
// ══════════════════════════════════════════════════════════════
const GOOGLE_CLIENT_ID = process.env.GOOGLE_CLIENT_ID || '';
const GOOGLE_CLIENT_SECRET = process.env.GOOGLE_CLIENT_SECRET || '';
const GMAIL_SCOPES = 'https://www.googleapis.com/auth/gmail.readonly https://www.googleapis.com/auth/userinfo.email';
function gmailIsConfigured() { return !!(GOOGLE_CLIENT_ID && GOOGLE_CLIENT_SECRET); }
function gmailRedirectUri(req) {
  return process.env.GOOGLE_REDIRECT_URI || (req.protocol + '://' + req.get('host') + '/api/gmail/oauth-callback');
}

const GMAIL_ENC_KEY = crypto.createHash('sha256').update(JWT_SECRET + ':gmail').digest();
function gmailEncrypt(text) {
  if (!text) return null;
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', GMAIL_ENC_KEY, iv);
  const enc = Buffer.concat([cipher.update(String(text), 'utf8'), cipher.final()]);
  return iv.toString('hex') + ':' + cipher.getAuthTag().toString('hex') + ':' + enc.toString('hex');
}
function gmailDecrypt(stored) {
  if (!stored) return null;
  const [ivHex, tagHex, dataHex] = String(stored).split(':');
  if (!ivHex || !tagHex || !dataHex) return null;
  const decipher = crypto.createDecipheriv('aes-256-gcm', GMAIL_ENC_KEY, Buffer.from(ivHex, 'hex'));
  decipher.setAuthTag(Buffer.from(tagHex, 'hex'));
  return Buffer.concat([decipher.update(Buffer.from(dataHex, 'hex')), decipher.final()]).toString('utf8');
}

async function gmailGetConnection() {
  return pgOne('SELECT * FROM gmail_connection WHERE id=1');
}

// Returnerer et gyldigt access token — forny automatisk med refresh_token hvis
// det er udløbet (eller udløber om under 2 minutter). Kaster hvis der slet
// ikke er forbundet en Gmail-konto.
async function gmailGetValidAccessToken() {
  const conn = await gmailGetConnection();
  if (!conn || !conn.refresh_token_enc) throw new Error('Ingen Gmail-konto forbundet');
  const now = Date.now();
  if (conn.access_token_enc && conn.token_expiry && Number(conn.token_expiry) > now + 120000) {
    return gmailDecrypt(conn.access_token_enc);
  }
  const refreshToken = gmailDecrypt(conn.refresh_token_enc);
  const resp = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      client_id: GOOGLE_CLIENT_ID,
      client_secret: GOOGLE_CLIENT_SECRET,
      refresh_token: refreshToken,
      grant_type: 'refresh_token'
    })
  });
  const data = await resp.json().catch(() => ({}));
  if (!resp.ok || !data.access_token) {
    throw new Error('Kunne ikke forny Gmail-adgang: ' + (data.error_description || data.error || resp.status));
  }
  const expiry = Date.now() + (Number(data.expires_in || 3600) * 1000);
  await pool.query('UPDATE gmail_connection SET access_token_enc=$1, token_expiry=$2 WHERE id=1', [gmailEncrypt(data.access_token), expiry]);
  return data.access_token;
}

async function gmailApiFetch(path, accessToken, opts) {
  const resp = await fetch('https://gmail.googleapis.com/gmail/v1/users/me' + path, Object.assign({}, opts, {
    headers: Object.assign({ 'Authorization': 'Bearer ' + accessToken }, (opts && opts.headers) || {})
  }));
  if (!resp.ok) {
    const raw = await resp.text().catch(() => '');
    throw new Error('Gmail API HTTP ' + resp.status + ': ' + raw.slice(0, 300));
  }
  return resp.json();
}

function gmailHeader(headers, name) {
  const h = (headers || []).find(x => x.name && x.name.toLowerCase() === name.toLowerCase());
  return h ? h.value : '';
}
function gmailParseFromHeader(from) {
  const m = String(from || '').match(/^\s*"?([^"<]*)"?\s*<?([^<>\s]+@[^<>\s]+)?>?\s*$/);
  if (!m) return { name: '', email: String(from || '').trim() };
  return { name: (m[1] || '').trim(), email: (m[2] || m[1] || '').trim() };
}
function gmailB64UrlDecode(data) {
  return Buffer.from(String(data || '').replace(/-/g, '+').replace(/_/g, '/'), 'base64');
}
// Går rekursivt igennem en Gmail-besked-payload og finder tekst-krop (html
// foretrukket, ellers plain) + en liste af rigtige vedhæftninger.
function gmailWalkPayload(part, acc) {
  if (!part) return;
  const filename = part.filename;
  if (filename && part.body && part.body.attachmentId) {
    acc.attachments.push({ filename, mimeType: part.mimeType || 'application/octet-stream', attachmentId: part.body.attachmentId, size: part.body.size || 0 });
  } else if (part.mimeType === 'text/html' && part.body && part.body.data && !acc.html) {
    acc.html = gmailB64UrlDecode(part.body.data).toString('utf8');
  } else if (part.mimeType === 'text/plain' && part.body && part.body.data && !acc.text) {
    acc.text = gmailB64UrlDecode(part.body.data).toString('utf8');
  }
  (part.parts || []).forEach(p => gmailWalkPayload(p, acc));
}

// ── OAuth-flow ──────────────────────────────────────────────────
app.get('/api/gmail/auth-url', auth, panelAccess('gmail-settings'), asyncRoute(async (req, res) => {
  if (!gmailIsConfigured()) return res.status(400).json({ error: 'GOOGLE_CLIENT_ID/GOOGLE_CLIENT_SECRET er ikke sat op på serveren endnu' });
  const state = jwt.sign({ purpose: 'gmail_oauth', uid: req.user.id }, JWT_SECRET, { expiresIn: '10m' });
  const params = new URLSearchParams({
    client_id: GOOGLE_CLIENT_ID,
    redirect_uri: gmailRedirectUri(req),
    response_type: 'code',
    scope: GMAIL_SCOPES,
    access_type: 'offline',
    prompt: 'consent',
    state
  });
  res.json({ url: 'https://accounts.google.com/o/oauth2/v2/auth?' + params.toString() });
}));

// Google redirekser brugerens BROWSER direkte hertil (ikke et fetch-kald med
// Authorization-header) — derfor ingen auth-middleware her. state-JWT'en
// beviser i stedet at det er en legitim forespørgsel startet af en rigtig
// admin-bruger i programmet, og fortæller hvem der forbandt kontoen.
app.get('/api/gmail/oauth-callback', asyncRoute(async (req, res) => {
  const { code, state, error } = req.query;
  function fail(msg) {
    res.status(400).send('<html><body style="font-family:sans-serif;padding:40px"><h2>Gmail-forbindelse fejlede</h2><p>' + String(msg).replace(/</g, '&lt;') + '</p><p><a href="/admin#notif-settings/gmail">Tilbage til Gulv Master</a></p></body></html>');
  }
  if (error) return fail('Google afviste: ' + error);
  if (!code || !state) return fail('Mangler code/state fra Google');
  let payload;
  try { payload = jwt.verify(state, JWT_SECRET); } catch (e) { return fail('Ugyldigt eller udløbet state — prøv at forbinde igen'); }
  if (!payload || payload.purpose !== 'gmail_oauth') return fail('Ugyldigt state');

  const tokenResp = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      client_id: GOOGLE_CLIENT_ID,
      client_secret: GOOGLE_CLIENT_SECRET,
      code,
      grant_type: 'authorization_code',
      redirect_uri: gmailRedirectUri(req)
    })
  });
  const tokenData = await tokenResp.json().catch(() => ({}));
  if (!tokenResp.ok || !tokenData.access_token) {
    return fail('Kunne ikke hente token fra Google: ' + (tokenData.error_description || tokenData.error || tokenResp.status));
  }
  if (!tokenData.refresh_token) {
    return fail('Google gav intet refresh-token (prøv at fjerne appens adgang under myaccount.google.com/permissions og forbind igen)');
  }
  const userinfoResp = await fetch('https://www.googleapis.com/oauth2/v2/userinfo', { headers: { Authorization: 'Bearer ' + tokenData.access_token } });
  const userinfo = await userinfoResp.json().catch(() => ({}));

  await pool.query(`
    INSERT INTO gmail_connection (id, email, access_token_enc, refresh_token_enc, token_expiry, connected_by, connected_at, last_synced_at, last_sync_error)
    VALUES (1,$1,$2,$3,$4,$5,${nowTextSQL()},NULL,NULL)
    ON CONFLICT (id) DO UPDATE SET email=$1, access_token_enc=$2, refresh_token_enc=$3, token_expiry=$4, connected_by=$5, connected_at=${nowTextSQL()}, last_sync_error=NULL
  `, [userinfo.email || null, gmailEncrypt(tokenData.access_token), gmailEncrypt(tokenData.refresh_token), Date.now() + (Number(tokenData.expires_in || 3600) * 1000), payload.uid]);

  await logSystemEvent('gmail', 'info', 'Gmail forbundet: ' + (userinfo.email || '?'));
  // Gmail har ikke længere sin egen side i admin.html — indholdet er nu en fane
  // på den samlede Indstillinger-side, så vi sender brugeren direkte til fanen.
  // OBS: bevidst uden query-string på hashet (kun #notif-settings/gmail, ikke
  // ...?connected=1) — admin.html's hash-router splitter kun på "/", ikke "?",
  // så et vedhæftet query-tegn ville gøre siden ikke matche noget i VALID_PAGES
  // og fejle stille ved indlæsning. Fanen henter selv sin forbindelsesstatus
  // (GET /api/gmail/status) med det samme den åbnes.
  res.redirect('/admin#notif-settings/gmail');
}));

app.get('/api/gmail/status', auth, panelAccess('gmail-settings'), asyncRoute(async (req, res) => {
  const conn = await gmailGetConnection();
  res.json({
    configured: gmailIsConfigured(),
    connected: !!(conn && conn.refresh_token_enc),
    email: conn ? conn.email : null,
    connected_at: conn ? conn.connected_at : null,
    last_synced_at: conn ? conn.last_synced_at : null,
    last_sync_error: conn ? conn.last_sync_error : null
  });
}));

// FEJLRETTELSE (sep. 2026): Filer- og Emails-fanerne på CRM-kortet og
// Emails-panelet på kundesiden brugte GET /api/gmail/status til bare at
// spørge "er Gmail forbundet overhovedet?" for at vide om fanerne skal vises.
// Men den rute kræver panelAccess('gmail-settings') — retten til selv at
// SÆTTE Gmail-integrationen op under Indstillinger — som kun Martin (admin)
// har. Enhver anden bruger (fx en kontormedarbejder som Sarah, der har
// 'customers'-adgang men ikke 'gmail-settings') fik derfor et 403 tilbage,
// hvilket i UI'et så ud som "Gmail er ikke forbundet" — selvom det rent
// faktisk er, for hele virksomheden (gmail_connection er én delt forbindelse,
// ikke pr. bruger). Denne rute afslører kun det ene boolean "connected", intet
// følsomt (ingen email, ingen tokens, ingen sync-fejl), og kræver derfor bare
// at man er logget ind — ikke at man må administrere selve integrationen.
app.get('/api/gmail/connected', auth, asyncRoute(async (req, res) => {
  const conn = await gmailGetConnection();
  res.json({ connected: !!(conn && conn.refresh_token_enc) });
}));

app.post('/api/gmail/disconnect', auth, panelAccess('gmail-settings'), asyncRoute(async (req, res) => {
  const conn = await gmailGetConnection();
  if (conn && conn.refresh_token_enc) {
    try {
      await fetch('https://oauth2.googleapis.com/revoke?token=' + encodeURIComponent(gmailDecrypt(conn.refresh_token_enc)), { method: 'POST' });
    } catch (e) { /* best-effort — fjern forbindelsen lokalt uanset */ }
  }
  await pool.query('DELETE FROM gmail_connection WHERE id=1');
  await logSystemEvent('gmail', 'info', 'Gmail-forbindelse fjernet af ' + (req.user.name || req.user.id));
  res.json({ ok: true });
}));

// ── Synkronisering ──────────────────────────────────────────────
// Henter mails til/fra hver kundes email-adresse fra den forbundne postkasse.
// Gemmer kun METADATA i databasen (emne/uddrag/afsender/dato) — selve
// brødtekst og vedhæftninger hentes live fra Gmail først når man åbner en
// mail, så vi ikke dublerer et helt mailarkiv i Postgres.
async function gmailSyncAll() {
  const accessToken = await gmailGetValidAccessToken();
  const customers = (await pool.query("SELECT id, email FROM customers WHERE email IS NOT NULL AND email <> ''")).rows;
  let totalNew = 0;
  for (const customer of customers) {
    try {
      totalNew += await gmailSyncCustomer(customer, accessToken);
    } catch (e) {
      console.error('Gmail-synk fejlede for kunde #' + customer.id + ':', e.message);
    }
  }
  await pool.query(`UPDATE gmail_connection SET last_synced_at=${nowTextSQL()}, last_sync_error=NULL WHERE id=1`);
  return totalNew;
}
// Fælles indsætningslogik for begge synk-veje nedenfor (den hurtige 40-nyeste
// synk der kører hvert 5. minut, og den on-demand fulde historik-synk) — for
// ikke at have to kopier af INSERT/ON CONFLICT-logikken der kan løbe fra
// hinanden. messages = Gmail-listeresultatets .messages[] (kun {id,threadId}),
// attachmentIds = et Set af besked-id'er vi allerede ved har vedhæftninger.
async function gmailUpsertMessages(messages, customerId, accessToken, connEmail, attachmentIds) {
  let added = 0;
  for (const m of messages) {
    const hasAttachment = attachmentIds.has(m.id) ? 1 : 0;
    const exists = await pgOne('SELECT id, has_attachments FROM customer_emails WHERE gmail_message_id=$1', [m.id]);
    if (exists) {
      if (hasAttachment && !exists.has_attachments) {
        await pool.query('UPDATE customer_emails SET has_attachments=1 WHERE id=$1', [exists.id]);
      }
      continue;
    }
    const detail = await gmailApiFetch('/messages/' + m.id + '?format=metadata&metadataHeaders=Subject&metadataHeaders=From&metadataHeaders=To&metadataHeaders=Date', accessToken);
    const headers = (detail.payload && detail.payload.headers) || [];
    const fromParsed = gmailParseFromHeader(gmailHeader(headers, 'From'));
    const direction = fromParsed.email && connEmail && fromParsed.email.toLowerCase() === connEmail.toLowerCase() ? 'out' : 'in';
    try {
      await pool.query(`
        INSERT INTO customer_emails (customer_id, gmail_message_id, gmail_thread_id, subject, snippet, from_email, from_name, to_emails, direction, internal_date, has_attachments)
        VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)
        ON CONFLICT (gmail_message_id) DO NOTHING
      `, [customerId, m.id, detail.threadId || null, gmailHeader(headers, 'Subject') || '(uden emne)', detail.snippet || '', fromParsed.email || null, fromParsed.name || null, gmailHeader(headers, 'To') || null, direction, Number(detail.internalDate) || Date.now(), hasAttachment]);
      added++;
    } catch (e) { console.error('Kunne ikke gemme mail ' + m.id + ':', e.message); }
  }
  return added;
}
async function gmailSyncCustomer(customer, accessToken) {
  const q = '(to:"' + customer.email + '" OR from:"' + customer.email + '")';
  const list = await gmailApiFetch('/messages?maxResults=40&q=' + encodeURIComponent(q), accessToken);
  const messages = list.messages || [];
  // Billig ekstra søgning: hvilke af disse mails har en vedhæftning? (bruges af
  // "Filer"-fanen, se GET /api/crm/customers/:id/files) — undgår at skulle hente
  // fulde besked-detaljer for hver eneste mail bare for at vide det.
  let attachmentIds = new Set();
  try {
    const attList = await gmailApiFetch('/messages?maxResults=100&q=' + encodeURIComponent(q + ' has:attachment'), accessToken);
    attachmentIds = new Set((attList.messages || []).map(x => x.id));
  } catch (e) { console.error('Kunne ikke tjekke vedhæftninger for kunde #' + customer.id + ':', e.message); }
  const connEmail = (await gmailGetConnection() || {}).email || '';
  return gmailUpsertMessages(messages, customer.id, accessToken, connEmail, attachmentIds);
}

// ── Fuld mail-historik (on-demand) ───────────────────────────────
// Martins spørgsmål: "kan den også hente gamle filer fra den email der
// tilkoblet eller kun nye?" — svaret er at den almindelige synk ovenfor
// bevidst KUN henter de 40 nyeste mails pr. kald (for at holde den hurtig nok
// til at køre hvert 5. minut på alle kunder ad gangen). Har en kunde mere end
// 40 mails i alt, og der løbende kommer nye til, kan ældre mails i teorien
// aldrig nå at blive synket med den hurtige synk alene.
// Denne funktion er et separat, on-demand kald (trigges af en knap i
// Filer/Emails-fanen, se crmpxFullMailSync i admin.html) der bladrer igennem
// ALLE Gmails søgeresultater via pageToken, op til en sikkerhedsgrænse, så det
// ikke kan løbe løbsk for en kunde med tusindvis af mails.
const GMAIL_FULL_SYNC_MAX_MESSAGES = 500;
const GMAIL_FULL_SYNC_MAX_PAGES = 20;
async function gmailFullSyncCustomer(customer, accessToken) {
  const q = '(to:"' + customer.email + '" OR from:"' + customer.email + '")';
  const connEmail = (await gmailGetConnection() || {}).email || '';

  let attachmentIds = new Set();
  try {
    let attPageToken, attGuard = 0;
    do {
      const attList = await gmailApiFetch('/messages?maxResults=100&q=' + encodeURIComponent(q + ' has:attachment') + (attPageToken ? '&pageToken=' + attPageToken : ''), accessToken);
      (attList.messages || []).forEach(x => attachmentIds.add(x.id));
      attPageToken = attList.nextPageToken;
      attGuard++;
    } while (attPageToken && attGuard < GMAIL_FULL_SYNC_MAX_PAGES);
  } catch (e) { console.error('Kunne ikke tjekke vedhæftninger (fuld synk) for kunde #' + customer.id + ':', e.message); }

  let added = 0, fetched = 0, pageToken, pages = 0;
  do {
    const list = await gmailApiFetch('/messages?maxResults=100&q=' + encodeURIComponent(q) + (pageToken ? '&pageToken=' + pageToken : ''), accessToken);
    const messages = list.messages || [];
    fetched += messages.length;
    added += await gmailUpsertMessages(messages, customer.id, accessToken, connEmail, attachmentIds);
    pageToken = list.nextPageToken;
    pages++;
  } while (pageToken && fetched < GMAIL_FULL_SYNC_MAX_MESSAGES && pages < GMAIL_FULL_SYNC_MAX_PAGES);

  return { added, fetched, truncated: !!pageToken };
}

app.post('/api/gmail/sync', auth, panelAccess('gmail-settings'), asyncRoute(async (req, res) => {
  try {
    const added = await gmailSyncAll();
    res.json({ ok: true, added });
  } catch (e) {
    await pool.query('UPDATE gmail_connection SET last_sync_error=$1 WHERE id=1', [String(e.message).slice(0, 500)]);
    res.status(400).json({ error: e.message });
  }
}));

// On-demand "hent hele historikken" — se kommentaren ved gmailFullSyncCustomer.
app.post('/api/crm/customers/:id/full-mail-sync', auth, panelAccess('customers'), asyncRoute(async (req, res) => {
  const customer = await pgOne('SELECT id, email FROM customers WHERE id=$1', [req.params.id]);
  if (!customer) return res.status(404).json({ error: 'Kunde ikke fundet' });
  if (!customer.email) return res.status(400).json({ error: 'Kunden har ingen emailadresse' });
  try {
    const accessToken = await gmailGetValidAccessToken();
    const result = await gmailFullSyncCustomer(customer, accessToken);
    res.json({ ok: true, added: result.added, fetched: result.fetched, truncated: result.truncated });
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
}));

// ── Kundens synkroniserede mails + live besked-/vedhæftnings-visning ────────
app.get('/api/crm/customers/:id/emails', auth, panelAccess('customers'), asyncRoute(async (req, res) => {
  const rows = (await pool.query('SELECT * FROM customer_emails WHERE customer_id=$1 ORDER BY internal_date DESC', [req.params.id])).rows;
  res.json(rows);
}));

// "Filer" — punkt i Martins Round D-ønske: samme idé som Close's Detaljer/Filer-
// faneskift, en samlet visning af alle vedhæftninger (billeder, PDF'er osv.)
// kunden har sendt på mail, uden at skulle åbne hver enkelt mail selv. Henter
// kun fulde besked-detaljer live for de mails der er markeret has_attachments=1
// ved synk (se gmailSyncCustomer), og er derfor billig selv med mange mails.
// Kappet til de 40 nyeste mails-med-vedhæftning pr. kald, for ikke at kunne løbe
// løbsk hvis en kunde en dag har hundredvis.
app.get('/api/crm/customers/:id/files', auth, panelAccess('customers'), asyncRoute(async (req, res) => {
  const accessToken = await gmailGetValidAccessToken();
  const emails = (await pool.query('SELECT * FROM customer_emails WHERE customer_id=$1 AND has_attachments=1 ORDER BY internal_date DESC LIMIT 40', [req.params.id])).rows;
  const files = [];
  for (const e of emails) {
    try {
      const detail = await gmailApiFetch('/messages/' + e.gmail_message_id + '?format=full', accessToken);
      const acc = { html: null, text: null, attachments: [] };
      gmailWalkPayload(detail.payload, acc);
      acc.attachments.forEach(a => files.push({
        filename: a.filename, mimeType: a.mimeType, size: a.size, attachmentId: a.attachmentId,
        gmail_message_id: e.gmail_message_id, subject: e.subject, internal_date: e.internal_date
      }));
    } catch (err) { console.error('Kunne ikke hente vedhæftninger for mail ' + e.gmail_message_id + ':', err.message); }
  }
  res.json(files);
}));

// FEJLRETTELSE (sep. 2026): Ligesom GET /api/gmail/status (se ovenfor) sad
// disse to ruter fejlagtigt bag panelAccess('gmail-settings') — retten til at
// administrere selve Gmail-forbindelsen, som kun Martin (admin) har — i stedet
// for panelAccess('customers'), som er den rettighed der reelt afgør om man må
// se en kundes mailkorrespondance. Enhver anden bruger med 'customers'-adgang
// (fx en kontormedarbejder som Sarah) kunne derfor se mail-LISTEN på en kunde
// (den henter fra customer_emails, korrekt gated på 'customers'), men fik "Ingen
// adgang til denne side" når selve mailteksten eller en vedhæftning skulle
// hentes — præcis samme slags fejl som Filer/Emails-fanerne tidligere. Som
// ekstra sikkerhed (nu hvor flere end admin kan kalde ruten) tjekkes det også at
// det efterspurgte gmail_message_id rent faktisk findes i customer_emails —
// dvs. er en mail der allerede er synkroniseret og vist på en kunde — så ruten
// ikke kan bruges til at hente vilkårlige beskeder fra virksomhedens postkasse.
app.get('/api/gmail/messages/:messageId', auth, panelAccess('customers'), asyncRoute(async (req, res) => {
  const known = await pgOne('SELECT id FROM customer_emails WHERE gmail_message_id=$1', [req.params.messageId]);
  if (!known) return res.status(404).json({ error: 'Mailen findes ikke i nogen kundes mailhistorik' });
  const accessToken = await gmailGetValidAccessToken();
  const detail = await gmailApiFetch('/messages/' + req.params.messageId + '?format=full', accessToken);
  const headers = (detail.payload && detail.payload.headers) || [];
  const acc = { html: null, text: null, attachments: [] };
  gmailWalkPayload(detail.payload, acc);
  res.json({
    subject: gmailHeader(headers, 'Subject'),
    from: gmailHeader(headers, 'From'),
    to: gmailHeader(headers, 'To'),
    date: gmailHeader(headers, 'Date'),
    bodyHtml: acc.html,
    bodyText: acc.text,
    attachments: acc.attachments.map(a => ({ filename: a.filename, mimeType: a.mimeType, attachmentId: a.attachmentId, size: a.size }))
  });
}));

app.get('/api/gmail/messages/:messageId/attachments/:attachmentId', auth, panelAccess('customers'), asyncRoute(async (req, res) => {
  const known = await pgOne('SELECT id FROM customer_emails WHERE gmail_message_id=$1', [req.params.messageId]);
  if (!known) return res.status(404).json({ error: 'Mailen findes ikke i nogen kundes mailhistorik' });
  const accessToken = await gmailGetValidAccessToken();
  const att = await gmailApiFetch('/messages/' + req.params.messageId + '/attachments/' + req.params.attachmentId, accessToken);
  const buf = gmailB64UrlDecode(att.data);
  const filename = String(req.query.filename || 'vedhaeftning').replace(/[^\w.\- æøåÆØÅ]/g, '_');
  res.setHeader('Content-Type', String(req.query.mimetype || 'application/octet-stream'));
  res.setHeader('Content-Disposition', 'attachment; filename="' + filename + '"');
  res.send(buf);
}));

// ══════════════════════════════════════════════════════════════
// CLOSE CRM-INTEGRATION — Martin bad om: "hver gang en kunde rykkes til
// Opportunities → Lav Tilbud så oprettes kunden i mit program med alt
// nødvendig data". Løst som et REALTIDS-webhook (Martins eget valg, ikke et
// periodisk tjek), da Close selv kan sende et signal med det samme en
// opportunity/lead skifter status.
//
// UDVIDET sep. 2026 efter Martins udtrykkelige ja ("Ja — udvid
// Close-webhooken"): webhooken opretter nu BÅDE kunden OG et tilsvarende salg
// i Gulvmasters egen Sales-pipeline (crm_opportunities), i stedet for kun den
// bare kunde-række som oprindeligt. Kunden oprettes desuden via
// crmFindOrCreateContactAndCustomer (samme dedup som resten af appen) i stedet
// for en rå INSERT INTO customers — dels for at undgå dubletter, dels fordi
// salget skal hænge på en crm_contacts-række. Se
// closeWebhookCreateOpportunity nedenfor og opportunity_id-kolonnen på
// close_customer_links (selvhelbredelse af gamle links uden salg).
//
// OPSÆTNING (skal gøres af Martin, kræver adgang til hans Close-konto):
//   1) I Close: Settings → Developer → Webhooks → "Add webhook", peg den på
//      https://<jeres-render-url>/api/integrations/close/webhook, og
//      abonnér på "Lead: Status changed" og/eller "Opportunity: Status
//      changed" (Close deler tit disse i to events — abonnér på begge for en
//      sikkerheds skyld, koden herunder tjekker selv om den rigtige status
//      er ramt uanset hvilket event det kommer fra).
//   2) Close viser en "signing key" når webhooket oprettes — sæt den som
//      miljøvariablen CLOSE_WEBHOOK_SIGNING_KEY i Render.
//   3) Lav en API-nøgle i Close (Settings → API Keys) og sæt den som
//      CLOSE_API_KEY i Render — bruges til at slå de FULDE lead-/kunde-data
//      op (Close-webhooks sender typisk kun et tyndt "der skete noget her"-
//      signal, ikke alle felter).
//   4) Hvis pipeline/status hedder noget andet end "Opportunities"/"Lav
//      Tilbud" i praksis, eller I bruger flere pipelines, sæt
//      CLOSE_TRIGGER_PIPELINE_LABEL / CLOSE_TRIGGER_STATUS_LABEL i Render —
//      ellers bruges disse to som standard. Vi slår selv status-ID'et op
//      dynamisk via Close's API ud fra navnet, i stedet for at hardkode et
//      internt Close-ID der ville knække hvis pipelinen redigeres senere.
//
// Uden disse 2 miljøvariabler sat er endpointet inaktivt (svarer 501), så
// resten af appen kører upåvirket indtil Martin har sat det op.
// ══════════════════════════════════════════════════════════════
const CLOSE_API_KEY = process.env.CLOSE_API_KEY || '';
const CLOSE_WEBHOOK_SIGNING_KEY = process.env.CLOSE_WEBHOOK_SIGNING_KEY || '';
const CLOSE_TRIGGER_PIPELINE_LABEL = process.env.CLOSE_TRIGGER_PIPELINE_LABEL || 'Opportunities';
const CLOSE_TRIGGER_STATUS_LABEL = process.env.CLOSE_TRIGGER_STATUS_LABEL || 'Lav Tilbud';
const CLOSE_API = 'https://api.close.com/api/v1';
let closeTriggerStatusIdCache = null; // {id, expiresAt} — undgår at slå det op ved hvert webhook-kald

function closeAuthHeader() {
  // Close bruger HTTP Basic Auth med API-nøglen som "brugernavn" og tomt kodeord.
  return 'Basic ' + Buffer.from(CLOSE_API_KEY + ':').toString('base64');
}

async function resolveCloseTriggerStatusId() {
  if (closeTriggerStatusIdCache && closeTriggerStatusIdCache.expiresAt > Date.now()) return closeTriggerStatusIdCache.id;
  const r = await fetch(CLOSE_API + '/pipeline/', { headers: { Authorization: closeAuthHeader() } });
  if (!r.ok) throw new Error('Kunne ikke hente pipelines fra Close (status ' + r.status + ')');
  const data = await r.json();
  const pipelines = data.data || [];
  const pipeline = pipelines.find(p => String(p.name || '').trim().toLowerCase() === CLOSE_TRIGGER_PIPELINE_LABEL.trim().toLowerCase());
  if (!pipeline) throw new Error('Fandt ingen pipeline i Close ved navn "' + CLOSE_TRIGGER_PIPELINE_LABEL + '"');
  const status = (pipeline.statuses || []).find(s => String(s.label || '').trim().toLowerCase() === CLOSE_TRIGGER_STATUS_LABEL.trim().toLowerCase());
  if (!status) throw new Error('Fandt ingen status ved navn "' + CLOSE_TRIGGER_STATUS_LABEL + '" i pipelinen "' + CLOSE_TRIGGER_PIPELINE_LABEL + '"');
  closeTriggerStatusIdCache = { id: status.id, expiresAt: Date.now() + 30 * 60 * 1000 };
  return status.id;
}

function verifyCloseWebhookSignature(req) {
  if (!CLOSE_WEBHOOK_SIGNING_KEY) return false;
  const sigHash = req.headers['close-sig-hash'];
  const sigTimestamp = req.headers['close-sig-timestamp'];
  if (!sigHash || !sigTimestamp || !req.rawBody) return false;
  const expected = crypto.createHmac('sha256', CLOSE_WEBHOOK_SIGNING_KEY)
    .update(sigTimestamp + req.rawBody.toString('utf8'))
    .digest('hex');
  try {
    return crypto.timingSafeEqual(Buffer.from(expected, 'hex'), Buffer.from(String(sigHash), 'hex'));
  } catch (e) {
    return false; // fx forskellig længde — helt sikkert ikke et match
  }
}

// Henter de fulde lead-data fra Close (kontaktoplysninger, adresse, noter) —
// webhook-payloaden alene indeholder typisk ikke alt det vi skal bruge.
async function fetchCloseLeadDetails(leadId) {
  const r = await fetch(CLOSE_API + '/lead/' + leadId + '/?_fields=id,display_name,name,addresses,contacts,description,note,html_url', {
    headers: { Authorization: closeAuthHeader() }
  });
  if (!r.ok) throw new Error('Kunne ikke hente lead ' + leadId + ' fra Close (status ' + r.status + ')');
  return r.json();
}

// Close-vedhæftninger/billeder ligger som "activities" af typen note/email med
// filer, ikke direkte på selve lead-objektet — vi slår dem op separat og
// samler dem som simple links, da Gulv Masters kundekort (customers) ikke har
// et billed-felt (kun projekter/sager har det, se project_photos). Fejler
// opslaget, springes billeder blot over — det må ikke vælte kunde-oprettelsen.
async function fetchCloseLeadAttachmentLinks(leadId) {
  try {
    const r = await fetch(CLOSE_API + '/activity/note/?lead_id=' + leadId, { headers: { Authorization: closeAuthHeader() } });
    if (!r.ok) return [];
    const data = await r.json();
    const links = [];
    (data.data || []).forEach(note => {
      (note.attachments || []).forEach(att => { if (att.url) links.push(att.url); });
    });
    return links;
  } catch (e) {
    return [];
  }
}

function closeLeadToCustomerFields(lead, attachmentLinks) {
  const contact = (lead.contacts || [])[0] || {};
  const phone = (contact.phones || [])[0] || {};
  const email = (contact.emails || [])[0] || {};
  const address = (lead.addresses || [])[0] || {};
  const addressParts = [address.address_1, address.address_2, address.zipcode, address.city].filter(Boolean);
  const noteParts = [];
  if (lead.description) noteParts.push(lead.description);
  if (lead.html_url) noteParts.push('Close-lead: ' + lead.html_url);
  if (attachmentLinks.length) noteParts.push('Billeder/vedhæftninger fra Close:\n' + attachmentLinks.join('\n'));
  return {
    name: lead.display_name || lead.name || 'Ukendt kunde (Close)',
    phone: phone.phone || null,
    email: email.email || null,
    address: addressParts.join(', ') || null,
    notes: noteParts.join('\n\n') || null
  };
}

// Opretter det tilsvarende SALG i Gulvmasters EGEN Sales-pipeline
// (crm_opportunities) — udvidelsen Martin bad om i sep. 2026 ("Ja — udvid
// Close-webhooken"). Indtil da lavede webhooken kun en kunde-række, så et
// Close-lead der nåede "Lav Tilbud" aldrig dukkede op som et kort i
// Sales-pipelinen, og derfor heller ikke fik glæde af pipelinens egen
// SMS/email-automatik.
//
// Stagen findes ved NAVN, case-insensitivt, ud fra CLOSE_TRIGGER_STATUS_LABEL
// (samme "match på navn, ellers pipelinens første stage"-mønster som
// CSV-importen bruger — closeMatchStageByName genbruges direkte). Aldrig
// hardkodede id'er: både pipeline og stage slås op live, så det stadig virker
// hvis Martin omdøber eller omrokerer sine stages.
//
// value/probability efterlades NULL: webhook-signalet fra Close bærer hverken
// beløb eller sandsynlighed, og begge kolonner er nullable. stage_changed_at
// sættes til NU — det her er ét enkelt, friskt salg i realtid, ikke en
// historisk bulk-import, så det skal opføre sig præcis som et salg oprettet i
// hånden (POST /api/crm/opportunities), inkl. crmLogActivity og
// crmFireStageAutomation.
async function closeWebhookCreateOpportunity(contactId, fields) {
  const pipeline = await pgOne("SELECT id, name FROM crm_pipelines WHERE type='opportunity' ORDER BY position ASC LIMIT 1");
  if (!pipeline) throw new Error('Ingen salgs-pipeline (type=opportunity) findes — opret én under CRM-indstillinger');
  const stages = (await pool.query('SELECT * FROM crm_stages WHERE pipeline_id=$1 ORDER BY position ASC, id ASC', [pipeline.id])).rows;
  if (!stages.length) throw new Error('Salgs-pipelinen "' + pipeline.name + '" har ingen stages');
  const matched = closeMatchStageByName(stages, CLOSE_TRIGGER_STATUS_LABEL);
  const stage = matched || stages[0];
  if (!matched) {
    console.warn('Close-webhook: fandt ingen stage ved navn "' + CLOSE_TRIGGER_STATUS_LABEL + '" i pipelinen "' + pipeline.name + '" — bruger første stage "' + stage.name + '" i stedet.');
  }
  const posRow = await pgOne('SELECT COALESCE(MAX(position),-1)+1 AS pos FROM crm_opportunities WHERE stage_id=$1', [stage.id]);
  const r = await pgOne(`
    INSERT INTO crm_opportunities (name,contact_id,pipeline_id,stage_id,value,probability,owner_id,note,position,stage_changed_at)
    VALUES ($1,$2,$3,$4,NULL,NULL,NULL,$5,$6,${nowTextSQL()}) RETURNING id
  `, [fields.name, contactId, pipeline.id, stage.id, fields.notes, posRow.pos]);
  await crmLogActivity('opportunity', r.id, 'created', 'Salg oprettet automatisk fra Close (lead flyttet til "' + CLOSE_TRIGGER_STATUS_LABEL + '")', null);
  crmFireStageAutomation('opportunity', r.id, stage.id, { name: fields.name, email: fields.email, phone: fields.phone })
    .catch(e => console.error('SMS/email-automatik fejlede for Close-salg #' + r.id + ':', e.message));
  return { id: r.id, stageName: stage.name, matchedStage: !!matched };
}

app.post('/api/integrations/close/webhook', asyncRoute(async (req, res) => {
  if (!CLOSE_API_KEY || !CLOSE_WEBHOOK_SIGNING_KEY) {
    console.error('Close-webhook kaldt, men CLOSE_API_KEY/CLOSE_WEBHOOK_SIGNING_KEY er ikke sat i miljøvariablerne.');
    return res.status(501).json({ error: 'Close-integrationen er ikke sat op endnu' });
  }
  if (!verifyCloseWebhookSignature(req)) {
    console.error('Close-webhook: ugyldig signatur — afvist.');
    return res.status(401).json({ error: 'Ugyldig signatur' });
  }
  // Svar Close med det samme — vi vil ikke risikere at Close gentager kaldet
  // fordi VORES efterbehandling (opslag mod Close + oprettelse her) tager for
  // lang tid. Selve arbejdet fortsætter i baggrunden efter res.json().
  res.json({ ok: true });

  try {
    const event = (req.body && req.body.event) || {};
    const leadId = event.lead_id || (event.data && event.data.lead_id) || (event.data && event.data.id) || null;
    const newStatusId = (event.data && (event.data.status_id || (event.data.status && event.data.status.id))) || null;
    if (!leadId || !newStatusId) return; // ikke et status-skifte-event vi kan bruge
    const triggerStatusId = await resolveCloseTriggerStatusId();
    if (newStatusId !== triggerStatusId) return; // skiftede til en ANDEN status end "Lav Tilbud" — ignorér

    // Tre tilstande, ikke to som før (hvor ETHVERT eksisterende link betød
    // "spring alt over"):
    //   1) link findes MED opportunity_id  → færdigbehandlet, spring over.
    //   2) link findes UDEN opportunity_id → kunden blev oprettet af den GAMLE
    //      kode (før salg-udvidelsen), eller salget fejlede sidst. Selvhelbred:
    //      opret KUN det manglende salg på den kunde der allerede findes.
    //   3) intet link                      → fuldt forløb: kunde + kontakt + salg.
    const existingLink = await pgOne('SELECT customer_id, opportunity_id FROM close_customer_links WHERE close_lead_id=$1', [leadId]);
    if (existingLink && existingLink.opportunity_id) {
      console.log('Close-webhook: lead ' + leadId + ' er allerede oprettet som kunde #' + existingLink.customer_id + ' og salg #' + existingLink.opportunity_id + ' — springer over.');
      return;
    }

    const lead = await fetchCloseLeadDetails(leadId);
    const attachmentLinks = await fetchCloseLeadAttachmentLinks(leadId);
    const fields = closeLeadToCustomerFields(lead, attachmentLinks);

    let customerId, contactId;
    if (existingLink) {
      // Selvhelbredelse. Kunden findes allerede og må IKKE oprettes igen — vi
      // slår derfor bevidst IKKE crmFindOrCreateContactAndCustomer op her
      // (den ville kunne lande på en anden kunde, eller oprette en ny, hvis
      // Close-leadet i mellemtiden har fået rettet telefon/email). Vi genbruger
      // den kontakt der allerede peger på kunden, og opretter kun en kontakt
      // hvis kunden slet ingen har (typisk: kunden blev lavet med den gamle
      // rå INSERT INTO customers, helt uden om crm_contacts).
      customerId = existingLink.customer_id;
      const existingContact = await pgOne('SELECT id FROM crm_contacts WHERE customer_id=$1 ORDER BY id ASC LIMIT 1', [customerId]);
      if (existingContact) contactId = existingContact.id;
      else {
        const c = await pgOne(
          'INSERT INTO crm_contacts (name,email,phone,address,customer_id) VALUES ($1,$2,$3,$4,$5) RETURNING id',
          [fields.name, fields.email, fields.phone, fields.address, customerId]
        );
        contactId = c.id;
      }
      console.log('Close-webhook: lead ' + leadId + ' har allerede kunde #' + customerId + ', men mangler sit salg i Sales-pipelinen — opretter det nu.');
    } else {
      // crmFindOrCreateContactAndCustomer i stedet for den tidligere rå
      // INSERT INTO customers: samme dedup (telefon først, så email) som resten
      // af appen, og den giver os den kontakt-række salget skal hænge på
      // (crm_opportunities har ingen customer_id — kun contact_id).
      const linked = await crmFindOrCreateContactAndCustomer(fields.name, fields.email, fields.phone, fields.address, fields.notes);
      customerId = linked.customerId;
      contactId = linked.contactId;
      await pool.query('INSERT INTO close_customer_links (close_lead_id, customer_id) VALUES ($1,$2) ON CONFLICT DO NOTHING', [leadId, customerId]);
      console.log('Close-webhook: ' + (linked.customerCreated ? 'oprettede kunde #' : 'genbrugte eksisterende kunde #') + customerId + ' ("' + fields.name + '") ud fra Close-lead ' + leadId);
    }

    // Salget i sit EGET try: fejler det, skal kunden ovenfor stadig stå. Vi
    // lader opportunity_id blive NULL, så næste udløsning/gentagelse fra Close
    // på samme lead automatisk prøver igen (tilstand 2 ovenfor) i stedet for at
    // fejlen forsvinder i stilhed.
    try {
      const opp = await closeWebhookCreateOpportunity(contactId, fields);
      await pool.query('UPDATE close_customer_links SET opportunity_id=$1 WHERE close_lead_id=$2', [opp.id, leadId]);
      console.log('Close-webhook: oprettede salg #' + opp.id + ' ("' + fields.name + '") i stagen "' + opp.stageName + '"' + (opp.matchedStage ? '' : ' (navnematch fejlede — brugte pipelinens første stage)') + ' for Close-lead ' + leadId);
    } catch (e) {
      console.error('Close-webhook: kunde #' + customerId + ' er på plads for lead ' + leadId + ', men salget i Sales-pipelinen kunne IKKE oprettes: ' + e.message + ' — opportunity_id efterlades NULL, så det prøves igen ved næste udløsning.');
      await logSystemEvent('close_webhook', 'error', 'Close-webhook: kunne ikke oprette salg i Sales-pipelinen for Close-lead ' + leadId + ' (kunde #' + customerId + ' er oprettet): ' + e.message);
    }
  } catch (e) {
    console.error('Close-webhook fejlede under efterbehandling:', e.message);
  }
}));

// ══════════════════════════════════════════════════════════════
// LEAD-INTAKE WEBHOOK — Martins ønske om automatisk at modtage leads fra sin
// WordPress/Elementor-formular og fra Facebook Lead Ads. I MODSÆTNING til
// Close-webhooken ovenfor (som kun opretter en "customers"-række, uden om
// hele CRM'et) opretter DENNE et rigtigt lead i Leads-pipelinen — så det får
// samme selvstændige SMS/email-automatik som alle andre leads (se
// crmFireStageAutomation), fx en velkomst-SMS hvis "Ny"-stagen har det slået
// til. Ikke bygget til at forbindes direkte fra Elementor/Facebook (deres
// egne webhook-formater er forskellige og ustabile at parse) — i stedet går
// begge igennem Make.com, som oversætter til det simple JSON-format herunder.
//
// OPSÆTNING (se "🤖 Automatisering"-fanen under Skabeloner i appen for URL +
// nøgle, klar til at indsætte i Make):
//   URL:  https://<jeres-render-url>/api/integrations/lead-intake/<kilde>
//         <kilde> er frit tekst til jeres egen reference, fx "elementor" eller
//         "facebook-ads" — indgår bare som lead'ets "Kilde" i CRM'et.
//   Header: X-Webhook-Secret: <nøglen fra Automatisering-fanen>
//           (et ?token=<nøgle> query-param virker også, hvis Make's Webhooks-
//           modul gør headers besværligt at sætte op).
//   Body (JSON): { "name": "...", "email": "...", "phone": "...", "address": "...", "note": "..." }
//           Kun "name" er påkrævet — map Elementor/Facebook-felterne til disse
//           navne i et "Set variable"/"Compose"-trin i Make FØR I sender videre.
// ══════════════════════════════════════════════════════════════
const LEAD_WEBHOOK_SOURCE_LABELS = { 'elementor': 'Elementor (WordPress)', 'facebook-ads': 'Facebook Ads' };
async function verifyLeadWebhookSecret(req) {
  const provided = req.headers['x-webhook-secret'] || req.query.token || '';
  if (!provided) return false;
  const row = await pgOne("SELECT value FROM app_settings WHERE key='lead_webhook_secret'");
  const expected = row && row.value;
  if (!expected) return false;
  try {
    return crypto.timingSafeEqual(Buffer.from(String(provided)), Buffer.from(String(expected)));
  } catch (e) {
    return false; // forskellig længde — helt sikkert ikke et match
  }
}
// ── ROBUSTHED I MODTAGELSEN (sep. 2026) ─────────────────────────────────────
// Anledning: Martin så et Facebook Ads-scenarie der "kørte grønt" i Make, men
// hvor leadet aldrig dukkede op i Gulvmaster — mens præcis samme endpoint
// virkede fint for Elementor. Selve route-koden er identisk uanset :source, så
// der er ikke (og var ikke) nogen kilde-specifik fejl her. Den langt mest
// sandsynlige forklaring ligger i Make-scenariet: enten et felt der ikke er
// mappet, eller Make's HTTP-modul der IKKE sætter Content-Type: application/json
// på netop det scenarie. Sker det sidste, springer Express' body-parsere over,
// req.body ender tom, "name" læses som tom — og endpointet svarer (helt korrekt
// set fra sin egen side) 400 "Navn mangler". Make viser i mange opsætninger
// stadig trinnet som gennemført, så det ligner "det virkede".
//
// De tre ting nedenfor gør at det ikke kan gentage sig ubemærket:
//   1. leadIntakeParseBody: forstår også en body der kommer HELT uden
//      Content-Type, som text/plain eller som application/octet-stream —
//      både hvis indholdet er JSON og hvis det er formular-kodet (a=1&b=2).
//      application/json og application/x-www-form-urlencoded håndteres i
//      forvejen af de globale parsere øverst i filen (express.json /
//      express.urlencoded) og røres ikke.
//   2. leadIntakeField: accepterer de mest almindelige alternative feltnavne,
//      fx Facebooks egne "full_name" og "phone_number", så et glemt
//      omdøbnings-trin i Make ikke i sig selv koster leadet.
//   3. En tydelig serverlog ved afvisning, med Content-Type, hvilke nøgler
//      body'en faktisk indeholdt, og :source — nok til at diagnosticere, uden
//      at skrive selve kundedata (navn/tlf/mail) i loggen.
// X-Webhook-Secret-tjekket er UÆNDRET og præcis lige så striks som før.
function leadIntakeParseBody(req, res, next) {
  // req._body sættes af body-parser når en af de globale parsere har læst
  // streamen. Er den sat, er der intet tilbage at læse — og intet at gøre.
  if (req._body) return next();
  let raw = '';
  let tooBig = false;
  req.setEncoding('utf8');
  req.on('data', chunk => {
    if (raw.length > 1000000) { tooBig = true; return; }
    raw += chunk;
  });
  req.on('end', () => {
    const text = tooBig ? '' : raw.trim();
    if (!text) return next();
    try {
      const parsed = JSON.parse(text);
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
        req.body = parsed;
        req.leadIntakeRecovered = 'json-uden-content-type';
        return next();
      }
    } catch (e) { /* ikke JSON — prøv formular-kodet nedenfor */ }
    try {
      const params = new URLSearchParams(text);
      const obj = {};
      for (const [key, value] of params) obj[key] = value;
      if (Object.keys(obj).length) {
        req.body = obj;
        req.leadIntakeRecovered = 'formular-kodet-uden-content-type';
      }
    } catch (e) { /* hverken JSON eller formular — body forbliver tom */ }
    next();
  });
  req.on('error', () => next());
}

// Sender Make (eller en anden afsender) en body med Content-Type:
// application/json men et indhold der IKKE er gyldig JSON — fx afkortet fordi
// et felt i Make var tomt, eller med en efterladt komma — så fejler Express'
// globale JSON-parser FØR ruten overhovedet nås. Uden dette ville det ende som
// en generisk 500 "Unhandled error: SyntaxError" uden nogen antydning af hvilken
// webhook eller hvilken kilde det drejede sig om. Her fanges det i stedet med
// en 400 og en log der siger præcis hvad der kom ind. Handleren er scopet til
// lead-intake-stien alene; alt andet sendes uændret videre til den globale
// fejl-handler nederst i filen.
app.use('/api/integrations/lead-intake', (error, req, res, next) => {
  if (!error || (error.type !== 'entity.parse.failed' && !(error instanceof SyntaxError))) return next(error);
  console.error('lead-intake webhook AFVIST (body kunne ikke parses). source=' + String((req.path || '').replace(/^\//, '') || '(ingen)')
    + ', content-type=' + String(req.headers['content-type'] || '(ingen)')
    + ', content-length=' + String(req.headers['content-length'] || '(ingen)')
    + ', parse-fejl=' + String(error.message));
  res.status(400).json({
    error: 'Body kunne ikke læses',
    hint: 'Content-Type var ' + String(req.headers['content-type'] || '(ingen)') + ', men indholdet er ikke gyldig JSON. Tjek feltmapningen i Make — et tomt felt kan efterlade ugyldig JSON.'
  });
});

// Slår et felt op på tværs af de navne forskellige kilder bruger. Første
// ikke-tomme værdi vinder; vores egne dokumenterede navne står altid først.
function leadIntakeField(body, names) {
  for (const key of names) {
    const value = body[key];
    if (value !== undefined && value !== null && String(value).trim()) return String(value).trim();
  }
  return '';
}

app.post('/api/integrations/lead-intake/:source', leadIntakeParseBody, asyncRoute(async (req, res) => {
  if (!(await verifyLeadWebhookSecret(req))) return res.status(401).json({ error: 'Ugyldig eller manglende nøgle (X-Webhook-Secret)' });
  const b = (req.body && typeof req.body === 'object' && !Array.isArray(req.body)) ? req.body : {};
  const name = leadIntakeField(b, ['name', 'Name', 'navn', 'Navn', 'full_name', 'fullName', 'full name'])
    || [leadIntakeField(b, ['first_name', 'firstName', 'fornavn']), leadIntakeField(b, ['last_name', 'lastName', 'efternavn'])].filter(Boolean).join(' ').trim();
  if (!name) {
    // Bevidst uden selve værdierne — kun STRUKTUREN, så en fejlsøgning senere
    // (Martins eller vores) kan se med det samme om body'en overhovedet kom
    // frem, og med hvilken Content-Type.
    console.error('lead-intake webhook AFVIST (intet navn i body). source=' + String(req.params.source || '(ingen)')
      + ', content-type=' + String(req.headers['content-type'] || '(ingen)')
      + ', body-nøgler=[' + Object.keys(b).join(',') + ']'
      + ', body-type=' + (Array.isArray(req.body) ? 'array' : typeof req.body)
      + ', content-length=' + String(req.headers['content-length'] || '(ingen)')
      + (req.leadIntakeRecovered ? ', genfundet-som=' + req.leadIntakeRecovered : ''));
    return res.status(400).json({ error: 'Navn mangler', hint: 'Send feltet "name" i body\'en. Modtaget Content-Type: ' + String(req.headers['content-type'] || '(ingen)') + '. Modtagne felter: ' + (Object.keys(b).join(', ') || '(ingen)') });
  }
  if (req.leadIntakeRecovered) {
    console.warn('lead-intake webhook: body kom uden brugbar Content-Type og blev genfundet som ' + req.leadIntakeRecovered
      + ' (source=' + String(req.params.source || '(ingen)') + '). Overvej at sætte Content-Type: application/json i Make.');
  }
  b.email = leadIntakeField(b, ['email', 'Email', 'e-mail', 'mail', 'email_address']) || null;
  b.phone = leadIntakeField(b, ['phone', 'Phone', 'telefon', 'tlf', 'phone_number', 'mobile', 'mobil']) || null;
  b.address = leadIntakeField(b, ['address', 'Address', 'adresse', 'street_address', 'street']) || null;
  b.note = leadIntakeField(b, ['note', 'Note', 'besked', 'message', 'comments', 'kommentar']) || null;
  const sourceLabel = LEAD_WEBHOOK_SOURCE_LABELS[req.params.source] || (req.params.source ? String(req.params.source) : 'Webhook');

  const p = await pgOne("SELECT id FROM crm_pipelines WHERE type='lead' ORDER BY position ASC LIMIT 1");
  if (!p) return res.status(400).json({ error: 'Ingen lead-pipeline findes — opret én under CRM-indstillinger' });
  const s = await pgOne('SELECT id FROM crm_stages WHERE pipeline_id=$1 ORDER BY position ASC LIMIT 1', [p.id]);
  const stageId = s && s.id;
  const posRow = await pgOne('SELECT COALESCE(MAX(position),-1)+1 AS pos FROM crm_leads WHERE stage_id=$1', [stageId]);

  const r = await pgOne(`
    INSERT INTO crm_leads (name,email,phone,address,source,note,pipeline_id,stage_id,owner_id,position,stage_changed_at)
    VALUES ($1,$2,$3,$4,$5,$6,$7,$8,NULL,$9,${nowTextSQL()}) RETURNING id
  `, [name, b.email || null, b.phone || null, b.address || null, sourceLabel, b.note || null, p.id, stageId, posRow.pos]);
  await crmLogActivity('lead', r.id, 'created', 'Lead modtaget automatisk via ' + sourceLabel, null);

  const linked = await crmFindOrCreateContactAndCustomer(name, b.email || null, b.phone || null, b.address || null, b.note || null);
  await pool.query('UPDATE crm_leads SET contact_id=$1 WHERE id=$2', [linked.contactId, r.id]);
  await crmLogActivity('lead', r.id, 'linked', (linked.customerCreated ? 'Ny kunde oprettet automatisk: ' : 'Koblet til eksisterende kunde: ') + name, null);

  crmFireStageAutomation('lead', r.id, stageId, { name, email: b.email || null, phone: b.phone || null })
    .catch(e => console.error('SMS/email-automatik fejlede for webhook-lead #' + r.id + ':', e.message));

  res.json({ ok: true, id: r.id });
}));

// ══════════════════════════════════════════════════════════════
// INDBYGGET CRM — Leads-pipeline → konverter til Kontakt + Opportunity i
// Sales-pipelinen, redigerbare pipelines/stages, brugerdefinerede felter.
// Se migrationen i initSchema() for tabellerne. Alt herunder kræver
// finance_admin, ligesom resten af CRM/Kunder-modulet.
// ══════════════════════════════════════════════════════════════
async function crmGetCustomFieldDefs(entityType) {
  const r = await pool.query('SELECT * FROM crm_custom_fields WHERE entity_type=$1 ORDER BY position ASC, id ASC', [entityType]);
  return r.rows.map(f => ({ ...f, options: f.options || [] }));
}
async function crmGetCustomFieldValues(entityType, entityId) {
  const r = await pool.query(`
    SELECT cf.key, cfv.value FROM crm_custom_field_values cfv
    JOIN crm_custom_fields cf ON cf.id = cfv.field_id
    WHERE cfv.entity_type=$1 AND cfv.entity_id=$2
  `, [entityType, entityId]);
  const out = {};
  r.rows.forEach(row => { out[row.key] = row.value; });
  return out;
}
async function crmGetCustomFieldValuesBulk(entityType, entityIds) {
  if (!entityIds.length) return {};
  const r = await pool.query(`
    SELECT cfv.entity_id, cf.key, cfv.value FROM crm_custom_field_values cfv
    JOIN crm_custom_fields cf ON cf.id = cfv.field_id
    WHERE cfv.entity_type=$1 AND cfv.entity_id = ANY($2::int[])
  `, [entityType, entityIds]);
  const out = {};
  r.rows.forEach(row => { (out[row.entity_id] = out[row.entity_id] || {})[row.key] = row.value; });
  return out;
}
// `exec` er valgfri og kan være enten poolen (standard) eller en klient midt i
// en transaktion — se crmWithTransaction nedenfor. Alle eksisterende kaldesteder
// udelader den og rammer derfor poolen præcis som før.
async function crmSetCustomFieldValues(entityType, entityId, valuesObj, exec) {
  const db = exec || pool;
  if (!valuesObj || typeof valuesObj !== 'object') return;
  const defs = await crmGetCustomFieldDefs(entityType);
  const byKey = {}; defs.forEach(d => { byKey[d.key] = d; });
  for (const key of Object.keys(valuesObj)) {
    const def = byKey[key];
    if (!def) continue; // ukendt felt-nøgle — ignoreres stille (fx et felt der lige er slettet)
    const val = valuesObj[key];
    if (val === null || val === undefined || val === '') {
      await db.query('DELETE FROM crm_custom_field_values WHERE field_id=$1 AND entity_type=$2 AND entity_id=$3', [def.id, entityType, entityId]);
    } else {
      await db.query(`
        INSERT INTO crm_custom_field_values (field_id, entity_type, entity_id, value) VALUES ($1,$2,$3,$4)
        ON CONFLICT (field_id, entity_type, entity_id) DO UPDATE SET value=$4
      `, [def.id, entityType, entityId, String(val)]);
    }
  }
}
async function crmLogActivity(entityType, entityId, kind, body, userId, exec) {
  await (exec || pool).query('INSERT INTO crm_activities (entity_type,entity_id,kind,body,user_id) VALUES ($1,$2,$3,$4,$5)', [entityType, entityId, kind, body || null, userId || null]);
}

// ── Fælles transaktions-indpakning for CRM-skrivninger ───────────
// Samme BEGIN/COMMIT/ROLLBACK-mønster som resten af filen allerede bruger
// (fx syncGanttJob), blot samlet ét sted så både enkelt-sletning og
// masse-handlingerne nedenfor deler nøjagtig samme opførsel: enten går HELE
// operationen igennem, eller også rulles den helt tilbage.
async function crmWithTransaction(fn) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const out = await fn(client);
    await client.query('COMMIT');
    return out;
  } catch (error) {
    try { await client.query('ROLLBACK'); } catch (_) {}
    throw error;
  } finally {
    client.release();
  }
}

// ── SLETNING af ét lead / én opportunity, inkl. børnerækker ──────
// FEJLRETTELSE (sep. 2026): DELETE /api/crm/leads/:id og
// DELETE /api/crm/opportunities/:id kørte tidligere BARE
// "DELETE FROM crm_leads WHERE id=$1" og intet andet.
//
// crm_custom_field_values, crm_activities og crm_tasks peger alle tre på
// (entity_type, entity_id) som et LØST par UDEN nogen foreign key — det er
// bevidst, fordi den samme tabel deles af flere entitetstyper ('lead',
// 'opportunity', 'contact') — men det betyder samtidig at Postgres ikke har
// nogen ON DELETE CASCADE at rydde op med. Hver sletning efterlod derfor
// forældreløse custom field-værdier, hele aktivitetstidslinjen og evt.
// opgaver liggende i databasen for evigt.
//
// Desuden: crm_leads.converted_opportunity_id blev tilføjet med
// "ALTER TABLE ... ADD COLUMN IF NOT EXISTS ... REFERENCES crm_opportunities(id)
// ON DELETE SET NULL", men kolonnen fandtes ALLEREDE fra den oprindelige
// CREATE TABLE (uden FK), så ADD COLUMN IF NOT EXISTS blev et no-op og
// fremmednøglen kom aldrig i databasen (bekræftet mod information_schema).
// Sletter man en opportunity, står det oprindelige lead altså tilbage med et
// converted_opportunity_id der peger i tomme luften — hvilket bl.a. gør at
// 🤝 Konvertér-knappen på leadet bliver ved med at være skjult ("allerede
// konverteret") selvom salget er væk. Vi nulstiller derfor selv feltet her i
// stedet for at stole på en FK der ikke findes.
//
// `exec` skal normalt være en transaktionsklient (se crmWithTransaction), så
// hele oprydningen + selve sletningen er atomisk.
async function crmDeleteEntityCascade(exec, entityType, entityId) {
  const table = entityType === 'lead' ? 'crm_leads' : 'crm_opportunities';
  const id = Number(entityId);
  if (!Number.isInteger(id) || id <= 0) return 0;
  await exec.query('DELETE FROM crm_custom_field_values WHERE entity_type=$1 AND entity_id=$2', [entityType, id]);
  await exec.query('DELETE FROM crm_activities WHERE entity_type=$1 AND entity_id=$2', [entityType, id]);
  await exec.query('DELETE FROM crm_tasks WHERE entity_type=$1 AND entity_id=$2', [entityType, id]);
  if (entityType === 'lead') {
    // Der ER en rigtig FK (ON DELETE SET NULL) på denne — vi gør det blot
    // eksplicit, så adfærden er den samme uanset om en ældre database mangler den.
    await exec.query('UPDATE crm_opportunities SET source_lead_id=NULL WHERE source_lead_id=$1', [id]);
  } else {
    await exec.query('UPDATE crm_leads SET converted_opportunity_id=NULL WHERE converted_opportunity_id=$1', [id]);
  }
  // close_customer_links.lead_id/opportunity_id ryddes BEVIDST IKKE — se
  // kommentaren ved kolonnen i initSchema: linket skal blive stående som
  // "behandlet", så en gentaget Close-webhook ikke genopretter noget Martin
  // netop har slettet i hånden.
  const r = await exec.query(`DELETE FROM ${table} WHERE id=$1`, [id]);
  return r.rowCount || 0;
}

// ══════════════════════════════════════════════════════════════
// MASSE-HANDLINGER PÅ KANBAN-BOARDET (Martins ønske: "slet, opdatere felt mm")
// ── POST /api/crm/leads/bulk og POST /api/crm/opportunities/bulk ──
//
//   { ids:[1,2,3], action:'delete' }
//   { ids:[...],   action:'stage',  stage_id:42 }
//   { ids:[...],   action:'field',  field_scope:'custom'|'core', field_key:'projekt_type', value:'Maler' }
//
// Begge ruter deler nøjagtig samme handler og er gated med præcis samme
// panelAccess som enkelt-ruterne ('crmp_leads' hhv. 'crmp_sales'). Alt skrives
// inde i én transaktion, og selve sletningen genbruger crmDeleteEntityCascade
// — samme funktion som DELETE .../:id kalder — i stedet for en parallel
// implementering.
//
// KERNEFELTER der må masseopdateres. Bevidst en kort, eksplicit hvidliste:
// nøglerne herfra interpoleres direkte ind i UPDATE-sætningen, så listen ER
// sikkerhedsgrænsen (værdierne parametriseres som alt andet).
const CRM_BULK_CORE_FIELDS = {
  lead: { source: { type: 'text', label: 'Kilde' }, owner_id: { type: 'user', label: 'Ansvarlig' } },
  opportunity: { owner_id: { type: 'user', label: 'Ansvarlig' } }
};
const CRM_BULK_MAX_IDS = 500;

async function crmBulkAction(entityType, req, res) {
  const b = req.body || {};
  const table = entityType === 'lead' ? 'crm_leads' : 'crm_opportunities';
  const ids = Array.from(new Set((Array.isArray(b.ids) ? b.ids : []).map(Number).filter(n => Number.isInteger(n) && n > 0)));
  if (!ids.length) return res.status(400).json({ error: 'Ingen kort valgt' });
  if (ids.length > CRM_BULK_MAX_IDS) return res.status(400).json({ error: 'For mange kort valgt på én gang (maks. ' + CRM_BULK_MAX_IDS + ')' });
  const action = String(b.action || '');
  const rows = (await pool.query(`SELECT * FROM ${table} WHERE id = ANY($1::int[])`, [ids])).rows;
  if (!rows.length) return res.status(404).json({ error: 'Ingen af de valgte kort findes længere' });

  if (action === 'delete') {
    const deleted = await crmWithTransaction(async client => {
      let n = 0;
      for (const row of rows) n += await crmDeleteEntityCascade(client, entityType, row.id);
      return n;
    });
    return res.json({ ok: true, action, deleted });
  }

  if (action === 'stage') {
    const stageId = Number(b.stage_id);
    if (!Number.isInteger(stageId) || stageId <= 0) return res.status(400).json({ error: 'stage_id mangler' });
    const stage = await pgOne('SELECT * FROM crm_stages WHERE id=$1', [stageId]);
    if (!stage) return res.status(404).json({ error: 'Stagen findes ikke' });
    // Samme regel som træk-og-slip på boardet: et kort kan kun flyttes til en
    // stage i sin EGEN pipeline.
    if (rows.some(r => Number(r.pipeline_id) !== Number(stage.pipeline_id))) {
      return res.status(400).json({ error: 'Stagen hører til en anden pipeline end de valgte kort' });
    }
    const changed = rows.filter(r => Number(r.stage_id) !== stageId);
    await crmWithTransaction(async client => {
      for (const row of changed) {
        await client.query(`UPDATE ${table} SET stage_id=$1, updated_at=${nowTextSQL()}, stage_changed_at=${nowTextSQL()} WHERE id=$2`, [stageId, row.id]);
        await crmLogActivity(entityType, row.id, 'stage_change', 'Status ændret til "' + stage.name + '"', req.user.id, client);
      }
    });
    // SMS/email-automatik EFTER commit — nøjagtig samme kald som ved en enkelt
    // flytning (PUT .../:id og træk-og-slip på boardet), så en masseflytning
    // ikke pludselig springer Martins stage-automatik over. crmFireStageAutomation
    // deduplikerer selv pr. (kort, stage), og må aldrig vælte selve svaret.
    for (const row of changed) {
      let fields = { name: row.name, email: row.email || null, phone: row.phone || null };
      if (entityType === 'opportunity') {
        const c = row.contact_id ? await pgOne('SELECT name, email, phone FROM crm_contacts WHERE id=$1', [row.contact_id]) : null;
        fields = { name: (c && c.name) || row.name, email: c && c.email, phone: c && c.phone };
      }
      crmFireStageAutomation(entityType, row.id, stageId, fields)
        .catch(e => console.error('SMS/email-automatik fejlede for ' + entityType + ' #' + row.id + ':', e.message));
    }
    return res.json({ ok: true, action, updated: changed.length, unchanged: rows.length - changed.length });
  }

  if (action === 'field') {
    const scope = String(b.field_scope || 'custom');
    const key = String(b.field_key || '');
    const raw = (b.value === undefined || b.value === null) ? '' : String(b.value);
    if (!key) return res.status(400).json({ error: 'Felt mangler' });

    if (scope === 'custom') {
      const defs = await crmGetCustomFieldDefs(entityType);
      const def = defs.find(d => d.key === key);
      if (!def) return res.status(400).json({ error: 'Ukendt felt' });
      // Samme validering som enkelt-redigeringen reelt giver via dropdown'en på
      // detaljesiden: et select-felt kan kun sættes til en af sine egne options
      // (eller ryddes med tom værdi).
      if (def.field_type === 'select' && raw !== '' && !(def.options || []).map(String).includes(raw)) {
        return res.status(400).json({ error: 'Ugyldig værdi for feltet "' + def.label + '"' });
      }
      await crmWithTransaction(async client => {
        for (const row of rows) {
          await crmSetCustomFieldValues(entityType, row.id, { [key]: raw }, client);
          await client.query(`UPDATE ${table} SET updated_at=${nowTextSQL()} WHERE id=$1`, [row.id]);
          await crmLogActivity(entityType, row.id, 'field_update', def.label + ' sat til "' + (raw || '—') + '" (masseopdatering)', req.user.id, client);
        }
      });
      return res.json({ ok: true, action, updated: rows.length });
    }

    const coreDef = (CRM_BULK_CORE_FIELDS[entityType] || {})[key];
    if (!coreDef) return res.status(400).json({ error: 'Feltet kan ikke masseopdateres' });
    let val = raw === '' ? null : raw;
    if (coreDef.type === 'user' && val !== null) {
      const u = await pgOne('SELECT id FROM users WHERE id=$1', [Number(val)]);
      if (!u) return res.status(400).json({ error: 'Ukendt bruger' });
      val = u.id;
    }
    await crmWithTransaction(async client => {
      for (const row of rows) {
        await client.query(`UPDATE ${table} SET ${key}=$1, updated_at=${nowTextSQL()} WHERE id=$2`, [val, row.id]);
        await crmLogActivity(entityType, row.id, 'field_update', coreDef.label + ' sat til "' + (raw || '—') + '" (masseopdatering)', req.user.id, client);
      }
    });
    return res.json({ ok: true, action, updated: rows.length });
  }

  return res.status(400).json({ error: 'Ukendt handling' });
}

// ── Automatisk SMS/email pr. pipeline-stage ──────────────────────
// Martins ønske om at flytte det han i dag gør med Close+inMobile ind i vores
// eget system: hver stage kan have en valgfri SMS- og/eller email-skabelon
// (crm_stages.sms_enabled/sms_template/email_enabled/email_subject/email_body).
// Kaldes hver gang et lead/en opportunity LANDER i en stage — både ved
// OPRETTELSE (fx et nyt lead fra webhooken nedenfor) og ved et rigtigt
// stage-SKIFT (træk i kanban/dropdown). Fejler afsendelsen (forkert/manglende
// nøgle, ugyldigt nummer osv.), må det ALDRIG vælte selve lead/opportunity-
// kaldet — logges blot som en aktivitet på leadet/sagen, ligesom alt andet her.
async function crmFireStageAutomation(entityType, entityId, stageId, contactFields) {
  if (!stageId) return;
  const stage = await pgOne('SELECT * FROM crm_stages WHERE id=$1', [stageId]);
  if (!stage) return;
  const vars = {
    navn: contactFields.name || '',
    telefon: contactFields.phone || '',
    email: contactFields.email || '',
    firma: 'Gulv Master Enterprise ApS',
    stage: stage.name || ''
  };
  // Once-per-(entity,stage)-dedup: Martins udtrykkelige krav (sep. 2026) — hvis
  // et kort rykkes ud og tilbage til samme stage igen (fx ved en fejl), skal
  // den samme SMS/mail IKKE sendes igen. Dedup-nøglen er selve activity-kind'en
  // (sms_sent_stage<ID>/email_sent_stage<ID>) — en eksisterende sådan række ER
  // "sendt allerede"-flaget, ligesom lost-followup-scanningen gør det for sit
  // eget kind. En FEJLET afsendelse logges under et andet, ikke-blokerende kind
  // (sms_failed/email_failed), så et forbigående problem ikke forhindrer et
  // reelt forsøg senere (fx ved et nyt stage-skift).
  const smsKind = 'sms_sent_stage' + stageId;
  const emailKind = 'email_sent_stage' + stageId;
  if (stage.sms_enabled && stage.sms_template && contactFields.phone) {
    const already = await pgOne('SELECT id FROM crm_activities WHERE entity_type=$1 AND entity_id=$2 AND kind=$3', [entityType, entityId, smsKind]);
    if (!already) {
      try {
        const message = fillDocEmailVars(stage.sms_template, vars);
        await sendSmsUniversal({ to: contactFields.phone, message });
        await crmLogActivity(entityType, entityId, smsKind, 'SMS sendt ("' + stage.name + '"): ' + message, null);
      } catch (e) {
        await crmLogActivity(entityType, entityId, 'sms_failed', 'SMS-automatik fejlede ("' + stage.name + '"): ' + e.message, null);
      }
    }
  }
  if (stage.email_enabled && stage.email_body && contactFields.email) {
    const already = await pgOne('SELECT id FROM crm_activities WHERE entity_type=$1 AND entity_id=$2 AND kind=$3', [entityType, entityId, emailKind]);
    if (!already) {
      try {
        const subject = fillDocEmailVars(stage.email_subject || 'Besked fra ' + vars.firma, vars);
        const html = fillDocEmailVars(stage.email_body, vars);
        await sendMailUniversal({ to: contactFields.email, subject, html, text: html.replace(/<[^>]+>/g, ' ') });
        await crmLogActivity(entityType, entityId, emailKind, 'Email sendt ("' + stage.name + '"): ' + subject, null);
      } catch (e) {
        await crmLogActivity(entityType, entityId, 'email_failed', 'Email-automatik fejlede ("' + stage.name + '"): ' + e.message, null);
      }
    }
  }
}

// ── Tidsbaserede opfølgninger pr. stage (crm_stage_followup_rules) ──────────
// Generisk motor: for ENHVER stage i ENHVER pipeline kan man sætte flere
// dag-tærskler op (fx "7 dage: SMS+mail", "14 dage: mail", "30 dage: mail"),
// redigerbare i CRM → ⚙ Indstillinger → Pipelines. Kører dagligt (se
// cron.schedule nedenfor) — samme dedup-mønster som runLostFollowupScan: en
// crm_activities-række med en unik kind pr. (regel, kanal) ER selve "sendt
// allerede"-flaget. Forlader kortet stagen og kommer tilbage senere, nulstiller
// det stage_changed_at (dagene tælles forfra) — MEN da dedup-nøglen kun er
// bundet til (entity, regel), sender en regel der allerede er udløst for denne
// stage IKKE igen, selv efter en tur ud og ind. Det er bevidst, og matcher
// Martins "kun 1 gang pr. stage"-princip konsekvent på tværs af hele motoren.
async function runStageFollowupScan() {
  const rules = (await pool.query(`
    SELECT r.*, s.name AS stage_name, s.pipeline_id, p.type AS pipeline_type
    FROM crm_stage_followup_rules r
    JOIN crm_stages s ON s.id = r.stage_id
    JOIN crm_pipelines p ON p.id = s.pipeline_id
    WHERE r.enabled = 1
  `)).rows;
  let processed = 0;
  for (const rule of rules) {
    const entityType = rule.pipeline_type === 'lead' ? 'lead' : 'opportunity';
    const table = entityType === 'lead' ? 'crm_leads' : 'crm_opportunities';
    const smsKind = 'stage_followup_sms_r' + rule.id;
    const emailKind = 'stage_followup_email_r' + rule.id;
    const rows = (await pool.query(`
      SELECT t.id, t.stage_changed_at, t.contact_id${entityType === 'lead' ? ', t.name, t.email, t.phone' : ''}
      FROM ${table} t WHERE t.stage_id = $1 AND t.stage_changed_at IS NOT NULL
    `, [rule.stage_id])).rows;
    for (const row of rows) {
      const daysOld = Math.floor((Date.now() - new Date(row.stage_changed_at)) / 86400000);
      if (daysOld < rule.days_after) continue;
      let name = row.name, email = row.email, phone = row.phone;
      if (row.contact_id) {
        const c = await pgOne('SELECT name, email, phone FROM crm_contacts WHERE id=$1', [row.contact_id]);
        if (c) { name = c.name || name; email = c.email || email; phone = c.phone || phone; }
      }
      const vars = { navn: name || '', firma: 'Gulv Master Enterprise ApS' };
      if (rule.sms_enabled && rule.sms_template && phone) {
        const already = await pgOne('SELECT id FROM crm_activities WHERE entity_type=$1 AND entity_id=$2 AND kind=$3', [entityType, row.id, smsKind]);
        if (!already) {
          try {
            const message = fillDocEmailVars(rule.sms_template, vars);
            await sendSmsUniversal({ to: phone, message });
            await crmLogActivity(entityType, row.id, smsKind, 'Tidsbaseret SMS-opfølgning sendt (' + daysOld + ' dage i "' + rule.stage_name + '"): ' + message, null);
            processed++;
          } catch (e) {
            await crmLogActivity(entityType, row.id, 'stage_followup_sms_failed', 'Tidsbaseret SMS-opfølgning fejlede ("' + rule.stage_name + '"): ' + e.message, null);
          }
        }
      }
      if (rule.email_enabled && rule.email_body && email) {
        const already = await pgOne('SELECT id FROM crm_activities WHERE entity_type=$1 AND entity_id=$2 AND kind=$3', [entityType, row.id, emailKind]);
        if (!already) {
          try {
            const subject = fillDocEmailVars(rule.email_subject || 'Opfølgning', vars);
            const html = fillDocEmailVars(rule.email_body, vars);
            await sendMailUniversal({ to: email, subject, html, text: html.replace(/<[^>]+>/g, ' ') });
            await crmLogActivity(entityType, row.id, emailKind, 'Tidsbaseret email-opfølgning sendt (' + daysOld + ' dage i "' + rule.stage_name + '"): ' + subject, null);
            processed++;
          } catch (e) {
            await crmLogActivity(entityType, row.id, 'stage_followup_email_failed', 'Tidsbaseret email-opfølgning fejlede ("' + rule.stage_name + '"): ' + e.message, null);
          }
        }
      }
    }
  }
  await logSystemEvent('stage_followup_scan', 'info', `Tidsbaserede stage-opfølgninger: ${processed} besked(er) sendt.`);
  return { processed };
}

// Find-eller-opret en crm_contacts-række + en customers-række for et navn/
// email/telefon, og kæd dem sammen — dedupliker på telefon/email ligesom
// resten af appen allerede gør (Close-webhooken m.fl.). Genbruges både ved
// lead-OPRETTELSE (så Lead/Kunde/Sales hænger sammen fra start) og ved
// lead-KONVERTERING (uændret slutresultat, men nu ét fælles sted for logikken).
async function crmFindOrCreateContactAndCustomer(name, email, phone, address, note) {
  let contact = null;
  if (phone) contact = await pgOne('SELECT * FROM crm_contacts WHERE phone=$1', [phone]);
  if (!contact && email) contact = await pgOne('SELECT * FROM crm_contacts WHERE email=$1', [email]);
  let contactId, contactCreated = false;
  if (contact) { contactId = contact.id; }
  else {
    const c = await pgOne('INSERT INTO crm_contacts (name,email,phone,address) VALUES ($1,$2,$3,$4) RETURNING id', [name, email, phone, address]);
    contactId = c.id; contactCreated = true;
  }

  // Genbrug kunden koblet på kontakten hvis den allerede findes (undgår at
  // kunne oprette en ekstra kunde hvis kundens telefon/email er blevet
  // opdateret siden sidst, men kontakt-koblingen stadig er der).
  let customer = null;
  if (contact && contact.customer_id) customer = await pgOne('SELECT id FROM customers WHERE id=$1', [contact.customer_id]);
  if (!customer && phone) customer = await pgOne('SELECT id FROM customers WHERE phone=$1', [phone]);
  if (!customer && email) customer = await pgOne('SELECT id FROM customers WHERE email=$1', [email]);
  let customerId, customerCreated = false;
  if (customer) { customerId = customer.id; }
  else {
    const cust = await pgOne('INSERT INTO customers (name,email,phone,address,notes) VALUES ($1,$2,$3,$4,$5) RETURNING id', [name, email, phone, address, note || null]);
    customerId = cust.id; customerCreated = true;
  }
  if (!contact || contact.customer_id !== customerId) {
    await pool.query('UPDATE crm_contacts SET customer_id=$1 WHERE id=$2', [customerId, contactId]);
  }
  return { contactId, customerId, contactCreated, customerCreated };
}

// Opdaterer en kontakt (og dens koblede kunde i customers, hvis der er én) med
// de angivne felter — kaldes når navn/email/telefon/adresse redigeres fra et
// leads eller en opportunitys detaljeside. Uden dette blev den underliggende
// kunde ved med at pege på den OPRINDELIGE adresse fra dengang leadet blev
// oprettet, selvom man bagefter rettede fx email på selve leadet — hvilket bl.a.
// gjorde at Gmail-synkroniseringen (som matcher på customers.email) aldrig fandt
// mails til/fra den nye adresse. Kun felter der rent faktisk er angivet
// (ikke undefined) opdateres. Bemærk: dette OPDATERER den allerede koblede
// kunde i stedet for at køre find-eller-opret-logik igen — hvis den nye email
// tilfældigvis matcher en ANDEN eksisterende kunde, bliver de to kunder IKKE
// slået sammen automatisk (det er en større funktion i sig selv, som ikke er
// bedt om her).
async function crmPropagateContactFields(contactId, fields) {
  const keys = Object.keys(fields).filter(k => fields[k] !== undefined);
  if (!contactId || !keys.length) return;
  const setSql = keys.map((k, i) => k + '=$' + (i + 2)).join(',');
  await pool.query('UPDATE crm_contacts SET ' + setSql + ' WHERE id=$1', [contactId, ...keys.map(k => fields[k])]);
  const contact = await pgOne('SELECT customer_id FROM crm_contacts WHERE id=$1', [contactId]);
  if (contact && contact.customer_id) {
    await pool.query('UPDATE customers SET ' + setSql + ' WHERE id=$1', [contact.customer_id, ...keys.map(k => fields[k])]);
  }
}

// ── PIPELINES + STAGES ──────────────────────────────────────────
app.get('/api/crm/pipelines', auth, panelAccessAny(['customers','crmp_leads','crmp_sales','crmp_tasks']), asyncRoute(async (req, res) => {
  const pipelines = await pool.query('SELECT * FROM crm_pipelines ORDER BY position ASC, id ASC');
  const stages = await pool.query('SELECT * FROM crm_stages ORDER BY position ASC, id ASC');
  res.json(pipelines.rows.map(p => ({ ...p, stages: stages.rows.filter(s => s.pipeline_id === p.id) })));
}));
app.post('/api/crm/pipelines', auth, panelAccessAny(['customers','crmp_leads','crmp_sales','crmp_tasks']), asyncRoute(async (req, res) => {
  const b = req.body || {};
  if (!b.name) return res.status(400).json({ error: 'Navn mangler' });
  const posRow = await pgOne('SELECT COALESCE(MAX(position),-1)+1 AS pos FROM crm_pipelines');
  const r = await pgOne('INSERT INTO crm_pipelines (name,type,position) VALUES ($1,$2,$3) RETURNING id', [String(b.name).trim(), b.type === 'lead' ? 'lead' : 'opportunity', posRow.pos]);
  await pool.query('INSERT INTO crm_stages (pipeline_id,name,color,position) VALUES ($1,$2,$3,0)', [r.id, 'Ny', '#6366F1']);
  res.json({ ok: true, id: r.id });
}));
app.put('/api/crm/pipelines/:id', auth, panelAccessAny(['customers','crmp_leads','crmp_sales','crmp_tasks']), asyncRoute(async (req, res) => {
  const b = req.body || {};
  if (b.name !== undefined) await pool.query('UPDATE crm_pipelines SET name=$1 WHERE id=$2', [String(b.name).trim(), req.params.id]);
  if (b.position !== undefined) await pool.query('UPDATE crm_pipelines SET position=$1 WHERE id=$2', [b.position, req.params.id]);
  res.json({ ok: true });
}));
app.delete('/api/crm/pipelines/:id', auth, panelAccessAny(['customers','crmp_leads','crmp_sales','crmp_tasks']), asyncRoute(async (req, res) => {
  const inUse = await pgOne(`
    SELECT (SELECT COUNT(*) FROM crm_leads WHERE pipeline_id=$1) + (SELECT COUNT(*) FROM crm_opportunities WHERE pipeline_id=$1) AS n
  `, [req.params.id]);
  if (inUse && Number(inUse.n) > 0) return res.status(400).json({ error: 'Pipelinen indeholder stadig leads/opportunities — flyt eller slet dem først' });
  await pool.query('DELETE FROM crm_pipelines WHERE id=$1', [req.params.id]);
  res.json({ ok: true });
}));
app.post('/api/crm/pipelines/:id/stages', auth, panelAccessAny(['customers','crmp_leads','crmp_sales','crmp_tasks']), asyncRoute(async (req, res) => {
  const b = req.body || {};
  if (!b.name) return res.status(400).json({ error: 'Navn mangler' });
  const posRow = await pgOne('SELECT COALESCE(MAX(position),-1)+1 AS pos FROM crm_stages WHERE pipeline_id=$1', [req.params.id]);
  const r = await pgOne('INSERT INTO crm_stages (pipeline_id,name,color,position) VALUES ($1,$2,$3,$4) RETURNING id', [req.params.id, String(b.name).trim(), b.color || '#6366F1', posRow.pos]);
  res.json({ ok: true, id: r.id });
}));
app.put('/api/crm/stages/:id', auth, panelAccessAny(['customers','crmp_leads','crmp_sales','crmp_tasks']), asyncRoute(async (req, res) => {
  const b = req.body || {};
  const current = await pgOne('SELECT * FROM crm_stages WHERE id=$1', [req.params.id]);
  if (!current) return res.status(404).json({ error: 'Stage ikke fundet' });
  await pool.query('UPDATE crm_stages SET name=$1,color=$2,position=$3,is_won=$4,is_lost=$5,sms_enabled=$6,sms_template=$7,email_enabled=$8,email_subject=$9,email_body=$10 WHERE id=$11', [
    b.name !== undefined ? String(b.name).trim() : current.name,
    b.color !== undefined ? b.color : current.color,
    b.position !== undefined ? b.position : current.position,
    b.is_won !== undefined ? (b.is_won ? 1 : 0) : current.is_won,
    b.is_lost !== undefined ? (b.is_lost ? 1 : 0) : current.is_lost,
    b.sms_enabled !== undefined ? (b.sms_enabled ? 1 : 0) : current.sms_enabled,
    b.sms_template !== undefined ? b.sms_template : current.sms_template,
    b.email_enabled !== undefined ? (b.email_enabled ? 1 : 0) : current.email_enabled,
    b.email_subject !== undefined ? b.email_subject : current.email_subject,
    b.email_body !== undefined ? b.email_body : current.email_body,
    req.params.id
  ]);
  res.json({ ok: true });
}));
app.delete('/api/crm/stages/:id', auth, panelAccessAny(['customers','crmp_leads','crmp_sales','crmp_tasks']), asyncRoute(async (req, res) => {
  const inUse = await pgOne(`
    SELECT (SELECT COUNT(*) FROM crm_leads WHERE stage_id=$1) + (SELECT COUNT(*) FROM crm_opportunities WHERE stage_id=$1) AS n
  `, [req.params.id]);
  if (inUse && Number(inUse.n) > 0) return res.status(400).json({ error: 'Stagen indeholder stadig kort — flyt dem til en anden stage først' });
  const stageCount = await pgOne('SELECT COUNT(*)::int AS n FROM crm_stages WHERE pipeline_id=(SELECT pipeline_id FROM crm_stages WHERE id=$1)', [req.params.id]);
  if (stageCount && stageCount.n <= 1) return res.status(400).json({ error: 'En pipeline skal have mindst én stage' });
  await pool.query('DELETE FROM crm_stages WHERE id=$1', [req.params.id]);
  res.json({ ok: true });
}));

// ── Tidsbaserede stage-opfølgninger (crm_stage_followup_rules) ──────────────
app.get('/api/crm/stages/:id/followup-rules', auth, panelAccessAny(['customers','crmp_leads','crmp_sales','crmp_tasks']), asyncRoute(async (req, res) => {
  const rows = (await pool.query('SELECT * FROM crm_stage_followup_rules WHERE stage_id=$1 ORDER BY days_after ASC, position ASC', [req.params.id])).rows;
  res.json({ rules: rows });
}));
app.post('/api/crm/stages/:id/followup-rules', auth, panelAccessAny(['customers','crmp_leads','crmp_sales','crmp_tasks']), asyncRoute(async (req, res) => {
  const b = req.body || {};
  if (!b.days_after || Number(b.days_after) <= 0) return res.status(400).json({ error: 'Antal dage skal være større end 0' });
  const posRow = await pgOne('SELECT COALESCE(MAX(position),-1)+1 AS pos FROM crm_stage_followup_rules WHERE stage_id=$1', [req.params.id]);
  const r = await pgOne(`
    INSERT INTO crm_stage_followup_rules (stage_id, days_after, enabled, sms_enabled, sms_template, email_enabled, email_subject, email_body, position)
    VALUES ($1,$2,1,$3,$4,$5,$6,$7,$8) RETURNING id
  `, [
    req.params.id,
    Number(b.days_after),
    b.sms_enabled ? 1 : 0,
    b.sms_template || null,
    b.email_enabled ? 1 : 0,
    b.email_subject || null,
    b.email_body || null,
    posRow.pos
  ]);
  res.json({ ok: true, id: r.id });
}));
app.put('/api/crm/followup-rules/:id', auth, panelAccessAny(['customers','crmp_leads','crmp_sales','crmp_tasks']), asyncRoute(async (req, res) => {
  const b = req.body || {};
  const current = await pgOne('SELECT * FROM crm_stage_followup_rules WHERE id=$1', [req.params.id]);
  if (!current) return res.status(404).json({ error: 'Regel ikke fundet' });
  await pool.query('UPDATE crm_stage_followup_rules SET days_after=$1,enabled=$2,sms_enabled=$3,sms_template=$4,email_enabled=$5,email_subject=$6,email_body=$7,position=$8 WHERE id=$9', [
    b.days_after !== undefined ? Number(b.days_after) : current.days_after,
    b.enabled !== undefined ? (b.enabled ? 1 : 0) : current.enabled,
    b.sms_enabled !== undefined ? (b.sms_enabled ? 1 : 0) : current.sms_enabled,
    b.sms_template !== undefined ? b.sms_template : current.sms_template,
    b.email_enabled !== undefined ? (b.email_enabled ? 1 : 0) : current.email_enabled,
    b.email_subject !== undefined ? b.email_subject : current.email_subject,
    b.email_body !== undefined ? b.email_body : current.email_body,
    b.position !== undefined ? b.position : current.position,
    req.params.id
  ]);
  res.json({ ok: true });
}));
app.delete('/api/crm/followup-rules/:id', auth, panelAccessAny(['customers','crmp_leads','crmp_sales','crmp_tasks']), asyncRoute(async (req, res) => {
  await pool.query('DELETE FROM crm_stage_followup_rules WHERE id=$1', [req.params.id]);
  res.json({ ok: true });
}));
app.post('/api/crm/followup-rules/run-now', auth, panelAccessAny(['customers','crmp_leads','crmp_sales','crmp_tasks']), asyncRoute(async (req, res) => {
  const result = await runStageFollowupScan();
  res.json({ ok: true, ...result });
}));

// ── Automatiserings-indstillinger (Skabeloner → 🤖 Automatisering) ──────────
app.get('/api/crm/lead-webhook-info', auth, panelAccessAny(['customers','crmp_leads','crmp_sales','crmp_tasks']), asyncRoute(async (req, res) => {
  const row = await pgOne("SELECT value FROM app_settings WHERE key='lead_webhook_secret'");
  const base = req.protocol + '://' + req.get('host') + '/api/integrations/lead-intake/';
  res.json({
    secret: row && row.value,
    url_elementor: base + 'elementor',
    url_facebook: base + 'facebook-ads',
    sms_configured: smsIsConfigured(),
    sms_provider: smsProviderName(),
    mail_configured: mailIsConfigured()
  });
}));
app.post('/api/crm/lead-webhook-regenerate', auth, adminOnly, asyncRoute(async (req, res) => {
  const secret = crypto.randomBytes(20).toString('hex');
  await pool.query("INSERT INTO app_settings (key,value) VALUES ('lead_webhook_secret',$1) ON CONFLICT (key) DO UPDATE SET value=$1", [secret]);
  res.json({ ok: true, secret });
}));
app.get('/api/crm/lost-followup-settings', auth, panelAccessAny(['customers','crmp_leads','crmp_sales','crmp_tasks']), asyncRoute(async (req, res) => {
  const row = await pgOne('SELECT * FROM crm_lost_followup_settings WHERE id=1');
  res.json(row || {});
}));
app.put('/api/crm/lost-followup-settings', auth, panelAccessAny(['customers','crmp_leads','crmp_sales','crmp_tasks']), asyncRoute(async (req, res) => {
  const b = req.body || {};
  const current = await pgOne('SELECT * FROM crm_lost_followup_settings WHERE id=1');
  await pool.query(`UPDATE crm_lost_followup_settings SET enabled=$1,days_threshold=$2,require_quote=$3,subject=$4,body=$5,updated_at=${nowTextSQL()} WHERE id=1`, [
    b.enabled !== undefined ? (b.enabled ? 1 : 0) : current.enabled,
    b.days_threshold !== undefined ? b.days_threshold : current.days_threshold,
    b.require_quote !== undefined ? (b.require_quote ? 1 : 0) : current.require_quote,
    b.subject !== undefined ? b.subject : current.subject,
    b.body !== undefined ? b.body : current.body
  ]);
  res.json({ ok: true });
}));
app.post('/api/crm/lost-followup/run', auth, panelAccessAny(['customers','crmp_leads','crmp_sales','crmp_tasks']), asyncRoute(async (req, res) => {
  const result = await runLostFollowupScan(true);
  res.json(result);
}));

// ── CUSTOM FIELDS ────────────────────────────────────────────────
app.get('/api/crm/custom-fields', auth, panelAccessAny(['customers','crmp_leads','crmp_sales','crmp_tasks']), asyncRoute(async (req, res) => {
  const q = req.query.entity_type;
  const r = q ? await pool.query('SELECT * FROM crm_custom_fields WHERE entity_type=$1 ORDER BY position ASC, id ASC', [q])
    : await pool.query('SELECT * FROM crm_custom_fields ORDER BY entity_type ASC, position ASC, id ASC');
  res.json(r.rows);
}));
app.post('/api/crm/custom-fields', auth, panelAccessAny(['customers','crmp_leads','crmp_sales','crmp_tasks']), asyncRoute(async (req, res) => {
  const b = req.body || {};
  if (!b.label || !b.entity_type) return res.status(400).json({ error: 'Label og entitetstype mangler' });
  const key = String(b.key || b.label).trim().toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '') || 'felt';
  const posRow = await pgOne('SELECT COALESCE(MAX(position),-1)+1 AS pos FROM crm_custom_fields WHERE entity_type=$1', [b.entity_type]);
  try {
    const r = await pgOne(`
      INSERT INTO crm_custom_fields (entity_type,key,label,field_type,options,position,show_on_card,option_colors) VALUES ($1,$2,$3,$4,$5,$6,$7,$8) RETURNING id
    `, [b.entity_type, key, String(b.label).trim(), b.field_type || 'text', JSON.stringify(Array.isArray(b.options) ? b.options : []), posRow.pos, b.show_on_card ? 1 : 0, JSON.stringify(b.option_colors && typeof b.option_colors === 'object' ? b.option_colors : {})]);
    res.json({ ok: true, id: r.id });
  } catch (e) {
    if (String(e.message).includes('duplicate key')) return res.status(400).json({ error: 'Der findes allerede et felt med den nøgle for denne entitetstype' });
    throw e;
  }
}));
// Hvor mange gemte værdier ligger der pr. valgmulighed på ét dropdown-felt?
// Bruges af options-editoren i ⚙️ Indstillinger, så Martin kan SE hvor mange
// leads/opportunities der bruger en valgmulighed FØR han sletter den — i stedet
// for at opdage det bagefter. Tæller også værdier der IKKE længere står i
// options-listen (udgåede/forældreløse værdier), så de er synlige.
app.get('/api/crm/custom-fields/:id/option-usage', auth, panelAccessAny(['customers','crmp_leads','crmp_sales','crmp_tasks']), asyncRoute(async (req, res) => {
  const current = await pgOne('SELECT * FROM crm_custom_fields WHERE id=$1', [req.params.id]);
  if (!current) return res.status(404).json({ error: 'Feltet blev ikke fundet' });
  const r = await pool.query(
    'SELECT value, COUNT(*)::int AS n FROM crm_custom_field_values WHERE field_id=$1 AND value IS NOT NULL AND value <> \'\' GROUP BY value',
    [req.params.id]
  );
  const counts = {}; let total = 0;
  r.rows.forEach(row => { counts[row.value] = row.n; total += row.n; });
  const known = new Set((current.options || []).map(String));
  res.json({ ok: true, counts, total, orphaned: Object.keys(counts).filter(v => !known.has(v)) });
}));
// ── OPDATÉR ét custom field ─────────────────────────────────────
// Kroppen er en DELVIS opdatering — kun de nøgler der sendes med ændres.
// Understøttede nøgler:
//   label, field_type, position, show_on_card, option_colors  (som hidtil)
//   options         : string[]        — HELE den nye valgmulighedsliste
//   option_renames  : {gammel:ny}     — omdøbninger der skal SLÅ IGENNEM på
//                                       allerede gemte værdier
//   allow_empty     : bool            — bekræftelse på at tømme options helt
//                                       selvom feltet har gemte værdier
//   sync_twin       : bool            — anvend options/renames på feltet med
//                                       SAMME key på den anden entitetstype
//
// VALG (sep. 2026, Martins ønske "det skal være præcis det samme felt, ikke en
// lignende kopi"): en OMDØBNING propagerer til crm_custom_field_values i SAMME
// transaktion, så et lead der stod på "Maler" står på "Malerarbejde" bagefter —
// og ikke på en værdi der ikke længere findes i dropdownen. En SLETNING af en
// valgmulighed rører derimod IKKE de gemte værdier: historikken skal ikke
// forsvinde bare fordi valgmuligheden ikke længere kan vælges fremadrettet.
// De værdier bliver "udgåede" og vises stadig (markeret) i detaljesidens
// dropdown, så de hverken er usynlige eller bliver overskrevet ved autogem.
app.put('/api/crm/custom-fields/:id', auth, panelAccessAny(['customers','crmp_leads','crmp_sales','crmp_tasks']), asyncRoute(async (req, res) => {
  const b = req.body || {};
  const current = await pgOne('SELECT * FROM crm_custom_fields WHERE id=$1', [req.params.id]);
  if (!current) return res.status(404).json({ error: 'Feltet blev ikke fundet' });

  let newOptions = null;
  if (b.options !== undefined) {
    if (!Array.isArray(b.options)) return res.status(400).json({ error: 'options skal være en liste' });
    newOptions = b.options.map(o => String(o == null ? '' : o).trim());
    if (newOptions.some(o => !o)) return res.status(400).json({ error: 'En valgmulighed må ikke være tom' });
    if (newOptions.some(o => o.length > 200)) return res.status(400).json({ error: 'En valgmulighed må højst være 200 tegn' });
    const seen = new Map();
    for (const o of newOptions) {
      const k = o.toLowerCase();
      if (seen.has(k)) return res.status(400).json({ error: 'Valgmuligheden "' + o + '" står der allerede — dubletter er ikke tilladt' });
      seen.set(k, o);
    }
    const effectiveType = b.field_type !== undefined ? b.field_type : current.field_type;
    if (effectiveType === 'select' && newOptions.length === 0 && !b.allow_empty) {
      const used = await pgOne("SELECT COUNT(*)::int AS n FROM crm_custom_field_values WHERE field_id=$1 AND value IS NOT NULL AND value <> ''", [req.params.id]);
      if (used && used.n > 0) return res.status(400).json({ error: 'Feltet har ' + used.n + ' gemte værdier — bekræft at listen skal tømmes helt', in_use: used.n, needs_confirm: 'allow_empty' });
    }
  }

  const renames = [];
  if (b.option_renames && typeof b.option_renames === 'object') {
    for (const oldName of Object.keys(b.option_renames)) {
      const to = String(b.option_renames[oldName] == null ? '' : b.option_renames[oldName]).trim();
      const from = String(oldName).trim();
      if (!from || !to || from === to) continue;
      renames.push([from, to]);
    }
  }

  // Twin = feltet med samme key på den ANDEN entitetstype (fx projekt_type
  // findes både på lead og opportunity, og et lead der konverteres tager sine
  // værdier med over pr. key). Holdes de to ikke i sync, ender en konverteret
  // opportunity med en værdi dens egen dropdown ikke kender.
  let twin = null;
  if (b.sync_twin) {
    twin = await pgOne('SELECT * FROM crm_custom_fields WHERE key=$1 AND entity_type<>$2 AND field_type=$3 ORDER BY id ASC LIMIT 1',
      [current.key, current.entity_type, current.field_type]);
  }

  // Alle omdøbninger slår igennem i ÉT UPDATE med en CASE-mapping — ikke som en
  // løkke af enkelt-UPDATEs. Ellers ville en "kæde" som {A:B, B:C} køre A→B og
  // BAGEFTER B→C, så de oprindelige A-værdier endte som C.
  const applyRenames = async (client, fieldId) => {
    if (!renames.length) return 0;
    const params = [fieldId];
    const cases = renames.map(([from, to]) => {
      params.push(from, to);
      return 'WHEN $' + (params.length - 1) + ' THEN $' + params.length;
    }).join(' ');
    const froms = renames.map((_, i) => '$' + (2 + i * 2)).join(',');
    const r = await client.query(
      'UPDATE crm_custom_field_values SET value = CASE value ' + cases + ' ELSE value END WHERE field_id=$1 AND value IN (' + froms + ')',
      params
    );
    return r.rowCount || 0;
  };
  // option_colors følger med en omdøbning, så farven ikke "falder af" navnet.
  const migrateColors = (colors) => {
    const out = Object.assign({}, colors && typeof colors === 'object' ? colors : {});
    for (const [from, to] of renames) {
      if (out[from] !== undefined) { out[to] = out[from]; delete out[from]; }
    }
    return out;
  };

  const result = await crmWithTransaction(async (client) => {
    // OBS: pg-driveren serialiserer et JS-array-parameter som en Postgres ARRAY-literal
    // (fx "{a,b}"), IKKE som JSON — så et uændret current.options (allerede parset til et
    // JS-array af pgOne) skal eksplicit JSON.stringify'es igen her, ellers fejler UPDATE'en
    // med "invalid input syntax for type json" så snart kun fx show_on_card sendes med.
    const colors = b.option_colors !== undefined
      ? (b.option_colors && typeof b.option_colors === 'object' ? b.option_colors : {})
      : migrateColors(current.option_colors || {});
    await client.query('UPDATE crm_custom_fields SET label=$1,field_type=$2,options=$3,position=$4,show_on_card=$5,option_colors=$6 WHERE id=$7', [
      b.label !== undefined ? String(b.label).trim() : current.label,
      b.field_type !== undefined ? b.field_type : current.field_type,
      newOptions !== null ? JSON.stringify(newOptions) : JSON.stringify(current.options || []),
      b.position !== undefined ? b.position : current.position,
      b.show_on_card !== undefined ? (b.show_on_card ? 1 : 0) : current.show_on_card,
      JSON.stringify(colors),
      req.params.id
    ]);
    let renamedValues = await applyRenames(client, current.id);
    let twinSynced = null;
    if (twin) {
      await client.query('UPDATE crm_custom_fields SET options=$1,option_colors=$2 WHERE id=$3', [
        newOptions !== null ? JSON.stringify(newOptions) : JSON.stringify(twin.options || []),
        JSON.stringify(b.option_colors !== undefined ? colors : migrateColors(twin.option_colors || {})),
        twin.id
      ]);
      renamedValues += await applyRenames(client, twin.id);
      twinSynced = { id: twin.id, entity_type: twin.entity_type };
    }
    return { renamedValues, twinSynced };
  });

  // Værdier der stadig ligger gemt, men hvis valgmulighed er fjernet fra listen.
  let orphaned = 0;
  if (newOptions !== null) {
    const orph = await pgOne(
      "SELECT COUNT(*)::int AS n FROM crm_custom_field_values WHERE field_id=$1 AND value IS NOT NULL AND value <> '' AND NOT (value = ANY($2::text[]))",
      [req.params.id, newOptions]
    );
    orphaned = (orph && orph.n) || 0;
  }
  res.json({ ok: true, renamed_values: result.renamedValues, orphaned_values: orphaned, twin_synced: result.twinSynced });
}));
app.delete('/api/crm/custom-fields/:id', auth, panelAccessAny(['customers','crmp_leads','crmp_sales','crmp_tasks']), asyncRoute(async (req, res) => {
  await pool.query('DELETE FROM crm_custom_fields WHERE id=$1', [req.params.id]);
  res.json({ ok: true });
}));

// ── LEADS ────────────────────────────────────────────────────────
app.get('/api/crm/leads', auth, panelAccess('crmp_leads'), asyncRoute(async (req, res) => {
  const conds = ['1=1']; const params = [];
  if (req.query.pipeline_id) { params.push(req.query.pipeline_id); conds.push('l.pipeline_id=$' + params.length); }
  if (req.query.stage_id) { params.push(req.query.stage_id); conds.push('l.stage_id=$' + params.length); }
  if (req.query.owner_id) { params.push(req.query.owner_id); conds.push('l.owner_id=$' + params.length); }
  if (req.query.q) { params.push('%' + req.query.q + '%'); conds.push('(l.name ILIKE $' + params.length + ' OR l.email ILIKE $' + params.length + ' OR l.phone ILIKE $' + params.length + ')'); }
  const rows = (await pool.query(`SELECT l.*, u.name AS owner_name, u.color AS owner_color, u.initials AS owner_initials FROM crm_leads l LEFT JOIN users u ON u.id=l.owner_id WHERE ${conds.join(' AND ')} ORDER BY l.position ASC, l.id DESC`, params)).rows;
  const cfValues = await crmGetCustomFieldValuesBulk('lead', rows.map(r => r.id));
  res.json(rows.map(r => ({ ...r, custom_fields: cfValues[r.id] || {} })));
}));
app.post('/api/crm/leads', auth, panelAccess('crmp_leads'), asyncRoute(async (req, res) => {
  const b = req.body || {};
  if (!b.name) return res.status(400).json({ error: 'Navn mangler' });
  let stageId = b.stage_id, pipelineId = b.pipeline_id;
  if (!pipelineId) { const p = await pgOne("SELECT id FROM crm_pipelines WHERE type='lead' ORDER BY position ASC LIMIT 1"); pipelineId = p && p.id; }
  if (!pipelineId) return res.status(400).json({ error: 'Ingen lead-pipeline findes — opret én under CRM-indstillinger' });
  if (!stageId) { const s = await pgOne('SELECT id FROM crm_stages WHERE pipeline_id=$1 ORDER BY position ASC LIMIT 1', [pipelineId]); stageId = s && s.id; }
  const posRow = await pgOne('SELECT COALESCE(MAX(position),-1)+1 AS pos FROM crm_leads WHERE stage_id=$1', [stageId]);
  const leadName = String(b.name).trim();
  const r = await pgOne(`
    INSERT INTO crm_leads (name,email,phone,address,source,note,pipeline_id,stage_id,owner_id,position,stage_changed_at) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,${nowTextSQL()}) RETURNING id
  `, [leadName, b.email || null, b.phone || null, b.address || null, b.source || null, b.note || null, pipelineId, stageId, b.owner_id || req.user.id, posRow.pos]);
  await crmSetCustomFieldValues('lead', r.id, b.custom_fields);
  await crmLogActivity('lead', r.id, 'created', 'Lead oprettet', req.user.id);

  // Lead, Kunde og Sales skal hænge sammen fra dag ét (Martins ønske) — opret/kobl
  // automatisk en rigtig kunde (+ kontakt) med det samme, ikke først ved konvertering.
  // Kører uanset om der er email/telefon (samme som konverterings-routen altid har
  // gjort) — uden kontaktinfo kan den blot ikke dedupliceres mod en eksisterende kunde.
  const linked = await crmFindOrCreateContactAndCustomer(leadName, b.email || null, b.phone || null, b.address || null, b.note || null);
  await pool.query('UPDATE crm_leads SET contact_id=$1 WHERE id=$2', [linked.contactId, r.id]);
  await crmLogActivity('lead', r.id, 'linked', (linked.customerCreated ? 'Ny kunde oprettet automatisk: ' : 'Koblet til eksisterende kunde: ') + leadName, req.user.id);
  // SMS/email-automatik for den stage leadet lander i (fx "Ny") — se
  // crmFireStageAutomation. Kører også for leads oprettet via webhooken
  // (POST /api/integrations/lead-intake/:source), som kalder samme kode.
  crmFireStageAutomation('lead', r.id, stageId, { name: leadName, email: b.email || null, phone: b.phone || null })
    .catch(e => console.error('SMS/email-automatik fejlede for lead #' + r.id + ':', e.message));
  res.json({ ok: true, id: r.id, contact_id: linked.contactId, customer_id: linked.customerId });
}));
app.get('/api/crm/leads/:id', auth, panelAccess('crmp_leads'), asyncRoute(async (req, res) => {
  let lead = await pgOne('SELECT l.*, u.name AS owner_name, c.customer_id AS customer_id FROM crm_leads l LEFT JOIN users u ON u.id=l.owner_id LEFT JOIN crm_contacts c ON c.id=l.contact_id WHERE l.id=$1', [req.params.id]);
  if (!lead) return res.status(404).json({ error: 'Lead ikke fundet' });
  // Selvhelbredende efterudfyldning: leads oprettet FØR kontakt/kunde blev
  // koblet automatisk ved oprettelse (indført senere) mangler contact_id/
  // customer_id — det er derfor 🏠 Kunde-panelet og 📎 Filer-fanen aldrig
  // dukkede op på ældre leads. Kobles nu på, første gang et sådant lead åbnes,
  // med samme find-eller-opret-logik som bruges ved oprettelse/konvertering.
  if (!lead.contact_id) {
    const linked = await crmFindOrCreateContactAndCustomer(lead.name, lead.email, lead.phone, lead.address, lead.note);
    await pool.query('UPDATE crm_leads SET contact_id=$1 WHERE id=$2', [linked.contactId, lead.id]);
    lead = await pgOne('SELECT l.*, u.name AS owner_name, c.customer_id AS customer_id FROM crm_leads l LEFT JOIN users u ON u.id=l.owner_id LEFT JOIN crm_contacts c ON c.id=l.contact_id WHERE l.id=$1', [req.params.id]);
  } else {
    // Selvhelbredende genopretning nr. 2: hvis leadets email/telefon er blevet
    // rettet (fx via "Gem ændringer" på selve leadet) FØR crmPropagateContactFields
    // fandtes (se PUT-routen nedenfor), er den koblede kontakt/kunde stadig den
    // gamle adresse — hvilket er præcis grunden til at Gmail-synk/Filer-fanen ikke
    // fandt noget. Genopretter automatisk, første gang leadet åbnes efter denne rettelse.
    const contact = await pgOne('SELECT email, phone FROM crm_contacts WHERE id=$1', [lead.contact_id]);
    if (contact && (contact.email !== lead.email || contact.phone !== lead.phone)) {
      await crmPropagateContactFields(lead.contact_id, { email: lead.email, phone: lead.phone });
    }
  }
  const customFields = await crmGetCustomFieldDefs('lead');
  const customValues = await crmGetCustomFieldValues('lead', lead.id);
  const activities = (await pool.query('SELECT a.*, u.name AS user_name FROM crm_activities a LEFT JOIN users u ON u.id=a.user_id WHERE a.entity_type=$1 AND a.entity_id=$2 ORDER BY a.created_at DESC, a.id DESC', ['lead', lead.id])).rows;
  res.json({ ...lead, custom_fields: customValues, custom_field_defs: customFields, activities });
}));
app.put('/api/crm/leads/:id', auth, panelAccess('crmp_leads'), asyncRoute(async (req, res) => {
  const b = req.body || {};
  const current = await pgOne('SELECT * FROM crm_leads WHERE id=$1', [req.params.id]);
  if (!current) return res.status(404).json({ error: 'Lead ikke fundet' });
  const stageChanged = b.stage_id !== undefined && Number(b.stage_id) !== current.stage_id;
  await pool.query(`
    UPDATE crm_leads SET name=$1,email=$2,phone=$3,address=$4,source=$5,note=$6,stage_id=$7,pipeline_id=$8,owner_id=$9,position=$10,updated_at=${nowTextSQL()}${stageChanged ? ',stage_changed_at=' + nowTextSQL() : ''} WHERE id=$11
  `, [
    b.name !== undefined ? String(b.name).trim() : current.name,
    b.email !== undefined ? b.email : current.email,
    b.phone !== undefined ? b.phone : current.phone,
    b.address !== undefined ? b.address : current.address,
    b.source !== undefined ? b.source : current.source,
    b.note !== undefined ? b.note : current.note,
    b.stage_id !== undefined ? b.stage_id : current.stage_id,
    b.pipeline_id !== undefined ? b.pipeline_id : current.pipeline_id,
    b.owner_id !== undefined ? b.owner_id : current.owner_id,
    b.position !== undefined ? b.position : current.position,
    req.params.id
  ]);
  // Se crmPropagateContactFields ovenfor — holder den koblede kunde (customers)
  // opdateret, så bl.a. Gmail-synk/Filer-fanen ikke bliver ved med at kigge
  // efter en forældet email efter en redigering her.
  if (current.contact_id && (b.name !== undefined || b.email !== undefined || b.phone !== undefined || b.address !== undefined)) {
    await crmPropagateContactFields(current.contact_id, {
      name: b.name !== undefined ? String(b.name).trim() : undefined,
      email: b.email !== undefined ? b.email : undefined,
      phone: b.phone !== undefined ? b.phone : undefined,
      address: b.address !== undefined ? b.address : undefined
    });
  }
  if (b.custom_fields) await crmSetCustomFieldValues('lead', req.params.id, b.custom_fields);
  if (stageChanged) {
    const newStage = await pgOne('SELECT name FROM crm_stages WHERE id=$1', [b.stage_id]);
    await crmLogActivity('lead', req.params.id, 'stage_change', 'Status ændret til "' + (newStage ? newStage.name : '?') + '"', req.user.id);
    crmFireStageAutomation('lead', req.params.id, b.stage_id, {
      name: b.name !== undefined ? String(b.name).trim() : current.name,
      email: b.email !== undefined ? b.email : current.email,
      phone: b.phone !== undefined ? b.phone : current.phone
    }).catch(e => console.error('SMS/email-automatik fejlede for lead #' + req.params.id + ':', e.message));
  }
  res.json({ ok: true });
}));
app.delete('/api/crm/leads/:id', auth, panelAccess('crmp_leads'), asyncRoute(async (req, res) => {
  // Se crmDeleteEntityCascade — rydder også custom field-værdier, aktiviteter
  // og opgaver op, hvilket denne rute IKKE gjorde tidligere.
  const deleted = await crmWithTransaction(client => crmDeleteEntityCascade(client, 'lead', req.params.id));
  res.json({ ok: true, deleted });
}));
// Masse-handlinger på flere leads ad gangen — se crmBulkAction ovenfor.
app.post('/api/crm/leads/bulk', auth, panelAccess('crmp_leads'), asyncRoute((req, res) => crmBulkAction('lead', req, res)));
app.post('/api/crm/leads/:id/notes', auth, panelAccess('crmp_leads'), asyncRoute(async (req, res) => {
  const b = req.body || {};
  if (!b.body) return res.status(400).json({ error: 'Note mangler' });
  await crmLogActivity('lead', req.params.id, 'note', String(b.body), req.user.id);
  res.json({ ok: true });
}));
// Konverterer et lead til en kontakt + en opportunity i Sales-pipelinen —
// og opretter/kæder samtidig en rigtig kunde i Kunder-modulet (customers),
// så Tilbud/Faktura/Projekter fungerer med det samme uden ekstra trin.
app.post('/api/crm/leads/:id/convert', auth, panelAccess('crmp_leads'), asyncRoute(async (req, res) => {
  const b = req.body || {};
  const lead = await pgOne('SELECT * FROM crm_leads WHERE id=$1', [req.params.id]);
  if (!lead) return res.status(404).json({ error: 'Lead ikke fundet' });
  if (lead.converted_opportunity_id) return res.status(400).json({ error: 'Leadet er allerede konverteret' });

  let targetPipelineId = b.pipeline_id;
  if (!targetPipelineId) { const p = await pgOne("SELECT id FROM crm_pipelines WHERE type='opportunity' ORDER BY position ASC LIMIT 1"); targetPipelineId = p && p.id; }
  if (!targetPipelineId) return res.status(400).json({ error: 'Ingen salgs-pipeline findes — opret én under CRM-indstillinger' });
  let targetStageId = b.stage_id;
  if (!targetStageId) { const s = await pgOne('SELECT id FROM crm_stages WHERE pipeline_id=$1 ORDER BY position ASC LIMIT 1', [targetPipelineId]); targetStageId = s && s.id; }

  // Kontakt + kunde: leadet har normalt allerede begge dele koblet fra
  // OPRETTELSEN (se POST /api/crm/leads), så her genbruges bare det —
  // faldbacker til samme find-eller-opret-logik for ældre leads fra før
  // den funktion fandtes.
  let contactId, customerId;
  if (lead.contact_id) {
    const existingContact = await pgOne('SELECT * FROM crm_contacts WHERE id=$1', [lead.contact_id]);
    if (existingContact) { contactId = existingContact.id; customerId = existingContact.customer_id || null; }
  }
  if (!contactId || !customerId) {
    const linked = await crmFindOrCreateContactAndCustomer(lead.name, lead.email, lead.phone, lead.address, lead.note);
    contactId = linked.contactId; customerId = linked.customerId;
  }
  await pool.query('UPDATE crm_contacts SET customer_id=$1 WHERE id=$2', [customerId, contactId]);

  const posRow = await pgOne('SELECT COALESCE(MAX(position),-1)+1 AS pos FROM crm_opportunities WHERE stage_id=$1', [targetStageId]);
  // note kopieres med over i SAMME kolonne-type (crm_opportunities.note findes
  // allerede, se skema-migreringen ovenfor) — ellers forsvandt lead-notens
  // fritekst sporløst ved konvertering. Se den lange kommentar ved
  // crmCopyActivitiesToOpportunity nedenfor for resten af data-overførslen.
  const opp = await pgOne(`
    INSERT INTO crm_opportunities (name,contact_id,pipeline_id,stage_id,owner_id,source_lead_id,note,position,stage_changed_at) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,${nowTextSQL()}) RETURNING id
  `, [lead.name, contactId, targetPipelineId, targetStageId, lead.owner_id, lead.id, lead.note || null, posRow.pos]);

  // Kopiér custom fields der findes på BEGGE entitetstyper (samme key) med over,
  // så data ikke går tabt ved konvertering.
  const leadValues = await crmGetCustomFieldValues('lead', lead.id);
  await crmSetCustomFieldValues('opportunity', opp.id, leadValues);

  // Hele leadets aktivitets-historik (noter, stage-skift, "lead oprettet" osv.)
  // kopieres over på den nye opportunity — se crmCopyActivitiesToOpportunity.
  const copiedActivities = await crmCopyActivitiesToOpportunity(lead.id, opp.id);

  const convertedStage = await pgOne("SELECT id FROM crm_stages WHERE pipeline_id=$1 AND is_won=1 ORDER BY position ASC LIMIT 1", [lead.pipeline_id]);
  await pool.query('UPDATE crm_leads SET converted_opportunity_id=$1, stage_id=COALESCE($2,stage_id), contact_id=$3 WHERE id=$4', [opp.id, convertedStage ? convertedStage.id : null, contactId, lead.id]);
  await crmLogActivity('lead', lead.id, 'converted', 'Konverteret til opportunity #' + opp.id, req.user.id);
  await crmLogActivity('opportunity', opp.id, 'created', 'Oprettet fra lead #' + lead.id, req.user.id);
  crmFireStageAutomation('opportunity', opp.id, targetStageId, { name: lead.name, email: lead.email, phone: lead.phone })
    .catch(e => console.error('SMS/email-automatik fejlede for opportunity #' + opp.id + ':', e.message));

  res.json({ ok: true, contact_id: contactId, customer_id: customerId, opportunity_id: opp.id, copied_activities: copiedActivities });
}));

// Kopierer HELE leadets aktivitets-tidslinje over på den nye opportunity ved
// konvertering (Martins ord: "INTET DATA fra lead-konverteringen til Sales-
// pipelinen må forsvinde"). Før dette blev aktiviteterne stående stemplet med
// entity_type='lead'/entity_id=<gammelt lead-id>, mens opportunityens eget
// Aktivitet-panel kun spørger på entity_type='opportunity' — så alle noter
// Martin selv havde skrevet så tomme ud efter konvertering, selvom rækkerne
// stadig lå i databasen under et lead der straks efter forsvinder ned i den
// sammenklappede "Konverteret"-kolonne.
//
// TRE BEVIDSTE VALG:
//  1) ADDITIV kopi, ikke flytning: lead-rækkerne bliver stående uændret, så
//     BEGGE poster har deres egen fulde historie (leadet skal stadig kunne
//     læses som det, der rent faktisk skete på leadet).
//  2) body kopieres 100% ORDRET for noter (kind='note') — det er tekst et
//     menneske har skrevet, og den må ikke omskrives. De øvrige, maskin-
//     genererede loglinjer får præfikset "Fra lead: ", så den flettede
//     tidslinje kan læses uden at man tror at fx 'Status ændret til
//     "Kontaktet"' handlede om en SALGS-stage.
//  3) kind NORMALISERES for alt andet end noter til 'lead_history'. Det er
//     ikke kosmetik: flere steder i serveren bruges (entity_type, entity_id,
//     kind) som "er dette allerede sket?"-nøgle — crmFireStageAutomation
//     ('sms_sent_stage<ID>'/'email_sent_stage<ID>') og runLostFollowupScan
//     ('lost_followup_sent'). Kopierede vi de kinds ordret over, ville den nye
//     opportunity kunne arve et "allerede sendt"-flag fra leadet og dermed
//     ALDRIG få sin egen opfølgnings-SMS/mail. Noter er derimod bevidst
//     bevaret som kind='note', så de kan rettes/slettes på opportunityen med
//     de samme ✎/🗑-knapper som alle andre noter (PUT/DELETE
//     /api/crm/activities/:id kræver netop kind='note'). En rettelse i kopien
//     ændrer ikke originalen på leadet — de to poster er uafhængige, jf. (1).
// created_at/user_id/updated_at bevares, så den flettede tidslinje står i
// rigtig kronologisk rækkefølge sammen med opportunityens egne linjer.
async function crmCopyActivitiesToOpportunity(leadId, oppId, exec) {
  const r = await (exec || pool).query(`
    INSERT INTO crm_activities (entity_type, entity_id, kind, body, user_id, created_at, updated_at)
    SELECT 'opportunity', $2,
           CASE WHEN kind='note' THEN 'note' ELSE 'lead_history' END,
           CASE WHEN kind='note' THEN body ELSE 'Fra lead: ' || COALESCE(body,'') END,
           user_id, created_at, updated_at
    FROM crm_activities
    WHERE entity_type='lead' AND entity_id=$1
    ORDER BY created_at ASC, id ASC
  `, [leadId, oppId]);
  return r.rowCount || 0;
}

// ── OPPORTUNITIES ────────────────────────────────────────────────
// Kontaktens egne felter (navn/telefon/email/adresse) redigeres fra
// opportunity-detaljesiden, siden en opportunity ikke selv ejer de felter —
// de bor på crm_contacts (kan være delt af flere opportunities for samme person).
app.put('/api/crm/contacts/:id', auth, panelAccess('customers'), asyncRoute(async (req, res) => {
  const b = req.body || {};
  const current = await pgOne('SELECT * FROM crm_contacts WHERE id=$1', [req.params.id]);
  if (!current) return res.status(404).json({ error: 'Kontakt ikke fundet' });
  await pool.query(`UPDATE crm_contacts SET name=$1,phone=$2,email=$3,address=$4,updated_at=${nowTextSQL()} WHERE id=$5`, [
    b.name !== undefined ? String(b.name).trim() : current.name,
    b.phone !== undefined ? b.phone : current.phone,
    b.email !== undefined ? b.email : current.email,
    b.address !== undefined ? b.address : current.address,
    req.params.id
  ]);
  // Se crmPropagateContactFields — holder den koblede kunde (customers) opdateret
  // ved samme lejlighed (samme grund som ved PUT /api/crm/leads/:id ovenfor).
  if (current.customer_id && (b.name !== undefined || b.email !== undefined || b.phone !== undefined || b.address !== undefined)) {
    await crmPropagateContactFields(req.params.id, {
      name: b.name !== undefined ? String(b.name).trim() : undefined,
      email: b.email !== undefined ? b.email : undefined,
      phone: b.phone !== undefined ? b.phone : undefined,
      address: b.address !== undefined ? b.address : undefined
    });
  }
  res.json({ ok: true });
}));
app.get('/api/crm/opportunities', auth, panelAccess('crmp_sales'), asyncRoute(async (req, res) => {
  const conds = ['1=1']; const params = [];
  if (req.query.pipeline_id) { params.push(req.query.pipeline_id); conds.push('o.pipeline_id=$' + params.length); }
  if (req.query.stage_id) { params.push(req.query.stage_id); conds.push('o.stage_id=$' + params.length); }
  if (req.query.owner_id) { params.push(req.query.owner_id); conds.push('o.owner_id=$' + params.length); }
  if (req.query.q) { params.push('%' + req.query.q + '%'); conds.push('(o.name ILIKE $' + params.length + ' OR c.name ILIKE $' + params.length + ' OR c.phone ILIKE $' + params.length + ' OR c.email ILIKE $' + params.length + ')'); }
  const rows = (await pool.query(`
    SELECT o.*, u.name AS owner_name, u.color AS owner_color, u.initials AS owner_initials,
      c.name AS contact_name, c.phone AS contact_phone, c.email AS contact_email, c.customer_id AS customer_id
    FROM crm_opportunities o
    LEFT JOIN users u ON u.id=o.owner_id
    LEFT JOIN crm_contacts c ON c.id=o.contact_id
    WHERE ${conds.join(' AND ')} ORDER BY o.position ASC, o.id DESC
  `, params)).rows;
  const cfValues = await crmGetCustomFieldValuesBulk('opportunity', rows.map(r => r.id));
  res.json(rows.map(r => ({ ...r, custom_fields: cfValues[r.id] || {} })));
}));
app.post('/api/crm/opportunities', auth, panelAccess('crmp_sales'), asyncRoute(async (req, res) => {
  const b = req.body || {};
  if (!b.name) return res.status(400).json({ error: 'Navn mangler' });
  let pipelineId = b.pipeline_id;
  if (!pipelineId) { const p = await pgOne("SELECT id FROM crm_pipelines WHERE type='opportunity' ORDER BY position ASC LIMIT 1"); pipelineId = p && p.id; }
  if (!pipelineId) return res.status(400).json({ error: 'Ingen salgs-pipeline findes' });
  let stageId = b.stage_id;
  if (!stageId) { const s = await pgOne('SELECT id FROM crm_stages WHERE pipeline_id=$1 ORDER BY position ASC LIMIT 1', [pipelineId]); stageId = s && s.id; }
  // Bruger samme find-eller-opret-logik som ved lead-oprettelse (og konvertering),
  // så en direkte-oprettet sale (uden om et lead) også får en rigtig kunde
  // koblet med det samme — ellers dukkede 🏠 Kunde-panelet og 📎 Filer-fanen
  // aldrig op på den slags sales.
  let contactId = b.contact_id || null;
  if (!contactId && (b.contact_name || b.contact_phone || b.contact_email)) {
    const linked = await crmFindOrCreateContactAndCustomer(b.contact_name || b.name, b.contact_email || null, b.contact_phone || null, null, null);
    contactId = linked.contactId;
  }
  const posRow = await pgOne('SELECT COALESCE(MAX(position),-1)+1 AS pos FROM crm_opportunities WHERE stage_id=$1', [stageId]);
  const r = await pgOne(`
    INSERT INTO crm_opportunities (name,contact_id,pipeline_id,stage_id,value,probability,owner_id,position,stage_changed_at) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,${nowTextSQL()}) RETURNING id
  `, [String(b.name).trim(), contactId, pipelineId, stageId, b.value || null, b.probability || null, b.owner_id || req.user.id, posRow.pos]);
  await crmSetCustomFieldValues('opportunity', r.id, b.custom_fields);
  await crmLogActivity('opportunity', r.id, 'created', 'Opportunity oprettet', req.user.id);
  crmFireStageAutomation('opportunity', r.id, stageId, { name: b.contact_name || b.name, email: b.contact_email || null, phone: b.contact_phone || null })
    .catch(e => console.error('SMS/email-automatik fejlede for opportunity #' + r.id + ':', e.message));
  res.json({ ok: true, id: r.id });
}));
app.get('/api/crm/opportunities/:id', auth, panelAccess('crmp_sales'), asyncRoute(async (req, res) => {
  const oppQuery = `
    SELECT o.*, c.name AS contact_name, c.phone AS contact_phone, c.email AS contact_email, c.address AS contact_address, c.customer_id AS customer_id
    FROM crm_opportunities o LEFT JOIN crm_contacts c ON c.id=o.contact_id WHERE o.id=$1
  `;
  let opp = await pgOne(oppQuery, [req.params.id]);
  if (!opp) return res.status(404).json({ error: 'Opportunity ikke fundet' });
  // Selvhelbredende efterudfyldning — samme grund som ved leads: en sale kan
  // mangle kunde-koblingen enten fordi den er oprettet direkte uden om et lead
  // (før find-eller-opret-rettelsen ovenfor i POST-routen), eller fordi den slet
  // ingen kontakt har. Koble til/opret nu, første gang salget åbnes.
  if (!opp.customer_id) {
    const linked = await crmFindOrCreateContactAndCustomer(
      opp.contact_name || opp.name, opp.contact_email || null, opp.contact_phone || null, opp.contact_address || null, null
    );
    if (opp.contact_id) await pool.query('UPDATE crm_contacts SET customer_id=$1 WHERE id=$2', [linked.customerId, opp.contact_id]);
    else await pool.query('UPDATE crm_opportunities SET contact_id=$1 WHERE id=$2', [linked.contactId, opp.id]);
    opp = await pgOne(oppQuery, [req.params.id]);
  }
  const customFields = await crmGetCustomFieldDefs('opportunity');
  const customValues = await crmGetCustomFieldValues('opportunity', opp.id);
  const activities = (await pool.query('SELECT a.*, u.name AS user_name FROM crm_activities a LEFT JOIN users u ON u.id=a.user_id WHERE a.entity_type=$1 AND a.entity_id=$2 ORDER BY a.created_at DESC, a.id DESC', ['opportunity', opp.id])).rows;
  res.json({ ...opp, custom_fields: customValues, custom_field_defs: customFields, activities });
}));
app.put('/api/crm/opportunities/:id', auth, panelAccess('crmp_sales'), asyncRoute(async (req, res) => {
  const b = req.body || {};
  const current = await pgOne('SELECT * FROM crm_opportunities WHERE id=$1', [req.params.id]);
  if (!current) return res.status(404).json({ error: 'Opportunity ikke fundet' });
  const stageChanged = b.stage_id !== undefined && Number(b.stage_id) !== current.stage_id;
  await pool.query(`
    UPDATE crm_opportunities SET name=$1,value=$2,probability=$3,stage_id=$4,pipeline_id=$5,owner_id=$6,position=$7,note=$8,updated_at=${nowTextSQL()}${stageChanged ? ',stage_changed_at=' + nowTextSQL() : ''} WHERE id=$9
  `, [
    b.name !== undefined ? String(b.name).trim() : current.name,
    b.value !== undefined ? b.value : current.value,
    b.probability !== undefined ? b.probability : current.probability,
    b.stage_id !== undefined ? b.stage_id : current.stage_id,
    b.pipeline_id !== undefined ? b.pipeline_id : current.pipeline_id,
    b.owner_id !== undefined ? b.owner_id : current.owner_id,
    b.position !== undefined ? b.position : current.position,
    // Note-feltet er nu redigerbart på opportunities i UI'et (samme 📝 Note-felt
    // som på leads) — før kunne kolonnen kun fyldes af Close-importen og af
    // lead-konverteringen, og der var ingen vej til at rette den bagefter.
    b.note !== undefined ? b.note : current.note,
    req.params.id
  ]);
  if (b.custom_fields) await crmSetCustomFieldValues('opportunity', req.params.id, b.custom_fields);
  if (stageChanged) {
    const newStage = await pgOne('SELECT name FROM crm_stages WHERE id=$1', [b.stage_id]);
    await crmLogActivity('opportunity', req.params.id, 'stage_change', 'Status ændret til "' + (newStage ? newStage.name : '?') + '"', req.user.id);
    // Opportunities ejer ikke selv email/telefon (bor på crm_contacts) — slå
    // kontakten op til SMS/email-automatikken.
    const oppContact = current.contact_id ? await pgOne('SELECT name, email, phone FROM crm_contacts WHERE id=$1', [current.contact_id]) : null;
    crmFireStageAutomation('opportunity', req.params.id, b.stage_id, {
      name: (oppContact && oppContact.name) || (b.name !== undefined ? String(b.name).trim() : current.name),
      email: oppContact && oppContact.email,
      phone: oppContact && oppContact.phone
    }).catch(e => console.error('SMS/email-automatik fejlede for opportunity #' + req.params.id + ':', e.message));
  }
  res.json({ ok: true });
}));
app.delete('/api/crm/opportunities/:id', auth, panelAccess('crmp_sales'), asyncRoute(async (req, res) => {
  // Se crmDeleteEntityCascade — rydder også custom field-værdier, aktiviteter
  // og opgaver op, og nulstiller kilde-leadets converted_opportunity_id.
  const deleted = await crmWithTransaction(client => crmDeleteEntityCascade(client, 'opportunity', req.params.id));
  res.json({ ok: true, deleted });
}));
// Masse-handlinger på flere opportunities ad gangen — se crmBulkAction ovenfor.
app.post('/api/crm/opportunities/bulk', auth, panelAccess('crmp_sales'), asyncRoute((req, res) => crmBulkAction('opportunity', req, res)));
app.post('/api/crm/opportunities/:id/notes', auth, panelAccess('crmp_sales'), asyncRoute(async (req, res) => {
  const b = req.body || {};
  if (!b.body) return res.status(400).json({ error: 'Note mangler' });
  await crmLogActivity('opportunity', req.params.id, 'note', String(b.body), req.user.id);
  res.json({ ok: true });
}));

// ── REDIGÉR / SLET ÉN NOTE I AKTIVITETS-TIDSLINJEN ───────────────
// Martins ønske (sep. 2026): man skal kunne rette en tastefejl i en note eller
// slette den igen — men KUN noter. Resten af tidslinjen (stage_change, created,
// converted, sms_sent/email_sent m.fl.) er et faktuelt log over hvad der rent
// faktisk er sket, og må hverken kunne rettes eller slettes; ellers kan man ikke
// stole på den. Derfor håndhæves kind='note' HER på serveren — ikke kun ved at
// undlade knapperne i UI'et — så et håndlavet kald mod et stage-skifte afvises.
//
// Adgang: aktiviteten hører til ENTEN et lead ELLER en opportunity, så den
// sædvanlige panelAccess('crmp_leads')/panelAccess('crmp_sales') kan ikke vælges
// på forhånd som middleware. I stedet slås rækken op først, og så tjekkes præcis
// den side rækken hører til — med nøjagtig samme regler som panelAccess bruger.
const CRM_ACTIVITY_PANEL_BY_ENTITY = { lead: 'crmp_leads', opportunity: 'crmp_sales' };
async function crmLoadEditableActivity(req, res) {
  const row = await pgOne('SELECT * FROM crm_activities WHERE id=$1', [req.params.id]);
  if (!row) { res.status(404).json({ error: 'Aktivitet ikke fundet' }); return null; }
  const panelKey = CRM_ACTIVITY_PANEL_BY_ENTITY[row.entity_type];
  if (!panelKey) { res.status(403).json({ error: 'Ingen adgang' }); return null; }
  const u = await pgOne('SELECT id, role, active, is_finance_admin, panel_role_id FROM users WHERE id=$1', [req.user.id]);
  if (!u || !u.active) { res.status(403).json({ error: 'Ingen adgang' }); return null; }
  if (u.role !== 'admin') {
    const pages = await computeUserPanelPages(u);
    if (!pages.includes(panelKey)) { res.status(403).json({ error: 'Ingen adgang til denne side' }); return null; }
  }
  if (row.kind !== 'note') { res.status(400).json({ error: 'Kun noter kan redigeres eller slettes — resten af tidslinjen er et fast log' }); return null; }
  return row;
}
app.put('/api/crm/activities/:id', auth, asyncRoute(async (req, res) => {
  const row = await crmLoadEditableActivity(req, res);
  if (!row) return;
  const b = req.body || {};
  if (!b.body || !String(b.body).trim()) return res.status(400).json({ error: 'Note mangler' });
  await pool.query(`UPDATE crm_activities SET body=$1, updated_at=${nowTextSQL()} WHERE id=$2`, [String(b.body).trim(), row.id]);
  res.json({ ok: true });
}));
app.delete('/api/crm/activities/:id', auth, asyncRoute(async (req, res) => {
  const row = await crmLoadEditableActivity(req, res);
  if (!row) return;
  await pool.query('DELETE FROM crm_activities WHERE id=$1', [row.id]);
  res.json({ ok: true });
}));

// Opportunities knyttet til en given kunde i Kunder-modulet — bruges af
// kundekortet til at vise "tilknyttede opportunities" (se customer-detail).
app.get('/api/crm/customers/:id/opportunities', auth, panelAccess('customers'), asyncRoute(async (req, res) => {
  const rows = (await pool.query(`
    SELECT o.*, s.name AS stage_name, s.color AS stage_color, p.name AS pipeline_name
    FROM crm_opportunities o
    JOIN crm_contacts c ON c.id=o.contact_id
    JOIN crm_stages s ON s.id=o.stage_id
    JOIN crm_pipelines p ON p.id=o.pipeline_id
    WHERE c.customer_id=$1 ORDER BY o.created_at DESC
  `, [req.params.id])).rows;
  res.json(rows);
}));
// "+ Ny handel" direkte på en eksisterende kunde (Martins ønske: "hvis jeg er
// under en gammel kunde kan jeg ved ét klik oprette en ny handel").
//
// Hvorfor en EGEN route i stedet for bare at kalde POST /api/crm/opportunities
// med et contact_id fra frontenden: en kunde ejer 0..n crm_contacts-rækker, og
// kundesiden kender kun customer_id. Skulle frontenden selv finde kontakten,
// ville den enten skulle hente en kontaktliste først (ekstra kald + risiko for
// at vælge den forkerte) eller sende kontaktoplysninger som tekst og dermed
// kunne oprette en DUBLET-kunde via crmFindOrCreateContactAndCustomer. Her
// slås kontakten i stedet op ud fra selve kunde-koblingen, og findes der ingen,
// oprettes én ud fra kundens egne navn/telefon/email/adresse og kobles til
// kunden med det samme — samme find-eller-opret-idé som
// crmFindOrCreateContactAndCustomer, blot med customer_id som udgangspunkt i
// stedet for telefon/email, så vi ALDRIG kan ende på en anden kunde.
app.post('/api/crm/customers/:id/opportunities', auth, panelAccessAny(['customers', 'crmp_sales']), asyncRoute(async (req, res) => {
  const b = req.body || {};
  const customer = await pgOne('SELECT * FROM customers WHERE id=$1', [req.params.id]);
  if (!customer) return res.status(404).json({ error: 'Kunde ikke fundet' });

  let pipelineId = b.pipeline_id;
  if (!pipelineId) { const p = await pgOne("SELECT id FROM crm_pipelines WHERE type='opportunity' ORDER BY position ASC LIMIT 1"); pipelineId = p && p.id; }
  if (!pipelineId) return res.status(400).json({ error: 'Ingen salgs-pipeline findes — opret én under CRM-indstillinger' });
  let stageId = b.stage_id;
  if (!stageId) { const s = await pgOne('SELECT id FROM crm_stages WHERE pipeline_id=$1 ORDER BY position ASC LIMIT 1', [pipelineId]); stageId = s && s.id; }
  // Stagen SKAL høre til den valgte pipeline — ellers ville et forældet stage_id
  // fra en anden pipeline (fx hvis dropdownen ikke nåede at blive fyldt om)
  // lande handlen i et helt andet board.
  const stage = stageId ? await pgOne('SELECT id FROM crm_stages WHERE id=$1 AND pipeline_id=$2', [stageId, pipelineId]) : null;
  if (!stage) { const s = await pgOne('SELECT id FROM crm_stages WHERE pipeline_id=$1 ORDER BY position ASC LIMIT 1', [pipelineId]); stageId = s && s.id; }
  if (!stageId) return res.status(400).json({ error: 'Salgs-pipelinen har ingen stages' });

  // Kontakt: genbrug kundens egen kontakt hvis der er én (foretræk den der
  // matcher kundens telefon/email, ellers bare den ældste), ellers opret.
  // (phone=$2 med $2=NULL giver NULL og matcher derfor ingenting — derfor
  // behøver de to første opslag ikke en ekstra "har kunden overhovedet et
  // telefonnummer/en email?"-test.)
  let contact = await pgOne('SELECT * FROM crm_contacts WHERE customer_id=$1 AND phone=$2 ORDER BY id ASC LIMIT 1', [customer.id, customer.phone || null]);
  if (!contact) contact = await pgOne('SELECT * FROM crm_contacts WHERE customer_id=$1 AND email=$2 ORDER BY id ASC LIMIT 1', [customer.id, customer.email || null]);
  if (!contact) contact = await pgOne('SELECT * FROM crm_contacts WHERE customer_id=$1 ORDER BY id ASC LIMIT 1', [customer.id]);
  if (!contact) {
    contact = await pgOne('INSERT INTO crm_contacts (name,email,phone,address,customer_id) VALUES ($1,$2,$3,$4,$5) RETURNING *', [
      customer.name, customer.email || null, customer.phone || null, customer.address || null, customer.id
    ]);
  }

  const name = (b.name !== undefined && String(b.name).trim()) ? String(b.name).trim() : customer.name;
  const posRow = await pgOne('SELECT COALESCE(MAX(position),-1)+1 AS pos FROM crm_opportunities WHERE stage_id=$1', [stageId]);
  const r = await pgOne(`
    INSERT INTO crm_opportunities (name,contact_id,pipeline_id,stage_id,value,probability,owner_id,position,stage_changed_at) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,${nowTextSQL()}) RETURNING id
  `, [name, contact.id, pipelineId, stageId, b.value || null, b.probability || null, b.owner_id || req.user.id, posRow.pos]);
  await crmSetCustomFieldValues('opportunity', r.id, b.custom_fields);
  await crmLogActivity('opportunity', r.id, 'created', 'Ny handel oprettet på kunden "' + customer.name + '"', req.user.id);
  crmFireStageAutomation('opportunity', r.id, stageId, { name: contact.name || customer.name, email: contact.email, phone: contact.phone })
    .catch(e => console.error('SMS/email-automatik fejlede for opportunity #' + r.id + ':', e.message));
  res.json({ ok: true, id: r.id, contact_id: contact.id, customer_id: customer.id, pipeline_id: pipelineId, stage_id: stageId });
}));

// ══════════════════════════════════════════════════════════════
// CLOSE CRM — HISTORISK IMPORT (sep. 2026, éngangsopgave for Martin, men
// bevidst bygget til at kunne genkøres trygt — se close_id-idempotens
// nedenfor). Importerer Martins fulde salgshistorik fra Close CRM
// (leads.csv + opportunities.csv, eksporteret direkte fra Close) ind i det
// indbyggede CRM ovenfor, ÉN gang, via en rigtig admin-knap i UI'et — ikke et
// engangsscript. Se POST /api/admin/import/close.
//
// TO STRUKTURELLE BESLUTNINGER (taget af Martin på forhånd, IKKE genvurderet her):
//   1) En Close-opportunity med status_type='won' bliver en RIGTIG kunde i
//      Kunder-modulet (customers), ikke kun en CRM-registrering.
//   2) Et lead der allerede blev til en Close-opportunity vises i Gulvmaster
//      KUN som opportunity'en — ALDRIG også som et separat "konverteret"
//      lead-kort. Kun leads der ALDRIG blev til en opportunity importeres
//      som lead-kort (se "rene leads"-udregningen nedenfor).
//
// EN TREDJE BESLUTNING, taget som en bevidst, begrundet udvidelse af
// appens EGEN etablerede konvention (dokumenteret ved crm_leads.contact_id
// ovenfor: "crmFindOrCreateContactAndCustomer() kaldt fra POST
// /api/crm/leads" — ALTID, for ethvert nyt lead, ikke kun ved konvertering):
//   3) crmFindOrCreateContactAndCustomer() køres for BÅDE alle importerede
//      leads OG alle importerede opportunities — ikke kun de 45 "Won". Det er
//      samme dedup-logik (telefon først, så email) som resten af appen
//      allerede bruger overalt. Flages eksplicit til Martin: dette betyder at
//      importen opretter langt flere Kunder-rækker end kun de vundne sager.
//
// BEVIDST UDELADT ift. den normale enkelt-række-oprettelse (POST
// /api/crm/leads / /api/crm/opportunities):
//   - crmLogActivity() kaldes IKKE pr. importeret række — en tidslinje-note
//     på hver af op til ~2790 historiske rækker ville bare være støj.
//   - crmFireStageAutomation() kaldes IKKE — og stage_changed_at sættes
//     bevidst til NULL for hver importeret række (se INSERT'erne nedenfor),
//     I STEDET FOR Close's oprindelige dato. Dette er en SIKKERHEDS-
//     beslutning, ikke en smagssag: appen har en daglig baggrundsscanning
//     (runStageFollowupScan, cron kl. 10:45) der sender AUTOMATISK SMS/mail
//     til alt der har ligget X dage i en stage med en tidsbaseret
//     opfølgningsregel — "Tilbud Afgivet" har allerede sådan en regel
//     (7/14/30 dage) fra appens standardopsætning. 1406 af de 1729
//     opportunities lander netop i "Tilbud Afgivet". Havde vi sat
//     stage_changed_at til Close's ÅRGAMLE dato, ville NÆSTE cron-kørsel
//     omgående sende en "har du set vores tilbud?"-SMS/mail til op til 1406
//     rigtige, historiske kontakter — hvoraf mange forlængst er afsluttede,
//     tabte eller har handlet et andet sted. Samme risiko gælder
//     runLostFollowupScan for "Tabt". Med stage_changed_at=NULL springer
//     begge scanninger (som kræver "stage_changed_at IS NOT NULL")
//     importerede rækker helt over, permanent — indtil Martin selv trækker
//     et kort til en ny stage, hvorved det almindelige ur starter forfra som
//     normalt. Flages eksplicit — se leveringsnoten.
//   - owner_id sættes ikke (Close's created_by/user_name mappes ikke til en
//     Gulvmaster-bruger).
//
// created_at/updated_at SÆTTES derimod til Close's egne date_created/
// date_updated (konverteret, se closeToDbTimestamp) — det er ren historik/
// visning uden automatik-konsekvenser, og bevarer hvornår tingene faktisk
// skete i Close.
// ══════════════════════════════════════════════════════════════

// RFC4180-kompatibel CSV-parser uden ekstern afhængighed (der findes ingen
// csv-pakke i package.json — se README/leveringsnote). Strips BOM, håndterer
// felter i "citationstegn" med indlejrede kommaer/linjeskift og fordoblet
// anførselstegn ("" -> ") som escape, UTF-8 (danske tegn). Valideret række-for-
// række og kolonne-for-kolonne mod Pythons indbyggede csv-modul (ground truth)
// på de RIGTIGE Close-eksportfiler (2750/1729/2480 rækker) før den blev taget i
// brug her — se leveringsnoten for detaljer om valideringen.
function closeParseCsv(buffer) {
  let text = buffer.toString('utf8');
  if (text.charCodeAt(0) === 0xFEFF) text = text.slice(1); // strip BOM
  const records = [];
  let field = '';
  let record = [];
  let inQuotes = false;
  const len = text.length;
  let i = 0;
  const pushField = () => { record.push(field); field = ''; };
  const pushRecord = () => { pushField(); records.push(record); record = []; };
  while (i < len) {
    const ch = text[i];
    if (inQuotes) {
      if (ch === '"') {
        if (text[i + 1] === '"') { field += '"'; i += 2; continue; }
        inQuotes = false; i++; continue;
      }
      field += ch; i++; continue;
    }
    if (ch === '"') { inQuotes = true; i++; continue; }
    if (ch === ',') { pushField(); i++; continue; }
    if (ch === '\r') {
      if (text[i + 1] === '\n') { pushRecord(); i += 2; continue; }
      pushRecord(); i++; continue;
    }
    if (ch === '\n') { pushRecord(); i++; continue; }
    field += ch; i++;
  }
  if (field.length > 0 || record.length > 0) pushRecord();
  while (records.length && records[records.length - 1].length === 1 && records[records.length - 1][0] === '') records.pop();
  if (!records.length) return [];
  const headers = records[0];
  const rows = [];
  for (let r = 1; r < records.length; r++) {
    const rec = records[r];
    const obj = {};
    for (let c = 0; c < headers.length; c++) obj[headers[c]] = rec[c] !== undefined ? rec[c] : '';
    rows.push(obj);
  }
  return rows;
}

// Close eksporterer altid UTC med et '+00:00'-suffiks, fx
// '2026-08-23 14:01:18.834000+00:00' — samme tekstformat som resten af appens
// egne TEXT-tidsstempler (nowTextSQL()) minus suffikset, så vi blot stripper
// det i stedet for at parse og genformattere en dato.
function closeToDbTimestamp(raw) {
  const s = String(raw || '').trim();
  if (!s) return null;
  const stripped = s.replace(/([+-]\d\d:\d\d|Z)$/i, '').trim().replace('T', ' ');
  if (!/^\d{4}-\d\d-\d\d \d\d:\d\d:\d\d/.test(stripped)) return null;
  return stripped;
}
function closeNowTimestamp() {
  return new Date().toISOString().replace('T', ' ').replace('Z', '');
}

// Kombinerer gade med by/postnr til én fuld adresse-streng — undgår at
// duplikere by/postnr hvis de allerede indgår i gade-feltet (set i praksis i
// den rigtige Close-eksport, fx "Iranvej 4, 2300 KBH"). Bevidst enkel — ingen
// forsøg på at normalisere/rette adresser.
function closeBuildAddress(street, city, zip, country) {
  street = String(street || '').trim();
  city = String(city || '').trim();
  zip = String(zip || '').trim();
  if (!street && !city && !zip) return null;
  const streetLower = street.toLowerCase();
  const extra = [];
  if (zip && !streetLower.includes(zip.toLowerCase())) extra.push(zip);
  if (city && !streetLower.includes(city.toLowerCase())) extra.push(city);
  const parts = [];
  if (street) parts.push(street);
  if (extra.length) parts.push(extra.join(' '));
  return parts.join(', ') || null;
}

// leads.csv er den AUTORITATIVE kilde til navn/telefon/email/adresse — også
// for opportunities (joinet via lead_id). opportunities.csv's egne
// contact_name/contact_id-kolonner er ofte tomme og bruges bevidst IKKE — se
// leveringsnoten. 281 af 2750 leads mangler primary_contact_name helt; falder
// da tilbage til display_name/lead_name (Close's egen sagstitel), og til sidst
// en fast tekst — crm_leads.name/crm_opportunities kræver NOT NULL.
function closeLeadPersonFields(leadRow) {
  const name = String(leadRow.primary_contact_name || '').trim()
    || String(leadRow.display_name || '').trim()
    || String(leadRow.lead_name || '').trim()
    || 'Ukendt navn (Close-import)';
  const email = String(leadRow.primary_contact_primary_email || '').trim() || null;
  const phone = String(leadRow.primary_contact_primary_phone || '').trim() || null;
  const address = closeBuildAddress(leadRow.address_1_address_1, leadRow.address_1_city, leadRow.address_1_zip, leadRow.address_1_country);
  return { name, email, phone, address };
}

const CLOSE_LEAD_SOURCE_MAP = { 'Opkald': 'Telefon', 'Mund til Mund': 'Anbefaling' };
function closeMapLeadSource(raw) {
  const s = String(raw || '').trim();
  if (!s) return null;
  return CLOSE_LEAD_SOURCE_MAP[s] || s;
}
// Projekt Type kan indeholde flere værdier adskilt af "; " (Close tillader
// multi-select, vores custom_fields gør ikke — UNIQUE pr. felt+entity). Kun
// første segment bruges, jf. leveringsnoten.
function closeMapProjektType(raw) {
  const s = String(raw || '').trim();
  if (!s) return null;
  const first = s.split(';')[0].trim();
  return first || null;
}

function closeMatchStageByName(stages, name) {
  const n = String(name || '').trim().toLowerCase();
  if (!n) return null;
  return stages.find(s => String(s.name || '').trim().toLowerCase() === n) || null;
}

// (Her lå closeResolveLeadStage(), som mappede leads.csv's egen status_label
// til en Lead-pipeline-stage. Den er fjernet ved rettelse nr. 2, sep. 2026:
// begge de to lead-populationer har nu hver sin, mere præcise stage-kilde —
// closeResolveReclassifiedLeadStage() for leads med en Leads-pipeline-række,
// og closeResolvePureLeadStage() ("Tabt") for leads uden nogen opportunity
// overhovedet. Se kommentarblokken "RETTELSE nr. 2" længere nede.)

// Prioriteret mapping status_type/status_label -> Sales-pipeline-stagenavn,
// se leveringsnoten for hele tabellen. targetName matches case-insensitivt
// mod de RIGTIGE stages i databasen — findes den ikke (anden pipeline-
// opsætning end forventet), falder vi tilbage til pipelinens første stage og
// flager det som en advarsel i stedet for at fejle hele importen.
function closeResolveOpportunityStage(oppStages, defaultStage, row) {
  const statusType = String(row.status_type || '').trim().toLowerCase();
  const statusLabel = String(row.status_label || '').trim();
  const statusLabelLower = statusLabel.toLowerCase();
  let targetName;
  let isCatchAll = false;
  if (statusType === 'won') targetName = 'Vundet';
  else if (statusLabel === 'Tilbud Afgivet') targetName = 'Tilbud Afgivet';
  else if (statusLabel === 'Lav Tilbud') targetName = 'Lav Tilbud';
  else if (statusLabel === 'Manglende data') targetName = 'Manglende data';
  else if (statusLabelLower.includes('hot lead')) targetName = 'Hot Lead';
  else if (statusLabel === 'Lost' || statusLabel === 'Ikke relevant / Lukket') targetName = 'Tabt';
  else { targetName = 'Manglende data'; isCatchAll = true; }
  const stage = closeMatchStageByName(oppStages, targetName);
  if (stage) return { stage, isCatchAll, targetName, notFoundInDb: false };
  return { stage: defaultStage, isCatchAll, targetName, notFoundInDb: true };
}

// Sikrer at et custom field FINDES for den givne entity_type/key, og opretter
// det (tomt options-array) hvis ikke — samme INSERT-mønster som appens egen
// standard-seeding af custom fields (initSchema). Kun relevant fordi denne
// lokale/prod-DB, ved verificering, viser at "Lead Source" IKKE findes som
// felt for entity_type='opportunity' (kun for 'lead') — modsat hvad der
// oprindeligt blev antaget. Se leveringsnoten: uden dette ville
// crmSetCustomFieldValues stille droppe Lead Source-værdien for hver eneste
// importeret opportunity (crmSetCustomFieldValues ignorerer ukendte
// feltnøgler uden fejl), og data ville gå tabt uden varsel.
//
// show_on_card=1 SÆTTES BEVIDST HER (rettelse, sep. 2026 — se leveringsnoten):
// crm_custom_fields.show_on_card har DEFAULT 0, og kort-badges på Kanban-
// boardet vises KUN for felter med show_on_card=1 (se crmpCardHtml i
// admin.html: `defs.filter(d => d.show_on_card && ...)`). Den første version af
// denne import oprettede derfor "Lead Source" for entity_type='opportunity'
// med show_on_card=0 — værdierne blev gemt korrekt i crm_custom_field_values og
// kunne ses inde på det enkelte salg (detalje-modalen læser feltdefinitionerne
// direkte fra GET /api/crm/opportunities/:id), men de var USYNLIGE på selve
// Sales-boardets kort. Det var præcis det Martin oplevede som "ingen af
// Opportunities fik Custom fields med ind". Felterne oprettes her udelukkende
// FOR at bære Close-data, så de skal være synlige på kortene fra start.
async function closeEnsureCustomFieldDef(entityType, key, label, fieldType) {
  const existing = await pgOne('SELECT id FROM crm_custom_fields WHERE entity_type=$1 AND key=$2', [entityType, key]);
  if (existing) return false;
  const posRow = await pgOne('SELECT COALESCE(MAX(position),-1)+1 AS pos FROM crm_custom_fields WHERE entity_type=$1', [entityType]);
  await pool.query(
    'INSERT INTO crm_custom_fields (entity_type,key,label,field_type,options,position,show_on_card) VALUES ($1,$2,$3,$4,$5,$6,1) ON CONFLICT (entity_type,key) DO NOTHING',
    [entityType, key, label, fieldType, '[]', posRow.pos]
  );
  return true;
}
// Slår "Vis på kort" til på et Close-mappet felt der allerede findes med
// show_on_card=0. Nødvendigt fordi Martins PRODUKTIONS-database allerede har
// "Lead Source" (opportunity) liggende — oprettet af den FØRSTE importkørsel,
// altså af vores egen kode, med den forkerte 0-default ovenfor. Uden dette
// ville en gen-import af de samme filer stadig efterlade felterne usynlige på
// kortene. Returnerer true hvis den faktisk ændrede noget, så det kan vises i
// import-kvitteringen — Martin kan altid fjerne fluebenet igen med ét klik
// under CRM-indstillinger → Felter.
async function closeEnsureShownOnCard(entityType, key) {
  const r = await pool.query(
    'UPDATE crm_custom_fields SET show_on_card=1 WHERE entity_type=$1 AND key=$2 AND COALESCE(show_on_card,0)=0',
    [entityType, key]
  );
  return r.rowCount > 0;
}
async function closeLoadFieldOptionCache(entityType, key) {
  const def = await pgOne('SELECT id, options FROM crm_custom_fields WHERE entity_type=$1 AND key=$2', [entityType, key]);
  if (!def) return null;
  const list = Array.isArray(def.options) ? def.options.map(String) : [];
  return { id: def.id, list, lowerSet: new Set(list.map(o => o.toLowerCase())) };
}
// Tilføjer en ny option til et select-felts options-array HVIS den ikke
// allerede findes case-insensitivt — så en værdi Close har, men Gulvmaster
// endnu ikke kender, ikke bare stille forsvinder (crmSetCustomFieldValues sætter
// blot den rå tekstværdi uanset options, men UI'ets dropdown ville aldrig vise
// den uden dette). Returnerer true hvis en ny option faktisk blev tilføjet.
async function closeEnsureOption(cache, value) {
  if (!cache || value === null || value === undefined) return false;
  const v = String(value);
  if (!v.trim()) return false;
  const lower = v.toLowerCase();
  if (cache.lowerSet.has(lower)) return false;
  cache.list.push(v);
  cache.lowerSet.add(lower);
  await pool.query('UPDATE crm_custom_fields SET options=$1 WHERE id=$2', [JSON.stringify(cache.list), cache.id]);
  return true;
}

// ══════════════════════════════════════════════════════════════
// RETTELSE (sep. 2026): opportunities.csv INDEHOLDER IKKE KUN SALG
// ──────────────────────────────────────────────────────────────
// Close eksporterer BÅDE sin rigtige salgs-pipeline OG sin egen "Leads
// Pipeline"-opfølgning gennem præcis samme opportunities-eksportformat,
// adskilt udelukkende af kolonnen `pipeline_name`. På Martins rigtige
// eksport: 1623 rækker med pipeline_name='Sales' (ægte salg) og 106 med
// pipeline_name='Leads' (IKKE salg — det er blot den kolonne leadet ligger i
// på Close's Leads-board: "Nyt lead", "Kontaktforsøg 1..4", "Afventer kunde",
// "Ikke relevant / Lukket").
//
// De første to produktionskørsler af denne import behandlede ALLE rækker i
// opportunities.csv som ægte salg. Konsekvensen i Martins produktionsdatabase:
//   1) 106 falske salg i Sales-pipelinen (94 i "Tabt", 12 i "Manglende data").
//   2) De tilhørende leads.csv-rækker blev SAMTIDIG udelukket fra at blive
//      importeret som leads overhovedet — fordi "rene leads"-udregningen
//      ekskluderede ethvert lead-id der optrådte som lead_id på en hvilken som
//      helst opportunity-række. Derfor stod Gulvmasters Lead-board med ALLE
//      1061 leads i "Nyt lead" og INTET i kontaktforsøgs-kolonnerne, modsat
//      Martins rigtige Close Leads Pipeline-visning.
//
// Rettelsen (aftalt med Martin):
//   - Kun pipeline_name='Sales' tæller som "dette lead blev til et rigtigt
//     salg" i "rene leads"-udregningen (udelukkelsen er fortsat rigtig — den
//     skal bare kun gælde ÆGTE salg).
//   - En pipeline_name='Leads'-række bliver i stedet STAGE-KILDE for leadet:
//     leadet importeres som et crm_leads-kort med personoplysninger fra
//     leads.csv (samme autoritative kilde som alt andet her) og med LEADETS
//     EGET close_id (leads.csv's `id`) som idempotens-nøgle — nøjagtig som
//     ethvert andet rent lead, så det deduperer korrekt mod
//     idx_crm_leads_close_id.
//   - Har ét lead BÅDE en Sales- og en Leads-række, vinder Sales-rækken
//     (leadet udelades fortsat, kun det ægte salg importeres). Optræder i
//     praksis 2 gange i Martins data.
//   - Har ét lead FLERE Leads-rækker, bruges den senest opdaterede som
//     stage-kilde, og der logges en advarsel. Optræder 1 gang i Martins data.
//   - SELVHELING: de 106 forkert oprettede crm_opportunities-rækker (tagget med
//     SELVE Leads-rækkens close_id) slettes ved næste kørsel, med tilhørende
//     custom field-værdier, aktiviteter og opgaver — se
//     closeDeleteWronglyImportedOpportunity().
// ══════════════════════════════════════════════════════════════

// De Lead-pipeline-stages Close's egen Leads Pipeline bruger, men som
// Gulvmasters standard-seed (Nyt lead / Kontaktet / Kvalificeret /
// Konverteret) ikke har. Oprettes automatisk ved import — samme idé som
// closeEnsureCustomFieldDef ovenfor: tjek på navn først, opret kun det der
// mangler, og kun én gang uanset hvor mange gange importen køres.
//
// `place`:
//   'after_new'  → indsættes i rækkefølge lige efter "Nyt lead", FØR
//                  "Kontaktet", så boardet læses Nyt lead → Kontaktforsøg 1-4
//                  → Afventer kunde → Kontaktet → Kvalificeret → Konverteret.
//   'last'       → sidst i pipelinen, efter "Konverteret" — Martins eget valg
//                  for "Ikke relevant / Lukket", spejler hvordan "Tabt" ligger
//                  sidst i Sales-pipelinen.
//
// Farverne følger samme Tailwind-agtige hex-stil som appens egen seeding
// (se initSchema): en stigende blå→gul→orange-trappe for de fire
// kontaktforsøg, teal for "Afventer kunde", og neutral grå for "Afvist".
//
// is_lost SÆTTES BEVIDST IKKE på "Afvist" (modsat "Tabt" i Sales-pipelinen).
// is_lost bruges KUN af runLostFollowupScan, som sender en automatisk
// "Er du stadig interesseret?"-mail X dage efter at et kort er landet i en
// is_lost-stage. Martin har bedt om en Afvist-kolonne, ikke om ny automatik på
// leads han selv har markeret som irrelevante. Han kan slå den til med ét klik
// (❌-fluebenet under CRM-indstillinger → Pipelines) hvis han ønsker det.
// (De importerede rækker ville i øvrigt alligevel blive sprunget over, fordi
// importen sætter stage_changed_at=NULL — se filhoved-kommentaren.)
//
// ── "Tabt" (rettelse, sep. 2026 — se den store kommentarblok "RETTELSE:
// leads UDEN NOGEN opportunity" nedenfor) ──
// Tilføjet SIDST i listen, og med place:'last', så den lander efter "Afvist"
// i pipelinen: begge er terminale/ikke-aktive kolonner, og "Tabt" er den
// største af dem (~1061 kort), så den skal ikke ligge midt i Martins
// arbejdsgang. Farven er en MØRKERE grå (#4B5563) end både "Nyt lead"
// (#6B7280) og "Afvist" (#9CA3AF), så de tre kan skelnes fra hinanden på
// boardet. is_lost sættes bevidst IKKE — nøjagtig samme begrundelse som for
// "Afvist" ovenfor, og med endnu større vægt her: det er over TUSIND gamle,
// kolde kontaktformular-henvendelser, som ingen af dem skal have en
// automatisk "Er du stadig interesseret?"-mail uden Martins udtrykkelige ja.
const CLOSE_LEAD_PIPELINE_STAGES = [
  { name: 'Kontaktforsøg 1', color: '#93C5FD', place: 'after_new' },
  { name: 'Kontaktforsøg 2', color: '#60A5FA', place: 'after_new' },
  { name: 'Kontaktforsøg 3', color: '#FBBF24', place: 'after_new' },
  { name: 'Kontaktforsøg 4', color: '#FB923C', place: 'after_new' },
  { name: 'Afventer kunde', color: '#14B8A6', place: 'after_new' },
  { name: 'Afvist', color: '#9CA3AF', place: 'last' },
  { name: 'Tabt', color: '#4B5563', place: 'last' }
];
// Ankerkæden bestemmer HVOR en manglende 'after_new'-stage indsættes: lige
// efter den SIDSTE af de foranstillede stages der faktisk findes. Dermed
// lander fx "Kontaktforsøg 3" korrekt efter "Kontaktforsøg 2", uanset om 1 og 2
// blev oprettet i denne kørsel, i en tidligere kørsel, eller af Martin selv.
const CLOSE_LEAD_STAGE_ANCHOR_CHAIN = ['Nyt lead', 'Kontaktforsøg 1', 'Kontaktforsøg 2', 'Kontaktforsøg 3', 'Kontaktforsøg 4', 'Afventer kunde'];

// Opretter de manglende Lead-pipeline-stages ovenfor og skubber KUN de
// efterfølgende stages én plads op pr. stage der rent faktisk oprettes.
// Findes de alle i forvejen (2., 3., ... kørsel), rører funktionen INTET —
// ingen dubletter, ingen huller i position-rækkefølgen, og ingen omrokering af
// stages Martin selv har flyttet eller tilføjet.
async function closeEnsureLeadPipelineStages(pipelineId) {
  const created = [];
  const loadStages = async () => (await pool.query('SELECT id, name, position FROM crm_stages WHERE pipeline_id=$1 ORDER BY position ASC, id ASC', [pipelineId])).rows;
  const findByName = (stages, name) => stages.find(s => String(s.name || '').trim().toLowerCase() === String(name).trim().toLowerCase()) || null;

  for (const def of CLOSE_LEAD_PIPELINE_STAGES) {
    const stages = await loadStages();
    if (findByName(stages, def.name)) continue; // findes allerede — spring helt over
    let targetPos;
    if (def.place === 'last') {
      targetPos = stages.reduce((m, s) => Math.max(m, Number(s.position)), -1) + 1;
    } else {
      const idx = CLOSE_LEAD_STAGE_ANCHOR_CHAIN.indexOf(def.name);
      let anchorPos = -1;
      for (let i = 0; i < (idx === -1 ? 1 : idx); i++) {
        const a = findByName(stages, CLOSE_LEAD_STAGE_ANCHOR_CHAIN[i]);
        if (a && Number(a.position) > anchorPos) anchorPos = Number(a.position);
      }
      targetPos = anchorPos + 1;
      // Gør plads: alt fra targetPos og frem rykker én op. Kun de stages der
      // ligger EFTER indsættelsespunktet berøres — aldrig "Nyt lead" eller
      // tidligere kontaktforsøg.
      await pool.query('UPDATE crm_stages SET position=position+1 WHERE pipeline_id=$1 AND position>=$2', [pipelineId, targetPos]);
    }
    await pool.query('INSERT INTO crm_stages (pipeline_id,name,color,position,is_won,is_lost) VALUES ($1,$2,$3,$4,0,0)', [pipelineId, def.name, def.color, targetPos]);
    created.push(def.name);
  }
  return created;
}

// Close's Leads Pipeline-statusnavne matcher 1:1 vores egne stagenavne, PÅ NÉR
// "Ikke relevant / Lukket" (94 af de 106 rækker), som Martin udtrykkeligt har
// valgt skal hedde "Afvist" i Gulvmaster. Alt andet matches dynamisk på navn
// mod de RIGTIGE stages i databasen (aldrig hardkodede id'er), præcis som
// closeResolveLeadStage/closeResolveOpportunityStage.
const CLOSE_LEADS_PIPELINE_STAGE_MAP = { 'ikke relevant / lukket': 'Afvist' };
function closeResolveReclassifiedLeadStage(leadStages, defaultStage, statusLabel) {
  const raw = String(statusLabel || '').trim();
  const targetName = CLOSE_LEADS_PIPELINE_STAGE_MAP[raw.toLowerCase()] || raw;
  const stage = closeMatchStageByName(leadStages, targetName);
  if (stage) return { stage, fellBack: false, targetName };
  return { stage: defaultStage, fellBack: true, targetName };
}

// SELVHELING af de forkert importerede salg. En pipeline_name='Leads'-række
// blev af den tidligere version oprettet som et crm_opportunities-kort tagget
// med RÆKKENS EGET close_id (oppo_...). Her fjernes den igen, sammen med alt
// der peger på opportunity-id'et — samme grundighed som resten af kodebasen
// viser for relaterede rækker:
//   crm_custom_field_values / crm_activities / crm_tasks (entity_type=
//   'opportunity' + entity_id — ingen FK, ville ellers blive forældreløse),
//   crm_leads.converted_opportunity_id (FK ON DELETE SET NULL, men nulstilles
//   eksplicit så et evt. lead ikke fremstår "konverteret"),
//   close_customer_links.opportunity_id (ingen FK — sat af Close-webhooken).
// Kunden/kontakten i Kunder-modulet RØRES BEVIDST IKKE: den blev fundet eller
// oprettet med samme dedup-logik som alt andet i appen, kan i mellemtiden have
// fået tilbud/fakturaer/sager hængende på sig, og leadet vi opretter i stedet
// peger alligevel på præcis samme kontakt.
// Returnerer true hvis der faktisk blev slettet et salg.
async function closeDeleteWronglyImportedOpportunity(closeOppId) {
  const wrong = await pgOne('SELECT id FROM crm_opportunities WHERE close_id=$1', [closeOppId]);
  if (!wrong) return false;
  await pool.query("DELETE FROM crm_custom_field_values WHERE entity_type='opportunity' AND entity_id=$1", [wrong.id]);
  await pool.query("DELETE FROM crm_activities WHERE entity_type='opportunity' AND entity_id=$1", [wrong.id]);
  await pool.query("DELETE FROM crm_tasks WHERE entity_type='opportunity' AND entity_id=$1", [wrong.id]);
  await pool.query('UPDATE crm_leads SET converted_opportunity_id=NULL WHERE converted_opportunity_id=$1', [wrong.id]);
  await pool.query('UPDATE close_customer_links SET opportunity_id=NULL WHERE opportunity_id=$1', [wrong.id]);
  await pool.query('DELETE FROM crm_opportunities WHERE id=$1', [wrong.id]);
  return true;
}

// ══════════════════════════════════════════════════════════════
// RETTELSE (sep. 2026, nr. 2): LEADS UDEN NOGEN OPPORTUNITY OVERHOVEDET
// ──────────────────────────────────────────────────────────────
// 1061 af de 2750 rækker i leads.csv optræder ALDRIG som lead_id på nogen
// opportunity-række — hverken en pipeline_name='Sales' eller en
// pipeline_name='Leads'. Det er rå kontaktformular-henvendelser som Close har
// registreret, men som Martin aldrig har arbejdet med på noget board. Alle
// 1061 har status_label='Nyt Lead' i leads.csv (Close's default-leadstatus,
// ikke et udtryk for at de er nye), og de blev derfor indtil nu importeret til
// Lead-pipelinens FØRSTE stage, "Nyt lead" — som dermed stod med 1061+ kort,
// mens Martins rigtige Close "Leads Pipeline"-board kun viser en håndfuld
// ægte nye leads.
//
// Martins ord ved opfølgning: "Lav en separat kolonne med tabt".
//
// VIGTIGT — "Tabt" og "Afvist" er TO FORSKELLIGE populationer, og de må ikke
// blandes sammen:
//   "Afvist" (rettelse nr. 1) = de 94 pipeline_name='Leads'-rækker som Close
//        selv har markeret 'Ikke relevant / Lukket'. Leads Martin FAKTISK har
//        haft på sit Leads-board og derefter afvist.
//   "Tabt"  (denne rettelse) = de ~1061 leads der ALDRIG har ligget på noget
//        Close-board. Aldrig arbejdet, ikke afvist — bare aldrig taget op.
//
// SELVHELING af Martins produktionsdata: de 1061 ligger allerede i "Nyt lead"
// fra tidligere kørsler, tagget med leadets eget close_id. Ved denne kørsel
// flyttes de (kun stage_id) til "Tabt" — se closeHealPureLeadToTabt(). Der
// slettes ALDRIG noget, og der bygges bevidst INGEN nulstillings-/wipe-
// funktion: samme rene slutresultat nås ved at flytte på plads.
// ══════════════════════════════════════════════════════════════

// Navnet på den stage rene leads (nul opportunities) skal lande i. Slås op på
// NAVN mod de rigtige stages i databasen — aldrig et hardkodet id — præcis som
// closeResolveLeadStage/closeResolveReclassifiedLeadStage.
const CLOSE_PURE_LEAD_STAGE_NAME = 'Tabt';
function closeResolvePureLeadStage(leadStages, defaultStage) {
  const stage = closeMatchStageByName(leadStages, CLOSE_PURE_LEAD_STAGE_NAME);
  if (stage) return { stage, fellBack: false };
  return { stage: defaultStage, fellBack: true };
}

// SELVHELING af de leads en TIDLIGERE kørsel lagde i "Nyt lead", og som efter
// rettelsen ovenfor hører hjemme i "Tabt".
//
// Flytter KUN en række der opfylder ALLE fire betingelser:
//   1) close_id matcher leads.csv-rækken  → Martins egne, håndlavede leads
//      (close_id IS NULL) kan aldrig rammes.
//   2) stage_id er stadig pipelinens FØRSTE stage ("Nyt lead")  → ligger den
//      et andet sted, har Martin selv flyttet kortet, og det respekteres.
//   3) kortet har ALDRIG skiftet stage: stage_changed_at er enten NULL (som
//      importen sætter den) ELLER nøjagtig lig created_at. Det sidste led er
//      IKKE pynt — se den vigtige note nedenfor. PUT /api/crm/leads/:id sætter
//      stage_changed_at til NUTIDEN hver gang stagen ændres, og de importerede
//      rækkers created_at er Close's egen (ofte årgamle) dato, så et manuelt
//      flyt kan aldrig komme til at ligne "urørt" — heller ikke hvis Martin
//      har flyttet kortet TILBAGE til "Nyt lead" igen.
//   4) mål-stagen er en anden end den nuværende  → gør gen-kørsel til en no-op.
//
// VIGTIGT — HVORFOR stage_changed_at IKKE bare kan testes med "IS NULL":
// initSchema() kører ved HVER serverstart og indeholder migrationen
//   UPDATE crm_leads SET stage_changed_at=created_at WHERE stage_changed_at IS NULL;
// Den blev skrevet længe før Close-importen fandtes, og den kan ikke se
// forskel på "kolonnen er lige blevet tilføjet" og "importen satte bevidst
// NULL". Første gang serveren genstarter efter en import (altså ved næste
// deploy) får ALLE importerede rækker derfor stage_changed_at = created_at.
// Målt direkte på en gennemkørsel af hele produktionssekvensen her: 1060 ud af
// 1060 importerede leads i "Nyt lead" havde stage_changed_at = created_at, ikke
// NULL. En ren "IS NULL"-test ville altså have flyttet NUL leads i praksis.
// Dette er en selvstændig, ældre fejl der rækker ud over denne rettelse — den
// underminerer også import-kodens egen dokumenterede sikkerhed mod automatiske
// SMS/mails på historiske rækker. Den er IKKE rettet her (det kræver Martins
// stillingtagen til de rækker der allerede er blevet bagudfyldt) — se
// leveringsnoten.
//
// stage_changed_at, updated_at, position, contact_id og alt andet RØRES IKKE:
// stage_changed_at må ikke få et NYT (nutidigt) tidsstempel, ellers ville
// runStageFollowupScan/runLostFollowupScan pludselig kunne fange over tusind
// årgamle kontakter (se filhoved-kommentaren). Kortet lander derfor nederst i
// "Tabt" med sin oprindelige position — helt uden automatik.
// Returnerer true hvis rækken faktisk blev flyttet.
async function closeHealPureLeadToTabt(closeId, defaultStageId, tabtStageId) {
  if (!tabtStageId || Number(tabtStageId) === Number(defaultStageId)) return false;
  const r = await pool.query(
    'UPDATE crm_leads SET stage_id=$1 WHERE close_id=$2 AND stage_id=$3 AND (stage_changed_at IS NULL OR stage_changed_at = created_at)',
    [tabtStageId, closeId, defaultStageId]
  );
  return r.rowCount > 0;
}

// ── ENDPOINT ─────────────────────────────────────────────────────
// adminOnly (ikke bare panelAccess) — dette er en engangs, historisk
// databulk-handling, ikke noget en almindelig medarbejder-login (fx Sarah)
// skal kunne trykke på, jf. samme gating som andre følsomme admin-handlinger
// (/api/backup/export, /api/users, /api/settings m.fl.).
app.post('/api/admin/import/close', auth, adminOnly, uploadCloseImport.fields([{ name: 'leads', maxCount: 1 }, { name: 'opportunities', maxCount: 1 }]), asyncRoute(async (req, res) => {
  const t0 = Date.now();
  const leadsFile = req.files && req.files.leads && req.files.leads[0];
  const oppsFile = req.files && req.files.opportunities && req.files.opportunities[0];
  if (!leadsFile || !oppsFile) return res.status(400).json({ error: 'Både leads.csv og opportunities.csv skal uploades' });

  let leadRows, oppRows;
  try {
    leadRows = closeParseCsv(leadsFile.buffer);
    oppRows = closeParseCsv(oppsFile.buffer);
  } catch (e) {
    return res.status(400).json({ error: 'Kunne ikke læse CSV-filerne: ' + e.message });
  }
  if (!leadRows.length) return res.status(400).json({ error: 'leads.csv er tom eller kunne ikke læses' });
  if (!oppRows.length) return res.status(400).json({ error: 'opportunities.csv er tom eller kunne ikke læses' });

  const leadPipeline = await pgOne("SELECT id FROM crm_pipelines WHERE type='lead' ORDER BY position ASC LIMIT 1");
  if (!leadPipeline) return res.status(400).json({ error: 'Ingen lead-pipeline findes — opret én under CRM-indstillinger' });
  // Opret de Lead-pipeline-stages Close's Leads Pipeline bruger, FØR stages
  // læses ind nedenfor — så de nyoprettede kan matches som alle andre.
  const createdLeadStages = await closeEnsureLeadPipelineStages(leadPipeline.id);
  const leadStages = (await pool.query('SELECT * FROM crm_stages WHERE pipeline_id=$1 ORDER BY position ASC, id ASC', [leadPipeline.id])).rows;
  if (!leadStages.length) return res.status(400).json({ error: 'Lead-pipelinen har ingen stages' });
  const defaultLeadStage = leadStages[0];

  const oppPipeline = await pgOne("SELECT id FROM crm_pipelines WHERE type='opportunity' ORDER BY position ASC LIMIT 1");
  if (!oppPipeline) return res.status(400).json({ error: 'Ingen salgs-pipeline (Sales) findes — opret én under CRM-indstillinger' });
  const oppStages = (await pool.query('SELECT * FROM crm_stages WHERE pipeline_id=$1 ORDER BY position ASC, id ASC', [oppPipeline.id])).rows;
  if (!oppStages.length) return res.status(400).json({ error: 'Salgs-pipelinen har ingen stages' });
  const defaultOppStage = oppStages[0];

  // Sikr custom fields — se closeEnsureCustomFieldDef ovenfor. Bruger samme
  // options som appens egen standard-seed for de felter der allerede findes.
  const createdFields = [];
  if (await closeEnsureCustomFieldDef('lead', 'lead_source', 'Lead Source', 'select')) createdFields.push('lead.lead_source');
  if (await closeEnsureCustomFieldDef('lead', 'projekt_type', 'Projekt Type', 'select')) createdFields.push('lead.projekt_type');
  if (await closeEnsureCustomFieldDef('opportunity', 'lead_source', 'Lead Source', 'select')) createdFields.push('opportunity.lead_source');
  if (await closeEnsureCustomFieldDef('opportunity', 'projekt_type', 'Projekt Type', 'select')) createdFields.push('opportunity.projekt_type');
  // Se closeEnsureShownOnCard: retter den forkerte show_on_card=0-default som
  // den første version af denne import gav de felter den selv oprettede.
  const shownOnCardFixed = [];
  for (const [ent, key] of [['lead', 'lead_source'], ['lead', 'projekt_type'], ['opportunity', 'lead_source'], ['opportunity', 'projekt_type']]) {
    if (await closeEnsureShownOnCard(ent, key)) shownOnCardFixed.push(ent + '.' + key);
  }

  const leadSourceCacheLead = await closeLoadFieldOptionCache('lead', 'lead_source');
  const projektTypeCacheLead = await closeLoadFieldOptionCache('lead', 'projekt_type');
  const leadSourceCacheOpp = await closeLoadFieldOptionCache('opportunity', 'lead_source');
  const projektTypeCacheOpp = await closeLoadFieldOptionCache('opportunity', 'projekt_type');
  const leadSourceNewOptions = new Set();
  const projektTypeNewOptions = new Set();

  // ── CUSTOM FIELDS: ét fælles sted ────────────────────────────
  // Samlet her (i stedet for inline i hver af de to faser, som før) fordi
  // NØJAGTIG samme mapping nu skal kunne køres i to situationer: når rækken
  // oprettes, OG når den allerede findes og kun skal have felterne efterfyldt
  // (se "GEN-KØRSEL"-blokkene i fase 1 og 2).
  function closeLeadCustomFieldValues(row) {
    const out = {};
    const ls = closeMapLeadSource(row['custom.Lead Source']);
    const pt = closeMapProjektType(row['custom.Projekt Type']);
    if (ls) out.lead_source = ls;
    if (pt) out.projekt_type = pt;
    return out;
  }
  // Opportunity-rækkens EGNE custom-felter først, ellers det tilhørende LEADS.
  // Grunden (målt på Martins rigtige eksport, se leveringsnoten): Close gemmer
  // i praksis næsten altid Lead Source/Projekt Type på LEADET, ikke på
  // opportunity'en. Af de 1729 opportunities har kun 68 selv en Lead Source og
  // 157 selv en Projekt Type — men deres tilhørende lead har det i hhv. 446 og
  // 284 tilfælde. Uden dette fald-tilbage ville ~9 ud af 10 salg i Sales-
  // pipelinen stå helt uden Projekt Type/Lead Source, selvom oplysningen
  // ligger lige ved siden af i den samme eksport. Samme princip som
  // closeLeadPersonFields, hvor leads.csv i forvejen er den autoritative kilde
  // til navn/telefon/email/adresse for opportunities. Opportunity'ens egen
  // værdi vinder ALTID hvis den findes — leadet bruges kun som udfyldning.
  function closeOppCustomFieldValues(row, leadRow) {
    const own = closeLeadCustomFieldValues(row);
    const fromLead = leadRow ? closeLeadCustomFieldValues(leadRow) : {};
    const out = {};
    let usedLeadFallback = false;
    for (const key of ['lead_source', 'projekt_type']) {
      if (own[key]) out[key] = own[key];
      else if (fromLead[key]) { out[key] = fromLead[key]; usedLeadFallback = true; }
    }
    return { values: out, usedLeadFallback };
  }
  // Skriver værdierne og udvider samtidig select-felternes options-liste med
  // værdier Close kender men Gulvmaster ikke gør. Returnerer true hvis der
  // faktisk blev sat mindst én værdi.
  async function closeWriteCustomFields(entityType, entityId, values, lsCache, ptCache) {
    if (!Object.keys(values).length) return false;
    if (values.lead_source && await closeEnsureOption(lsCache, values.lead_source)) leadSourceNewOptions.add(values.lead_source);
    if (values.projekt_type && await closeEnsureOption(ptCache, values.projekt_type)) projektTypeNewOptions.add(values.projekt_type);
    await crmSetCustomFieldValues(entityType, entityId, values);
    return true;
  }

  // In-memory position-tællere pr. stage (én opslags-forespørgsel i stedet for
  // en MAX(position)-forespørgsel PR. importeret række) — samme resultat som
  // det eksisterende "COALESCE(MAX(position),-1)+1"-mønster, bare uden ~2790
  // ekstra roundtrips.
  const leadPosCounters = {};
  (await pool.query('SELECT stage_id, COALESCE(MAX(position),-1) AS maxpos FROM crm_leads GROUP BY stage_id')).rows
    .forEach(r => { leadPosCounters[r.stage_id] = Number(r.maxpos); });
  const nextLeadPosition = (stageId) => { const n = (leadPosCounters[stageId] === undefined ? -1 : leadPosCounters[stageId]) + 1; leadPosCounters[stageId] = n; return n; };
  const oppPosCounters = {};
  (await pool.query('SELECT stage_id, COALESCE(MAX(position),-1) AS maxpos FROM crm_opportunities GROUP BY stage_id')).rows
    .forEach(r => { oppPosCounters[r.stage_id] = Number(r.maxpos); });
  const nextOppPosition = (stageId) => { const n = (oppPosCounters[stageId] === undefined ? -1 : oppPosCounters[stageId]) + 1; oppPosCounters[stageId] = n; return n; };

  const summary = {
    ok: true,
    leads_imported: 0,
    leads_skipped_existing: 0,
    // Antal ALLEREDE importerede rækker der ved denne kørsel fik deres custom
    // fields sat/rettet i stedet for bare at blive sprunget over — se
    // "GEN-KØRSEL"-blokken nedenfor. Tælles adskilt fra _skipped_existing, som
    // fortsat er det samlede antal rækker der ikke blev oprettet på ny.
    leads_custom_fields_refreshed: 0,
    // ── Rettelsen af pipeline_name='Leads'-fejlklassificeringen (se den store
    // kommentarblok over CLOSE_LEAD_PIPELINE_STAGES) ──
    // Leads oprettet ud fra en pipeline_name='Leads'-række, dvs. leads der FØR
    // rettelsen slet ikke blev importeret som leads.
    leads_reclassified_from_leads_pipeline: 0,
    // Delmængde af ovenstående: dem hvor der SAMTIDIG lå et forkert oprettet
    // salg fra en tidligere kørsel, som blev slettet i denne kørsel.
    leads_reclassified_from_wrong_opportunity: 0,
    // Alle forkert oprettede salg der blev fjernet fra Sales-pipelinen —
    // inkl. de få hvor leadet alligevel ikke skal oprettes (fordi leadet også
    // har et ÆGTE salg), og derfor er tallet ≥ tallet ovenfor.
    wrong_opportunities_deleted: 0,
    // ── Rettelsen af de rene leads uden nogen opportunity (se kommentarblokken
    // "RETTELSE nr. 2" over CLOSE_PURE_LEAD_STAGE_NAME) ──
    // Nye leads (nul opportunities af nogen art) oprettet direkte i "Tabt" i
    // denne kørsel — altså dem der FØR rettelsen ville være landet i "Nyt lead".
    leads_imported_to_tabt: 0,
    // Allerede importerede leads fra en TIDLIGERE (fejlbehæftet) kørsel, som
    // stadig lå urørt i "Nyt lead" og nu er flyttet til "Tabt". 0 ved 2. og
    // senere kørsel — og tæller aldrig kort Martin selv har flyttet.
    leads_moved_to_tabt: 0,
    // Nye Lead-pipeline-stages oprettet af denne kørsel (tom ved gen-kørsel).
    lead_stages_created: createdLeadStages,
    // Fordeling af de reklassificerede leads pr. stage — den fordeling Martin
    // kender fra Close's egen Leads Pipeline-visning.
    reclassified_lead_stage_counts: {},
    opportunities_imported: 0,
    opportunities_skipped_existing: 0,
    opportunities_custom_fields_refreshed: 0,
    customers_created: 0,
    customers_matched_existing: 0,
    contacts_created: 0,
    contacts_matched_existing: 0,
    // (lead_stage_fallback_counts er udgået ved rettelse nr. 2: begge lead-
    // populationer har nu en fast, kendt stage-kilde, så der findes ikke
    // længere et "ukendt status_label"-fald-tilbage for leads. Skulle selve
    // mål-stagen mangle, flages det i stedet som en advarsel.)
    opportunity_stage_fallback_counts: {},
    lead_source_new_options_added: [],
    projekt_type_new_options_added: [],
    custom_fields_created: createdFields,
    custom_fields_shown_on_card_fixed: shownOnCardFixed,
    // Hvor mange opportunities der hentede deres Lead Source/Projekt Type fra
    // det TILHØRENDE LEAD i stedet for fra opportunity-rækkens eget felt — se
    // closeOppCustomFieldValues nedenfor.
    opportunity_custom_fields_from_lead: 0,
    warnings: [],
    errors: []
  };

  // leads.csv joinet via id er den AUTORITATIVE kilde til navn/telefon/email/
  // adresse — også for opportunities. "Rene leads" = leads.csv-rækker hvis id
  // ALDRIG optræder som en opportunitys lead_id (beslutning #2 ovenfor).
  const leadsById = new Map();
  leadRows.forEach(r => { if (r.id) leadsById.set(r.id, r); });

  // ── OPDELING AF opportunities.csv PÅ pipeline_name ───────────
  // Se den store kommentarblok over CLOSE_LEAD_PIPELINE_STAGES: kun 'Sales'
  // er ægte salg. Ukendte pipeline_name-værdier (skulle ikke kunne ske, men
  // Close kunne få flere boards) behandles som salg — samme adfærd som før
  // rettelsen — og flages som advarsel, så intet forsvinder lydløst.
  const salesOppRows = [];
  const leadsPipelineRows = [];
  const unknownPipelineNames = new Set();
  for (const r of oppRows) {
    const pn = String(r.pipeline_name || '').trim();
    if (pn.toLowerCase() === 'leads') leadsPipelineRows.push(r);
    else {
      if (pn && pn.toLowerCase() !== 'sales') unknownPipelineNames.add(pn);
      salesOppRows.push(r);
    }
  }
  if (unknownPipelineNames.size) {
    summary.warnings.push('opportunities.csv indeholder ukendte pipeline_name-værdier (' + Array.from(unknownPipelineNames).join(', ') + ') — de er behandlet som ægte salg og importeret i Sales-pipelinen.');
  }

  // "Rene leads" = leads.csv-rækker hvis id ALDRIG optræder som lead_id på en
  // ÆGTE (pipeline_name='Sales') opportunity. En Leads-pipeline-række
  // udelukker altså IKKE længere sit lead — den bliver tværtimod leadets
  // stage-kilde nedenfor.
  const salesLeadIds = new Set();
  salesOppRows.forEach(r => { if (r.lead_id) salesLeadIds.add(r.lead_id); });
  const pureLeadRows = leadRows.filter(r => r.id && !salesLeadIds.has(r.id));

  // Mål-stagen for leads UDEN nogen opportunity overhovedet — "Tabt", oprettet
  // af closeEnsureLeadPipelineStages ovenfor. Slås op ÉN gang her (ikke pr.
  // række). Skulle den mod forventning mangle (Martin har omdøbt/slettet den
  // igen), falder vi tilbage til den hidtidige adfærd — pipelinens første stage
  // — og flager det, i stedet for at fejle importen.
  const pureLeadStageResolved = closeResolvePureLeadStage(leadStages, defaultLeadStage);
  const pureLeadStage = pureLeadStageResolved.stage;
  if (pureLeadStageResolved.fellBack) {
    summary.warnings.push('Lead-stagen "' + CLOSE_PURE_LEAD_STAGE_NAME + '" findes ikke i Lead-pipelinen — leads uden nogen opportunity blev lagt i "' + defaultLeadStage.name + '" som før.');
  }

  // Stage-kilde pr. lead_id. Har ét lead flere Leads-rækker, vinder den senest
  // opdaterede (fald tilbage til oprettelsesdato, derefter id, så valget er
  // deterministisk og gen-kørsler giver samme resultat).
  const reclassifiedByLeadId = new Map();
  const duplicateReclassifiedLeadIds = new Set();
  for (const r of leadsPipelineRows) {
    if (!r.lead_id) continue;
    // Sales vinder: leadet har ALLIGEVEL et ægte salg og skal derfor stadig
    // ikke oprettes som lead-kort (det forkerte salg ryddes stadig op nedenfor).
    if (salesLeadIds.has(r.lead_id)) continue;
    const prev = reclassifiedByLeadId.get(r.lead_id);
    if (!prev) { reclassifiedByLeadId.set(r.lead_id, r); continue; }
    duplicateReclassifiedLeadIds.add(r.lead_id);
    const key = (x) => String(x.date_updated || '') + '|' + String(x.date_created || '') + '|' + String(x.id || '');
    if (key(r) > key(prev)) reclassifiedByLeadId.set(r.lead_id, r);
  }
  for (const lid of duplicateReclassifiedLeadIds) {
    summary.warnings.push('Lead ' + lid + ' har flere rækker i Close\'s Leads Pipeline — brugte den senest opdaterede ("' + String((reclassifiedByLeadId.get(lid) || {}).status_label || '').trim() + '") som stage.');
  }

  // ── FASE 0: SELVHELING — fjern salg der aldrig burde have været salg ──
  // Kører for ALLE Leads-pipeline-rækker, også de få hvis lead alligevel ikke
  // bliver til et lead-kort (fordi leadet også har et ægte salg) — ellers ville
  // det falske salg blive stående i Sales-pipelinen for evigt. Er der intet at
  // slette (Martin har endnu ikke kørt den fejlbehæftede version, eller det er
  // 2. gang denne rettelse køres), sker der ganske enkelt ingenting.
  const healedLeadIds = new Set();
  for (const row of leadsPipelineRows) {
    try {
      if (await closeDeleteWronglyImportedOpportunity(row.id)) {
        summary.wrong_opportunities_deleted++;
        if (row.lead_id) healedLeadIds.add(row.lead_id);
      }
    } catch (e) {
      summary.errors.push('Oprydning af fejlimporteret salg ' + (row && row.id) + ': ' + e.message);
    }
  }

  // ── FASE 1: rene leads → Lead-pipelinen ──────────────────────
  for (const row of pureLeadRows) {
    try {
      const closeId = row.id;
      // Findes en Leads-pipeline-række for dette lead, er DEN stage-kilden.
      const reclassRow = reclassifiedByLeadId.get(closeId) || null;
      const existing = await pgOne('SELECT id FROM crm_leads WHERE close_id=$1', [closeId]);
      // ── GEN-KØRSEL: efterfyld custom fields på en RÆKKE DER ALLEREDE FINDES ──
      // Før denne rettelse blev en allerede importeret række sprunget helt
      // over, hvilket betød at Martins ~2790 rækker fra den FØRSTE
      // produktionskørsel aldrig kunne få rettet deres custom fields — en
      // gen-import ville ikke røre dem. Nu køres NØJAGTIG samme
      // felt-mapping igen på den eksisterende række.
      // BEVIDST IKKE rørt her: crmFindOrCreateContactAndCustomer (ingen nye/
      // ændrede kunder eller kontakter), stage_id/position/contact_id og
      // stage_changed_at. Kørslen kan altså ikke flytte et kort Martin selv har
      // trukket videre i pipelinen, ikke oprette dubletter, og ikke udløse
      // SMS/email-automatik. Den rører KUN crm_custom_field_values.
      if (existing) {
        summary.leads_skipped_existing++;
        const values = closeLeadCustomFieldValues(row);
        if (await closeWriteCustomFields('lead', existing.id, values, leadSourceCacheLead, projektTypeCacheLead)) {
          summary.leads_custom_fields_refreshed++;
        }
        // SELVHELING (rettelse nr. 2): har leadet INGEN opportunity af nogen
        // art (!reclassRow), hører det hjemme i "Tabt" — men tidligere kørsler
        // lagde det i "Nyt lead". Flyt det på plads, dog kun hvis det stadig
        // ligger præcis der hvor den gamle import efterlod det. Se
        // closeHealPureLeadToTabt for alle fire betingelser; funktionen er selv
        // en no-op ved 2. kørsel og kan aldrig ramme et kort Martin har rørt.
        // BEMÆRK: kun stage_id ændres — hverken custom fields, kunde/kontakt,
        // position, updated_at eller stage_changed_at berøres.
        if (!reclassRow) {
          if (await closeHealPureLeadToTabt(closeId, defaultLeadStage.id, pureLeadStage.id)) {
            summary.leads_moved_to_tabt++;
          }
        }
        continue;
      }

      const person = closeLeadPersonFields(row);
      // Stage: har leadet en Leads-pipeline-række, er det DENS status_label der
      // er den rigtige kolonne — det er præcis den fordeling Martin ser i
      // Close's egen Leads Pipeline-visning. Har det INGEN opportunity
      // overhovedet, er kolonnen "Tabt" (rettelse nr. 2 — se kommentarblokken
      // over CLOSE_PURE_LEAD_STAGE_NAME).
      // BEVIDST UÆNDRET: person-, note-, dato- og custom field-felterne hentes
      // fortsat fra leads.csv-rækken, nøjagtig som for ethvert andet rent lead
      // — Leads-rækkens value/confidence har ingen modsvarende kolonner på
      // crm_leads og droppes. Det holder også GEN-KØRSEL-blokken ovenfor
      // idempotent: den efterfylder custom fields fra samme leads.csv-række.
      let stage;
      if (reclassRow) {
        const resolved = closeResolveReclassifiedLeadStage(leadStages, defaultLeadStage, reclassRow.status_label);
        stage = resolved.stage;
        if (resolved.fellBack) {
          const warnMsg = 'Lead-stage "' + resolved.targetName + '" findes ikke i Lead-pipelinen — faldt tilbage til "' + defaultLeadStage.name + '".';
          if (!summary.warnings.includes(warnMsg)) summary.warnings.push(warnMsg);
        }
        summary.reclassified_lead_stage_counts[stage.name] = (summary.reclassified_lead_stage_counts[stage.name] || 0) + 1;
        summary.leads_reclassified_from_leads_pipeline++;
        if (healedLeadIds.has(closeId)) summary.leads_reclassified_from_wrong_opportunity++;
      } else {
        // INGEN opportunity af nogen art — hverken Sales eller Leads. Se
        // kommentarblokken "RETTELSE nr. 2": disse ~1061 rå henvendelser skal
        // i "Tabt", IKKE i "Nyt lead". Bemærk at leads.csv's egen status_label
        // ("Nyt Lead" for alle 1061) BEVIDST ikke længere bruges som stage-
        // kilde her — den er Close's default-leadstatus og siger intet om at
        // leadet skulle være nyt. Reklassificerede leads ovenfor er uberørte.
        stage = pureLeadStage;
        summary.leads_imported_to_tabt++;
      }
      const note = String(row.description || '').trim() || null;
      const createdAt = closeToDbTimestamp(row.date_created) || closeNowTimestamp();
      const updatedAt = closeToDbTimestamp(row.date_updated) || createdAt;
      const position = nextLeadPosition(stage.id);

      const r = await pgOne(`
        INSERT INTO crm_leads (name,email,phone,address,source,note,pipeline_id,stage_id,owner_id,position,stage_changed_at,close_id,created_at,updated_at)
        VALUES ($1,$2,$3,$4,NULL,$5,$6,$7,NULL,$8,NULL,$9,$10,$11) RETURNING id
      `, [person.name, person.email, person.phone, person.address, note, leadPipeline.id, stage.id, position, closeId, createdAt, updatedAt]);

      await closeWriteCustomFields('lead', r.id, closeLeadCustomFieldValues(row), leadSourceCacheLead, projektTypeCacheLead);

      // Beslutning #3 — se filhoved-kommentaren: samme find-eller-opret-logik
      // som resten af appen, for ALLE importerede leads (ikke kun Won).
      const linked = await crmFindOrCreateContactAndCustomer(person.name, person.email, person.phone, person.address, note);
      await pool.query('UPDATE crm_leads SET contact_id=$1 WHERE id=$2', [linked.contactId, r.id]);
      if (linked.contactCreated) summary.contacts_created++; else summary.contacts_matched_existing++;
      if (linked.customerCreated) summary.customers_created++; else summary.customers_matched_existing++;

      summary.leads_imported++;
    } catch (e) {
      summary.errors.push('Lead ' + (row && row.id) + ' (' + (row && (row.primary_contact_name || row.display_name || '?')) + '): ' + e.message);
    }
  }

  // ── FASE 2: ÆGTE opportunities (pipeline_name='Sales') → Sales-pipelinen ──
  // BEMÆRK: her itereres over salesOppRows, IKKE oppRows. Rækkerne fra Close's
  // Leads Pipeline er allerede håndteret som leads i fase 0+1 ovenfor.
  for (const row of salesOppRows) {
    try {
      const closeId = row.id;
      const existing = await pgOne('SELECT id FROM crm_opportunities WHERE close_id=$1', [closeId]);
      // ── GEN-KØRSEL — se den tilsvarende blok i fase 1 for begrundelsen.
      // Samme begrænsning her: KUN crm_custom_field_values røres. Hverken
      // stage, position, contact_id, kunde/kontakt-koblingen eller
      // stage_changed_at ændres på et salg der allerede ligger i pipelinen.
      if (existing) {
        summary.opportunities_skipped_existing++;
        const cf = closeOppCustomFieldValues(row, row.lead_id ? leadsById.get(row.lead_id) : null);
        if (await closeWriteCustomFields('opportunity', existing.id, cf.values, leadSourceCacheOpp, projektTypeCacheOpp)) {
          summary.opportunities_custom_fields_refreshed++;
          if (cf.usedLeadFallback) summary.opportunity_custom_fields_from_lead++;
        }
        continue;
      }

      const leadRow = row.lead_id ? leadsById.get(row.lead_id) : null;
      let person;
      if (leadRow) {
        person = closeLeadPersonFields(leadRow);
      } else {
        person = { name: String(row.lead_name || row.contact_name || '').trim() || 'Ukendt navn (Close-import)', email: String(row.contact_email || '').trim() || null, phone: null, address: null };
        summary.warnings.push('Opportunity ' + closeId + ': tilhørende lead (lead_id "' + row.lead_id + '") blev ikke fundet i leads.csv — brugte begrænset fallback-data fra opportunities.csv.');
      }
      // opportunities.csv's EGEN "lead_name"-kolonne er reelt Close's sagstitel
      // (fx "Gulvslibning — Anni"), ikke bare personens navn — bruges som
      // sagens navn i Sales-pipelinen, adskilt fra kontaktens navn (person.name).
      const oppName = String(row.lead_name || '').trim() || person.name;

      const { stage, isCatchAll, targetName, notFoundInDb } = closeResolveOpportunityStage(oppStages, defaultOppStage, row);
      if (notFoundInDb) {
        const warnMsg = 'Target-stage "' + targetName + '" findes ikke i Sales-pipelinen — faldt tilbage til "' + defaultOppStage.name + '".';
        if (!summary.warnings.includes(warnMsg)) summary.warnings.push(warnMsg);
      } else if (isCatchAll) {
        const key = String(row.status_label || '').trim() || '(tom)';
        summary.opportunity_stage_fallback_counts[key] = (summary.opportunity_stage_fallback_counts[key] || 0) + 1;
      }

      const valueRaw = row.value;
      const value = valueRaw !== undefined && valueRaw !== '' && Number.isFinite(Number(valueRaw)) ? Number(valueRaw) : null;
      const confRaw = row.confidence;
      const probability = confRaw !== undefined && confRaw !== '' && Number.isFinite(Number(confRaw)) ? Number(confRaw) : null;
      const note = String(row.note || '').trim() || null;
      const createdAt = closeToDbTimestamp(row.date_created) || closeNowTimestamp();
      const updatedAt = closeToDbTimestamp(row.date_updated) || createdAt;
      const position = nextOppPosition(stage.id);

      // Beslutning #3 — se filhoved-kommentaren: samme find-eller-opret-logik
      // for ALLE importerede opportunities (ikke kun Won).
      const linked = await crmFindOrCreateContactAndCustomer(person.name, person.email, person.phone, person.address, note);
      if (linked.contactCreated) summary.contacts_created++; else summary.contacts_matched_existing++;
      if (linked.customerCreated) summary.customers_created++; else summary.customers_matched_existing++;

      const r = await pgOne(`
        INSERT INTO crm_opportunities (name,contact_id,pipeline_id,stage_id,value,probability,owner_id,note,position,stage_changed_at,close_id,created_at,updated_at)
        VALUES ($1,$2,$3,$4,$5,$6,NULL,$7,$8,NULL,$9,$10,$11) RETURNING id
      `, [oppName, linked.contactId, oppPipeline.id, stage.id, value, probability, note, position, closeId, createdAt, updatedAt]);

      const cf = closeOppCustomFieldValues(row, leadRow);
      if (await closeWriteCustomFields('opportunity', r.id, cf.values, leadSourceCacheOpp, projektTypeCacheOpp)) {
        if (cf.usedLeadFallback) summary.opportunity_custom_fields_from_lead++;
      }

      summary.opportunities_imported++;
    } catch (e) {
      summary.errors.push('Opportunity ' + (row && row.id) + ': ' + e.message);
    }
  }

  summary.lead_source_new_options_added = Array.from(leadSourceNewOptions);
  summary.projekt_type_new_options_added = Array.from(projektTypeNewOptions);
  summary.duration_ms = Date.now() - t0;
  await logSystemEvent('close_import', 'info', `Close CRM-import: ${summary.leads_imported} leads, ${summary.opportunities_imported} opportunities importeret (${summary.leads_skipped_existing}+${summary.opportunities_skipped_existing} fandtes i forvejen, heraf ${summary.leads_custom_fields_refreshed}+${summary.opportunities_custom_fields_refreshed} med opdaterede custom fields), ${summary.leads_reclassified_from_leads_pipeline} leads reklassificeret fra Close's Leads Pipeline (${summary.wrong_opportunities_deleted} fejlimporterede salg fjernet), ${summary.leads_imported_to_tabt} leads uden opportunity lagt i "Tabt" (+${summary.leads_moved_to_tabt} flyttet dertil fra "${defaultLeadStage.name}"), ${summary.lead_stages_created.length} nye lead-stages, ${summary.errors.length} fejl.`);
  res.json(summary);
}));

// Simpel opgave-tjekliste pr. lead/opportunity (Close-lignende "Tasks"-panel).
// Bevidst IKKE koblet til Daglig planlægning/Gantt — det er en helt separat,
// meget større planlægningsmotor. Dette er kun en let huskeliste på selve
// CRM-kortet, fx "Ring op i morgen", "Send tilbud".
app.get('/api/crm/tasks', auth, panelAccess('crmp_tasks'), asyncRoute(async (req, res) => {
  const { entity_type, entity_id } = req.query;
  if (!entity_type || !entity_id) return res.status(400).json({ error: 'entity_type og entity_id påkrævet' });
  const rows = (await pool.query(`
    SELECT t.*, u.name AS assigned_name, u.color AS assigned_color, u.initials AS assigned_initials
    FROM crm_tasks t LEFT JOIN users u ON u.id=t.assigned_to
    WHERE t.entity_type=$1 AND t.entity_id=$2 ORDER BY t.done ASC, t.id ASC
  `, [entity_type, entity_id])).rows;
  res.json(rows);
}));
// "Opfølgninger" — alle opgaver på tværs af leads/opportunities, samlet ét
// sted, så Martin og Sarah kan se hinandens (og egne) kommende opfølgninger
// og oprette/omfordele dem uden at skulle ind på hvert enkelt lead/opportunity.
// Skal registreres FØR GET /api/crm/tasks/:id, hvis den nogensinde tilføjes —
// ellers ville "overview" selv blive fortolket som et :id.
app.get('/api/crm/tasks/overview', auth, panelAccess('crmp_tasks'), asyncRoute(async (req, res) => {
  const includeDone = req.query.include_done === '1';
  const rows = (await pool.query(`
    SELECT t.*,
      COALESCE(l.name, o.name) AS entity_name,
      u.name AS assigned_name, u.color AS assigned_color, u.initials AS assigned_initials,
      cu.name AS created_by_name
    FROM crm_tasks t
    LEFT JOIN crm_leads l ON t.entity_type='lead' AND l.id=t.entity_id
    LEFT JOIN crm_opportunities o ON t.entity_type='opportunity' AND o.id=t.entity_id
    LEFT JOIN users u ON u.id=t.assigned_to
    LEFT JOIN users cu ON cu.id=t.created_by
    ${includeDone ? '' : 'WHERE t.done=0'}
    ORDER BY t.done ASC, (t.due_date IS NULL) ASC, t.due_date ASC, (t.due_time IS NULL) ASC, t.due_time ASC, t.id ASC
  `)).rows;
  res.json(rows);
}));
app.post('/api/crm/tasks', auth, panelAccess('crmp_tasks'), asyncRoute(async (req, res) => {
  const b = req.body || {};
  if (!b.entity_type || !b.entity_id || !String(b.title || '').trim()) return res.status(400).json({ error: 'Titel mangler' });
  const row = await pgOne(`
    INSERT INTO crm_tasks (entity_type,entity_id,title,assigned_to,created_by,due_date,due_time,priority)
    VALUES ($1,$2,$3,$4,$5,$6,$7,$8) RETURNING *
  `, [b.entity_type, b.entity_id, String(b.title).trim(), b.assigned_to || null, req.user.id, b.due_date || null, b.due_time || null, b.priority ? 1 : 0]);
  res.json(row);
}));
app.put('/api/crm/tasks/:id', auth, panelAccess('crmp_tasks'), asyncRoute(async (req, res) => {
  const b = req.body || {};
  const fields = [], values = [];
  if (b.title !== undefined) { fields.push(`title=$${fields.length + 1}`); values.push(String(b.title).trim()); }
  if (b.done !== undefined) { fields.push(`done=$${fields.length + 1}`); values.push(b.done ? 1 : 0); }
  if (b.assigned_to !== undefined) { fields.push(`assigned_to=$${fields.length + 1}`); values.push(b.assigned_to || null); }
  if (b.due_date !== undefined) { fields.push(`due_date=$${fields.length + 1}`); values.push(b.due_date || null); }
  if (b.due_time !== undefined) { fields.push(`due_time=$${fields.length + 1}`); values.push(b.due_time || null); }
  if (b.priority !== undefined) { fields.push(`priority=$${fields.length + 1}`); values.push(b.priority ? 1 : 0); }
  if (!fields.length) return res.json({ ok: true });
  values.push(req.params.id);
  await pool.query(`UPDATE crm_tasks SET ${fields.join(',')} WHERE id=$${values.length}`, values);
  res.json({ ok: true });
}));
app.delete('/api/crm/tasks/:id', auth, panelAccess('crmp_tasks'), asyncRoute(async (req, res) => {
  await pool.query('DELETE FROM crm_tasks WHERE id=$1', [req.params.id]);
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
// `exec` er valgfri og kan være enten poolen (standard) eller en klient midt i
// en transaktion — samme mønster som crmSetCustomFieldValues/crmLogActivity
// allerede bruger. Alle eksisterende kaldesteder udelader den og rammer derfor
// poolen præcis som før; kun JobTread-sagsimporten sender en transaktionsklient
// med, så spejlingen ruller tilbage sammen med resten hvis importen fejler.
async function mirrorProjectTaskToPool(id, project, fields, exec) {
  await (exec || pool).query(`
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
  // Pris/tilbudsbeløb sendes KUN med til kontor/økonomi-brugere (til søgning/visning
  // i admin.html's Projekter-liste) — aldrig til employee/employee-demo, som deler
  // dette samme endpoint til deres sagsliste og ikke må se priser.
  const includePrice = await isFinanceAdmin(req.user.id);
  const rows = await pool.query(`
    SELECT p.*, q.quote_number${includePrice ? ', q.total AS quote_total, i.total AS invoice_total' : ''},
      (SELECT COUNT(*)::int FROM gantt_tasks WHERE project_id=p.id) AS task_count,
      (SELECT COUNT(*)::int FROM time_entries WHERE project_id=p.id) AS time_entry_count,
      (SELECT COUNT(*)::int FROM project_photos WHERE project_id=p.id) AS photo_count
    FROM projects p LEFT JOIN quotes q ON q.id = p.quote_id${includePrice ? ' LEFT JOIN invoices i ON i.id = p.invoice_id' : ''}
    ORDER BY p.created_at DESC
  `);
  res.json(rows.rows);
}));

app.get('/api/projects/:id', auth, asyncRoute(async (req, res) => {
  const project = await pgOne('SELECT * FROM projects WHERE id=$1', [req.params.id]);
  if (!project) return res.status(404).json({ error: 'Projektet blev ikke fundet' });
  const [tasks, photos, timeEntries, materials, qaSubmissions, contactSubmissions, quoteLines, qaTemplateIds] = await Promise.all([
    pool.query('SELECT * FROM gantt_tasks WHERE project_id=$1 ORDER BY position ASC, id ASC', [req.params.id]).then(r => r.rows),
    pool.query('SELECT * FROM project_photos WHERE project_id=$1 ORDER BY created_at DESC', [req.params.id]).then(r => r.rows),
    pool.query('SELECT * FROM time_entries WHERE project_id=$1 ORDER BY entry_date DESC, id DESC', [req.params.id]).then(r => r.rows),
    pool.query('SELECT * FROM project_materials WHERE project_id=$1 ORDER BY created_at DESC', [req.params.id]).then(r => r.rows),
    pool.query('SELECT * FROM qa_submissions WHERE project_id=$1 ORDER BY submitted_at DESC', [req.params.id]).then(r => r.rows),
    pool.query('SELECT * FROM contact_form_submissions WHERE project_id=$1 ORDER BY submitted_at DESC', [req.params.id]).then(r => r.rows),
    project.quote_id
      ? pool.query('SELECT id, description FROM quote_lines WHERE quote_id=$1 ORDER BY position ASC, id ASC', [project.quote_id]).then(r => r.rows)
      : Promise.resolve([]),
    pool.query('SELECT qa_template_id FROM project_qa_templates WHERE project_id=$1', [req.params.id]).then(r => r.rows.map(x => x.qa_template_id))
  ]);
  res.json({ ...project, tasks, photos, time_entries: timeEntries, materials, qa_submissions: qaSubmissions, contact_form_submissions: contactSubmissions, quote_line_options: quoteLines, qa_template_ids: qaTemplateIds });
}));

// Projekt-budget (sep. 2026, Martins ønske #3 "Samlet budget visning under projekter"):
// Godkendt pris / Opkrævet / Restsaldo / Forventet omkostning / Forventet fortjeneste /
// Margin — samme opbygning som JobTread-billedet Martin sendte. adminOnly, fordi svaret
// afslører løn- og akkord-omkostninger pr. medarbejder, som ikke skal ses bredt af alle
// der har adgang til projekter-panelet.
app.get('/api/projects/:id/budget', auth, adminOnly, asyncRoute(async (req, res) => {
  const project = await pgOne('SELECT id, quote_id, invoice_id FROM projects WHERE id=$1', [req.params.id]);
  if (!project) return res.status(404).json({ error: 'Projektet blev ikke fundet' });

  const quote = project.quote_id ? await pgOne('SELECT id, total FROM quotes WHERE id=$1', [project.quote_id]) : null;
  const approved = quote ? Number(quote.total) || 0 : 0;

  // Opkrævet: betalinger på alle fakturaer der hører til sagen — både den direkte kobling
  // (projects.invoice_id) og evt. andre fakturaer lavet på samme tilbud (quote_id).
  const invoiceIds = new Set();
  if (project.invoice_id) invoiceIds.add(project.invoice_id);
  if (project.quote_id) {
    const rows = await pool.query('SELECT id FROM invoices WHERE quote_id=$1', [project.quote_id]).then(r => r.rows);
    rows.forEach(r => invoiceIds.add(r.id));
  }
  let collected = 0;
  if (invoiceIds.size) {
    const ids = [...invoiceIds];
    const ph = ids.map((_, i) => `$${i + 1}`).join(',');
    collected = await pool.query(`SELECT COALESCE(SUM(amount),0) AS s FROM invoice_payments WHERE invoice_id IN (${ph})`, ids)
      .then(r => Number(r.rows[0].s) || 0);
  }

  // Forventet omkostning ("cost to complete"): budgetteret kostpris fra tilbudslinjerne.
  // Vi har ikke løbende indkøbs-/materiale-tracking pr. sag, så dette er den bedste
  // tilgængelige proxy for de forventede materialeomkostninger.
  let costToComplete = 0;
  if (project.quote_id) {
    costToComplete = await pgOne(
      `SELECT COALESCE(SUM(cost_price * quantity), 0) AS s FROM quote_lines WHERE quote_id=$1 AND line_type='item'`,
      [project.quote_id]
    ).then(r => Number(r.s) || 0);
  }

  // Løn-/akkord-omkostning: hver tidsregistrering på sagen omregnes til kr ud fra
  // medarbejderens NUVÆRENDE lønform/-sats (der gemmes ikke en historisk sats pr. registrering).
  const laborRows = await pool.query(`
    SELECT te.id, te.user_id, te.minutes, te.akkord_item_id, te.akkord_quantity,
           u.name AS user_name, u.pay_type, u.hourly_wage,
           ai.name AS akkord_name, ai.rate AS akkord_rate
    FROM time_entries te
    LEFT JOIN users u ON u.id = te.user_id
    LEFT JOIN akkord_items ai ON ai.id = te.akkord_item_id
    WHERE te.project_id=$1
  `, [req.params.id]).then(r => r.rows);

  const byEmployee = new Map();
  let laborTotal = 0;
  for (const row of laborRows) {
    const isAkkord = !!(row.akkord_item_id && Number(row.akkord_quantity) > 0);
    const minutes = Number(row.minutes) || 0;
    const cost = isAkkord
      ? (Number(row.akkord_quantity) || 0) * (Number(row.akkord_rate) || 0)
      : (minutes / 60) * (Number(row.hourly_wage) || 0);
    laborTotal += cost;
    const key = row.user_id || 0;
    if (!byEmployee.has(key)) {
      byEmployee.set(key, { user_id: row.user_id, name: row.user_name || 'Ukendt medarbejder', pay_type: row.pay_type || 'hourly', minutes: 0, akkord_lines: [], cost: 0 });
    }
    const emp = byEmployee.get(key);
    emp.minutes += minutes;
    emp.cost += cost;
    if (isAkkord) emp.akkord_lines.push({ time_entry_id: row.id, item: row.akkord_name || '—', quantity: Number(row.akkord_quantity) || 0, rate: Number(row.akkord_rate) || 0, cost });
  }

  const profit = approved - costToComplete - laborTotal;
  const margin = approved > 0 ? (profit / approved) * 100 : 0;

  res.json({
    approved_price: approved,
    collected,
    remaining_balance: approved - collected,
    cost_to_complete: costToComplete,
    labor_cost: laborTotal,
    projected_profit: profit,
    projected_margin: margin,
    employees: [...byEmployee.values()]
  });
}));

// Kontoret vælger hvilke KS-skabeloner der er tilgængelige for medarbejderen på DENNE
// sag. Ingen rækker gemt = ingen begrænsning (alle skabeloner tilladt, bagudkompatibelt).
app.put('/api/projects/:id/qa-templates', auth, panelAccess('projects'), asyncRoute(async (req, res) => {
  const project = await pgOne('SELECT id FROM projects WHERE id=$1', [req.params.id]);
  if (!project) return res.status(404).json({ error: 'Projektet blev ikke fundet' });
  const ids = Array.isArray(req.body && req.body.template_ids) ? req.body.template_ids.map(Number).filter(Boolean) : [];
  await pool.query('DELETE FROM project_qa_templates WHERE project_id=$1', [req.params.id]);
  if (ids.length) {
    const values = ids.map((_, i) => `($1,$${i + 2})`).join(',');
    await pool.query(`INSERT INTO project_qa_templates (project_id, qa_template_id) VALUES ${values} ON CONFLICT DO NOTHING`, [req.params.id, ...ids]);
  }
  res.json({ ok: true });
}));

app.put('/api/projects/:id', auth, panelAccess('projects'), asyncRoute(async (req, res) => {
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
app.post('/api/projects/:id/convert-quote-lines', auth, panelAccess('projects'), asyncRoute(async (req, res) => {
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

app.post('/api/projects/:id/tasks', auth, panelAccess('projects'), asyncRoute(async (req, res) => {
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

app.put('/api/projects/:id/tasks/:taskId', auth, panelAccess('projects'), asyncRoute(async (req, res) => {
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

app.delete('/api/projects/:id/tasks/:taskId', auth, panelAccess('projects'), asyncRoute(async (req, res) => {
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

app.delete('/api/projects/:id/photos/:photoId', auth, panelAccess('projects'), asyncRoute(async (req, res) => {
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
  // Billeder: understøt både det gamle enkelt-felt (photo_url) og en liste (photo_urls).
  // En medarbejders egen registrering kræver stadig mindst ét billede som dokumentation.
  // Kontorets manuelle registreringer (finance/admin, evt. for en anden medarbejder)
  // kan undtagelsesvist gemmes uden billede, da de typisk indtastes efterfølgende.
  let photoUrls = Array.isArray(b.photo_urls) ? b.photo_urls.filter(Boolean).map(String) : [];
  if (!photoUrls.length && b.photo_url) photoUrls = [String(b.photo_url)];
  // Valgfri user_id: kun kontor/økonomi-brugere må registrere tid FOR en anden medarbejder.
  let targetUserId = req.user.id;
  if (b.user_id && Number(b.user_id) !== req.user.id) {
    if (!(await isFinanceAdmin(req.user.id))) return res.status(403).json({ error: 'Kun kontoret kan registrere tid for andre medarbejdere' });
    targetUserId = Number(b.user_id);
  }
  const isManualByOffice = targetUserId !== req.user.id || (b.manual && await isFinanceAdmin(req.user.id));
  // Akkord (sep. 2026): en akkord-lønnet medarbejder logger en post fra akkordlisten +
  // antal i stedet for (eller ud over) minutter — se akkord_items. Minutter er stadig
  // nyttigt til historik/planlægning og forbliver påkrævet MEDMINDRE der er angivet en
  // gyldig akkord-post, for ikke at gøre timeregistrering unødigt besværlig for alle andre.
  const akkordItemId = b.akkord_item_id ? Number(b.akkord_item_id) : null;
  const akkordQuantity = Math.max(0, Number(b.akkord_quantity) || 0);
  const hasAkkord = akkordItemId && akkordQuantity > 0;
  if (!note) return res.status(400).json({ error: 'Skriv en note om det udførte arbejde' });
  if (!photoUrls.length && !isManualByOffice) return res.status(400).json({ error: 'Upload et billede som dokumentation' });
  if ((!minutes || minutes <= 0) && !hasAkkord) return res.status(400).json({ error: 'Angiv hvor mange minutter der er brugt, eller vælg en akkord-post' });
  const entryDate = validDate(b.entry_date) ? b.entry_date : new Date().toISOString().slice(0, 10);
  const r = await pool.query(`
    INSERT INTO time_entries (project_id,user_id,minutes,note,photo_url,photo_urls,bought_materials,quote_line_id,entry_date,created_by,akkord_item_id,akkord_quantity)
    VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12) RETURNING id
  `, [req.params.id, targetUserId, Math.max(0, Math.round(minutes) || 0), note, photoUrls[0] || null, JSON.stringify(photoUrls), b.bought_materials || null, b.quote_line_id || null, entryDate, req.user.id, hasAkkord ? akkordItemId : null, hasAkkord ? akkordQuantity : 0]);
  res.json({ ok: true, id: r.rows[0].id });
}));

// Redigering er forbeholdt kontoret/økonomi — en medarbejder kan ikke selv rette en
// registrering bagefter, kun oprette og (indirekte, via kontoret) få den rettet.
app.put('/api/projects/:id/time-entries/:entryId', auth, panelAccess('projects'), asyncRoute(async (req, res) => {
  const existing = await pgOne('SELECT id FROM time_entries WHERE id=$1 AND project_id=$2', [req.params.entryId, req.params.id]);
  if (!existing) return res.status(404).json({ error: 'Tidsregistreringen blev ikke fundet' });
  const b = req.body || {};
  const note = String(b.note || '').trim();
  const minutes = Number(b.minutes);
  const akkordItemId = b.akkord_item_id ? Number(b.akkord_item_id) : null;
  const akkordQuantity = Math.max(0, Number(b.akkord_quantity) || 0);
  const hasAkkord = akkordItemId && akkordQuantity > 0;
  if (!note) return res.status(400).json({ error: 'Skriv en note om det udførte arbejde' });
  if ((!minutes || minutes <= 0) && !hasAkkord) return res.status(400).json({ error: 'Angiv hvor mange minutter der er brugt, eller vælg en akkord-post' });
  if (!b.user_id) return res.status(400).json({ error: 'Vælg en medarbejder' });
  const entryDate = validDate(b.entry_date) ? b.entry_date : new Date().toISOString().slice(0, 10);
  let photoUrls = Array.isArray(b.photo_urls) ? b.photo_urls.filter(Boolean).map(String) : [];
  if (!photoUrls.length && b.photo_url) photoUrls = [String(b.photo_url)];
  await pool.query(`
    UPDATE time_entries SET user_id=$1, minutes=$2, note=$3, photo_url=$4, photo_urls=$5,
      bought_materials=$6, quote_line_id=$7, entry_date=$8, updated_at=${nowTextSQL()}, akkord_item_id=$9, akkord_quantity=$10
    WHERE id=$11 AND project_id=$12
  `, [Number(b.user_id), Math.max(0, Math.round(minutes) || 0), note, photoUrls[0] || null, JSON.stringify(photoUrls), b.bought_materials || null, b.quote_line_id || null, entryDate, hasAkkord ? akkordItemId : null, hasAkkord ? akkordQuantity : 0, req.params.entryId, req.params.id]);
  res.json({ ok: true });
}));

app.delete('/api/projects/:id/time-entries/:entryId', auth, panelAccess('projects'), asyncRoute(async (req, res) => {
  await pool.query('DELETE FROM time_entries WHERE id=$1 AND project_id=$2', [req.params.entryId, req.params.id]);
  res.json({ ok: true });
}));

// ── MINE TIDSREGISTRERINGER — medarbejderens egen samlede oversigt på tværs
// af alle sager ("Mine timer"), så de kan se alt de har indberettet ét sted
// og selv rette en fejl (forkert antal minutter/note/dato), i stedet for at
// skulle bede kontoret om det. Bevidst afgrænset ift. ovenstående kontor-vej:
// en medarbejder må kun se/rette/slette SINE EGNE registreringer (tjekket her
// server-side via entry.user_id===req.user.id), og må ikke omregistrere en
// post til en anden medarbejder eller ændre billeder/materialer/tilbudslinje
// — det kræver stadig kontorets fulde redigeringsvej ovenfor.
app.get('/api/time-entries/mine', auth, asyncRoute(async (req, res) => {
  const rows = await pool.query(`
    SELECT te.*, p.name AS project_name
    FROM time_entries te
    JOIN projects p ON p.id = te.project_id
    WHERE te.user_id = $1
    ORDER BY te.entry_date DESC, te.created_at DESC, te.id DESC
  `, [req.user.id]);
  res.json(rows.rows);
}));

app.put('/api/time-entries/:entryId', auth, asyncRoute(async (req, res) => {
  const existing = await pgOne('SELECT * FROM time_entries WHERE id=$1', [req.params.entryId]);
  if (!existing) return res.status(404).json({ error: 'Tidsregistreringen blev ikke fundet' });
  if (Number(existing.user_id) !== req.user.id && !(await isFinanceAdmin(req.user.id))) {
    return res.status(403).json({ error: 'Du kan kun rette dine egne registreringer' });
  }
  const b = req.body || {};
  const note = String(b.note || '').trim();
  const minutes = Number(b.minutes);
  if (!note) return res.status(400).json({ error: 'Skriv en note om det udførte arbejde' });
  if (!minutes || minutes <= 0) return res.status(400).json({ error: 'Angiv hvor mange minutter der er brugt' });
  const entryDate = validDate(b.entry_date) ? b.entry_date : existing.entry_date;
  await pool.query(`
    UPDATE time_entries SET minutes=$1, note=$2, entry_date=$3, updated_at=${nowTextSQL()} WHERE id=$4
  `, [Math.round(minutes), note, entryDate, req.params.entryId]);
  res.json({ ok: true });
}));

app.delete('/api/time-entries/:entryId', auth, asyncRoute(async (req, res) => {
  const existing = await pgOne('SELECT user_id FROM time_entries WHERE id=$1', [req.params.entryId]);
  if (!existing) return res.status(404).json({ error: 'Tidsregistreringen blev ikke fundet' });
  if (Number(existing.user_id) !== req.user.id && !(await isFinanceAdmin(req.user.id))) {
    return res.status(403).json({ error: 'Du kan kun slette dine egne registreringer' });
  }
  await pool.query('DELETE FROM time_entries WHERE id=$1', [req.params.entryId]);
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

app.delete('/api/projects/:id/materials/:materialId', auth, panelAccess('projects'), asyncRoute(async (req, res) => {
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
app.post('/api/projects/:id/materials/:materialId/invoice', auth, panelAccess('projects'), asyncRoute(async (req, res) => {
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
  // ?project_id=X: brugt af medarbejder-appen for kun at vise de skabeloner kontoret
  // har tildelt DEN sag. Har sagen ingen tildelinger endnu, vises alle (bagudkompatibelt).
  let rows;
  if (req.query.project_id) {
    const assignedIds = await pool.query('SELECT qa_template_id FROM project_qa_templates WHERE project_id=$1', [req.query.project_id]).then(r => r.rows.map(x => x.qa_template_id));
    rows = assignedIds.length
      ? await pool.query('SELECT * FROM qa_templates WHERE id = ANY($1::int[]) ORDER BY name', [assignedIds])
      : await pool.query('SELECT * FROM qa_templates ORDER BY name');
  } else {
    rows = await pool.query('SELECT * FROM qa_templates ORDER BY name');
  }
  res.json(rows.rows.map(r => ({ ...r, fields: typeof r.fields === 'string' ? safeJsonParse(r.fields, []) : (r.fields || []) })));
}));

app.post('/api/qa-templates', auth, panelAccess('projects'), asyncRoute(async (req, res) => {
  const b = req.body || {};
  const name = String(b.name || '').trim();
  if (!name) return res.status(400).json({ error: 'Skriv et navn til skabelonen' });
  const fields = Array.isArray(b.fields) ? b.fields : [];
  const r = await pool.query('INSERT INTO qa_templates (name,fields) VALUES ($1,$2) RETURNING id', [name, JSON.stringify(fields)]);
  res.json({ ok: true, id: r.rows[0].id });
}));

app.put('/api/qa-templates/:id', auth, panelAccess('projects'), asyncRoute(async (req, res) => {
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

app.delete('/api/qa-templates/:id', auth, panelAccess('projects'), asyncRoute(async (req, res) => {
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

app.delete('/api/qa-submissions/:id', auth, panelAccess('projects'), asyncRoute(async (req, res) => {
  await pool.query('DELETE FROM qa_submissions WHERE id=$1', [req.params.id]);
  res.json({ ok: true });
}));

// ── KONTAKTFORMULAR — samme mønster som KS-skabeloner ovenfor, blot en
// separat skabelon-/besvarelses-tabel så de to formål ikke blandes sammen. ──
app.get('/api/contact-form-templates', auth, asyncRoute(async (req, res) => {
  const rows = await pool.query('SELECT * FROM contact_form_templates ORDER BY name');
  res.json(rows.rows.map(r => ({ ...r, fields: typeof r.fields === 'string' ? safeJsonParse(r.fields, []) : (r.fields || []) })));
}));

app.post('/api/contact-form-templates', auth, panelAccess('projects'), asyncRoute(async (req, res) => {
  const b = req.body || {};
  const name = String(b.name || '').trim();
  if (!name) return res.status(400).json({ error: 'Skriv et navn til formularen' });
  const fields = Array.isArray(b.fields) ? b.fields : [];
  const r = await pool.query('INSERT INTO contact_form_templates (name,fields) VALUES ($1,$2) RETURNING id', [name, JSON.stringify(fields)]);
  res.json({ ok: true, id: r.rows[0].id });
}));

app.put('/api/contact-form-templates/:id', auth, panelAccess('projects'), asyncRoute(async (req, res) => {
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

app.delete('/api/contact-form-templates/:id', auth, panelAccess('projects'), asyncRoute(async (req, res) => {
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

app.delete('/api/contact-form-submissions/:id', auth, panelAccess('projects'), asyncRoute(async (req, res) => {
  await pool.query('DELETE FROM contact_form_submissions WHERE id=$1', [req.params.id]);
  res.json({ ok: true });
}));

// ── HURTIG FAKTURERING FRA TIDSREGISTRERING — tager en registrering (evt.
// med indkøbte materialer) og lægger den som ny linje/linjer på sagens
// faktura, klar til Martin blot skal sætte prisen og sende. Kræver at
// tilbuddet allerede er konverteret til faktura — der findes bevidst ingen
// "opret tom faktura"-vej i systemet, faktura skabes altid fra et tilbud. ──
app.post('/api/projects/:id/time-entries/:entryId/invoice', auth, panelAccess('projects'), asyncRoute(async (req, res) => {
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
app.get('/api/customers/history', auth, panelAccess('customers'), asyncRoute(async (req, res) => {
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
app.post('/api/templates', auth, panelAccess('templates'), asyncRoute(async (req, res) => {
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
app.put('/api/templates/:id', auth, panelAccess('templates'), asyncRoute(async (req, res) => {
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
app.delete('/api/templates/:id', auth, panelAccess('templates'), asyncRoute(async (req, res) => {
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
app.post('/api/email-templates', auth, panelAccess('email-templates'), asyncRoute(async (req, res) => {
  const body = req.body || {};
  if (!body.name || !body.subject || !body.body) return res.status(400).json({ error: 'Navn, emne og indhold skal udfyldes' });
  const r = await pool.query(`
    INSERT INTO email_templates (name,subject,body,updated_at) VALUES ($1,$2,$3,${nowTextSQL()}) RETURNING id
  `, [String(body.name).trim().slice(0, 200), String(body.subject).trim().slice(0, 300), String(body.body).slice(0, 5000)]);
  res.json({ ok: true, id: r.rows[0].id });
}));
app.put('/api/email-templates/:id', auth, panelAccess('email-templates'), asyncRoute(async (req, res) => {
  const body = req.body || {};
  const r = await pool.query(`
    UPDATE email_templates SET name=$1,subject=$2,body=$3,updated_at=${nowTextSQL()} WHERE id=$4
  `, [String(body.name || '').trim().slice(0, 200), String(body.subject || '').trim().slice(0, 300), String(body.body || '').slice(0, 5000), req.params.id]);
  if (!r.rowCount) return res.status(404).json({ error: 'Skabelonen blev ikke fundet' });
  res.json({ ok: true });
}));
app.delete('/api/email-templates/:id', auth, panelAccess('email-templates'), asyncRoute(async (req, res) => {
  await pool.query('DELETE FROM email_templates WHERE id=$1', [req.params.id]);
  res.json({ ok: true });
}));

// ── MAIL-SKABELONER TIL TILBUD/FAKTURA (HTML) ──
app.get('/api/document-email-templates', auth, panelAccess('email-templates'), asyncRoute(async (req, res) => {
  const rows = await pool.query('SELECT * FROM document_email_templates ORDER BY name ASC');
  res.json(rows.rows);
}));
app.post('/api/document-email-templates', auth, panelAccess('email-templates'), asyncRoute(async (req, res) => {
  const body = req.body || {};
  if (!body.name || !body.subject || !body.body_html) return res.status(400).json({ error: 'Navn, emne og indhold skal udfyldes' });
  const r = await pool.query(`
    INSERT INTO document_email_templates (name,subject,body_html,updated_at) VALUES ($1,$2,$3,${nowTextSQL()}) RETURNING id
  `, [String(body.name).trim().slice(0, 200), String(body.subject).trim().slice(0, 300), String(body.body_html).slice(0, 40000)]);
  res.json({ ok: true, id: r.rows[0].id });
}));
app.put('/api/document-email-templates/:id', auth, panelAccess('email-templates'), asyncRoute(async (req, res) => {
  const body = req.body || {};
  const r = await pool.query(`
    UPDATE document_email_templates SET name=$1,subject=$2,body_html=$3,updated_at=${nowTextSQL()} WHERE id=$4
  `, [String(body.name || '').trim().slice(0, 200), String(body.subject || '').trim().slice(0, 300), String(body.body_html || '').slice(0, 40000), req.params.id]);
  if (!r.rowCount) return res.status(404).json({ error: 'Skabelonen blev ikke fundet' });
  res.json({ ok: true });
}));
app.delete('/api/document-email-templates/:id', auth, panelAccess('email-templates'), asyncRoute(async (req, res) => {
  await pool.query('DELETE FROM document_email_templates WHERE id=$1', [req.params.id]);
  res.json({ ok: true });
}));

// ── SAMLET SKABELON-CENTER (Skabeloner i topmenuen) ──────────────────
// "Singulære" system-mails — ét aktivt eksemplar pr. key, redigeres inline
// (ingen separat opret/slet, kun de faste keys sat i initSchema()).
app.get('/api/system-email-templates', auth, panelAccess('email-templates'), asyncRoute(async (req, res) => {
  const rows = await pool.query('SELECT * FROM system_email_templates ORDER BY key ASC');
  res.json(rows.rows);
}));
app.put('/api/system-email-templates/:key', auth, panelAccess('email-templates'), asyncRoute(async (req, res) => {
  const body = req.body || {};
  const fields = [], values = [];
  if (body.subject !== undefined) { fields.push(`subject=$${fields.length + 1}`); values.push(String(body.subject).trim().slice(0, 300)); }
  if (body.body_html !== undefined) { fields.push(`body_html=$${fields.length + 1}`); values.push(String(body.body_html).slice(0, 40000)); }
  if (body.enabled !== undefined) { fields.push(`enabled=$${fields.length + 1}`); values.push(body.enabled ? 1 : 0); }
  if (!fields.length) return res.json({ ok: true });
  fields.push(`updated_at=${nowTextSQL()}`);
  values.push(req.params.key);
  const r = await pool.query(`UPDATE system_email_templates SET ${fields.join(',')} WHERE key=$${values.length}`, values);
  if (!r.rowCount) return res.status(404).json({ error: 'Skabelonen blev ikke fundet' });
  res.json({ ok: true });
}));

// Brugerdefinerede skabeloner uden fast automatisk handling (endnu) — frit
// opret/redigér/slet, jf. Martins ønske om løbende at kunne oprette flere.
app.get('/api/custom-email-templates', auth, panelAccess('email-templates'), asyncRoute(async (req, res) => {
  const rows = await pool.query('SELECT * FROM custom_email_templates ORDER BY name ASC');
  res.json(rows.rows);
}));
app.post('/api/custom-email-templates', auth, panelAccess('email-templates'), asyncRoute(async (req, res) => {
  const body = req.body || {};
  if (!body.name || !body.subject || !body.body_html) return res.status(400).json({ error: 'Navn, emne og indhold skal udfyldes' });
  const r = await pool.query(`
    INSERT INTO custom_email_templates (name,subject,body_html,updated_at) VALUES ($1,$2,$3,${nowTextSQL()}) RETURNING id
  `, [String(body.name).trim().slice(0, 200), String(body.subject).trim().slice(0, 300), String(body.body_html).slice(0, 40000)]);
  res.json({ ok: true, id: r.rows[0].id });
}));
app.put('/api/custom-email-templates/:id', auth, panelAccess('email-templates'), asyncRoute(async (req, res) => {
  const body = req.body || {};
  const r = await pool.query(`
    UPDATE custom_email_templates SET name=$1,subject=$2,body_html=$3,updated_at=${nowTextSQL()} WHERE id=$4
  `, [String(body.name || '').trim().slice(0, 200), String(body.subject || '').trim().slice(0, 300), String(body.body_html || '').slice(0, 40000), req.params.id]);
  if (!r.rowCount) return res.status(404).json({ error: 'Skabelonen blev ikke fundet' });
  res.json({ ok: true });
}));
app.delete('/api/custom-email-templates/:id', auth, panelAccess('email-templates'), asyncRoute(async (req, res) => {
  await pool.query('DELETE FROM custom_email_templates WHERE id=$1', [req.params.id]);
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
app.get('/api/notification-settings', auth, panelAccess('notif-settings'), asyncRoute(async (req, res) => {
  await ensureNotificationRulesSeeded();
  const rows = await pool.query('SELECT * FROM notification_rules ORDER BY event_key ASC');
  res.json(rows.rows);
}));
app.put('/api/notification-settings/:eventKey', auth, panelAccess('notif-settings'), asyncRoute(async (req, res) => {
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
app.get('/api/dashboard/overview', auth, panelAccess('dashboard'), asyncRoute(async (req, res) => {
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

app.get('/api/dashboard/capacity-forecast', auth, panelAccess('dashboard'), asyncRoute(async (req, res) => {
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

app.get('/api/dashboard/kpis', auth, panelAccess('dashboard'), asyncRoute(async (req, res) => {
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
app.get('/api/customers/portal-link', auth, panelAccess('customers'), asyncRoute(async (req, res) => {
  const name = String(req.query.name || '').trim();
  if (!name) return res.status(400).json({ error: 'Mangler kundenavn' });
  const token = await getOrCreateCustomerPortalToken(name);
  if (!token) return res.status(400).json({ error: 'Kunne ikke oprette link' });
  res.json({ ok: true, url: customerPortalLinkFor(token) });
}));

// Send kundeportal-linket direkte til kunden pr. mail fra projekt-siden (Runde H
// #7: "Kundehistorik burde fjernes, der burde automatisk oprettes en
// kundeplatform... så man bare kan trykke send"). Genbruger samme
// getOrCreateCustomerPortalToken/customerPortalLinkFor som den ældre
// GET /api/customers/portal-link (Kundehistorik) brugte til at hente linket —
// denne rute går skridtet videre og sender det som mail via sendMailUniversal,
// helt uafhængigt af Gmail-forbindelsen (se sendMailUniversal-kommentaren).
app.post('/api/projects/:id/send-portal-link', auth, panelAccess('projects'), asyncRoute(async (req, res) => {
  const project = await pgOne('SELECT * FROM projects WHERE id=$1', [req.params.id]);
  if (!project) return res.status(404).json({ error: 'Projektet blev ikke fundet' });
  if (!project.customer_email) return res.status(400).json({ error: 'Kunden har ingen e-mail registreret på sagen' });
  if (!mailIsConfigured()) return res.status(400).json({ error: 'E-mail er ikke konfigureret på serveren' });
  const token = await getOrCreateCustomerPortalToken(project.name);
  if (!token) return res.status(400).json({ error: 'Kunne ikke oprette kundeportal-link' });
  const link = customerPortalLinkFor(token);
  const settingsRows = await pool.query("SELECT key,value FROM app_settings WHERE key='company_name'");
  const companyName = settingsRows.rows[0]?.value || 'Gulv Master Enterprise ApS';
  const subject = `Din side hos ${companyName}`;
  const html = `<p>Hej,</p><p>Her er linket til din side hos ${companyName}, hvor du altid kan se status på jeres sag(er), tilbud og fakturaer:</p><p><a href="${link}">${link}</a></p>`;
  try {
    await sendMailUniversal({ to: project.customer_email, subject, html, text: html.replace(/<[^>]+>/g, ' ') });
    await logSystemEvent('portal-link', 'info', `Kundeportal-link sendt til ${project.customer_email} for "${project.name}"`);
    res.json({ ok: true, url: link, to: project.customer_email });
  } catch (e) {
    await logSystemEvent('portal-link', 'error', `Kunne ikke sende kundeportal-link for "${project.name}": ${e.message}`);
    res.status(500).json({ error: 'Kunne ikke sende mailen: ' + e.message });
  }
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
app.post('/api/assignments/:id/send-scheduled-email', auth, panelAccess('plan'), asyncRoute(async (req, res) => {
  const current = await pgOne('SELECT * FROM planning_bookings WHERE id=$1', [req.params.id]);
  if (!current) return res.status(404).json({ error: 'Bookingen blev ikke fundet' });
  const result = await sendScheduledEmail(current, (req.body || {}).template_id || null);
  if (!result.sent) return res.status(400).json({ error: result.reason || 'Kunne ikke sende mailen' });
  res.json({ ok: true });
}));

// Henter (og opretter ved behov) det offentlige kundelink for én booking, til
// "🔗 Hent kunde-status-link"-knappen i booking-popup'en — uafhængigt af om der
// nogensinde sendes en mail, så du fx også kan sende linket manuelt via SMS.
app.get('/api/assignments/:id/portal-link', auth, panelAccess('plan'), asyncRoute(async (req, res) => {
  const current = await pgOne('SELECT id FROM planning_bookings WHERE id=$1', [req.params.id]);
  if (!current) return res.status(404).json({ error: 'Bookingen blev ikke fundet' });
  const token = await getOrCreateBookingToken(current.id);
  res.json({ ok: true, url: portalLinkFor(token) });
}));

// Fælles motor for både "Vi kommer i morgen" og "Vi kommer i dag" — kun
// dagsoffset (0=i dag, 1=i morgen), sendt-flag-kolonne og skabelon-key
// adskiller de to, så de aldrig blokerer hinanden eller sender dobbelt.
// Emne/besked hentes nu fra det samlede Skabeloner-center (system_email_templates),
// i stedet for at være hårdkodet — se leveringsnoten om konsolideringen.
async function sendReminderEmailsGeneric(dayOffset, sentAtColumn, templateKey) {
  if (!mailIsConfigured()) return { sent: 0, reason: 'E-mail er ikke konfigureret på serveren' };
  const targetDate = new Date(); targetDate.setDate(targetDate.getDate() + dayOffset);
  const iso = targetDate.toISOString().slice(0, 10);
  // DISTINCT ON (task_id): hvis samme opgave ved en fejl er booket flere gange samme
  // dag, skal kunden kun have ÉN påmindelse, ikke én pr. duplikeret booking-række.
  const sysTpl = await pgOne('SELECT * FROM system_email_templates WHERE key=$1', [templateKey]);
  if (sysTpl && !sysTpl.enabled) return { sent: 0, reason: 'Skabelonen "' + sysTpl.name + '" er slået fra i Skabeloner-centeret' };
  const rows = await pool.query(`
    SELECT DISTINCT ON (b.task_id) b.*, t.job_name, t.customer_email FROM planning_bookings b JOIN jt_tasks t ON b.task_id=t.id
    WHERE b.start_date=$1 AND COALESCE(b.planning_mode,'daily')='daily' AND b.${sentAtColumn} IS NULL AND t.customer_email IS NOT NULL
    ORDER BY b.task_id, b.id ASC
  `, [iso]);
  const settingsRows = await pool.query("SELECT key,value FROM app_settings WHERE key='company_name'");
  const companyName = settingsRows.rows[0]?.value || 'Gulv Master Enterprise ApS';
  const dagOrd = dayOffset === 0 ? 'i dag' : 'i morgen';
  let sentCount = 0;
  for (const b of rows.rows) {
    const portalToken = b.job_name ? await getOrCreateCustomerPortalToken(b.job_name) : null;
    const portalLink = portalToken ? customerPortalLinkFor(portalToken) : '';
    const vars = {
      kunde: b.job_name, opgave: b.job_name, firma: companyName,
      tidspunkt: b.start_time ? ' kl. ' + b.start_time : '',
      link: portalLink
    };
    const subject = fillDocEmailVars(sysTpl?.subject || `Vi kommer ${dagOrd} — ${companyName}`, vars);
    let text = fillDocEmailVars(
      sysTpl?.body_html || `Hej,\n\nVi vil bare give dig besked om, at vi kommer ${dagOrd}{{tidspunkt}} og udfører ({{opgave}}).\n\nDu kan altid se status på din opgave her: {{link}}\n\nVenlig hilsen\n{{firma}}`,
      vars
    );
    // Hvis {{link}} er tom (ingen sags-portal endnu), ryd tomme linjer op i stedet
    // for at lade "her: " stå og pege på ingenting.
    text = text.split('\n').filter(l => l.trim() !== '' || true).join('\n').replace(/^Du kan altid se status på din opgave her: \s*$/m, '').replace(/\n{3,}/g, '\n\n');
    let status = 'sent', error = null;
    try { await sendMailUniversal({ to: b.customer_email, subject, text, html: text.split('\n').map(l => l ? `<p>${l.replace(/</g, '&lt;')}</p>` : '<br>').join('') }); sentCount++; }
    catch (e) { status = 'error'; error = redactSecret(e.message || '').slice(0, 500); }
    await pool.query('INSERT INTO customer_schedule_emails (booking_id,task_id,kind,to_email,status,error) VALUES ($1,$2,$3,$4,$5,$6)', [b.id, b.task_id, dayOffset === 0 ? 'reminder_today' : 'reminder', b.customer_email, status, error]);
    // Marker ALLE bookinger for samme opgave+dato som sendt, ikke kun den ene, så en
    // evt. duplikeret booking ikke selv trigger endnu en påmindelse.
    await pool.query(`UPDATE planning_bookings SET ${sentAtColumn}=${nowTextSQL()} WHERE task_id=$1 AND start_date=$2`, [b.task_id, iso]);
  }
  return { sent: sentCount, candidates: rows.rows.length };
}
async function sendReminderEmails() {
  return sendReminderEmailsGeneric(1, 'reminder_email_sent_at', 'reminder_tomorrow');
}
async function sendTodayReminderEmails() {
  return sendReminderEmailsGeneric(0, 'reminder_today_email_sent_at', 'reminder_today');
}

// "Din montør kommer i morgen"-SMS — samme kandidat-logik som mail-påmindelsen
// ovenfor (én pr. opgave, kun i morgens bookinger, kun daglige bookinger — ikke
// kapacitetsblokke), men kræver customer_phone i stedet for customer_email, og
// har sit eget "allerede sendt"-flag (sms_reminder_sent_at) så de to kanaler ikke
// blokerer hinanden — en kunde med både e-mail og telefon skal gerne have begge.
async function sendReminderSms() {
  if (!smsIsConfigured()) return { sent: 0, reason: 'SMS er ikke konfigureret på serveren (INMOBILE_API_TOKEN/GATEWAYAPI_API_TOKEN/TWILIO_*)' };
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
  let smsResult = { sent: 0, reason: 'SMS er ikke konfigureret på serveren (INMOBILE_API_TOKEN/GATEWAYAPI_API_TOKEN/TWILIO_*)' };
  try { smsResult = await sendReminderSms(); } catch (e) { smsResult = { sent: 0, reason: e.message }; }
  res.json({ ok: true, ...emailResult, sms_sent: smsResult.sent, sms_candidates: smsResult.candidates || 0, sms_reason: smsResult.reason || null });
}));
// "Vi kommer i DAG"-varianten — samme manuelle knap-mønster som "i morgen"
// ovenfor, men til dagens bookinger og med sit eget skabelon/sendt-flag, så de
// to ikke griber ind i hinanden. Kun mail (ingen SMS-variant, jf. Martins ønske).
app.post('/api/customer-emails/send-today-reminders', auth, adminOnly, asyncRoute(async (req, res) => {
  const emailResult = await sendTodayReminderEmails();
  res.json({ ok: true, ...emailResult });
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

// ── Automatisk opfølgning på tabte leads/sager (Martins "5 dage i lost med
// et tilbud"-ønske) — samme skan-mønster som runDunningScan ovenfor, bare på
// crm_leads/crm_opportunities i stedet for fakturaer. Tjekker BEGGE tabeller,
// finder rækker der ligger i en stage markeret "Tabt" (is_lost=1), og som har
// gjort det i mindst X dage (stage_changed_at — se kommentaren ved den
// kolonne). Dedupe: en crm_activities-række med kind='lost_followup_sent' er
// selve "sendt allerede"-flaget, så scanningen aldrig sender to gange til
// samme lead/sag, uanset hvor mange gange den kører.
async function runLostFollowupScan(triggeredManually) {
  const settings = await pgOne('SELECT * FROM crm_lost_followup_settings WHERE id=1');
  if (!settings || (!settings.enabled && !triggeredManually)) return { ran: false, reason: 'Slået fra' };
  if (!mailIsConfigured()) return { ran: false, reason: 'E-mail er ikke konfigureret' };
  const days = Number(settings.days_threshold) || 5;
  let sent = 0, skippedNoEmail = 0, skippedNoQuote = 0;

  for (const entityType of ['lead', 'opportunity']) {
    const table = entityType === 'lead' ? 'crm_leads' : 'crm_opportunities';
    const extraCols = entityType === 'lead' ? ', t.name, t.email, t.phone' : '';
    const rows = (await pool.query(`
      SELECT t.id, t.stage_changed_at, t.contact_id${extraCols}
      FROM ${table} t JOIN crm_stages s ON s.id = t.stage_id
      WHERE s.is_lost = 1 AND t.stage_changed_at IS NOT NULL
    `)).rows;
    for (const row of rows) {
      const daysOld = Math.floor((Date.now() - new Date(row.stage_changed_at)) / 86400000);
      if (daysOld < days) continue;
      const already = await pgOne("SELECT id FROM crm_activities WHERE entity_type=$1 AND entity_id=$2 AND kind='lost_followup_sent'", [entityType, row.id]);
      if (already) continue;

      let name = row.name, email = row.email, customerId = null;
      if (row.contact_id) {
        const c = await pgOne('SELECT name, email, customer_id FROM crm_contacts WHERE id=$1', [row.contact_id]);
        if (c) { name = c.name || name; email = c.email || email; customerId = c.customer_id; }
      }
      if (settings.require_quote) {
        const q = customerId ? await pgOne('SELECT id FROM quotes WHERE customer_id=$1 LIMIT 1', [customerId]) : null;
        if (!q) { skippedNoQuote++; continue; }
      }
      if (!email) { skippedNoEmail++; continue; }
      try {
        const vars = { navn: name || '', firma: 'Gulv Master Enterprise ApS' };
        const subject = fillDocEmailVars(settings.subject || 'Er du stadig interesseret?', vars);
        const html = fillDocEmailVars(settings.body || '', vars);
        await sendMailUniversal({ to: email, subject, html, text: html.replace(/<[^>]+>/g, ' ') });
        await crmLogActivity(entityType, row.id, 'lost_followup_sent', 'Opfølgningsmail sendt (' + daysOld + ' dage i "Tabt"): ' + subject, null);
        sent++;
      } catch (e) {
        await crmLogActivity(entityType, row.id, 'lost_followup_failed', 'Opfølgningsmail fejlede: ' + e.message, null);
      }
    }
  }
  await logSystemEvent('lost_followup_scan', 'info', `Tabt-opfølgning: ${sent} mail(s) sendt, ${skippedNoEmail} sprunget over (ingen e-mail), ${skippedNoQuote} sprunget over (intet tilbud).`);
  return { ran: true, sent, skippedNoEmail, skippedNoQuote };
}

// Manuel afsendelse for ÉN faktura — uanset dag-tærskler, og uanset til/fra-knappen.
// Vælger automatisk næste niveau (1 hvis intet sendt endnu, ellers 2).
app.post('/api/finance/dunning-send/:documentId', auth, panelAccess('finance'), asyncRoute(async (req, res) => {
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

app.get('/api/finance/dunning-settings', auth, panelAccess('finance'), asyncRoute(async (req, res) => {
  res.json(await pgOne('SELECT * FROM finance_dunning_settings WHERE id=1'));
}));
app.put('/api/finance/dunning-settings', auth, panelAccess('finance'), asyncRoute(async (req, res) => {
  const body = req.body || {};
  await pool.query(`
    UPDATE finance_dunning_settings SET enabled=$1,days_rykker1=$2,days_rykker2=$3,fee_amount=$4,updated_at=${nowTextSQL()} WHERE id=1
  `, [body.enabled ? 1 : 0, Number(body.days_rykker1) || 14, Number(body.days_rykker2) || 28, Number(body.fee_amount) || 100]);
  res.json({ ok: true });
}));
app.get('/api/finance/dunning-log', auth, panelAccess('finance'), asyncRoute(async (req, res) => {
  const rows = await pool.query('SELECT * FROM finance_dunning_log ORDER BY id DESC LIMIT 100');
  res.json(rows.rows);
}));
app.post('/api/finance/dunning-run', auth, panelAccess('finance'), asyncRoute(async (req, res) => {
  res.json(await runDunningScan(true));
}));

app.get('/api/finance/panel-order/:panel', auth, panelAccess('finance'), asyncRoute(async (req, res) => {
  const row = await pgOne('SELECT order_json FROM finance_panel_order WHERE panel=$1', [req.params.panel]);
  res.json({ order: row ? JSON.parse(row.order_json) : null });
}));
app.put('/api/finance/panel-order', auth, panelAccess('finance'), asyncRoute(async (req, res) => {
  const body = req.body || {};
  if (!body.panel || !Array.isArray(body.order)) return res.status(400).json({ error: 'panel og order skal udfyldes' });
  await pool.query(`
    INSERT INTO finance_panel_order (panel,order_json,updated_at) VALUES ($1,$2,${nowTextSQL()})
    ON CONFLICT (panel) DO UPDATE SET order_json=$2,updated_at=${nowTextSQL()}
  `, [body.panel, JSON.stringify(body.order)]);
  res.json({ ok: true });
}));

app.get('/api/finance/panel-box-size/:panel', auth, panelAccess('finance'), asyncRoute(async (req, res) => {
  const rows = await pool.query('SELECT box_id,width,height FROM finance_panel_box_size WHERE panel=$1', [req.params.panel]);
  const out = {};
  for (const r of rows.rows) out[r.box_id] = { width: r.width, height: r.height };
  res.json(out);
}));
app.put('/api/finance/panel-box-size', auth, panelAccess('finance'), asyncRoute(async (req, res) => {
  const body = req.body || {};
  if (!body.panel || !body.boxId || !body.width || !body.height) return res.status(400).json({ error: 'panel, boxId, width og height skal udfyldes' });
  await pool.query(`
    INSERT INTO finance_panel_box_size (panel,box_id,width,height,updated_at) VALUES ($1,$2,$3,$4,${nowTextSQL()})
    ON CONFLICT (panel,box_id) DO UPDATE SET width=$3,height=$4,updated_at=${nowTextSQL()}
  `, [body.panel, body.boxId, Math.round(body.width), Math.round(body.height)]);
  res.json({ ok: true });
}));

app.post('/api/finance/manual-revenue', auth, panelAccess('finance'), asyncRoute(async (req, res) => {
  const body = req.body || {};
  if (!body.month_key || !body.name) return res.status(400).json({ error: 'Måned og navn skal udfyldes' });
  const r = await pool.query('INSERT INTO finance_manual_revenue (month_key,name,fag,amount) VALUES ($1,$2,$3,$4) RETURNING id', [body.month_key, String(body.name).slice(0, 200), body.fag || 'Ukendt', Number(body.amount) || 0]);
  res.json({ ok: true, id: r.rows[0].id });
}));
app.put('/api/finance/manual-revenue/:id', auth, panelAccess('finance'), asyncRoute(async (req, res) => {
  const body = req.body || {};
  await pool.query(`UPDATE finance_manual_revenue SET name=$1,fag=$2,amount=$3,updated_at=${nowTextSQL()} WHERE id=$4`, [String(body.name || '').slice(0, 200), body.fag || 'Ukendt', Number(body.amount) || 0, req.params.id]);
  res.json({ ok: true });
}));
app.delete('/api/finance/manual-revenue/:id', auth, panelAccess('finance'), asyncRoute(async (req, res) => {
  await pool.query('DELETE FROM finance_manual_revenue WHERE id=$1', [req.params.id]);
  res.json({ ok: true });
}));

app.put('/api/finance/job-month-override/:jobId', auth, panelAccess('finance'), asyncRoute(async (req, res) => {
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
app.get('/api/finance/job-status-marks', auth, panelAccess('finance'), asyncRoute(async (req, res) => {
  const rows = await pool.query('SELECT job_key, status FROM finance_job_status_marks');
  const out = {};
  for (const r of rows.rows) out[r.job_key] = r.status;
  res.json(out);
}));
app.put('/api/finance/job-status-marks/:jobKey', auth, panelAccess('finance'), asyncRoute(async (req, res) => {
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
app.get('/api/finance/revenue', auth, panelAccess('finance'), asyncRoute(async (req, res) => {
  const monthsBack = Math.min(12, Math.max(0, Number(req.query.monthsBack) || 0));
  const monthsForward = Math.min(6, Math.max(1, Number(req.query.monthsForward) || 1));
  const data = await fetchFinanceJobsByMonth(monthsBack, monthsForward);
  res.json(data);
}));

// Hele kalenderåret (januar-december) i ét kald — bruges af årsgrafen i Oversigt.
// Omsætning er sagsbudget-baseret (samme metode som resten af Omsætning pr. fag),
// så fag-opdelingen er tilgængelig for alle 12 måneder ensartet. Udgifter hentes fra
// de månedsopdelte udgiftsposter under Udgifter-fanen.
app.get('/api/finance/year-overview', auth, panelAccess('finance'), asyncRoute(async (req, res) => {
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
app.get('/api/finance/dashboard-widgets', auth, panelAccess('finance'), asyncRoute(async (req, res) => {
  const rows = await pool.query('SELECT * FROM finance_dashboard_widgets ORDER BY sort_order ASC, id ASC');
  res.json(rows.rows);
}));
app.post('/api/finance/dashboard-widgets', auth, panelAccess('finance'), asyncRoute(async (req, res) => {
  const body = req.body || {};
  const allowed = ['trend', 'year', 'fag_pie', 'invoice_status', 'expense_pie', 'vat_deadline', 'todo_today'];
  if (!allowed.includes(body.widget_type)) return res.status(400).json({ error: 'Ukendt graftype' });
  const maxOrder = await pgOne('SELECT COALESCE(MAX(sort_order),-1)::int AS m FROM finance_dashboard_widgets');
  const r = await pool.query('INSERT INTO finance_dashboard_widgets (widget_type, sort_order) VALUES ($1,$2) RETURNING id', [body.widget_type, (maxOrder ? maxOrder.m : -1) + 1]);
  res.json({ ok: true, id: r.rows[0].id });
}));
app.delete('/api/finance/dashboard-widgets/:id', auth, panelAccess('finance'), asyncRoute(async (req, res) => {
  await pool.query('DELETE FROM finance_dashboard_widgets WHERE id=$1', [req.params.id]);
  res.json({ ok: true });
}));


app.put('/api/finance/job-override/:jobId', auth, panelAccess('finance'), asyncRoute(async (req, res) => {
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
app.get('/api/finance/invoices', auth, panelAccess('finance'), asyncRoute(async (req, res) => {
  res.json(await fetchFinanceInvoices());
}));

app.put('/api/finance/invoices/:documentId', auth, panelAccess('finance'), asyncRoute(async (req, res) => {
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
app.post('/api/finance/bank-statement/parse', auth, panelAccess('finance'), uploadBankStatement.single('file'), asyncRoute(async (req, res) => {
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
app.get('/api/finance/bank-statement/session', auth, panelAccess('finance'), asyncRoute(async (req, res) => {
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
app.post('/api/finance/bank-statement/upload-month', auth, panelAccess('finance'), uploadBankStatement.single('file'), asyncRoute(async (req, res) => {
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
app.get('/api/finance/bank-statement/month-totals', auth, panelAccess('finance'), asyncRoute(async (req, res) => {
  const months = String(req.query.months || '').split(',').filter(m => /^\d{4}-\d{2}$/.test(m));
  const out = {};
  if (!months.length) return res.json(out);
  const rows = await pool.query('SELECT month_key,filename,expense_total,income_total,txn_count,uploaded_at FROM finance_bank_month_statements WHERE month_key = ANY($1)', [months]);
  for (const r of rows.rows) out[r.month_key] = { filename: r.filename, expenseTotal: r.expense_total, incomeTotal: r.income_total, count: r.txn_count, uploadedAt: r.uploaded_at };
  res.json(out);
}));
app.delete('/api/finance/bank-statement/month/:month', auth, panelAccess('finance'), asyncRoute(async (req, res) => {
  await pool.query('DELETE FROM finance_bank_month_statements WHERE month_key=$1', [req.params.month]);
  res.json({ ok: true });
}));

app.post('/api/finance/bank-statement/mark-reconciled', auth, panelAccess('finance'), asyncRoute(async (req, res) => {
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
app.post('/api/finance/bank-statement/unreconcile', auth, panelAccess('finance'), asyncRoute(async (req, res) => {
  const externalId = String(req.body?.externalId || '');
  if (!externalId) return res.status(400).json({ error: 'Mangler transaktions-id' });
  await pool.query('DELETE FROM finance_bank_reconciled WHERE external_id=$1', [externalId]);
  res.json({ ok: true });
}));
// ── Faste udgifter ──
app.get('/api/finance/expenses', auth, panelAccess('finance'), asyncRoute(async (req, res) => {
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
app.get('/api/finance/expenses-totals', auth, panelAccess('finance'), asyncRoute(async (req, res) => {
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
app.get('/api/finance/expense-month-totals', auth, panelAccess('finance'), asyncRoute(async (req, res) => {
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
app.put('/api/finance/expense-month-totals/:month', auth, panelAccess('finance'), asyncRoute(async (req, res) => {
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
app.delete('/api/finance/expense-month-totals/:month', auth, panelAccess('finance'), asyncRoute(async (req, res) => {
  const mk = req.params.month;
  await pool.query('DELETE FROM finance_expense_month_totals WHERE month_key=$1', [mk]);
  res.json({ ok: true });
}));
app.post('/api/finance/expenses', auth, panelAccess('finance'), asyncRoute(async (req, res) => {
  const body = req.body || {};
  if (!body.category_id || !body.name || !body.month_key) return res.status(400).json({ error: 'Kategori, navn og måned skal udfyldes' });
  const r = await pool.query('INSERT INTO finance_expenses (category_id,name,amount,paid,month_key) VALUES ($1,$2,$3,$4,$5) RETURNING id', [body.category_id, String(body.name).slice(0, 200), Number(body.amount) || 0, body.paid ? 1 : 0, body.month_key]);
  res.json({ ok: true, id: r.rows[0].id });
}));
app.put('/api/finance/expenses/:id', auth, panelAccess('finance'), asyncRoute(async (req, res) => {
  const body = req.body || {};
  await pool.query(`UPDATE finance_expenses SET name=$1,amount=$2,paid=$3,updated_at=${nowTextSQL()} WHERE id=$4`, [String(body.name || '').slice(0, 200), Number(body.amount) || 0, body.paid ? 1 : 0, req.params.id]);
  res.json({ ok: true });
}));
app.delete('/api/finance/expenses/:id', auth, panelAccess('finance'), asyncRoute(async (req, res) => {
  await pool.query('DELETE FROM finance_expenses WHERE id=$1', [req.params.id]);
  res.json({ ok: true });
}));

// ── Privat budget: fuldt frit redigerbart — kategorier kan oprettes/omdøbes/slettes,
// ikke kun poster inde i faste kategorier (modsat den almindelige Udgifter-fane).
app.get('/api/finance/private-budget', auth, panelAccess('finance'), asyncRoute(async (req, res) => {
  const cats = await pool.query('SELECT * FROM private_budget_categories ORDER BY sort_order ASC, id ASC');
  const items = await pool.query('SELECT * FROM private_budget_items ORDER BY id ASC');
  const byCategory = cats.rows.map(c => ({ ...c, items: items.rows.filter(i => i.category_id === c.id) }));
  res.json(byCategory);
}));
app.put('/api/finance/private-budget/reorder', auth, panelAccess('finance'), asyncRoute(async (req, res) => {
  const order = (req.body || {}).order || [];
  for (let i = 0; i < order.length; i++) {
    await pool.query('UPDATE private_budget_categories SET sort_order=$1 WHERE id=$2', [i, order[i]]);
  }
  res.json({ ok: true });
}));
app.post('/api/finance/private-budget/category', auth, panelAccess('finance'), asyncRoute(async (req, res) => {
  const body = req.body || {};
  if (!body.name) return res.status(400).json({ error: 'Navn skal udfyldes' });
  const maxOrder = await pgOne('SELECT COALESCE(MAX(sort_order),0)::int AS m FROM private_budget_categories');
  const r = await pool.query('INSERT INTO private_budget_categories (name, sort_order) VALUES ($1,$2) RETURNING id', [String(body.name).slice(0, 200), (maxOrder ? maxOrder.m : 0) + 1]);
  res.json({ ok: true, id: r.rows[0].id });
}));
app.put('/api/finance/private-budget/category/:id', auth, panelAccess('finance'), asyncRoute(async (req, res) => {
  const body = req.body || {};
  if (!body.name) return res.status(400).json({ error: 'Navn skal udfyldes' });
  await pool.query('UPDATE private_budget_categories SET name=$1 WHERE id=$2', [String(body.name).slice(0, 200), req.params.id]);
  res.json({ ok: true });
}));
app.delete('/api/finance/private-budget/category/:id', auth, panelAccess('finance'), asyncRoute(async (req, res) => {
  await pool.query('DELETE FROM private_budget_categories WHERE id=$1', [req.params.id]);
  res.json({ ok: true });
}));
app.post('/api/finance/private-budget/item', auth, panelAccess('finance'), asyncRoute(async (req, res) => {
  const body = req.body || {};
  if (!body.category_id || !body.name) return res.status(400).json({ error: 'Kategori og navn skal udfyldes' });
  const r = await pool.query('INSERT INTO private_budget_items (category_id,name,amount,note) VALUES ($1,$2,$3,$4) RETURNING id', [body.category_id, String(body.name).slice(0, 200), Number(body.amount) || 0, body.note ? String(body.note).slice(0, 500) : null]);
  res.json({ ok: true, id: r.rows[0].id });
}));
app.put('/api/finance/private-budget/item/:id', auth, panelAccess('finance'), asyncRoute(async (req, res) => {
  const body = req.body || {};
  await pool.query(`UPDATE private_budget_items SET name=$1,amount=$2,note=$3,updated_at=${nowTextSQL()} WHERE id=$4`, [String(body.name || '').slice(0, 200), Number(body.amount) || 0, body.note ? String(body.note).slice(0, 500) : null, req.params.id]);
  res.json({ ok: true });
}));
app.delete('/api/finance/private-budget/item/:id', auth, panelAccess('finance'), asyncRoute(async (req, res) => {
  await pool.query('DELETE FROM private_budget_items WHERE id=$1', [req.params.id]);
  res.json({ ok: true });
}));

// ── Bank-snapshots (erstatter manuel indtastning hver gang — gemmes rigtigt i databasen) ──
app.get('/api/finance/bank-snapshots', auth, panelAccess('finance'), asyncRoute(async (req, res) => {
  const rows = await pool.query('SELECT * FROM finance_bank_snapshots ORDER BY snap_date DESC LIMIT 24');
  res.json(rows.rows);
}));
app.post('/api/finance/bank-snapshots', auth, panelAccess('finance'), asyncRoute(async (req, res) => {
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
app.get('/api/finance/profit-snapshots', auth, panelAccess('finance'), asyncRoute(async (req, res) => {
  const rows = await pool.query('SELECT * FROM profit_snapshots ORDER BY month_key ASC');
  res.json(rows.rows);
}));
// Manuel "Gem nu"-knap — bruges også automatisk af den månedlige cron nedenfor d. 15.
// Idempotent: kører man den flere gange samme måned, opdateres blot samme række.
app.post('/api/finance/profit-snapshots/save-now', auth, panelAccess('finance'), asyncRoute(async (req, res) => {
  const snap = await saveMonthlyProfitSnapshot();
  res.json({ ok: true, snapshot: snap });
}));

// ── Send dagens rapport til egen mail — genbruger den eksisterende mail-opsætning ──
app.post('/api/finance/email-report', auth, panelAccess('finance'), asyncRoute(async (req, res) => {
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
app.get('/api/quotes/:id/activity', auth, panelAccess('quotes'), asyncRoute(async (req, res) => {
  const rows = await pool.query('SELECT * FROM document_activity WHERE doc_type=$1 AND doc_id=$2 ORDER BY id DESC', ['quote', req.params.id]);
  res.json(rows.rows);
}));
app.get('/api/invoices/:id/activity', auth, panelAccess('quotes'), asyncRoute(async (req, res) => {
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
    ('company_name','logo_url','company_address','company_cvr','company_phone','company_email','company_bank_reg','company_bank_account','company_iban','company_swift','invoice_footer_note','default_tax_rate')
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
    iban: map.company_iban || '',
    swift: map.company_swift || '',
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
app.get('/api/products', auth, panelAccess('quotes'), asyncRoute(async (req, res) => {
  const rows = await pool.query('SELECT * FROM products WHERE active=1 ORDER BY category NULLS LAST, name');
  res.json(rows.rows);
}));

app.post('/api/products', auth, panelAccess('quotes'), asyncRoute(async (req, res) => {
  const b = req.body || {};
  if (!b.name) return res.status(400).json({ error: 'Navn mangler' });
  const r = await pool.query(`
    INSERT INTO products (name,description,sku,unit,cost_price,sell_price,category,product_type,note)
    VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9) RETURNING id
  `, [String(b.name).trim(), b.description || null, b.sku || null, b.unit || 'stk', Number(b.cost_price) || 0, Number(b.sell_price) || 0, b.category || null, b.product_type === 'materialer' ? 'materialer' : 'service', b.note || null]);
  res.json({ ok: true, id: r.rows[0].id });
}));

app.put('/api/products/:id', auth, panelAccess('quotes'), asyncRoute(async (req, res) => {
  const b = req.body || {};
  const current = await pgOne('SELECT * FROM products WHERE id=$1', [req.params.id]);
  if (!current) return res.status(404).json({ error: 'Produktet blev ikke fundet' });
  await pool.query(`
    UPDATE products SET name=$1,description=$2,sku=$3,unit=$4,cost_price=$5,sell_price=$6,category=$7,product_type=$8,note=$9,updated_at=${nowTextSQL()}
    WHERE id=$10
  `, [
    b.name !== undefined ? String(b.name).trim() : current.name,
    b.description !== undefined ? b.description : current.description,
    b.sku !== undefined ? b.sku : current.sku,
    b.unit !== undefined ? b.unit : current.unit,
    b.cost_price !== undefined ? Number(b.cost_price) || 0 : current.cost_price,
    b.sell_price !== undefined ? Number(b.sell_price) || 0 : current.sell_price,
    b.category !== undefined ? b.category : current.category,
    b.product_type !== undefined ? (b.product_type === 'materialer' ? 'materialer' : 'service') : current.product_type,
    b.note !== undefined ? b.note : current.note,
    req.params.id
  ]);
  res.json({ ok: true });
}));

app.delete('/api/products/:id', auth, panelAccess('quotes'), asyncRoute(async (req, res) => {
  // Slet ikke rigtigt — historiske tilbud/fakturaer refererer stadig til product_id,
  // og skal blive ved med at vise korrekt selv efter produktet er "slettet".
  await pool.query('UPDATE products SET active=0 WHERE id=$1', [req.params.id]);
  res.json({ ok: true });
}));

// ── AI-DIKTERING AF TILBUD (sep. 2026, Martins ønske: "kan du tilføje AI så jeg
// kan tale til programmet med hvad jeg ønsker tilbuddet skal være, og den
// lynhurtigt finder det i databasen med produkter eller selv laver produktet" —
// valgte "hele tilbuddet på én gang"-varianten). Selve tale-til-tekst sker i
// browseren (Web Speech API, gratis, ingen server-nøgle nødvendig, se admin.html)
// — denne rute tager KUN den færdige tekst og beder en AI-model dele den op i
// tilbudslinjer og matche hver linje mod produktkataloget. Opretter ALDRIG selv
// et produkt i databasen — det sker kun når Martin bekræfter i gennemgangs-
// vinduet i admin.html, via den helt almindelige POST /api/products ovenfor
// (Martins valg: "altid bekræft med mig først"). Kræver ANTHROPIC_API_KEY sat
// som miljøvariabel på serveren (Render → Environment → tilføj ANTHROPIC_API_KEY)
// — uden den svarer ruten pænt med en dansk fejlbesked i stedet for at fejle råt.
const ANTHROPIC_MODEL = process.env.ANTHROPIC_MODEL || 'claude-sonnet-4-5-20250929';
async function callAnthropicJSON(systemPrompt, userPrompt) {
  if (!process.env.ANTHROPIC_API_KEY) {
    const err = new Error('AI-diktering er ikke aktiveret på serveren endnu — ANTHROPIC_API_KEY mangler i Render-miljøvariablerne.');
    err.isConfig = true;
    throw err;
  }
  const r = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'x-api-key': process.env.ANTHROPIC_API_KEY,
      'anthropic-version': '2023-06-01'
    },
    body: JSON.stringify({
      model: ANTHROPIC_MODEL,
      max_tokens: 2000,
      system: systemPrompt,
      messages: [{ role: 'user', content: userPrompt }]
    })
  });
  const data = await r.json().catch(() => null);
  if (!r.ok) {
    const msg = (data && data.error && data.error.message) || ('AI-kald fejlede (HTTP ' + r.status + ')');
    throw new Error(msg);
  }
  const text = data && data.content && data.content[0] && data.content[0].text;
  if (!text) throw new Error('AI-svaret var tomt');
  // Modellen bedes KUN svare med JSON, men vi renser defensivt for evt.
  // ```json ... ``` kodeblok-hegn, hvis den alligevel skulle tilføje det.
  const cleaned = text.trim().replace(/^```(json)?/i, '').replace(/```$/, '').trim();
  return JSON.parse(cleaned);
}
app.post('/api/quotes/ai-parse-lines', auth, panelAccess('quotes'), asyncRoute(async (req, res) => {
  const transcript = String((req.body && req.body.transcript) || '').trim();
  if (!transcript) return res.status(400).json({ error: 'Ingen tale/tekst modtaget' });
  const products = (await pool.query("SELECT id,name,unit,sell_price,cost_price,category,product_type FROM products WHERE active=1 ORDER BY name LIMIT 1000")).rows;
  const catalogForPrompt = products.map(p => ({ id: p.id, name: p.name, unit: p.unit, sell_price: Number(p.sell_price), category: p.category || null, type: p.product_type }));
  const systemPrompt = 'Du hjælper en dansk gulvfirma-medarbejder (Gulv Master) med at omsætte et talt diktat til tilbudslinjer.\n'
    + 'Du får (1) et diktat på dansk og (2) firmaets produktkatalog som JSON.\n'
    + 'Del diktatet op i separate linjer — én pr. arbejde/produkt/vare der nævnes. For hver linje:\n'
    + '- "quantity": mængde som tal (antag 1 hvis intet tal nævnes)\n'
    + '- "unit": enhed (fx "m2", "stk", "timer", "lbm") — gæt ud fra sammenhængen, ellers "stk"\n'
    + '- "description": en kort, naturlig beskrivelse af linjen på dansk\n'
    + '- "match": hvis et produkt i kataloget TYDELIGVIS er det samme, sæt {"product_id": <id>} — vær IKKE overfortolkende, kun ved en reelt god match\n'
    + '- "new_product": hvis INTET produkt i kataloget passer, sæt i stedet {"name": <kort produktnavn>, "unit": <enhed>, "product_type": "materialer" eller "service"} — lad prisfelter være ude, dem sætter brugeren selv bagefter\n'
    + 'Præcis ét af "match"/"new_product" skal være sat pr. linje, aldrig begge, aldrig ingen.\n'
    + 'Svar KUN med gyldig JSON på formen {"lines":[...]} — ingen forklaring, ingen kodeblok-hegn.';
  const userPrompt = 'PRODUKTKATALOG:\n' + JSON.stringify(catalogForPrompt) + '\n\nDIKTAT:\n' + transcript;
  let parsed;
  try {
    parsed = await callAnthropicJSON(systemPrompt, userPrompt);
  } catch (e) {
    await logSystemEvent('ai_parse_quote', 'error', 'AI-diktering fejlede: ' + e.message);
    return res.status(e.isConfig ? 501 : 502).json({ error: e.message });
  }
  const rawLines = Array.isArray(parsed && parsed.lines) ? parsed.lines : [];
  const byId = new Map(products.map(p => [p.id, p]));
  const lines = rawLines.map(l => {
    const quantity = Number(l.quantity) || 1;
    const unit = String(l.unit || 'stk').trim() || 'stk';
    const description = String(l.description || '').trim();
    let match = null, newProduct = null;
    if (l.match && byId.has(Number(l.match.product_id))) {
      const p = byId.get(Number(l.match.product_id));
      match = { product_id: p.id, name: p.name, unit: p.unit, sell_price: Number(p.sell_price), cost_price: Number(p.cost_price), product_type: p.product_type };
    } else if (l.new_product && l.new_product.name) {
      newProduct = {
        name: String(l.new_product.name).trim(),
        unit: String(l.new_product.unit || unit || 'stk').trim(),
        product_type: l.new_product.product_type === 'materialer' ? 'materialer' : 'service'
      };
    }
    if (!match && !newProduct) return null; // hverken match eller forslag — kan ikke bruges
    return { quantity, unit, description, match, new_product: newProduct };
  }).filter(Boolean);
  await logSystemEvent('ai_parse_quote', 'info', 'AI-diktering: ' + lines.length + ' linje(r) tolket ud af diktat på ' + transcript.length + ' tegn (' + rawLines.length + ' rå linjer fra modellen).');
  res.json({ ok: true, lines });
}));

// ── AKKORDLISTE (sep. 2026) — global prisliste til stykløn, se akkord_items i
// migrations-blokken. Læses af tidsregistrerings-modalen (panelAccess('projects') er
// nok til det — medarbejdere der logger tid skal kunne se posterne), men kun en ægte
// admin må ændre selve listen (priser er følsomme, ligesom lønfeltet på en medarbejder).
app.get('/api/akkord-items', auth, panelAccess('projects'), asyncRoute(async (req, res) => {
  const rows = (await pool.query('SELECT * FROM akkord_items WHERE active=1 ORDER BY position ASC, id ASC')).rows;
  res.json(rows);
}));
app.get('/api/akkord-items/all', auth, adminOnly, asyncRoute(async (req, res) => {
  // Inkl. inaktive — bruges af selve administrations-UI'en, så en post kan slås til/fra igen.
  const rows = (await pool.query('SELECT * FROM akkord_items ORDER BY position ASC, id ASC')).rows;
  res.json(rows);
}));
app.post('/api/akkord-items', auth, adminOnly, asyncRoute(async (req, res) => {
  const b = req.body || {};
  const name = String(b.name || '').trim();
  if (!name) return res.status(400).json({ error: 'Navn mangler' });
  const posRow = await pgOne('SELECT COALESCE(MAX(position),-1)+1 AS pos FROM akkord_items');
  const r = await pgOne('INSERT INTO akkord_items (name,rate,position) VALUES ($1,$2,$3) RETURNING id', [name, Math.max(0, Number(b.rate) || 0), posRow.pos]);
  res.json({ ok: true, id: r.id });
}));
app.put('/api/akkord-items/:id', auth, adminOnly, asyncRoute(async (req, res) => {
  const current = await pgOne('SELECT * FROM akkord_items WHERE id=$1', [req.params.id]);
  if (!current) return res.status(404).json({ error: 'Posten blev ikke fundet' });
  const b = req.body || {};
  await pool.query('UPDATE akkord_items SET name=$1,rate=$2,active=$3,position=$4 WHERE id=$5', [
    b.name !== undefined ? String(b.name).trim() : current.name,
    b.rate !== undefined ? Math.max(0, Number(b.rate) || 0) : current.rate,
    b.active !== undefined ? (b.active ? 1 : 0) : current.active,
    b.position !== undefined ? b.position : current.position,
    req.params.id
  ]);
  res.json({ ok: true });
}));
app.delete('/api/akkord-items/:id', auth, adminOnly, asyncRoute(async (req, res) => {
  // Slet ikke rigtigt — historiske tidsregistreringer refererer stadig til akkord_item_id
  // (ON DELETE SET NULL ville ellers gøre gamle registreringer uforklarlige bagefter).
  await pool.query('UPDATE akkord_items SET active=0 WHERE id=$1', [req.params.id]);
  res.json({ ok: true });
}));

// ── AFKOBLET 05-09-2026 ────────────────────────────────────────────────────
// Martin har fjernet alle resterende JobTread-koblinger fra admin-UI'et — dette
// engangsimport-værktøj ("📥 Importér fra JobTread" i Produkter) er derfor også
// taget ud. Ruten er kommenteret ud, ikke slettet, af samme grund som de andre
// JobTread-afkoblinger denne dag: nemt at genaktivere, hvis det skulle blive
// relevant igen. products.jt_cost_item_id-kolonnen og de allerede importerede
// produkter er urørte.
// // Engangs-import fra JobTread's costItems — bevidst IKKE en løbende synkronisering
// // (se svar i chatten): henter alt organisationen har brugt af cost items på tværs af
// // jobs, og lægger de unikke navne ind som et udgangspunkt for jeres eget katalog.
// // Køres kun når admin selv trykker på knappen, aldrig automatisk.
// app.post('/api/products/import-from-jobtread', auth, panelAccess('quotes'), asyncRoute(async (req, res) => {
//   if (!JT_ORG || !JT_GRANT) return res.status(400).json({ error: 'JobTread er ikke sat op på serveren' });
//   // JobTread har ikke en selvstændig "produktkatalog"-type — cost items på tværs
//   // af alle jobs bruges i stedet, hvor en cost item enten ER en genbrugelig skabelon
//   // (organizationCostItem er tom, og den har sin egen unitCost/unitPrice), eller er
//   // en KOPI af én, brugt på et konkret job (organizationCostItem peger på skabelonen,
//   // og har typisk ikke sin egen pris). Vi importerer kun items med reelle pris-data,
//   // dedupliceret på navn — kopier uden egen pris springes over, da skabelonen med
//   // samme navn allerede giver den rigtige cost/salgspris.
//   const seen = new Map(); // navn (lowercase) -> {name,unit,cost,price,jtId,isTemplate}
//   let page = null;
//   let guard = 0;
//   try {
//     do {
//       guard++;
//       const data = await jtFetch({
//         query: { $: { grantKey: JT_GRANT }, organization: { $: { id: JT_ORG }, costItems: {
//           $: { size: 100, page: page || undefined },
//           nextPage: {},
//           nodes: { id: {}, name: {}, description: {}, unit: { name: {} }, unitCost: {}, unitPrice: {}, organizationCostItem: { id: {} } }
//         } } }
//       }, 'Produktimport: hent cost items fra JobTread');
//       const conn = data?.organization?.costItems;
//       for (const n of conn?.nodes || []) {
//         if (!n.name) continue;
//         if (n.unitCost == null && n.unitPrice == null) continue; // job-kopi uden egen pris — spring over
//         const key = n.name.toLowerCase().trim();
//         const isTemplate = !n.organizationCostItem;
//         const existing = seen.get(key);
//         if (!existing || (isTemplate && !existing.isTemplate)) {
//           seen.set(key, { name: n.name, description: n.description || '', unit: n.unit?.name || 'stk', cost: Number(n.unitCost) || 0, price: Number(n.unitPrice) || 0, jtId: n.id, isTemplate });
//         }
//       }
//       page = conn?.nextPage || null;
//     } while (page && guard < 200);
//   } catch (error) {
//     return res.status(400).json({ error: 'Kunne ikke hente fra JobTread: ' + error.message });
//   }
//   let imported = 0, skipped = 0, descriptionsFilled = 0;
//   for (const item of seen.values()) {
//     const existing = item.jtId
//       ? await pgOne('SELECT id, description FROM products WHERE jt_cost_item_id=$1', [item.jtId])
//       : await pgOne('SELECT id, description FROM products WHERE lower(trim(name))=lower(trim($1)) AND jt_cost_item_id IS NULL', [item.name]);
//     if (existing) {
//       skipped++;
//       // Findes allerede lokalt — vi rører aldrig navn/pris på et eksisterende produkt
//       // (kan være rettet manuelt), men hvis der IKKE allerede står en beskrivelse, og
//       // JobTread har en, udfylder vi den. Overskriver aldrig en beskrivelse der allerede
//       // findes — kun tomme felter (Martins ønske, sep. 2026).
//       if (item.description && !(existing.description || '').trim()) {
//         await pool.query('UPDATE products SET description=$1 WHERE id=$2', [item.description, existing.id]);
//         descriptionsFilled++;
//       }
//       continue;
//     }
//     await pool.query(`
//       INSERT INTO products (name,description,unit,cost_price,sell_price,jt_cost_item_id) VALUES ($1,$2,$3,$4,$5,$6)
//     `, [item.name, item.description, item.unit, item.cost, item.price, item.jtId]);
//     imported++;
//   }
//   res.json({ ok: true, imported, skipped, descriptions_filled: descriptionsFilled, total_found: seen.size });
// }));

// ── TILBUDSSKABELONER — gemte linjesæt til hurtigt at starte et nyt tilbud fra ──
app.get('/api/quote-templates', auth, panelAccess('quotes'), asyncRoute(async (req, res) => {
  const rows = await pool.query('SELECT * FROM quote_templates ORDER BY name ASC');
  res.json(rows.rows);
}));

app.post('/api/quote-templates', auth, panelAccess('quotes'), asyncRoute(async (req, res) => {
  const b = req.body || {};
  if (!b.name) return res.status(400).json({ error: 'Navn mangler' });
  const r = await pool.query(`
    INSERT INTO quote_templates (name,description,lines) VALUES ($1,$2,$3) RETURNING id
  `, [String(b.name).trim(), b.description || null, JSON.stringify(b.lines || [])]);
  res.json({ ok: true, id: r.rows[0].id });
}));

app.put('/api/quote-templates/:id', auth, panelAccess('quotes'), asyncRoute(async (req, res) => {
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

app.delete('/api/quote-templates/:id', auth, panelAccess('quotes'), asyncRoute(async (req, res) => {
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

app.get('/api/quotes', auth, panelAccess('quotes'), asyncRoute(async (req, res) => {
  const rows = await pool.query('SELECT * FROM quotes ORDER BY created_at DESC, id DESC');
  res.json(rows.rows);
}));

app.get('/api/quotes/:id', auth, panelAccess('quotes'), asyncRoute(async (req, res) => {
  const quote = await loadQuoteFull(req.params.id);
  if (!quote) return res.status(404).json({ error: 'Tilbuddet blev ikke fundet' });
  res.json(quote);
}));

// `exec` er valgfri (pool som standard, eller en transaktionsklient) — se samme
// mønster ved crmSetCustomFieldValues/mirrorProjectTaskToPool. Eksisterende
// kaldesteder er uændrede; kun JobTread-sagsimporten sender en klient med.
async function saveQuoteLines(quoteId, lines, exec) {
  const db = exec || pool;
  await db.query('DELETE FROM quote_lines WHERE quote_id=$1', [quoteId]);
  let pos = 0;
  for (const l of (lines || [])) {
    if (!l.description) continue;
    const isText = l.line_type === 'text';
    await db.query(`
      INSERT INTO quote_lines (quote_id,product_id,description,unit,quantity,cost_price,sell_price,position,product_type,discount_pct,discount_type,line_type,note)
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13)
    `, [quoteId, isText ? null : (l.product_id || null), String(l.description).trim(), isText ? '' : (l.unit || 'stk'), isText ? 0 : (Number(l.quantity) || 1), isText ? 0 : (Number(l.cost_price) || 0), isText ? 0 : (Number(l.sell_price) || 0), pos++, l.product_type === 'materialer' ? 'materialer' : 'service', isText ? 0 : (Number(l.discount_pct) || 0), l.discount_type === 'fixed' ? 'fixed' : 'pct', isText ? 'text' : 'item', isText ? null : (l.note ? String(l.note).trim() : null)]);
  }
}

app.post('/api/quotes', auth, panelAccess('quotes'), asyncRoute(async (req, res) => {
  const b = req.body || {};
  const company = await getCompanyInfo();
  const taxRate = b.tax_rate !== undefined ? Number(b.tax_rate) : company.defaultTaxRate;
  const discountPct = Number(b.discount_pct) || 0;
  const discountType = b.discount_type === 'fixed' ? 'fixed' : 'pct';
  const totals = computeTotals(b.lines || [], taxRate, { value: discountPct, type: discountType });
  const quoteNumber = await nextDocNumber('quote', 'TIL');
  const acceptToken = crypto.randomBytes(20).toString('hex');
  const r = await pool.query(`
    INSERT INTO quotes (quote_number,job_name,job_id,customer_id,customer_address,customer_phone,customer_email,status,subtotal,tax_rate,tax_amount,total,notes,top_note,internal_note,valid_until,created_by,discount_pct,discount_type,accept_token)
    VALUES ($1,$2,$3,$4,$5,$6,$7,'draft',$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19) RETURNING id
  `, [quoteNumber, b.job_name || null, b.job_id || null, b.customer_id || null, b.customer_address || null, b.customer_phone || null, b.customer_email || null, totals.subtotal, taxRate, totals.taxAmount, totals.total, b.notes ? sanitizeRichText(b.notes) : null, b.top_note ? sanitizeRichText(b.top_note) : null, b.internal_note || null, b.valid_until || null, req.user.id, discountPct, discountType, acceptToken]);
  await saveQuoteLines(r.rows[0].id, b.lines);
  logDocActivity('quote', r.rows[0].id, 'created', req.user.name, null);
  res.json({ ok: true, id: r.rows[0].id, quote_number: quoteNumber });
}));

app.put('/api/quotes/:id', auth, panelAccess('quotes'), asyncRoute(async (req, res) => {
  const current = await pgOne('SELECT * FROM quotes WHERE id=$1', [req.params.id]);
  if (!current) return res.status(404).json({ error: 'Tilbuddet blev ikke fundet' });
  const b = req.body || {};
  const taxRate = b.tax_rate !== undefined ? Number(b.tax_rate) : current.tax_rate;
  const discountPct = b.discount_pct !== undefined ? Number(b.discount_pct) || 0 : Number(current.discount_pct) || 0;
  const discountType = b.discount_type !== undefined ? (b.discount_type === 'fixed' ? 'fixed' : 'pct') : (current.discount_type === 'fixed' ? 'fixed' : 'pct');
  const totals = computeTotals(b.lines !== undefined ? b.lines : await pool.query('SELECT * FROM quote_lines WHERE quote_id=$1', [req.params.id]).then(r => r.rows), taxRate, { value: discountPct, type: discountType });
  await pool.query(`
    UPDATE quotes SET job_name=$1,job_id=$2,customer_id=$3,customer_address=$4,customer_phone=$5,customer_email=$6,subtotal=$7,tax_rate=$8,tax_amount=$9,total=$10,notes=$11,top_note=$12,internal_note=$13,valid_until=$14,discount_pct=$15,discount_type=$16,updated_at=${nowTextSQL()}
    WHERE id=$17
  `, [
    b.job_name !== undefined ? b.job_name : current.job_name,
    b.job_id !== undefined ? b.job_id : current.job_id,
    b.customer_id !== undefined ? b.customer_id : current.customer_id,
    b.customer_address !== undefined ? b.customer_address : current.customer_address,
    b.customer_phone !== undefined ? b.customer_phone : current.customer_phone,
    b.customer_email !== undefined ? b.customer_email : current.customer_email,
    totals.subtotal, taxRate, totals.taxAmount, totals.total,
    b.notes !== undefined ? sanitizeRichText(b.notes) : current.notes,
    b.top_note !== undefined ? sanitizeRichText(b.top_note) : current.top_note,
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

app.put('/api/quotes/:id/status', auth, panelAccess('quotes'), asyncRoute(async (req, res) => {
  const status = String((req.body || {}).status || '');
  if (!['draft', 'sent', 'accepted', 'declined'].includes(status)) return res.status(400).json({ error: 'Ugyldig status' });
  const r = await pool.query(`UPDATE quotes SET status=$1, updated_at=${nowTextSQL()} WHERE id=$2 AND status <> 'converted'`, [status, req.params.id]);
  if (!r.rowCount) return res.status(400).json({ error: 'Tilbuddet findes ikke, eller er allerede konverteret til en faktura' });
  logDocActivity('quote', req.params.id, 'status_changed', req.user.name, status);
  res.json({ ok: true });
}));

app.delete('/api/quotes/:id', auth, panelAccess('quotes'), asyncRoute(async (req, res) => {
  const r = await pool.query(`DELETE FROM quotes WHERE id=$1 AND status <> 'converted'`, [req.params.id]);
  if (!r.rowCount) return res.status(400).json({ error: 'Kan ikke slette et tilbud der er konverteret til faktura' });
  res.json({ ok: true });
}));

app.post('/api/quotes/:id/convert-to-invoice', auth, panelAccess('quotes'), asyncRoute(async (req, res) => {
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
    INSERT INTO invoices (invoice_number,quote_id,job_name,job_id,customer_address,customer_phone,customer_email,status,subtotal,tax_rate,tax_amount,total,notes,due_date,discount_pct,customer_id)
    VALUES ($1,$2,$3,$4,$5,$6,$7,'unpaid',$8,$9,$10,$11,$12,$13,$14,$15) RETURNING id
  `, [invoiceNumber, quote.id, quote.job_name, quote.job_id, quote.customer_address, quote.customer_phone, quote.customer_email, quote.subtotal, quote.tax_rate, quote.tax_amount, quote.total, quote.notes, dueDate.toISOString().slice(0, 10), equivDocDiscountPct, quote.customer_id || null]);
  const invoiceId = r.rows[0].id;
  let pos = 0;
  for (const l of quote.lines) {
    await pool.query(`
      INSERT INTO invoice_lines (invoice_id,product_id,description,unit,quantity,cost_price,sell_price,position,product_type,discount_pct,line_type,note)
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)
    `, [invoiceId, l.product_id, l.description, l.unit, l.quantity, l.cost_price, l.sell_price, pos++, l.product_type || 'service', equivalentLinePct(l), l.line_type === 'text' ? 'text' : 'item', l.note || null]);
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

app.get('/api/invoices', auth, panelAccess('quotes'), asyncRoute(async (req, res) => {
  const rows = await pool.query(`
    SELECT i.*, COALESCE((SELECT SUM(amount) FROM invoice_payments p WHERE p.invoice_id=i.id),0) AS paid_total,
           COALESCE((SELECT SUM(amount) FROM credit_notes c WHERE c.invoice_id=i.id),0) AS credited_total
    FROM invoices i ORDER BY i.created_at DESC, i.id DESC
  `);
  res.json(rows.rows.map(r => ({ ...r, remaining: Number(r.total) - Number(r.paid_total) - Number(r.credited_total) })));
}));

app.get('/api/invoices/:id', auth, panelAccess('quotes'), asyncRoute(async (req, res) => {
  const invoice = await loadInvoiceFull(req.params.id);
  if (!invoice) return res.status(404).json({ error: 'Fakturaen blev ikke fundet' });
  res.json(invoice);
}));

app.put('/api/invoices/:id', auth, panelAccess('quotes'), asyncRoute(async (req, res) => {
  const current = await pgOne('SELECT * FROM invoices WHERE id=$1', [req.params.id]);
  if (!current) return res.status(404).json({ error: 'Fakturaen blev ikke fundet' });
  const b = req.body || {};
  await pool.query(`
    UPDATE invoices SET notes=$1, due_date=$2, customer_address=$3, customer_phone=$4, customer_email=$5, updated_at=${nowTextSQL()}
    WHERE id=$6
  `, [
    b.notes !== undefined ? sanitizeRichText(b.notes) : current.notes,
    b.due_date !== undefined ? b.due_date : current.due_date,
    b.customer_address !== undefined ? b.customer_address : current.customer_address,
    b.customer_phone !== undefined ? b.customer_phone : current.customer_phone,
    b.customer_email !== undefined ? b.customer_email : current.customer_email,
    req.params.id
  ]);
  logDocActivity('invoice', req.params.id, 'edited', req.user.name, null);
  res.json({ ok: true });
}));

app.post('/api/invoices/:id/payments', auth, panelAccess('quotes'), asyncRoute(async (req, res) => {
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

app.delete('/api/invoices/:id/payments/:paymentId', auth, panelAccess('quotes'), asyncRoute(async (req, res) => {
  await pool.query('DELETE FROM invoice_payments WHERE id=$1 AND invoice_id=$2', [req.params.paymentId, req.params.id]);
  await refreshInvoiceStatus(req.params.id);
  logDocActivity('invoice', req.params.id, 'payment_removed', req.user.name, null);
  res.json({ ok: true });
}));

app.put('/api/invoices/:id/void', auth, panelAccess('quotes'), asyncRoute(async (req, res) => {
  await pool.query(`UPDATE invoices SET status='void', updated_at=${nowTextSQL()} WHERE id=$1`, [req.params.id]);
  logDocActivity('invoice', req.params.id, 'void', req.user.name, null);
  res.json({ ok: true });
}));

// ── KREDITNOTAER ──────────────────────────────────────────────
// Selvstændigt nummereret dokument (KN-ÅÅÅÅ-NNNN) knyttet til én faktura, med
// et valgfrit beløb — kan dække hele eller kun en del af fakturaen (fx en
// reklamation over én linje). Beløbet kan ikke overstige det der er tilbage at
// kreditere (total minus allerede krediterede kreditnotaer).
app.get('/api/invoices/:id/credit-notes', auth, panelAccess('quotes'), asyncRoute(async (req, res) => {
  const rows = await pool.query('SELECT * FROM credit_notes WHERE invoice_id=$1 ORDER BY created_at ASC, id ASC', [req.params.id]);
  res.json(rows.rows);
}));
app.post('/api/invoices/:id/credit-notes', auth, panelAccess('quotes'), asyncRoute(async (req, res) => {
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
app.delete('/api/credit-notes/:id', auth, panelAccess('quotes'), asyncRoute(async (req, res) => {
  const cn = await pgOne('SELECT * FROM credit_notes WHERE id=$1', [req.params.id]);
  if (!cn) return res.status(404).json({ error: 'Kreditnotaen blev ikke fundet' });
  await pool.query('DELETE FROM credit_notes WHERE id=$1', [req.params.id]);
  await refreshInvoiceStatus(cn.invoice_id);
  logDocActivity('invoice', cn.invoice_id, 'credit_note_removed', req.user.name, cn.credit_note_number);
  res.json({ ok: true });
}));
app.get('/api/credit-notes/:id/pdf', auth, panelAccess('quotes'), asyncRoute(async (req, res) => {
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
app.post('/api/credit-notes/:id/send', auth, panelAccess('quotes'), asyncRoute(async (req, res) => {
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
// ── RIG TEKST (fed skrift, links) I NOTER ────────────────────────────────
// Noter i tilbud/faktura gemmes som et lille tilladt HTML-undersæt (kun
// <b>/<strong>, <br>, <a href="...">) og renderes to steder: her til PDF
// (parses om til PDFKit-tekstkørsler nedenfor) og direkte som innerHTML på
// kundens online side. Derfor saniteres teksten HER, ved gem (se kald i
// quote/faktura/indstillings-routerne), én gang for alle, så begge visninger
// er sikre uanset hvad der oprindeligt blev indtastet i editoren.
function sanitizeRichText(html) {
  if (!html) return '';
  let s = String(html);
  s = s.replace(/<(script|style)[^>]*>[\s\S]*?<\/\1>/gi, '');
  s = s.replace(/<a\s+[^>]*href\s*=\s*"([^"]*)"[^>]*>/gi, (m, href) => {
    const safe = /^(https?:|mailto:)/i.test(href.trim()) ? href.trim() : '';
    return safe ? `<a href="${safe.replace(/"/g, '&quot;')}" target="_blank" rel="noopener">` : '<a>';
  });
  s = s.replace(/<(?!\/?(b|strong|br|a)\b)[^>]*>/gi, '');
  return s.trim();
}

// Ren tekst-udgave af en rig-tekst-note (bruges til højde-beregning og andre
// steder der ikke kan/skal vise HTML, fx sms/notifikations-tekster).
function richTextToPlain(html) {
  return String(html || '').replace(/<br\s*\/?>/gi, '\n').replace(/<[^>]+>/g, '')
    .replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#39;/g, "'");
}

// Tegner sanitizeRichText's HTML-undersæt som PDFKit-tekstkørsler (fed skrift
// og klikbare, understregede links), linje for linje (<br> = ny linje). x/y
// er startpunktet, width bruges til PDFKit's egen ombrydning inden for hver
// kørsels-kæde. Returnerer Y-positionen efter det tegnede indhold, til brug i
// resten af funktionens manuelt styrede y-cursor.
function renderRichText(doc, html, x, y, width, opts) {
  opts = opts || {};
  const fontSize = opts.fontSize || 9;
  const color = opts.color || '#374151';
  const lineGap = opts.lineGap !== undefined ? opts.lineGap : 2;
  const lines = String(html || '').split(/<br\s*\/?>/i);
  let curY = y;
  lines.forEach((lineHtml) => {
    if (!lineHtml.trim()) {
      doc.font('Helvetica').fontSize(fontSize).fillColor(color).text(' ', x, curY, { width, lineGap });
      curY = doc.y;
      return;
    }
    const runs = [];
    let boldDepth = 0, href = null;
    const re = /<(\/?)(b|strong|a)(?:\s+href="([^"]*)")?[^>]*>|([^<]+)/gi;
    let m;
    while ((m = re.exec(lineHtml))) {
      if (m[4] !== undefined) {
        const text = m[4].replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#39;/g, "'");
        if (text) runs.push({ text, bold: boldDepth > 0, href: href || undefined });
      } else {
        const closing = m[1] === '/', tag = m[2].toLowerCase();
        if (tag === 'b' || tag === 'strong') boldDepth += closing ? -1 : 1;
        if (tag === 'a') href = closing ? null : (m[3] || null);
      }
    }
    if (!runs.length) runs.push({ text: '', bold: false });
    runs.forEach((run, i) => {
      const isFirst = i === 0, isLast = i === runs.length - 1;
      doc.font(run.bold ? 'Helvetica-Bold' : 'Helvetica').fontSize(fontSize).fillColor(run.href ? '#4F46E5' : color);
      const textOpts = { width, lineGap, continued: !isLast };
      if (run.href) { textOpts.link = run.href; textOpts.underline = true; }
      if (isFirst) doc.text(run.text, x, curY, textOpts);
      else doc.text(run.text, textOpts);
    });
    curY = doc.y;
  });
  doc.font('Helvetica');
  return curY;
}

// ── FÆLLES PDF-HEADER/FOOTER (moderne "Billy"-stil) ──────────────────────
// Logoet får lov at føre alene (intet firmanavn ved siden af når der er et
// logo) — kun hvis der IKKE er uploadet et logo endnu vises navnet i stedet,
// så headeren ikke står helt tom. Returnerer Y hvor næste indhold kan starte.
function drawDocHeader(doc, docLabel, docNumber, metaLines, accent, company) {
  const logoBuf = logoDataUriToBuffer(company.logoUrl);
  if (logoBuf) {
    try { doc.image(logoBuf, 40, 30, { fit: [220, 90] }); } catch (e) { /* korrupt billede — spring logoet over */ }
  } else {
    doc.font('Helvetica-Bold').fontSize(18).fillColor('#111318').text(company.name, 40, 54);
    doc.font('Helvetica');
  }
  doc.fontSize(23).fillColor(accent).text(docLabel, 340, 40, { width: 215, align: 'right' });
  doc.fontSize(10).fillColor('#111318').text(docNumber, 340, 71, { width: 215, align: 'right' });
  doc.fontSize(9).fillColor('#9CA3AF');
  metaLines.forEach((l, i) => doc.text(l, 340, 87 + i * 13, { width: 215, align: 'right' }));
  const y = 150;
  doc.moveTo(40, y).lineTo(555, y).strokeColor('#EEF0F3').lineWidth(1).stroke();
  return y + 24;
}

// "Fra:" (Gulv Master selv) i venstre kolonne og "Til:" (kunden) i højre —
// som Martin bad om, i stedet for kun "Til:" som før.
function drawFraTilBlock(doc, y, company, record) {
  const colW = 235;
  doc.font('Helvetica').fontSize(8).fillColor('#9CA3AF').text('FRA', 40, y, { characterSpacing: 0.5 });
  doc.text('TIL', 305, y, { characterSpacing: 0.5 });
  let leftY = y + 14, rightY = y + 14;
  doc.font('Helvetica-Bold').fontSize(10.5).fillColor('#111318').text(company.name, 40, leftY, { width: colW });
  leftY += 14;
  doc.font('Helvetica').fontSize(9).fillColor('#6B7280');
  [company.address, company.cvr ? `CVR ${company.cvr}` : '', company.phone, company.email].filter(Boolean).forEach((l) => { doc.text(l, 40, leftY, { width: colW }); leftY += 12; });

  const rightName = record.job_name || '';
  if (rightName) {
    doc.font('Helvetica-Bold').fontSize(10.5).fillColor('#111318').text(rightName, 305, rightY, { width: colW });
    rightY += 14;
  }
  doc.font('Helvetica').fontSize(9).fillColor('#6B7280');
  [record.customer_address, record.customer_phone ? 'Tlf. ' + record.customer_phone : '', record.customer_email].filter(Boolean).forEach((l) => { doc.text(l, 305, rightY, { width: colW }); rightY += 12; });

  return Math.max(leftY, rightY) + 12;
}

// Fælles centreret bund-footer: CVR + betalingsoplysninger (bankreg/konto,
// IBAN/SWIFT) samlet og centreret, plus en evt. fri footer-note derunder —
// som Martin bad om ("firmaets [betalings]data centeret i bunden").
function drawDocFooter(doc, company) {
  const parts = [];
  if (company.cvr) parts.push(`CVR ${company.cvr}`);
  if (company.bankReg || company.bankAccount) parts.push(`Reg. ${company.bankReg}  Konto ${company.bankAccount}`);
  if (company.iban) parts.push(`IBAN ${company.iban}`);
  if (company.swift) parts.push(`SWIFT/BIC ${company.swift}`);
  let y = 763;
  if (parts.length) {
    doc.moveTo(190, y).lineTo(405, y).strokeColor('#EEF0F3').lineWidth(1).stroke();
    y += 9;
    doc.font('Helvetica').fontSize(8).fillColor('#9CA3AF').text(parts.join('   ·   '), 40, y, { width: 515, align: 'center' });
    y += 13;
  }
  if (company.footerNote) {
    doc.font('Helvetica').fontSize(8).fillColor('#B7BCC5').text(company.footerNote, 40, y, { width: 515, align: 'center' });
  }
}

// Linje-beskrivelse i den RIGTIGE PDF (PDFKit, ikke HTML/CSS) — samme opdeling som
// lineDescCellHtml() ovenfor: 1. linje af l.description = overskrift (fed), resten =
// beskrivelse (lidt federe end almindelig tekst — der er kun 2 vægte i PDFKits
// standard-Helvetica, så "en lille smule tykkere" er løst med selve overskriftens fed
// skrift + normal Helvetica for beskrivelsen, i stedet for en ikke-eksisterende "semibold"),
// og l.note (nyt separat felt, Martins ønske sep. 2026) i sin egen lyse boks nedenunder.
// To funktioner: _pdfLineDescParts() deler teksten op ét sted, højde-funktionen bruges til
// at reservere korrekt plads FØR noget tegnes (PDFKit har ingen automatisk layout-flow).
function _pdfLineDescParts(l) {
  const full = String(l.description || '');
  const nl = full.indexOf('\n');
  return {
    heading: nl === -1 ? full : full.slice(0, nl),
    rest: nl === -1 ? '' : full.slice(nl + 1).trim(),
    note: (l.note && String(l.note).trim()) ? String(l.note).trim() : ''
  };
}
function pdfLineDescHeight(doc, l, width) {
  const p = _pdfLineDescParts(l);
  doc.font('Helvetica-Bold').fontSize(9.5);
  let h = doc.heightOfString(p.heading, { width });
  if (p.rest) {
    doc.font('Helvetica').fontSize(9.5);
    h += 3 + doc.heightOfString(p.rest, { width });
  }
  if (p.note) {
    doc.font('Helvetica-Oblique').fontSize(8.5);
    h += 8 + doc.heightOfString(p.note, { width: width - 16 }) + 12;
  }
  doc.font('Helvetica').fontSize(9.5);
  return h;
}
function drawPdfLineDesc(doc, l, x, y, width) {
  const p = _pdfLineDescParts(l);
  doc.font('Helvetica-Bold').fontSize(9.5).fillColor('#111318').text(p.heading, x, y, { width });
  let cy = y + doc.heightOfString(p.heading, { width });
  if (p.rest) {
    doc.font('Helvetica').fontSize(9.5).fillColor('#374151').text(p.rest, x, cy + 3, { width });
    cy += 3 + doc.heightOfString(p.rest, { width });
  }
  if (p.note) {
    doc.font('Helvetica-Oblique').fontSize(8.5);
    const noteH = doc.heightOfString(p.note, { width: width - 16 });
    cy += 8;
    doc.roundedRect(x - 2, cy, width + 4, noteH + 12, 4).fill('#FFF7ED');
    doc.fillColor('#7C2D12').text(p.note, x + 6, cy + 6, { width: width - 16 });
    cy += noteH + 12;
  }
  doc.font('Helvetica').fontSize(9.5).fillColor('#111318');
  return cy - y;
}
function drawDocumentPdf(doc, kind, record, company) {
  const isInvoice = kind === 'invoice';
  const accent = '#4F46E5';
  const metaLines = [`Dato: ${String(record.created_at || '').slice(0, 10)}`];
  if (isInvoice && record.due_date) metaLines.push(`Forfaldsdato: ${record.due_date}`);
  if (!isInvoice && record.valid_until) metaLines.push(`Gyldig til: ${record.valid_until}`);
  let y = drawDocHeader(doc, isInvoice ? 'FAKTURA' : 'TILBUD', isInvoice ? record.invoice_number : record.quote_number, metaLines, accent, company);

  y = drawFraTilBlock(doc, y, company, record);

  if (!isInvoice && record.top_note) {
    const noteH = doc.heightOfString(richTextToPlain(record.top_note), { width: 495 });
    doc.roundedRect(40, y, 515, noteH + 20, 8).fill('#F7F8FC');
    renderRichText(doc, record.top_note, 50, y + 10, 495, { color: '#374151' });
    y += noteH + 32;
  }

  y = Math.max(y + 6, 222);
  doc.roundedRect(40, y, 515, 24, 6).fill('#F4F6FB');
  doc.font('Helvetica').fontSize(9).fillColor('#374151');
  doc.text('Beskrivelse', 52, y + 8);
  doc.text('Antal', 320, y + 8, { width: 50, align: 'right' });
  doc.text('Enhedspris', 380, y + 8, { width: 80, align: 'right' });
  doc.text('I alt', 457, y + 8, { width: 80, align: 'right' });
  y += 32;
  doc.fontSize(9.5).fillColor('#111318');
  let rawSubtotal = 0;
  (record.lines || []).forEach(l => {
    if (l.line_type === 'text') {
      const h = doc.heightOfString(l.description, { width: 507 });
      doc.font('Helvetica-Bold').fontSize(9.5).fillColor('#111318').text(l.description, 48, y, { width: 507 });
      doc.font('Helvetica');
      y += h + 12;
      doc.moveTo(40, y - 4).lineTo(555, y - 4).strokeColor('#EEF0F3').stroke();
      return;
    }
    const lineDiscType = l.discount_type === 'fixed' ? 'fixed' : 'pct';
    const lineDiscVal = Number(l.discount_pct) || 0;
    const gross = Number(l.quantity) * Number(l.sell_price);
    const lineDiscAmt = lineDiscountAmount(l, gross);
    const lineTotal = gross - lineDiscAmt;
    rawSubtotal += lineTotal;
    const lineDiscLabel = lineDiscVal ? (lineDiscType === 'fixed' ? ` (-${Math.round(lineDiscVal).toLocaleString('da-DK')} kr)` : ` (-${lineDiscVal}%)`) : '';
    // Overskrift/beskrivelse/note (sep. 2026) — se pdfLineDescHeight/drawPdfLineDesc
    // ovenfor drawDocumentPdf. Højden skal beregnes FØRST (PDFKit har intet automatisk
    // layout-flow), så antal/pris-kolonnerne og skillelinjen kan placeres korrekt.
    const nameHeight = pdfLineDescHeight(doc, l, 260);
    doc.font('Helvetica').fontSize(9.5).fillColor('#111318');
    doc.text(String(l.quantity) + ' ' + (l.unit || '') + lineDiscLabel, 320, y, { width: 50, align: 'right' });
    doc.text(Math.round(Number(l.sell_price)).toLocaleString('da-DK') + ' kr', 380, y, { width: 80, align: 'right' });
    doc.text(Math.round(lineTotal).toLocaleString('da-DK') + ' kr', 457, y, { width: 80, align: 'right' });
    drawPdfLineDesc(doc, l, 48, y, 260);
    y += Math.max(nameHeight, 14) + 8;
    doc.moveTo(40, y - 4).lineTo(555, y - 4).strokeColor('#EEF0F3').stroke();
  });

  y += 12;
  const totalsX = 380;
  const docDiscountType = record.discount_type === 'fixed' ? 'fixed' : 'pct';
  const docDiscountPct = Number(record.discount_pct) || 0;
  const docDiscountAmount = docDiscountType === 'fixed' ? Math.max(0, Math.min(docDiscountPct, rawSubtotal)) : (docDiscountPct ? rawSubtotal * docDiscountPct / 100 : 0);
  const docDiscountLabel = docDiscountType === 'fixed' ? `${Math.round(docDiscountPct).toLocaleString('da-DK')} kr` : `${docDiscountPct}%`;
  if (docDiscountAmount > 0) {
    doc.fontSize(9.5).fillColor('#6B7280').text(`Rabat (${docDiscountLabel})`, totalsX, y, { width: 80, align: 'right' });
    doc.fillColor('#DC2626').text('-' + Math.round(docDiscountAmount).toLocaleString('da-DK') + ' kr', 457, y, { width: 80, align: 'right' });
    y += 16;
  }
  doc.fontSize(9.5).fillColor('#6B7280').text('Subtotal', totalsX, y, { width: 80, align: 'right' });
  doc.fillColor('#111318').text(Math.round(Number(record.subtotal)).toLocaleString('da-DK') + ' kr', 457, y, { width: 80, align: 'right' });
  y += 16;
  doc.fillColor('#6B7280').text(`Moms (${record.tax_rate}%)`, totalsX, y, { width: 80, align: 'right' });
  doc.fillColor('#111318').text(Math.round(Number(record.tax_amount)).toLocaleString('da-DK') + ' kr', 457, y, { width: 80, align: 'right' });
  y += 20;
  doc.roundedRect(totalsX, y - 4, 165, 24, 6).fill(accent);
  doc.fillColor('#fff').fontSize(11).text('Total', totalsX + 10, y + 3);
  doc.text(Math.round(Number(record.total)).toLocaleString('da-DK') + ' kr', 457, y + 3, { width: 80, align: 'right' });
  y += 32;

  if (isInvoice && record.paid_total > 0) {
    doc.fontSize(9.5).fillColor('#15803D').text('Betalt', totalsX, y, { width: 80, align: 'right' });
    doc.text('-' + Math.round(Number(record.paid_total)).toLocaleString('da-DK') + ' kr', 457, y, { width: 80, align: 'right' });
    y += 16;
    doc.fontSize(10).fillColor('#B91C1C').text('Restbeløb', totalsX, y, { width: 80, align: 'right' });
    doc.text(Math.round(Number(record.remaining)).toLocaleString('da-DK') + ' kr', 457, y, { width: 80, align: 'right' });
    y += 20;
  }

  if (record.notes) {
    y += 12;
    const noteH = doc.heightOfString(richTextToPlain(record.notes), { width: 495 });
    doc.roundedRect(40, y, 515, noteH + 20, 8).fill('#F7F8FC');
    renderRichText(doc, record.notes, 50, y + 10, 495, { color: '#374151' });
    y += noteH + 30;
  }

  if (!isInvoice && record.status === 'accepted' && record.signed_name) {
    y += 8;
    doc.font('Helvetica').fontSize(9).fillColor('#15803D').text(`✓ Accepteret af ${record.signed_name} den ${String(record.signed_at || '').slice(0, 16).replace('T', ' ')}`, 40, y, { width: 515 });
    y += 15;
    if (record.signature_data && /^data:image\/(png|jpeg);base64,/.test(record.signature_data)) {
      try {
        const imgBuf = Buffer.from(record.signature_data.split(',')[1], 'base64');
        doc.image(imgBuf, 40, y, { width: 150 });
        y += 55;
      } catch (e) { /* ugyldigt billede — spring underskriften over på PDF'en */ }
    }
  }

  drawDocFooter(doc, company);
}
// Kreditnotaer er beløbs-/begrundelses-baserede (ikke linje-baserede som
// tilbud/faktura), så de har deres egen, langt enklere tegne-funktion frem for
// at genbruge drawDocumentPdf's linje-tabel. Bruger samme fælles header/footer
// som tilbud/faktura for et ensartet, moderne udtryk.
function drawCreditNotePdf(doc, creditNote, invoice, company) {
  const accent = '#DC2626';
  const metaLines = [`Dato: ${String(creditNote.created_at || '').slice(0, 10)}`, `Vedr. faktura: ${invoice ? invoice.invoice_number : ''}`];
  let y = drawDocHeader(doc, 'KREDITNOTA', creditNote.credit_note_number, metaLines, accent, company);

  doc.font('Helvetica').fontSize(8).fillColor('#9CA3AF').text('TIL', 40, y);
  y += 14;
  if (invoice && invoice.job_name) { doc.font('Helvetica-Bold').fontSize(10.5).fillColor('#111318').text(invoice.job_name, 40, y); y += 14; }
  doc.font('Helvetica').fontSize(9).fillColor('#6B7280');
  if (invoice && invoice.customer_address) { doc.text(invoice.customer_address, 40, y); y += 12; }

  y = Math.max(y + 20, 210);
  doc.roundedRect(40, y, 515, 64, 10).fill('#FEF2F2');
  doc.fontSize(9.5).fillColor('#6B7280').text('Krediteret beløb', 56, y + 14);
  doc.font('Helvetica-Bold').fontSize(20).fillColor(accent).text(Math.round(Number(creditNote.amount)).toLocaleString('da-DK') + ' kr', 56, y + 30);
  doc.font('Helvetica');
  y += 84;

  if (creditNote.reason) {
    doc.fontSize(9).fillColor('#374151').text('Begrundelse:', 40, y);
    y += 14;
    doc.fontSize(9.5).fillColor('#111318').text(creditNote.reason, 40, y, { width: 515 });
    y += doc.heightOfString(creditNote.reason, { width: 515 }) + 10;
  }

  drawDocFooter(doc, company);
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

app.get('/api/quotes/:id/pdf', auth, panelAccess('quotes'), asyncRoute(async (req, res) => {
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

app.get('/api/invoices/:id/pdf', auth, panelAccess('quotes'), asyncRoute(async (req, res) => {
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
// Linje-beskrivelse på tilbud/faktura (sep. 2026, Martins ønske): 1. linje af
// l.description er OVERSKRIFTEN (produktnavnet — se qzProductLineText i admin.html, som
// sætter navn+beskrivelse sammen med et linjeskift NÅR man vælger et produkt), resten af
// teksten er selve beskrivelsen, vist lidt federe lige under overskriften. l.note er et
// helt separat felt (products.note / quote_lines.note / invoice_lines.note) og vises i sin
// egen fremhævede boks NEDERST — adskilt fra beskrivelsen, som Martin bad om. Bruges af
// /tilbud/:token nedenfor; drawDocumentPdf (rigtig PDF) har sin egen PDFKit-udgave af
// samme opdeling, da PDFKit ikke kan bruge HTML/CSS.
function lineDescCellHtml(l) {
  const full = String(l.description || '');
  const nl = full.indexOf('\n');
  const heading = nl === -1 ? full : full.slice(0, nl);
  const rest = nl === -1 ? '' : full.slice(nl + 1).trim();
  let html = `<div class="ln-heading">${escPublic(heading)}</div>`;
  if (rest) html += `<div class="ln-desc">${escPublic(rest)}</div>`;
  if (l.note && String(l.note).trim()) html += `<div class="ln-note">${escPublic(String(l.note).trim())}</div>`;
  return html;
}

app.get('/api/quotes/:id/share-link', auth, panelAccess('quotes'), asyncRoute(async (req, res) => {
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
app.get('/api/settings/email-template-assignments', auth, panelAccess('email-templates'), asyncRoute(async (req, res) => {
  res.json(await getEmailTemplateAssignments());
}));
app.put('/api/settings/email-template-assignments', auth, panelAccess('email-templates'), asyncRoute(async (req, res) => {
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

app.post('/api/quotes/:id/send', auth, panelAccess('quotes'), asyncRoute(async (req, res) => {
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
  // ARKIVERING — gem den PRÆCISE PDF (som blev sendt) + et datasnapshot som en ny
  // nummereret version, så tilbuddet altid kan redigeres/gensendes videre uden at en
  // tidligere given pris/PDF nogensinde forsvinder eller ændres i baglommen. Fejler
  // arkiveringen af en eller anden grund, må det IKKE vælte selve afsendelsen — mailen
  // er allerede sendt til kunden på dette tidspunkt.
  try {
    const mx = await pgOne('SELECT COALESCE(MAX(version_number),0) AS mx FROM quote_sends WHERE quote_id=$1', [quote.id]);
    const versionNumber = Number(mx.mx) + 1;
    await pool.query(
      'INSERT INTO quote_sends (quote_id,version_number,sent_by,recipient,pdf_snapshot,snapshot_data) VALUES ($1,$2,$3,$4,$5,$6)',
      [quote.id, versionNumber, req.user.name, to, pdfBuffer, JSON.stringify(quote)]
    );
  } catch (e) { console.error('Kunne ikke arkivere tilbudsversion:', e.message); }
  res.json({ ok: true });
}));

app.get('/api/quotes/:id/sends', auth, panelAccess('quotes'), asyncRoute(async (req, res) => {
  const rows = await pool.query('SELECT id,version_number,sent_at,sent_by,recipient FROM quote_sends WHERE quote_id=$1 ORDER BY version_number DESC', [req.params.id]);
  res.json(rows.rows);
}));

app.get('/api/quotes/:id/sends/:sendId/pdf', auth, panelAccess('quotes'), asyncRoute(async (req, res) => {
  const row = await pgOne('SELECT pdf_snapshot,version_number FROM quote_sends WHERE id=$1 AND quote_id=$2', [req.params.sendId, req.params.id]);
  if (!row || !row.pdf_snapshot) return res.status(404).json({ error: 'Den arkiverede PDF-version blev ikke fundet' });
  res.set('Content-Type', 'application/pdf');
  res.set('Content-Disposition', `inline; filename="tilbud-v${row.version_number}.pdf"`);
  res.send(row.pdf_snapshot);
}));

app.post('/api/invoices/:id/send', auth, panelAccess('quotes'), asyncRoute(async (req, res) => {
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
    if (l.line_type === 'text') {
      return `<tr><td colspan="4" class="ln-textrow">${esc(l.description)}</td></tr>`;
    }
    const discType = l.discount_type === 'fixed' ? 'fixed' : 'pct';
    const disc = Number(l.discount_pct) || 0;
    const gross = Number(l.quantity) * Number(l.sell_price);
    const lineTotal = gross - lineDiscountAmount(l, gross);
    const discLabel = disc ? (discType === 'fixed' ? ` (-${Math.round(disc).toLocaleString('da-DK')} kr)` : ` (-${disc}%)`) : '';
    return `<tr><td>${lineDescCellHtml(l)}</td><td class="num">${Number(l.quantity)} ${esc(l.unit || '')}${discLabel}</td><td class="num">${krFmtServer(l.sell_price)}</td><td class="num">${krFmtServer(lineTotal)}</td></tr>`;
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
  .doc-top{display:flex;justify-content:space-between;align-items:flex-start;gap:16px;flex-wrap:wrap;padding-bottom:18px;border-bottom:1px solid #EEF0F3;margin-bottom:20px}
  .company-logo-lg{max-width:260px;max-height:96px;object-fit:contain}
  .company-name-fallback{font-size:19px;font-weight:800}
  .doctype{font-size:21px;font-weight:800;color:#4F46E5;text-align:right}
  .docmeta{font-size:11px;color:#9CA3AF;text-align:right;margin-top:4px;line-height:1.7}
  .fratil{display:flex;gap:24px;flex-wrap:wrap;margin:0 0 18px}
  .fratil>div{flex:1;min-width:190px}
  .fratil-label{font-size:10px;font-weight:700;color:#9CA3AF;letter-spacing:.05em;margin-bottom:6px}
  .fratil-name{font-size:14px;font-weight:700;margin-bottom:3px}
  .fratil-line{font-size:12px;color:#6B7280;line-height:1.6}
  table{width:100%;border-collapse:collapse;font-size:13px;margin:14px 0}
  th{text-align:left;background:#F4F6FB;padding:8px 10px;font-size:11px;color:#374151}
  th.num,td.num{text-align:right}
  td{padding:8px 10px;border-bottom:1px solid #EEF0F3}
  .ln-heading{font-weight:700}
  .ln-desc{font-weight:600;color:#374151;margin-top:3px;white-space:pre-line}
  .ln-note{margin-top:6px;background:#FFF7ED;border-left:3px solid #FB923C;border-radius:6px;padding:6px 9px;font-size:11.5px;font-weight:500;color:#7C2D12;white-space:pre-line}
  .ln-textrow{font-weight:700;white-space:pre-line}
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
  .notecard{margin:14px 0;font-size:12.5px;color:#374151;background:#F7F8FC;border-radius:10px;padding:14px 16px;line-height:1.6;word-break:break-word}
  .notecard a{color:#4F46E5}
  .pagefooter{max-width:640px;margin:0 auto;text-align:center;font-size:11px;color:#9CA3AF;padding:6px 8px 0;line-height:1.8}
  .pagefooter .note{color:#C6CBD3;font-size:10.5px;margin-top:4px}
</style></head><body><div class="wrap">
<div class="card">
  <div class="doc-top">
    ${company.logoUrl ? `<img class="company-logo-lg" src="${esc(company.logoUrl)}" alt="${esc(company.name)}">` : `<div class="company-name-fallback">${esc(company.name)}</div>`}
    <div><div class="doctype">TILBUD</div><div class="docmeta">${esc(quote.quote_number)}<br>Dato: ${esc(String(quote.created_at || '').slice(0, 10))}${quote.valid_until ? `<br>Gyldig til: ${esc(quote.valid_until)}` : ''}</div></div>
  </div>
  <div class="fratil">
    <div><div class="fratil-label">FRA</div><div class="fratil-name">${esc(company.name)}</div>${[company.address, company.cvr ? 'CVR ' + company.cvr : '', company.phone, company.email].filter(Boolean).map(l => `<div class="fratil-line">${esc(l)}</div>`).join('')}</div>
    <div><div class="fratil-label">TIL</div>${quote.job_name ? `<div class="fratil-name">${esc(quote.job_name)}</div>` : ''}${[quote.customer_address, quote.customer_phone ? 'Tlf. ' + quote.customer_phone : '', quote.customer_email].filter(Boolean).map(l => `<div class="fratil-line">${esc(l)}</div>`).join('')}</div>
  </div>
  ${quote.top_note ? `<div class="notecard">${quote.top_note}</div>` : ''}
  <table><thead><tr><th>Beskrivelse</th><th class="num">Antal</th><th class="num">Enhedspris</th><th class="num">I alt</th></tr></thead><tbody>${rowsHtml}</tbody></table>
  <div class="totals">
    ${discountAmount > 0 ? `<div class="totals-row"><span>Rabat (${docDiscLabel})</span><span>-${krFmtServer(discountAmount)}</span></div>` : ''}
    <div class="totals-row"><span>Subtotal</span><span>${krFmtServer(quote.subtotal)}</span></div>
    <div class="totals-row"><span>Moms (${quote.tax_rate}%)</span><span>${krFmtServer(quote.tax_amount)}</span></div>
    <div class="totals-row grand"><span>Total</span><span>${krFmtServer(quote.total)}</span></div>
  </div>
  ${quote.notes ? `<div class="notecard">${quote.notes}</div>` : ''}
</div>
<div class="card">${statusBlock}</div>
${(company.cvr || company.bankReg || company.bankAccount || company.iban || company.swift || company.footerNote) ? `<div class="pagefooter">${[company.cvr ? 'CVR ' + company.cvr : '', (company.bankReg || company.bankAccount) ? ('Reg. ' + company.bankReg + '  Konto ' + company.bankAccount) : '', company.iban ? 'IBAN ' + company.iban : '', company.swift ? 'SWIFT/BIC ' + company.swift : ''].filter(Boolean).map(esc).join('  ·  ')}${company.footerNote ? `<div class="note">${esc(company.footerNote)}</div>` : ''}</div>` : ''}
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
      // Sagsnummer tildeles automatisk her, i samme GM-ÅÅÅÅ-NNNN-stil som Tilbud (TIL-)
      // og Faktura (FAK-) allerede bruger — se nextDocNumber(). Martin bad om at nye
      // sager altid får et sagsnummer fra start, i stedet for at det skal tastes ind
      // manuelt bagefter som på de enkelte opgaver i Tidslinje/Daglig plan.
      const jobNumber = await nextDocNumber('project', 'GM');
      const p = await pgOne(`
        INSERT INTO projects (quote_id, name, customer_id, customer_address, customer_phone, customer_email, job_number)
        VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING id
      `, [quote.id, quote.job_name || quote.quote_number, quote.customer_id, quote.customer_address, quote.customer_phone, quote.customer_email, jobNumber]);
      projectId = p.id;
    }
  } catch (e) {
    // Selve accepten er allerede gemt — en fejl her må ikke vælte kundens kvittering.
  }
  // AUTOMATISK VELKOMSTMAIL — sender kundens PERMANENTE kundeportal-link (alle
  // tilbud/fakturaer/opgaver ét sted) med det samme kunden har accepteret, så de ikke
  // længere skal bruge det midlertidige underskrifts-link. Fejler mailen (fx ikke
  // konfigureret), må det aldrig vælte selve accept-kvitteringen, som allerede er gemt.
  try {
    if (quote.customer_email && mailIsConfigured()) {
      const company = await getCompanyInfo();
      const portalToken = quote.job_name ? await getOrCreateCustomerPortalToken(quote.job_name) : null;
      const portalLink = portalToken ? customerPortalLinkFor(portalToken) : PUBLIC_APP_URL;
      const firstName = name.split(' ')[0];
      // Emne/besked hentes nu fra det samlede Skabeloner-center (system_email_templates,
      // key='quote_accepted') i stedet for at være hårdkodet — se leveringsnoten.
      const sysTpl = await pgOne("SELECT * FROM system_email_templates WHERE key='quote_accepted'");
      if (!sysTpl || sysTpl.enabled) {
        const vars = { kunde: escPublic(firstName), firma: escPublic(company.name), link: escPublic(portalLink), dokument_nr: escPublic(quote.quote_number) };
        const subject = fillDocEmailVars(sysTpl?.subject || `Tak for din accept, {{kunde}}! 🎉`, vars);
        const bodyHtml = fillDocEmailVars(sysTpl?.body_html || `<p>Hej {{kunde}},</p><p>Tusind tak fordi du har accepteret tilbuddet <b>{{dokument_nr}}</b> hos {{firma}} — vi glæder os til at komme i gang! 🛠️</p><p>Du kan altid følge dit projekt og se alle dine tilbud og fakturaer på din helt egen side her, uden at skulle logge ind:</p><p><a href="{{link}}">{{link}}</a></p><p>Gem gerne linket — det er dit permanente overblik fremover.</p><p>Har du spørgsmål, er du altid velkommen til at kontakte os.</p><p>Mange hilsner<br>{{firma}}</p>`, vars);
        await sendMailUniversal({ to: quote.customer_email, subject, html: bodyHtml, text: stripHtmlToText(bodyHtml) });
        logDocActivity('quote', quote.id, 'accepted_email_sent', 'System', `til ${quote.customer_email}`);
      }
    }
  } catch (e) { console.error('Kunne ikke sende accept-kvitteringsmail:', e.message); }
  res.json({ ok: true, project_id: projectId });
}));

// ══════════════════════════════════════════════════════════════
// PRISFORESPØRGSLER (RFQ) — send tilbuddets materiale-linjer til leverandører
// ("supplier", uden priser) for at indhente sammenlignelige priser, eller send
// hele tilbuddet til en underleverandør ("subcontractor") med blanke pris-felter
// de selv udfylder online. Systemet sender selv e-mails via sendMailUniversal.
// ══════════════════════════════════════════════════════════════
app.post('/api/quotes/:id/requests', auth, panelAccess('quotes'), asyncRoute(async (req, res) => {
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

app.get('/api/quotes/:id/requests', auth, panelAccess('quotes'), asyncRoute(async (req, res) => {
  const requests = (await pool.query('SELECT * FROM quote_requests WHERE quote_id=$1 ORDER BY created_at DESC', [req.params.id])).rows;
  for (const r of requests) {
    r.lines = (await pool.query('SELECT * FROM quote_request_lines WHERE request_id=$1 ORDER BY position ASC, id ASC', [r.id])).rows;
    r.recipients = (await pool.query('SELECT * FROM quote_request_recipients WHERE request_id=$1 ORDER BY created_at ASC', [r.id])).rows;
  }
  res.json(requests);
}));

app.delete('/api/quote-requests/:id', auth, panelAccess('quotes'), asyncRoute(async (req, res) => {
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
  td:first-child{white-space:pre-line}
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

// ══ ÉNGANGSOPRYDNING: GAMLE JOBTREAD-OPGAVER UD AF OPGAVEPOOLEN ═════════════
//
// Baggrund: Martin er migreret helt væk fra JobTread og har genoprettet alle
// sine sager internt i appen. De gamle source='jobtread'-rækker i jt_tasks står
// derfor tilbage i Opgavepool/Kapacitet/Tidslinje som forvirrende dubletter af
// hans nye interne sager. De skal væk — MEN alt der har rigtig historik hængende
// på sig skal blive stående, urørt.
//
// SIKKERHEDSREGLEN: en jt_tasks-række slettes kun hvis
//   1) COALESCE(source,'jobtread') = 'jobtread'  (NULL = gammel legacy-række fra
//      før source-kolonnen fandtes, behandles som JobTread), OG
//   2) dens id findes IKKE i NOGEN af de tabeller der peger tilbage på den.
// Alt andet springes helt over — ingen ændring, ingen markering, intet.
//
// Der findes INGEN rigtige FOREIGN KEYs på tværs af disse tabeller (alle
// task_id-kolonner er almindelige TEXT-kolonner uden REFERENCES), så Postgres
// stopper os ikke selv — listen herunder er fundet ved at gennemgå hele skemaet
// i initSchema() for kolonner der gemmer et jt_tasks.id:
//   planning_bookings.task_id       — bookinger ude hos medarbejderne
//   assignments.task_id             — den gamle bookingtabel fra før planning_bookings
//   time_logs.task_id               — tidsregistrering
//   task_checklist_items.task_id    — tjekpunkter
//   customer_visits.task_id         — kundebesøgsskemaer
//   job_files.task_id               — uploadede billeder/filer på opgaven
//   completion_emails.task_id       — "opgaven er færdig"-mails til kunden
//   customer_schedule_emails.task_id— planlagt/påmindelses-mails til kunden
//   customer_schedule_sms.task_id   — påmindelses-SMS til kunden
// (gantt_tasks har kun parent_task_id, som peger på gantt_tasks' EGNE rækker —
//  ikke på jt_tasks — og Gantt-fanen læser i det hele taget gantt_tasks, ikke
//  jt_tasks, så den er helt urørt af denne oprydning.)
//
// Bevidst mere forsigtig end "tjek kun bookinger": en JobTread-opgave, der
// aldrig kom gennem bookingflowet, men som der ER registreret tid eller
// uploadet billeder på, ville ellers forsvinde i stilhed.
const JOBTREAD_CLEANUP_MIGRATION = 'jobtread_task_pool_cleanup_20260905';
const JOBTREAD_CLEANUP_REFERENCES = [
  { table: 'planning_bookings', label: 'booking' },
  { table: 'assignments', label: 'gammel booking' },
  { table: 'time_logs', label: 'tidsregistrering' },
  { table: 'task_checklist_items', label: 'tjekliste' },
  { table: 'customer_visits', label: 'kundebesøg' },
  { table: 'job_files', label: 'fil' },
  { table: 'completion_emails', label: 'færdig-mail' },
  { table: 'customer_schedule_emails', label: 'planlægningsmail' },
  { table: 'customer_schedule_sms', label: 'påmindelses-SMS' }
];

async function runJobTreadPoolCleanup() {
  // Gate #1 (uden for transaktionen): er den allerede kørt, så laves der intet
  // arbejde overhovedet — hverken tælling eller sletning. Gate #2 ligger inde i
  // transaktionen herunder, så to samtidige opstarter aldrig kan køre den to gange.
  const already = await pgOne('SELECT 1 FROM app_migrations WHERE name=$1', [JOBTREAD_CLEANUP_MIGRATION]);
  if (already) return { ok: true, skipped: true, reason: 'already_done' };

  const notReferenced = JOBTREAD_CLEANUP_REFERENCES
    .map(r => `NOT EXISTS (SELECT 1 FROM ${r.table} x WHERE x.task_id = t.id)`)
    .join('\n        AND ');

  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const claimed = await client.query(
      "INSERT INTO app_migrations (name, details) VALUES ($1, $2) ON CONFLICT (name) DO NOTHING",
      [JOBTREAD_CLEANUP_MIGRATION, 'Kører…']
    );
    if (!claimed.rowCount) {
      await client.query('ROLLBACK');
      return { ok: true, skipped: true, reason: 'already_done' };
    }

    // Hvor mange JobTread-rækker findes der i alt, og hvor mange af dem har
    // historik på sig? Tælles FØR sletningen, i samme transaktion.
    const breakdownSelect = JOBTREAD_CLEANUP_REFERENCES
      .map(r => `(SELECT COUNT(*)::int FROM jt_tasks t WHERE COALESCE(t.source,'jobtread')='jobtread' AND EXISTS (SELECT 1 FROM ${r.table} x WHERE x.task_id = t.id)) AS "${r.table}"`)
      .join(',\n        ');
    const counts = await client.query(`
      SELECT
        (SELECT COUNT(*)::int FROM jt_tasks t WHERE COALESCE(t.source,'jobtread')='jobtread') AS jobtread_total,
        (SELECT COUNT(*)::int FROM jt_tasks t WHERE COALESCE(t.source,'jobtread')='jobtread' AND ${notReferenced}) AS deletable,
        ${breakdownSelect}
    `);
    const c = counts.rows[0];
    const kept = c.jobtread_total - c.deletable;

    const deleted = await client.query(`
      DELETE FROM jt_tasks t
      WHERE COALESCE(t.source,'jobtread')='jobtread'
        AND ${notReferenced}
    `);

    // Læselig opdeling af HVORFOR de bevarede rækker blev bevaret. Én opgave kan
    // sagtens tælle med i flere kolonner (fx både booking og tidsregistrering),
    // så tallene summer ikke nødvendigvis til "beholdt".
    const reasons = JOBTREAD_CLEANUP_REFERENCES
      .filter(r => c[r.table] > 0)
      .map(r => `${r.label}: ${c[r.table]}`)
      .join(', ');
    const message = `JobTread-oprydning: slettede ${deleted.rowCount} gamle JobTread-opgaver uden nogen historik. `
      + `Beholdt ${kept} opgaver der stadig har en booking/tidsregistrering/tjekliste/besøg/fil/mail knyttet til sig.`
      + (reasons ? ` (Bevaret pga. — ${reasons}. Samme opgave kan tælle med flere steder.)` : '')
      + ' Manuelle opgaver, sags-opgaver fra Projekter og kapacitetsrækker er ikke rørt.';

    await client.query('UPDATE app_migrations SET details=$2, completed_at=' + nowTextSQL() + ' WHERE name=$1', [JOBTREAD_CLEANUP_MIGRATION, message]);
    await client.query('COMMIT');

    await logSystemEvent('jobtread_cleanup', 'info', message);
    console.log(message);
    return { ok: true, deleted: deleted.rowCount, kept, total: c.jobtread_total };
  } catch (error) {
    try { await client.query('ROLLBACK'); } catch (_) {}
    throw error;
  } finally {
    client.release();
  }
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
  // ── JOBTREAD-SYNK TIL OPGAVEPOOLEN: SLÅET FRA PERMANENT 05-09-2026 ──────────
  // Martin har migreret alt væk fra JobTread og opretter nu selv kunder, sager,
  // tilbud og tidsplaner direkte i appen. Opgavepoolen (Opgavepool, Daglig
  // planlægning, Kapacitetsboard, Tidslinje) skal derfor udelukkende køre på
  // appens egne data — source='manual' / 'project' / 'capacity' — og må aldrig
  // få nye source='jobtread'-rækker ind igen. Se chat/commit for kontekst.
  //
  // syncFromJT() (og de tre baggrundskald den udløste ved succes:
  // syncCustomerPhonesFromJT, syncJobGeocodesInBackground, syncVendorsFromJT) er
  // bevidst IKKE slettet — kun frakoblet — så det hele nemt kan genaktiveres,
  // hvis det mod forventning skulle blive nødvendigt igen. Den gamle kode stod
  // præcis sådan her:
  //
  //   if (JT_GRANT && JT_ORG && JT_AUTO_SYNC && !migrationPending) {
  //     setTimeout(() => syncFromJT().catch(error => { ... }), 5000);
  //     cron.schedule('0 * * * *', () => syncFromJT().catch(error => { ... }));
  //   } else if (migrationPending) {
  //     console.log('JobTread-sync er sat på pause, indtil den første SQLite-import er færdig.');
  //   }

  // ── GEOKODNING: NU HELT UAFHÆNGIG AF JOBTREAD ──────────────────────────────
  // syncJobGeocodesInBackground() er IKKE JobTread-specifik: den slår adresser
  // op hos Nominatim (OpenStreetMap) for ALLE rækker i jt_tasks uanset source —
  // altså også manuelle opgaver, kundebesøg og sags-opgaver spejlet ind fra
  // Projekter. Den blev tidligere kun udløst som en sidegevinst af en vellykket
  // JobTread-synk, så uden dette kald ville kort/afstand (Ruter & kort,
  // Kapacitet) stille og roligt holde op med at virke for adresser på nye
  // interne sager. Den kører derfor nu i sit eget timeslot, uden nogen form for
  // JobTread-involvering (ingen grant/org-tjek nødvendig — funktionen kalder
  // aldrig JobTreads API).
  cron.schedule('0 * * * *', () => syncJobGeocodesInBackground().catch(error => { console.error('Planlagt geokodning fejlede:', error.message); logSystemEvent('geocode_sync', 'error', 'Planlagt geokodning (hver time) fejlede: ' + error.message); }));

  // ── ÉNGANGSOPRYDNING AF GAMLE JOBTREAD-OPGAVER I POOLEN ────────────────────
  // Kører højst én gang nogensinde (gated på app_migrations). Springes over så
  // længe den første SQLite-import mangler, for ellers ville oprydningen køre
  // mod en tom database, markere sig som gennemført, og de gamle JobTread-
  // rækker ville aldrig blive ryddet op efter importen.
  if (!migrationPending) {
    runJobTreadPoolCleanup().catch(error => { console.error('JobTread-oprydning fejlede:', error.message); logSystemEvent('jobtread_cleanup', 'error', 'JobTread-oprydning af opgavepoolen fejlede: ' + error.message); });
  } else {
    console.log('JobTread-oprydning af opgavepoolen afventer, at den første SQLite-import er færdig.');
  }
  // OBS: kunde-påmindelsen ("vi kommer i morgen") sendes IKKE automatisk længere —
  // kun når admin selv trykker på knappen (se POST /api/customer-emails/send-reminders
  // nedenfor). Notifikationsscanneren kører stadig automatisk, det er intern info,
  // ikke noget der går ud til kunder.
  cron.schedule('15 * * * *', () => runNotificationScan().catch(e => { console.error('Notifikationsscan fejlede:', e.message); logSystemEvent('notification_scan', 'error', 'Notifikationsscan fejlede: ' + e.message); }));
  // Rykker-scan kl. 10 hver dag — runDunningScan tjekker selv om det er slået til.
  cron.schedule('0 10 * * *', () => runDunningScan(false).catch(e => { console.error('Rykker-scan fejlede:', e.message); logSystemEvent('dunning_scan', 'error', 'Rykker-scan fejlede: ' + e.message); }));
  // Tabt-opfølgning kl. 10:30 hver dag — runLostFollowupScan tjekker selv om den er slået til.
  cron.schedule('30 10 * * *', () => runLostFollowupScan(false).catch(e => { console.error('Tabt-opfølgning fejlede:', e.message); logSystemEvent('lost_followup_scan', 'error', 'Tabt-opfølgning fejlede: ' + e.message); }));
  // Tidsbaserede stage-opfølgninger kl. 10:45 hver dag (15 min efter tabt-opfølgning) —
  // se crm_stage_followup_rules / runStageFollowupScan. Kan også køres manuelt via
  // "Kør nu (test)"-knappen i CRM → ⚙ Indstillinger → Pipelines.
  cron.schedule('45 10 * * *', () => runStageFollowupScan().catch(e => { console.error('Stage-opfølgningsscan fejlede:', e.message); logSystemEvent('stage_followup_scan', 'error', 'Stage-opfølgningsscan fejlede: ' + e.message); }));
  // Profit-analyse — gemmer et fast snapshot af indeværende måned kl. 08 d. 15. hver
  // måned, så Martin kan sammenligne måned for måned uden at tallene ændrer sig
  // bagefter. Kan også udløses manuelt via "Gem nu"-knappen i Oversigt.
  cron.schedule('0 8 15 * *', () => saveMonthlyProfitSnapshot().catch(e => { console.error('Profit-snapshot fejlede:', e.message); logSystemEvent('profit_snapshot', 'error', 'Månedligt profit-snapshot fejlede: ' + e.message); }));
  // Gmail-synk hver 5. minut — kører kun når GOOGLE_CLIENT_ID/SECRET er sat op
  // OG en postkasse rent faktisk er forbundet (se GET /api/gmail/status). Kan
  // også udløses manuelt via "Synk nu" på Gmail-indstillingssiden. (Sat op fra
  // hvert 30. minut efter Martins ønske — ægte live-synk via Google Cloud
  // Pub/Sub blev fravalgt pga. den ekstra GCP-opsætning/vedligehold det kræver.)
  cron.schedule('*/5 * * * *', async () => {
    if (!gmailIsConfigured()) return;
    const conn = await gmailGetConnection().catch(() => null);
    if (!conn || !conn.refresh_token_enc) return;
    try { await gmailSyncAll(); }
    catch (e) {
      console.error('Gmail-synk fejlede:', e.message);
      await pool.query('UPDATE gmail_connection SET last_sync_error=$1 WHERE id=1', [String(e.message).slice(0, 500)]).catch(() => {});
      await logSystemEvent('gmail', 'error', 'Planlagt Gmail-synk fejlede: ' + e.message);
    }
  });
}

start().catch(error => {
  console.error('FATAL STARTUP ERROR:', error.message);
  process.exit(1);
});
