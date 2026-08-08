/**
 * compare-detectors.ts
 *
 * Computes lib-level (TP/FP/FN/TN, P/R/F1) and version-level (Major/Minor/Patch
 * matches with detected-set spread) metrics across all detectors against
 * ground-truth.csv on the same eval site set:
 *
 *   - LDC          (from GT csv `ldc` + `ldc_version` columns)
 *   - PTDetector   (from GT csv `ptdetector` column, lib-level only)
 *   - Aletheia     (src/data/other-tool/aletheia_results_debun.json)
 *   - D-Bundlr     (src/data/other-tool/dbundlr_results_debun.json)
 *   - DEBUN        (src/data/threshold-sweep/t84/summary.csv, module-aware scorer)
 *
 * LDC version handling: partial versions (`preact@10`) are expanded to all
 * matching cdn cache versions (preact 10.x.x). LDC entries without a version
 * (lib-only) are excluded from version-level counting.
 * Aletheia version handling: top-1 with ties (no threshold).
 * D-Bundlr doesn't emit versions -> skipped from version-level metrics.
 *
 * This module exports `runCompareDetectors()` (used by the RQ1/RQ2 evaluation
 * wrappers) and prints a human-readable summary when run directly.
 *
 * Env:
 *   DEBUN_EVAL_DIR  override DEBUN summary location
 *                   (default: src/data/threshold-sweep/t84)
 *   FP_CACHE_DIR    override fingerprint-cache dir for cdn baseLib universe
 *                   (default: src/data/fingerprint-cache)
 *   DBUNDLR_MIN     minimum confidence for D-Bundlr lib-level detection
 *                   (default: 0.6)
 */
import fs from 'fs';
import path from 'path';
import * as Papa from 'papaparse';

export interface LibMetric {
  tp: number;
  fp: number;
  fn: number;
  tn: number;
}
export interface VerStats {
  tp: number;
  M: number;
  m: number;
  p: number;
  wM: number[];
  wMm: number[];
  wMmp: number[];
}
export interface CompareResult {
  lib: {
    LDC: LibMetric;
    PTDetector: LibMetric;
    /** D-Bundlr over the full library universe (can never detect untrained libs) */
    dbundler: LibMetric;
    /** D-Bundlr restricted to the libraries it was trained on — the fair operating scope */
    dbundlerTrained: LibMetric;
    DEBUN: LibMetric;
  };
  version: { LDC: VerStats; Aletheia: VerStats; DEBUN: VerStats };
  /** per canonical library: DEBUN (score_m) TP counts and ground-truth counts */
  perLib: { DEBUN: Record<string, number>; ground: Record<string, number> };
  /** per-(site,lib) true positives per detector, as `site\tlib`, for the Venn diagram */
  tpPairs: Record<string, string[]>;
  /** scope of the `dbundlerTrained` metric, for table footnotes */
  dbundlrScope: {
    /** canonical trained libs that exist in the universe (the scored set) */
    libs: string[];
    /** GT instances belonging to those libs */
    gtInstances: number;
    /** GT instances over the full universe */
    gtInstancesAll: number;
  };
}

// ── metric helpers (pure) ──
export function precision(m: LibMetric): number {
  return m.tp + m.fp ? m.tp / (m.tp + m.fp) : 0;
}
export function recall(m: LibMetric): number {
  return m.tp + m.fn ? m.tp / (m.tp + m.fn) : 0;
}
export function f1(m: LibMetric): number {
  const P = precision(m);
  const R = recall(m);
  return P + R ? (2 * P * R) / (P + R) : 0;
}
const avg = (a: number[]) =>
  a.length ? a.reduce((x, y) => x + y, 0) / a.length : 0;

export function runCompareDetectors(): CompareResult {
  const root = process.cwd();
  const gtPath = path.join(root, 'src/ground/ground-truth.csv');
  const aletPath = path.join(root, 'src/data/other-tool/aletheia_results_debun.json');
  const dbunPath = path.join(root, 'src/data/other-tool/dbundlr_results_debun.json');
  const webHashDir = path.join(root, 'src/data/allWebHashes');
  const cacheDir = process.env['FP_CACHE_DIR'] ?? 'src/data/fingerprint-cache';
  const cacheAbs = cacheDir.startsWith('/') ? cacheDir : path.join(root, cacheDir);
  const cdnLibsPath = path.join(cacheAbs, 'cdn-alllibs.json');
  const debunDir = process.env['DEBUN_EVAL_DIR'] ?? 'src/data/threshold-sweep/t84';
  const debunSummary = path.join(root, debunDir, 'summary.csv');

  const DBUNDLR_MIN = parseFloat(process.env['DBUNDLR_MIN'] ?? '0.6');

  // ── canonical lib-name mapping (tool output → universe) ──
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
    // npm names used only by D-Bundlr; the universe/GT spell these `three.js`
    // and `jquery.isotope`. Without these two the corresponding D-Bundlr
    // detections fall outside the universe and are counted as neither TP nor FP.
    'three': 'three.js',
    'isotope-layout': 'jquery.isotope',
  };
  const canon = (s: string): string => ALIAS[s] ?? s;

  const parts = (v: string): [number | null, number | null, number | null] => {
    const p = v.split('.').map((x) => parseInt(x));
    return [p[0] ?? null, p[1] ?? null, p[2] ?? null];
  };

  function parseLibVer(cell: string): Map<string, string> {
    const m = new Map<string, string>();
    if (!cell) return m;
    for (const tok of cell.split(',').map((s) => s.trim()).filter(Boolean)) {
      const at = tok.indexOf('@');
      const lib = canon((at < 0 ? tok : tok.slice(0, at)).trim().toLowerCase());
      const ver = at < 0 ? '' : tok.slice(at + 1).trim();
      if (lib) m.set(lib, ver);
    }
    return m;
  }

  // ── universe ──
  const cdnLibsRaw = JSON.parse(fs.readFileSync(cdnLibsPath, 'utf8')) as Record<string, { versions?: string[] }>;
  const universe = new Set<string>();
  const libVersions = new Map<string, Set<string>>();
  for (const [k, v] of Object.entries(cdnLibsRaw)) {
    const lib = k.split('____')[0].toLowerCase();
    universe.add(lib);
    let s = libVersions.get(lib);
    if (!s) { s = new Set(); libVersions.set(lib, s); }
    for (const ver of (v.versions ?? [])) s.add(ver);
  }

  function expandPrefix(lib: string, ver: string): Set<string> {
    const all = libVersions.get(lib) ?? new Set();
    if (!ver) return new Set();
    const lp = parts(ver);
    const out = new Set<string>();
    for (const v of all) {
      const [a, b, c] = parts(v);
      if (lp[0] != null && lp[0] !== a) continue;
      if (lp[1] != null && lp[1] !== b) continue;
      if (lp[2] != null && lp[2] !== c) continue;
      out.add(v);
    }
    return out;
  }

  // ── load GT (drives both lib + version metrics) ──
  type GtMap = Map<string, Map<string, string>>;
  const gt: GtMap = new Map();
  const ldcVerMap: GtMap = new Map();        // ldc_version
  const ldcLibMap = new Map<string, Set<string>>();   // ldc col (lib only)
  const ptLibMap = new Map<string, Set<string>>();    // ptdetector

  const gtRaw = fs.readFileSync(gtPath, 'utf8');
  const gtParsed = Papa.parse<Record<string, string>>(gtRaw, { header: true, skipEmptyLines: true });

  // ── eval site set ──
  // allWebHashes contributes only file *names*, never hashes, and its extra entries are
  // ablation-model files (`<site>-f`, `-fb`, `-fbc`) that no ground-truth url matches. The
  // set is therefore exactly the ground-truth urls, so it is derived from the ground truth
  // when the 115 MB hash directory has not been built.
  const evalSites = new Set(
    fs.existsSync(webHashDir)
      ? fs.readdirSync(webHashDir)
          .filter((f) => f.endsWith('.json') && !f.includes('-cnt') && !f.includes('-cfg'))
          .map((f) => f.replace(/\.json$/, ''))
      : gtParsed.data.map((r) => (r['url'] ?? '').trim()).filter(Boolean)
  );

  for (const r of gtParsed.data) {
    const site = (r['url'] ?? '').trim();
    if (!site || !evalSites.has(site)) continue;
    gt.set(site, parseLibVer(r['ground truth'] ?? ''));
    ldcVerMap.set(site, parseLibVer(r['ldc_version'] ?? ''));
    const ldcLibs = new Set<string>();
    for (const tok of (r['ldc'] ?? '').split(',').map((s) => s.trim()).filter(Boolean)) {
      ldcLibs.add(canon(tok.split('@')[0].toLowerCase()));
    }
    ldcLibMap.set(site, ldcLibs);
    const ptLibs = new Set<string>();
    for (const tok of (r['ptdetector'] ?? '').split(',').map((s) => s.trim()).filter(Boolean)) {
      ptLibs.add(canon(tok.split('@')[0].toLowerCase()));
    }
    ptLibMap.set(site, ptLibs);
  }

  // ── load tool outputs ──
  type AletheiaRecord = { urls: string[]; detections: Record<string, Record<string, number>> };
  const aletheia = JSON.parse(fs.readFileSync(aletPath, 'utf8')) as AletheiaRecord[];

  type DbundlerEntry = { confidence: number; function: { packageName: string } };
  type DbundlerRecord = { urls: string[]; detections: Array<{ dbundlr?: DbundlerEntry[] }> };
  const dbundlerRaw = JSON.parse(fs.readFileSync(dbunPath, 'utf8')) as
    | { result: DbundlerRecord[]; trained_libs?: string[] }
    | DbundlerRecord[];
  const dbundler: DbundlerRecord[] = Array.isArray(dbundlerRaw) ? dbundlerRaw : dbundlerRaw.result;

  // Libraries D-Bundlr was trained on. It structurally cannot detect anything
  // outside this set, so scoring it over the full universe inflates its FN
  // count with libraries it never had a chance at. `trainedLibs` is that set
  // intersected with the universe (libs with no cdn entry cannot be scored).
  const trainedLibs = new Set<string>();
  for (const l of (Array.isArray(dbundlerRaw) ? [] : dbundlerRaw.trained_libs ?? [])) {
    const lib = canon(l.trim().toLowerCase());
    if (universe.has(lib)) trainedLibs.add(lib);
  }

  // Aletheia: per (site, lib), top-1 (with ties) as detected version set
  const aleBySite = new Map<string, Map<string, Set<string>>>();
  for (const r of aletheia) {
    const site = r.urls?.[0]?.trim();
    if (!site) continue;
    for (const [libRaw, verMap] of Object.entries(r.detections ?? {})) {
      const lib = canon(libRaw.toLowerCase());
      const entries = Object.entries(verMap);
      if (entries.length === 0) continue;
      let maxS = -Infinity;
      for (const [, s] of entries) if (s > maxS) maxS = s;
      const top = entries.filter(([, s]) => s === maxS).map(([v]) => v);
      let s = aleBySite.get(site);
      if (!s) { s = new Map(); aleBySite.set(site, s); }
      let cur = s.get(lib);
      if (!cur) { cur = new Set(); s.set(lib, cur); }
      for (const v of top) cur.add(v);
    }
  }

  // dbundler: per-bundle, mc = max confidence; if mc > DBUNDLR_MIN, emit all
  // packages tied at mc (lib-level only — no version)
  const dbBySite = new Map<string, Set<string>>();
  for (const r of dbundler) {
    const site = r.urls?.[0]?.trim();
    if (!site) continue;
    let s = dbBySite.get(site);
    if (!s) { s = new Set(); dbBySite.set(site, s); }
    for (const det of r.detections ?? []) {
      const entries = det.dbundlr ?? [];
      if (entries.length === 0) continue;
      let mc = -Infinity;
      for (const e of entries) if (e.confidence > mc) mc = e.confidence;
      if (mc <= DBUNDLR_MIN) continue;
      for (const e of entries) {
        if (e.confidence !== mc) continue;
        const lib = canon((e.function?.packageName ?? '').toLowerCase());
        if (lib) s.add(lib);
      }
    }
  }

  // DEBUN: from summary.csv — include every row where DEBUN claimed detection
  // (detected=true), regardless of TP/FP, so libMetrics can count FPs correctly.
  const debunBySite = new Map<string, Map<string, Set<string>>>();
  const dcsv = fs.readFileSync(debunSummary, 'utf8').trim().split('\n');
  const dh = dcsv[0].split(',');
  const idx = (k: string) => dh.indexOf(k);
  for (const line of dcsv.slice(1)) {
    const f = line.split(',');
    const site = f[idx('site')];
    const lib = canon(f[idx('lib')].toLowerCase());
    const detected = f[idx('detected')];
    if (detected !== 'true') continue;
    const versions = (f[idx('strictVersions')] ?? '').split(';').map((s) => s.trim()).filter(Boolean);
    let s = debunBySite.get(site);
    if (!s) { s = new Map(); debunBySite.set(site, s); }
    s.set(lib, new Set(versions));
  }

  // ── lib-level metrics ──
  function libMetrics(
    detected: (site: string) => Set<string>,
    scope: Set<string> = universe
  ): LibMetric {
    const m: LibMetric = { tp: 0, fp: 0, fn: 0, tn: 0 };
    for (const site of evalSites) {
      const gts = gt.get(site);
      if (!gts || gts.size === 0) continue;
      const det = detected(site);
      for (const lib of scope) {
        const inGt = gts.has(lib);
        const inDet = det.has(lib);
        if (inGt && inDet) m.tp++;
        else if (!inGt && inDet) m.fp++;
        else if (inGt && !inDet) m.fn++;
        else m.tn++;
      }
    }
    return m;
  }

  // LDC lib-level: use only the `ldc` column (matches rq1's evaluateAll),
  // not the `ldc_version` column which sometimes lists extra libs.
  const ldcLibDetected = (s: string) => ldcLibMap.get(s) ?? new Set<string>();
  const ptLibDetected = (s: string) => ptLibMap.get(s) ?? new Set<string>();
  const dbLibDetected = (s: string) => dbBySite.get(s) ?? new Set<string>();
  const debunLibDetected = (s: string) => new Set((debunBySite.get(s) ?? new Map()).keys());

  const M_LDC = libMetrics(ldcLibDetected);
  const M_PT = libMetrics(ptLibDetected);
  const M_DB = libMetrics(dbLibDetected);
  const M_DB_TRAINED = libMetrics(dbLibDetected, trainedLibs);
  const M_DEB = libMetrics(debunLibDetected);

  // ── version-level metrics ──
  function newVer(): VerStats { return { tp: 0, M: 0, m: 0, p: 0, wM: [], wMm: [], wMmp: [] }; }

  function checkVer(stats: VerStats, gtVer: string, versions: Set<string>): void {
    if (versions.size === 0) return;
    stats.tp++;
    const [gM, gmL, gp] = parts(gtVer);
    const majors = new Set<number | null>();
    const minors = new Set<string>();
    const patches = new Set<string>();
    let mF = false, miF = false, paF = false;
    for (const v of versions) {
      const [a, b, c] = parts(v);
      majors.add(a);
      minors.add(`${a}.${b}`);
      patches.add(v);
      if (a === gM) mF = true;
      if (a === gM && b === gmL) miF = true;
      if (a === gM && b === gmL && c === gp) paF = true;
    }
    if (mF) stats.M++;
    if (miF) stats.m++;
    if (paF) stats.p++;
    stats.wM.push(majors.size);
    stats.wMm.push(minors.size);
    stats.wMmp.push(patches.size);
  }

  const vLDC = newVer();
  const vALE = newVer();
  const vDEB = newVer();

  for (const [site, gts] of gt) {
    const ldcV = ldcVerMap.get(site) ?? new Map<string, string>();
    const aleSiteMap = aleBySite.get(site) ?? new Map<string, Set<string>>();
    const debunSiteMap = debunBySite.get(site) ?? new Map<string, Set<string>>();
    for (const [lib, gtVer] of gts) {
      if (!gtVer) continue;
      // LDC: only consider entries with a version emitted (skip lib-only)
      if (ldcV.has(lib)) {
        const ldcVer = ldcV.get(lib);
        if (ldcVer) {
          const expanded = expandPrefix(lib, ldcVer);
          checkVer(vLDC, gtVer, expanded.size > 0 ? expanded : new Set([ldcVer]));
        }
      }
      if (aleSiteMap.has(lib)) checkVer(vALE, gtVer, aleSiteMap.get(lib)!);
      if (debunSiteMap.has(lib)) checkVer(vDEB, gtVer, debunSiteMap.get(lib)!);
    }
  }

  // ── per-library counts (for the scorer-ablation Table 2c) ──
  const debunPerLib: Record<string, number> = {};
  const groundPerLib: Record<string, number> = {};
  for (const [site, gts] of gt) {
    const det = debunBySite.get(site) ?? new Map<string, Set<string>>();
    for (const lib of gts.keys()) {
      groundPerLib[lib] = (groundPerLib[lib] ?? 0) + 1;
      if (det.has(lib)) debunPerLib[lib] = (debunPerLib[lib] ?? 0) + 1;
    }
  }

  // ── per-(site,lib) true-positive sets, for the RQ3 Venn diagram ──
  // A pair is a TP for a detector when the detector reports the library on the
  // site and the ground truth agrees. Same universe and canonicalization as
  // libMetrics, so the region counts always add up to the TP column above.
  const tpPairs: Record<string, Set<string>> = {
    LDC: new Set(), PTDetector: new Set(), dbundler: new Set(), DEBUN: new Set(),
  };
  const tpSources: Array<[string, (s: string) => Set<string>]> = [
    ['LDC', ldcLibDetected], ['PTDetector', ptLibDetected],
    ['dbundler', dbLibDetected], ['DEBUN', debunLibDetected],
  ];
  for (const site of evalSites) {
    const gts = gt.get(site);
    if (!gts || gts.size === 0) continue;
    for (const [name, detected] of tpSources) {
      const det = detected(site);
      for (const lib of universe) {
        if (gts.has(lib) && det.has(lib)) tpPairs[name].add(`${site}\t${lib}`);
      }
    }
  }

  const gtInstancesAll = Object.values(groundPerLib).reduce((a, b) => a + b, 0);
  const gtInstances = [...trainedLibs].reduce((a, l) => a + (groundPerLib[l] ?? 0), 0);

  return {
    lib: {
      LDC: M_LDC,
      PTDetector: M_PT,
      dbundler: M_DB,
      dbundlerTrained: M_DB_TRAINED,
      DEBUN: M_DEB,
    },
    version: { LDC: vLDC, Aletheia: vALE, DEBUN: vDEB },
    perLib: { DEBUN: debunPerLib, ground: groundPerLib },
    dbundlrScope: { libs: [...trainedLibs].sort(), gtInstances, gtInstancesAll },
    tpPairs: Object.fromEntries(Object.entries(tpPairs).map(([k, v]) => [k, [...v].sort()])),
  };
}

// ── standalone printing ──
function printResult(res: CompareResult): void {
  const fmt = (m: LibMetric) =>
    `P=${precision(m).toFixed(4)} R=${recall(m).toFixed(4)} F1=${f1(m).toFixed(4)} ` +
    `TP=${m.tp} FP=${m.fp} FN=${m.fn} TN=${m.tn}`;
  console.log('=== Lib-level (against GT, on eval sites) ===');
  console.log(`LDC         : ${fmt(res.lib.LDC)}`);
  console.log(`PTDetector  : ${fmt(res.lib.PTDetector)}`);
  console.log(`D-Bundlr    : ${fmt(res.lib.dbundler)}`);
  console.log(`D-Bundlr*   : ${fmt(res.lib.dbundlerTrained)}`);
  console.log(`DEBUN       : ${fmt(res.lib.DEBUN)}`);
  console.log(
    `  * restricted to the ${res.dbundlrScope.libs.length} libraries D-Bundlr was trained on ` +
    `(${res.dbundlrScope.gtInstances}/${res.dbundlrScope.gtInstancesAll} GT instances)`
  );
  const fmtVer = (name: string, v: VerStats) =>
    console.log(
      `${name.padEnd(12)} TP=${v.tp}  ` +
      `Major=${v.M} (avg=${avg(v.wM).toFixed(2)})  ` +
      `Minor=${v.m} (avg=${avg(v.wMm).toFixed(2)})  ` +
      `Patch=${v.p} (avg=${avg(v.wMmp).toFixed(2)})`
    );
  console.log('');
  console.log('=== Version-level (TP rows with gtVersion known; partial LDC versions expanded) ===');
  fmtVer('LDC', res.version.LDC);
  fmtVer('Aletheia', res.version.Aletheia);
  fmtVer('DEBUN', res.version.DEBUN);
  console.log('(PTDetector and D-Bundlr do not emit versions; omitted)');
}

// ── Venn region counts (figures-bundle/rq1-venn4.csv) ──
// Every (site, lib) true positive falls in exactly one of the 15 non-empty
// membership patterns over the four detectors, so the region counts partition
// the union and each detector's regions sum to its TP column.
function writeVennCsv(res: CompareResult, out: string): void {
  const order = ['LDC', 'PTDetector', 'dbundler', 'DEBUN'];
  const sets = order.map((k) => new Set(res.tpPairs[k] ?? []));
  const union = new Set<string>(sets.flatMap((s) => [...s]));
  const counts = new Map<string, number>();
  for (const pair of union) {
    const key = sets.map((s) => (s.has(pair) ? 1 : 0)).join(',');
    counts.set(key, (counts.get(key) ?? 0) + 1);
  }
  const lines = ['ldc,pt,dbundlr,debun,count'];
  for (const [key, n] of [...counts].sort((a, b) => b[1] - a[1])) {
    lines.push(`${key},${n}`);
  }
  fs.mkdirSync(path.dirname(out), { recursive: true });
  fs.writeFileSync(out, lines.join('\n') + '\n');
  console.log(`\n[out] ${out}`);
  for (const [i, k] of order.entries()) {
    console.log(`  ${k.padEnd(11)} venn sum = ${sets[i].size}`);
  }
}

if (require.main === module) {
  const res = runCompareDetectors();
  printResult(res);
  const i = process.argv.indexOf('--venn-csv');
  if (i >= 0) writeVennCsv(res, process.argv[i + 1] ?? 'rq1-venn4.csv');
}
