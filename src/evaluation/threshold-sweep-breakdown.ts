/**
 * Read data/threshold-sweep/t$n/summary.csv and produce FP/FN breakdown per lib.
 * Writes per-threshold:
 *   data/threshold-sweep/t$n/fp-fn-breakdown.csv
 * And also augments the main sweep.csv with FP/FN lib breakdown columns.
 *
 * Safe to re-run while sweep is still in progress — it only processes folders
 * that have a completed summary.csv.
 */
import fs from 'fs';
import path from 'path';

const SWEEP_DIR = 'data/threshold-sweep';

interface Row {
  threshold: number;
  summary?: { tp: number; fp: number; fn: number; tn: number; };
  fpByLib: Record<string, number>;
  fnByLib: Record<string, number>;
  fpSites: Record<string, string[]>;   // lib → sites
  fnSites: Record<string, string[]>;   // lib → sites
}

function parseSummary(csvPath: string): Row['fpByLib'] extends infer _ ? Row : never {
  const content = fs.readFileSync(csvPath, 'utf8');
  const lines = content.trim().split('\n');
  const header = lines[0].split(',');
  const libIdx = header.indexOf('lib');
  const siteIdx = header.indexOf('site');
  const verdictIdx = header.indexOf('verdict');
  const fpByLib: Record<string, number> = {};
  const fnByLib: Record<string, number> = {};
  const fpSites: Record<string, string[]> = {};
  const fnSites: Record<string, string[]> = {};
  for (const line of lines.slice(1)) {
    const cols = line.split(',');
    const lib = cols[libIdx];
    const site = cols[siteIdx];
    const verdict = cols[verdictIdx];
    if (verdict === 'FP') {
      fpByLib[lib] = (fpByLib[lib] ?? 0) + 1;
      (fpSites[lib] = fpSites[lib] ?? []).push(site);
    } else if (verdict === 'FN') {
      fnByLib[lib] = (fnByLib[lib] ?? 0) + 1;
      (fnSites[lib] = fnSites[lib] ?? []).push(site);
    }
  }
  return { threshold: 0, fpByLib, fnByLib, fpSites, fnSites };
}

const dirs = fs.readdirSync(SWEEP_DIR).filter((d) => /^t\d+$/.test(d)).sort((a, b) => parseInt(a.slice(1)) - parseInt(b.slice(1)));

const rows: Row[] = [];
for (const dir of dirs) {
  const threshold = parseInt(dir.slice(1));
  const summaryPath = path.join(SWEEP_DIR, dir, 'summary.csv');
  const metricsPath = path.join(SWEEP_DIR, dir, 'metrics.json');
  if (!fs.existsSync(summaryPath)) { console.log(`[skip] t=${threshold} (no summary.csv yet)`); continue; }

  const row = parseSummary(summaryPath) as Row;
  row.threshold = threshold;

  if (fs.existsSync(metricsPath)) {
    const m = JSON.parse(fs.readFileSync(metricsPath, 'utf8'));
    row.summary = { tp: m.overall.tp, fp: m.overall.fp, fn: m.overall.fn, tn: m.overall.tn };
  }

  // Per-threshold breakdown file
  const outLines = ['type,lib,count,sites'];
  const fpSorted = Object.entries(row.fpByLib).sort((a, b) => b[1] - a[1]);
  const fnSorted = Object.entries(row.fnByLib).sort((a, b) => b[1] - a[1]);
  for (const [lib, cnt] of fpSorted) outLines.push(`FP,${lib},${cnt},"${row.fpSites[lib].join(';')}"`);
  for (const [lib, cnt] of fnSorted) outLines.push(`FN,${lib},${cnt},"${row.fnSites[lib].join(';')}"`);
  fs.writeFileSync(path.join(SWEEP_DIR, dir, 'fp-fn-breakdown.csv'), outLines.join('\n') + '\n');

  rows.push(row);
  console.log(`[ok] t=${threshold}: FP=${Object.values(row.fpByLib).reduce((a, b) => a + b, 0)} (${Object.keys(row.fpByLib).length} libs), FN=${Object.values(row.fnByLib).reduce((a, b) => a + b, 0)} (${Object.keys(row.fnByLib).length} libs)`);
}

// Augmented sweep table: include breakdown summary
const allLibs = new Set<string>();
for (const r of rows) { for (const l of Object.keys(r.fpByLib)) allLibs.add(l); for (const l of Object.keys(r.fnByLib)) allLibs.add(l); }

const augLines = ['threshold,tp,fp,fn,tn,fp_breakdown,fn_breakdown'];
for (const r of rows) {
  const fp = Object.entries(r.fpByLib).sort((a, b) => b[1] - a[1]).map(([l, c]) => `${l}:${c}`).join(';');
  const fn = Object.entries(r.fnByLib).sort((a, b) => b[1] - a[1]).map(([l, c]) => `${l}:${c}`).join(';');
  const t = r.summary ?? { tp: 0, fp: 0, fn: 0, tn: 0 };
  augLines.push([r.threshold, t.tp, t.fp, t.fn, t.tn, `"${fp}"`, `"${fn}"`].join(','));
}
fs.writeFileSync(path.join(SWEEP_DIR, 'sweep-fp-fn.csv'), augLines.join('\n') + '\n');
console.log(`\n[out] ${path.join(SWEEP_DIR, 'sweep-fp-fn.csv')}`);
