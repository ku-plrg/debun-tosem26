import { DepGraph, FilterRecord } from '../types/depgraph';

/**
 * A node is "green" when it passes AND has at least one function hash
 * (fileHashCount > 0). Gray nodes (empty-function vacuous passes) are NOT
 * considered candidates for entry status.
 */
function isGreen(rec: FilterRecord | undefined): boolean {
  return !!rec && rec.passed && rec.fileHashCount > 0;
}

/**
 * Entry candidate selection with SCC (cycle) contraction.
 *
 * Conceptually: contract each strongly-connected component to a meta-node,
 * then a meta-node qualifies as an entry when:
 *   (a) every member of the SCC is GREEN (all-passed cycle), AND
 *   (b) no external green ancestor exists (any green node in a different SCC
 *       that reaches into this SCC via reverse edges).
 *
 * Singleton SCCs (acyclic nodes) reduce to the original per-node rule:
 * "green node with no green ancestor". Cyclic SCCs that fail (a) — partial
 * matches inside a cycle — are skipped; only fully-passed cycles become
 * entries. The representative is the lexicographically-first member; the
 * subsequent forward BFS in findStrictEntries reaches the rest of the cycle
 * via its own edges.
 *
 * Edge direction: [from, to] means `from` imports `to`, so ancestors are
 * reached via reverse adjacency (importers of X / their importers / …).
 */
export function findEntryCandidates(
  graph: DepGraph,
  filterMap: Map<string, FilterRecord>
): string[] {
  const forwardAdj = new Map<string, string[]>();
  const reverseAdj = new Map<string, string[]>();
  for (const n of graph.nodes) { forwardAdj.set(n, []); reverseAdj.set(n, []); }
  for (const [from, to] of graph.edges) {
    forwardAdj.get(from)?.push(to);
    reverseAdj.get(to)?.push(from);
  }

  // Tarjan's SCC (recursive — depgraphs here are small, ~10²-10³ nodes max).
  const sccOf = new Map<string, number>();
  const sccMembers: string[][] = [];
  {
    const idx = new Map<string, number>();
    const low = new Map<string, number>();
    const onStack = new Set<string>();
    const tStack: string[] = [];
    let counter = 0;
    const visit = (v: string): void => {
      idx.set(v, counter); low.set(v, counter); counter++;
      tStack.push(v); onStack.add(v);
      for (const w of forwardAdj.get(v) || []) {
        if (!idx.has(w)) {
          visit(w);
          low.set(v, Math.min(low.get(v)!, low.get(w)!));
        } else if (onStack.has(w)) {
          low.set(v, Math.min(low.get(v)!, idx.get(w)!));
        }
      }
      if (low.get(v) === idx.get(v)) {
        const id = sccMembers.length;
        const members: string[] = [];
        let w: string;
        do {
          w = tStack.pop()!;
          onStack.delete(w);
          sccOf.set(w, id);
          members.push(w);
        } while (w !== v);
        sccMembers.push(members);
      }
    };
    for (const n of graph.nodes) if (!idx.has(n)) visit(n);
  }

  const entries: string[] = [];
  for (let scc = 0; scc < sccMembers.length; scc++) {
    const members = sccMembers[scc];
    if (!members.every((n) => isGreen(filterMap.get(n)))) continue;

    // BFS upward via reverse edges, skipping same-SCC nodes (they are the
    // cycle itself, not external ancestors).
    const seen = new Set<string>();
    const stack: string[] = [];
    for (const n of members) {
      for (const p of reverseAdj.get(n) || []) {
        if (sccOf.get(p) !== scc) stack.push(p);
      }
    }
    let hasExternalGreen = false;
    while (stack.length) {
      const cur = stack.pop()!;
      if (seen.has(cur)) continue;
      seen.add(cur);
      if (isGreen(filterMap.get(cur))) { hasExternalGreen = true; break; }
      for (const p of reverseAdj.get(cur) || []) {
        if (!seen.has(p) && sccOf.get(p) !== scc) stack.push(p);
      }
    }

    if (!hasExternalGreen) {
      entries.push([...members].sort()[0]);
    }
  }

  return entries.sort();
}

/**
 * Strict entry = entry candidate whose FULL forward closure (entry + all
 * descendants reachable via import edges) has an aggregate hash-match ratio
 * ≥ threshold.
 *
 * For each entry E:
 *   1. Collect closure C = { E } ∪ descendants(E).
 *   2. Let union = ⋃ fileHashes(n) for n ∈ C  (unique hashes across the whole
 *      subtree — NOT per-file).
 *   3. Let matched = |union ∩ siteHashSet|.
 *   4. If matched / |union| ≥ threshold → strict entry. Empty union (no
 *      functions anywhere in the subtree) counts as trivially passing.
 *
 * Returns:
 *   strictEntries  — subset of `entries` that passed the aggregate check
 *   strictClosure  — union of forward closures of strict entries (the set
 *                    of nodes to render in the filtered subgraph)
 */
export function findStrictEntries(
  graph: DepGraph,
  filterMap: Map<string, FilterRecord>,
  entries: string[],
  opts: {
    fileHashes: Map<string, string[]>;
    siteHashSet: Set<string>;
    threshold: number;
  }
): { strictEntries: string[]; strictClosure: Set<string> } {
  // Forward adjacency: forwardAdj[from] = [imports-by-from]
  const forwardAdj = new Map<string, string[]>();
  for (const n of graph.nodes) forwardAdj.set(n, []);
  for (const [from, to] of graph.edges) {
    const arr = forwardAdj.get(from);
    if (arr) arr.push(to);
  }

  const strictEntries: string[] = [];
  const strictClosure = new Set<string>();

  for (const entry of entries) {
    // BFS forward from entry to collect closure
    const closure = new Set<string>();
    const stack: string[] = [entry];
    while (stack.length) {
      const cur = stack.pop()!;
      if (closure.has(cur)) continue;
      closure.add(cur);
      for (const child of forwardAdj.get(cur) || []) {
        if (!closure.has(child)) stack.push(child);
      }
    }

    // Aggregate hash union across closure
    const union = new Set<string>();
    for (const n of closure) {
      for (const h of opts.fileHashes.get(n) || []) union.add(h);
    }

    // Require a non-trivial closure: at least 3 unique hashes under entry,
    // otherwise the match ratio is not meaningful (too easy to game).
    if (union.size < 3) continue;

    let matched = 0;
    for (const h of union) if (opts.siteHashSet.has(h)) matched++;
    const ratio = matched / union.size;

    if (ratio >= opts.threshold) {
      strictEntries.push(entry);
      for (const n of closure) strictClosure.add(n);
    }
  }

  return { strictEntries: strictEntries.sort(), strictClosure };
}
