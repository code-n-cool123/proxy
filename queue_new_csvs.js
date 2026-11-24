// Finds profiles in Downloads/New_50 surnames CSVs that are not yet queued or already in the review gallery.
// Prints the per-surname counts, writes the new profile IDs (space-separated, surname by surname) to the
// file given as the first argument, and records them in new50_queued.txt so they are not queued twice.
const fs = require('fs');
const path = require('path');
const os = require('os');

const DL = path.join(os.homedir(), 'Downloads');
const CSV_DIR = path.join(DL, 'New_50 surnames');
const QUEUED = path.join(__dirname, 'new50_queued.txt');
const outFile = process.argv[2];

const queued = new Set(fs.existsSync(QUEUED) ? fs.readFileSync(QUEUED, 'utf8').split(/\s+/).filter(Boolean) : []);
const g = {};
new Function('window', fs.readFileSync(path.join(__dirname, 'data.js'), 'utf8'))(g);
const have = new Set(g.PROFILES.map(p => p.slug.toLowerCase()));

// One CSV per surname; the combined ALL_*.csv adds nothing new, so it is read last.
const files = fs.readdirSync(CSV_DIR).filter(f => /\.csv$/i.test(f)).sort((a, b) => /^ALL/i.test(a) - /^ALL/i.test(b) || a.localeCompare(b));
const fresh = [], per = {};
for (const f of files) {
  for (const line of fs.readFileSync(path.join(CSV_DIR, f), 'utf8').replace(/^﻿/, '').split(/\r?\n/).slice(1)) {
    const u = line.match(/linkedin\.com\/in\/([^,\/?#"]+)/i);
    if (!u || queued.has(u[1]) || have.has(u[1].toLowerCase())) continue;
    queued.add(u[1]);
    fresh.push(u[1]);
    const s = line.split(',').pop().trim() || f.replace(/\.csv$/i, '');
    per[s] = (per[s] || 0) + 1;
  }
}
if (outFile) fs.writeFileSync(outFile, fresh.join(' '));
if (fresh.length) fs.writeFileSync(QUEUED, [...queued].join('\n'));
console.log(`new=${fresh.length} ${JSON.stringify(per)}`);
