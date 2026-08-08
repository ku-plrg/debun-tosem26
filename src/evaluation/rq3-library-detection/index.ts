/**
 * Library Detection — `run RQ3`, paper RQ3, Table 5.
 *
 * Compares DEBUN against LDC, PTDetector, and D-Bundlr at the ψ = 84% operating
 * point and prints TP/FP/FN + Precision/Recall/F1. Reuses the shared metric
 * engine in `cmd/compare-detectors.ts`, which reads:
 *   - src/ground/ground-truth.csv            (LDC + PTDetector precomputed columns)
 *   - src/data/other-tool/*_results_debun.json (Aletheia / D-Bundlr fixtures)
 *   - src/data/threshold-sweep/t84/summary.csv (DEBUN, module-dependency-aware scorer)
 *
 * D-Bundlr scope: unlike the other detectors, D-Bundlr is a supervised model and
 * can only ever emit one of the libraries in its training set. Scoring it over
 * the full universe would charge it FNs for libraries it structurally cannot
 * detect, so its column is computed over that training set only (`dbundlerTrained`).
 * This shrinks its FN denominator; it removes zero FPs, because every library it
 * mispredicts is by construction also a trained one.
 */
import {
  runCompareDetectors,
  precision,
  recall,
  f1,
  LibMetric,
} from '../../cmd/compare-detectors';

const pct = (x: number): string => `${(x * 100).toFixed(2)}%`;

export default async function runRQ2(): Promise<void> {
  const res = runCompareDetectors();
  const cols: Record<string, LibMetric> = {
    PTDETECTOR: res.lib.PTDetector,
    LDC: res.lib.LDC,
    'D-BUNDLR*': res.lib.dbundlerTrained,
    DEBUN: res.lib.DEBUN,
  };

  const table: Record<string, Record<string, string | number>> = {};
  const addRow = (label: string, fn: (m: LibMetric) => string | number) => {
    table[label] = {};
    for (const [name, m] of Object.entries(cols)) table[label][name] = fn(m);
  };
  addRow('TP', (m) => m.tp);
  addRow('FP', (m) => m.fp);
  addRow('FN', (m) => m.fn);
  addRow('Precision', (m) => pct(precision(m)));
  addRow('Recall', (m) => pct(recall(m)));
  addRow('F1-score', (m) => pct(f1(m)));

  const scope = res.dbundlrScope;
  console.log('\n=== Library Detection (run RQ3; paper RQ3) — paper Table 5 (ψ = 84%) ===');
  console.table(table);
  console.log(
    `* D-Bundlr is scored only over the ${scope.libs.length} libraries in its training set ` +
    `(${scope.gtInstances} of ${scope.gtInstancesAll} ground-truth instances); the other three ` +
    `detectors are scored over the full library universe. Restricting the scope raises ` +
    `D-Bundlr's recall but leaves its precision unchanged, since every library it can ` +
    `mispredict is by construction also a trained one.`
  );
  console.log(`  trained libs: ${scope.libs.join(', ')}`);

  const { printFig17, printFig18 } = await import('../figures');
  printFig17();
  printFig18();
}
