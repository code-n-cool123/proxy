// Combines the Eric/Anthony and Surnames galleries into this folder.
// Copies photos + per-profile JSON and writes data.js. Safe to re-run; decisions.json is never touched.
const fs = require('fs');
const path = require('path');
const os = require('os');

const DL = path.join(os.homedir(), 'Downloads');
const SOURCES = [
  { dir: path.join(DL, 'LinkedIn Profiles', 'profiles'), collection: 'Eric & Anthony',
    keep: (p) => p.first === 'eric' || p.first === 'anthony',
    group: (p) => p.first === 'eric' ? 'Eric' : 'Anthony' },
  { dir: path.join(DL, 'LinkedIn Surnames', 'profiles'), collection: 'Surnames',
    keep: () => true, group: (p) => p.group },
  // Built by build_new50.js straight into this folder (photos and JSON are already in place).
  { dir: __dirname, file: 'new50.data.js', optional: true, collection: 'New_50 surnames',
    keep: () => true, group: (p) => p.group },
];
const OUT = __dirname;
for (const d of ['images', 'json']) fs.mkdirSync(path.join(OUT, d), { recursive: true });

function load(src) {
  const f = path.join(src.dir, src.file || 'data.js');
  if (src.optional && !fs.existsSync(f)) return [];
  const g = {};
  new Function('window', fs.readFileSync(f, 'utf8'))(g);
  return g.PROFILES;
}
const copy = (from, to) => { if (fs.existsSync(from) && !fs.existsSync(to)) fs.copyFileSync(from, to); };

const bySlug = new Map();
for (const src of SOURCES) {
  for (const p of load(src)) {
    if (!src.keep(p)) continue;
    const key = p.slug.toLowerCase();
    const prev = bySlug.get(key);
    if (prev && prev.fetchedAt >= p.fetchedAt) continue; // keep the most recent fetch
    const rec = { ...p, collection: src.collection, group: src.group(p) };
    if (p.picture) {
      copy(path.join(src.dir, p.picture), path.join(OUT, p.picture));
    }
    const jf = p.slug.toLowerCase().replace(/[^a-z0-9_-]/g, (c) => '_' + c.charCodeAt(0).toString(16)) + '.json';
    copy(path.join(src.dir, 'json', jf), path.join(OUT, 'json', jf));
    bySlug.set(key, rec);
  }
}
const out = [...bySlug.values()].sort((a, b) => a.name.trim().localeCompare(b.name.trim()));
fs.writeFileSync(path.join(OUT, 'data.js'), 'window.PROFILES=' + JSON.stringify(out) + ';\nwindow.BUILT_AT=' + JSON.stringify(new Date().toISOString()) + ';');
const counts = {};
for (const p of out) counts[p.collection] = (counts[p.collection] || 0) + 1;
console.log('profiles', out.length, JSON.stringify(counts), 'withPhoto', out.filter((p) => p.picture).length);
