import fs from 'fs';
import path from 'path';

/**
 * Load the birth-based dup-hash blacklist produced by
 * `src/debun/phase1/extract-dups.ts` and group by library name.
 *
 * Input files:
 *   - `src/data/debun-hashes/all-libs.json`     — lib name/id catalog
 *   - `src/data/debun-hashes/dups-0.3-hash.json` — per-hash loser lib/version
 *
 * Output:
 *   Map<libName, Set<hash>> — hashes to remove when fingerprinting that lib
 *
 * Semantics: a "loser" library is the newer lib in a birth-based pairwise
 * comparison. Its shared hashes are considered copied-in and are noise
 * for that lib's own detection.
 *
 * `libName` in the all-libs map often has suffixes like
 * `jquery____dist.jquery.min` — we strip the `____` suffix so the lookup
 * can use the plain npm directory name (`jquery`). Multiple suffixed names
 * can collapse into the same base; we union their hash sets.
 */
export function loadDupFilter(rootDir: string = process.cwd()): Map<string, Set<string>> {
  const allLibsPath = path.join(rootDir, 'src/data/debun-hashes/all-libs.json');
  const dupsPath = path.join(rootDir, 'src/data/debun-hashes/dups-0.3-hash.json');

  if (!fs.existsSync(allLibsPath) || !fs.existsSync(dupsPath)) {
    console.warn(
      `[dup-filter] missing ${path.relative(rootDir, allLibsPath)} or ${path.relative(rootDir, dupsPath)} — returning empty filter`
    );
    return new Map();
  }

  const allLibs: Record<string, { id: number }> = JSON.parse(
    fs.readFileSync(allLibsPath, 'utf-8')
  );

  // id → base libName (strip `____suffix`)
  const idToBase = new Map<number, string>();
  for (const [fullName, info] of Object.entries(allLibs)) {
    const base = fullName.split('____')[0];
    // If multiple fullNames share the same id (shouldn't happen), last wins
    idToBase.set(info.id, base);
  }

  const dups: Record<string, Record<string, Record<string, unknown>>> = JSON.parse(
    fs.readFileSync(dupsPath, 'utf-8')
  );

  const byLib = new Map<string, Set<string>>();
  for (const hashesAtNodes of Object.values(dups)) {
    for (const [hash, loserMap] of Object.entries(hashesAtNodes)) {
      for (const loserIdStr of Object.keys(loserMap)) {
        const base = idToBase.get(Number(loserIdStr));
        if (!base) continue;
        let set = byLib.get(base);
        if (!set) {
          set = new Set();
          byLib.set(base, set);
        }
        set.add(hash);
      }
    }
  }

  return byLib;
}

/**
 * Apply the dup filter to a per-file hash map. For each file:
 *   - Remove hashes that appear in dupSet.
 *   - If the file ends up with zero hashes AND had hashes originally,
 *     drop it entirely (the whole module is dup noise).
 *   - Files that originally had zero hashes (empty modules) are untouched.
 *
 * Returns a NEW map; input is not mutated.
 */
export function applyDupFilter<T extends { hashes: string[] }>(
  fileHashes: Record<string, T>,
  dupSet: Set<string> | undefined
): Record<string, T> {
  if (!dupSet || dupSet.size === 0) return fileHashes;

  const out: Record<string, T> = {};
  for (const [relPath, rec] of Object.entries(fileHashes)) {
    const originalCount = rec.hashes.length;
    const kept = rec.hashes.filter((h) => !dupSet.has(h));
    if (originalCount > 0 && kept.length === 0) {
      // entire module was dup noise — drop
      continue;
    }
    out[relPath] = { ...rec, hashes: kept };
  }
  return out;
}
