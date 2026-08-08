/**
 * Library Version Detection — `run RQ4`, paper RQ4, Table 6.
 *
 * Compares DEBUN against LDC and Aletheia at three semantic-versioning
 * granularities (Major / Minor / Patch), reporting the number of correctly
 * detected versions (out of the 98 ground-truth versioned libraries) and the
 * average candidate-range size. Reuses `cmd/compare-detectors.ts`.
 */
import { runCompareDetectors, VerStats } from '../../cmd/compare-detectors';

const avg = (a: number[]): number =>
  a.length ? a.reduce((x, y) => x + y, 0) / a.length : 0;

const cell = (correct: number, range: number[]): string =>
  `${correct} (±${avg(range).toFixed(2)})`;

export default async function runRQ3(): Promise<void> {
  const res = runCompareDetectors();
  const cols: Record<string, VerStats> = {
    LDC: res.version.LDC,
    Aletheia: res.version.Aletheia,
    DEBUN: res.version.DEBUN,
  };

  const table: Record<string, Record<string, string>> = {
    Major: {},
    Minor: {},
    Patch: {},
  };
  for (const [name, v] of Object.entries(cols)) {
    table['Major'][name] = cell(v.M, v.wM);
    table['Minor'][name] = cell(v.m, v.wMm);
    table['Patch'][name] = cell(v.p, v.wMmp);
  }

  console.log('\n=== Version Detection (run RQ4; paper RQ4) — paper Table 6 (ψ = 84%) ===');
  console.log('Each cell: # correctly detected versions (± avg candidate-range size)');
  console.table(table);

  const { printFig19 } = await import('../figures');
  printFig19();
}
