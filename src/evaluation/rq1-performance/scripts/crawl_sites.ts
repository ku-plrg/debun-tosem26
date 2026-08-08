/**
 * Crawl websites into src/data/crawled/, one child process per site.
 *
 * This is the shared acquisition step for the three static tools (DEBUN, D-Bundlr,
 * Aletheia) and is timed separately from any tool's analysis. Sites already present
 * under src/data/crawled/ are skipped, so an interrupted run resumes.
 *
 * Two site lists. `--from <json>` takes an array of domains — use it with the 56-site
 * common set to re-crawl exactly what Table 1 is measured on, which needs no external
 * input. `--sites N` re-derives the top N from a Tranco snapshot instead; that list is
 * not redistributed, so point TRANCO_CSV at a `rank,domain` CSV (the measurement used
 * the 2026-01-04 snapshot from https://tranco-list.eu).
 *
 *   npx ts-node --transpile-only <this> --from <common_set.json> --out work/crawl.json
 *   TRANCO_CSV=tranco.csv npx ts-node --transpile-only <this> --sites 100 --out …
 *
 * `./crawl-sites.sh` at the repo root wraps the first form.
 */
import { execFileSync } from 'child_process';
import fs from 'fs';
import path from 'path';

// scripts → perf → evaluation → src → repo root. The crawler resolves its output
// against src/, so it must be launched with the repo root as cwd.
const ART = path.join(__dirname, '../../../..');
const CRAWLED = path.join(ART, 'src/data/crawled');
const PERF = path.join(ART, 'src/evaluation/rq1-performance');
const TSNODE_OPTS =
  '{"module":"CommonJS","moduleResolution":"Node","esModuleInterop":true,"target":"ES2020"}';

function arg(n: string, d: string): string {
  const i = process.argv.indexOf('--' + n);
  return i >= 0 ? process.argv[i + 1] : d;
}
const FROM = arg('from', '');
const N = parseInt(arg('sites', '100'), 10);
const OUT = arg('out', path.join(PERF, 'work/crawl.json'));

const sites: string[] = FROM
  ? (JSON.parse(fs.readFileSync(FROM, 'utf-8')) as string[]).slice(0, N)
  : (fs
      .readFileSync(process.env.TRANCO_CSV ?? path.join(PERF, 'tranco.csv'), 'utf-8')
      .split('\n')
      .slice(0, N)
      .map((l) => l.split(',')[1]?.trim())
      .filter(Boolean) as string[]);

fs.mkdirSync(path.dirname(OUT), { recursive: true });

function walk(dir: string, acc: string[] = []): string[] {
  let entries: fs.Dirent[];
  try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return acc; }
  for (const e of entries) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) walk(p, acc);
    else if (e.isFile()) acc.push(p);
  }
  return acc;
}

type Row = { rank: number; site: string; crawlMs?: number; crawlError?: string;
             files?: number; skipped?: boolean; error?: string };

const rows: Row[] = [];
for (let i = 0; i < sites.length; i++) {
  const site = sites[i];
  const row: Row = { rank: i + 1, site };
  const existing = walk(path.join(CRAWLED, site));
  if (existing.length > 0) {
    row.skipped = true;
    row.files = existing.length;
    console.log(`[${i + 1}/${sites.length}] ${site.padEnd(26)} skip (already crawled, ${existing.length} files)`);
  } else {
    try {
      const stdout = execFileSync(
        'npx',
        ['ts-node', '--transpile-only', path.join(__dirname, 'crawl_one.ts'), site],
        { encoding: 'utf-8', cwd: ART, timeout: 240000, maxBuffer: 64 * 1024 * 1024,
          env: { ...process.env, TS_NODE_COMPILER_OPTIONS: TSNODE_OPTS } }
      );
      const k = stdout.lastIndexOf('__RESULT__');
      if (k < 0) throw new Error('no result marker from crawl child');
      const res = JSON.parse(stdout.slice(k + '__RESULT__'.length).trim());
      row.crawlMs = res.crawlMs;
      if (res.error) row.crawlError = res.error;
      row.files = res.filePaths.length;
      console.log(`[${i + 1}/${sites.length}] ${site.padEnd(26)} ${row.crawlMs}ms files=${row.files}` +
        (row.crawlError ? ` [${row.crawlError.slice(0, 40)}]` : ''));
    } catch (e) {
      row.error = String((e as Error)?.message ?? e).split('\n')[0];
      console.log(`[${i + 1}/${sites.length}] ${site.padEnd(26)} FAILED: ${row.error.slice(0, 60)}`);
    }
  }
  rows.push(row);
  fs.writeFileSync(OUT, JSON.stringify({ rows }, null, 1));
}

const withJs = rows.filter((r) => (r.files ?? 0) > 0);
console.log(`\nsites with JS: ${withJs.length}/${rows.length}`);
console.log(`wrote ${OUT}`);
