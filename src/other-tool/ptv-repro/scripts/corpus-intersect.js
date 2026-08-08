#!/usr/bin/env node
/**
 * Compute the fair corpus = libs that BOTH PTV and Debun can do VERSION detection on.
 *   PTV  version-capable = libraries.json (labels/features)  ∪ versionfiles
 *   Debun version-capable = version-anchors.json keys (68)
 * Canonicalize both sides, intersect, then report per-lib version coverage overlap.
 */
const fs = require('fs');
const path = require('path');
// Self-contained defaults: scripts/ lives at <repo>/src/other-tool/ptv-repro/scripts.
const RP = path.join(__dirname, '..');                  // ptv-repro
const REPO = path.resolve(RP, '..', '..', '..');        // debun-tosem26 repo root
const PTV = process.env.PTV_DIR || path.join(REPO, 'src/other-tool/ptv');   // vendored PTV extension
const DEB = process.env.DEBUN_SRC || path.join(REPO, 'src');

// ---- canonicalization (mirror Debun ALIAS + normalize) ----
const ALIAS = {
  'react-dom': 'react', 'reactdom': 'react',
  'angularjs': 'angular.js', 'backbone': 'backbone.js', 'handlebars': 'handlebars.js',
  'hammerjs': 'hammer.js', 'ifvisible.js': 'ifvisible', 'jquery-ui': 'jqueryui',
  'jquery.ui': 'jqueryui', 'lodash': 'lodash.js', 'moment': 'moment.js',
  'requirejs': 'require.js', 'underscore': 'underscore.js',
};
// loose key: lowercase, strip .js, strip separators
const norm = (s) => String(s).trim().toLowerCase().replace(/\.js$/, '').replace(/[.\-_ ]/g, '');
const canon = (s) => { const c = ALIAS[String(s).trim().toLowerCase()] ?? String(s).trim().toLowerCase(); return c; };

// ---- PTV side ----
const ptvLibs = JSON.parse(fs.readFileSync(PTV + '/data/libraries.json', 'utf8'));
const ptvByNorm = new Map(); // norm -> {libname, versionfile, hasLabel}
for (const e of ptvLibs) {
  const n = norm(e.libname);
  ptvByNorm.set(n, { libname: e.libname, versionfile: e.versionfile || null, hasLabel: !!e.function });
}
// PTV per-lib version coverage from versionfile
function ptvVersions(versionfile) {
  if (!versionfile) return [];
  const p = PTV + '/data/versions/' + versionfile;
  if (!fs.existsSync(p)) return [];
  try {
    const d = JSON.parse(fs.readFileSync(p, 'utf8'));
    const vs = new Set();
    for (const k of Object.keys(d)) { const e = d[k]; (e.version_list || (e.version ? [e.version] : [])).forEach((v) => vs.add(String(v))); }
    return [...vs];
  } catch { return []; }
}

// ---- Debun side ----
const anchors = JSON.parse(fs.readFileSync(DEB + '/data/fingerprint-cache/version-anchors.json', 'utf8'));
const debByNorm = new Map(); // norm -> {name, versions[]}
for (const name of Object.keys(anchors)) {
  debByNorm.set(norm(name), { name, versions: Object.keys(anchors[name]) });
}

// ---- intersect ----
const rows = [];
for (const [n, deb] of debByNorm.entries()) {
  const ptv = ptvByNorm.get(n);
  if (!ptv) { rows.push({ n, deb: deb.name, ptv: null }); continue; }
  const pv = ptvVersions(ptv.versionfile);
  // version overlap (exact string)
  const debSet = new Set(deb.versions);
  const common = pv.filter((v) => debSet.has(v));
  rows.push({ n, deb: deb.name, ptv: ptv.libname, ptvHasLabel: ptv.hasLabel, ptvVf: !!ptv.versionfile,
    ptvVerCount: pv.length, debVerCount: deb.versions.length, commonVerCount: common.length,
    debVersions: deb.versions, ptvVersions: pv });
}

const matched = rows.filter((r) => r.ptv);
const unmatched = rows.filter((r) => !r.ptv);

console.log('===== DEBUN version-capable libs:', debByNorm.size, '  PTV lib universe:', ptvByNorm.size, '=====');
console.log('\n### INTERSECTION (Debun∩PTV, version-capable):', matched.length, 'libs ###');
console.log('lib'.padEnd(20), 'label', 'vf ', 'PTVv', 'DEBv', 'common');
for (const r of matched.sort((a, b) => b.commonVerCount - a.commonVerCount)) {
  console.log(String(r.deb).padEnd(20), String(r.ptvHasLabel).padEnd(5), String(r.ptvVf).padEnd(3), String(r.ptvVerCount).padStart(4), String(r.debVerCount).padStart(4), String(r.commonVerCount).padStart(6));
}
console.log('\n### Debun libs NOT in PTV universe:', unmatched.length, '###');
console.log(unmatched.map((r) => r.deb).join(', '));

const withLabel = matched.filter((r) => r.ptvHasLabel).length;
const withVf = matched.filter((r) => r.ptvVf).length;
const withCommonVers = matched.filter((r) => r.commonVerCount > 0).length;
console.log('\n===== SUMMARY =====');
console.log('intersection libs           :', matched.length);
console.log('  with PTV label (Step1)    :', withLabel);
console.log('  with PTV versionfile      :', withVf);
console.log('  with >=1 common version   :', withCommonVers);

fs.writeFileSync(process.env.OUT || path.join(RP, 'corpus-intersect.json'), JSON.stringify({ matched, unmatched }, null, 2));
console.log('\n-> corpus-intersect.json written');
