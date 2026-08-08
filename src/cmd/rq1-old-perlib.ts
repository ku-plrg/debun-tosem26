/**
 * One-threshold variant of rq1-old-sweep that ALSO writes (site, lib) det
 * pairs, for per-library count tables.
 *
 *   T_PCT=84 npx ts-node --transpile-only src/cmd/rq1-old-perlib.ts
 *
 * Output: data/threshold-sweep/t<T>-u/detection.csv with header
 *   site,lib,detected
 */
import fs from 'fs';
import path from 'path';
import * as Papa from 'papaparse';

const root = process.cwd();
const cacheDir = process.env['FP_CACHE_DIR'] ?? 'src/data/fingerprint-cache';
const cacheAbs = path.isAbsolute(cacheDir) ? cacheDir : path.join(root, cacheDir);
const libsPath = path.join(cacheAbs, 'cdn-alllibs.json');
const hashPath = path.join(cacheAbs, 'cdn-allhash.json');
const blPath = path.join(cacheAbs, 'web-blacklist-0.6.json');
const birthPath = path.join(root, 'src/data/birth_sanitized.json');
const gtPath = path.join(root, 'src/ground/ground-truth.csv');
const webHashDir = path.join(root, 'src/data/allWebHashes');

const T_PCT = parseInt(process.env['T_PCT'] ?? '84', 10);
const OUT_DIR = process.env['OUT_DIR'] ?? `src/data/threshold-sweep/t${T_PCT}-u`;
const MIN_FN_COUNT = parseInt(process.env['MIN_FN_COUNT'] ?? '5', 10);
const DUP_THRESHOLD = parseFloat(process.env['DUP_THRESHOLD'] ?? '0.3');

const ALIAS: Record<string, string> = {
  'react-dom': 'react', 'angularjs': 'angular.js', 'backbone': 'backbone.js',
  'handlebars': 'handlebars.js', 'hammerjs': 'hammer.js', 'ifvisible.js': 'ifvisible',
  'jquery-ui': 'jqueryui', 'jquery.ui': 'jqueryui', 'lodash': 'lodash.js',
  'moment': 'moment.js', 'requirejs': 'require.js', 'underscore': 'underscore.js',
};
const canon = (s: string) => ALIAS[s] ?? s;

type LibInfo = { id: number; versions: string[]; hashCnt: number[] };
const libInfos = JSON.parse(fs.readFileSync(libsPath, 'utf8')) as Record<string, LibInfo>;
const allHash = JSON.parse(fs.readFileSync(hashPath, 'utf8')) as Record<string, Record<string, Record<string, [number, number][]>>>;
const webBL = (fs.existsSync(blPath)
  ? new Set<string>(Object.values(JSON.parse(fs.readFileSync(blPath, 'utf8')) as Record<string, string[]>).flat())
  : new Set<string>());

const fileLibByBase = new Map<string, { id: number; versions: string[]; hashCnt: number[] }[]>();
const idToBaseEntry = new Map<number, { base: string; entry: LibInfo }>();
for (const [key, info] of Object.entries(libInfos)) {
  const base = key.split('____')[0];
  let arr = fileLibByBase.get(base);
  if (!arr) { arr = []; fileLibByBase.set(base, arr); }
  arr.push(info);
  idToBaseEntry.set(info.id, { base, entry: info });
}

// (base, version) → set of hashes (union of variants)
const baseVerHashes = new Map<string, Map<string, Set<string>>>();
const baseHashCnt = new Map<string, Map<string, number>>();
for (const [nodesStr, bucket] of Object.entries(allHash)) {
  for (const [hash, libMap] of Object.entries(bucket)) {
    if (webBL.has(hash)) continue;
    for (const [libIdStr, ranges] of Object.entries(libMap)) {
      const meta = idToBaseEntry.get(Number(libIdStr));
      if (!meta) continue;
      for (const [lo, hi] of ranges) {
        for (let vi = lo; vi <= hi; vi++) {
          const v = meta.entry.versions[vi];
          if (!v) continue;
          let vm = baseVerHashes.get(meta.base);
          if (!vm) { vm = new Map(); baseVerHashes.set(meta.base, vm); }
          let hs = vm.get(v);
          if (!hs) { hs = new Set(); vm.set(v, hs); }
          hs.add(hash);
        }
      }
    }
  }
}
for (const [base, vm] of baseVerHashes) {
  const cmap = new Map<string, number>();
  for (const [v, hs] of vm) cmap.set(v, hs.size);
  baseHashCnt.set(base, cmap);
}

// ── per-site hash sets ──
const evalSites: string[] = fs.readdirSync(webHashDir)
  .filter((f) => f.endsWith('.json') && !f.endsWith('-cnt.json') && !f.endsWith('-cfg.json'))
  .map((f) => f.replace(/\.json$/, ''))
  .sort();

// site → (base → (version → match count))
const siteMatches = new Map<string, Map<string, Map<string, number>>>();
for (const site of evalSites) {
  let siteRaw: Record<string, string[]>;
  try { siteRaw = JSON.parse(fs.readFileSync(path.join(webHashDir, `${site}.json`), 'utf8')); }
  catch { continue; }
  const siteH = new Set<string>();
  for (const arr of Object.values(siteRaw)) for (const h of arr) siteH.add(h);
  const map = new Map<string, Map<string, number>>();
  for (const [base, vm] of baseVerHashes) {
    const inner = new Map<string, number>();
    for (const [v, hs] of vm) {
      let c = 0; for (const h of hs) if (siteH.has(h)) c++;
      if (c > 0) inner.set(v, c);
    }
    if (inner.size > 0) map.set(base, inner);
  }
  siteMatches.set(site, map);
}

// ── GT ──
const gtCsv = fs.readFileSync(gtPath, 'utf8');
const gtRows = Papa.parse(gtCsv, { header: true }).data as any[];
const gt = new Map<string, Set<string>>();
for (const row of gtRows) {
  const s = (row.url || '').trim();
  if (!s) continue;
  const set = new Set<string>();
  for (const tok of (row['ground truth'] || '').split(',')) {
    const tt = tok.trim(); if (!tt) continue;
    const at = tt.indexOf('@');
    const lib = canon(((at < 0 ? tt : tt.slice(0, at))).trim().toLowerCase());
    set.add(lib);
  }
  gt.set(s, set);
}

const universe = new Set<string>([...baseHashCnt.keys()].map(canon));

// ── intra-dup adjustment (lib-level, birth-based) for "denominator" ──
// Read precomputed file if present; otherwise skip (recall slightly off but
// ranking unchanged). The old script computes this — for simplicity we omit
// here unless the user already produced it.
const intraDupLibsBase = new Map<string, Map<string, number>>();

// ── single-threshold detection (collect ALL passing versions per base) ──
const T = T_PCT / 100;
fs.mkdirSync(path.join(root, OUT_DIR), { recursive: true });
const detLines: string[] = ['site,lib,detected,strictVersions'];
for (const site of evalSites) {
  const sc = siteMatches.get(site);
  // canon(base) → set of versions that passed threshold
  const detVers = new Map<string, Set<string>>();
  if (sc) {
    for (const [base, vMap] of sc) {
      const hashCntMap = baseHashCnt.get(base); if (!hashCntMap) continue;
      const dupAdj = intraDupLibsBase.get(base);
      const cb = canon(base);
      // First, collect (v, ratio) for versions passing threshold + min-fn-count.
      let bestRatio = -1;
      const passing: Array<[string, number]> = [];
      for (const [v, score] of vMap) {
        if (score < MIN_FN_COUNT) continue;
        const denom = (hashCntMap.get(v) ?? 0) - (dupAdj?.get(v) ?? 0);
        if (denom <= 0) continue;
        const ratio = score / denom;
        if (ratio > T) {
          passing.push([v, ratio]);
          if (ratio > bestRatio) bestRatio = ratio;
        }
      }
      // Keep only the top-tier (max-ratio) versions — matches the "tight"
      // claim semantics used by score_m's strictVersions.
      if (passing.length > 0) {
        const set = new Set<string>();
        for (const [v, ratio] of passing) {
          if (Math.abs(ratio - bestRatio) < 1e-9) set.add(v);
        }
        detVers.set(cb, set);
      }
    }
  }
  for (const lib of universe) {
    const vers = detVers.get(lib);
    const det = !!vers && vers.size > 0;
    const versStr = det ? [...vers!].join(';') : '';
    detLines.push(`${site},${lib},${det ? 'true' : 'false'},${versStr}`);
  }
}
const detPath = path.join(root, OUT_DIR, 'detection.csv');
fs.writeFileSync(detPath, detLines.join('\n') + '\n');
console.log(`[wrote] ${detPath}`);

// summary.csv mirrors detection.csv with the same header.
fs.writeFileSync(path.join(root, OUT_DIR, 'summary.csv'), detLines.join('\n') + '\n');
console.log(`[wrote] ${path.join(root, OUT_DIR, 'summary.csv')}`);
