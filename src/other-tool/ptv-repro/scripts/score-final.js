#!/usr/bin/env node
/**
 * FINAL scorer — faithful to tosem26 RQ2/Table 4 (compare-detectors checkVer).
 *   Debun candidate set = strictVersions (from REAL web-detect-eval summary.csv, ψ=84%)
 *   PTV   candidate set = reported version array (as-shipped / no-label)
 * Metric per tool: Major/Minor/Patch = #entries whose candidate set contains GT@level (÷N),
 *   avg range at each level = mean(distinct majors / minors / patches) over detected entries.
 * Mirrors checkVer: majors=Set(a), minors=Set("a.b"), patches=Set(v); range=size at that level.
 */
const fs = require('fs');
const path = require('path');
// Self-contained defaults: scripts/ lives at <repo>/src/other-tool/ptv-repro/scripts.
const REPO = path.resolve(__dirname, '..', '..', '..', '..');   // debun-tosem26 repo root
const WORK = process.env.WORK || path.join(REPO, 'tmp/ptv-repro');
const MAPPING = process.env.MAPPING || path.join(WORK, 'mapping.json');
const DEBUN_SUMMARY = process.env.DEBUN_SUMMARY || path.join(WORK, 'debun-out/summary.csv');
const PTV = process.env.PTV || path.join(WORK, 'ptv-results.json');

const canon = (s) => String(s).toLowerCase().replace(/\.json$/, '').replace(/\.js$/, '').replace(/[.\-_ ]/g, '');
const parts = (v) => { const p = String(v).split('.').map((x) => parseInt(x)); return [p[0] ?? null, p[1] ?? null, p[2] ?? null]; };

// checkVer: returns {mF,miF,paF, rM,rm,rp} for a candidate set vs gt (null if empty set)
function checkVer(gtVer, versions) {
  if (!versions || versions.length === 0) return null;
  const [gM, gm, gp] = parts(gtVer);
  const majors = new Set(), minors = new Set(), patches = new Set();
  let mF = false, miF = false, paF = false;
  for (const v of versions) {
    const [a, b, c] = parts(v);
    majors.add(a); minors.add(a + '.' + b); patches.add(v);
    if (a === gM) mF = true;
    if (a === gM && b === gm) miF = true;
    if (a === gM && b === gm && c === gp) paF = true;
  }
  return { mF, miF, paF, rM: majors.size, rm: minors.size, rp: patches.size };
}

const mapping = JSON.parse(fs.readFileSync(MAPPING, 'utf8')).filter((m) => !m.error);
const ptv = new Map(JSON.parse(fs.readFileSync(PTV, 'utf8')).map((p) => [p.id, p]));

// Debun strictVersions per (site -> canon -> [versions])
const debBySite = new Map();
{
  const lines = fs.readFileSync(DEBUN_SUMMARY, 'utf8').trim().split('\n');
  const H = lines[0].split(','); const idx = (n) => H.indexOf(n);
  for (let i = 1; i < lines.length; i++) {
    // naive split ok: fields here have no embedded commas (versions use ';')
    const f = lines[i].split(',');
    const site = f[idx('site')]; const lib = canon(f[idx('lib')]);
    const strict = (f[idx('strictVersions')] || '').split(';').map((s) => s.trim()).filter(Boolean);
    if (!debBySite.has(site)) debBySite.set(site, new Map());
    debBySite.get(site).set(lib, strict);
  }
}
function debCand(m) { const s = debBySite.get(m.site); return s && s.get(m.canon) ? s.get(m.canon) : []; }
function ptvCand(m, variant) {
  const p = ptv.get(m.canon + '@' + m.version); if (!p) return [];
  let v = p.variants[variant]; if (!v && variant === 'noLabel' && !m.ptvHasLabel) v = p.variants.asShipped;
  if (!v || v.error || !v.detected) return [];
  return [...new Set((v.reported || []).map(String))];
}

const tools = { Debun: (m) => debCand(m), PTV: (m) => ptvCand(m, 'asShipped') };
const subsets = { all: () => true };

function agg(filt, fn) {
  let N = 0, det = 0, M = 0, m = 0, p = 0, rM = [], rm = [], rp = [];
  for (const e of mapping) { if (!filt(e)) continue; N++; const r = checkVer(e.version, fn(e)); if (!r) continue; det++;
    if (r.mF) M++; if (r.miF) m++; if (r.paF) p++; rM.push(r.rM); rm.push(r.rm); rp.push(r.rp); }
  const avg = (a) => a.length ? a.reduce((x, y) => x + y, 0) / a.length : 0;
  return { N, det, M, m, p, rM: avg(rM), rm: avg(rm), rp: avg(rp) };
}

const out = {};
const pc = (a, b) => (b === 0 ? '  -  ' : (100 * a / b).toFixed(1).padStart(5));
for (const [sub, filt] of Object.entries(subsets)) {
  out[sub] = {};
  console.log(`\n===== ${sub}  (N=${mapping.filter(filt).length}) =====`);
  console.log('tool'.padEnd(17), 'recall', '| Major  Minor  Patch  (÷N) | rMaj  rMin  rPat (avg range@level)');
  for (const [tool, fn] of Object.entries(tools)) {
    const a = agg(filt, fn); out[sub][tool] = a;
    console.log(tool.padEnd(17), pc(a.det, a.N), '|', pc(a.M, a.N), pc(a.m, a.N), pc(a.p, a.N), ' |',
      a.rM.toFixed(2).padStart(5), a.rm.toFixed(2).padStart(5), a.rp.toFixed(2).padStart(5));
  }
}
console.log('\nMajor/Minor/Patch = 후보집합이 GT를 그 레벨에서 포함(÷N). avg range@level = detected 중 distinct majors/minors/patches 평균.');
console.log('Debun 후보=strictVersions(real ψ=84%), PTV 후보=reported.');
fs.mkdirSync(WORK, { recursive: true });
fs.writeFileSync(path.join(WORK, 'score-final-summary.json'), JSON.stringify(out, null, 2));

// per-entry detail
const detail = mapping.map((m) => {
  const row = { id: m.canon + '@' + m.version, gt: m.version, label: !!m.ptvHasLabel };
  row.debunStrict = debCand(m); row.ptv = ptvCand(m, 'asShipped'); row.ptvNoLabel = ptvCand(m, 'noLabel');
  return row;
});
fs.writeFileSync(path.join(WORK, 'score-final-detail.json'), JSON.stringify(detail, null, 2));
console.log('-> score-final-summary.json, score-final-detail.json');
