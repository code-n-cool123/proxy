// Server for the review gallery.
// Serves the page, returns profiles one page at a time, and saves approve/reject decisions to decisions.json.
// Listens on the network (all interfaces) and requires the password in password.txt.
const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const ROOT = __dirname;
const PORT = +process.env.PORT || 8095;
const HOST = process.env.HOST || '0.0.0.0';

// --- password + sessions ---
// password.txt holds the password (first line). It is created with a random one on first start; edit it to change.
const PASSWORD_FILE = path.join(ROOT, 'password.txt');
if (!fs.existsSync(PASSWORD_FILE)) fs.writeFileSync(PASSWORD_FILE, crypto.randomBytes(12).toString('base64url') + '\n');
const passwordHash = () => crypto.createHash('sha256').update(fs.readFileSync(PASSWORD_FILE, 'utf8').split(/\r?\n/)[0].trim()).digest();
const SESSION_DAYS = 14;
const sessions = new Map(); // token -> expiry ms
const failures = new Map(); // ip -> {count, until}
function cookieToken(req) {
  const m = (req.headers.cookie || '').match(/(?:^|;\s*)review_session=([A-Za-z0-9_-]+)/);
  const t = m && m[1], exp = t && sessions.get(t);
  if (!exp) return null;
  if (exp < Date.now()) { sessions.delete(t); return null; }
  return t;
}
function checkPassword(given) {
  const a = crypto.createHash('sha256').update(String(given || '')).digest();
  return crypto.timingSafeEqual(a, passwordHash());
}
// After 5 wrong passwords from one address, refuse logins from it for 15 minutes.
function lockedOut(ip) { const f = failures.get(ip); return f && f.until > Date.now(); }
function noteFailure(ip) {
  const f = failures.get(ip) || { count: 0, until: 0 };
  f.count++;
  if (f.count >= 5) { f.until = Date.now() + 15 * 60000; f.count = 0; }
  failures.set(ip, f);
}
const LOGIN_PAGE = (msg) => `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>LinkedIn Review – Sign in</title>
<style>:root{--bg:#f4f5f7;--s:#fff;--t:#16181d;--m:#5d6470;--l:#e3e6ea;--a:#0a66c2;--bad:#c62828}@media (prefers-color-scheme:dark){:root{--bg:#111317;--s:#1a1d23;--t:#e8eaed;--m:#9aa1ab;--l:#2a2e36;--a:#5aa2f0;--bad:#f2726f}}
body{margin:0;min-height:100vh;display:grid;place-items:center;background:var(--bg);color:var(--t);font:15px/1.45 system-ui,-apple-system,"Segoe UI",Roboto,sans-serif;padding:16px;box-sizing:border-box}
form{background:var(--s);border:1px solid var(--l);border-radius:14px;padding:24px;width:min(340px,100%);display:grid;gap:12px}
h1{font-size:18px;margin:0}p{margin:0;color:var(--m);font-size:13px}.e{color:var(--bad)}
input{font:inherit;color:inherit;background:var(--bg);border:1px solid var(--l);border-radius:8px;padding:9px 11px}
button{font:inherit;background:var(--a);color:#fff;border:0;border-radius:8px;padding:9px;cursor:pointer}</style></head>
<body><form method="post" action="/login"><h1>LinkedIn Review</h1><p>Enter the review password.</p>${msg ? `<p class="e">${msg}</p>` : ''}
<input type="password" name="password" autocomplete="current-password" autofocus required aria-label="Password"><button>Sign in</button></form></body></html>`;
const DATA = path.join(ROOT, 'data.js');
const DECISIONS = path.join(ROOT, 'decisions.json');
const types = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.json': 'application/json', '.jpg': 'image/jpeg', '.csv': 'text/csv; charset=utf-8' };
const MAX_PER = 200;

// --- data (reloaded automatically when merge.js rewrites data.js) ---
let P = [], bySlug = new Map(), meta = {}, dataMtime = 0;
function loadData() {
  const m = fs.statSync(DATA).mtimeMs;
  if (m === dataMtime) return;
  const g = {};
  new Function('window', fs.readFileSync(DATA, 'utf8'))(g);
  P = g.PROFILES;
  for (const p of P) p._q = [p.name, p.csvName, p.headline, p.title, p.company, p.location, p.country, p.skills.join(' '), p.positions.map(x => x.company + ' ' + x.title).join(' ')].join(' ').toLowerCase();
  bySlug = new Map(P.map(p => [p.slug, p]));
  const groups = {};
  for (const p of P) (groups[p.collection] ||= new Set()).add(p.group);
  meta = { total: P.length, builtAt: g.BUILT_AT, collections: Object.fromEntries(Object.entries(groups).sort().map(([c, s]) => [c, [...s].filter(Boolean).sort()])) };
  dataMtime = m;
}

let decisions = {};
try { decisions = JSON.parse(fs.readFileSync(DECISIONS, 'utf8')); } catch {}
function saveDecisions() {
  const tmp = DECISIONS + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(decisions, null, 1));
  fs.renameSync(tmp, DECISIONS);
}
// --- contacts (slug -> {name, url, email}; reloaded automatically when contacts.json is rewritten) ---
const CONTACTS = path.join(ROOT, 'contacts.json');
let contacts = {}, contactsMtime = 0;
function loadContacts() {
  if (!fs.existsSync(CONTACTS)) return;
  const m = fs.statSync(CONTACTS).mtimeMs;
  if (m === contactsMtime) return;
  contacts = JSON.parse(fs.readFileSync(CONTACTS, 'utf8'));
  contactsMtime = m;
}

// --- used contacts (slug -> {at}): contacts already copied out, hidden from the contacts view ---
const USED = path.join(ROOT, 'contacts_used.json');
let used = {};
try { used = JSON.parse(fs.readFileSync(USED, 'utf8')); } catch {}
function saveUsed() {
  const tmp = USED + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(used, null, 1));
  fs.renameSync(tmp, USED);
}

const statusOf = (p) => decisions[p.slug]?.status || null;
const strip = ({ _q, ...p }) => ({ ...p, status: statusOf(p), decidedAt: decisions[p.slug]?.at || null, contact: contacts[p.slug] || null, usedAt: used[p.slug]?.at || null });

function counts() {
  let approved = 0, rejected = 0, fresh = 0, usedCount = 0;
  for (const p of P) {
    const s = statusOf(p);
    if (s === 'approved') { approved++; if (contacts[p.slug]) used[p.slug] ? usedCount++ : fresh++; }
    else if (s === 'rejected') rejected++;
  }
  return { todo: P.length - approved - rejected, approved, rejected, contacts: fresh, used: usedCount };
}
// view: todo | approved | rejected | contacts | used. Rejected profiles only ever appear in the rejected view.
// contacts lists the approved profiles looked up on RocketReach that have not been copied out yet; used lists the ones that have.
function query(sp) {
  const view = ['approved', 'rejected', 'contacts', 'used'].includes(sp.get('view')) ? sp.get('view') : 'todo';
  const words = (sp.get('q') || '').trim().toLowerCase().split(/\s+/).filter(Boolean);
  const col = sp.get('col') || '', grp = sp.get('grp') || '', pic = sp.get('pic') || '';
  return P.filter(p => {
    const s = statusOf(p);
    if (view === 'contacts' || view === 'used') { if (s !== 'approved' || !contacts[p.slug] || !!used[p.slug] !== (view === 'used')) return false; }
    else if (view === 'todo' ? s : s !== view) return false;
    if (col && p.collection !== col) return false;
    if (grp && p.group !== grp) return false;
    if (pic && (!!p.picture) !== (pic === '1')) return false;
    return words.every(w => p._q.includes(w));
  });
}

const csvCell = (v) => `"${String(v ?? '').replace(/"/g, '""')}"`;

http.createServer((req, res) => {
  const u = new URL(req.url, 'http://localhost');
  const url = decodeURIComponent(u.pathname);
  const json = (code, obj) => { res.writeHead(code, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' }); res.end(JSON.stringify(obj)); };
  const html = (code, body, headers = {}) => { res.writeHead(code, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store', ...headers }); res.end(body); };
  const ip = req.socket.remoteAddress;

  if (url === '/login' && req.method === 'GET') return html(200, LOGIN_PAGE(''));
  if (url === '/login' && req.method === 'POST') {
    let body = '';
    req.on('data', (c) => { body += c; if (body.length > 4096) req.destroy(); });
    req.on('end', () => {
      if (lockedOut(ip)) return html(429, LOGIN_PAGE('Too many wrong attempts. Try again in 15 minutes.'));
      if (!checkPassword(new URLSearchParams(body).get('password'))) { noteFailure(ip); return html(401, LOGIN_PAGE('Wrong password.')); }
      failures.delete(ip);
      const token = crypto.randomBytes(32).toString('base64url');
      sessions.set(token, Date.now() + SESSION_DAYS * 864e5);
      res.writeHead(303, { Location: '/', 'Set-Cookie': `review_session=${token}; HttpOnly; SameSite=Strict; Path=/; Max-Age=${SESSION_DAYS * 86400}` });
      res.end();
    });
    return;
  }
  if (url === '/logout') {
    const t = cookieToken(req); if (t) sessions.delete(t);
    res.writeHead(303, { Location: '/login', 'Set-Cookie': 'review_session=; HttpOnly; SameSite=Strict; Path=/; Max-Age=0' });
    return res.end();
  }
  // Everything else needs a signed-in session.
  if (!cookieToken(req)) {
    if (url.startsWith('/api/')) return json(401, { error: 'not signed in' });
    res.writeHead(303, { Location: '/login' }); return res.end();
  }

  try { loadData(); loadContacts(); } catch (e) { return json(500, { error: 'cannot read data: ' + e.message }); }

  if (url === '/api/meta') return json(200, { ...meta, counts: counts() });

  if (url === '/api/profiles') {
    const list = query(u.searchParams);
    const per = Math.min(MAX_PER, Math.max(1, parseInt(u.searchParams.get('per')) || 60));
    const pages = Math.max(1, Math.ceil(list.length / per));
    // page wins; offset is accepted too and rounded down to its page.
    let page = parseInt(u.searchParams.get('page'));
    if (!(page >= 1)) page = Math.floor((parseInt(u.searchParams.get('offset')) || 0) / per) + 1;
    page = Math.min(page, pages);
    const offset = (page - 1) * per;
    return json(200, { total: list.length, page, pages, per, offset, counts: counts(), items: list.slice(offset, offset + per).map(strip) });
  }

  if (url === '/api/decision' && req.method === 'POST') {
    let body = '';
    req.on('data', (c) => { body += c; if (body.length > 1e5) req.destroy(); });
    req.on('end', () => {
      try {
        const { slug, status } = JSON.parse(body);
        if (!bySlug.has(slug)) return json(400, { error: 'unknown profile' });
        if (status === 'approved' || status === 'rejected') decisions[slug] = { status, at: new Date().toISOString() };
        else if (status === null) delete decisions[slug];
        else return json(400, { error: 'status must be approved, rejected or null' });
        saveDecisions();
        json(200, { ok: true, counts: counts() });
      } catch (e) { json(400, { error: e.message }); }
    });
    return;
  }

  if (url === '/api/export.csv') {
    const rows = P.filter(p => statusOf(p) === 'approved');
    const csv = ['Name,Headline,Title,Company,Location,Collection,Group,LinkedIn URL,Approved at']
      .concat(rows.map(p => [p.name.trim(), p.headline, p.title, p.company, p.location, p.collection, p.group, p.url, decisions[p.slug].at].map(csvCell).join(','))).join('\r\n');
    res.writeHead(200, { 'Content-Type': 'text/csv; charset=utf-8', 'Content-Disposition': `attachment; filename="approved_profiles_${new Date().toISOString().slice(0, 10)}.csv"` });
    return res.end('﻿' + csv);
  }

  if (url === '/api/contact-used' && req.method === 'POST') {
    let body = '';
    req.on('data', (c) => { body += c; if (body.length > 1e5) req.destroy(); });
    req.on('end', () => {
      try {
        const { slug, used: isUsed } = JSON.parse(body);
        if (!contacts[slug]) return json(400, { error: 'unknown contact' });
        if (isUsed) used[slug] = { at: new Date().toISOString() };
        else delete used[slug];
        saveUsed();
        json(200, { ok: true, counts: counts() });
      } catch (e) { json(400, { error: e.message }); }
    });
    return;
  }

  // Only the contacts not copied out yet.
  if (url === '/api/contacts.txt') {
    const rows = P.filter(p => statusOf(p) === 'approved' && contacts[p.slug] && !used[p.slug]).map(p => contacts[p.slug]);
    res.writeHead(200, { 'Content-Type': 'text/plain; charset=utf-8', 'Content-Disposition': `attachment; filename="contacts_${new Date().toISOString().slice(0, 10)}.txt"` });
    return res.end(rows.map(c => `${c.name}\r\n${c.url}\r\n${c.email || 'No personal email found'}`).join('\r\n\r\n') + '\r\n');
  }

  // Static files: the page, photos and per-profile JSON. Data and decisions files are only reachable through the API.
  const p = url === '/' ? '/index.html' : url;
  const f = path.join(ROOT, path.normalize(p));
  const allowed = f === path.join(ROOT, 'index.html') || f.startsWith(path.join(ROOT, 'images') + path.sep) || f.startsWith(path.join(ROOT, 'json') + path.sep);
  if (!allowed || !fs.existsSync(f) || fs.statSync(f).isDirectory()) { res.statusCode = 404; return res.end(); }
  res.setHeader('Content-Type', types[path.extname(f)] || 'application/octet-stream');
  fs.createReadStream(f).pipe(res);
}).listen(PORT, HOST, () => {
  console.log(`Review gallery: http://localhost:${PORT}`);
  if (HOST === '0.0.0.0') for (const list of Object.values(require('os').networkInterfaces())) for (const a of list) if (a.family === 'IPv4' && !a.internal) console.log(`  from other devices: http://${a.address}:${PORT}`);
  console.log(`Password: see password.txt in ${ROOT}`);
});
