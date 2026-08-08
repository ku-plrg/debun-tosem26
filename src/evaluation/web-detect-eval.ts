/**
 * web-detect-eval.ts
 *
 * Run the npm-vs-website POG hash detection pipeline across ALL npm libraries
 * × ALL semver-valid versions × ALL sites in allWebHashes, WITHOUT rendering
 * any graphs. Outputs CSVs and metrics JSON for ground-truth comparison.
 *
 * Usage:
 *   npx ts-node --transpile-only src/evaluation/web-detect-eval.ts
 *
 * Env vars:
 *   SITE_FILTER         comma-separated site names (default: all)
 *   NPM_FILTER_LIB      comma-separated lib names (default: all)
 *   MATCH_THRESHOLD     0-100 percent (default: 85)
 *   DETECT_RULE         strict (default) | posterior — see the gate below
 *   MIN_POG_NODES       drop POGs with fewer nodes (default: 0 — LoC≥6 in cache build already filters small fns)
 *   MAX_VERSIONS_PER_LIB  integer, top-N by semver (default: all)
 *   EVAL_DEBUG          set to "1" for per-site per-file logs
 *   DISABLE_DUP_FILTER  set to "1" to skip birth-dup noise removal
 */

import * as fs from 'fs';
import * as path from 'path';
import * as Papa from 'papaparse';

// eslint-disable-next-line @typescript-eslint/no-var-requires
const semverSort: (list: string[], loose?: boolean) => string[] = require('semver/functions/sort');
// eslint-disable-next-line @typescript-eslint/no-var-requires
const semverValid: (v: string) => string | null = require('semver/functions/valid');

const { readFileSync } = fs;
const { join } = path;
import { loadWebBlacklist } from '../fingerprint-collector/web-blacklist';
import { filterAndFindEntries } from '../fingerprint-collector/module-filter';
import { scoreLibForSite, VersionDetection } from '../fingerprint-collector/lib-scoring';
import { DepGraph, FileHashRecord } from '../types/depgraph';
import { MODEL_SUFFIX, parseModel } from '../fingerprint-collector/pog-models';

// ── paths ──────────────────────────────────────────────────────────────────

const rootDir = process.cwd();
const npmDataDir = join(rootDir, 'src/data/npm');
const webHashDir = join(rootDir, 'src/data/allWebHashes');
// Per-model website-hash suffix ('' = full). The fingerprint cache is selected
// separately via FP_CACHE_DIR (see build-db.sh).
const WEB_SUFFIX = MODEL_SUFFIX[parseModel(process.env['MODEL'])];
const groundTruthPath = join(rootDir, 'src/ground/ground-truth.csv');
// An absolute EVAL_OUTPUT_DIR must not be joined onto the repo root — that silently writes
// a `<repo>/Users/...` tree instead of failing, which is how 131 MB of eval output once ended
// up inside the checkout.
const outDirEnv = process.env['EVAL_OUTPUT_DIR'] ?? 'src/data/web-detect-eval';
const outDir = path.isAbsolute(outDirEnv) ? outDirEnv : join(rootDir, outDirEnv);

// ── semver helpers ─────────────────────────────────────────────────────────

const parseVersionString = (version: string) => {
  const [major, minor, patch = '0'] = version.split('.');
  const [patchVersion, patchSuffix = '0'] = patch.split('-');
  return [parseInt(major), parseInt(minor), parseInt(patchVersion), patchSuffix];
};

function isValidSemver(version: string): boolean {
  return !!(semverValid(version) && parseVersionString(version)[3] === '0');
}

// ── CSV helper ─────────────────────────────────────────────────────────────

function csvEscape(s: string | number | boolean): string {
  const str = String(s);
  if (str.includes(',') || str.includes('"') || str.includes('\n')) {
    return '"' + str.replace(/"/g, '""') + '"';
  }
  return str;
}

function csvRow(cols: (string | number | boolean)[]): string {
  return cols.map(csvEscape).join(',');
}

// ── Beta posterior: P(p ≥ c) for p ~ Beta(M+1, N-M+1) ──────────────────────
// Detection score interprets MATCH_THRESHOLD as the consistency c = expected
// per-function match rate when the library is genuinely embedded. Under that
// model and a uniform Beta prior on the true rate p, the posterior tail
// P(p ≥ c | M matched out of N closure hashes) gives a calibrated score that
// auto-deflates small-N noise. Implemented via the regularized incomplete
// beta with Lentz continued-fraction (NR §6.4).

function logGamma(z: number): number {
  const g = 7;
  const coef = [
    0.99999999999980993, 676.5203681218851, -1259.1392167224028,
    771.32342877765313, -176.61502916214059, 12.507343278686905,
    -0.13857109526572012, 9.9843695780195716e-6, 1.5056327351493116e-7,
  ];
  if (z < 0.5) return Math.log(Math.PI / Math.sin(Math.PI * z)) - logGamma(1 - z);
  z -= 1;
  let x = coef[0];
  for (let i = 1; i < g + 2; i++) x += coef[i] / (z + i);
  const t = z + g + 0.5;
  return 0.5 * Math.log(2 * Math.PI) + (z + 0.5) * Math.log(t) - t + Math.log(x);
}

function betacf(a: number, b: number, x: number): number {
  const MAXIT = 200;
  const EPS = 3e-7;
  const FPMIN = 1e-30;
  const qab = a + b;
  const qap = a + 1;
  const qam = a - 1;
  let c = 1;
  let d = 1 - (qab * x) / qap;
  if (Math.abs(d) < FPMIN) d = FPMIN;
  d = 1 / d;
  let h = d;
  for (let m = 1; m <= MAXIT; m++) {
    const m2 = 2 * m;
    let aa = (m * (b - m) * x) / ((qam + m2) * (a + m2));
    d = 1 + aa * d;
    if (Math.abs(d) < FPMIN) d = FPMIN;
    c = 1 + aa / c;
    if (Math.abs(c) < FPMIN) c = FPMIN;
    d = 1 / d;
    h *= d * c;
    aa = -((a + m) * (qab + m) * x) / ((a + m2) * (qap + m2));
    d = 1 + aa * d;
    if (Math.abs(d) < FPMIN) d = FPMIN;
    c = 1 + aa / c;
    if (Math.abs(c) < FPMIN) c = FPMIN;
    d = 1 / d;
    const del = d * c;
    h *= del;
    if (Math.abs(del - 1) < EPS) break;
  }
  return h;
}

function regIncBeta(x: number, a: number, b: number): number {
  if (x <= 0) return 0;
  if (x >= 1) return 1;
  const lbeta = logGamma(a) + logGamma(b) - logGamma(a + b);
  const front = Math.exp(a * Math.log(x) + b * Math.log(1 - x) - lbeta);
  if (x < (a + 1) / (a + b + 2)) {
    return (front * betacf(a, b, x)) / a;
  }
  return 1 - (front * betacf(b, a, 1 - x)) / b;
}

function posteriorTail(M: number, N: number, c: number): number {
  if (N === 0) return 0;
  return 1 - regIncBeta(c, M + 1, N - M + 1);
}

// ── lib name normalization ─────────────────────────────────────────────────

function normalizeLibName(raw: string): string {
  return raw.trim();
}

// ── ground-truth parser ────────────────────────────────────────────────────

interface GtEntry {
  libName: string;
  version?: string;
}

function parseGroundTruth(csvPath: string): Map<string, GtEntry[]> {
  const result = new Map<string, GtEntry[]>();
  let raw: string;
  try {
    raw = fs.readFileSync(csvPath, 'utf-8');
  } catch (e) {
    console.warn('[gt] Could not read ground-truth.csv:', (e as Error).message);
    return result;
  }

  const parsed = Papa.parse<Record<string, string>>(raw, {
    header: true,
    skipEmptyLines: true,
  });

  for (const row of parsed.data) {
    const url = (row['url'] ?? '').trim();
    const gtCell = (row['ground truth'] ?? '').trim();
    if (!url || !gtCell) continue;

    const entries: GtEntry[] = [];
    for (const part of gtCell.split(',')) {
      const token = part.trim();
      if (!token) continue;
      const atIdx = token.indexOf('@');
      if (atIdx === -1) {
        entries.push({ libName: normalizeLibName(token) });
      } else {
        const rawName = token.slice(0, atIdx).trim();
        const ver = token.slice(atIdx + 1).trim();
        entries.push({ libName: normalizeLibName(rawName), version: ver });
      }
    }
    result.set(url, entries);
  }
  return result;
}

// ── site hash loader ───────────────────────────────────────────────────────

function loadSiteHashSet(site: string): Set<string> | null {
  const filePath = join(webHashDir, `${site}${WEB_SUFFIX}.json`);
  if (!fs.existsSync(filePath)) {
    console.warn(`[skip site] ${site} — no hash file at ${filePath}`);
    return null;
  }
  let raw: Record<string, string[]>;
  try {
    raw = JSON.parse(readFileSync(filePath, 'utf-8'));
  } catch (e) {
    console.warn(`[skip site] ${site} — failed to parse hash file: ${(e as Error).message}`);
    return null;
  }
  const hashSet = new Set<string>();
  for (const arr of Object.values(raw)) {
    for (const h of arr) hashSet.add(h);
  }
  return hashSet;
}

// ── metrics helper ─────────────────────────────────────────────────────────

function calcPRF(tp: number, fp: number, fn: number): { precision: number; recall: number; f1: number } {
  const precision = tp + fp === 0 ? 0 : tp / (tp + fp);
  const recall = tp + fn === 0 ? 0 : tp / (tp + fn);
  const f1 = precision + recall === 0 ? 0 : (2 * precision * recall) / (precision + recall);
  return { precision, recall, f1 };
}

function round4(n: number): number {
  return Math.round(n * 10000) / 10000;
}

// ── detection row types ───────────────────────────────────────────────────

interface DetectionRow {
  site: string;
  lib: string;
  version: string;
  totalFiles: number;
  passedFiles: number;
  entryCount: number;
  strictEntryCount: number;
  /** size of the file set reachable from any strict entry through the dep graph */
  strictClosureSize: number;
  strictUnionHashCount: number;
  strictMatchedHashCount: number;
  strictRatio: number;
  /** |⋃ hashes across all npm∩cdn passed files| — full closure, not strict subset */
  closureUnionHashCount: number;
  /** matches against siteHashSet within closure union */
  closureMatchedHashCount: number;
  /** posterior P(p ≥ MATCH_THRESHOLD | closureMatched, closureUnion) under Beta(M+1, N-M+1) */
  posteriorScore: number;
}

// ── main ───────────────────────────────────────────────────────────────────

(async () => {
  // ── parse env ──
  const siteEnv = process.env['SITE_FILTER'];
  const libEnv = process.env['NPM_FILTER_LIB'];
  const thresholdEnv = process.env['MATCH_THRESHOLD'];
  const maxVerEnv = process.env['MAX_VERSIONS_PER_LIB'];
  const debugMode = process.env['EVAL_DEBUG'] === '1';

  const thresholdPercent = thresholdEnv ? parseFloat(thresholdEnv) : 85;
  if (!Number.isFinite(thresholdPercent) || thresholdPercent < 0 || thresholdPercent > 100) {
    console.error(`[Fatal] MATCH_THRESHOLD must be 0-100, got '${thresholdEnv}'`);
    process.exit(1);
  }
  const matchThreshold = thresholdPercent / 100;

  const maxVersions = maxVerEnv ? parseInt(maxVerEnv, 10) : undefined;

  // ── load webBL (global noise). File-level embedded-copy detection is computed later
  //    after the npm index is built, using composite-hash-per-file + birth comparison. ──
  const useDupFilter = process.env['DISABLE_DUP_FILTER'] !== '1';
  const cacheDirEnv = process.env['FP_CACHE_DIR'] ?? 'src/data/fingerprint-cache';
  const cacheDir = cacheDirEnv.startsWith('/') ? cacheDirEnv : join(rootDir, cacheDirEnv);
  let webBL = new Set<string>();
  if (useDupFilter) {
    if (process.env['DISABLE_WEB_BLACKLIST'] === '1') {
      console.log('[web-blacklist] disabled via DISABLE_WEB_BLACKLIST=1');
    } else {
      webBL = loadWebBlacklist(rootDir, 0.6);
      console.log(`[web-blacklist] ${webBL.size} hashes (applied globally)`);
    }
  } else {
    console.log('[dup-filter] disabled via DISABLE_DUP_FILTER=1');
  }
  /** check if hash is noise (webBL only — per-lib cdn-dup replaced by file-level embedded detection) */
  const isNoise = (hash: string, _baseLib: string): boolean => webBL.has(hash);

  // ── determine target sites ──
  const allSiteFiles = fs.readdirSync(webHashDir)
    .filter((f) => f.endsWith('.json') && !/-(cnt|cfg|f|fb|fbc)\.json$/.test(f))
    .map((f) => f.replace(/\.json$/, ''))
    .sort();

  const targetSites = siteEnv
    ? siteEnv.split(',').map((s) => s.trim()).filter(Boolean)
    : allSiteFiles;

  // ── determine target libs ──
  const allNpmLibs = fs.readdirSync(npmDataDir).sort();
  const targetLibs = libEnv
    ? libEnv.split(',').map((s) => s.trim()).filter(Boolean)
    : allNpmLibs;

  console.log(`[config] sites: ${targetSites.length} (${siteEnv ?? 'all'})`);
  console.log(`[config] libs: ${targetLibs.length} (${libEnv ?? 'all'})`);
  console.log(`[config] threshold: ${thresholdPercent}%`);
  if (maxVersions !== undefined) console.log(`[config] maxVersions: ${maxVersions}`);

  fs.mkdirSync(outDir, { recursive: true });

  // ── load ground truth ──
  const groundTruth = parseGroundTruth(groundTruthPath);
  console.log(`[gt] loaded ${groundTruth.size} site entries from ground-truth.csv`);

  // ── load site hash sets ──
  const siteHashSets = new Map<string, Set<string>>();
  for (const site of targetSites) {
    const hashSet = loadSiteHashSet(site);
    if (hashSet) {
      siteHashSets.set(site, hashSet);
      if (debugMode) console.log(`[site] ${site} hashSet=${hashSet.size}`);
    }
  }

  const activeSites = targetSites.filter((s) => siteHashSets.has(s));
  if (activeSites.length === 0) {
    console.error('[Fatal] No valid sites found');
    process.exit(1);
  }
  console.log(`[config] activeSites: ${activeSites.length}`);

  // ── inverted-index architecture: direct (hash → lib/file/ver) lookup ──
  const minCandidate = parseInt(process.env['MIN_CANDIDATE'] ?? '5', 10);
  console.log(`[config] minCandidate=${minCandidate} (unique site hashes to keep lib), cdn-intersection ratio threshold = ${(matchThreshold * 100).toFixed(0)}% (same as matchThreshold)`);

  // ── load cache files directly ──
  interface AllLibsEntry { id: number; versions: string[]; hashCnt: number[]; relPath?: string }
  type AllLibsT = Record<string, AllLibsEntry>;
  type AllHashT = Record<string, Record<string, Record<string, Array<[number, number]>>>>;
  type AllDepsT = Record<string, { nodes: number[]; edges: [number, number][]; unresolved: [number, string][] }>;

  console.log('[index] loading cache files...');
  const tLoad = Date.now();
  const npmLibsData = JSON.parse(fs.readFileSync(join(cacheDir, 'alllibs.json'), 'utf-8')) as AllLibsT;
  const npmHashData = JSON.parse(fs.readFileSync(join(cacheDir, 'allhash.json'), 'utf-8')) as AllHashT;
  const npmDepsData = JSON.parse(fs.readFileSync(join(cacheDir, 'alldeps.json'), 'utf-8')) as AllDepsT;
  const cdnLibsData = JSON.parse(fs.readFileSync(join(cacheDir, 'cdn-alllibs.json'), 'utf-8')) as AllLibsT;
  const cdnHashData = JSON.parse(fs.readFileSync(join(cacheDir, 'cdn-allhash.json'), 'utf-8')) as AllHashT;
  console.log(`[index] loaded cache in ${((Date.now()-tLoad)/1000).toFixed(1)}s`);

  // ── build npm indexes ──
  const tIdx = Date.now();

  interface FileLibMeta { baseLib: string; relPath: string; versions: string[]; hashCnt: number[] }
  const fileLibById = new Map<number, FileLibMeta>();
  const fileLibIdsByBaseLib = new Map<string, number[]>();

  for (const [key, entry] of Object.entries(npmLibsData)) {
    const baseLib = key.split('____')[0];
    const relPath = entry.relPath ?? key.slice(baseLib.length + 4).replace(/\./g, '/') + '.js';
    fileLibById.set(entry.id, { baseLib, relPath, versions: entry.versions, hashCnt: entry.hashCnt });
    let arr = fileLibIdsByBaseLib.get(baseLib);
    if (!arr) { arr = []; fileLibIdsByBaseLib.set(baseLib, arr); }
    arr.push(entry.id);
  }

  // The cache stores each hash's version span as a range; expanding every range into its own
  // per-version Set costs ~1 GB resident (1.05 M Sets, 22.6 M members) for data that only the
  // one-off composite pass and fingerprint precompute below read. Keep the ranges (~78 MB) and
  // expand one library at a time instead — same total work, bounded peak.
  interface HashRange { hash: string; lo: number; hi: number; webBL: boolean }
  const hashRangesByLib = new Map<number, HashRange[]>();
  const MIN_POG_NODES = parseInt(process.env['MIN_POG_NODES'] ?? '0', 10);
  console.log(`[config] min POG nodes = ${MIN_POG_NODES} (drop POGs with nodes < ${MIN_POG_NODES})`);

  for (const [nodesStr, bucket] of Object.entries(npmHashData)) {
    if (Number(nodesStr) < MIN_POG_NODES) continue;
    for (const [hash, libMap] of Object.entries(bucket)) {
      const isWebBL = webBL.has(hash);
      for (const [libIdStr, ranges] of Object.entries(libMap)) {
        const libId = Number(libIdStr);
        if (!fileLibById.has(libId)) continue;
        let arr = hashRangesByLib.get(libId);
        if (!arr) { arr = []; hashRangesByLib.set(libId, arr); }
        for (const [lo, hi] of ranges) arr.push({ hash, lo, hi, webBL: isWebBL });
      }
    }
  }
  console.log(`[index] npm: ${hashRangesByLib.size} libs (hash ranges) in ${((Date.now()-tIdx)/1000).toFixed(1)}s`);

  /**
   * Per-version hash Sets for one library, materialized on demand.
   *
   * `raw` is unfiltered (for the file-level composite hash), `filtered` drops web-blacklisted
   * hashes — exactly the two maps this used to build eagerly. The cache is scoped by the
   * caller (one library in the composite pass, one baseLib in the precompute) rather than
   * size-capped: a fixed LRU makes a baseLib with more files than the cap re-expand them on
   * every version, which measured 106 s of precompute instead of 3.5 s.
   */
  const expandedCache = new Map<number, { raw: Map<number, Set<string>>; filtered: Map<number, Set<string>> }>();
  function expandLib(libId: number) {
    const hit = expandedCache.get(libId);
    if (hit) return hit;
    const raw = new Map<number, Set<string>>();
    const filtered = new Map<number, Set<string>>();
    for (const r of hashRangesByLib.get(libId) ?? []) {
      for (let vi = r.lo; vi <= r.hi; vi++) {
        let rs = raw.get(vi);
        if (!rs) { rs = new Set(); raw.set(vi, rs); }
        rs.add(r.hash);
        if (r.webBL) continue;
        let fset = filtered.get(vi);
        if (!fset) { fset = new Set(); filtered.set(vi, fset); }
        fset.add(r.hash);
      }
    }
    const entry = { raw, filtered };
    expandedCache.set(libId, entry);
    return entry;
  }

  // ── File-level embedded-copy detection ──
  // For each (libId, verIdx), compute composite hash = sha1(sorted raw hashes).
  // When the same composite hash appears in multiple baseLibs, birth dates of each lib determine
  // winner/loser. Losers' file-libs are flagged as embedded copies and excluded from detection.
  const tFileDup = Date.now();
  const MIN_FILE_HASHES = parseInt(process.env['FILE_DUP_MIN_HASHES'] ?? '1', 10);
  const { createHash } = require('crypto') as typeof import('crypto');
  const birthPath = join(rootDir, 'src/data/birth_sanitized.json');
  let birthInfo: Record<string, Record<string, string>> = {};
  try { birthInfo = JSON.parse(fs.readFileSync(birthPath, 'utf-8')); }
  catch (e) { console.warn(`[file-dup] cannot load birth: ${(e as Error).message}`); }

  interface FileLibEntry { libId: number; verIdx: number; baseLib: string; version: string }
  const compositeToEntries = new Map<string, FileLibEntry[]>();
  // One library at a time: expand, consume, drop — nothing here is reused across libraries.
  for (const libId of hashRangesByLib.keys()) {
    const meta = fileLibById.get(libId);
    if (!meta) continue;
    expandedCache.clear();
    for (const [verIdx, rawSet] of expandLib(libId).raw) {
      if (rawSet.size < MIN_FILE_HASHES) continue;
      const sorted = [...rawSet].sort();
      const composite = createHash('sha1').update(sorted.join('|')).digest('hex');
      const version = meta.versions[verIdx];
      if (!version) continue;
      let arr = compositeToEntries.get(composite);
      if (!arr) { arr = []; compositeToEntries.set(composite, arr); }
      arr.push({ libId, verIdx, baseLib: meta.baseLib, version });
    }
  }
  expandedCache.clear(); // the raw Sets are only needed for the composites above

  const embeddedFileLibVer = new Set<string>();
  let winLoserGroups = 0;
  for (const [_composite, entries] of compositeToEntries) {
    if (entries.length < 2) continue;
    const baseLibs = new Set(entries.map((e) => e.baseLib));
    if (baseLibs.size < 2) continue;
    // oldest birth per baseLib across the entries of this composite group
    const oldestByBaseLib = new Map<string, number>();
    for (const e of entries) {
      const raw = birthInfo[e.baseLib]?.[e.version];
      if (!raw) continue;
      const t = new Date(raw).getTime();
      const cur = oldestByBaseLib.get(e.baseLib);
      if (cur === undefined || t < cur) oldestByBaseLib.set(e.baseLib, t);
    }
    if (oldestByBaseLib.size === 0) continue;
    let winner = '';
    let winnerTime = Number.POSITIVE_INFINITY;
    for (const [bl, t] of oldestByBaseLib) { if (t < winnerTime) { winnerTime = t; winner = bl; } }
    for (const e of entries) {
      if (e.baseLib !== winner) embeddedFileLibVer.add(`${e.libId}@${e.verIdx}`);
    }
    winLoserGroups++;
  }
  console.log(`[file-dup] composite-match groups with cross-lib embedding: ${winLoserGroups}, flagged ${embeddedFileLibVer.size} file-libs as embedded (min_hashes=${MIN_FILE_HASHES}) in ${((Date.now()-tFileDup)/1000).toFixed(1)}s`);

  // ── build cdn indexes ──
  const tCdn = Date.now();
  interface CdnFileLibMeta { baseLib: string; relPath: string; versions: string[] }
  const cdnFileLibById = new Map<number, CdnFileLibMeta>();
  for (const [key, entry] of Object.entries(cdnLibsData)) {
    const baseLib = key.split('____')[0];
    const relPath = entry.relPath ?? key.slice(baseLib.length + 4).replace(/\./g, '/') + '.js';
    cdnFileLibById.set(entry.id, { baseLib, relPath, versions: entry.versions });
  }

  const cdnHashByLibVer = new Map<string, Set<string>>(); // "baseLib@version" — union across variants
  const cdnHashByLib    = new Map<string, Set<string>>(); // baseLib (superset)
  // Per-variant-file hashes per version: "baseLib@version" → Map<relPath, Set<hash>>
  const cdnVariantHashesByLibVer = new Map<string, Map<string, Set<string>>>();

  for (const [nodesStr, bucket] of Object.entries(cdnHashData)) {
    if (Number(nodesStr) < MIN_POG_NODES) continue;
    for (const [hash, libMap] of Object.entries(bucket)) {
      for (const [libIdStr, ranges] of Object.entries(libMap)) {
        const info = cdnFileLibById.get(Number(libIdStr));
        if (!info) continue;
        let superset = cdnHashByLib.get(info.baseLib);
        if (!superset) { superset = new Set(); cdnHashByLib.set(info.baseLib, superset); }
        superset.add(hash);
        for (const [lo, hi] of ranges) {
          for (let vi = lo; vi <= hi; vi++) {
            const version = info.versions[vi];
            if (!version) continue;
            const verKey = `${info.baseLib}@${version}`;
            let vset = cdnHashByLibVer.get(verKey);
            if (!vset) { vset = new Set(); cdnHashByLibVer.set(verKey, vset); }
            vset.add(hash);
            // Per-variant tracking
            let variantMap = cdnVariantHashesByLibVer.get(verKey);
            if (!variantMap) { variantMap = new Map(); cdnVariantHashesByLibVer.set(verKey, variantMap); }
            let vhs = variantMap.get(info.relPath);
            if (!vhs) { vhs = new Set(); variantMap.set(info.relPath, vhs); }
            vhs.add(hash);
          }
        }
      }
    }
  }
  console.log(`[index] cdn: ${cdnHashByLibVer.size} (lib,ver) / ${cdnHashByLib.size} lib supersets in ${((Date.now()-tCdn)/1000).toFixed(1)}s`);

  // ── iteration unit is the CDN (lib, version) pair ──
  // - npm-only version: ignored (no row emitted)
  // - cdn-only version: single-file bundle detection (no file decomposition)
  // - both: npm file decomposition, each file filtered by cdn-intersection (strict same version)

  // cdnVersionsByLib: baseLib → sorted (descending) versions present in cdn
  const cdnVersionsByLib = new Map<string, string[]>();
  for (const libVerKey of cdnHashByLibVer.keys()) {
    const at = libVerKey.lastIndexOf('@');
    const baseLib = libVerKey.slice(0, at);
    const version = libVerKey.slice(at + 1);
    let arr = cdnVersionsByLib.get(baseLib);
    if (!arr) { arr = []; cdnVersionsByLib.set(baseLib, arr); }
    arr.push(version);
  }
  for (const [bl, vers] of cdnVersionsByLib) {
    try { cdnVersionsByLib.set(bl, semverSort(vers.filter(isValidSemver)).reverse()); }
    catch { cdnVersionsByLib.set(bl, [...vers].sort().reverse()); }
  }


  // cdnHashToLibVers: hash → [(baseLib, version)] from cdn, webBL + per-lib-dup filtered
  const cdnHashToLibVers = new Map<string, Array<{ baseLib: string; version: string }>>();
  for (const [libVerKey, hashSet] of cdnHashByLibVer) {
    const at = libVerKey.lastIndexOf('@');
    const baseLib = libVerKey.slice(0, at);
    const version = libVerKey.slice(at + 1);
    for (const h of hashSet) {
      if (isNoise(h, baseLib)) continue;
      let arr = cdnHashToLibVers.get(h);
      if (!arr) { arr = []; cdnHashToLibVers.set(h, arr); }
      arr.push({ baseLib, version });
    }
  }
  console.log(`[index] cdn inverted: ${cdnHashToLibVers.size} dup-filtered hashes, ${[...cdnVersionsByLib.values()].reduce((a, b) => a + b.length, 0)} (lib,ver) pairs`);

  // ── helper: assemble (lib, ver) fingerprint ──
  // - npm has exact same version → per-file decomposition, filter files by cdn-intersection (strict)
  // - npm does NOT have exact same version → single-file bundle (cdn hashes, dup-filtered)
  function assembleFingerprint(baseLib: string, version: string, cdnBundleHashes: Set<string>)
    : { fileHashes: Record<string, FileHashRecord>; depgraph: DepGraph; mode: 'npm-decomposed' | 'cdn-bundle' | 'empty' }
  {
    const libIds = fileLibIdsByBaseLib.get(baseLib) ?? [];
    const npmFileHashes: Record<string, FileHashRecord> = {};
    let npmHasThisVer = false;
    for (const libId of libIds) {
      const meta = fileLibById.get(libId)!;
      const vi = meta.versions.indexOf(version);
      if (vi < 0) continue;
      npmHasThisVer = true;
      const key = `${libId}@${vi}`;
      // File-level embedded-copy filter: skip files that are embedded copies of another lib
      if (embeddedFileLibVer.has(key)) continue;
      const hashSet = expandLib(libId).filtered.get(vi);
      if (!hashSet || hashSet.size === 0) continue;
      // cdn-intersection filter (strict same-ver): drop file if (matched in cdn) / total < matchThreshold
      let matchedInCdn = 0;
      for (const h of hashSet) if (cdnBundleHashes.has(h)) matchedInCdn++;
      const cdnRatio = hashSet.size === 0 ? 1 : matchedInCdn / hashSet.size;
      if (cdnRatio < matchThreshold) continue;
      // Keep ONLY the npm hashes that are also present in cdn — drop dev/build-only
      // functions that don't actually ship in the released bundle. This makes the
      // file fingerprint = npm ∩ cdn, which is what site detection should match against.
      const intersectedHashes = [...hashSet].filter((h) => cdnBundleHashes.has(h));
      if (intersectedHashes.length === 0) continue;
      npmFileHashes[meta.relPath] = { hashes: intersectedHashes, funcCount: meta.hashCnt[vi] ?? 0 };
    }

    if (npmHasThisVer && Object.keys(npmFileHashes).length > 0) {
      const present = new Set(Object.keys(npmFileHashes));
      const depRaw = npmDepsData[`${baseLib}@${version}`];
      let depgraph: DepGraph;
      if (depRaw) {
        const idToRel = (id: number): string => fileLibById.get(id)?.relPath ?? String(id);
        // Contract: remove non-present nodes, connect their parents to their descendants transitively
        const fullNodes = depRaw.nodes.map(idToRel);
        const fullEdges = depRaw.edges.map(([a, b]) => [idToRel(a), idToRel(b)] as [string, string]);
        const adj = new Map<string, string[]>();
        for (const n of fullNodes) adj.set(n, []);
        for (const [a, b] of fullEdges) {
          let arr = adj.get(a);
          if (!arr) { arr = []; adj.set(a, arr); }
          arr.push(b);
        }
        const newEdges: [string, string][] = [];
        const seen = new Set<string>();
        for (const src of fullNodes) {
          if (!present.has(src)) continue;
          const visited = new Set<string>();
          const stack: string[] = [...(adj.get(src) ?? [])];
          while (stack.length) {
            const cur = stack.pop()!;
            if (visited.has(cur)) continue;
            visited.add(cur);
            if (present.has(cur)) {
              if (cur === src) continue;
              const key = `${src}\t${cur}`;
              if (!seen.has(key)) { seen.add(key); newEdges.push([src, cur]); }
            } else {
              for (const nxt of (adj.get(cur) ?? [])) stack.push(nxt);
            }
          }
        }
        depgraph = {
          nodes: fullNodes.filter((n) => present.has(n)).sort(),
          edges: newEdges,
          unresolved: depRaw.unresolved
            .map(([a, spec]) => [idToRel(a), spec] as [string, string])
            .filter(([a]) => present.has(a)),
        };
      } else {
        depgraph = { nodes: [...present].sort(), edges: [], unresolved: [] };
      }
      return { fileHashes: npmFileHashes, depgraph, mode: 'npm-decomposed' };
    }

    // cdn-only (or npm has version but all files failed cdn-intersection) → one entry per cdn variant file
    // CDN bundle fallback for npm-absent libs is OFF by default — when enabled,
    // closure-less per-variant detection introduces FP families (json2.js etc).
    // Set ENABLE_CDN_BUNDLE_FALLBACK=1 to opt back in.
    if (process.env['ENABLE_CDN_BUNDLE_FALLBACK'] !== '1') {
      return { fileHashes: {}, depgraph: { nodes: [], edges: [], unresolved: [] }, mode: 'empty' };
    }
    const variantMap = cdnVariantHashesByLibVer.get(`${baseLib}@${version}`);
    if (!variantMap || variantMap.size === 0) {
      return { fileHashes: {}, depgraph: { nodes: [], edges: [], unresolved: [] }, mode: 'empty' };
    }
    const cdnFileHashes: Record<string, FileHashRecord> = {};
    const nodes: string[] = [];
    for (const [relPath, hs] of variantMap) {
      const cleaned = [...hs].filter((h) => !isNoise(h, baseLib));
      if (cleaned.length === 0) continue;
      cdnFileHashes[relPath] = { hashes: cleaned, funcCount: cleaned.length };
      nodes.push(relPath);
    }
    if (nodes.length === 0) {
      return { fileHashes: {}, depgraph: { nodes: [], edges: [], unresolved: [] }, mode: 'empty' };
    }
    return {
      fileHashes: cdnFileHashes,
      depgraph: { nodes: nodes.sort(), edges: [], unresolved: [] },
      mode: 'cdn-bundle',
    };
  }

  // ── pre-compute assembleFingerprint per (baseLib, version) ──
  // All inputs to assembleFingerprint are site-independent, so the result is
  // the same for every site that scores this pair. Precomputing once trims
  // the per-site detection loop's `assemble` cost from ~1.5s to a Map.get().
  type AssembleResult = ReturnType<typeof assembleFingerprint>;
  const assembledByLibVer = new Map<string, AssembleResult>();
  {
    const tAsm = Date.now();
    for (const [baseLib, versions] of cdnVersionsByLib) {
      // Every version of this baseLib reads the same libIds, so they are expanded once here
      // and dropped before the next baseLib.
      expandedCache.clear();
      for (const version of versions) {
        const cdnBundle = cdnHashByLibVer.get(`${baseLib}@${version}`);
        if (!cdnBundle) continue;
        assembledByLibVer.set(`${baseLib}@${version}`, assembleFingerprint(baseLib, version, cdnBundle));
      }
    }
    console.log(
      `[index] precomputed ${assembledByLibVer.size} assembleFingerprints in ${((Date.now() - tAsm) / 1000).toFixed(1)}s`
    );
  }
  // assembleFingerprint was the only reader; the per-site loop below reads assembledByLibVer.
  hashRangesByLib.clear();
  expandedCache.clear();

  // ── site-first detection: iterate cdn (lib, ver) ──
  const detectionRows: DetectionRow[] = [];
  const zeroRow = (site: string, lib: string, version: string): DetectionRow => ({
    site, lib, version,
    totalFiles: 0, passedFiles: 0,
    entryCount: 0, strictEntryCount: 0,
    strictClosureSize: 0,
    strictUnionHashCount: 0, strictMatchedHashCount: 0,
    strictRatio: 0,
    closureUnionHashCount: 0, closureMatchedHashCount: 0,
    posteriorScore: 0,
  });

  const targetLibSet = new Set(targetLibs);

  for (let sIdx = 0; sIdx < activeSites.length; sIdx++) {
    const site = activeSites[sIdx];
    const siteHashSet = siteHashSets.get(site)!;
    const tSite = Date.now();

    // Inverted match via CDN index: for each site hash, mark matched (baseLib, version)
    const matchedCdnLibVer = new Set<string>();            // "baseLib@version"
    const hitsByBaseLib = new Map<string, Set<string>>();  // baseLib → unique site hashes matched
    for (const h of siteHashSet) {
      const hits = cdnHashToLibVers.get(h);
      if (!hits) continue;
      const baseLibsHit = new Set<string>();
      for (const { baseLib, version } of hits) {
        matchedCdnLibVer.add(`${baseLib}@${version}`);
        baseLibsHit.add(baseLib);
      }
      for (const bl of baseLibsHit) {
        let set = hitsByBaseLib.get(bl);
        if (!set) { set = new Set(); hitsByBaseLib.set(bl, set); }
        set.add(h);
      }
    }

    const candidateLibs = new Set<string>();
    for (const [bl, hset] of hitsByBaseLib) if (hset.size >= minCandidate) candidateLibs.add(bl);

    let versionsProcessed = 0, bundleMode = 0, npmMode = 0;
    for (const [baseLib, versions] of cdnVersionsByLib) {
      if (targetLibSet.size > 0 && !targetLibSet.has(baseLib)) continue;
      const isCand = candidateLibs.has(baseLib);
      const versionsToReport = maxVersions !== undefined ? versions.slice(0, maxVersions) : versions;

      for (const version of versionsToReport) {
        if (!isCand || !matchedCdnLibVer.has(`${baseLib}@${version}`)) {
          detectionRows.push(zeroRow(site, baseLib, version));
          continue;
        }
        const cached = assembledByLibVer.get(`${baseLib}@${version}`)!;
        const { fileHashes, depgraph, mode } = cached;
        const totalFiles = Object.keys(fileHashes).length;
        if (mode === 'empty' || totalFiles === 0) {
          detectionRows.push(zeroRow(site, baseLib, version));
          continue;
        }
        if (mode === 'cdn-bundle') bundleMode++; else npmMode++;

        const result = filterAndFindEntries(fileHashes, depgraph, {
          threshold: matchThreshold,
          siteHashSet,
        });

        const strictUnionHashCount   = result.strictUnionHashes.size;
        const strictMatchedHashCount = result.strictMatchedCount;
        const strictRatio = strictUnionHashCount === 0 ? 0
          : strictMatchedHashCount / strictUnionHashCount;

        // Per-file posterior: treat each file f as a standalone mini-library
        // whose closure = files reachable from f via depgraph. For each f,
        // compute the Beta posterior P(p ≥ c | M_f, N_f) over its closure
        // union, then aggregate via max — library is detected if *any* file's
        // closure passes the bar. This catches tree-shaken libs (e.g. react)
        // where only a slice of the package ships to the site: that slice's
        // root file has a clean local closure that matches well, even though
        // the global union (whole package) doesn't.
        const adj = new Map<string, string[]>();
        for (const n of depgraph.nodes) adj.set(n, []);
        for (const [a, b] of depgraph.edges) {
          const arr = adj.get(a);
          if (arr) arr.push(b);
        }
        let posteriorScore = 0;
        let closureUnionSize = 0;
        let closureMatched = 0;
        for (const f of depgraph.nodes) {
          const closure = new Set<string>();
          const stack: string[] = [f];
          while (stack.length) {
            const cur = stack.pop()!;
            if (closure.has(cur)) continue;
            closure.add(cur);
            for (const nxt of adj.get(cur) ?? []) stack.push(nxt);
          }
          const union = new Set<string>();
          for (const c of closure) {
            const rec = fileHashes[c];
            if (!rec) continue;
            for (const h of rec.hashes) union.add(h);
          }
          let matched = 0;
          for (const h of union) if (siteHashSet.has(h)) matched++;
          const score = posteriorTail(matched, union.size, matchThreshold);
          if (score > posteriorScore) {
            posteriorScore = score;
            closureUnionSize = union.size;
            closureMatched = matched;
          }
        }

        if (debugMode) {
          console.log(
            `  [detect] ${site} × ${baseLib}/${version} (${mode})`,
            `passed=${result.passedCount}/${totalFiles}`,
            `entries=${result.entries.length} strict=${result.strictEntries.length}`,
            `strictRatio=${strictRatio.toFixed(4)}`,
            `closure=${closureMatched}/${closureUnionSize}`,
            `score=${posteriorScore.toFixed(4)}`
          );
        }

        detectionRows.push({
          site, lib: baseLib, version,
          totalFiles,
          passedFiles: result.passedCount,
          entryCount: result.entries.length,
          strictEntryCount: result.strictEntries.length,
          strictClosureSize: result.strictClosure.size,
          strictUnionHashCount,
          strictMatchedHashCount,
          strictRatio,
          closureUnionHashCount: closureUnionSize,
          closureMatchedHashCount: closureMatched,
          posteriorScore,
        });
        versionsProcessed++;
      }
    }

    console.log(`[site ${sIdx + 1}/${activeSites.length}] ${site} — ${candidateLibs.size} cand libs, ${versionsProcessed} scored (npm=${npmMode}, cdn-bundle=${bundleMode}), ${((Date.now()-tSite)/1000).toFixed(1)}s`);
  }

  // ── ensure GT libs without cdn still appear in summary (as "not detected" FN) ──
  const seenSiteLibs = new Set(detectionRows.map((r) => `${r.site}\t${r.lib}`));
  for (const [site, gtEntries] of groundTruth) {
    if (!siteHashSets.has(site)) continue;
    for (const e of gtEntries) {
      const key = `${site}\t${e.libName}`;
      if (!seenSiteLibs.has(key)) {
        detectionRows.push(zeroRow(site, e.libName, e.version ?? ''));
        seenSiteLibs.add(key);
      }
    }
  }

  // ── lib-name alias: kept as separate baseLib rows in detection.csv;
  // canonical merge happens at summary stage (see scoreLibForSite call below). ──
  const libAlias: Record<string, string> = { 'react-dom': 'react' };

  // ── sort detection rows: site asc, lib asc, version via semverSort ────────

  type RowKey = string;
  const rowGroups = new Map<RowKey, DetectionRow[]>();
  for (const row of detectionRows) {
    const key = `${row.site}\t${row.lib}`;
    if (!rowGroups.has(key)) rowGroups.set(key, []);
    rowGroups.get(key)!.push(row);
  }

  const sortedDetectionRows: DetectionRow[] = [];
  const sortedKeys = Array.from(rowGroups.keys()).sort();
  for (const key of sortedKeys) {
    const rows = rowGroups.get(key)!;
    const versions = rows.map((r) => r.version);
    let sortedVers: string[];
    try {
      sortedVers = semverSort(versions);
    } catch {
      sortedVers = versions.sort();
    }
    const verIndex = new Map(sortedVers.map((v, i) => [v, i]));
    rows.sort((a, b) => (verIndex.get(a.version) ?? 0) - (verIndex.get(b.version) ?? 0));
    sortedDetectionRows.push(...rows);
  }

  // ── write detection.csv ───────────────────────────────────────────────────

  const detectionHeader = 'site,lib,version,totalFiles,passedFiles,entryCount,strictEntryCount,strictClosureSize,strictUnionHashCount,strictMatchedHashCount,strictRatio,closureUnionHashCount,closureMatchedHashCount,posteriorScore';
  const detectionLines = [detectionHeader];
  for (const row of sortedDetectionRows) {
    detectionLines.push(csvRow([
      row.site, row.lib, row.version,
      row.totalFiles, row.passedFiles, row.entryCount, row.strictEntryCount,
      row.strictClosureSize,
      row.strictUnionHashCount, row.strictMatchedHashCount,
      row.strictRatio.toFixed(6),
      row.closureUnionHashCount, row.closureMatchedHashCount,
      row.posteriorScore.toFixed(6),
    ]));
  }
  fs.writeFileSync(join(outDir, 'detection.csv'), detectionLines.join('\n') + '\n', 'utf-8');
  console.log(`[out] detection.csv — ${sortedDetectionRows.length} rows`);

  // ── build summary per (site, lib) ─────────────────────────────────────────

  interface SummaryRow {
    site: string;
    lib: string;
    detected: boolean;
    versionRange: string;
    maxStrictCount: number;
    strictVersions: string;
    gtHasLib: boolean;
    gtVersion: string;
    verdict: 'TP' | 'FP' | 'FN' | 'TN' | 'UNKNOWN';
  }

  // Score each baseLib independently first, then merge canonical libs (e.g.
  // react ∪ react-dom → react). Versions are unioned across alias sources.
  const summaryRows: SummaryRow[] = [];
  const uniqueSiteLibPairs = new Set(sortedDetectionRows.map((r) => `${r.site}\t${r.lib}`));
  type PerBaseLibSummary = {
    detected: boolean;
    versionRange: string;
    maxStrictCount: number;
    strictVersions: string[];
    /** posterior detection: max P(p ≥ c) across versions of this baseLib */
    posteriorDetected: boolean;
    posteriorMaxScore: number;
    /** versions with posteriorScore ≥ 0.5, semver-sorted */
    posteriorVersions: string[];
    /** "min..max" of posteriorVersions, or single version when only one */
    posteriorVersionRange: string;
  };
  const perBaseLib = new Map<string, PerBaseLibSummary>(); // key: site\tbaseLib

  const DETECT_THRESHOLD = 0.5; // fixed: detected iff posterior tail mass clears half

  for (const key of Array.from(uniqueSiteLibPairs).sort()) {
    const [site, baseLib] = key.split('\t');
    const rows = sortedDetectionRows.filter((r) => r.site === site && r.lib === baseLib);

    const versionDetections: VersionDetection[] = rows.map((r) => ({
      version: r.version,
      strictEntryCount: r.strictEntryCount,
      strictRatio: r.strictUnionHashCount === 0 ? 0 : r.strictMatchedHashCount / r.strictUnionHashCount,
      strictMatchedHashCount: r.strictMatchedHashCount,
      strictClosureSize: r.strictClosureSize,
    }));

    // Note: GT lookup at this stage is informational — final verdict is recomputed
    // after canonical merge using the canonical lib name.
    const s = scoreLibForSite(versionDetections, null, baseLib);

    // Posterior aggregation across versions of this baseLib
    let posteriorMaxScore = 0;
    const posteriorPassing: string[] = [];
    for (const r of rows) {
      if (r.posteriorScore > posteriorMaxScore) posteriorMaxScore = r.posteriorScore;
      if (r.posteriorScore >= DETECT_THRESHOLD) posteriorPassing.push(r.version);
    }
    let posteriorSorted: string[];
    try { posteriorSorted = semverSort(posteriorPassing); }
    catch { posteriorSorted = [...posteriorPassing].sort(); }
    const posteriorDetected = posteriorMaxScore >= DETECT_THRESHOLD;
    const posteriorVersionRange = posteriorSorted.length === 0 ? ''
      : posteriorSorted.length === 1 ? posteriorSorted[0]
      : `${posteriorSorted[0]}..${posteriorSorted[posteriorSorted.length - 1]}`;

    perBaseLib.set(key, {
      detected: s.detected,
      versionRange: s.versionRange,
      maxStrictCount: s.maxStrictCount,
      strictVersions: s.strictVersions,
      posteriorDetected,
      posteriorMaxScore,
      posteriorVersions: posteriorSorted,
      posteriorVersionRange,
    });
  }

  // ── canonical merge: aggregate alias families into one row per (site, canonical) ──
  function canonicalize(lib: string): string { return libAlias[lib] ?? lib; }
  const sourcesByCanonicalSummary = new Map<string, Set<string>>();
  for (const lib of new Set(sortedDetectionRows.map((r) => r.lib))) {
    const canon = canonicalize(lib);
    let set = sourcesByCanonicalSummary.get(canon);
    if (!set) { set = new Set(); sourcesByCanonicalSummary.set(canon, set); }
    set.add(lib);
  }

  const sites = Array.from(new Set(sortedDetectionRows.map((r) => r.site))).sort();
  for (const site of sites) {
    for (const [canon, sources] of [...sourcesByCanonicalSummary.entries()].sort()) {
      let strictDetected = false;
      let maxStrictCount = 0;
      let posteriorAny = false;
      const strictUnion = new Set<string>();
      let bestVersionRange = '';
      let bestMaxCount = -1;
      for (const src of sources) {
        const rec = perBaseLib.get(`${site}\t${src}`);
        if (!rec) continue;
        if (rec.detected) strictDetected = true;
        if (rec.posteriorDetected) posteriorAny = true;
        if (rec.maxStrictCount > maxStrictCount) maxStrictCount = rec.maxStrictCount;
        for (const v of rec.strictVersions) strictUnion.add(v);
        // pick versionRange from the source with the highest maxStrictCount (informational)
        if (rec.detected && rec.maxStrictCount > bestMaxCount) {
          bestMaxCount = rec.maxStrictCount;
          bestVersionRange = rec.versionRange;
        }
      }
      // DETECT_RULE picks which of the two gates decides a library is present:
      //   strict     (default) — some version passed the ψ consistency test outright
      //   posterior            — P(consistency ≥ ψ) ≥ 0.5 under Beta(M+1, N-M+1)
      // Everything the paper reports uses `strict` except the five ablation columns of
      // Table 3, which build-db.sh therefore builds with `posterior`.
      const detected = process.env['DETECT_RULE'] === 'posterior' ? posteriorAny : strictDetected;

      // GT lookup with canonical name
      const rawGtEntries = groundTruth.get(site) ?? null;
      const gtEntries = rawGtEntries ? rawGtEntries.map((e) => ({ libName: e.libName, version: e.version })) : null;
      const inGt = gtEntries !== null;
      const gtMatch = gtEntries?.find((e) => e.libName === canon);
      const gtHasLib = !!gtMatch;
      const gtVersion = gtMatch?.version ?? '';
      let verdict: SummaryRow['verdict'];
      if (!inGt) verdict = 'UNKNOWN';
      else if (detected && gtHasLib) verdict = 'TP';
      else if (detected && !gtHasLib) verdict = 'FP';
      else if (!detected && gtHasLib) verdict = 'FN';
      else verdict = 'TN';

      // semver-sort the unioned version lists
      const strictSorted = (() => { try { return semverSort([...strictUnion]); } catch { return [...strictUnion].sort(); } })();

      summaryRows.push({
        site,
        lib: canon,
        detected,
        versionRange: bestVersionRange,
        maxStrictCount,
        strictVersions: strictSorted.join(';'),
        gtHasLib,
        gtVersion,
        verdict,
      });
    }
  }

  // ── write summary.csv ─────────────────────────────────────────────────────

  const summaryHeader = 'site,lib,detected,versionRange,maxStrictCount,strictVersions,gtHasLib,gtVersion,verdict';
  const summaryLines = [summaryHeader];
  for (const row of summaryRows) {
    summaryLines.push(csvRow([
      row.site, row.lib, row.detected, row.versionRange, row.maxStrictCount,
      row.strictVersions,
      row.gtHasLib, row.gtVersion, row.verdict,
    ]));
  }
  fs.writeFileSync(join(outDir, 'summary.csv'), summaryLines.join('\n') + '\n', 'utf-8');
  console.log(`[out] summary.csv — ${summaryRows.length} rows`);

  // ── compute metrics.json ──────────────────────────────────────────────────

  const knownRows = summaryRows.filter((r) => r.verdict !== 'UNKNOWN');

  let oTP = 0, oFP = 0, oFN = 0, oTN = 0;
  for (const r of knownRows) {
    if (r.verdict === 'TP') oTP++;
    else if (r.verdict === 'FP') oFP++;
    else if (r.verdict === 'FN') oFN++;
    else oTN++;
  }
  const overallPRF = calcPRF(oTP, oFP, oFN);

  const perSiteMetrics: Record<string, {
    precision: number; recall: number; f1: number;
    detected: string[]; gt: string[];
  }> = {};
  const sitesInGt = new Set(knownRows.map((r) => r.site));
  for (const site of Array.from(sitesInGt).sort()) {
    const siteRows = knownRows.filter((r) => r.site === site);
    let sTP = 0, sFP = 0, sFN = 0;
    for (const r of siteRows) {
      if (r.verdict === 'TP') sTP++;
      else if (r.verdict === 'FP') sFP++;
      else if (r.verdict === 'FN') sFN++;
    }
    const prf = calcPRF(sTP, sFP, sFN);
    perSiteMetrics[site] = {
      precision: round4(prf.precision),
      recall: round4(prf.recall),
      f1: round4(prf.f1),
      detected: siteRows.filter((r) => r.detected).map((r) => r.lib).sort(),
      gt: siteRows.filter((r) => r.gtHasLib).map((r) => r.lib).sort(),
    };
  }

  const perLibMetrics: Record<string, {
    precision: number; recall: number; f1: number; tp: number; fp: number; fn: number;
  }> = {};
  const libsInGt = new Set(knownRows.filter((r) => r.gtHasLib).map((r) => r.lib));
  for (const lib of Array.from(libsInGt).sort()) {
    const libRows = knownRows.filter((r) => r.lib === lib);
    let lTP = 0, lFP = 0, lFN = 0;
    for (const r of libRows) {
      if (r.verdict === 'TP') lTP++;
      else if (r.verdict === 'FP') lFP++;
      else if (r.verdict === 'FN') lFN++;
    }
    const prf = calcPRF(lTP, lFP, lFN);
    perLibMetrics[lib] = {
      precision: round4(prf.precision),
      recall: round4(prf.recall),
      f1: round4(prf.f1),
      tp: lTP, fp: lFP, fn: lFN,
    };
  }

  const metricsJson = {
    threshold: thresholdPercent,
    overall: {
      precision: round4(overallPRF.precision),
      recall: round4(overallPRF.recall),
      f1: round4(overallPRF.f1),
      tp: oTP, fp: oFP, fn: oFN, tn: oTN,
    },
    perSite: perSiteMetrics,
    perLib: perLibMetrics,
  };

  fs.writeFileSync(join(outDir, 'metrics.json'), JSON.stringify(metricsJson, null, 2) + '\n', 'utf-8');
  console.log(`[out] metrics.json — overall precision=${round4(overallPRF.precision)} recall=${round4(overallPRF.recall)} f1=${round4(overallPRF.f1)}`);

  console.log('\n[done] All outputs written to', outDir);
})();
