/**
 * hash-extractor.ts
 *
 * Computes and caches per-file fingerprint hashes + depgraph for all (lib, version) pairs.
 * Format mirrors src/data/debun-hashes/all-libs.json + all-hash.json exactly.
 *
 * Cache layout — 6 global files, no subdirectories:
 *   data/fingerprint-cache/
 *     alllibs.json      — npm file-lib catalog
 *     allhash.json      — npm inverted index
 *     alldeps.json      — npm depgraphs
 *     cdn-alllibs.json  — cdn file-lib catalog
 *     cdn-allhash.json  — cdn inverted index
 *
 * File-lib naming convention (matches reference all-libs.json):
 *   relPath "src/core/nodeName.js" under lib "jquery" → "jquery____src.core.nodeName"
 *   Steps: replace "/" with ".", strip trailing .js/.mjs/.cjs extension.
 *
 * opts.source: 'npm' (default) | 'cdn' — selects which cache set to use.
 * opts.dupSet + opts.stripDupNodes: apply dup filter post-cache; when stripDupNodes=true
 *   also remove wholly-dup-removed files from the returned depgraph.
 *
 * Migration: rm -rf data/fingerprint-cache
 */

import fs from 'fs';
import path from 'path';
import fingerprintCollector from './index';
import { collectHashesForModel, parseModel } from './pog-models';

// POG-generation model for this cache build (env MODEL, default 'pog' = full).
// Each model is fingerprinted into its own FP_CACHE_DIR (see pog-models MODEL_CACHE).
const HE_MODEL = parseModel(process.env['MODEL']);
import { buildDepGraph } from './depgraph-builder';
import { applyDupFilter } from './dup-filter';
import { FileHashRecord, DepGraph } from '../types/depgraph';

// ── file helpers (verbatim from lib-database.ts) ──

function getAllFiles(dirPath: string, basePath: string = dirPath): string[] {
  const entries = fs.readdirSync(dirPath, { withFileTypes: true });
  let result: string[] = [];
  for (const entry of entries) {
    const fullPath = path.join(dirPath, entry.name);
    if (entry.isFile()) result.push(path.relative(basePath, fullPath));
    else if (entry.isDirectory()) result = result.concat(getAllFiles(fullPath, basePath));
  }
  return result;
}

function isJS(files: string[]): string[] {
  return files.filter((f) => f.endsWith('.js') || f.endsWith('.mjs') || f.endsWith('.cjs'));
}

// ── public types ──

export interface ExtractedHashes {
  fileHashes: Record<string, FileHashRecord>;
  depgraph: DepGraph;
  cached: boolean;
}

export interface HashExtractorOpts {
  cacheDir?: string;
  dupSet?: Set<string>;
  source?: 'npm' | 'cdn';     // default 'npm'
  stripDupNodes?: boolean;     // when true, also strip wholly-removed files from depgraph
  /**
   * Cache-build mode: when true, skip reconstructing fileHashes/depgraph on a
   * cache HIT (that reconstruction scans the whole inverted index — O(#hashes)
   * per version). `populate-fingerprint-cache` only reads the `cached` flag, so
   * it passes this to avoid pathological O(n^2) behaviour on large caches.
   */
  cacheOnly?: boolean;
}

// ── on-disk types ──

type LibData = Record<string, { id: number; versions: string[]; hashCnt: number[] }>;
type HashData = Record<string, Record<string, Record<string, Array<[number, number]>>>>;
type DepData  = Record<string, { nodes: number[]; edges: [number, number][]; unresolved: [number, string][] }>;

// ── per-source in-memory state ──

interface SourceState {
  allLibs: LibData;
  allHash: HashData;
  allDeps: DepData;
  libIdByKey: Map<string, number>;
  verIdxByKeyVer: Map<string, Map<string, number>>;
  keyById: Map<number, string>;
  parentVerCached: Map<string, boolean>;
  relPathToKey: Map<string, Map<string, string>>;
  fileIdToHashes: Map<number, string[]>;
  nextId: number;
  loaded: boolean;
  dirty: boolean;
  libsFile: string;
  hashFile: string;
  depsFile: string;
}

function makeSourceState(libsFile: string, hashFile: string, depsFile: string): SourceState {
  return {
    allLibs: {}, allHash: {}, allDeps: {},
    libIdByKey: new Map(), verIdxByKeyVer: new Map(), keyById: new Map(),
    parentVerCached: new Map(), relPathToKey: new Map(), fileIdToHashes: new Map(),
    nextId: 0, loaded: false, dirty: false,
    libsFile, hashFile, depsFile,
  };
}

const sources: Record<'npm' | 'cdn', SourceState | null> = { npm: null, cdn: null };

let resolvedCacheDir: string | null = null;

function getCacheDir(opts?: HashExtractorOpts): string {
  if (resolvedCacheDir) return resolvedCacheDir;
  const base = opts?.cacheDir ?? process.env['FP_CACHE_DIR'] ?? 'src/data/fingerprint-cache';
  resolvedCacheDir = path.isAbsolute(base) ? base : path.join(process.cwd(), base);
  return resolvedCacheDir;
}

function getSourceState(opts?: HashExtractorOpts): SourceState {
  const src = opts?.source ?? 'npm';
  if (!sources[src]) {
    const dir = getCacheDir(opts);
    const prefix = src === 'cdn' ? 'cdn-' : '';
    sources[src] = makeSourceState(
      path.join(dir, `${prefix}alllibs.json`),
      path.join(dir, `${prefix}allhash.json`),
      path.join(dir, `${prefix}alldeps.json`),
    );
  }
  return sources[src]!;
}

function tryReadJson<T>(p: string): T | null {
  if (!fs.existsSync(p)) return null;
  try {
    if (fs.statSync(p).isDirectory()) return null;
    return JSON.parse(fs.readFileSync(p, 'utf-8')) as T;
  } catch (e) {
    console.warn(`[cache load fail] ${path.basename(p)}: ${(e as Error).message}`);
    return null;
  }
}

// ── naming ──

function toFilelibKey(libName: string, relPath: string): string {
  const dotted = relPath.replace(/[/\\]/g, '.').replace(/\.(js|mjs|cjs)$/, '');
  return `${libName}____${dotted}`;
}

// ── load ──

function buildReverseIndexes(s: SourceState): void {
  s.libIdByKey.clear(); s.verIdxByKeyVer.clear(); s.keyById.clear();
  s.nextId = 0;
  for (const [key, entry] of Object.entries(s.allLibs)) {
    s.libIdByKey.set(key, entry.id);
    s.keyById.set(entry.id, key);
    if (entry.id >= s.nextId) s.nextId = entry.id + 1;
    const vm = new Map<string, number>();
    entry.versions.forEach((v, i) => vm.set(v, i));
    s.verIdxByKeyVer.set(key, vm);
  }
}

function buildHashReverseIndex(s: SourceState): void {
  s.fileIdToHashes.clear();
  for (const bucket of Object.values(s.allHash)) {
    for (const [hash, libMap] of Object.entries(bucket)) {
      for (const libIdStr of Object.keys(libMap)) {
        const id = Number(libIdStr);
        let arr = s.fileIdToHashes.get(id);
        if (!arr) { arr = []; s.fileIdToHashes.set(id, arr); }
        if (!arr.includes(hash)) arr.push(hash);
      }
    }
  }
}

function ensureLoaded(s: SourceState): void {
  if (s.loaded) return;
  s.loaded = true;
  s.allLibs = tryReadJson<LibData>(s.libsFile) ?? {};
  s.allHash  = tryReadJson<HashData>(s.hashFile)  ?? {};
  s.allDeps  = tryReadJson<DepData>(s.depsFile)   ?? {};
  buildReverseIndexes(s);
  buildHashReverseIndex(s);
}

// ── flush ──

function flushSource(s: SourceState, dir: string): void {
  if (!s.dirty) return;
  try { fs.mkdirSync(dir, { recursive: true }); }
  catch (e) { console.warn(`[cache flush fail] mkdir: ${(e as Error).message}`); return; }
  const write = (p: string, obj: unknown) => {
    try { fs.writeFileSync(p, JSON.stringify(obj)); }
    catch (e) { console.warn(`[cache flush fail] ${path.basename(p)}: ${(e as Error).message}`); }
  };
  write(s.libsFile, s.allLibs);
  write(s.hashFile, s.allHash);
  write(s.depsFile, s.allDeps);
  s.dirty = false;
}

export function flushAllCaches(opts?: HashExtractorOpts): void {
  const dir = getCacheDir(opts);
  if (sources.npm) flushSource(sources.npm, dir);
  if (sources.cdn) flushSource(sources.cdn, dir);
}

export function flushLibCache(_libName: string, opts?: HashExtractorOpts): void {
  flushAllCaches(opts);
}

process.on('beforeExit', () => flushAllCaches());
process.on('SIGINT', () => { flushAllCaches(); process.exit(130); });

// ── range-compression (verbatim logic from lib-database.ts:136-160) ──

function insertVersionIdx(
  s: SourceState,
  nodes: number,
  hash: string,
  libId: number,
  versionIdx: number,
): void {
  const nodesKey = String(nodes);
  const libIdKey = String(libId);
  if (!s.allHash[nodesKey]) {
    s.allHash[nodesKey] = { [hash]: { [libIdKey]: [[versionIdx, versionIdx]] } };
    return;
  }
  if (!s.allHash[nodesKey][hash]) {
    s.allHash[nodesKey][hash] = { [libIdKey]: [[versionIdx, versionIdx]] };
    return;
  }
  if (!s.allHash[nodesKey][hash][libIdKey]) {
    s.allHash[nodesKey][hash][libIdKey] = [[versionIdx, versionIdx]];
    return;
  }
  const ranges = s.allHash[nodesKey][hash][libIdKey];
  if (ranges[ranges.length - 1][1] === versionIdx - 1) {
    ranges[ranges.length - 1][1] = versionIdx;
  } else {
    ranges.push([versionIdx, versionIdx]);
  }
}

// ── cache check ──

function isVersionCached(s: SourceState, libName: string, version: string): boolean {
  const ck = `${libName}\0${version}`;
  if (s.parentVerCached.has(ck)) return s.parentVerCached.get(ck)!;
  // Prefer allDeps (npm has it). For cdn (no deps), check allLibs: any file-lib
  // entry whose parent is `libName` and versions array contains `version`.
  let cached = `${libName}@${version}` in s.allDeps;
  if (!cached) {
    for (const [key, entry] of Object.entries(s.allLibs)) {
      if (key.split('____')[0] !== libName) continue;
      if ((entry as { versions: string[] }).versions.includes(version)) {
        cached = true;
        break;
      }
    }
  }
  s.parentVerCached.set(ck, cached);
  return cached;
}

// ── reconstruct fileHashes ──

function reconstructFileHashes(s: SourceState, libName: string, version: string): Record<string, FileHashRecord> {
  const result: Record<string, FileHashRecord> = {};
  const prefix = `${libName}____`;
  const pverKey = `${libName}\0${version}`;
  const pathMap = s.relPathToKey.get(pverKey);

  for (const [key, entry] of Object.entries(s.allLibs)) {
    if (!key.startsWith(prefix)) continue;
    const verMap = s.verIdxByKeyVer.get(key);
    if (!verMap?.has(version)) continue;
    const verIdx = verMap.get(version)!;
    const libId = entry.id;
    const libIdKey = String(libId);

    const hashes: string[] = [];
    for (const bucket of Object.values(s.allHash)) {
      for (const [hash, libMap] of Object.entries(bucket)) {
        if (!libMap[libIdKey]) continue;
        for (const [lo, hi] of libMap[libIdKey]) {
          if (verIdx >= lo && verIdx <= hi) { hashes.push(hash); break; }
        }
      }
    }

    // Recover relPath: prefer in-memory pathMap, fallback dotted→slashed
    let relPath: string | null = null;
    if (pathMap) {
      for (const [rp, k] of pathMap) { if (k === key) { relPath = rp; break; } }
    }
    if (!relPath) {
      // Store relPath in alllibs so we can round-trip without the in-memory map
      // (populated during storeFileHashesRaw via relPathEntry field — see below)
      relPath = (entry as { relPath?: string }).relPath
        ?? key.slice(prefix.length).replace(/\./g, '/') + '.js';
    }

    result[relPath] = { hashes, funcCount: entry.hashCnt[verIdx] ?? 0 };
  }
  return result;
}

// ── compute raw ──

interface HashWithNodes { hash: string; nodes: number; }

// LoC filter for npm/cdn fingerprinting. escodegen-printed line count must be
// >= NPM_CDN_MIN_FN_LOC for the function to contribute a hash. Site/web hashing
// (gen-web-hashes.ts) deliberately leaves this off — it calls fingerprintCollector
// without an extractOpts arg, so default minFnLoc=0 (no filter) applies there.
const NPM_CDN_MIN_FN_LOC = (() => {
  const raw = process.env['MIN_FN_LOC'];
  const n = raw === undefined ? 6 : parseInt(raw, 10);
  return Number.isFinite(n) && n > 0 ? n : 0;
})();

function computeFileHashesRaw(
  pkgRoot: string, libName: string, version: string,
): Record<string, { hashes: HashWithNodes[]; funcCount: number }> {
  const result: Record<string, { hashes: HashWithNodes[]; funcCount: number }> = {};
  let files: string[];
  try { files = isJS(getAllFiles(pkgRoot)); }
  catch { return result; }
  for (const file of [...files].sort()) {
    try {
      const code = fs.readFileSync(path.join(pkgRoot, file), 'utf-8');
      try {
        const pogs = collectHashesForModel(code, HE_MODEL, { minFnLoc: NPM_CDN_MIN_FN_LOC });
        const seen = new Map<string, number>();
        for (const p of pogs) if (!seen.has(p.hash)) seen.set(p.hash, p.nodes);
        const hashes: HashWithNodes[] = [];
        for (const [hash, nodes] of seen) hashes.push({ hash, nodes });
        result[file] = { hashes, funcCount: pogs.length };
      } catch (e) {
        console.log('[hash error]', libName, version, file, (e as Error).message);
        result[file] = { hashes: [], funcCount: 0 };
      }
    } catch (e) {
      console.log('[hash error]', libName, version, file, (e as Error).message);
    }
  }
  return result;
}

// ── store raw hashes ──

function storeFileHashesRaw(
  s: SourceState,
  libName: string, version: string,
  raw: Record<string, { hashes: HashWithNodes[]; funcCount: number }>,
  pverKey: string,
): void {
  const pathMap = new Map<string, string>();
  s.relPathToKey.set(pverKey, pathMap);

  for (const [relPath, rec] of Object.entries(raw)) {
    const key = toFilelibKey(libName, relPath);
    pathMap.set(relPath, key);

    let entry = s.allLibs[key] as { id: number; versions: string[]; hashCnt: number[]; relPath?: string };
    if (!entry) {
      const id = s.nextId++;
      entry = { id, versions: [], hashCnt: [], relPath };
      s.allLibs[key] = entry;
      s.libIdByKey.set(key, id);
      s.keyById.set(id, key);
      s.verIdxByKeyVer.set(key, new Map());
    } else if (!entry.relPath) {
      entry.relPath = relPath;
    }

    const verMap = s.verIdxByKeyVer.get(key)!;
    if (verMap.has(version)) continue;
    const verIdx = entry.versions.length;
    entry.versions.push(version);
    entry.hashCnt.push(rec.funcCount);
    verMap.set(version, verIdx);

    const libId = entry.id;
    for (const { hash, nodes } of rec.hashes) {
      insertVersionIdx(s, nodes, hash, libId, verIdx);
      let arr = s.fileIdToHashes.get(libId);
      if (!arr) { arr = []; s.fileIdToHashes.set(libId, arr); }
      if (!arr.includes(hash)) arr.push(hash);
    }
  }
}

function rawToFileHashes(raw: Record<string, { hashes: HashWithNodes[]; funcCount: number }>): Record<string, FileHashRecord> {
  const result: Record<string, FileHashRecord> = {};
  for (const [relPath, rec] of Object.entries(raw)) {
    result[relPath] = { hashes: rec.hashes.map((h) => h.hash), funcCount: rec.funcCount };
  }
  return result;
}

// ── store/reconstruct depgraph ──

function storeDepGraph(s: SourceState, libName: string, version: string, depgraph: DepGraph, pverKey: string): void {
  const pathMap = s.relPathToKey.get(pverKey);
  const toId = (relPath: string): number | null => {
    const key = pathMap?.get(relPath) ?? toFilelibKey(libName, relPath);
    const id = s.libIdByKey.get(key);
    return id !== undefined ? id : null;
  };
  const nodes: number[] = [];
  for (const n of depgraph.nodes) { const id = toId(n); if (id !== null) nodes.push(id); }
  const edges: [number, number][] = [];
  for (const [a, b] of depgraph.edges) {
    const ia = toId(a), ib = toId(b);
    if (ia !== null && ib !== null) edges.push([ia, ib]);
  }
  const unresolved: [number, string][] = [];
  for (const [a, spec] of depgraph.unresolved) {
    const ia = toId(a); if (ia !== null) unresolved.push([ia, spec]);
  }
  s.allDeps[`${libName}@${version}`] = { nodes, edges, unresolved };
}

function reconstructDepGraph(s: SourceState, libName: string, version: string): DepGraph {
  const ge = s.allDeps[`${libName}@${version}`];
  if (!ge) return { nodes: [], edges: [], unresolved: [] };
  const pverKey = `${libName}\0${version}`;
  const pathMap = s.relPathToKey.get(pverKey);

  const toPath = (id: number): string => {
    const key = s.keyById.get(id);
    if (!key) return String(id);
    // Prefer stored relPath field (round-trip safe)
    const entry = s.allLibs[key] as { relPath?: string } | undefined;
    if (entry?.relPath) return entry.relPath;
    // Prefer in-memory pathMap
    if (pathMap) { for (const [rp, k] of pathMap) { if (k === key) return rp; } }
    // Fallback: dotted → slashed
    const prefix = `${libName}____`;
    if (key.startsWith(prefix)) return key.slice(prefix.length).replace(/\./g, '/') + '.js';
    return key;
  };

  return {
    nodes: ge.nodes.map(toPath).sort(),
    edges: ge.edges.map(([a, b]) => [toPath(a), toPath(b)] as [string, string]),
    unresolved: ge.unresolved.map(([a, spec]) => [toPath(a), spec] as [string, string]),
  };
}

// ── depgraph node-stripping helper ──

export function stripDupNodesFromDepgraph(
  depgraph: DepGraph,
  removedFiles: Set<string>,
): DepGraph {
  if (removedFiles.size === 0) return depgraph;
  const nodes = depgraph.nodes.filter((n) => !removedFiles.has(n));
  const edges = depgraph.edges.filter(([a, b]) => !removedFiles.has(a) && !removedFiles.has(b));
  const unresolved = depgraph.unresolved.filter(([a]) => !removedFiles.has(a));
  return { nodes, edges, unresolved };
}

// ── main export ──

export function extractHashes(
  libName: string,
  version: string,
  pkgRoot: string,
  opts?: HashExtractorOpts,
): ExtractedHashes {
  const s = getSourceState(opts);
  ensureLoaded(s);

  const cached = isVersionCached(s, libName, version);
  let fileHashes: Record<string, FileHashRecord>;
  let depgraph: DepGraph;

  const isCdn = opts?.source === 'cdn';

  if (cached && opts?.cacheOnly) {
    // Cache-build mode: caller only needs `cached`. Skip the O(#hashes) rebuild.
    return { fileHashes: {}, depgraph: { nodes: [], edges: [], unresolved: [] }, cached: true };
  }
  if (cached) {
    fileHashes = reconstructFileHashes(s, libName, version);
    depgraph   = isCdn
      ? { nodes: Object.keys(fileHashes).sort(), edges: [], unresolved: [] }
      : reconstructDepGraph(s, libName, version);
  } else {
    const pverKey = `${libName}\0${version}`;
    const raw = computeFileHashesRaw(pkgRoot, libName, version);
    storeFileHashesRaw(s, libName, version, raw, pverKey);
    fileHashes = rawToFileHashes(raw);
    if (isCdn) {
      // cdn distributions are bundled — depgraph edges rarely meaningful, skip.
      depgraph = { nodes: Object.keys(fileHashes).sort(), edges: [], unresolved: [] };
    } else {
      try {
        depgraph = buildDepGraph(pkgRoot);
      } catch (e) {
        console.log('[depgraph error]', libName, version, (e as Error).message);
        depgraph = { nodes: Object.keys(fileHashes).sort(), edges: [], unresolved: [] };
      }
      storeDepGraph(s, libName, version, depgraph, pverKey);
    }
    s.parentVerCached.set(`${libName}\0${version}`, true);
    s.dirty = true;
  }

  // Apply dup filter post-cache (cache stays raw)
  if (opts?.dupSet && opts.dupSet.size > 0) {
    const before = Object.keys(fileHashes);
    const filtered = applyDupFilter(fileHashes, opts.dupSet);
    fileHashes = filtered;

    if (opts.stripDupNodes) {
      const after = new Set(Object.keys(filtered));
      const removed = new Set(before.filter((p) => !after.has(p)));
      depgraph = stripDupNodesFromDepgraph(depgraph, removed);
    }
  }

  return { fileHashes, depgraph, cached };
}

// ── parallel-friendly entrypoints (worker pool) ────────────────────────────
// Workers call computeRawPerVersion (pure CPU); main thread calls
// applyRawPerVersion to mutate the shared SourceState, then flushAllCaches.

export type RawPerVersion = Record<string, { hashes: HashWithNodes[]; funcCount: number }>;

export function computeRawPerVersion(
  libName: string,
  version: string,
  pkgRoot: string,
  isCdn: boolean,
): { raw: RawPerVersion; depgraph: DepGraph | null } {
  const raw = computeFileHashesRaw(pkgRoot, libName, version);
  let depgraph: DepGraph | null = null;
  if (!isCdn) {
    try { depgraph = buildDepGraph(pkgRoot); }
    catch (e) { console.log('[depgraph error]', libName, version, (e as Error).message); }
  }
  return { raw, depgraph };
}

export function applyRawPerVersion(
  libName: string,
  version: string,
  raw: RawPerVersion,
  depgraph: DepGraph | null,
  opts?: HashExtractorOpts,
): void {
  const s = getSourceState(opts);
  ensureLoaded(s);
  if (isVersionCached(s, libName, version)) return;
  const pverKey = `${libName}\0${version}`;
  storeFileHashesRaw(s, libName, version, raw, pverKey);
  if (depgraph) storeDepGraph(s, libName, version, depgraph, pverKey);
  s.parentVerCached.set(pverKey, true);
  s.dirty = true;
}

export function isCachedPerVersion(
  libName: string,
  version: string,
  opts?: HashExtractorOpts,
): boolean {
  const s = getSourceState(opts);
  ensureLoaded(s);
  return isVersionCached(s, libName, version);
}
