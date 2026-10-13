/**
 * Measure Setup (crawl) time for the sites in the common set that have no recorded time.
 *
 * Reads results/common_set.json and results/crawl100.json, crawls whatever is missing a
 * crawlMs into a throwaway root, and writes work/crawl_timing.json. Idempotent: sites
 * already in the output are skipped, so an interrupted run can be resumed.
 *
 *   npx ts-node --transpile-only <this> --out src/evaluation/rq1-performance/work/crawl_timing.json
 */
import { execFileSync } from 'child_process';
import fs from 'fs';
import path from 'path';

// scripts → perf → evaluation → src → repo root; the crawl child needs the root as cwd.
const ART = path.join(__dirname, '../../../..');
const PERF = path.join(ART, 'src/evaluation/rq1-performance');
const RESULTS = path.join(PERF, 'results');
const OUTDIR = path.join(PERF, 'work');
const TSNODE_OPTS =
  '{"module":"CommonJS","moduleResolution":"Node","esModuleInterop":true,"target":"ES2020"}';

function arg(n: string, d: string): string {
  const i = process.argv.indexOf('--' + n);
  return i >= 0 ? process.argv[i + 1] : d;
}
const OUT = arg('out', path.join(OUTDIR, 'crawl_timing.json'));
// Empty means crawl_timing_one.ts picks its own default root. It is resolved against src/,
// not the repo root, because crawler.ts joins it onto __dirname/'../'.
const ROOT = arg('root', '');
// --all re-measures every site in the common set, not only the ones results/ has no time for.
// Repeated Setup measurement needs the whole set each pass; the default stays incremental.
const ALL = process.argv.includes('--all');
fs.mkdirSync(path.dirname(OUT), { recursive: true });

// --sites narrows the set to a JSON list of site names; without it, the whole common set.
// A repeated Setup measurement has to crawl the same sites the Detection stages measure, and
// a smoke test has to be able to crawl two of them.
const SITES_FILE = arg('sites', '');
const common: string[] = JSON.parse(
  fs.readFileSync(SITES_FILE || path.join(RESULTS, 'common_set.json'), 'utf-8')
);
const prior: Record<string, number> = {};
for (const r of JSON.parse(fs.readFileSync(path.join(RESULTS, 'crawl100.json'), 'utf-8')).rows) {
  if (typeof r.crawlMs === 'number') prior[r.site] = r.crawlMs;
}

type Row = { site: string; crawlMs?: number; files?: number; crawlError?: string; error?: string };
const rows: Row[] = fs.existsSync(OUT) ? JSON.parse(fs.readFileSync(OUT, 'utf-8')).rows : [];
const done = new Set(rows.map((r) => r.site));
const todo = common.filter((s) => (ALL || !(s in prior)) && !done.has(s));
console.log(`common set ${common.length}; already timed ${common.filter((s) => s in prior).length}; to crawl ${todo.length}${ALL ? ' (--all)' : ''}${ROOT ? ` into src/${ROOT}` : ''}`);

for (let i = 0; i < todo.length; i++) {
  const site = todo[i];
  const row: Row = { site };
  try {
    const stdout = execFileSync(
      'npx',
      ['ts-node', '--transpile-only', path.join(__dirname, 'crawl_timing_one.ts'), site,
        ...(ROOT ? [ROOT] : [])],
      { encoding: 'utf-8', cwd: ART, timeout: 240000, maxBuffer: 64 * 1024 * 1024,
        env: { ...process.env, TS_NODE_COMPILER_OPTIONS: TSNODE_OPTS } }
    );
    const k = stdout.lastIndexOf('__RESULT__');
    if (k < 0) throw new Error('no result marker from crawl child');
    const res = JSON.parse(stdout.slice(k + '__RESULT__'.length).trim());
    row.crawlMs = res.crawlMs;
    row.files = res.filePaths.length;
    if (res.error) row.crawlError = res.error;
    console.log(`[${i + 1}/${todo.length}] ${site.padEnd(20)} ${row.crawlMs}ms files=${row.files}` +
      (row.crawlError ? ` [${row.crawlError.slice(0, 40)}]` : ''));
  } catch (e) {
    row.error = String((e as Error)?.message ?? e).split('\n')[0];
    console.log(`[${i + 1}/${todo.length}] ${site.padEnd(20)} FAILED: ${row.error.slice(0, 60)}`);
  }
  rows.push(row);
  fs.writeFileSync(OUT, JSON.stringify({ rows }, null, 1));
}

console.log(`wrote ${OUT}`);
