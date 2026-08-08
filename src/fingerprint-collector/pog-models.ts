/**
 * Single source of truth for the six POG-generation models used in the RQ3
 * ablations. The option sets match the fingerprint-consistency ablation in
 * evaluation/rq2-ablation/index.ts (configs A–F) so that the "detection across POG
 * models" tables and the consistency/accuracy table describe the same models.
 *
 *   cnt  Count      simple property-operation counting
 *   cfg  POG        basic Property-Order Graph (no structural refinements)
 *   f    POG+F      + branch flipping
 *   fb   POG+FB     + branch bypassing
 *   fbc  POG+FBC    + path cloning
 *   pog  POG+FBCI   + function inlining  (== full DEBUN, fingerprintCollector default)
 *
 * Each model writes into its own fingerprint-cache directory (see MODEL_CACHE),
 * so the scorers select a model purely via FP_CACHE_DIR + the allWebHashes suffix.
 */
import fingerprintCollector from './index';
import extractFunctions from './function-collector';
import { generatePOGHash } from './hash-function';
import { extractPOG } from './pog-generator';
import { getPropertyCnthash } from '../evaluation/rq2-ablation/property-cnt';
import { Function as Func, POGAnalysisOptions, POGHash } from '../types/pog';

export type ModelKey = 'cnt' | 'cfg' | 'f' | 'fb' | 'fbc' | 'pog';

export const MODEL_KEYS: ModelKey[] = ['cnt', 'cfg', 'f', 'fb', 'fbc', 'pog'];

export const MODEL_LABEL: Record<ModelKey, string> = {
  cnt: 'Count',
  cfg: 'POG',
  f: 'POG+F',
  fb: 'POG+FB',
  fbc: 'POG+FBC',
  pog: 'POG+FBCI',
};

/** allWebHashes / debun-hashes filename suffix for each model ('' = full). */
export const MODEL_SUFFIX: Record<ModelKey, string> = {
  cnt: '-cnt',
  cfg: '-cfg',
  f: '-f',
  fb: '-fb',
  fbc: '-fbc',
  pog: '',
};

/** Per-model fingerprint-cache directory name under src/data/ ('' = full). */
export const MODEL_CACHE: Record<ModelKey, string> = {
  cnt: 'fingerprint-cache-cnt',
  cfg: 'fingerprint-cache-cfg',
  f: 'fingerprint-cache-f',
  fb: 'fingerprint-cache-fb',
  fbc: 'fingerprint-cache-fbc',
  pog: 'fingerprint-cache',
};

export function parseModel(v: string | undefined): ModelKey {
  const m = (v ?? 'pog') as ModelKey;
  if (!MODEL_KEYS.includes(m)) {
    throw new Error(`Invalid MODEL '${v}'. Valid: ${MODEL_KEYS.join('|')}`);
  }
  return m;
}

// BASE == rq3 config B ("POG"): structural refinements off, but the always-on
// normalizations (literalProperty / skipArguments / assignmentPropagation) on.
const BASE: POGAnalysisOptions = {
  branchFlipping: false,
  branchBypassing: false,
  pathCloning: false,
  inlining: false,
  literalProperty: true,
  skipArguments: true,
  assignmentPropagation: true,
};
const OPTIONS: Record<'cfg' | 'f' | 'fb' | 'fbc', POGAnalysisOptions> = {
  cfg: { ...BASE },
  f: { ...BASE, branchFlipping: true },
  fb: { ...BASE, branchFlipping: true, branchBypassing: true },
  fbc: { ...BASE, branchFlipping: true, branchBypassing: true, pathCloning: true },
};

const isValid = (f: Func) => f.id !== undefined && !f.id.startsWith('JSCA_null');

/**
 * Fingerprint one source file with the given POG model.
 * `minFnLoc` (>0) drops short functions (npm/cdn use 6; site/web use 0).
 */
export function collectHashesForModel(
  raw: string,
  model: ModelKey,
  opts?: { minFnLoc?: number; extractFunctionId?: boolean }
): POGHash[] {
  const minFnLoc = opts?.minFnLoc ?? 0;
  if (model === 'pog') {
    // full DEBUN: inlining + all refinements (fingerprintCollector default).
    return fingerprintCollector(raw, undefined, {
      minFnLoc,
      extractFunctionId: opts?.extractFunctionId ?? false,
    });
  }
  const funcs = extractFunctions(raw, false, { minFnLoc }).filter(isValid);
  if (model === 'cnt') {
    return funcs.map((f) => getPropertyCnthash(undefined, f.body));
  }
  const options = OPTIONS[model];
  return funcs.map((f) => generatePOGHash({ body: f.body, graph: extractPOG(f, options).nodes }));
}
