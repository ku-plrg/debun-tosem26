/**
 * Performance — paper RQ1, Table 1.
 *
 * Detection cost per website on the 56 sites among the Tranco top 100 where all six tools
 * run. DEBUN's column is measured here whenever the hash databases are built; the five
 * baseline columns are read from the stored per-site measurements under `results/`, because
 * re-running them needs the baselines' own environments (a browser with three extensions for
 * LDC / PTdetector / PTV, a GraphCodeBERT server for D-Bundlr, a built dolospy for Aletheia)
 * and about nine hours. `README.md` in this directory documents that harness.
 *
 *   ./debun.sh run RQ1              # all 56 sites (~3 min once the index is loaded)
 *   RQ1_SITES=5 ./debun.sh run RQ1  # quick check on the first 5
 *
 * Setup for the static tools is one crawl shared by all three. Two crawls that returned no
 * file are excluded: their duration measures the failure, not the cost.
 */
import { execFileSync } from 'child_process';
import fs from 'fs';
import path from 'path';

const ROOT = process.cwd();
const RESULTS = path.join(ROOT, 'src/evaluation/rq1-performance/results');
const WORK = path.join(ROOT, 'src/evaluation/rq1-performance/work');

type Row = Record<string, string>;

function readCsv(file: string): Row[] {
  const lines = fs.readFileSync(file, 'utf-8').trim().split('\n');
  const head = lines[0].split(',');
  return lines.slice(1).map((l) => {
    const cells = l.split(',');
    return Object.fromEntries(head.map((h, i) => [h, cells[i]])) as Row;
  });
}

const readJson = <T>(name: string): T =>
  JSON.parse(fs.readFileSync(path.join(RESULTS, name), 'utf-8')) as T;

const mean = (xs: number[]): number => xs.reduce((a, b) => a + b, 0) / xs.length;
function median(xs: number[]): number {
  const s = [...xs].sort((a, b) => a - b);
  const m = s.length >> 1;
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
}

export default async function runPerf(): Promise<void> {
  const sites: string[] = readJson('common_set.json');
  const limit = parseInt(process.env['RQ1_SITES'] ?? '0', 10);
  const target = limit > 0 ? sites.slice(0, limit) : sites;
  const partial = target.length < sites.length;

  console.log(
    `\n=== Performance (run RQ1; paper RQ1) — paper Table 1 ===\n` +
    `DEBUN on ${target.length} of the ${sites.length} six-tool sites` +
    `${partial ? ' (RQ1_SITES set — a subset, not the paper number)' : ''} …`
  );

  // DEBUN's row comes from the real detector, which reads the hash databases `build-db.sh`
  // constructs — the repository ships the summaries the other tables need, not the 213 MB
  // index. With the index present the run is live; without it the row is read from the same
  // stored measurement the five baseline rows already come from, and the table says so.
  // Measuring needs two things, and a reviewer normally has neither: the module-aware index
  // (download-files.sh) and the crawled scripts of these 56 sites, which are not redistributed
  // — the crawl is the Setup step of Table 1, and `./crawl-sites.sh` reproduces it.
  // Checking only the index would send a reviewer who ran download-files.sh into the bench and
  // crash it on the missing corpus.
  const cacheDir = process.env['FP_CACHE_DIR'] ?? 'src/data/fingerprint-cache';
  const siteDir = process.env['SITE_SRC_DIR'] ?? 'src/data/crawled';
  const haveIndex = fs.existsSync(path.join(ROOT, cacheDir, 'alllibs.json'));
  const crawled = target.filter((s) => fs.existsSync(path.join(ROOT, siteDir, s)));
  const measured = haveIndex && crawled.length === target.length;
  let bench: Row[];
  let benchSource: string;

  if (measured) {
    // Kept, not written to a temp file and deleted. The bench times eight phases per site —
    // parse / single-use / collector / POG / hash, then lookup / assemble / filter — and the
    // paper's Fig. 14 is that breakdown. Rolling them up to two numbers for the table and
    // then unlinking the file threw away the only copy of the figure's data. `bench-56.csv`
    // under results/ carries the same columns for the stored run.
    const benchOut = path.join(WORK, 'bench-live.csv');
    fs.mkdirSync(WORK, { recursive: true });
    // `node -r ts-node/register/transpile-only` rather than `npx ts-node`: the bench extracts
    // each site in a worker_thread, and the worker only resolves .ts if the register hook is
    // in the parent's execArgv for it to inherit. Launching through npx leaves execArgv empty
    // and the worker dies with ERR_UNKNOWN_FILE_EXTENSION.
    // --expose-gc lets the bench collect once before reading its resident baseline; without
    // it the index's build garbage is still on the heap and the memory figures read ~4x too
    // high. It does not force per-site collections, so the timings stay untouched.
    execFileSync(
      process.execPath,
      ['--expose-gc', '-r', 'ts-node/register/transpile-only', 'src/evaluation/web-detect-bench.ts'],
      {
        cwd: ROOT,
        stdio: ['ignore', 'inherit', 'inherit'],
        env: {
          ...process.env,
          TS_NODE_TRANSPILE_ONLY: '1',
          SITE_SRC_DIR: siteDir,
          SITE_FILTER: target.join(','),
          FP_CACHE_DIR: cacheDir,
          MATCH_THRESHOLD: process.env['MATCH_THRESHOLD'] ?? '84',
          BENCH_OUTPUT: benchOut,
        },
      }
    );
    bench = readCsv(benchOut);
    benchSource = benchOut;
  } else {
    console.log(
      `  DEBUN is reported from its stored run too — ` +
      (!haveIndex
        ? `${cacheDir}/alllibs.json is absent (run ./download-files.sh).`
        : `only ${crawled.length} of ${target.length} sites are under ${siteDir} ` +
          `(crawl them with ./crawl-sites.sh).`)
    );
    benchSource = path.join(RESULTS, 'bench-56.csv');
    bench = readCsv(benchSource);
  }

  // Baselines: stored per-site measurements.
  const rt = new Map(
    readJson<{ rows: Array<Record<string, any>> }>('stage3c_100.json').rows.map((r) => [r.site, r])
  );
  const st2 = new Map(
    readJson<{ rows: Array<Record<string, any>> }>('stage2_full.json').rows.map((r) => [r.site, r])
  );

  // A crawl that ended with no file is a failed crawl, not a fast one.
  const crawl = new Map<string, number>();
  for (const src of ['crawl100.json', 'crawl_timing.json']) {
    const p = path.join(RESULTS, src);
    if (!fs.existsSync(p)) continue;
    for (const r of readJson<{ rows: Array<Record<string, any>> }>(src).rows) {
      if (!r.crawlMs) continue;
      if (!r.files) { crawl.delete(r.site); continue; }
      crawl.set(r.site, r.crawlMs);
    }
  }

  const benchBySite = new Map(bench.map((r) => [r['site'], r]));
  const pick = (f: (s: string) => number | undefined): number[] =>
    sites.map(f).filter((x): x is number => x !== undefined);

  const cols: Array<[string, number[], number[]]> = [
    ['LDC', pick((s) => crawlOrNull(rt.get(s)?.ldc?.pageLoadMs)), pick((s) => rt.get(s)?.ldc?.computeMs)],
    ['PTdetector', pick((s) => crawlOrNull(rt.get(s)?.ptdetector?.pageLoadMs)), pick((s) => rt.get(s)?.ptdetector?.computeMs)],
    ['PTV', pick((s) => crawlOrNull(rt.get(s)?.ptv?.pageLoadMs)), pick((s) => rt.get(s)?.ptv?.computeMs)],
    ['D-Bundlr', pick((s) => crawl.get(s)), pick((s) => st2.get(s)?.dbundlrMs)],
    ['Aletheia', pick((s) => crawl.get(s)), pick((s) => st2.get(s)?.aletheiaMs)],
    ['DEBUN', pick((s) => crawl.get(s)),
      // measured this run; over the subset when RQ1_SITES is set
      target.map((s) => Number(benchBySite.get(s)?.['totalMs'])).filter((x) => !isNaN(x))],
  ];

  const table: Record<string, Record<string, string>> = { 'Setup (s)': {}, 'Detection (s)': {}, 'Total (s)': {} };
  for (const [name, setup, detect] of cols) {
    const s = mean(setup) / 1000;
    const d = mean(detect) / 1000;
    table['Setup (s)'][name] = s.toFixed(2);
    table['Detection (s)'][name] = d.toFixed(2);
    table['Total (s)'][name] = (s + d).toFixed(2);
  }
  console.table(table);

  const dTotal = cols[5][2];
  const hash = target.map((s) => Number(benchBySite.get(s)?.['hashTotalMs'])).filter((x) => !isNaN(x));
  const det = target.map((s) => Number(benchBySite.get(s)?.['detectTotalMs'])).filter((x) => !isNaN(x));
  const rss = target.map((s) => Number(benchBySite.get(s)?.['peakRssMB'])).filter((x) => !isNaN(x));
  console.log(
    `DEBUN, ${measured ? 'measured' : 'stored'}, ${dTotal.length} site(s): ${mean(dTotal).toFixed(1)} ms mean ` +
    `(median ${median(dTotal).toFixed(1)}) = ${mean(hash).toFixed(1)} ms fingerprinting + ` +
    `${mean(det).toFixed(1)} ms library detection (${((100 * mean(det)) / mean(dTotal)).toFixed(0)}% detector)`
  );
  console.log(
    `  peak RSS ${mean(rss).toFixed(0)} MB mean, ${Math.max(...rss).toFixed(0)} MB max` +
    `${measured ? ' — see the [mem] line above for the live index size' : ''}`
  );
  console.log(
    `  per-site, per-phase timings (paper Fig. 14): ${path.relative(ROOT, benchSource)} — ` +
    `parseMs, scMs, collectorMs, pogMs, hashMs then lookupMs, assembleMs, filterMs`
  );
  console.log(
    `* Baseline columns are the stored measurements in src/evaluation/rq1-performance/results/; ` +
    `re-running them needs each tool's own environment and about nine hours. DEBUN is ` +
    `${measured ? 'measured by this run' : 'stored as well (no index present)'}. Setup is shared by the three ` +
    `static tools and excludes two crawls that returned no file. ` +
    `src/evaluation/rq1-performance/README.md documents the harness.`
  );
  if (partial) {
    console.log(`\n! RQ1_SITES=${limit} — DEBUN's column is a ${limit}-site subset. Unset it for the paper number.`);
  }
}

/** pageLoadMs is absent when a runtime tool failed on that site; drop rather than count as 0. */
function crawlOrNull(v: unknown): number | undefined {
  return typeof v === 'number' ? v : undefined;
}
