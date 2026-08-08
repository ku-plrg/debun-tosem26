/**
 * version-metrics.ts
 *
 * Score web-detect-eval results against the same GT and rules as
 * src/evaluation/rq3-library-detection/index.ts. Two metric variants:
 *   • exact     — the detector pins down a single version equal to GT
 *   • inclusion — at least one detected version overlaps with GT versions
 *                 (a multi-version range counts as TP for inclusion only)
 *
 * Universe: GT entries that include a version (entries with no version
 * specified are skipped, mirroring rq2's `if (!versions.length) return`).
 *
 * Lib-level FP: any detected (lib, version) where the lib does not appear
 * in GT increments dbRange.FP — the same harsh rule rq2 uses.
 *
 * Usage:
 *   npx tsx src/evaluation/version-metrics.ts <eval-output-dir> [--per-lib]
 *
 * Examples:
 *   npx tsx src/evaluation/version-metrics.ts data/eval-t86-n5u3
 *   npx tsx src/evaluation/version-metrics.ts data/eval-t86-n5u3 --per-lib
 */
import * as fs from 'fs';
import { join } from 'path';

const args = process.argv.slice(2);
const showPerLib = args.includes('--per-lib');
// GT scoping happens upstream (web-detect-eval skips out-of-scope versions at detection).
// Keep version-metrics simple: score against the full GT, no in-script filter.
const noScope = true;
void args.includes('--no-scope');
const dir = args.find(a => !a.startsWith('--'));

if (!dir) {
  console.error('Usage: version-metrics <eval-output-dir> [--per-lib]');
  process.exit(1);
}

const summaryPath = join(dir, 'summary.csv');
const gtPath = 'src/ground/ground-truth.csv';
const cdnLibsPath = 'src/data/fingerprint-cache/cdn-alllibs.json';
for (const p of [summaryPath, gtPath, cdnLibsPath]) {
  if (!fs.existsSync(p)) {
    console.error(`[error] not found: ${p}`);
    process.exit(1);
  }
}

// ── CDN scope ──
// Stricter rule: a (canonical-lib, version) is in-scope iff EVERY baseLib that
// aliases to it has that version in CDN. Example: 'react' canonicalizes both
// 'react' and 'react-dom'. react@18.3.1 is in-scope only when both react CDN
// AND react-dom CDN have 18.3.1 — partial CDN coverage means we cannot
// reliably detect that exact (lib, version) pair.
const libAlias: Record<string, string> = { 'react-dom': 'react' };
function canonicalize(lib: string): string { return libAlias[lib] ?? lib; }

interface CdnLibsEntry { id: number; versions: string[] }
const cdnLibsRaw = JSON.parse(fs.readFileSync(cdnLibsPath, 'utf-8')) as Record<string, CdnLibsEntry>;
// per-baseLib version set (union across file-libs of that baseLib)
const cdnVersionsByBaseLib = new Map<string, Set<string>>();
for (const [key, e] of Object.entries(cdnLibsRaw)) {
  const baseLib = key.split('____')[0];
  let s = cdnVersionsByBaseLib.get(baseLib);
  if (!s) { s = new Set(); cdnVersionsByBaseLib.set(baseLib, s); }
  for (const v of e.versions) s.add(v);
}
// inverse alias map: canonical → list of baseLibs that contribute to it
const sourcesByCanonical = new Map<string, string[]>();
const allBaseLibs = new Set<string>([...cdnVersionsByBaseLib.keys(), ...Object.keys(libAlias)]);
for (const bl of allBaseLibs) {
  const canon = canonicalize(bl);
  let arr = sourcesByCanonical.get(canon);
  if (!arr) { arr = []; sourcesByCanonical.set(canon, arr); }
  if (!arr.includes(bl)) arr.push(bl);
}
function inScope(lib: string, version?: string): boolean {
  if (noScope) return true;
  const sources = sourcesByCanonical.get(lib) ?? [lib];
  if (version === undefined) {
    return sources.every((bl) => (cdnVersionsByBaseLib.get(bl)?.size ?? 0) > 0);
  }
  return sources.every((bl) => cdnVersionsByBaseLib.get(bl)?.has(version));
}

// ── parse summary.csv → debunSet[url] = ["lib@v", "lib@v", ...] ──
function splitCsvLine(line: string): string[] {
  // handles quoted fields with commas
  const out: string[] = [];
  let cur = '';
  let inQ = false;
  for (let i = 0; i < line.length; i++) {
    const c = line[i];
    if (c === '"') { inQ = !inQ; continue; }
    if (c === ',' && !inQ) { out.push(cur); cur = ''; continue; }
    cur += c;
  }
  out.push(cur);
  return out;
}

const summaryText = fs.readFileSync(summaryPath, 'utf-8').trim();
const summaryLines = summaryText.split('\n');
const summaryHdr = splitCsvLine(summaryLines[0]);
const colIdx = (name: string) => summaryHdr.indexOf(name);
const idxSite = colIdx('site'), idxLib = colIdx('lib'), idxDet = colIdx('detected');
const idxStrict = colIdx('strictVersions');
const inclusionByUrl = new Map<string, string[]>();
const exactByUrl = new Map<string, string[]>();
for (let i = 1; i < summaryLines.length; i++) {
  const c = splitCsvLine(summaryLines[i]);
  const site = c[idxSite];
  const lib = c[idxLib];
  if (c[idxDet] !== 'true') continue;
  const strictVers = Array.from(new Set((c[idxStrict] ?? '').split(';').filter(Boolean)));
  if (strictVers.length === 0) continue;
  let inc = inclusionByUrl.get(site);
  if (!inc) { inc = []; inclusionByUrl.set(site, inc); }
  for (const v of strictVers) inc.push(`${lib}@${v}`);
  // exact mode uses the same strictVersions universe as inclusion mode.
  let ex = exactByUrl.get(site);
  if (!ex) { ex = []; exactByUrl.set(site, ex); }
  for (const v of strictVers) ex.push(`${lib}@${v}`);
}

// ── parse ground-truth.csv ──
function parseLibraries(cell: string | undefined): string[] {
  if (!cell) return [];
  return cell.split(',').map(s => s.trim()).filter(s => s.length > 0);
}

const gtText = fs.readFileSync(gtPath, 'utf-8').trim();
const gtLines = gtText.split('\n');
const gtHeader = splitCsvLine(gtLines[0]);
const gtIdx = gtHeader.indexOf('ground truth');
const urlIdx = gtHeader.indexOf('url');
if (gtIdx === -1 || urlIdx === -1) {
  console.error('[error] ground-truth.csv missing required columns');
  process.exit(1);
}

interface Counts { tp: number; fp: number; fn: number }
const ex: Counts = { tp: 0, fp: 0, fn: 0 };
const rg: Counts = { tp: 0, fp: 0, fn: 0 };
const lib: Counts = { tp: 0, fp: 0, fn: 0 };
const exPerLib: Record<string, Counts> = {};
const rgPerLib: Record<string, Counts> = {};
const libPerLib: Record<string, Counts> = {};
function bump(map: Record<string, Counts>, lib: string, key: keyof Counts) {
  if (!map[lib]) map[lib] = { tp: 0, fp: 0, fn: 0 };
  map[lib][key]++;
}

let totalVersions = 0;
let totalLibEntries = 0;
let outOfScopeVersions = 0;
let outOfScopeLibs = 0;

for (let i = 1; i < gtLines.length; i++) {
  const c = splitCsvLine(gtLines[i]);
  const url = c[urlIdx];
  const truthCell = c[gtIdx];
  const truthSet = new Set(parseLibraries(truthCell));
  if (truthSet.size === 0) continue;

  const incSet = new Set(inclusionByUrl.get(url) ?? []);
  const exSet  = new Set(exactByUrl.get(url) ?? []);

  // Per-site set of GT lib names (for lib-level metric)
  const gtLibsThisSite = new Set<string>();
  for (const truth of truthSet) gtLibsThisSite.add(truth.split('@')[0]);

  for (const truth of truthSet) {
    const [libName, ...versions] = truth.split('@');

    // version-level scope filter: drop GT (lib, version) not in CDN cache
    if (versions.length > 0) {
      const inScopeAll = versions.every((v) => inScope(libName, v));
      if (!inScopeAll) {
        outOfScopeVersions++;
        continue;
      }
      totalVersions++;

      // exact mode (uses anchor-confirmed versions when available)
      const exDebunVers = [...exSet].filter(l => l.startsWith(`${libName}@`)).flatMap(l => l.split('@').slice(1));
      if (exDebunVers.length > 0) {
        const exTrue = versions.filter(v => exDebunVers.includes(v)).length;
        if (exTrue > 0) {
          if (exDebunVers.length === 1) { ex.tp++; bump(exPerLib, libName, 'tp'); }
          else { ex.fn++; bump(exPerLib, libName, 'fn'); }
        } else {
          if (exDebunVers.length === 1) { ex.fp++; ex.fn++; bump(exPerLib, libName, 'fp'); bump(exPerLib, libName, 'fn'); }
          else { ex.fn++; bump(exPerLib, libName, 'fn'); }
        }
      } else {
        ex.fn++; bump(exPerLib, libName, 'fn');
      }

      // inclusion mode (always uses strictVersions multi-range)
      const incDebunVers = [...incSet].filter(l => l.startsWith(`${libName}@`)).flatMap(l => l.split('@').slice(1));
      if (incDebunVers.length > 0) {
        const incTrue = versions.filter(v => incDebunVers.includes(v)).length;
        if (incTrue > 0) { rg.tp++; bump(rgPerLib, libName, 'tp'); }
        else if (incDebunVers.length === 1) { rg.fp++; rg.fn++; bump(rgPerLib, libName, 'fp'); bump(rgPerLib, libName, 'fn'); }
        else { rg.fp++; rg.fn++; bump(rgPerLib, libName, 'fp'); bump(rgPerLib, libName, 'fn'); }
      } else {
        rg.fn++; bump(rgPerLib, libName, 'fn');
      }
    }
  }

  // ── lib-level metric (per site, per GT lib) ──
  // GT lib in scope iff CDN has any version of canonical(lib).
  for (const gtLib of gtLibsThisSite) {
    if (!inScope(gtLib)) { outOfScopeLibs++; continue; }
    totalLibEntries++;
    const detected = [...incSet].some((d) => d.split('@')[0] === gtLib);
    if (detected) { lib.tp++; bump(libPerLib, gtLib, 'tp'); }
    else { lib.fn++; bump(libPerLib, gtLib, 'fn'); }
  }
  // lib-level FP (per (site, detLib) dedup): det lib not present in any GT lib
  const fpLibsThisSite = new Set<string>();
  for (const det of incSet) {
    const detLib = det.split('@')[0];
    if ([...truthSet].some((t) => t.startsWith(detLib))) continue;
    fpLibsThisSite.add(detLib);
  }
  for (const detLib of fpLibsThisSite) {
    lib.fp++; bump(libPerLib, detLib, 'fp');
  }

  // ── inclusion FP: per (site, det lib) dedup — matches rq2's per-emit rule
  // (in our pipeline each (site, lib) collapses to one summary row = one emit). ──
  for (const detLib of fpLibsThisSite) {
    rg.fp++; bump(rgPerLib, detLib, 'fp');
  }
}

function score(c: Counts) {
  const p = c.tp + c.fp === 0 ? 0 : c.tp / (c.tp + c.fp);
  const r = c.tp + c.fn === 0 ? 0 : c.tp / (c.tp + c.fn);
  const f1 = p + r === 0 ? 0 : (2 * p * r) / (p + r);
  return { p, r, f1 };
}

console.log(`# ${dir} — version metrics (rq2-style)`);
console.log(`(scope: CDN-only — npm-only versions/libs excluded)`);
console.log(`(GT lib-version entries scored: ${totalVersions}; out-of-scope versions dropped: ${outOfScopeVersions})`);
console.log(`(GT lib entries scored: ${totalLibEntries}; out-of-scope libs dropped: ${outOfScopeLibs})`);

console.log('\n## overall');
console.log();
const sEx = score(ex);
const sRg = score(rg);
const sLib = score(lib);
console.log('| metric | lib | exact | inclusion |');
console.log('|---|---:|---:|---:|');
console.log(`| precision | ${sLib.p.toFixed(4)} | ${sEx.p.toFixed(4)} | ${sRg.p.toFixed(4)} |`);
console.log(`| recall    | ${sLib.r.toFixed(4)} | ${sEx.r.toFixed(4)} | ${sRg.r.toFixed(4)} |`);
console.log(`| f1        | ${sLib.f1.toFixed(4)} | ${sEx.f1.toFixed(4)} | ${sRg.f1.toFixed(4)} |`);
console.log(`| TP/FP/FN  | ${lib.tp}/${lib.fp}/${lib.fn} | ${ex.tp}/${ex.fp}/${ex.fn} | ${rg.tp}/${rg.fp}/${rg.fn} |`);

if (showPerLib) {
  console.log('\n## per-lib (lib — site×lib unique)');
  console.log();
  console.log('| lib | P | R | F1 | TP | FP | FN |');
  console.log('|---|---:|---:|---:|---:|---:|---:|');
  const libRows = Object.entries(libPerLib)
    .filter(([, c]) => c.tp + c.fp + c.fn > 0)
    .sort((a, b) => (b[1].tp + b[1].fn) - (a[1].tp + a[1].fn));
  for (const [libN, c] of libRows) {
    const s = score(c);
    console.log(`| ${libN} | ${s.p.toFixed(3)} | ${s.r.toFixed(3)} | ${s.f1.toFixed(3)} | ${c.tp} | ${c.fp} | ${c.fn} |`);
  }

  console.log('\n## per-lib (inclusion)');
  console.log();
  console.log('| lib | P | R | F1 | TP | FP | FN |');
  console.log('|---|---:|---:|---:|---:|---:|---:|');
  const rows = Object.entries(rgPerLib)
    .filter(([, c]) => c.tp + c.fp + c.fn > 0)
    .sort((a, b) => (b[1].tp + b[1].fp + b[1].fn) - (a[1].tp + a[1].fp + a[1].fn));
  for (const [lib, c] of rows) {
    const s = score(c);
    console.log(`| ${lib} | ${s.p.toFixed(3)} | ${s.r.toFixed(3)} | ${s.f1.toFixed(3)} | ${c.tp} | ${c.fp} | ${c.fn} |`);
  }

  console.log('\n## per-lib (exact)');
  console.log();
  console.log('| lib | P | R | F1 | TP | FP | FN |');
  console.log('|---|---:|---:|---:|---:|---:|---:|');
  const rows2 = Object.entries(exPerLib)
    .filter(([, c]) => c.tp + c.fp + c.fn > 0)
    .sort((a, b) => (b[1].tp + b[1].fp + b[1].fn) - (a[1].tp + a[1].fp + a[1].fn));
  for (const [lib, c] of rows2) {
    const s = score(c);
    console.log(`| ${lib} | ${s.p.toFixed(3)} | ${s.r.toFixed(3)} | ${s.f1.toFixed(3)} | ${c.tp} | ${c.fp} | ${c.fn} |`);
  }
}
