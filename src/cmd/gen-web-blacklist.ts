/**
 * Compute popular-hash blacklist across the target website corpus.
 *
 * For each hash, count how many of the TARGET_URLS' allWebHashes/<site>.json
 * files contain it. If the count ≥ |TARGET_URLS| × THRESHOLD, the hash is
 * considered "ubiquitous" and is added to the blacklist, which downstream
 * pipelines (npm→web detection) subtract from npm fingerprints to remove
 * generic noise.
 *
 * Output: data/fingerprint-cache/web-blacklist-<THRESHOLD>.json
 *   Shape: { [nodes: string]: string[] }   (same shape as allWebHashes files)
 *
 * Env:
 *   WEB_BLACKLIST_THRESHOLD  default 0.6  (fraction of sites)
 */
import fs from 'fs';
import path from 'path';
import { TARGET_URLS } from '../utils/urls';

const rootDir = process.cwd();
const webHashDir = path.join(rootDir, 'src/data/allWebHashes');
const cacheDirEnv = process.env['FP_CACHE_DIR'] ?? 'src/data/fingerprint-cache';
const outDir = path.isAbsolute(cacheDirEnv) ? cacheDirEnv : path.join(rootDir, cacheDirEnv);

// Reads the per-model website hashes (allWebHashes/<site><SUFFIX>.json) and
// writes an unsuffixed blacklist into the per-model cache dir (FP_CACHE_DIR).
import { MODEL_SUFFIX, parseModel } from '../fingerprint-collector/pog-models';
const SUFFIX = MODEL_SUFFIX[parseModel(process.env['MODEL'])];

function getBlacklistPath(threshold: number): string {
  return path.join(outDir, `web-blacklist-${threshold}.json`);
}

(() => {
  const threshold = parseFloat(process.env['WEB_BLACKLIST_THRESHOLD'] ?? '0.6');
  if (!Number.isFinite(threshold) || threshold <= 0 || threshold > 1) {
    console.error(`[Fatal] WEB_BLACKLIST_THRESHOLD must be in (0, 1], got '${process.env['WEB_BLACKLIST_THRESHOLD']}'`);
    process.exit(1);
  }

  fs.mkdirSync(outDir, { recursive: true });

  const commonHashesCnt: Record<string, Record<string, number>> = {};
  let sitesRead = 0;
  for (const url of TARGET_URLS) {
    const hashPath = path.join(webHashDir, `${url}${SUFFIX}.json`);
    if (!fs.existsSync(hashPath)) {
      console.warn(`[skip] no hash file: ${url}`);
      continue;
    }
    let hashes: Record<string, string[]>;
    try {
      hashes = JSON.parse(fs.readFileSync(hashPath, 'utf-8'));
    } catch (e) {
      console.warn(`[skip] failed to parse ${url}.json: ${(e as Error).message}`);
      continue;
    }
    sitesRead++;
    for (const [nodes, arr] of Object.entries(hashes)) {
      for (const hash of arr) {
        if (!commonHashesCnt[nodes]) commonHashesCnt[nodes] = {};
        commonHashesCnt[nodes][hash] = (commonHashesCnt[nodes][hash] ?? 0) + 1;
      }
    }
  }

  const minCnt = sitesRead * threshold;
  const popularHashes: Record<string, string[]> = {};
  let total = 0;
  for (const [nodes, hashWithCnt] of Object.entries(commonHashesCnt)) {
    for (const [hash, cnt] of Object.entries(hashWithCnt)) {
      if (cnt >= minCnt) {
        if (!popularHashes[nodes]) popularHashes[nodes] = [];
        popularHashes[nodes].push(hash);
        total++;
      }
    }
  }

  const outPath = getBlacklistPath(threshold);
  fs.writeFileSync(outPath, JSON.stringify(popularHashes, null, 2));
  console.log(
    `[done] ${total} ubiquitous hashes (≥${Math.ceil(minCnt)} of ${sitesRead} sites, threshold=${threshold}) → ${outPath}`
  );
})();
