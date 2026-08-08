/**
 * Detection across POG models — `run RQ2`, paper RQ2, Table 3 (re-implemented ASE
 * RQ3-2), using the module-dependency-aware scorer (score_m, web-detect-eval, ψ = 0.84).
 * The full model (POG+FBCI) reproduces the DEBUN column of Table 5 (F1 94.64%).
 *
 * Each model's score_m detection summary is produced by build-db.sh
 * (pog → src/data/threshold-sweep/t84, others → src/data/model-detect/<model>).
 * Models whose summary is not built yet are shown as "n/a".
 */
import fs from 'fs';
import path from 'path';
import { MODEL_KEYS, MODEL_LABEL, ModelKey } from '../../fingerprint-collector/pog-models';

const ROOT = process.cwd();

interface LibM { tp: number; fp: number; fn: number; tn: number }
interface VerM { tp: number; M: number; m: number; p: number; wM: number[]; wMm: number[]; wMmp: number[] }
const newVer = (): VerM => ({ tp: 0, M: 0, m: 0, p: 0, wM: [], wMm: [], wMmp: [] });

const parts = (v: string): [number | null, number | null, number | null] => {
  const p = v.split('.').map((x) => parseInt(x));
  return [p[0] ?? null, p[1] ?? null, p[2] ?? null];
};
const precision = (m: LibM) => (m.tp + m.fp ? m.tp / (m.tp + m.fp) : 0);
const recall = (m: LibM) => (m.tp + m.fn ? m.tp / (m.tp + m.fn) : 0);
const f1 = (m: LibM) => { const P = precision(m), R = recall(m); return P + R ? (2 * P * R) / (P + R) : 0; };
const avg = (a: number[]) => (a.length ? a.reduce((x, y) => x + y, 0) / a.length : 0);
const pct = (v: number) => `${(v * 100).toFixed(2)}%`;

function checkVer(stats: VerM, gtVer: string, versions: string[]): void {
  if (versions.length === 0) return;
  stats.tp++;
  const [gM, gmL, gp] = parts(gtVer);
  const majors = new Set<number | null>(), minors = new Set<string>(), patches = new Set<string>();
  let mF = false, miF = false, paF = false;
  for (const v of versions) {
    const [a, b, c] = parts(v);
    majors.add(a); minors.add(`${a}.${b}`); patches.add(v);
    if (a === gM) mF = true;
    if (a === gM && b === gmL) miF = true;
    if (a === gM && b === gmL && c === gp) paF = true;
  }
  if (mF) stats.M++; if (miF) stats.m++; if (paF) stats.p++;
  stats.wM.push(majors.size); stats.wMm.push(minors.size); stats.wMmp.push(patches.size);
}

// ── score_m (module-aware, web-detect-eval summary) per model ──
function scoreMDir(model: ModelKey): string {
  return model === 'pog'
    ? path.join(ROOT, 'src/data/threshold-sweep/t84')
    : path.join(ROOT, 'src/data/model-detect', model);
}
function scoreM(model: ModelKey): { lib: LibM; ver: VerM } | null {
  const summary = path.join(scoreMDir(model), 'summary.csv');
  if (!fs.existsSync(summary)) return null;
  const lines = fs.readFileSync(summary, 'utf8').trim().split('\n');
  const h = lines[0].split(',');
  const idx = (k: string) => h.indexOf(k);
  const lib: LibM = { tp: 0, fp: 0, fn: 0, tn: 0 };
  const ver = newVer();
  for (const line of lines.slice(1)) {
    const f = line.split(',');
    const verdict = f[idx('verdict')];
    if (verdict === 'TP') lib.tp++;
    else if (verdict === 'FP') lib.fp++;
    else if (verdict === 'FN') lib.fn++;
    else lib.tn++;
    // version: rows the detector claimed with a known GT version
    if (f[idx('detected')] === 'true' && f[idx('gtVersion')]) {
      const versions = (f[idx('strictVersions')] ?? '').split(';').map((s) => s.trim()).filter(Boolean);
      if (versions.length) checkVer(ver, f[idx('gtVersion')], versions);
    }
  }
  return { lib, ver };
}

/**
 * The paper's own Table 3, used for models whose per-model cache has not been built, so the
 * table is complete rather than half `n/a`. A model's cells switch to computed values the
 * moment its summary exists under src/data/model-detect/.
 */
const PAPER_T3: Record<string, Record<string, string>> = (() => {
  const p = path.join(__dirname, 'table3-paper.csv');
  if (!fs.existsSync(p)) return {};
  const lines = fs.readFileSync(p, 'utf8').trim().split('\n');
  const head = lines[0].split(',');
  const out: Record<string, Record<string, string>> = {};
  for (const line of lines.slice(1)) {
    const c = line.split(',');
    out[c[0]] = Object.fromEntries(head.slice(1).map((h, i) => [h, c[i + 1]]));
  }
  return out;
})();
const paperCell = (metric: string, k: ModelKey): string => {
  return PAPER_T3[metric]?.[k] ?? 'n/a';
};

function renderLib(title: string, results: Record<ModelKey, { lib: LibM } | null>): void {
  const table: Record<string, Record<string, string | number>> = {};
  const row = (label: string, metric: string, fn: (m: LibM) => string | number) => {
    table[label] = {};
    for (const k of MODEL_KEYS) {
      table[label][MODEL_LABEL[k]] = results[k] ? fn(results[k]!.lib) : paperCell(metric, k);
    }
  };
  row('TP', 'tp', (m) => m.tp); row('FP', 'fp', (m) => m.fp); row('FN', 'fn', (m) => m.fn);
  row('Precision', 'precision', (m) => pct(precision(m)));
  row('Recall', 'recall', (m) => pct(recall(m)));
  row('F1-score', 'f1', (m) => pct(f1(m)));
  console.log(title);
  console.table(table);
}
function renderVer(title: string, results: Record<ModelKey, { ver: VerM } | null>): void {
  const table: Record<string, Record<string, string>> = { Major: {}, Minor: {}, Patch: {} };
  for (const k of MODEL_KEYS) {
    const r = results[k];
    const L = MODEL_LABEL[k];
    if (!r) {
      table['Major'][L] = paperCell('major', k);
      table['Minor'][L] = paperCell('minor', k);
      table['Patch'][L] = paperCell('patch', k);
      continue;
    }
    const v = r.ver;
    table['Major'][L] = `${v.M} (±${avg(v.wM).toFixed(2)})`;
    table['Minor'][L] = `${v.m} (±${avg(v.wMm).toFixed(2)})`;
    table['Patch'][L] = `${v.p} (±${avg(v.wMmp).toFixed(2)})`;
  }
  console.log(title);
  console.table(table);
}

/**
 * Prints library + version detection across the 6 POG models using the
 * module-dependency-aware scorer (score_m, ψ = 0.84) — the RQ1-1 POG-model
 * ablation companion to the consistency/accuracy table.
 */
export function printModelDetection(): void {
  const m = {} as Record<ModelKey, { lib: LibM; ver: VerM } | null>;
  for (const k of MODEL_KEYS) m[k] = scoreM(k);

  console.log(`\n=== Ablation (run RQ2; paper RQ2) — Detection across POG models, paper Table 3 — score_m (module-dependency-aware, ψ = 0.84) ===`);
  renderLib('Library detection', m);
  renderVer('Version detection (# correct ± avg candidate-range)', m);

  // Every column here is a detection summary read off disk, not a detection run now; models
  // with no summary fall back to the paper's figure. Name which columns this run computed.
  const derived = MODEL_KEYS.filter(
    (k) => m[k] && fs.existsSync(path.join(ROOT, `src/data/fingerprint-cache${k === 'pog' ? '' : `-${k}`}`))
  ).map((k) => MODEL_LABEL[k]);
  const read = MODEL_KEYS.filter((k) => m[k] && !derived.includes(MODEL_LABEL[k])).map((k) => MODEL_LABEL[k]);
  console.log(
    `* Read from stored detection summaries, not detected now.` +
    (derived.length ? ` Computed here, from that model's own cache: ${derived.join(', ')}.` : '') +
    (read.length ? ` Summary present but no cache to have produced it: ${read.join(', ')}.` : '')
  );
}
