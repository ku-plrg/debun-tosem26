import escodegen from 'escodegen';
import fs from 'fs';
import { ESTree } from 'meriyah';
import path from 'path';
import readline from 'readline';
import extractFunctions from '../../fingerprint-collector/function-collector';
import { generatePOGHash } from '../../fingerprint-collector/hash-function';
import { extractPOG } from '../../fingerprint-collector/pog-generator';
import { Function as Func, POGAnalysisOptions, POGHash } from '../../types/pog';
import { getPropertyCnthash } from './property-cnt';
import {
  runCompareDetectors,
  precision,
  recall,
  f1,
  LibMetric,
  VerStats,
} from '../../cmd/compare-detectors';
import { runOldScore } from '../../cmd/rq1-old-score';

const INLINE_ENABLED = !['0', 'false', 'off', 'no'].includes(
  (process.env.RQ1_INLINE || '1').toLowerCase()
);
const RUN_SUFFIX = INLINE_ENABLED ? '' : '-no-inline';

const VALID_TYPES = ['original', 'swc', 'terser'] as const;
type ExtractType = (typeof VALID_TYPES)[number];

const RQ1_SCORE_ONLY = ['1', 'true', 'yes', 'on'].includes(
  (process.env.RQ1_SCORE_ONLY || '').toLowerCase()
);
const RQ1_TYPE_RAW = process.env.RQ1_TYPE;

function selectedTypes(): ExtractType[] {
  if (!RQ1_TYPE_RAW) return [...VALID_TYPES];
  const requested = RQ1_TYPE_RAW.split(',')
    .map((s) => s.trim())
    .filter(Boolean);
  const invalid = requested.filter(
    (t) => !VALID_TYPES.includes(t as ExtractType)
  );
  if (invalid.length > 0) {
    throw new Error(
      `Invalid RQ1_TYPE: ${invalid.join(',')}. Valid: ${VALID_TYPES.join(',')}`
    );
  }
  return requested as ExtractType[];
}

function getAllFiles(dirPath: string, basePath: string = dirPath) {
  const entries = fs.readdirSync(dirPath, { withFileTypes: true });
  let result: string[] = [];
  for (const entry of entries) {
    const fullPath = path.join(dirPath, entry.name);
    const relativePath = path.relative(basePath, fullPath);
    if (entry.isFile()) result.push(relativePath);
    else if (entry.isDirectory())
      result = result.concat(getAllFiles(fullPath, basePath));
  }
  return result;
}

function countLines(str: string) {
  return str.split('\n').length;
}

// Reproduce the pre-refactor measurement exactly: function-collector used to
// store func.body as `{...funcNode, body: { type:'BlockStatement', body:[originalBody] }}`
// for non-arrow-expression functions, then escodegen would emit
// `function name(params) { { ...originalBody... } }`. The extra inner `{ }`
// pair contributed 2 lines per function, and multi-line parameter lists added
// further lines. We reproduce both by reusing the captured signature
// (id/params/async/generator/funcType) and double-wrapping the BlockStatement.
function countMainFunctionLines(func: Func): number {
  const sig = func.sig;
  const isArrowExpression = sig?.type === 'ArrowFunctionExpression' && sig.expression;
  let wrapped: ESTree.Node;
  if (isArrowExpression) {
    // Old code's arrow-expression branch did NOT double-wrap.
    wrapped = {
      type: 'ArrowFunctionExpression',
      id: sig?.id ?? null,
      params: sig?.params ?? [],
      generator: false,
      async: sig?.async ?? false,
      expression: true,
      body: func.body as ESTree.Expression,
    } as ESTree.ArrowFunctionExpression;
  } else {
    const doubleWrapped: ESTree.BlockStatement = {
      type: 'BlockStatement',
      body: [func.body as ESTree.Statement],
    };
    wrapped = {
      type: sig?.type ?? 'FunctionExpression',
      id: sig?.id ?? null,
      params: sig?.params ?? [],
      generator: sig?.generator ?? false,
      async: sig?.async ?? false,
      body: doubleWrapped,
    } as ESTree.FunctionExpression;
  }
  return countLines(escodegen.generate(wrapped));
}

// Base options. literalProperty / skipArguments / assignmentPropagation are
// always on; the four toggles (flipping, bypassing, cloning, inlining) are
// added incrementally per config.
const BASE: POGAnalysisOptions = {
  branchFlipping: false,
  branchBypassing: false,
  pathCloning: false,
  inlining: false,
  literalProperty: true,
  skipArguments: true,
  assignmentPropagation: true,
};

function pogHash(f: Func, overrides: Partial<POGAnalysisOptions>): POGHash {
  const opts = { ...BASE, ...overrides };
  const cfg = extractPOG(f, opts);
  return generatePOGHash({ body: f.body, graph: cfg.nodes });
}

const hashOneFunc: Record<string, (f: Func) => POGHash> = {
  // A: Count
  A: (f: Func) => getPropertyCnthash(undefined, f.body),
  // B: Base POG (no toggles)
  B: (f: Func) => pogHash(f, {}),
  // C: + branchFlipping
  C: (f: Func) => pogHash(f, { branchFlipping: true }),
  // D: + branchBypassing
  D: (f: Func) =>
    pogHash(f, { branchFlipping: true, branchBypassing: true }),
  // E: + pathCloning
  E: (f: Func) =>
    pogHash(f, { branchFlipping: true, branchBypassing: true, pathCloning: true }),
  // F: + inlining
  F: (f: Func) =>
    pogHash(f, { branchFlipping: true, branchBypassing: true, pathCloning: true, inlining: true }),
};

const HASH_KEYS = Object.keys(hashOneFunc);
const NUM_CONFIGS = HASH_KEYS.length;

// Configs that require the inlined function set (singleCallBody populated).
const INLINE_KEYS = new Set(['F']);

function dataPath(name: string) {
  return path.join(__dirname, `../../data/${name}${RUN_SUFFIX}.log`);
}

const validFunc = (f: Func) =>
  f.id !== undefined && !f.id.startsWith('JSCA_null');

const DIAG_PATH = path.join(__dirname, `../../data/ablation-diag${RUN_SUFFIX}.log`);
const diagStream = fs.createWriteStream(DIAG_PATH, { flags: 'w' });
function diag(msg: string): void {
  diagStream.write(msg + '\n');
}

function extractHash(type: string) {
  const allFiles = getAllFiles(path.join(__dirname, `../../data/${type}`));
  const filename = dataPath(type);
  const buffer: string[] = [];
  buffer.push(
    `idx,${HASH_KEYS.map((k) => `nodes${k},hash${k}`).join(',')},loc,funcCountAll,funcCountInlined`
  );
  allFiles.forEach((filePath) => {
    const raw = fs.readFileSync(
      path.join(__dirname, `../../data/${type}`, filePath),
      'utf-8'
    );
    try {
      // Two function sets: all (inline=false) and inlined (inline=true, SC excluded)
      const funcsAll = extractFunctions(raw, false);
      const funcsInlined = extractFunctions(raw, true);
      const inlinedById = new Map<string, Func>();
      for (const f of funcsInlined) if (f.id) inlinedById.set(f.id, f);

      const funcCountAll = funcsAll.filter(validFunc).length;
      const funcCountInlined = funcsInlined.filter(validFunc).length;

      funcsAll.filter(validFunc).forEach((f) => {
        const fInlined = f.id ? inlinedById.get(f.id) : undefined;
        const res = HASH_KEYS.map((key) => {
          try {
            if (INLINE_KEYS.has(key)) {
              if (!fInlined) return { nodes: 0, hash: '' } as POGHash;
              return hashOneFunc[key](fInlined);
            }
            return hashOneFunc[key](f);
          } catch (e) {
            const target = INLINE_KEYS.has(key) ? fInlined : f;
            const icbSize = target?.singleCallBody?.size ?? 0;
            diag(
              `[HASH FAIL] type=${type} file=${filePath} id=${f.id} name=${f.name ?? ''} key=${key} inlineMap=${icbSize}`
            );
            diag(
              `  err=${(e as Error)?.message ?? String(e)}\n  stack=${((e as Error)?.stack ?? '').split('\n').slice(0, 6).join(' | ')}`
            );
            return { nodes: 0, hash: '' } as POGHash;
          }
        });
        const lines = type === 'original' ? countMainFunctionLines(f) : '';
        buffer.push(
          `${f.id},${res
            .map((r) => `${r.nodes},${r.hash}`)
            .join(',')},${lines},${funcCountAll},${funcCountInlined}`
        );
      });
    } catch (e) {
      diag(
        `[FILE FAIL] type=${type} file=${filePath} err=${(e as Error)?.message ?? String(e)}`
      );
      diag(
        `  stack=${((e as Error)?.stack ?? '').split('\n').slice(0, 6).join(' | ')}`
      );
    }
  });
  fs.writeFileSync(filename, buffer.join('\n') + '\n');
}

function getExitCondition(value: number, threshold: number): boolean {
  return value < threshold;
}

async function processLogFile(
  filePath: string,
  callback: (line: string) => void
) {
  const fileStream = fs.createReadStream(filePath);

  const rl = readline.createInterface({
    input: fileStream,
    crlfDelay: Infinity, // Windows CRLF (\r\n)도 정상 처리
  });

  for await (const line of rl) {
    callback(line);
  }
}

type LogRow = {
  idx: string;
  hashes: string[];
  loc: number;
  funcCountAll: number;
  funcCountInlined: number;
};

async function loadLog(filePath: string): Promise<LogRow[]> {
  const rows: LogRow[] = [];
  await processLogFile(filePath, (line: string) => {
    const parts = line.split(',');
    const idx = parts[0];
    if (!idx || !idx.startsWith('JSCA')) return;
    // CSV layout: idx, (nodes_i, hash_i) × NUM_CONFIGS, loc, funcCountAll, funcCountInlined
    const hashes: string[] = [];
    for (let i = 0; i < NUM_CONFIGS; i++) {
      hashes.push(parts[2 + i * 2]); // hash column for config i
    }
    const locIdx = 1 + NUM_CONFIGS * 2;
    const loc = parts[locIdx] ? +parts[locIdx] : 0;
    const funcCountAll = parts[locIdx + 1] ? +parts[locIdx + 1] : 0;
    const funcCountInlined = parts[locIdx + 2] ? +parts[locIdx + 2] : 0;
    rows.push({ idx, hashes, loc, funcCountAll, funcCountInlined });
  });
  return rows;
}

const processRq3 = (
  originalRows: LogRow[],
  swcRows: LogRow[],
  terserRows: LogRow[],
  LOC_THRESHOLD: number
) => {
  const N = NUM_CONFIGS;
  const swcMaps: Array<Record<string, string>> = Array.from({ length: N }, () => ({}));
  const terserMaps: Array<Record<string, string>> = Array.from({ length: N }, () => ({}));
  const cnts: Array<Record<string, number>> = Array.from({ length: N }, () => ({}));
  const locMap: Record<string, number> = {};

  let allFunctionCount = 0;
  let allFunctionCountInlined = 0;
  const allMatchCnts = new Array(N).fill(0);
  let minifiedFunctionCount = 0;
  let minifiedFunctionCountInlined = 0;
  const bothTrueMatchCnts = new Array(N).fill(0);

  // 1. loc map
  for (const r of originalRows) {
    locMap[r.idx] = r.loc;
  }

  // 2. swc map
  for (const r of swcRows) {
    const loc = locMap[r.idx];
    if (loc === undefined || getExitCondition(loc, LOC_THRESHOLD)) continue;
    for (let i = 0; i < N; i++) swcMaps[i][r.idx] = r.hashes[i];
  }

  // 3. terser map
  for (const r of terserRows) {
    const loc = locMap[r.idx];
    if (loc === undefined || getExitCondition(loc, LOC_THRESHOLD)) continue;
    for (let i = 0; i < N; i++) terserMaps[i][r.idx] = r.hashes[i];
  }

  // Index of first inlined config — rows with non-empty hash here are in the inlined set
  const firstInlineIdx = HASH_KEYS.indexOf([...INLINE_KEYS][0]);

  // 4. counts over original
  for (const r of originalRows) {
    if (getExitCondition(r.loc, LOC_THRESHOLD)) continue;
    allFunctionCount++;
    if (r.hashes[firstInlineIdx]) allFunctionCountInlined++;
    for (let i = 0; i < N; i++) {
      const h = r.hashes[i];
      if (!h) continue;
      cnts[i][h] = (cnts[i][h] || 0) + 1;
    }
  }

  // 5. matches (skip empty hashes — SC functions excluded in inlined configs)
  for (const r of originalRows) {
    if (getExitCondition(r.loc, LOC_THRESHOLD)) continue;
    if (swcMaps[0][r.idx] && terserMaps[0][r.idx]) {
      minifiedFunctionCount++;
      if (r.hashes[firstInlineIdx]) minifiedFunctionCountInlined++;
    }
    for (let i = 0; i < N; i++) {
      const h = r.hashes[i];
      if (!h) continue;
      if (swcMaps[i][r.idx] === h && terserMaps[i][r.idx] === h)
        bothTrueMatchCnts[i]++;
      if (cnts[i][h]) allMatchCnts[i] += cnts[i][h];
    }
  }

  const result: Record<string, number> = {
    allFunctionCount,
    minifiedFunctionCount,
    allFunctionCountInlined,
    minifiedFunctionCountInlined,
  };
  for (let i = 0; i < N; i++) {
    const k = HASH_KEYS[i];
    result[`bothTrueMatchCnt${k}`] = bothTrueMatchCnts[i];
    result[`allMatchCnt${k}`] = allMatchCnts[i];
  }
  return result;
};

const scoreFilename = path.join(
  __dirname,
  `../../results/rq2-ablation/score${RUN_SUFFIX}.csv`
);
if (!fs.existsSync(path.dirname(scoreFilename))) {
  fs.mkdirSync(path.dirname(scoreFilename), { recursive: true });
}

const TYPE_LABEL: Record<ExtractType, string> = {
  original: 'Original',
  swc: 'SWC',
  terser: 'Terser',
};

const main = async () => {
  console.log(`RQ3 inline mode: ${INLINE_ENABLED ? 'on' : 'off'}`);

  if (RQ1_SCORE_ONLY) {
    console.log('RQ1_SCORE_ONLY=1 — skipping hash extraction.');
  } else {
    const types = selectedTypes();
    console.log('\n============ [PROCESS: HASH EXTRACTION] ============');
    console.log(`extracting types: ${types.join(', ')}`);
    for (const type of types) {
      console.log(`\nExtracting [${TYPE_LABEL[type]}] hash...`);
      console.time(`Time[${type}]`);
      extractHash(type);
      console.timeEnd(`Time[${type}]`);
    }

    // If RQ1_TYPE was set (subset run for parallel extraction), skip scoring.
    // Scoring needs all 3 logs — run separately with RQ1_SCORE_ONLY=1.
    if (RQ1_TYPE_RAW) {
      console.log(
        `\nRQ1_TYPE=${RQ1_TYPE_RAW} set — skipping scoring. ` +
          `After all 3 types are extracted, run again with RQ1_SCORE_ONLY=1.`
      );
      return;
    }
  }

  console.log('\n============ [PROCESS: SCORING] ============');
  console.time('Time[score]');
  console.time('Time[score:load]');
  const [originalRows, swcRows, terserRows] = await Promise.all([
    loadLog(dataPath('original')),
    loadLog(dataPath('swc')),
    loadLog(dataPath('terser')),
  ]);
  console.timeEnd('Time[score:load]');

  const locs = Array.from({ length: 30 }, (_, i) => i);
  const scoreHeader = [
    'LOC',
    'allFunctionCount',
    'minifiedFunctionCount',
    'allFunctionCountInlined',
    'minifiedFunctionCountInlined',
    ...HASH_KEYS.flatMap((k) => [`bothTrueMatchCnt${k}`, `allMatchCnt${k}`]),
  ].join(',');
  const scoreLines: string[] = [scoreHeader];
  for (const loc of locs) {
    console.log('processing', loc);
    const res = processRq3(originalRows, swcRows, terserRows, loc + 5);
    scoreLines.push(`${loc + 1},${Object.values(res).join(',')}`);
  }
  fs.writeFileSync(scoreFilename, scoreLines.join('\n') + '\n');
  console.timeEnd('Time[score]');
  console.log('done', scoreFilename);
};

export default main;

// ─────────────────────────────────────────────────────────────────────────────
// Ablation report wrappers (run RQ2; paper RQ2):
//   paper Table 2 (POG ablation) + Table 4 (library-scorer ablation) + Table 3 (POG models)
// ─────────────────────────────────────────────────────────────────────────────

const ABLATION_LABELS: Record<string, string> = {
  A: 'Count',
  B: 'POG',
  C: 'POG+F',
  D: 'POG+FB',
  E: 'POG+FBC',
  F: 'POG+FBCI',
};
const LOC_MIN = parseInt(process.env['RQ1_LOC'] ?? '6', 10);
const pct = (x: number): string => `${(x * 100).toFixed(2)}%`;
const avg = (a: number[]): number =>
  a.length ? a.reduce((x, y) => x + y, 0) / a.length : 0;

/** Ensure the per-LOC ablation score.csv exists (heavy: extracts + scores). */
async function ensureScoreCsv(): Promise<void> {
  const rebuild = ['1', 'true', 'yes', 'on'].includes(
    (process.env['REBUILD'] ?? '').toLowerCase()
  );
  if (rebuild || !fs.existsSync(scoreFilename)) {
    console.log('[RQ3] score.csv missing (or REBUILD set) — running ablation extraction…');
    await main();
  }
}

/** Paper Table 2 — POG ablation consistency/accuracy at LOC ≥ LOC_MIN. */
function printTable3(): void {
  const lines = fs.readFileSync(scoreFilename, 'utf8').trim().split('\n');
  const header = lines[0].split(',');
  const col = (name: string) => header.indexOf(name);
  const row = lines.slice(1).map((l) => l.split(','))
    .find((f) => +f[0] === LOC_MIN);
  if (!row) {
    console.error(`[RQ3] no LOC=${LOC_MIN} row in ${scoreFilename}`);
    return;
  }
  const num = (name: string) => Number(row[col(name)]);
  const funcsAll = num('allFunctionCount');
  const funcsInlined = num('allFunctionCountInlined');

  const table: Record<string, Record<string, string | number>> = {
    '# Consistent': {},
    '# Functions': {},
    Consistency: {},
    '# Duplicated': {},
    Accuracy: {},
  };
  for (const key of HASH_KEYS) {
    const label = ABLATION_LABELS[key] ?? key;
    const consistent = num(`bothTrueMatchCnt${key}`);
    const duplicated = num(`allMatchCnt${key}`);
    const funcs = key === 'F' ? funcsInlined : funcsAll;
    table['# Consistent'][label] = consistent;
    table['# Functions'][label] = funcs;
    table['Consistency'][label] = pct(funcs ? consistent / funcs : 0);
    table['# Duplicated'][label] = duplicated;
    table['Accuracy'][label] = pct(duplicated ? funcs / duplicated : 0);
  }
  console.log(`\n=== Ablation (run RQ2; paper RQ2) — POG ablation, paper Table 2 (LOC ≥ ${LOC_MIN}) ===`);
  console.table(table);
}

/** Paper Table 4 — uniform (score_u) vs module-dependency-aware (score_m) scorer. */
function printTable4(): void {
  // score_u: legacy uniform scorer at its best-F1 operating point (ψ = 15%),
  // unless THRESHOLD is overridden in the environment.
  if (!process.env['THRESHOLD']) process.env['THRESHOLD'] = '0.15';
  const su = runOldScore();
  const sm = runCompareDetectors();

  // 4a — library detection
  const libCols: Record<string, LibMetric> = { score_u: su.lib, score_m: sm.lib.DEBUN };
  const t4a: Record<string, Record<string, string | number>> = {};
  const addLib = (label: string, fn: (m: LibMetric) => string | number) => {
    t4a[label] = {};
    for (const [name, m] of Object.entries(libCols)) t4a[label][name] = fn(m);
  };
  addLib('TP', (m) => m.tp);
  addLib('FP', (m) => m.fp);
  addLib('FN', (m) => m.fn);
  addLib('Precision', (m) => pct(precision(m)));
  addLib('Recall', (m) => pct(recall(m)));
  addLib('F1-score', (m) => pct(f1(m)));

  // 4b — version detection
  const verCols: Record<string, VerStats> = { score_u: su.version, score_m: sm.version.DEBUN };
  const cell = (correct: number, range: number[]) => `${correct} (±${avg(range).toFixed(2)})`;
  const t4b: Record<string, Record<string, string>> = { Major: {}, Minor: {}, Patch: {} };
  for (const [name, v] of Object.entries(verCols)) {
    t4b['Major'][name] = cell(v.M, v.wM);
    t4b['Minor'][name] = cell(v.m, v.wMm);
    t4b['Patch'][name] = cell(v.p, v.wMmp);
  }

  // 4c — per-library detected counts
  const libs = ['react', 'core-js', 'lodash.js', 'jquery', 'preact', 'zepto'];
  const t4c: Record<string, Record<string, number>> = {};
  for (const lib of libs) {
    t4c[lib] = {
      score_u: su.perLibTP[lib] ?? 0,
      score_m: sm.perLib.DEBUN[lib] ?? 0,
      Ground: sm.perLib.ground[lib] ?? su.ground[lib] ?? 0,
    };
  }

  console.log(`\n=== Ablation (run RQ2; paper RQ2) — Library-scorer ablation, paper Table 4 (score_u @ ψ=${su.threshold}, score_m @ ψ=0.84) ===`);
  console.log('Table 4a — Library detection');
  console.table(t4a);
  console.log('Table 4b — Version detection (# correct ± avg candidate-range)');
  console.table(t4b);
  console.log('Table 4c — Detected libraries (per-library counts)');
  console.table(t4c);
}

/** `run RQ2` entry point: prints paper Tables 2, 4, and the POG-model detection (Table 3). */
export async function runRQ1(): Promise<void> {
  await ensureScoreCsv();
  printTable3();
  // Tables 3 and 4 rescore every website, so unlike the rest of this command they need the
  // hash databases `build-db.sh` constructs. Report that and carry on rather than aborting:
  // Table 2 and both figures come from files the repository ships.
  await attempt('paper Table 4 (library-scorer ablation)', async () => printTable4());
  await attempt('paper Table 3 (detection across POG models)', async () => {
    const { printModelDetection } = await import('./model-detection');
    printModelDetection();
  });
  const { printFig15, printFig16 } = await import('../figures');
  printFig15();
  printFig16();
}

async function attempt(what: string, fn: () => Promise<void>): Promise<void> {
  try {
    await fn();
  } catch (e) {
    const msg = (e as NodeJS.ErrnoException)?.code === 'ENOENT'
      ? `missing ${(e as NodeJS.ErrnoException).path?.replace(`${process.cwd()}/`, '')}`
      : String((e as Error)?.message ?? e).split('\n')[0];
    console.log(`\n(${what}: skipped — ${msg}.\n  Run ./download-files.sh; see "What each command needs" in README.md.)`);
  }
}
