/**
 * metrics-report.ts
 *
 * Run web-detect-eval at the given threshold and print precision/recall/F1.
 *
 * Usage:
 *   npx tsx src/evaluation/metrics-report.ts <threshold> [--per-lib] [--out=<dir>]
 *   npx tsx src/evaluation/metrics-report.ts --from=<existing-dir> [--per-lib]
 *
 * Examples:
 *   npx tsx src/evaluation/metrics-report.ts 86
 *   npx tsx src/evaluation/metrics-report.ts 86 --per-lib
 *   npx tsx src/evaluation/metrics-report.ts --from=data/eval-t86-n5u3 --per-lib
 *
 * Env (forwarded to web-detect-eval when running):
 *   MIN_POG_NODES         (default 5)
 *   FILE_DUP_MIN_HASHES   (default 1)
 *   NODE_OPTIONS          (default "--max-old-space-size=12288")
 */
import * as fs from 'fs';
import { join } from 'path';
import { spawnSync } from 'child_process';

interface LibMetric { precision: number; recall: number; f1: number; tp: number; fp: number; fn: number }
interface MetricsFile {
  threshold: number;
  overall: LibMetric & { tn: number };
  perLib: Record<string, LibMetric>;
}

const args = process.argv.slice(2);
const showPerLib = args.includes('--per-lib');
const fromArg = args.find(a => a.startsWith('--from='));
const outArg = args.find(a => a.startsWith('--out='));
const positional = args.filter(a => !a.startsWith('--'));

let dir: string;

if (fromArg) {
  dir = fromArg.slice('--from='.length);
} else {
  const t = positional[0];
  if (!t || !/^\d+$/.test(t)) {
    console.error('Usage: metrics-report <threshold> [--per-lib] [--out=<dir>]');
    console.error('   or: metrics-report --from=<existing-dir> [--per-lib]');
    process.exit(1);
  }
  dir = outArg ? outArg.slice('--out='.length) : `data/eval-t${t}`;

  console.error(`[run] threshold=${t} → ${dir}`);
  const env = {
    ...process.env,
    MIN_POG_NODES: process.env['MIN_POG_NODES'] ?? '5',
    FILE_DUP_MIN_HASHES: process.env['FILE_DUP_MIN_HASHES'] ?? '1',
    MATCH_THRESHOLD: t,
    EVAL_OUTPUT_DIR: dir,
    NODE_OPTIONS: process.env['NODE_OPTIONS'] ?? '--max-old-space-size=12288',
  };
  const r = spawnSync('npx', ['tsx', 'src/evaluation/web-detect-eval.ts'], {
    env,
    stdio: ['ignore', 'inherit', 'inherit'],
  });
  if (r.status !== 0) {
    console.error(`[error] eval failed (exit ${r.status})`);
    process.exit(r.status ?? 1);
  }
}

const path = join(dir, 'metrics.json');
if (!fs.existsSync(path)) {
  console.error(`[error] not found: ${path}`);
  process.exit(1);
}

const m = JSON.parse(fs.readFileSync(path, 'utf-8')) as MetricsFile;
const o = m.overall;

console.log();
console.log(`# ${dir}  (threshold = ${m.threshold}%)`);
console.log();
console.log('| metric | value |');
console.log('|---|---:|');
console.log(`| precision | ${o.precision.toFixed(4)} |`);
console.log(`| recall    | ${o.recall.toFixed(4)} |`);
console.log(`| f1        | ${o.f1.toFixed(4)} |`);
console.log(`| TP / FP / FN / TN | ${o.tp} / ${o.fp} / ${o.fn} / ${o.tn} |`);

if (showPerLib) {
  console.log();
  console.log('## per-lib');
  console.log();
  console.log('| lib | P | R | F1 | TP | FP | FN |');
  console.log('|---|---:|---:|---:|---:|---:|---:|');
  const rows = Object.entries(m.perLib)
    .filter(([, r]) => r.tp + r.fp + r.fn > 0)
    .sort((a, b) => (b[1].tp + b[1].fp + b[1].fn) - (a[1].tp + a[1].fp + a[1].fn));
  for (const [lib, r] of rows) {
    console.log(`| ${lib} | ${r.precision.toFixed(3)} | ${r.recall.toFixed(3)} | ${r.f1.toFixed(3)} | ${r.tp} | ${r.fp} | ${r.fn} |`);
  }
}
