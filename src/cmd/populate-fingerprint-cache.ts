/**
 * Populate `src/data/fingerprint-cache/` (npm + cdn) by fingerprinting every
 * semver-valid version of every library under `src/data/npm/` and `src/data/cdn/`.
 *
 * This is a one-off cache-warming step — no detection, no graphs, just hashes.
 * Run it once so subsequent eval / modgraph scripts are fast.
 *
 * Usage:
 *   NODE_OPTIONS='--max-old-space-size=12288' npx ts-node --transpile-only src/cmd/populate-fingerprint-cache.ts
 *
 * Env:
 *   NPM_FILTER_LIB  comma-separated lib names (default: all libs present in either npm or cdn dir)
 *   SKIP_NPM=1     skip npm side
 *   SKIP_CDN=1     skip cdn side
 */
import fs from 'fs';
import path, { join } from 'path';
import semverSort from 'semver/functions/sort';
import semverValid from 'semver/functions/valid';
import { extractHashes, flushLibCache, flushAllCaches } from '../fingerprint-collector/hash-extractor';

// Flushing the full cache after every library is O(n^2) in disk I/O (each lib
// rewrites the growing 130MB+ cache). By default we flush once at the end;
// set FLUSH_EACH=1 for the old per-lib flush (crash-resilient but slow).
const FLUSH_EACH = process.env['FLUSH_EACH'] === '1';

const rootDir = process.cwd();
const npmDataDir = join(rootDir, 'src/data/npm');
const cdnDataDir = join(rootDir, 'src/data/cdn');

const parseVersionString = (version: string) => {
  const [major, minor, patch = '0'] = version.split('.');
  const [patchVersion, patchSuffix = '0'] = patch.split('-');
  return [parseInt(major), parseInt(minor), parseInt(patchVersion), patchSuffix];
};

function isValidSemver(version: string): boolean {
  return !!(semverValid(version) && parseVersionString(version)[3] === '0');
}

function listSemverVersions(baseDir: string, libName: string): string[] {
  const libPath = join(baseDir, libName);
  if (!fs.existsSync(libPath)) return [];
  try {
    const versions = fs.readdirSync(libPath).filter(isValidSemver);
    return semverSort(versions);
  } catch {
    return [];
  }
}

async function populateSource(source: 'npm' | 'cdn', baseDir: string, targetLibs: string[]): Promise<void> {
  console.log(`\n[${source}] populating ${targetLibs.length} libs from ${baseDir}`);
  let libsDone = 0;
  let versionsDone = 0;
  let versionsCached = 0;
  const start = Date.now();
  for (const libName of targetLibs) {
    const versions = listSemverVersions(baseDir, libName);
    if (versions.length === 0) continue;
    for (const version of versions) {
      const pkgRoot = join(baseDir, libName, version);
      const t0 = Date.now();
      const { cached } = extractHashes(libName, version, pkgRoot, { source, cacheOnly: true });
      const dt = Date.now() - t0;
      versionsDone++;
      if (cached) versionsCached++;
      if (versionsDone % 50 === 0) {
        const elapsed = ((Date.now() - start) / 1000).toFixed(0);
        console.log(`  [${source}] progress ${versionsDone} versions (${versionsCached} cached) — ${elapsed}s`);
      }
      if (!cached && dt > 2000) {
        console.log(`  [${source}] ${libName}/${version} took ${dt}ms (${versions.length} versions in lib)`);
      }
    }
    if (FLUSH_EACH) flushLibCache(libName, { source });
    libsDone++;
    if (libsDone % 10 === 0) {
      console.log(`  [${source}] ${libsDone}/${targetLibs.length} libs flushed`);
    }
  }
  const elapsed = ((Date.now() - start) / 1000).toFixed(0);
  console.log(`[${source}] done: ${libsDone} libs, ${versionsDone} versions (${versionsCached} cache hits) in ${elapsed}s`);
}

(async () => {
  const skipNpm = process.env['SKIP_NPM'] === '1';
  const skipCdn = process.env['SKIP_CDN'] === '1';
  const libEnv = process.env['NPM_FILTER_LIB'];

  let targetLibs: string[];
  if (libEnv) {
    targetLibs = libEnv.split(',').map((s) => s.trim()).filter(Boolean);
  } else {
    const npmSet = fs.existsSync(npmDataDir) ? new Set(fs.readdirSync(npmDataDir)) : new Set<string>();
    const cdnSet = fs.existsSync(cdnDataDir) ? new Set(fs.readdirSync(cdnDataDir)) : new Set<string>();
    const union = new Set<string>([...npmSet, ...cdnSet]);
    targetLibs = [...union].sort();
  }

  console.log(`[config] libs: ${targetLibs.length}, skipNpm=${skipNpm}, skipCdn=${skipCdn}`);

  if (!skipNpm) await populateSource('npm', npmDataDir, targetLibs);
  if (!skipCdn) await populateSource('cdn', cdnDataDir, targetLibs);

  if (!FLUSH_EACH) {
    console.log('[flush] writing cache once …');
    flushAllCaches();
  }
  console.log('\n[done] cache populated');
})();
