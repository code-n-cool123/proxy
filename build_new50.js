// Reads new50_batch_*.json from Downloads (and its archive), saves photos + full JSON into this review folder,
// and writes new50.data.js, which merge.js folds into data.js. Safe to re-run; skips existing images.
// Names and surnames come from every CSV in Downloads/New_50 surnames, so newly added files are picked up.
const fs = require('fs');
const path = require('path');
const os = require('os');

const DL = path.join(os.homedir(), 'Downloads');
const CSV_DIR = path.join(DL, 'New_50 surnames');
const ARCHIVE = path.join(DL, 'LinkedIn Batch Archive', 'new50_surnames');
const OUT = __dirname;
const IMG = path.join(OUT, 'images');
const RAW = path.join(OUT, 'json');
for (const d of [IMG, RAW]) fs.mkdirSync(d, { recursive: true });

// CSV name/surname lookup by slug
const csv = {};
for (const f of fs.readdirSync(CSV_DIR).filter(f => /\.csv$/i.test(f))) {
  for (const line of fs.readFileSync(path.join(CSV_DIR, f), 'utf8').replace(/^﻿/, '').split(/\r?\n/).slice(1)) {
    const m = line.match(/^(.*?),(?:"[^"]*"|[^,]*),([^,]*)$/);
    const u = line.match(/linkedin\.com\/in\/([^,\/?#"]+)/i);
    if (m && u) csv[u[1].toLowerCase()] = { name: m[1].replace(/^"|"$/g, ''), search: m[2].trim() };
  }
}

const biggest = (o) => {
  if (!o) return null;
  if (typeof o === 'string') return /^https?:/.test(o) ? o : null;
  if (o.url && typeof o.url === 'string') return o.url;
  const ks = Object.keys(o).filter(k => typeof o[k] === 'string').sort((a, b) => parseInt(b) - parseInt(a));
  return ks.length ? o[ks[0]] : null;
};
const safe = (s) => s.toLowerCase().replace(/[^a-z0-9_-]/g, (c) => '_' + c.charCodeAt(0).toString(16));
const ym = (d) => d && d.year ? (d.month ? `${String(d.month).padStart(2, '0')}/${d.year}` : `${d.year}`) : '';
const period = (tp) => {
  if (!tp) return '';
  const a = ym(tp.startDate), b = tp.endDate ? ym(tp.endDate) : (a ? 'Present' : '');
  return [a, b].filter(Boolean).join(' – ');
};

async function download(url, file) {
  const dest = path.join(IMG, file);
  if (fs.existsSync(dest)) return 'images/' + file;
  if (!url) return null;
  try {
    const r = await fetch(url);
    if (!r.ok) return null;
    fs.writeFileSync(dest, Buffer.from(await r.arrayBuffer()));
    return 'images/' + file;
  } catch { return null; }
}

function slim(rec, pic) {
  const p = rec.profile || {};
  const c = csv[rec.slug.toLowerCase()] || {};
  const positions = (p.positions?.length ? p.positions : p.experience || []).map(x => ({
    title: x.title || x.position || '',
    company: x.companyName || x.company?.name || '',
    location: x.locationName || x.location || '',
    period: period(x.timePeriod) || x.duration || '',
    duration: x.totalDuration || '',
    description: x.description || '',
  }));
  const educations = (p.educations?.length ? p.educations : p.education || []).map(x => ({
    school: x.schoolName || x.school || '',
    degree: [x.degreeName, x.fieldOfStudy].filter(Boolean).join(', '),
    period: period(x.timePeriod),
  }));
  const names = (arr, f) => (arr || []).map(f).filter(Boolean);
  return {
    slug: rec.slug,
    csvName: c.name || '',
    group: c.search || '',
    first: (c.name || p.firstName || '').split(/[ ,]/)[0].normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase(),
    name: [p.firstName, p.lastName].filter(Boolean).join(' ') || c.name || rec.slug,
    headline: p.headline || '',
    title: p.currentTitle || p.jobTitle || '',
    company: positions[0]?.company || p.currentCompany?.name || '',
    location: p.geoLocationName || p.location?.linkedinText || '',
    country: p.geoCountryName || p.location?.parsed?.countryFull || '',
    about: p.summary || p.about || '',
    connections: p.connectionsCount ?? null,
    followers: p.followerCount ?? null,
    premium: !!p.premium, verified: !!(p.isVerified || p.verified),
    url: p.linkedinUrl || p.profileUrl || rec.inputUrl,
    picture: pic,
    positions, educations,
    skills: names(p.skills, s => s.name),
    certifications: names(p.certifications, x => [x.name || x.title, x.authority || x.issuer].filter(Boolean).join(' — ')),
    languages: names(p.languages, x => [x.name, x.proficiency].filter(Boolean).join(' — ')),
    honors: names(p.honors?.length ? p.honors : p.honorsAndAwards, x => x.title || x.name),
    volunteer: names(p.volunteerExperiences?.length ? p.volunteerExperiences : p.volunteerExperience, x => [x.role || x.title, x.companyName || x.organization].filter(Boolean).join(' — ')),
    projects: names(p.projects, x => x.title || x.name),
    source: rec.source, fetchedAt: rec.fetchedAt,
  };
}

(async () => {
  // Batches land in Downloads during the run and are archived afterwards; read both.
  const dirs = [DL, ARCHIVE].filter(d => fs.existsSync(d));
  const files = dirs.flatMap(d => fs.readdirSync(d).filter(f => /^new50_batch_\d+\.json$/.test(f)).map(f => path.join(d, f))).sort();
  const bySlug = new Map();
  for (const f of files) {
    for (const rec of JSON.parse(fs.readFileSync(f, 'utf8'))) if (rec.source !== 'cache') bySlug.set(rec.slug, rec);
  }
  const recs = [...bySlug.values()];
  const out = [];
  let pics = 0;
  const queue = recs.slice();
  async function worker() {
    while (queue.length) {
      const rec = queue.shift();
      const p = rec.profile || {};
      const fn = safe(rec.slug);
      fs.writeFileSync(path.join(RAW, fn + '.json'), JSON.stringify(rec, null, 1));
      const pic = await download(biggest(p.pictureUrl) || biggest(p.profilePicture) || biggest(p.photo), fn + '.jpg');
      if (pic) pics++;
      out.push(slim(rec, pic));
    }
  }
  await Promise.all(Array.from({ length: 6 }, worker));
  out.sort((a, b) => a.name.localeCompare(b.name));
  fs.writeFileSync(path.join(OUT, 'new50.data.js'), 'window.PROFILES=' + JSON.stringify(out) + ';\nwindow.BUILT_AT=' + JSON.stringify(new Date().toISOString()) + ';');
  const g = {};
  for (const p of out) g[p.group] = (g[p.group] || 0) + 1;
  console.log(`batches=${files.length} profiles=${out.length} withPhoto=${pics} ${JSON.stringify(g)}`);
})();
