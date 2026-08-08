// eslint-disable-next-line @typescript-eslint/no-var-requires
const semverSort: (list: string[], loose?: boolean) => string[] = require('semver/functions/sort');

// ── public types ──

export interface VersionDetection {
  version: string;
  strictEntryCount: number;
  strictRatio: number;   // matched/union (1 when union empty)
  /** number of unique POG hashes (≈ functions) that matched the site for this version */
  strictMatchedHashCount?: number;
  /** size of the file set reachable from any strict entry through the dep graph */
  strictClosureSize?: number;
}

export interface GroundTruthEntry {
  libName: string;
  version?: string;
}

export interface LibSummary {
  detected: boolean;
  versionRange: string;
  maxStrictCount: number;
  strictVersions: string[];
  gtHasLib: boolean;
  gtVersion: string;
  verdict: 'TP' | 'FP' | 'FN' | 'TN' | 'UNKNOWN';
}

// ── main export ──

export function scoreLibForSite(
  versions: VersionDetection[],
  gtEntries: GroundTruthEntry[] | null,  // null = site not in GT file
  libName: string
): LibSummary {
  const strictRows = versions.filter((v) => v.strictEntryCount > 0);
  const detected = strictRows.length > 0;

  // strictVersions = versions that tie for the MAX matched-function count (semver-sorted)
  // versionRange = "min..max" over the same set (compact human-readable label)
  // Rationale: among strict-passing versions, pick the one(s) where the most lib
  // functions actually matched the site. Ties keep multiple entries.
  let strictVersionsList: string[] = [];
  let versionRange = '';
  let maxStrictCount = 0;
  if (detected) {
    const matchedOf = (r: VersionDetection): number =>
      r.strictMatchedHashCount ?? r.strictClosureSize ?? r.strictEntryCount;
    maxStrictCount = Math.max(...strictRows.map((r) => r.strictEntryCount));
    const maxMatched = Math.max(...strictRows.map(matchedOf));
    const topRows = strictRows.filter((r) => matchedOf(r) === maxMatched);
    let topSortedVers: string[];
    try { topSortedVers = semverSort(topRows.map((r) => r.version)); }
    catch { topSortedVers = topRows.map((r) => r.version).sort(); }
    strictVersionsList.push(...topSortedVers);
    versionRange = topSortedVers.length === 1
      ? topSortedVers[0]
      : `${topSortedVers[0]}..${topSortedVers[topSortedVers.length - 1]}`;
  }

  // Ground-truth lookup (lib-level, ignore version for verdict)
  const inGt = gtEntries !== null;
  const gtMatch = gtEntries?.find((e) => e.libName === libName);
  const gtHasLib = !!gtMatch;
  const gtVersion = gtMatch?.version ?? '';

  let verdict: LibSummary['verdict'];
  if (!inGt) {
    verdict = 'UNKNOWN';
  } else if (detected && gtHasLib) {
    verdict = 'TP';
  } else if (detected && !gtHasLib) {
    verdict = 'FP';
  } else if (!detected && gtHasLib) {
    verdict = 'FN';
  } else {
    verdict = 'TN';
  }

  return {
    detected,
    versionRange,
    maxStrictCount,
    strictVersions: strictVersionsList,
    gtHasLib,
    gtVersion,
    verdict,
  };
}
