/**
 * rq1-old-sweep.ts
 *
 * Sweep OLD-DEBUN scoring across thresholds 0.00 .. 1.00 (step 0.01),
 * computing P/R/F1 per threshold against ground-truth.csv on the eval site
 * set. Pre-computes the (site, base, ver) match counts once and re-uses them
 * across thresholds for speed.
 *
 * Output: data/threshold-sweep/sweep-old.csv
 *           threshold,precision,recall,f1,tp,fp,fn,tn
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

const MIN_FN_COUNT = parseInt(process.env['MIN_FN_COUNT'] ?? '5', 10);
const DUP_THRESHOLD = parseFloat(process.env['DUP_THRESHOLD'] ?? '0.3');
const OUT = process.env['OUT'] ?? 'src/data/threshold-sweep/sweep-old.csv';

const ALIAS: Record<string, string> = {
  'react-dom': 'react', 'angularjs': 'angular.js', 'backbone': 'backbone.js',
  'handlebars': 'handlebars.js', 'hammerjs': 'hammer.js', 'ifvisible.js': 'ifvisible',
  'jquery-ui': 'jqueryui', 'jquery.ui': 'jqueryui', 'lodash': 'lodash.js',
  'moment': 'moment.js', 'requirejs': 'require.js', 'underscore': 'underscore.js',
};
const canon = (s: string) => ALIAS[s] ?? s;

console.error('[load] caches …');
type LibInfo = { id: number; versions: string[]; hashCnt: number[] };
const libInfos = JSON.parse(fs.readFileSync(libsPath, 'utf8')) as Record<string, LibInfo>;
const libHashes = JSON.parse(fs.readFileSync(hashPath, 'utf8')) as Record<string, Record<string, Record<string, [number, number][]>>>;
const blacklist = JSON.parse(fs.readFileSync(blPath, 'utf8')) as Record<string, string[]>;
const birth = JSON.parse(fs.readFileSync(birthPath, 'utf8')) as Record<string, Record<string, string>>;

const blacklistSet: Record<string, Set<string>> = {};
for (const [n, hs] of Object.entries(blacklist)) blacklistSet[n] = new Set(hs);

const libIdToBase = new Map<number, { base: string; versions: string[] }>();
for (const [name, info] of Object.entries(libInfos)) {
  libIdToBase.set(info.id, { base: name.split('____')[0].toLowerCase(), versions: info.versions });
}

console.error('[base] computing base-lib hashCnt …');
const baseHashCnt = new Map<string, Map<string, number>>();
for (const hashMatches of Object.values(libHashes)) {
  for (const matches of Object.values(hashMatches)) {
    const baseVers = new Map<string, Set<string>>();
    for (const [libIdStr, ranges] of Object.entries(matches)) {
      const info = libIdToBase.get(+libIdStr);
      if (!info) continue;
      let s = baseVers.get(info.base); if (!s) { s = new Set(); baseVers.set(info.base, s); }
      for (const [start, end] of ranges) for (let v = start; v <= end; v++) s.add(info.versions[v]);
    }
    for (const [base, verStrs] of baseVers) {
      let m = baseHashCnt.get(base); if (!m) { m = new Map(); baseHashCnt.set(base, m); }
      for (const v of verStrs) m.set(v, (m.get(v) ?? 0) + 1);
    }
  }
}

const birthCache = new Map<string, Date | null>();
function getBirth(base: string, ver: string): Date | undefined {
  const key = `${base}@${ver}`;
  let cached = birthCache.get(key);
  if (cached !== undefined) return cached ?? undefined;
  const raw = birth[base]?.[ver];
  cached = raw ? new Date(raw) : null;
  birthCache.set(key, cached);
  return cached ?? undefined;
}

console.error('[dup] inter-base co-occurrence …');
const dupMap = new Map<string, number>();
for (const hashMatches of Object.values(libHashes)) {
  for (const matches of Object.values(hashMatches)) {
    const baseMap = new Map<string, Set<string>>();
    for (const [libIdStr, ranges] of Object.entries(matches)) {
      const info = libIdToBase.get(+libIdStr);
      if (!info) continue;
      let s = baseMap.get(info.base); if (!s) { s = new Set(); baseMap.set(info.base, s); }
      for (const [start, end] of ranges) for (let v = start; v <= end; v++) s.add(info.versions[v]);
    }
    if (baseMap.size < 2 || baseMap.size > 7) continue;
    const bases = [...baseMap.keys()].sort();
    for (let i = 0; i < bases.length - 1; i++) {
      const v1s = baseMap.get(bases[i])!;
      for (let j = i + 1; j < bases.length; j++) {
        const v2s = baseMap.get(bases[j])!;
        for (const v1 of v1s) {
          const bb1 = getBirth(bases[i], v1);
          for (const v2 of v2s) {
            const bb2 = getBirth(bases[j], v2);
            if (!bb1 && !bb2) continue;
            const key = `${bases[i]}|${v1}|${bases[j]}|${v2}`;
            dupMap.set(key, (dupMap.get(key) ?? 0) + 1);
          }
        }
      }
    }
  }
}

const candidates: string[] = [];
for (const [key, cnt] of dupMap) {
  const [b1, v1, b2, v2] = key.split('|');
  const c1 = baseHashCnt.get(b1)?.get(v1);
  const c2 = baseHashCnt.get(b2)?.get(v2);
  if (!c1 || !c2) continue;
  if (cnt / c1 > DUP_THRESHOLD || cnt / c2 > DUP_THRESHOLD) candidates.push(key);
}
dupMap.clear();

const pairs = new Map<string, { b1: string; b2: string; v1s: Set<string>; v2s: Set<string> }>();
for (const key of candidates) {
  const [b1, v1, b2, v2] = key.split('|');
  const pk = `${b1}|${b2}`;
  let p = pairs.get(pk); if (!p) { p = { b1, b2, v1s: new Set(), v2s: new Set() }; pairs.set(pk, p); }
  p.v1s.add(v1); p.v2s.add(v2);
}

const winnerMap = new Map<string, Set<string>>();
for (const { b1, b2, v1s, v2s } of pairs.values()) {
  const oldestOf = (b: string, vs: Set<string>) => {
    let o = new Date();
    for (const v of vs) { const bb = getBirth(b, v); if (bb && bb < o) o = bb; }
    return o;
  };
  const o1 = oldestOf(b1, v1s); const o2 = oldestOf(b2, v2s);
  const [winner, loser] = o1 < o2 ? [b1, b2] : [b2, b1];
  let s = winnerMap.get(winner); if (!s) { s = new Set(); winnerMap.set(winner, s); }
  s.add(loser);
}

const intraDupHashesBase: Record<string, Record<string, Map<string, Set<string>>>> = {};
const intraDupLibsBaseSet = new Map<string, Map<string, Set<string>>>();
for (const [nodes, hashMatches] of Object.entries(libHashes)) {
  for (const [hash, matches] of Object.entries(hashMatches)) {
    const baseMap = new Map<string, Set<string>>();
    for (const [libIdStr, ranges] of Object.entries(matches)) {
      const info = libIdToBase.get(+libIdStr);
      if (!info) continue;
      let s = baseMap.get(info.base); if (!s) { s = new Set(); baseMap.set(info.base, s); }
      for (const [start, end] of ranges) for (let v = start; v <= end; v++) s.add(info.versions[v]);
    }
    if (baseMap.size < 2 || baseMap.size > 7) continue;
    const bases = [...baseMap.keys()];
    for (let i = 0; i < bases.length - 1; i++) {
      for (let j = i + 1; j < bases.length; j++) {
        const b1 = bases[i], b2 = bases[j];
        let loser: string, loserVs: Set<string>;
        if (winnerMap.get(b1)?.has(b2)) { loser = b2; loserVs = baseMap.get(b2)!; }
        else if (winnerMap.get(b2)?.has(b1)) { loser = b1; loserVs = baseMap.get(b1)!; }
        else continue;
        if (!intraDupHashesBase[nodes]) intraDupHashesBase[nodes] = {};
        if (!intraDupHashesBase[nodes][hash]) intraDupHashesBase[nodes][hash] = new Map();
        intraDupHashesBase[nodes][hash].set(loser, loserVs);
        let perLib = intraDupLibsBaseSet.get(loser); if (!perLib) { perLib = new Map(); intraDupLibsBaseSet.set(loser, perLib); }
        for (const v of loserVs) {
          let hs = perLib.get(v); if (!hs) { hs = new Set(); perLib.set(v, hs); }
          hs.add(hash);
        }
      }
    }
  }
}
const intraDupLibsBase = new Map<string, Map<string, number>>();
for (const [b, vMap] of intraDupLibsBaseSet) {
  const out = new Map<string, number>();
  for (const [v, hs] of vMap) out.set(v, hs.size);
  intraDupLibsBase.set(b, out);
}

// ── per-site precomputed matches (threshold-independent) ──
console.error('[scan] per-site matches …');
const evalSites = new Set(
  fs.readdirSync(webHashDir)
    .filter((f) => f.endsWith('.json') && !f.includes('-cnt') && !f.includes('-cfg'))
    .map((f) => f.replace(/\.json$/, '')),
);

type SiteCache = Map<string, Map<string, number>>; // base → ver → count
const siteMatches = new Map<string, SiteCache>();

for (const site of evalSites) {
  const sitePath = path.join(webHashDir, `${site}.json`);
  if (!fs.existsSync(sitePath)) continue;
  const siteHashes = JSON.parse(fs.readFileSync(sitePath, 'utf8')) as Record<string, string[]>;
  const matches: SiteCache = new Map();
  for (const [nodes, hashes] of Object.entries(siteHashes)) {
    const blN = blacklistSet[nodes];
    const lhN = libHashes[nodes]; if (!lhN) continue;
    const dupN = intraDupHashesBase[nodes];
    for (const hash of hashes) {
      if (blN?.has(hash)) continue;
      const m = lhN[hash]; if (!m) continue;
      const baseVers = new Map<string, Set<string>>();
      for (const [libIdStr, ranges] of Object.entries(m)) {
        const info = libIdToBase.get(+libIdStr);
        if (!info) continue;
        let s = baseVers.get(info.base); if (!s) { s = new Set(); baseVers.set(info.base, s); }
        for (const [start, end] of ranges) for (let v = start; v <= end; v++) s.add(info.versions[v]);
      }
      const dupH = dupN?.[hash];
      for (const [base, verStrs] of baseVers) {
        const dupVers = dupH?.get(base);
        let mb = matches.get(base); if (!mb) { mb = new Map(); matches.set(base, mb); }
        for (const v of verStrs) {
          if (dupVers?.has(v)) continue;
          mb.set(v, (mb.get(v) ?? 0) + 1);
        }
      }
    }
  }
  siteMatches.set(site, matches);
}
console.error(`[scan] ${siteMatches.size} sites cached`);

// ── ground truth ──
const gt = new Map<string, Set<string>>();
const gtRaw = fs.readFileSync(gtPath, 'utf8');
const gtParsed = Papa.parse<Record<string, string>>(gtRaw, { header: true, skipEmptyLines: true });
for (const r of gtParsed.data) {
  const site = (r['url'] ?? '').trim();
  if (!evalSites.has(site)) continue;
  const libs = new Set<string>();
  for (const tok of (r['ground truth'] ?? '').split(',').map((s) => s.trim()).filter(Boolean)) {
    libs.add(canon(tok.split('@')[0].toLowerCase()));
  }
  gt.set(site, libs);
}

const universe = new Set<string>([...baseHashCnt.keys()].map(canon));

// ── sweep ──
const out: string[] = ['threshold,precision,recall,f1,tp,fp,fn,tn'];
console.error('[sweep] T=0..100');
for (let i = 0; i <= 100; i++) {
  const T = i / 100;
  let tp = 0, fp = 0, fn = 0, tn = 0;
  for (const site of evalSites) {
    const gts = gt.get(site); if (!gts || gts.size === 0) continue;
    const sc = siteMatches.get(site); if (!sc) continue;
    const detected = new Set<string>();
    for (const [base, vMap] of sc) {
      const hashCntMap = baseHashCnt.get(base); if (!hashCntMap) continue;
      const dupAdj = intraDupLibsBase.get(base);
      for (const [v, score] of vMap) {
        if (score < MIN_FN_COUNT) continue;
        const denom = (hashCntMap.get(v) ?? 0) - (dupAdj?.get(v) ?? 0);
        if (denom <= 0) continue;
        if (score / denom > T) { detected.add(canon(base)); break; }
      }
    }
    for (const lib of universe) {
      const inGt = gts.has(lib); const inDet = detected.has(lib);
      if (inGt && inDet) tp++;
      else if (!inGt && inDet) fp++;
      else if (inGt && !inDet) fn++;
      else tn++;
    }
  }
  const P = tp + fp ? tp / (tp + fp) : 0;
  const R = tp + fn ? tp / (tp + fn) : 0;
  const F = P + R ? 2 * P * R / (P + R) : 0;
  out.push(`${i},${P.toFixed(6)},${R.toFixed(6)},${F.toFixed(6)},${tp},${fp},${fn},${tn}`);
  if (i % 10 === 0) console.error(`  T=${i}%  P=${P.toFixed(3)} R=${R.toFixed(3)} F1=${F.toFixed(3)}`);
}

const outPath = path.isAbsolute(OUT) ? OUT : path.join(root, OUT);
fs.mkdirSync(path.dirname(outPath), { recursive: true });
fs.writeFileSync(outPath, out.join('\n') + '\n');
console.log(`[wrote] ${outPath}`);
