'use strict';
// ══════════════════════════════════════════════════════════════
// NOTER — Notion-lignende noteprogram under Videnscenter. Overført fra
// Arkitekt & Boligrenovering-portalen (nov. 2026, Martin: "så mine kolleger kan
// begynde at bruge programmet hvor jeg så kan læse deres noter"). Forskelle her:
//  • Admin kan se (og rette) ALLE medarbejderes private sider — vist under
//    "👀 Medarbejdernes sider" i UI'et. Medarbejderne får det at vide i UI'et.
//  • Filer gemmes i egen tabel note_files (Gulv Master har ikke arch_intake_files).
// Martin: "et note program ... Et der fælles men også hvor vi kan have vores
// eget ligesom Notion bare bedre og mere moderne ... sætte et billede i
// toppen af hver note og give hver note et navn".
//  • Sider med undersider, i to rum: 'shared' (alle medarbejdere) og
//    'private' (kun ejeren). Undersider arver rummet fra roden.
//  • Indholdet gemmes som blokke (JSON) — se notes-ui.js for blok-typerne.
//  • Coverbillede, ikon, favoritter, papirkurv, søgning, kommentarer,
//    påmindelser (push + notifikation), @omtale af kolleger, link-kort og AI.
//  • Filer (billeder, PDF, video, filer) gemmes i Postgres (note_files) og
//    serveres på /filer/<nøgle>/<navn>.
// ══════════════════════════════════════════════════════════════
const crypto = require('crypto');
const express = require('express');
const dns = require('dns').promises;
const net = require('net');

module.exports = function registerNotes(app, deps) {
  const { pool, pgOne, auth, asyncRoute, PUBLIC_APP_URL, callAnthropicJSONMulti, sendPushToUser } = deps;
  const str = (v, n) => String(v == null ? '' : v).slice(0, n || 2000);
  const MAX_FILE = 25 * 1024 * 1024;

  async function initSchema() {
    await pool.query(`
      CREATE TABLE IF NOT EXISTS note_pages (
        id SERIAL PRIMARY KEY, parent_id INTEGER REFERENCES note_pages(id) ON DELETE CASCADE,
        scope TEXT NOT NULL DEFAULT 'shared', owner_id INTEGER,
        title TEXT NOT NULL DEFAULT '', icon TEXT, cover_url TEXT, cover_pos INTEGER NOT NULL DEFAULT 50,
        blocks JSONB NOT NULL DEFAULT '[]'::jsonb, full_width BOOLEAN NOT NULL DEFAULT false,
        position DOUBLE PRECISION NOT NULL DEFAULT 0, search_text TEXT,
        created_by INTEGER, updated_by INTEGER,
        created_at TIMESTAMPTZ NOT NULL DEFAULT now(), updated_at TIMESTAMPTZ NOT NULL DEFAULT now(), deleted_at TIMESTAMPTZ
      );
      CREATE INDEX IF NOT EXISTS idx_note_pages_parent ON note_pages(parent_id);
      CREATE INDEX IF NOT EXISTS idx_note_pages_scope ON note_pages(scope, owner_id);
      CREATE TABLE IF NOT EXISTS note_favorites (user_id INTEGER NOT NULL, page_id INTEGER NOT NULL REFERENCES note_pages(id) ON DELETE CASCADE, created_at TIMESTAMPTZ NOT NULL DEFAULT now(), PRIMARY KEY (user_id, page_id));
      CREATE TABLE IF NOT EXISTS note_comments (
        id SERIAL PRIMARY KEY, page_id INTEGER NOT NULL REFERENCES note_pages(id) ON DELETE CASCADE, user_id INTEGER,
        body TEXT NOT NULL, resolved BOOLEAN NOT NULL DEFAULT false, created_at TIMESTAMPTZ NOT NULL DEFAULT now()
      );
      CREATE INDEX IF NOT EXISTS idx_note_comments_page ON note_comments(page_id);
      CREATE TABLE IF NOT EXISTS note_reminders (
        id SERIAL PRIMARY KEY, page_id INTEGER NOT NULL REFERENCES note_pages(id) ON DELETE CASCADE, block_id TEXT NOT NULL,
        user_id INTEGER, remind_at TIMESTAMPTZ NOT NULL, text TEXT, sent_at TIMESTAMPTZ, created_by INTEGER,
        UNIQUE (page_id, block_id)
      );
      CREATE TABLE IF NOT EXISTS note_versions (
        id SERIAL PRIMARY KEY, page_id INTEGER NOT NULL REFERENCES note_pages(id) ON DELETE CASCADE,
        title TEXT, blocks JSONB NOT NULL, chars INTEGER NOT NULL DEFAULT 0, nblocks INTEGER NOT NULL DEFAULT 0,
        reason TEXT, user_id INTEGER, created_at TIMESTAMPTZ NOT NULL DEFAULT now()
      );
      CREATE INDEX IF NOT EXISTS idx_note_versions_page ON note_versions(page_id, created_at DESC);
      ALTER TABLE note_pages ADD COLUMN IF NOT EXISTS text_size TEXT;
      CREATE TABLE IF NOT EXISTS note_files (
        id SERIAL PRIMARY KEY, key TEXT UNIQUE NOT NULL, name TEXT, mime TEXT, size INTEGER, data BYTEA,
        uploaded_by INTEGER, created_at TIMESTAMPTZ NOT NULL DEFAULT now()
      );
    `);
    await migrateOldSharedNotes().catch(e => console.error('Overførsel af gamle fælles noter fejlede:', e.message));
    // Første gang: en velkomstside i Fælles, så siden ikke er tom
    const any = await pgOne('SELECT id FROM note_pages LIMIT 1');
    if (!any) {
      await pool.query(`INSERT INTO note_pages (scope, title, icon, cover_url, blocks, search_text) VALUES ('shared', $1, '👋', $2, $3, $4)`, [
        'Velkommen til Noter', 'gradient:sunset', JSON.stringify(WELCOME), searchText('Velkommen til Noter', WELCOME)
      ]);
    }
  }
  // De gamle "fælles noter" (shared_notes, én HTML-tekst pr. note) flyttes
  // én gang over som Fælles-sider, så intet går tabt. Gamle rækker bliver liggende.
  async function migrateOldSharedNotes() {
    const done = await pgOne("SELECT 1 AS x FROM app_migrations WHERE name='notes_from_shared_notes_v1'").catch(() => null);
    if (done) return;
    const old = (await pool.query("SELECT * FROM shared_notes ORDER BY sort_order, id").catch(() => ({ rows: [] }))).rows;
    let n = 0;
    for (const r of old) {
      const html = String(r.content || '');
      if (!html.replace(/<[^>]+>/g, '').replace(/&nbsp;/g, ' ').trim()) continue;
      const blocks = htmlToBlocks(html);
      const title = String(r.title || 'Fælles note').slice(0, 300);
      await pool.query(`INSERT INTO note_pages (scope, title, icon, blocks, position, search_text, created_by, updated_by) VALUES ('shared',$1,'📝',$2,$3,$4,$5,$5)`,
        [title, JSON.stringify(blocks), 100 + n, searchText(title, blocks), r.updated_by || r.created_by || null]);
      n++;
    }
    await pool.query("INSERT INTO app_migrations (name, details) VALUES ('notes_from_shared_notes_v1', $1) ON CONFLICT DO NOTHING", [JSON.stringify({ pages: n })]).catch(() => {});
    if (n) console.log('Noter: ' + n + ' gamle fælles noter overført til det nye noteprogram');
  }
  // Groft: hver linje/afsnit i den gamle HTML bliver sin egen blok.
  function htmlToBlocks(html) {
    const out = [];
    const norm = String(html).replace(/\r/g, '')
      .replace(/<li[^>]*>/gi, '\n§LI§').replace(/<\/li>/gi, '\n')
      .replace(/<h[1-3][^>]*>/gi, '\n§H§').replace(/<\/h[1-3]>/gi, '\n')
      .replace(/<br\s*\/?>/gi, '\n').replace(/<\/(div|p)>/gi, '\n').replace(/<(div|p)[^>]*>/gi, '\n')
      .replace(/<\/?(ul|ol)[^>]*>/gi, '\n');
    norm.split('\n').forEach(line => {
      let type = 'p';
      if (line.startsWith('§LI§')) { type = 'bullet'; line = line.slice(4); }
      else if (line.startsWith('§H§')) { type = 'h2'; line = line.slice(3); }
      const h = clean(line).trim();
      if (!h.replace(/<[^>]+>/g, '').replace(/&nbsp;/g, ' ').trim()) return;
      out.push(b(type, h));
    });
    return out.slice(0, 2900);
  }
  const b = (type, html, extra) => Object.assign({ id: crypto.randomBytes(6).toString('hex'), type, html: html || '' }, extra || {});
  const WELCOME = [
    b('p', 'Her samler I viden, procedurer, mødenoter og idéer – fælles for hele teamet eller kun for dig selv.'),
    b('callout', 'Skriv <b>/</b> for at indsætte overskrifter, lister, to-dos, billeder, tabeller, kolonner, videoer og meget mere. Skriv <b>@</b> for at nævne en kollega, en side eller en dato.', { icon: '💡', bg: 'yellow' }),
    b('h2', 'Kom godt i gang'),
    b('todo', 'Giv siden et coverbillede – hold musen over toppen og tryk <b>Tilføj cover</b>', { checked: false }),
    b('todo', 'Opret en privat side under <b>Mine sider</b>', { checked: false }),
    b('todo', 'Markér text og tryk <b>✨ AI</b> for at forbedre, forkorte eller oversætte', { checked: false }),
    b('toggle', 'Genveje på tastaturet', { open: false }),
    b('bullet', '<b>Cmd/Ctrl + B / I / U</b> – fed, kursiv, understreget', { indent: 1 }),
    b('bullet', '<b>Cmd/Ctrl + Alt + 1-3</b> – overskrifter, <b>4</b> to-do, <b>5</b> punktliste, <b>6</b> nummerliste, <b>7</b> toggle, <b>8</b> kode', { indent: 1 }),
    b('bullet', '<b># </b>, <b>- </b>, <b>1. </b>, <b>[] </b>, <b>&gt; </b> og <b>---</b> laver blokke mens du skriver', { indent: 1 })
  ];

  // ── adgang ─────────────────────────────────────────────────
  // Inviterede "kun Noter"-brugere (role='notes', nov. 2026) ser KUN deres egne
  // sider – aldrig firmaets Fælles-sider eller medarbejdernes navne.
  // Gulv Master: admin kan også se medarbejdernes private sider.
  const visibleSql = `(p.owner_id=$1 OR (p.scope='shared' AND NOT EXISTS (SELECT 1 FROM users nu WHERE nu.id=$1 AND nu.role='notes')) OR EXISTS (SELECT 1 FROM users au WHERE au.id=$1 AND au.role='admin'))`;
  async function isNotesOnly(userId) { const r = await pgOne('SELECT role FROM users WHERE id=$1', [userId]); return !!r && r.role === 'notes'; }
  async function getPage(id, userId) {
    const p = await pgOne(`SELECT p.*, u.name AS updated_by_name, c.name AS created_by_name, o.name AS owner_name FROM note_pages p
      LEFT JOIN users u ON u.id=p.updated_by LEFT JOIN users c ON c.id=p.created_by LEFT JOIN users o ON o.id=p.owner_id WHERE p.id=$2 AND ${visibleSql}`, [userId, id]);
    return p;
  }
  const stripHtml = h => String(h || '').replace(/<[^>]+>/g, ' ').replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/\s+/g, ' ').trim();
  function walk(blocks, fn) {
    (Array.isArray(blocks) ? blocks : []).forEach(x => {
      if (!x || typeof x !== 'object') return;
      fn(x);
      if (Array.isArray(x.cols)) x.cols.forEach(c => walk(c, fn));
    });
  }
  function searchText(title, blocks) {
    const parts = [];
    walk(blocks, x => {
      if (x.html) parts.push(stripHtml(x.html));
      if (Array.isArray(x.rows)) x.rows.forEach(r => (r || []).forEach(c => parts.push(stripHtml(c))));
      if (x.name) parts.push(x.name);
      if (x.caption) parts.push(stripHtml(x.caption));
      if (x.title) parts.push(x.title);
      if (Array.isArray(x.titles)) parts.push(x.titles.join(' · '));
    });
    return parts.filter(Boolean).join(' · ').slice(0, 60000);
  }
  // Sanitering: kun ufarlig inline-HTML i tekstblokke
  function clean(html) {
    let s = String(html || '');
    s = s.replace(/<(script|style|iframe|object|embed|form|input|textarea|select|button)[^>]*>[\s\S]*?<\/\1>/gi, '').replace(/<(script|style|iframe|object|embed|form|input|textarea|select|button)[^>]*\/?>/gi, '');
    s = s.replace(/\son\w+\s*=\s*("[^"]*"|'[^']*'|[^\s>]+)/gi, '');
    s = s.replace(/\s(href|src)\s*=\s*("([^"]*)"|'([^']*)')/gi, (m, a, q, v1, v2) => { const v = (v1 || v2 || '').trim(); return /^(https?:|mailto:|tel:|#|\/)/i.test(v) ? ` ${a}="${v.replace(/"/g, '&quot;')}"` : ''; });
    s = s.replace(/<(?!\/?(b|strong|i|em|u|s|strike|del|code|a|br|span|mark|sub|sup|font)\b)[^>]*>/gi, '');
    return s.slice(0, 100000);
  }
  const URLOK = v => /^(https?:\/\/|\/filer\/)/i.test(String(v || ''));
  const TYPES = new Set(['p', 'h1', 'h2', 'h3', 'bullet', 'num', 'todo', 'toggle', 'th1', 'th2', 'th3', 'quote', 'callout', 'divider', 'table', 'image', 'file', 'video', 'audio', 'pdf', 'code', 'bookmark', 'embed', 'columns', 'toc', 'page', 'remind', 'tabs']);
  const COLORS = new Set(['', 'gray', 'brown', 'orange', 'yellow', 'green', 'blue', 'purple', 'pink', 'red']);
  function cleanBlocks(list, depth) {
    if (!Array.isArray(list) || depth > 3) return [];
    return list.slice(0, 3000).map(x => {
      if (!x || typeof x !== 'object' || !TYPES.has(x.type)) return null;
      const o = { id: str(x.id, 40) || crypto.randomBytes(6).toString('hex'), type: x.type };
      if (x.html != null) o.html = clean(x.html);
      if (x.indent) o.indent = Math.max(0, Math.min(10, Number(x.indent) || 0));
      if (x.checked != null) o.checked = !!x.checked;
      if (x.open != null) o.open = !!x.open;
      // toggle+to-do er fjernet (okt. 2026) – feltet 'todo' gemmes ikke længere (klienten omdanner ved åbning)
      if (['s', 'l', 'xl'].includes(x.fs)) o.fs = x.fs; else if (Number(x.fs) >= 8 && Number(x.fs) <= 96) o.fs = Math.round(Number(x.fs));
      if (COLORS.has(x.color)) o.color = x.color;
      if (COLORS.has(x.bg)) o.bg = x.bg;
      if (x.al === 'center' || x.al === 'right') o.al = x.al;
      if (x.icon) o.icon = str(x.icon, 16);
      if (x.lang) o.lang = str(x.lang, 30);
      if (x.code != null) o.code = str(x.code, 100000);
      if (URLOK(x.url)) o.url = str(x.url, 2000);
      if (x.name) o.name = str(x.name, 300);
      if (x.size) o.size = Number(x.size) || 0;
      if (x.mime) o.mime = str(x.mime, 120);
      if (x.sub) o.sub = str(x.sub, 20);
      if (x.caption != null) o.caption = clean(x.caption);
      if (x.width) o.width = ['s', 'm', 'l', 'full'].includes(x.width) ? x.width : 'l';
      if (x.title) o.title = str(x.title, 300);
      if (x.desc) o.desc = str(x.desc, 600);
      if (URLOK(x.image)) o.image = str(x.image, 2000);
      if (x.site) o.site = str(x.site, 200);
      if (x.pageId) o.pageId = Number(x.pageId) || null;
      if (x.header != null) o.header = !!x.header;
      if (Array.isArray(x.rows)) o.rows = x.rows.slice(0, 200).map(r => (Array.isArray(r) ? r : []).slice(0, 20).map(c => clean(c)));
      if (Array.isArray(x.cols)) o.cols = x.cols.slice(0, x.type === 'tabs' ? 20 : 4).map(c => cleanBlocks(c, depth + 1));
      if (Array.isArray(x.titles)) o.titles = x.titles.slice(0, 20).map(t => str(t, 80));
      if (Array.isArray(x.widths)) o.widths = x.widths.slice(0, 4).map(n => Math.max(0.05, Math.min(0.95, Number(n) || 0.25)));
      if (x.active != null) o.active = Math.max(0, Math.min(19, Number(x.active) || 0));
      if (x.at) o.at = str(x.at, 40);
      if (x.userId) o.userId = Number(x.userId) || null;
      return o;
    }).filter(Boolean);
  }
  async function syncReminders(pageId, blocks, userId) {
    const rem = [];
    walk(blocks, x => { if (x.type === 'remind' && x.at && !isNaN(new Date(x.at))) rem.push(x); });
    const ids = rem.map(x => x.id);
    await pool.query('DELETE FROM note_reminders WHERE page_id=$1 AND sent_at IS NULL AND NOT (block_id = ANY($2))', [pageId, ids]);
    for (const x of rem) {
      await pool.query(`INSERT INTO note_reminders (page_id, block_id, user_id, remind_at, text, created_by) VALUES ($1,$2,$3,$4,$5,$6)
        ON CONFLICT (page_id, block_id) DO UPDATE SET user_id=EXCLUDED.user_id, remind_at=EXCLUDED.remind_at, text=EXCLUDED.text,
        sent_at=CASE WHEN note_reminders.remind_at<>EXCLUDED.remind_at THEN NULL ELSE note_reminders.sent_at END`,
        [pageId, x.id, x.userId || userId, new Date(x.at).toISOString(), stripHtml(x.html).slice(0, 300), userId]);
    }
  }
  function mentionedUsers(blocks) {
    const set = new Set();
    walk(blocks, x => {
      const h = String(x.html || '') + (Array.isArray(x.rows) ? x.rows.flat().join(' ') : '');
      (h.match(/data-user="(\d+)"/g) || []).forEach(m => set.add(Number(m.match(/\d+/)[0])));
    });
    return set;
  }
  function notify(userId, title, body, link) {
    pool.query('INSERT INTO notifications (event_key,title,body,link,user_id) VALUES ($1,$2,$3,$4,$5)', ['note', title, body, link || '', userId])
      .catch(() => pool.query('INSERT INTO notifications (event_key,title,body,link) VALUES ($1,$2,$3,$4)', ['note', title, body, link || '']).catch(() => {}));
    if (sendPushToUser) sendPushToUser(userId, title, body, '/admin' + (link || '')).catch(() => {});
  }

  // ── træ, seneste, søgning ───────────────────────────────────
  app.get('/api/notes/tree', auth, asyncRoute(async (req, res) => {
    const rows = (await pool.query(`SELECT p.id, p.parent_id, p.scope, p.owner_id, p.title, p.icon, p.position, p.updated_at, o.name AS owner_name
      FROM note_pages p LEFT JOIN users o ON o.id=p.owner_id WHERE p.deleted_at IS NULL AND ${visibleSql} ORDER BY p.position, p.id`, [req.user.id])).rows;
    const fav = (await pool.query('SELECT page_id FROM note_favorites WHERE user_id=$1 ORDER BY created_at', [req.user.id])).rows.map(r => r.page_id);
    res.json({ pages: rows, favorites: fav, me: req.user.id, is_admin: req.user.role === 'admin' });
  }));
  app.get('/api/notes/recent', auth, asyncRoute(async (req, res) => {
    const rows = (await pool.query(`SELECT p.id, p.scope, p.title, p.icon, p.cover_url, p.cover_pos, p.updated_at, u.name AS updated_by_name,
      p.blocks FROM note_pages p LEFT JOIN users u ON u.id=p.updated_by
      WHERE p.deleted_at IS NULL AND (p.owner_id=$1 OR p.scope='shared') AND ${visibleSql} ORDER BY p.updated_at DESC LIMIT 12`, [req.user.id])).rows;
    res.json(rows.map(r => { const parts = []; walk(r.blocks, x => { if (x.html && parts.join(' ').length < 200) parts.push(stripHtml(x.html)); }); delete r.blocks; r.excerpt = parts.join(' · ').slice(0, 200); return r; }));
  }));
  app.get('/api/notes/search', auth, asyncRoute(async (req, res) => {
    const q = str(req.query.q, 200).trim().toLowerCase();
    if (!q) return res.json([]);
    const rows = (await pool.query(`SELECT p.id, p.scope, p.title, p.icon, p.updated_at,
      substring(COALESCE(p.search_text,'') from greatest(1, position($2 in lower(COALESCE(p.search_text,''))) - 60) for 180) AS snippet
      FROM note_pages p WHERE p.deleted_at IS NULL AND ${visibleSql} AND (lower(p.title) LIKE $3 OR lower(COALESCE(p.search_text,'')) LIKE $3)
      ORDER BY (lower(p.title) LIKE $3) DESC, p.updated_at DESC LIMIT 30`, [req.user.id, q, '%' + q + '%'])).rows;
    res.json(rows);
  }));
  app.get('/api/notes/people', auth, asyncRoute(async (req, res) => {
    if (await isNotesOnly(req.user.id)) return res.json((await pool.query('SELECT id, name, initials, color FROM users WHERE id=$1', [req.user.id])).rows);
    res.json((await pool.query("SELECT id, name, initials, color FROM users WHERE active=1 AND COALESCE(can_login,1)=1 AND COALESCE(role,'')<>'notes' ORDER BY name")).rows);
  }));

  // ── én side ──────────────────────────────────────────────────
  app.get('/api/notes/trash', auth, asyncRoute(async (req, res) => {
    res.json((await pool.query(`SELECT p.id, p.title, p.icon, p.scope, p.deleted_at FROM note_pages p WHERE p.deleted_at IS NOT NULL AND ${visibleSql}
      AND (p.parent_id IS NULL OR NOT EXISTS (SELECT 1 FROM note_pages q WHERE q.id=p.parent_id AND q.deleted_at IS NOT NULL)) ORDER BY p.deleted_at DESC LIMIT 100`, [req.user.id])).rows);
  }));
  app.get('/api/notes/:id(\\d+)', auth, asyncRoute(async (req, res) => {
    const p = await getPage(Number(req.params.id), req.user.id);
    if (!p) return res.status(404).json({ error: 'Siden findes ikke, eller du har ikke adgang' });
    const crumbs = (await pool.query(`WITH RECURSIVE c AS (SELECT id, parent_id, title, icon, 0 AS d FROM note_pages WHERE id=$1
      UNION ALL SELECT n.id, n.parent_id, n.title, n.icon, c.d+1 FROM note_pages n JOIN c ON n.id=c.parent_id WHERE c.d<20)
      SELECT id, title, icon FROM c ORDER BY d DESC`, [p.id])).rows;
    const children = (await pool.query('SELECT id, title, icon FROM note_pages WHERE parent_id=$1 AND deleted_at IS NULL ORDER BY position, id', [p.id])).rows;
    const fav = !!(await pgOne('SELECT 1 FROM note_favorites WHERE user_id=$1 AND page_id=$2', [req.user.id, p.id]));
    const cc = await pgOne('SELECT COUNT(*)::int AS n FROM note_comments WHERE page_id=$1 AND NOT resolved', [p.id]);
    delete p.search_text;
    res.json(Object.assign(p, { crumbs, children, favorite: fav, comment_count: cc.n }));
  }));
  // Titler/ikoner til link- og side-blokke
  app.post('/api/notes/lookup', auth, asyncRoute(async (req, res) => {
    const ids = (Array.isArray((req.body || {}).ids) ? req.body.ids : []).map(Number).filter(Boolean).slice(0, 200);
    if (!ids.length) return res.json({});
    const rows = (await pool.query(`SELECT p.id, p.title, p.icon, p.deleted_at FROM note_pages p WHERE p.id = ANY($2) AND ${visibleSql}`, [req.user.id, ids])).rows;
    const out = {}; rows.forEach(r => { out[r.id] = { title: r.title, icon: r.icon, deleted: !!r.deleted_at }; });
    res.json(out);
  }));
  app.post('/api/notes', auth, asyncRoute(async (req, res) => {
    const bd = req.body || {};
    let scope = bd.scope === 'private' ? 'private' : 'shared', parentId = Number(bd.parent_id) || null;
    if (await isNotesOnly(req.user.id)) scope = 'private';
    let ownerId = req.user.id;
    if (parentId) { const par = await getPage(parentId, req.user.id); if (!par) return res.status(404).json({ error: 'Forældresiden findes ikke' }); scope = par.scope; if (par.scope === 'private' && par.owner_id) ownerId = par.owner_id; }
    const pos = await pgOne('SELECT COALESCE(MAX(position),0)+1 AS p FROM note_pages WHERE parent_id IS NOT DISTINCT FROM $1', [parentId]);
    const blocks = cleanBlocks(bd.blocks || [], 0);
    const title = str(bd.title, 300);
    const p = await pgOne(`INSERT INTO note_pages (parent_id, scope, owner_id, title, icon, cover_url, blocks, position, search_text, created_by, updated_by)
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$10) RETURNING id`, [parentId, scope, ownerId, title, bd.icon ? str(bd.icon, 16) : null, bd.cover_url && (URLOK(bd.cover_url) || /^gradient:/.test(bd.cover_url)) ? str(bd.cover_url, 2000) : null, JSON.stringify(blocks), pos.p, searchText(title, blocks), req.user.id]);
    // Som i Notion: en ny underside får et link-kort nederst på forældresiden
    if (parentId && bd.link_in_parent !== false) {
      await pool.query(`UPDATE note_pages SET blocks = blocks || $1::jsonb WHERE id=$2`, [JSON.stringify([{ id: crypto.randomBytes(6).toString('hex'), type: 'page', pageId: p.id }]), parentId]);
    }
    res.json({ ok: true, id: p.id, scope });
  }));
  // 3-vejs fletning af blokke (base = sidst fælles udgave, mine = mine ændringer, theirs = den gemte udgave)
  function nbMerge(B, M, T) {
    var J = function (x) { return JSON.stringify(x === undefined ? null : x); };
    var map = function (l) { var o = {}; (l || []).forEach(function (b) { if (b && b.id) o[b.id] = b; }); return o; };
    function block(b, m, t) {
      if (!b) return m;
      if (J(m) === J(b)) return t;
      if (J(t) === J(b) || J(t) === J(m)) return m;
      var o = {}, keys = {};
      [b, m, t].forEach(function (x) { Object.keys(x).forEach(function (k) { keys[k] = 1; }); });
      Object.keys(keys).forEach(function (k) {
        var v;
        if (k === 'cols' && Array.isArray(m.cols) && Array.isArray(t.cols) && Array.isArray(b.cols) && m.cols.length === t.cols.length && b.cols.length === m.cols.length) {
          v = m.cols.map(function (c, i) { return list(b.cols[i], c, t.cols[i]); });
        } else v = J(m[k]) === J(b[k]) ? t[k] : m[k];
        if (v !== undefined) o[k] = v;
      });
      return o;
    }
    function list(B, M, T) {
      B = B || []; M = M || []; T = T || [];
      var bm = map(B), mm = map(M), tm = map(T), out = {};
      var keep = function (id) {
        var b = bm[id], m = mm[id], t = tm[id];
        if (m && t) return block(b, m, t);
        if (m) return !b ? m : (J(m) !== J(b) ? m : null); // de har slettet – behold kun hvis jeg har ændret den
        if (t) return !b ? t : (J(t) !== J(b) ? t : null); // jeg har slettet – behold kun hvis de har ændret den
        return null;
      };
      var ord = function (l) { return l.filter(function (x) { return x && bm[x.id] && mm[x.id] && tm[x.id]; }).map(function (x) { return x.id; }).join(','); };
      var theyMoved = ord(T) !== ord(B);
      var P = theyMoved ? T : M, S = theyMoved ? M : T, res = [];
      P.forEach(function (x) { if (!x || out[x.id]) return; var v = keep(x.id); if (v) { out[x.id] = 1; res.push(v); } });
      S.forEach(function (x, i) {
        if (!x || out[x.id]) return; var v = keep(x.id); if (!v) return;
        var at = 0; for (var j = i - 1; j >= 0; j--) { var k = res.findIndex(function (r) { return r.id === S[j].id; }); if (k > -1) { at = k + 1; break; } }
        out[x.id] = 1; res.splice(at, 0, v);
      });
      return res;
    }
    return list(B, M, T);
  }

  // ── versionshistorik ─────────────────────────────────────
  const countOf = (blocks) => { let n = 0; walk(blocks, () => n++); return n; };
  async function saveVersion(page, reason, userId) {
    const blocks = page.blocks || [];
    const chars = searchText('', blocks).length;
    if (!countOf(blocks) && !page.title) return;
    await pool.query('INSERT INTO note_versions (page_id, title, blocks, chars, nblocks, reason, user_id) VALUES ($1,$2,$3,$4,$5,$6,$7)',
      [page.id, page.title || '', JSON.stringify(blocks), chars, countOf(blocks), reason || 'auto', userId || page.updated_by || null]);
    await pool.query(`DELETE FROM note_versions WHERE page_id=$1 AND id NOT IN (SELECT id FROM note_versions WHERE page_id=$1 ORDER BY created_at DESC LIMIT 200)`, [page.id]);
  }
  // Gem den forrige udgave hvis der er gået 10 min siden sidste version, eller hvis meget indhold forsvinder på én gang
  async function maybeVersion(cur, newBlocks, userId) {
    const last = await pgOne('SELECT created_at, blocks FROM note_versions WHERE page_id=$1 ORDER BY created_at DESC LIMIT 1', [cur.id]);
    const oldChars = searchText('', cur.blocks).length, newChars = searchText('', newBlocks).length;
    const oldN = countOf(cur.blocks), newN = countOf(newBlocks);
    const bigLoss = oldChars - newChars > 150 || oldN - newN >= 3;
    const stale = !last || (Date.now() - new Date(last.created_at).getTime()) > 10 * 60 * 1000;
    if (bigLoss || stale) {
      if (last && JSON.stringify(last.blocks) === JSON.stringify(cur.blocks)) return;
      await saveVersion(cur, bigLoss ? 'delete' : 'auto', cur.updated_by || userId);
    }
  }
  app.get('/api/notes/:id(\\d+)/versions', auth, asyncRoute(async (req, res) => {
    const cur = await getPage(Number(req.params.id), req.user.id);
    if (!cur) return res.status(404).json({ error: 'Siden findes ikke' });
    const r = await pool.query(`SELECT v.id, v.title, v.chars, v.nblocks, v.reason, v.created_at, u.name AS user_name FROM note_versions v LEFT JOIN users u ON u.id=v.user_id WHERE v.page_id=$1 ORDER BY v.created_at DESC LIMIT 200`, [cur.id]);
    res.json({ versions: r.rows, current: { chars: searchText('', cur.blocks).length, nblocks: countOf(cur.blocks), updated_at: cur.updated_at, user_name: cur.updated_by_name } });
  }));
  app.get('/api/notes/:id(\\d+)/versions/:vid', auth, asyncRoute(async (req, res) => {
    const cur = await getPage(Number(req.params.id), req.user.id);
    if (!cur) return res.status(404).json({ error: 'Siden findes ikke' });
    const v = await pgOne('SELECT v.*, u.name AS user_name FROM note_versions v LEFT JOIN users u ON u.id=v.user_id WHERE v.id=$1 AND v.page_id=$2', [Number(req.params.vid), cur.id]);
    if (!v) return res.status(404).json({ error: 'Versionen findes ikke' });
    res.json(v);
  }));
  app.post('/api/notes/:id(\\d+)/versions/:vid/restore', auth, asyncRoute(async (req, res) => {
    const cur = await getPage(Number(req.params.id), req.user.id);
    if (!cur) return res.status(404).json({ error: 'Siden findes ikke' });
    const v = await pgOne('SELECT * FROM note_versions WHERE id=$1 AND page_id=$2', [Number(req.params.vid), cur.id]);
    if (!v) return res.status(404).json({ error: 'Versionen findes ikke' });
    await saveVersion(cur, 'before-restore', req.user.id);
    const blocks = cleanBlocks(v.blocks, 0);
    const r = await pgOne(`UPDATE note_pages SET blocks=$1, title=$2, search_text=$3, updated_by=$4, updated_at=now() WHERE id=$5 RETURNING updated_at`,
      [JSON.stringify(blocks), v.title || cur.title, searchText(v.title || cur.title, blocks), req.user.id, cur.id]);
    res.json({ ok: true, updated_at: r.updated_at });
  }));
  app.put('/api/notes/:id(\\d+)', auth, asyncRoute(async (req, res) => {
    const id = Number(req.params.id); const bd = req.body || {};
    const cur = await getPage(id, req.user.id);
    if (!cur) return res.status(404).json({ error: 'Siden findes ikke' });
    const merging = bd.blocks !== undefined && Array.isArray(bd.base_blocks);
    if (!merging && bd.base_updated_at && cur.updated_by && cur.updated_by !== req.user.id && new Date(cur.updated_at) > new Date(bd.base_updated_at) && !bd.force) {
      return res.status(409).json({ conflict: true, updated_by_name: cur.updated_by_name, updated_at: cur.updated_at });
    }
    const sets = [], vals = [];
    const set = (col, v) => { vals.push(v); sets.push(col + '=$' + vals.length); };
    if (bd.title !== undefined) set('title', str(bd.title, 300));
    if (bd.icon !== undefined) set('icon', bd.icon ? str(bd.icon, 16) : null);
    if (bd.cover_url !== undefined) set('cover_url', bd.cover_url && (URLOK(bd.cover_url) || /^gradient:[a-z0-9-]+$/.test(bd.cover_url)) ? str(bd.cover_url, 2000) : null);
    if (bd.cover_pos !== undefined) set('cover_pos', Math.max(0, Math.min(100, Number(bd.cover_pos) || 0)));
    if (bd.full_width !== undefined) set('full_width', !!bd.full_width);
    if (bd.text_size !== undefined) set('text_size', ['s', 'l', 'xl'].includes(bd.text_size) ? bd.text_size : (Number(bd.text_size) >= 8 && Number(bd.text_size) <= 40 ? String(Math.round(Number(bd.text_size))) : null));
    let blocks = null, mineClean = null, r, db = null;
    // Fælles redigering: flet mine ændringer (i forhold til den udgave jeg tog udgangspunkt i) ind i den gemte udgave,
    // så to der skriver samtidig ikke overskriver hinanden. Rækken låses imens, så to gem ikke kan krydse.
    if (merging) { db = await pool.connect(); await db.query('BEGIN'); }
    try {
      if (bd.blocks !== undefined) {
        mineClean = cleanBlocks(bd.blocks, 0); blocks = mineClean;
        if (merging) {
          const live = (await db.query('SELECT blocks FROM note_pages WHERE id=$1 FOR NO KEY UPDATE', [id])).rows[0];
          const theirs = (live && live.blocks) || [];
          blocks = cleanBlocks(nbMerge(cleanBlocks(bd.base_blocks, 0), mineClean, theirs), 0);
          cur.blocks = theirs;
        }
        set('blocks', JSON.stringify(blocks)); await maybeVersion(cur, blocks, req.user.id).catch(e => console.error('Note-version:', e.message));
      }
      if (!sets.length) { if (db) await db.query('ROLLBACK'); return res.json({ ok: true, updated_at: cur.updated_at }); }
      const title = bd.title !== undefined ? str(bd.title, 300) : cur.title;
      set('search_text', searchText(title, blocks || cur.blocks));
      set('updated_by', req.user.id);
      sets.push('updated_at=now()');
      vals.push(id);
      const q = `UPDATE note_pages SET ${sets.join(', ')} WHERE id=$${vals.length} RETURNING updated_at`;
      r = db ? (await db.query(q, vals)).rows[0] : await pgOne(q, vals);
      if (db) await db.query('COMMIT');
    } catch (e) { if (db) await db.query('ROLLBACK').catch(() => {}); throw e; }
    finally { if (db) db.release(); }
    var title = bd.title !== undefined ? str(bd.title, 300) : cur.title;
    if (blocks) {
      await syncReminders(id, blocks, req.user.id).catch(e => console.error('Note-påmindelser:', e.message));
      const before = mentionedUsers(cur.blocks), after = mentionedUsers(blocks);
      after.forEach(uid => { if (!before.has(uid) && uid !== req.user.id) notify(uid, `${req.user.name || 'En kollega'} nævnte dig i "${title || 'Uden titel'}"`, 'Åbn noten for at se det.', '#kb-notes/' + id); });
    }
    const out = { ok: true, updated_at: r.updated_at };
    if (merging && JSON.stringify(blocks) !== JSON.stringify(mineClean)) out.blocks = blocks;
    res.json(out);
  }));
  app.post('/api/notes/:id(\\d+)/move', auth, asyncRoute(async (req, res) => {
    const id = Number(req.params.id); const bd = req.body || {};
    const cur = await getPage(id, req.user.id);
    if (!cur) return res.status(404).json({ error: 'Siden findes ikke' });
    let parentId = bd.parent_id === null || bd.parent_id === undefined ? null : Number(bd.parent_id) || null;
    let scope = bd.scope === 'private' ? 'private' : bd.scope === 'shared' ? 'shared' : cur.scope;
    if (await isNotesOnly(req.user.id)) scope = 'private';
    if (parentId) {
      const par = await getPage(parentId, req.user.id); if (!par) return res.status(404).json({ error: 'Målsiden findes ikke' });
      const cyc = await pgOne(`WITH RECURSIVE a AS (SELECT id, parent_id FROM note_pages WHERE id=$1 UNION ALL SELECT n.id, n.parent_id FROM note_pages n JOIN a ON n.id=a.parent_id) SELECT 1 FROM a WHERE id=$2`, [parentId, id]);
      if (cyc) return res.status(400).json({ error: 'En side kan ikke flyttes ind under sig selv' });
      scope = par.scope;
    }
    const pos = bd.position != null ? Number(bd.position) : (await pgOne('SELECT COALESCE(MAX(position),0)+1 AS p FROM note_pages WHERE parent_id IS NOT DISTINCT FROM $1', [parentId])).p;
    // Ejeren af en privat side bevares (admin der flytter en medarbejders side
    // overtager den ikke): under en forælder arves forælderens ejer, ellers
    // beholdes sidens egen ejer (eller den der flytter den, hvis den var fælles).
    let newOwner = req.user.id;
    if (parentId) { const par = await pgOne('SELECT owner_id, scope FROM note_pages WHERE id=$1', [parentId]); if (par && par.scope === 'private' && par.owner_id) newOwner = par.owner_id; }
    else if (cur.scope === 'private' && cur.owner_id) newOwner = cur.owner_id;
    await pool.query('UPDATE note_pages SET parent_id=$1, position=$2, scope=$3, owner_id=CASE WHEN $3=\'private\' THEN $5 ELSE owner_id END WHERE id=$4', [parentId, pos, scope, id, newOwner]);
    // Undersider følger rummet
    await pool.query(`WITH RECURSIVE d AS (SELECT id FROM note_pages WHERE parent_id=$1 UNION ALL SELECT n.id FROM note_pages n JOIN d ON n.parent_id=d.id)
      UPDATE note_pages SET scope=$2, owner_id=CASE WHEN $2='private' THEN $3 ELSE owner_id END WHERE id IN (SELECT id FROM d)`, [id, scope, newOwner]);
    res.json({ ok: true });
  }));
  app.post('/api/notes/:id(\\d+)/duplicate', auth, asyncRoute(async (req, res) => {
    const cur = await getPage(Number(req.params.id), req.user.id);
    if (!cur) return res.status(404).json({ error: 'Siden findes ikke' });
    const fresh = JSON.parse(JSON.stringify(cur.blocks || []));
    walk(fresh, x => { x.id = crypto.randomBytes(6).toString('hex'); });
    const p = await pgOne(`INSERT INTO note_pages (parent_id, scope, owner_id, title, icon, cover_url, cover_pos, blocks, full_width, position, search_text, created_by, updated_by)
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$12) RETURNING id`, [cur.parent_id, cur.scope, cur.scope === 'private' && cur.owner_id ? cur.owner_id : req.user.id, (cur.title || 'Uden titel') + ' (kopi)', cur.icon, cur.cover_url, cur.cover_pos, JSON.stringify(fresh), cur.full_width, Number(cur.position) + 0.5, cur.search_text, req.user.id]);
    res.json({ ok: true, id: p.id });
  }));
  app.delete('/api/notes/:id(\\d+)', auth, asyncRoute(async (req, res) => {
    const cur = await getPage(Number(req.params.id), req.user.id);
    if (!cur) return res.status(404).json({ error: 'Siden findes ikke' });
    await pool.query(`WITH RECURSIVE d AS (SELECT id FROM note_pages WHERE id=$1 UNION ALL SELECT n.id FROM note_pages n JOIN d ON n.parent_id=d.id)
      UPDATE note_pages SET deleted_at=now() WHERE id IN (SELECT id FROM d) AND deleted_at IS NULL`, [cur.id]);
    res.json({ ok: true });
  }));
  app.post('/api/notes/:id(\\d+)/restore', auth, asyncRoute(async (req, res) => {
    const cur = await getPage(Number(req.params.id), req.user.id);
    if (!cur) return res.status(404).json({ error: 'Siden findes ikke' });
    await pool.query(`WITH RECURSIVE d AS (SELECT id FROM note_pages WHERE id=$1 UNION ALL SELECT n.id FROM note_pages n JOIN d ON n.parent_id=d.id)
      UPDATE note_pages SET deleted_at=NULL WHERE id IN (SELECT id FROM d)`, [cur.id]);
    // Ligger forælderen stadig i papirkurven, lægges siden i roden
    await pool.query('UPDATE note_pages p SET parent_id=NULL FROM note_pages q WHERE p.id=$1 AND q.id=p.parent_id AND q.deleted_at IS NOT NULL', [cur.id]);
    res.json({ ok: true });
  }));
  app.delete('/api/notes/:id(\\d+)/permanent', auth, asyncRoute(async (req, res) => {
    const cur = await getPage(Number(req.params.id), req.user.id);
    if (!cur || !cur.deleted_at) return res.status(400).json({ error: 'Kun sider i papirkurven kan slettes permanent' });
    await pool.query('DELETE FROM note_pages WHERE id=$1', [cur.id]);
    res.json({ ok: true });
  }));
  app.post('/api/notes/:id(\\d+)/favorite', auth, asyncRoute(async (req, res) => {
    const on = !!(req.body || {}).on;
    if (on) await pool.query('INSERT INTO note_favorites (user_id, page_id) VALUES ($1,$2) ON CONFLICT DO NOTHING', [req.user.id, req.params.id]);
    else await pool.query('DELETE FROM note_favorites WHERE user_id=$1 AND page_id=$2', [req.user.id, req.params.id]);
    res.json({ ok: true });
  }));

  // ── kommentarer ─────────────────────────────────────────────
  app.get('/api/notes/:id(\\d+)/comments', auth, asyncRoute(async (req, res) => {
    if (!(await getPage(Number(req.params.id), req.user.id))) return res.status(404).json({ error: 'Findes ikke' });
    res.json((await pool.query(`SELECT c.*, u.name AS user_name, u.initials, u.color FROM note_comments c LEFT JOIN users u ON u.id=c.user_id
      WHERE c.page_id=$1 ORDER BY c.resolved, c.created_at`, [req.params.id])).rows);
  }));
  app.post('/api/notes/:id(\\d+)/comments', auth, asyncRoute(async (req, res) => {
    const p = await getPage(Number(req.params.id), req.user.id);
    if (!p) return res.status(404).json({ error: 'Findes ikke' });
    const body = str((req.body || {}).body, 4000).trim();
    if (!body) return res.status(400).json({ error: 'Skriv en kommentar' });
    const r = await pgOne('INSERT INTO note_comments (page_id, user_id, body) VALUES ($1,$2,$3) RETURNING id', [p.id, req.user.id, body]);
    // Giv besked til den, der ejer/sidst rettede siden
    const to = new Set([p.created_by, p.updated_by].filter(x => x && x !== req.user.id));
    to.forEach(uid => notify(uid, `Ny kommentar på "${p.title || 'Uden titel'}"`, (req.user.name ? req.user.name + ': ' : '') + body.slice(0, 140), '#kb-notes/' + p.id));
    res.json({ ok: true, id: r.id });
  }));
  app.put('/api/notes/comments/:cid', auth, asyncRoute(async (req, res) => {
    await pool.query(`UPDATE note_comments SET resolved=$1 WHERE id=$2 AND page_id IN (SELECT id FROM note_pages p WHERE ${visibleSql.split('$1').join('$3')})`, [!!(req.body || {}).resolved, req.params.cid, req.user.id]);
    res.json({ ok: true });
  }));
  app.delete('/api/notes/comments/:cid', auth, asyncRoute(async (req, res) => {
    await pool.query('DELETE FROM note_comments WHERE id=$1 AND (user_id=$2 OR $3)', [req.params.cid, req.user.id, req.user.role === 'admin']);
    res.json({ ok: true });
  }));

  // ── filer ─────────────────────────────────────────────────
  app.post('/api/notes/upload', auth, express.raw({ type: () => true, limit: MAX_FILE + 1024 }), asyncRoute(async (req, res) => {
    const buf = req.body;
    if (!Buffer.isBuffer(buf) || !buf.length) return res.status(400).json({ error: 'Filen er tom' });
    if (buf.length > MAX_FILE) return res.status(413).json({ error: 'Filen er over 25 MB' });
    let name = 'fil'; try { name = decodeURIComponent(String(req.headers['x-file-name'] || 'fil')); } catch (e) { /* */ }
    name = name.replace(/[\u0000-\u001f\/\\]/g, '-').slice(0, 180) || 'fil';
    const mime = String(req.headers['x-file-type'] || 'application/octet-stream').slice(0, 120).toLowerCase();
    const key = crypto.randomBytes(18).toString('base64url');
    await pool.query('INSERT INTO note_files (key,name,mime,size,data,uploaded_by) VALUES ($1,$2,$3,$4,$5,$6)', [key, name, mime, buf.length, buf, req.user.id]);
    res.json({ ok: true, url: '/filer/' + key + '/' + encodeURIComponent(name), name, size: buf.length, mime });
  }));

  // Filer hentes via en lang, tilfældig nøgle (samme princip som i Arkitekt-portalen).
  const INLINE = /^(image\/(png|jpe?g|gif|webp|heic|heif|avif)|application\/pdf|video\/(mp4|quicktime|webm)|audio\/(mpeg|mp4|wav|x-m4a)|text\/plain)$/i;
  app.get('/filer/:key/:name?', asyncRoute(async (req, res) => {
    const f = await pgOne('SELECT name,mime,size,data FROM note_files WHERE key=$1', [req.params.key]);
    if (!f) return res.status(404).send('Filen findes ikke længere');
    const inline = INLINE.test(f.mime || '');
    res.set('Content-Type', inline ? f.mime : 'application/octet-stream');
    res.set('X-Content-Type-Options', 'nosniff');
    res.set('Cache-Control', 'private, max-age=3600');
    res.set('Content-Disposition', (inline ? 'inline' : 'attachment') + "; filename*=UTF-8''" + encodeURIComponent(f.name || 'fil'));
    res.send(f.data);
  }));

  // ── link-kort (bogmærke) ───────────────────────────────────
  function privateIp(ip) {
    if (net.isIPv6(ip)) return /^(::1|fc|fd|fe80|::ffff:(10\.|127\.|192\.168\.|169\.254\.|172\.(1[6-9]|2\d|3[01])\.))/i.test(ip) || ip === '::';
    return /^(10\.|127\.|0\.|192\.168\.|169\.254\.|172\.(1[6-9]|2\d|3[01])\.|100\.(6[4-9]|[7-9]\d|1[01]\d|12[0-7])\.)/.test(ip);
  }
  app.get('/api/notes/link-preview', auth, asyncRoute(async (req, res) => {
    let u; try { u = new URL(String(req.query.url || '')); } catch (e) { return res.status(400).json({ error: 'Ugyldigt link' }); }
    if (!/^https?:$/.test(u.protocol)) return res.status(400).json({ error: 'Kun http(s)-links' });
    const fallback = { title: u.hostname.replace(/^www\./, ''), desc: '', image: null, site: u.hostname.replace(/^www\./, '') };
    try {
      const addrs = await dns.lookup(u.hostname, { all: true });
      if (!addrs.length || addrs.some(a => privateIp(a.address))) return res.json(fallback);
      const ctl = new AbortController(); const t = setTimeout(() => ctl.abort(), 6000);
      const r = await fetch(u.toString(), { signal: ctl.signal, redirect: 'follow', headers: { 'User-Agent': 'Mozilla/5.0 (compatible; GMNoter/1.0)', Accept: 'text/html' } });
      clearTimeout(t);
      const html = (await r.text()).slice(0, 400000);
      const meta = n => { const m = html.match(new RegExp('<meta[^>]+(?:property|name)=["\']' + n + '["\'][^>]*content=["\']([^"\']*)', 'i')) || html.match(new RegExp('<meta[^>]+content=["\']([^"\']*)["\'][^>]*(?:property|name)=["\']' + n + '["\']', 'i')); return m ? m[1] : ''; };
      const dec = s => String(s || '').replace(/&amp;/g, '&').replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&lt;/g, '<').replace(/&gt;/g, '>').trim();
      const title = dec(meta('og:title') || (html.match(/<title[^>]*>([^<]*)/i) || [])[1]) || fallback.title;
      let image = dec(meta('og:image')); if (image) { try { image = new URL(image, u).toString(); } catch (e) { image = null; } }
      res.json({ title: title.slice(0, 300), desc: dec(meta('og:description') || meta('description')).slice(0, 400), image: image && /^https:/.test(image) ? image : null, site: dec(meta('og:site_name')) || fallback.site });
    } catch (e) { res.json(fallback); }
  }));

  // ── AI-skrivehjælp ─────────────────────────────────────────
  const AI_SYS = `Du er skrivehjælp i et noteprogram hos Gulv Master (dansk gulvfirma: gulvslibning, gulvlægning, maler og enterprise). Skriv på det sprog, brugeren skriver på (som standard dansk), medmindre du bliver bedt om at oversætte. Vær konkret og kortfattet, ingen indledende floskler.
Svar KUN med gyldig JSON i én af to former:
1) Når der skal laves nyt indhold (handling "write", "summarize", "todos", "continue"): {"blocks":[{"type":"h2|h3|p|bullet|num|todo|quote","text":"..."}]} — text må indeholde <b>, <i> og <code>.
2) Når en markeret tekst skal omskrives (handling "improve", "shorter", "longer", "fix", "translate_en", "translate_da", "tone_friendly", "tone_formal"): {"text":"den nye tekst"} — behold eventuel <b>/<i>-formatering.`;
  const ACTIONS = {
    write: 'Skriv indhold ud fra denne instruks:', summarize: 'Opsummér teksten i få punkter:', todos: 'Find alle opgaver/aftaler i teksten og lav dem som to-dos:',
    continue: 'Fortsæt teksten naturligt med 1-3 afsnit:', improve: 'Forbedr sproget, så det er klart og professionelt:', shorter: 'Gør teksten kortere uden at miste indhold:',
    longer: 'Uddyb teksten:', fix: 'Ret stave- og grammatikfejl, ændr intet andet:', translate_en: 'Oversæt til engelsk:', translate_da: 'Oversæt til dansk:',
    tone_friendly: 'Omskriv i en venlig, personlig tone:', tone_formal: 'Omskriv i en formel, professionel tone:'
  };
  app.post('/api/notes/ai', auth, asyncRoute(async (req, res) => {
    const bd = req.body || {};
    const action = ACTIONS[bd.action] ? bd.action : 'write';
    const text = str(bd.text, 30000), prompt = str(bd.prompt, 4000), ctx = str(bd.context, 20000);
    if (!text && !prompt) return res.status(400).json({ error: 'Skriv hvad AI skal lave' });
    const user = `Handling: ${action}\n${ACTIONS[action]}\n${prompt ? '\nInstruks: ' + prompt : ''}${text ? '\n\nTekst:\n' + text : ''}${ctx ? '\n\nSidens øvrige indhold (kontekst):\n' + ctx : ''}`;
    try {
      const out = await callAnthropicJSONMulti(AI_SYS, [{ role: 'user', content: user }]);
      if (out && Array.isArray(out.blocks)) return res.json({ blocks: out.blocks.slice(0, 120).map(x => ({ type: ['h1', 'h2', 'h3', 'p', 'bullet', 'num', 'todo', 'quote'].includes(x.type) ? x.type : 'p', html: clean(String(x.text || '')) })) });
      return res.json({ text: clean(String((out && out.text) || '')) });
    } catch (e) { res.status(e.isConfig ? 501 : 502).json({ error: e.message }); }
  }));

  // ── påmindelser (hvert minut) ──────────────────────────────
  async function remindTick() {
    try {
      const due = (await pool.query(`SELECT r.*, p.title FROM note_reminders r JOIN note_pages p ON p.id=r.page_id
        WHERE r.sent_at IS NULL AND r.remind_at <= now() AND p.deleted_at IS NULL LIMIT 50`)).rows;
      for (const r of due) {
        await pool.query('UPDATE note_reminders SET sent_at=now() WHERE id=$1', [r.id]);
        if (r.user_id) notify(r.user_id, '🔔 Påmindelse: ' + (r.text || r.title || 'Note'), 'Fra noten "' + (r.title || 'Uden titel') + '"', '#kb-notes/' + r.page_id);
      }
    } catch (e) { console.error('Note-påmindelser fejlede:', e.message); }
  }
  function startJobs(cron) { if (cron) cron.schedule('* * * * *', remindTick); }
  // Privat velkomstside til en nyinviteret "kun Noter"-bruger
  async function createWelcomeFor(userId) {
    const blocks = WELCOME.map(x => Object.assign({}, x, { id: crypto.randomBytes(6).toString('hex') }));
    await pool.query(`INSERT INTO note_pages (scope, owner_id, title, icon, cover_url, blocks, position, search_text, created_by, updated_by) VALUES ('private', $1, $2, '👋', 'gradient:sunset', $3, 1, $4, $1, $1)`, [
      userId, 'Velkommen til Noter', JSON.stringify(blocks), searchText('Velkommen til Noter', blocks)]);
  }
  return { initSchema, startJobs, createWelcomeFor, _test: { cleanBlocks, remindTick } };
};
