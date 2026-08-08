/**
 * Parallel populate-fingerprint-cache: worker_threads pool variant of
 * `src/cmd/populate-fingerprint-cache.ts`.
 *
 * Layout:
 *   - Workers run `computeRawPerVersion` (pure CPU: parse + AST + hash).
 *   - Main thread owns the SourceState and calls `applyRawPerVersion` /
 *     `flushAllCaches`. Workers never touch shared state.
 *
 * Usage:
 *   NODE_OPTIONS='--max-old-space-size=12288' \
 *   npx ts-node --transpile-only src/cmd/populate-fingerprint-cache-parallel.ts
 *
 * Env:
 *   NPM_FILTER_LIB  comma-separated lib names
 *   SKIP_NPM=1      skip npm side
 *   SKIP_CDN=1      skip cdn side
 *   WORKERS=N       worker pool size (default: min(8, cpu/2))
 */
import { Worker, isMainThread, parentPort } from 'worker_threads';
import os from 'os';
import fs from 'fs';
import path, { join } from 'path';
import semverSort from 'semver/functions/sort';
import semverValid from 'semver/functions/valid';
import {
  applyRawPerVersion,
  computeRawPerVersion,
  flushAllCaches,
  isCachedPerVersion,
  RawPerVersion,
} from '../fingerprint-collector/hash-extractor';
import type { DepGraph } from '../types/depgraph';

// ── worker side ───────────────────────────────────────────────────────────
if (!isMainThread) {
  parentPort!.on('message', (task: WorkerTask) => {
    try {
      const { libName, version, pkgRoot, isCdn } = task;
      const { raw, depgraph } = computeRawPerVersion(libName, version, pkgRoot, isCdn);
      const reply: WorkerReply = { ok: true, taskId: task.taskId, raw, depgraph };
      parentPort!.postMessage(reply);
    } catch (e) {
      const reply: WorkerReply = { ok: false, taskId: task.taskId, error: (e as Error)?.message ?? String(e) };
      parentPort!.postMessage(reply);
    }
  });
  // worker is event-driven; nothing else to do
}

// ── types ─────────────────────────────────────────────────────────────────
interface WorkerTask {
  taskId: number;
  libName: string;
  version: string;
  pkgRoot: string;
  isCdn: boolean;
}
type WorkerReply =
  | { ok: true; taskId: number; raw: RawPerVersion; depgraph: DepGraph | null }
  | { ok: false; taskId: number; error: string };

// ── main side ─────────────────────────────────────────────────────────────
const rootDir = process.cwd();
const npmDataDir = join(rootDir, 'src/data/npm');
const cdnDataDir = join(rootDir, 'src/data/cdn');

function parseVersionString(version: string) {
  const [major, minor, patch = '0'] = version.split('.');
  const [patchVersion, patchSuffix = '0'] = patch.split('-');
  return [parseInt(major), parseInt(minor), parseInt(patchVersion), patchSuffix];
}
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

interface PendingTask extends WorkerTask {
  source: 'npm' | 'cdn';
}

async function processSource(
  source: 'npm' | 'cdn',
  baseDir: string,
  targetLibs: string[],
  workers: Worker[],
): Promise<void> {
  console.log(`\n[${source}] populating ${targetLibs.length} libs from ${baseDir}`);
  const isCdn = source === 'cdn';
  const start = Date.now();
  let versionsDone = 0;
  let versionsCached = 0;
  let libsDone = 0;

  for (const libName of targetLibs) {
    const versions = listSemverVersions(baseDir, libName);
    if (versions.length === 0) continue;

    const pending: PendingTask[] = [];
    for (const version of versions) {
      if (isCachedPerVersion(libName, version, { source })) {
        versionsCached++;
        versionsDone++;
        continue;
      }
      const pkgRoot = join(baseDir, libName, version);
      pending.push({ source, taskId: 0, libName, version, pkgRoot, isCdn });
    }

    if (pending.length > 0) {
      await runBatch(pending, workers, source, (dt, task) => {
        versionsDone++;
        if (versionsDone % 50 === 0) {
          const elapsed = ((Date.now() - start) / 1000).toFixed(0);
          console.log(`  [${source}] progress ${versionsDone} versions (${versionsCached} cached) — ${elapsed}s`);
        }
        if (dt > 2000) {
          console.log(`  [${source}] ${task.libName}/${task.version} took ${dt}ms (${versions.length} versions in lib)`);
        }
      });
    } else {
      versionsDone += 0; // already counted as cached above
    }

    flushAllCaches({ source });
    libsDone++;
    if (libsDone % 10 === 0) {
      console.log(`  [${source}] ${libsDone}/${targetLibs.length} libs flushed`);
    }
  }

  const elapsed = ((Date.now() - start) / 1000).toFixed(0);
  console.log(`[${source}] done: ${libsDone} libs, ${versionsDone} versions (${versionsCached} cache hits) in ${elapsed}s`);
}

interface WorkerState {
  busy: boolean;
  currentTaskId: number;
  startedAt: number;
  resolve?: (reply: WorkerReply) => void;
}

function runBatch(
  tasks: PendingTask[],
  workers: Worker[],
  source: 'npm' | 'cdn',
  onComplete: (dt: number, task: PendingTask) => void,
): Promise<void> {
  return new Promise((resolveAll, rejectAll) => {
    const states = workers.map<WorkerState>(() => ({ busy: false, currentTaskId: -1, startedAt: 0 }));
    let nextTask = 0;
    let remaining = tasks.length;
    let nextTaskId = 1;
    const taskById = new Map<number, PendingTask>();

    const dispatch = () => {
      while (nextTask < tasks.length) {
        const idx = states.findIndex((s) => !s.busy);
        if (idx === -1) return;
        const task = tasks[nextTask++];
        task.taskId = nextTaskId++;
        taskById.set(task.taskId, task);
        states[idx].busy = true;
        states[idx].currentTaskId = task.taskId;
        states[idx].startedAt = Date.now();
        workers[idx].postMessage(task);
      }
    };

    const onMessage = (idx: number) => (reply: WorkerReply) => {
      const dt = Date.now() - states[idx].startedAt;
      const task = taskById.get(reply.taskId);
      if (!task) {
        console.warn(`[parallel] orphan reply taskId=${reply.taskId}`);
      } else {
        taskById.delete(reply.taskId);
        if (reply.ok) {
          try {
            applyRawPerVersion(task.libName, task.version, reply.raw, reply.depgraph, { source });
          } catch (e) {
            console.warn(`[apply-fail] ${task.libName}/${task.version}: ${(e as Error).message}`);
          }
        } else {
          console.warn(`[worker-fail] ${task.libName}/${task.version}: ${reply.error}`);
        }
        onComplete(dt, task);
      }
      states[idx].busy = false;
      states[idx].currentTaskId = -1;
      remaining--;
      if (remaining === 0) {
        for (const w of workers) w.removeAllListeners('message');
        resolveAll();
      } else {
        dispatch();
      }
    };

    for (let i = 0; i < workers.length; i++) {
      workers[i].on('message', onMessage(i));
      workers[i].on('error', rejectAll);
    }
    dispatch();
  });
}

async function main(): Promise<void> {
  const skipNpm = process.env['SKIP_NPM'] === '1';
  const skipCdn = process.env['SKIP_CDN'] === '1';
  const libEnv = process.env['NPM_FILTER_LIB'];
  const workersEnv = process.env['WORKERS'];
  const cpu = os.cpus().length || 4;
  const workerCount = workersEnv
    ? Math.max(1, parseInt(workersEnv, 10) | 0)
    : Math.max(1, Math.min(8, Math.floor(cpu / 2)));

  let targetLibs: string[];
  if (libEnv) {
    targetLibs = libEnv.split(',').map((s) => s.trim()).filter(Boolean);
  } else {
    const npmSet = fs.existsSync(npmDataDir) ? new Set(fs.readdirSync(npmDataDir)) : new Set<string>();
    const cdnSet = fs.existsSync(cdnDataDir) ? new Set(fs.readdirSync(cdnDataDir)) : new Set<string>();
    const union = new Set<string>([...npmSet, ...cdnSet]);
    targetLibs = [...union].sort();
  }

  console.log(`[config] libs: ${targetLibs.length}, skipNpm=${skipNpm}, skipCdn=${skipCdn}, workers=${workerCount} (cpu=${cpu})`);

  // Spawn worker pool — use this file as both entrypoint and worker via isMainThread.
  const workers: Worker[] = [];
  for (let i = 0; i < workerCount; i++) {
    workers.push(new Worker(__filename, {
      execArgv: ['-r', 'ts-node/register/transpile-only'],
    }));
  }

  // Graceful shutdown
  let flushing = false;
  const shutdown = (sig: string) => {
    if (flushing) return;
    flushing = true;
    console.log(`\n[${sig}] flushing caches before exit...`);
    try { flushAllCaches({ source: 'npm' }); } catch (e) { console.warn('npm flush:', e); }
    try { flushAllCaches({ source: 'cdn' }); } catch (e) { console.warn('cdn flush:', e); }
    for (const w of workers) w.terminate().catch(() => {});
    process.exit(130);
  };
  process.on('SIGINT',  () => shutdown('SIGINT'));
  process.on('SIGTERM', () => shutdown('SIGTERM'));

  try {
    if (!skipNpm) await processSource('npm', npmDataDir, targetLibs, workers);
    if (!skipCdn) await processSource('cdn', cdnDataDir, targetLibs, workers);
  } finally {
    for (const w of workers) await w.terminate().catch(() => {});
  }

  console.log('\n[done] cache populated');
}

// Main entrypoint — placed at file bottom so module-level consts are init'd
if (isMainThread) {
  main().catch((e) => { console.error('[fatal]', e); process.exit(1); });
}
