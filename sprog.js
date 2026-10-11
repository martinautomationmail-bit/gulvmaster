'use strict';
// ══════════════════════════════════════════════════════════════
// SPROG (okt. 2026) — dansk/engelsk i portalen og medarbejder-appen.
//  • /i18n/lang.js   – vælgeren DA | EN (indlæses altid)
//  • /i18n/en.js     – ordbog + oversætter (indlæses kun ved engelsk)
//  • /api/me/lang    – brugerens valg gemmes, så det følger med på alle enheder
// Kundesider, mails og PDF'er er fortsat på dansk — kun admin.html/employee.html
// (og employee-demo.html) oversættes.
// ══════════════════════════════════════════════════════════════
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

module.exports = function registerSprog(app, deps) {
  const { pool, pgOne, auth, asyncRoute, rootDir } = deps;
  let enJs = null, langJs = null, ver = '1';
  function load() {
    const dict = fs.readFileSync(path.join(rootDir, 'i18n-en.json'), 'utf8');
    const rt = fs.readFileSync(path.join(rootDir, 'i18n-runtime.js'), 'utf8');
    enJs = 'window.__I18N_DICT=' + dict.trim() + ';\n' + rt;
    langJs = fs.readFileSync(path.join(rootDir, 'i18n-lang.js'), 'utf8');
    ver = crypto.createHash('md5').update(enJs + langJs).digest('hex').slice(0, 8);
  }
  try { load(); } catch (e) { console.error('Sprogfiler mangler:', e.message); }
  const send = (body) => (req, res) => {
    if (!body()) return res.status(404).end();
    res.type('application/javascript; charset=utf-8');
    res.set('Cache-Control', req.query.v ? 'public, max-age=31536000, immutable' : 'no-cache');
    res.send(body());
  };
  app.get('/i18n/en.js', send(() => enJs));
  app.get('/i18n/lang.js', send(() => langJs));
  app.get('/i18n/version', (req, res) => res.json({ v: ver }));

  async function initSchema() {
    await pool.query("ALTER TABLE users ADD COLUMN IF NOT EXISTS lang TEXT");
  }
  app.get('/api/me/lang', auth, asyncRoute(async (req, res) => {
    const u = await pgOne('SELECT lang FROM users WHERE id=$1', [req.user.id]);
    res.json({ lang: u && u.lang ? u.lang : null });
  }));
  app.put('/api/me/lang', auth, asyncRoute(async (req, res) => {
    const l = (req.body || {}).lang === 'en' ? 'en' : 'da';
    await pool.query('UPDATE users SET lang=$1 WHERE id=$2', [l, req.user.id]);
    res.json({ ok: true, lang: l });
  }));
  // Indsættes i <head> på de interne sider (se server.js → sendPage)
  function headSnippet() {
    return `<script>(function(){try{if(localStorage.getItem('ab_lang')==='en')document.write('<scr'+'ipt src="/i18n/en.js?v=${ver}"></scr'+'ipt>');}catch(e){}})();</script><script src="/i18n/lang.js?v=${ver}" defer></script>`;
  }
  return { initSchema, headSnippet };
};
