/**
 * cdn-dup-extractor.ts
 *
 * Derives a "noise hash" set from the CDN fingerprint cache using birth-based
 * duplicate-detection logic (port of src/debun/phase1/extract-dups.ts).
 *
 * CDN is library-unit (each variant file = a bundle of the whole library, not a
 * module inside it), so dup calculation operates on a lib-level view: variants
 * of the same library are unioned into a single (baseLib, version) hash set and
 * intra-lib pairs are never counted as duplicates.
 *
 * On-disk cache at data/fingerprint-cache/cdn-dup-hashes.json has shape:
 *   { [loserLib]: { [winnerLib]: [hash, ...] } }
 * — preserving which lib a hash is dup *to* which earlier lib, so we can do
 * per-lib filtering later (exclude hash only when matching the loser lib, etc).
 */

import fs from 'fs';
import path from 'path';

// ── types matching alllibs / allhash on-disk shapes ──

export type CdnAllLibs = Record<string, { id: number; versions: string[]; hashCnt: number[] }>;
export type CdnAllHash = Record<string, Record<string, Record<string, Array<[number, number]>>>>;

export interface CdnDupOpts {
  dupThreshold?: number;   // default 0.3
  minLibs?: number;        // default 2 (distinct baseLibs)
  maxLibs?: number;        // default 7 (distinct baseLibs)
}

/** loserLib → winnerLib → hashes attributed to that winner-loser pair */
export type CdnDupDetail = Record<string, Record<string, string[]>>;

// ── birth helpers ──

type BirthInfo = Record<string, Record<string, string>>;

// ── main: detailed output ──

export function computeCdnDupDetail(
  cdnAllLibs: CdnAllLibs,
  cdnAllHash: CdnAllHash,
  birthInfo: BirthInfo,
  opts?: CdnDupOpts,
): CdnDupDetail {
  const dupThreshold = opts?.dupThreshold ?? 0.3;
  const minLibs      = opts?.minLibs      ?? 2;
  const maxLibs      = opts?.maxLibs      ?? 7;

  // libId → { baseLib, versions } from per-variant cdn-alllibs entries
  interface FileLibInfo { baseLib: string; versions: string[] }
  const fileLibById = new Map<number, FileLibInfo>();
  for (const [key, info] of Object.entries(cdnAllLibs)) {
    const baseLib = key.split('____')[0];
    fileLibById.set(info.id, { baseLib, versions: info.versions });
  }

  // baseLib → version → Set<hash> (union across variants of same lib-version)
  const libVerHashes = new Map<string, Map<string, Set<string>>>();
  for (const hashBucket of Object.values(cdnAllHash)) {
    for (const [hash, libMap] of Object.entries(hashBucket)) {
      for (const [libIdStr, ranges] of Object.entries(libMap)) {
        const info = fileLibById.get(Number(libIdStr));
        if (!info) continue;
        let verMap = libVerHashes.get(info.baseLib);
        if (!verMap) { verMap = new Map(); libVerHashes.set(info.baseLib, verMap); }
        for (const [lo, hi] of ranges) {
          for (let vi = lo; vi <= hi; vi++) {
            const ver = info.versions[vi];
            if (!ver) continue;
            let hset = verMap.get(ver);
            if (!hset) { hset = new Set(); verMap.set(ver, hset); }
            hset.add(hash);
          }
        }
      }
    }
  }

  // baseLib → version → funcCount (size of the union hash set for that lib-version)
  const libVerFuncCount = new Map<string, Map<string, number>>();
  for (const [baseLib, verMap] of libVerHashes) {
    const fcMap = new Map<string, number>();
    for (const [ver, hset] of verMap) fcMap.set(ver, hset.size);
    libVerFuncCount.set(baseLib, fcMap);
  }

  // birth cache
  const birthCache = new Map<string, Date | null>();
  const getBirth = (baseLib: string, ver: string): Date | undefined => {
    const k = `${baseLib}@${ver}`;
    if (birthCache.has(k)) return birthCache.get(k) ?? undefined;
    const raw = birthInfo[baseLib]?.[ver];
    const d = raw ? new Date(raw) : undefined;
    birthCache.set(k, d ?? null);
    return d;
  };

  // hash → Array<[baseLib, version]>
  const hashToLibVers = new Map<string, Array<[string, string]>>();
  for (const [baseLib, verMap] of libVerHashes) {
    for (const [ver, hset] of verMap) {
      for (const h of hset) {
        let arr = hashToLibVers.get(h);
        if (!arr) { arr = []; hashToLibVers.set(h, arr); }
        arr.push([baseLib, ver]);
      }
    }
  }

  // ── Phase 1: count shared hashes per (baseLibA@verA, baseLibB@verB) pair ──
  const dupMap = new Map<string, number>();
  for (const libvers of hashToLibVers.values()) {
    const distinctBaseLibs = new Set(libvers.map(([bl]) => bl));
    if (distinctBaseLibs.size < minLibs || distinctBaseLibs.size > maxLibs) continue;

    for (let i = 0; i < libvers.length - 1; i++) {
      for (let j = i + 1; j < libvers.length; j++) {
        const [lA, vA] = libvers[i];
        const [lB, vB] = libvers[j];
        if (lA === lB) continue; // skip intra-baseLib (same library, different variants)
        const bA = getBirth(lA, vA);
        const bB = getBirth(lB, vB);
        if (!bA && !bB) continue;
        const [k1, k2] = lA < lB
          ? [`${lA}@${vA}`, `${lB}@${vB}`]
          : [`${lB}@${vB}`, `${lA}@${vA}`];
        const key = `${k1}|${k2}`;
        dupMap.set(key, (dupMap.get(key) ?? 0) + 1);
      }
    }
  }

  // ── Phase 2: threshold filter ──
  interface Candidate { lA: string; vA: string; lB: string; vB: string }
  const judgementCandidates: Candidate[] = [];
  for (const [key, dupCnt] of dupMap) {
    const [k1, k2] = key.split('|');
    const atA = k1.lastIndexOf('@');
    const atB = k2.lastIndexOf('@');
    const lA = k1.slice(0, atA), vA = k1.slice(atA + 1);
    const lB = k2.slice(0, atB), vB = k2.slice(atB + 1);
    const fcA = libVerFuncCount.get(lA)?.get(vA) || 1;
    const fcB = libVerFuncCount.get(lB)?.get(vB) || 1;
    if (dupCnt / fcA > dupThreshold || dupCnt / fcB > dupThreshold) {
      judgementCandidates.push({ lA, vA, lB, vB });
    }
  }

  // ── Phase 3: winner/loser by oldest birth date ──
  interface PairGroup { lA: string; lB: string; vA: Set<string>; vB: Set<string> }
  const pairVersions = new Map<string, PairGroup>();
  for (const c of judgementCandidates) {
    const [base1, base2] = c.lA < c.lB ? [c.lA, c.lB] : [c.lB, c.lA];
    const pairKey = `${base1}|${base2}`;
    let g = pairVersions.get(pairKey);
    if (!g) { g = { lA: base1, lB: base2, vA: new Set(), vB: new Set() }; pairVersions.set(pairKey, g); }
    if (c.lA === g.lA) { g.vA.add(c.vA); g.vB.add(c.vB); }
    else               { g.vA.add(c.vB); g.vB.add(c.vA); }
  }

  const getOldestDate = (baseLib: string, vers: Set<string>): Date => {
    let oldest = new Date();
    for (const v of vers) {
      const d = getBirth(baseLib, v);
      if (d && d < oldest) oldest = d;
    }
    return oldest;
  };

  // winner baseLib → Set of loser baseLibs
  const winnerMap = new Map<string, Set<string>>();
  for (const { lA, lB, vA, vB } of pairVersions.values()) {
    const dA = getOldestDate(lA, vA);
    const dB = getOldestDate(lB, vB);
    const [winner, loser] = dA <= dB ? [lA, lB] : [lB, lA];
    let losers = winnerMap.get(winner);
    if (!losers) { losers = new Set(); winnerMap.set(winner, losers); }
    losers.add(loser);
  }

  // ── Phase 4: attribute ALL of winner's hashes (across all winner versions) to the loser ──
  // This catches embedded copies: e.g., jqueryui npm contains external/jquery/jquery.js
  // with ALL jquery hashes, not just the subset shared with cdn jqueryui bundle.
  // By adding the full winner hash union, the loser's embedded winner files get filtered.
  const detail: CdnDupDetail = {};

  // Union of all hashes per baseLib (across all versions/variants in cdn)
  const libAllHashes = new Map<string, Set<string>>();
  for (const [baseLib, verMap] of libVerHashes) {
    const allH = new Set<string>();
    for (const hset of verMap.values()) for (const h of hset) allH.add(h);
    libAllHashes.set(baseLib, allH);
  }

  for (const [winner, losers] of winnerMap) {
    const winnerHashes = libAllHashes.get(winner);
    if (!winnerHashes) continue;
    const sorted = [...winnerHashes].sort();
    for (const loser of losers) {
      let winners = detail[loser];
      if (!winners) { winners = {}; detail[loser] = winners; }
      winners[winner] = sorted;
    }
  }

  return detail;
}

// ── flat set helper ──

export function flattenCdnDupDetail(detail: CdnDupDetail): Set<string> {
  const out = new Set<string>();
  for (const winners of Object.values(detail)) {
    for (const hashes of Object.values(winners)) {
      for (const h of hashes) out.add(h);
    }
  }
  return out;
}

export function computeCdnDupHashes(
  cdnAllLibs: CdnAllLibs,
  cdnAllHash: CdnAllHash,
  birthInfo: BirthInfo,
  opts?: CdnDupOpts,
): Set<string> {
  return flattenCdnDupDetail(computeCdnDupDetail(cdnAllLibs, cdnAllHash, birthInfo, opts));
}

// ── cached loader ──

function loadBirthInfo(): BirthInfo {
  const birthPath = path.join(process.cwd(), 'src/data/birth_sanitized.json');
  try { return JSON.parse(fs.readFileSync(birthPath, 'utf-8')) as BirthInfo; }
  catch (e) {
    console.warn(`[cdn-dup] cannot load birth_sanitized.json: ${(e as Error).message}`);
    return {};
  }
}

export function loadCdnDupDetail(
  cdnAllLibs: CdnAllLibs,
  cdnAllHash: CdnAllHash,
  cacheDir: string,
  opts?: CdnDupOpts,
): CdnDupDetail {
  const cachePath = path.join(cacheDir, 'cdn-dup-hashes.json');

  if (fs.existsSync(cachePath)) {
    try {
      const raw = JSON.parse(fs.readFileSync(cachePath, 'utf-8'));
      if (!Array.isArray(raw) && typeof raw === 'object' && raw !== null) {
        const losers = Object.keys(raw).length;
        let hashCnt = 0;
        for (const winners of Object.values(raw as CdnDupDetail)) {
          for (const hs of Object.values(winners)) hashCnt += hs.length;
        }
        console.log(`[cdn-dup] loaded detail from cache: ${losers} loser libs, ${hashCnt} loser-hash entries`);
        return raw as CdnDupDetail;
      }
      console.warn('[cdn-dup] cache shape is legacy flat array — recomputing detail');
    } catch (e) {
      console.warn(`[cdn-dup] cache load fail: ${(e as Error).message}`);
    }
  }

  console.log('[cdn-dup] computing lib-level dup detail from cdn allhash...');
  const detail = computeCdnDupDetail(cdnAllLibs, cdnAllHash, loadBirthInfo(), opts);
  const losers = Object.keys(detail).length;
  const flat = flattenCdnDupDetail(detail);
  console.log(`[cdn-dup] computed ${losers} loser libs, ${flat.size} unique dup hashes`);

  try {
    fs.mkdirSync(cacheDir, { recursive: true });
    fs.writeFileSync(cachePath, JSON.stringify(detail, null, 2));
  } catch (e) {
    console.warn(`[cdn-dup] cache write fail: ${(e as Error).message}`);
  }

  return detail;
}

export function loadCdnDupHashes(
  cdnAllLibs: CdnAllLibs,
  cdnAllHash: CdnAllHash,
  cacheDir: string,
  opts?: CdnDupOpts,
): Set<string> {
  return flattenCdnDupDetail(loadCdnDupDetail(cdnAllLibs, cdnAllHash, cacheDir, opts));
}
