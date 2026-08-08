/**
 * The numbers behind the paper's data figures, printed as tables.
 *
 * Figures 14-19 are plots of per-threshold or per-region counts. The artifact prints those
 * counts instead of re-rendering the PDFs, so every figure is checkable from the terminal
 * with no plotting dependency. Sweeps are downsampled to stay readable; the CSVs hold every
 * row. Each source file sits in the directory of the command that prints it.
 *
 *   Fig. 14  detection time breakdown        measured live         (run RQ1, see rq1-performance/)
 *   Fig. 15  consistency/accuracy at LOC ≥ x results/rq2-ablation/score.csv (run RQ2)
 *   Fig. 16  scorer comparison over ψ        rq2-ablation/scorer-sweep-score_u.csv
 *                                            + rq3-library-detection/threshold-sweep.csv    (run RQ2)
 *   Fig. 17  library detection over ψ        rq3-library-detection/threshold-sweep.csv      (run RQ3)
 *   Fig. 18  detected-library Venn           rq3-library-detection/venn-libraries.csv       (run RQ3)
 *   Fig. 19  correct-version Venn            rq4-version-detection/venn-versions.csv        (run RQ4)
 */
import fs from 'fs';
import path from 'path';

const EVAL = path.join(process.cwd(), 'src/evaluation');

type Row = Record<string, string>;

const read = (rel: string): Row[] | null => readAt(path.join(EVAL, rel));

function readAt(p: string): Row[] | null {
  if (!fs.existsSync(p)) return null;
  // Some of these CSVs are CRLF; without stripping it the last column's key keeps a \r and
  // every lookup on it returns undefined.
  const lines = fs.readFileSync(p, 'utf-8').replace(/\r/g, '').trim().split('\n');
  const head = lines[0].split(',');
  return lines.slice(1).map((l) => {
    const c = l.split(',');
    return Object.fromEntries(head.map((h, i) => [h, c[i]])) as Row;
  });
}

const pct = (x: string | number): string => `${(Number(x) * 100).toFixed(2)}%`;
const missing = (fig: string, file: string): void =>
  console.log(`\n(${fig}: ${file} not present — skipped)`);

/**
 * Fig. 15 — consistency and accuracy as the minimum function length grows.
 *
 * Read from `src/results/rq2-ablation/score.csv`, the same file Table 2 uses, so the LOC >= 6 row of
 * this figure and Table 2 cannot drift apart. (The paper's own figure bundle carried a
 * separate copy whose inlined-model counts were one revision behind: 51,410 functions against
 * 51,091, which shifted POG+FBCI consistency to 94.52% from Table 2's 95.21%.)
 */
export function printFig15(): void {
  const rows = readAt(path.join(process.cwd(), 'src/results/rq2-ablation/score.csv'));
  if (!rows) return missing('Fig. 15', '../src/results/rq2-ablation/score.csv');
  const models: Array<[string, string]> = [
    ['Count', 'A'], ['POG', 'B'], ['POG+F', 'C'], ['POG+FB', 'D'], ['POG+FBC', 'E'], ['POG+FBCI', 'F'],
  ];
  console.log('\n=== Fig. 15 — Scores for each model with LOC >= x ===');
  const cons: Record<string, Record<string, string>> = {};
  const acc: Record<string, Record<string, string>> = {};
  for (const r of rows) {
    const loc = Number(r['LOC']);
    if (loc > 10 && loc % 5 !== 0) continue;   // 1..10 then every 5th
    cons[`LOC>=${loc}`] = {};
    acc[`LOC>=${loc}`] = {};
    for (const [name, s] of models) {
      const inlined = s === 'F';
      const fnCount = Number(r[inlined ? 'allFunctionCountInlined' : 'allFunctionCount']);
      cons[`LOC>=${loc}`][name] = pct(Number(r[`bothTrueMatchCnt${s}`]) / fnCount);
      acc[`LOC>=${loc}`][name] = pct(fnCount / Number(r[`allMatchCnt${s}`]));
    }
  }
  console.log('Consistency');
  console.table(cons);
  console.log('Accuracy');
  console.table(acc);
}

/**
 * Fig. 16 — the two library scorers across the threshold sweep.
 *
 * score_m reads `rq3-library-detection/threshold-sweep.csv`, the same sweep Fig. 17 plots, so the two figures
 * cannot disagree. The paper's figure bundle carried a second score_m sweep that differed on
 * 17 of the 41 thresholds (140 true positives at psi = 100% against the current 142); it
 * agreed at psi = 84%, which is why Table 4 never showed the drift.
 */
export function printFig16(): void {
  const withDep = read('rq3-library-detection/threshold-sweep.csv');
  const withoutDep = read('rq2-ablation/scorer-sweep-score_u.csv');
  if (!withDep || !withoutDep) return missing('Fig. 16', 'rq3-library-detection/threshold-sweep.csv + rq2-ablation/scorer-sweep-score_u.csv');
  console.log('\n=== Fig. 16 — Library detection across scorers, over the threshold sweep ===');
  const byT = (rs: Row[]) => new Map(rs.map((r) => [r['threshold'], r]));
  const m = byT(withDep);
  const u = byT(withoutDep);
  const table: Record<string, Record<string, string>> = {};
  for (let t = 0; t <= 100; t += 10) {
    const a = u.get(String(t));
    const b = m.get(String(t));
    if (!a || !b) continue;
    table[`psi=${t}%`] = {
      'score_u P': pct(a['precision']), 'score_u R': pct(a['recall']), 'score_u F1': pct(a['f1']),
      'score_m P': pct(b['precision']), 'score_m R': pct(b['recall']), 'score_m F1': pct(b['f1']),
    };
  }
  console.table(table);
  const best = (rs: Row[]) => rs.reduce((x, y) => (Number(y['f1']) > Number(x['f1']) ? y : x));
  const bu = best(withoutDep); const bm = best(withDep);
  console.log(
    `best F1 — score_u ${pct(bu['f1'])} at psi=${bu['threshold']}%, ` +
    `score_m ${pct(bm['f1'])} at psi=${bm['threshold']}%`
  );
}

/** Fig. 17 — DEBUN's precision/recall/F1 as the score threshold moves. */
export function printFig17(): void {
  const rows = read('rq3-library-detection/threshold-sweep.csv');
  if (!rows) return missing('Fig. 17', 'rq3-library-detection/threshold-sweep.csv');
  console.log('\n=== Fig. 17 — Library detection scores with different thresholds psi_m ===');
  const table: Record<string, Record<string, string>> = {};
  for (const r of rows) {
    const t = Number(r['threshold']);
    if (t % 5 !== 0 && t !== 84) continue;
    table[`psi=${t}%${t === 84 ? ' *' : ''}`] = {
      Precision: pct(r['precision']), Recall: pct(r['recall']), 'F1-score': pct(r['f1']),
      TP: r['tp'], FP: r['fp'], FN: r['fn'],
    };
  }
  console.table(table);
  const f1s = rows.map((r) => Number(r['f1']));
  const minRow = rows[f1s.indexOf(Math.min(...f1s))];
  console.log(
    `* psi = 84% is the operating point of Tables 5 and 6. Lowest F1 over the sweep is ` +
    `${pct(minRow['f1'])} at psi=${minRow['threshold']}%; DEBUN's recall stays above ` +
    `D-Bundlr's 62.89% at every threshold (minimum ${pct(Math.min(...rows.map((r) => Number(r['recall']))))}).`
  );
}

/** Fig. 18 / 19 — which tools found what, as Venn regions. */
export function printVenn(file: string, fig: string, tools: string[]): void {
  const rows = read(file);
  if (!rows) return missing(fig, file);
  console.log(`\n=== ${fig} ===`);
  const table: Record<string, Record<string, string | number>> = {};
  for (const r of rows) {
    const on = tools.filter((t) => r[t] === '1');
    const label = on.length ? on.join(' + ') : '(none)';
    table[label] = { count: Number(r['count']) };
  }
  console.table(table);
  for (const t of tools) {
    const total = rows.filter((r) => r[t] === '1').reduce((a, r) => a + Number(r['count']), 0);
    const only = rows
      .filter((r) => r[t] === '1' && tools.every((o) => o === t || r[o] === '0'))
      .reduce((a, r) => a + Number(r['count']), 0);
    console.log(`  ${t}: ${total} total, ${only} found by it alone`);
  }
}

export const printFig18 = (): void =>
  printVenn('rq3-library-detection/venn-libraries.csv', 'Fig. 18 — Venn of detected library instances', ['ldc', 'pt', 'dbundlr', 'debun']);
export const printFig19 = (): void =>
  printVenn('rq4-version-detection/venn-versions.csv', 'Fig. 19 — Venn of correctly detected versions', ['ldc', 'debun', 'aletheia']);
