import { DepGraph, FileHashRecord, FilterRecord } from '../types/depgraph';
import { findEntryCandidates, findStrictEntries } from './entry-finder';

// ── public types ──

export interface ModuleFilterOpts {
  threshold: number;        // 0..1 (typ 0.9)
  siteHashSet: Set<string>;
  /** hashes excluded from the matched count (numerator) but still counted in total (denominator).
   * Used for dup/blacklist noise: matches on these hashes are unreliable, so they don't help pass threshold,
   * but their presence in total keeps the ratio honest (embedded copies can't pass by dup-stripping). */
  noiseSet?: Set<string>;
}

export interface ModuleFilterResult {
  filterMap: Map<string, FilterRecord>;
  passedCount: number;
  entries: string[];
  strictEntries: string[];
  strictClosure: Set<string>;
  strictUnionHashes: Set<string>;   // union across strict closure for metrics
  strictMatchedCount: number;
}

// ── main export ──

export function filterAndFindEntries(
  fileHashes: Record<string, FileHashRecord>,
  depgraph: DepGraph,
  opts: ModuleFilterOpts
): ModuleFilterResult {
  const { threshold, siteHashSet } = opts;

  // Build filterMap (per-file passed based on ratio >= threshold)
  const filterMap = new Map<string, FilterRecord>();
  let passedCount = 0;

  for (const [relPath, record] of Object.entries(fileHashes)) {
    const total = record.hashes.length;
    const missing = record.hashes.filter((h) => !siteHashSet.has(h));
    const matchRatio = total === 0 ? 1 : (total - missing.length) / total;
    const passed = matchRatio >= threshold;
    if (passed) passedCount++;
    filterMap.set(relPath, {
      passed,
      fileHashCount: record.hashes.length,
      cdnHashCount: siteHashSet.size,
      missingHashCount: missing.length,
      versionSource: 'same',
    });
  }

  // Entry candidates: passed nodes with no passing ancestor
  const entries = findEntryCandidates(depgraph, filterMap);

  // Build fileHashesMap for findStrictEntries
  const fileHashesMap = new Map<string, string[]>();
  for (const [relPath, record] of Object.entries(fileHashes)) {
    fileHashesMap.set(relPath, record.hashes);
  }

  // Strict entries: closure union hash ratio >= threshold AND union >= 5
  const { strictEntries, strictClosure } = findStrictEntries(depgraph, filterMap, entries, {
    fileHashes: fileHashesMap,
    siteHashSet,
    threshold,
  });

  // Union hashes across strict closure + intersection count with site
  const strictUnionHashes = new Set<string>();
  for (const node of strictClosure) {
    for (const h of fileHashesMap.get(node) ?? []) {
      strictUnionHashes.add(h);
    }
  }

  let strictMatchedCount = 0;
  for (const h of strictUnionHashes) {
    if (siteHashSet.has(h)) strictMatchedCount++;
  }

  return {
    filterMap,
    passedCount,
    entries,
    strictEntries,
    strictClosure,
    strictUnionHashes,
    strictMatchedCount,
  };
}
