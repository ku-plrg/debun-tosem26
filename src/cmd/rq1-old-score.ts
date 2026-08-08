/**
 * rq1-old-score.ts
 *
 * Re-run the OLD DEBUN scoring methodology on the CURRENT cdn-* hash cache and
 * CURRENT allWebHashes/* — i.e., POG generator is the current version, but
 * matching uses the legacy per-hash-count formula. Aggregation is at the
 * BASE-LIB level (e.g. "jquery", not "jquery____slim"):
 *
 *   hashCnt[base][verStr] = #distinct hashes mapping to any submodule of `base`
 *                            at version `verStr`
 *   matches[base][verStr] = #distinct (per-site) hashes hitting `base@verStr`
 *                            (a hash counts ONCE even if it hits multiple
 *                             submodules of the same base lib)
 *   denom = hashCnt - intraDupSuppressed
 *   detect lib if any version has matches >= MIN_FN_COUNT AND
 *               matches/denom > THRESHOLD
 *
 * Inter-base-lib dups are computed in-memory (DUP_THRESHOLD=0.3, birth-date
 * arbitration). The "loser" base lib's matching versions are suppressed when
 * the hash also hits the "winner" base lib.
 *
 * Env:
 *   THRESHOLD       percentage threshold (default 0.19)
 *   MIN_FN_COUNT    minimum match count per (base, verStr) (default 5)
 *   DUP_THRESHOLD   inter-base-lib pair dup threshold (default 0.3)
 *   FP_CACHE_DIR    cache dir (default data/fingerprint-cache)
 *   OUT_DIR         optional dir to dump TP (site, lib) tsv
 */
import fs from 'fs';
import path from 'path';
import * as Papa from 'papaparse';
import { MODEL_SUFFIX, parseModel } from '../fingerprint-collector/pog-models';

export interface OldScoreResult {
  lib: { tp: number; fp: number; fn: number; tn: number };
  version: { tp: number; M: number; m: number; p: number; wM: number[]; wMm: number[]; wMmp: number[] };
  /** #correctly-detected (TP) instances per canonical library name */
  perLibTP: Record<string, number>;
  /** #ground-truth instances per canonical library name */
  ground: Record<string, number>;
  threshold: number;
}

/**
 * Runs the legacy uniform (per-hash-count) scorer — DEBUN's `score_u` — over the
 * current cdn hash cache and allWebHashes. Threshold via the THRESHOLD env var
 * (default 0.19; the paper's best-F1 operating point for score_u is 0.15).
 */
export function runOldScore(): OldScoreResult {
  const root = process.cwd();
const cacheDir = process.env['FP_CACHE_DIR'] ?? 'src/data/fingerprint-cache';
const cacheAbs = path.isAbsolute(cacheDir) ? cacheDir : path.join(root, cacheDir);
const libsPath = path.join(cacheAbs, 'cdn-alllibs.json');
const hashPath = path.join(cacheAbs, 'cdn-allhash.json');
const blPath = path.join(cacheAbs, 'web-blacklist-0.6.json');
const birthPath = path.join(root, 'src/data/birth_sanitized.json');
const gtPath = path.join(root, 'src/ground/ground-truth.csv');
const webHashDir = path.join(root, 'src/data/allWebHashes');

const THRESHOLD = parseFloat(process.env['THRESHOLD'] ?? '0.19');
const MIN_FN_COUNT = parseInt(process.env['MIN_FN_COUNT'] ?? '5', 10);
const DUP_THRESHOLD = parseFloat(process.env['DUP_THRESHOLD'] ?? '0.3');

const ALIAS: Record<string, string> = {
  'react-dom': 'react',
  'angularjs': 'angular.js',
  'backbone': 'backbone.js',
  'handlebars': 'handlebars.js',
  'hammerjs': 'hammer.js',
  'ifvisible.js': 'ifvisible',
  'jquery-ui': 'jqueryui',
  'jquery.ui': 'jqueryui',
  'lodash': 'lodash.js',
  'moment': 'moment.js',
  'requirejs': 'require.js',
  'underscore': 'underscore.js',
};
const canon = (s: string): string => ALIAS[s] ?? s;

console.error('[load] libs/hash/blacklist/birth …');
type LibInfo = { id: number; versions: string[]; hashCnt: number[] };
const libInfos = JSON.parse(fs.readFileSync(libsPath, 'utf8')) as Record<string, LibInfo>;
const libHashes = JSON.parse(fs.readFileSync(hashPath, 'utf8')) as Record<string, Record<string, Record<string, [number, number][]>>>;
const blacklist = JSON.parse(fs.readFileSync(blPath, 'utf8')) as Record<string, string[]>;
const birth = JSON.parse(fs.readFileSync(birthPath, 'utf8')) as Record<string, Record<string, string>>;

const blacklistSet: Record<string, Set<string>> = {};
for (const [n, hs] of Object.entries(blacklist)) blacklistSet[n] = new Set(hs);

// libId → { base lib name (lowercase), versions[] }
const libIdToBase = new Map<number, { base: string; versions: string[] }>();
for (const [name, info] of Object.entries(libInfos)) {
  libIdToBase.set(info.id, { base: name.split('____')[0].toLowerCase(), versions: info.versions });
}

// ── base-lib hashCnt: distinct hashes per (base, verStr) ──
console.error('[base] computing base-lib hashCnt by inversion …');
const baseHashCnt = new Map<string, Map<string, number>>();
for (const hashMatches of Object.values(libHashes)) {
  for (const matches of Object.values(hashMatches)) {
    const baseVers = new Map<string, Set<string>>();
    for (const [libIdStr, ranges] of Object.entries(matches)) {
      const info = libIdToBase.get(+libIdStr);
      if (!info) continue;
      let s = baseVers.get(info.base);
      if (!s) { s = new Set(); baseVers.set(info.base, s); }
      for (const [start, end] of ranges) {
        for (let v = start; v <= end; v++) s.add(info.versions[v]);
      }
    }
    for (const [base, verStrs] of baseVers) {
      let m = baseHashCnt.get(base);
      if (!m) { m = new Map(); baseHashCnt.set(base, m); }
      for (const v of verStrs) m.set(v, (m.get(v) ?? 0) + 1);
    }
  }
}
console.error(`[base] ${baseHashCnt.size} base libs, total (base,ver) entries: ${[...baseHashCnt.values()].reduce((a, m) => a + m.size, 0)}`);

// ── inter-base-lib dup co-occurrence (DUP_THRESHOLD=0.3) ──
console.error('[dup] counting (b1,v1,b2,v2) co-occurrences at base level …');
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

const dupMap = new Map<string, number>();
for (const hashMatches of Object.values(libHashes)) {
  for (const matches of Object.values(hashMatches)) {
    const baseMap = new Map<string, Set<string>>();
    for (const [libIdStr, ranges] of Object.entries(matches)) {
      const info = libIdToBase.get(+libIdStr);
      if (!info) continue;
      let s = baseMap.get(info.base);
      if (!s) { s = new Set(); baseMap.set(info.base, s); }
      for (const [start, end] of ranges) {
        for (let v = start; v <= end; v++) s.add(info.versions[v]);
      }
    }
    if (baseMap.size < 2 || baseMap.size > 7) continue;
    const bases = [...baseMap.keys()].sort();
    for (let i = 0; i < bases.length - 1; i++) {
      const b1 = bases[i];
      const v1s = baseMap.get(b1)!;
      for (let j = i + 1; j < bases.length; j++) {
        const b2 = bases[j];
        const v2s = baseMap.get(b2)!;
        for (const v1 of v1s) {
          const bb1 = getBirth(b1, v1);
          for (const v2 of v2s) {
            const bb2 = getBirth(b2, v2);
            if (!bb1 && !bb2) continue;
            const key = `${b1}|${v1}|${b2}|${v2}`;
            dupMap.set(key, (dupMap.get(key) ?? 0) + 1);
          }
        }
      }
    }
  }
}
console.error(`[dup] ${dupMap.size} (b1,v1,b2,v2) entries`);

const candidates: string[] = [];
for (const [key, cnt] of dupMap) {
  const [b1, v1, b2, v2] = key.split('|');
  const c1 = baseHashCnt.get(b1)?.get(v1);
  const c2 = baseHashCnt.get(b2)?.get(v2);
  if (!c1 || !c2) continue;
  if (cnt / c1 > DUP_THRESHOLD || cnt / c2 > DUP_THRESHOLD) candidates.push(key);
}
dupMap.clear();
console.error(`[dup] ${candidates.length} candidates above DUP_T=${DUP_THRESHOLD}`);

const pairs = new Map<string, { b1: string; b2: string; v1s: Set<string>; v2s: Set<string> }>();
for (const key of candidates) {
  const [b1, v1, b2, v2] = key.split('|');
  const pk = `${b1}|${b2}`;
  let p = pairs.get(pk);
  if (!p) { p = { b1, b2, v1s: new Set(), v2s: new Set() }; pairs.set(pk, p); }
  p.v1s.add(v1);
  p.v2s.add(v2);
}

function oldestBaseDate(b: string, vs: Set<string>): Date {
  let oldest = new Date();
  for (const v of vs) {
    const bb = getBirth(b, v);
    if (bb && bb < oldest) oldest = bb;
  }
  return oldest;
}

const winnerMap = new Map<string, Set<string>>(); // winner base → set of loser bases
for (const { b1, b2, v1s, v2s } of pairs.values()) {
  const o1 = oldestBaseDate(b1, v1s);
  const o2 = oldestBaseDate(b2, v2s);
  const [winner, loser] = o1 < o2 ? [b1, b2] : [b2, b1];
  let s = winnerMap.get(winner);
  if (!s) { s = new Set(); winnerMap.set(winner, s); }
  s.add(loser);
}
const winnerCnt = [...winnerMap.values()].reduce((a, s) => a + s.size, 0);
console.error(`[dup] winner-loser base pairs: ${winnerCnt}`);

// intraDupHashesBase[nodes][hash] = Map<loserBase, Set<verStr>>
// intraDupLibsBase[loserBase][verStr] = #suppressed hashes
console.error('[dup] building intra-dup tables …');
const intraDupHashesBase: Record<string, Record<string, Map<string, Set<string>>>> = {};
const intraDupLibsBaseSet = new Map<string, Map<string, Set<string>>>();
for (const [nodes, hashMatches] of Object.entries(libHashes)) {
  for (const [hash, matches] of Object.entries(hashMatches)) {
    const baseMap = new Map<string, Set<string>>();
    for (const [libIdStr, ranges] of Object.entries(matches)) {
      const info = libIdToBase.get(+libIdStr);
      if (!info) continue;
      let s = baseMap.get(info.base);
      if (!s) { s = new Set(); baseMap.set(info.base, s); }
      for (const [start, end] of ranges) {
        for (let v = start; v <= end; v++) s.add(info.versions[v]);
      }
    }
    if (baseMap.size < 2 || baseMap.size > 7) continue;
    const bases = [...baseMap.keys()];
    for (let i = 0; i < bases.length - 1; i++) {
      const b1 = bases[i];
      for (let j = i + 1; j < bases.length; j++) {
        const b2 = bases[j];
        let loser: string;
        let loserVs: Set<string>;
        if (winnerMap.get(b1)?.has(b2)) { loser = b2; loserVs = baseMap.get(b2)!; }
        else if (winnerMap.get(b2)?.has(b1)) { loser = b1; loserVs = baseMap.get(b1)!; }
        else continue;
        if (!intraDupHashesBase[nodes]) intraDupHashesBase[nodes] = {};
        if (!intraDupHashesBase[nodes][hash]) intraDupHashesBase[nodes][hash] = new Map();
        intraDupHashesBase[nodes][hash].set(loser, loserVs);
        let perLib = intraDupLibsBaseSet.get(loser);
        if (!perLib) { perLib = new Map(); intraDupLibsBaseSet.set(loser, perLib); }
        for (const v of loserVs) {
          let hs = perLib.get(v);
          if (!hs) { hs = new Set(); perLib.set(v, hs); }
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

// ── per-site scoring at base level ──
function scoreSite(siteHashes: Record<string, string[]>): Map<string, Set<string>> {
  // base → verStr → counts
  const matches = new Map<string, Map<string, number>>();
  const t2Count = new Map<string, Map<string, number>>();
  const t3Count = new Map<string, Map<string, number>>();
  const inc = (m: Map<string, Map<string, number>>, base: string, v: string) => {
    let mb = m.get(base);
    if (!mb) { mb = new Map(); m.set(base, mb); }
    mb.set(v, (mb.get(v) ?? 0) + 1);
  };
  for (const [nodes, hashes] of Object.entries(siteHashes)) {
    const blN = blacklistSet[nodes];
    const lhN = libHashes[nodes];
    if (!lhN) continue;
    const dupN = intraDupHashesBase[nodes];
    for (const hash of hashes) {
      if (blN?.has(hash)) continue;
      const m = lhN[hash];
      if (!m) continue;
      const baseVers = new Map<string, Set<string>>();
      for (const [libIdStr, ranges] of Object.entries(m)) {
        const info = libIdToBase.get(+libIdStr);
        if (!info) continue;
        let s = baseVers.get(info.base);
        if (!s) { s = new Set(); baseVers.set(info.base, s); }
        for (const [start, end] of ranges) {
          for (let v = start; v <= end; v++) s.add(info.versions[v]);
        }
      }
      // type at base level: 3=one base & one version, 2=one base & ≥2 versions, 1=multi base
      let matchType: 1 | 2 | 3 = 1;
      if (baseVers.size === 1) {
        const onlyVers = baseVers.values().next().value as Set<string>;
        matchType = onlyVers.size === 1 ? 3 : 2;
      }
      const dupH = dupN?.[hash];
      for (const [base, verStrs] of baseVers) {
        const dupVers = dupH?.get(base);
        for (const v of verStrs) {
          if (dupVers?.has(v)) continue;
          inc(matches, base, v);
          if (matchType === 2) inc(t2Count, base, v);
          else if (matchType === 3) inc(t3Count, base, v);
        }
      }
    }
  }
  // base → set of detected versions (type3 || type2 || topPct, mirrors old logic)
  const detected = new Map<string, Set<string>>();
  for (const [base, vMap] of matches) {
    const hashCntMap = baseHashCnt.get(base);
    if (!hashCntMap) continue;
    const dupAdj = intraDupLibsBase.get(base);
    let topPct = -1;
    const topVers = new Set<string>();
    const type3Vers = new Set<string>();
    let topT2 = 0;
    let type2Vers = new Set<string>();
    for (const [v, score] of vMap) {
      if (score < MIN_FN_COUNT) continue;
      const denom = (hashCntMap.get(v) ?? 0) - (dupAdj?.get(v) ?? 0);
      if (denom <= 0) continue;
      const pct = score / denom;
      if (pct <= THRESHOLD) continue;
      // top percentage tie set
      if (pct > topPct) { topPct = pct; topVers.clear(); topVers.add(v); }
      else if (pct === topPct) topVers.add(v);
      // type 3 (any version with at least one type-3 hash)
      if ((t3Count.get(base)?.get(v) ?? 0) > 0) type3Vers.add(v);
      // type 2 (only versions where type2-count > 3, tied at max)
      const t2 = t2Count.get(base)?.get(v) ?? 0;
      if (t2 > 3) {
        if (t2 > topT2) { topT2 = t2; type2Vers = new Set([v]); }
        else if (t2 === topT2) type2Vers.add(v);
      }
    }
    if (topVers.size === 0) continue;
    const finalSet = type3Vers.size > 0 ? type3Vers : type2Vers.size > 0 ? type2Vers : topVers;
    detected.set(canon(base), finalSet);
  }
  return detected;
}

// ── ground truth + universe ──
const universe = new Set<string>([...baseHashCnt.keys()].map(canon));

// Per-model website-hash suffix ('' = full). Site set is enumerated from the
// base (unsuffixed) files, excluding every model-variant file.
const WEB_SUFFIX = MODEL_SUFFIX[parseModel(process.env['MODEL'])];
const evalSites = new Set(
  fs.readdirSync(webHashDir)
    .filter((f) => f.endsWith('.json') && !/-(cnt|cfg|f|fb|fbc)\.json$/.test(f))
    .map((f) => f.replace(/\.json$/, '')),
);

const gt = new Map<string, Map<string, string>>(); // site → lib → ver
const gtRaw = fs.readFileSync(gtPath, 'utf8');
const gtParsed = Papa.parse<Record<string, string>>(gtRaw, { header: true, skipEmptyLines: true });
for (const r of gtParsed.data) {
  const site = (r['url'] ?? '').trim();
  if (!evalSites.has(site)) continue;
  const m = new Map<string, string>();
  for (const tok of (r['ground truth'] ?? '').split(',').map((s) => s.trim()).filter(Boolean)) {
    const at = tok.indexOf('@');
    const lib = canon((at < 0 ? tok : tok.slice(0, at)).trim().toLowerCase());
    const ver = at < 0 ? '' : tok.slice(at + 1).trim();
    if (lib) m.set(lib, ver);
  }
  gt.set(site, m);
}

const verParts = (v: string): [number | null, number | null, number | null] => {
  const p = v.split('.').map((x) => parseInt(x));
  return [p[0] ?? null, p[1] ?? null, p[2] ?? null];
};

console.error(`[score] ${evalSites.size} sites, T=${THRESHOLD}, MFC=${MIN_FN_COUNT}, DUP_T=${DUP_THRESHOLD}`);
let tp = 0, fp = 0, fn = 0, tn = 0;
const tpSet = new Set<string>();
const fpSet = new Set<string>();
const verRows: string[] = []; // per-detection: site\tlib\tgtVer\tdetVers (semicolon-separated)
const ver = { tp: 0, M: 0, m: 0, p: 0, wM: [] as number[], wMm: [] as number[], wMmp: [] as number[] };
for (const site of evalSites) {
  const gts = gt.get(site);
  if (!gts || gts.size === 0) continue;
  const sitePath = path.join(webHashDir, `${site}${WEB_SUFFIX}.json`);
  if (!fs.existsSync(sitePath)) continue;
  const siteHashes = JSON.parse(fs.readFileSync(sitePath, 'utf8')) as Record<string, string[]>;
  const detected = scoreSite(siteHashes);
  for (const lib of universe) {
    const inGt = gts.has(lib);
    const inDet = detected.has(lib);
    if (inGt && inDet) { tp++; tpSet.add(`${site}\t${lib}`); }
    else if (!inGt && inDet) { fp++; fpSet.add(`${site}\t${lib}`); }
    else if (inGt && !inDet) fn++;
    else tn++;
  }
  // version-level (only counts (site, lib) where GT has known version AND detector emits)
  for (const [lib, gtVer] of gts) {
    if (!gtVer) continue;
    const detVers = detected.get(lib);
    if (!detVers || detVers.size === 0) continue;
    ver.tp++;
    const [gM, gmL, gp] = verParts(gtVer);
    const majors = new Set<number | null>();
    const minors = new Set<string>();
    const patches = new Set<string>();
    let mF = false, miF = false, paF = false;
    for (const v of detVers) {
      const [a, b, c] = verParts(v);
      majors.add(a);
      minors.add(`${a}.${b}`);
      patches.add(v);
      if (a === gM) mF = true;
      if (a === gM && b === gmL) miF = true;
      if (a === gM && b === gmL && c === gp) paF = true;
    }
    if (mF) ver.M++;
    if (miF) ver.m++;
    if (paF) ver.p++;
    ver.wM.push(majors.size);
    ver.wMm.push(minors.size);
    ver.wMmp.push(patches.size);
    verRows.push(`${site}\t${lib}\t${gtVer}\t${[...detVers].join(';')}`);
  }
}

  const perLibTP: Record<string, number> = {};
  for (const key of tpSet) {
    const lib = key.split('\t')[1];
    perLibTP[lib] = (perLibTP[lib] ?? 0) + 1;
  }
  const ground: Record<string, number> = {};
  for (const gts of gt.values()) {
    for (const lib of gts.keys()) ground[lib] = (ground[lib] ?? 0) + 1;
  }

  const outDir = process.env['OUT_DIR'];
  if (outDir) {
    fs.mkdirSync(outDir, { recursive: true });
    fs.writeFileSync(path.join(outDir, `tp-old-t${THRESHOLD}.tsv`), [...tpSet].sort().join('\n'));
    fs.writeFileSync(path.join(outDir, `fp-old-t${THRESHOLD}.tsv`), [...fpSet].sort().join('\n'));
    fs.writeFileSync(path.join(outDir, `ver-old-t${THRESHOLD}.tsv`), verRows.sort().join('\n'));
    console.log(`[wrote] ${outDir}/tp-old-t${THRESHOLD}.tsv, fp-…, ver-…`);
  }

  return {
    lib: { tp, fp, fn, tn },
    version: ver,
    perLibTP,
    ground,
    threshold: THRESHOLD,
  };
}

if (require.main === module) {
  const r = runOldScore();
  const m = r.lib;
  const P = m.tp + m.fp ? m.tp / (m.tp + m.fp) : 0;
  const R = m.tp + m.fn ? m.tp / (m.tp + m.fn) : 0;
  const F = P + R ? (2 * P * R) / (P + R) : 0;
  const avg = (xs: number[]) => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : 0);
  console.log(`\n=== OLD-DEBUN (score_u, base-lib aggregation, T=${r.threshold}) ===`);
  console.log(`P=${P.toFixed(4)} R=${R.toFixed(4)} F1=${F.toFixed(4)} TP=${m.tp} FP=${m.fp} FN=${m.fn} TN=${m.tn}`);
  const v = r.version;
  console.log(`\n=== OLD-DEBUN version-level (subset: TP rows with gtVersion known) ===`);
  console.log(`tp-with-ver=${v.tp}  Major=${v.M} (${avg(v.wM).toFixed(2)})  Minor=${v.m} (${avg(v.wMm).toFixed(2)})  Patch=${v.p} (${avg(v.wMmp).toFixed(2)})`);
}
