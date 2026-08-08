// Per-site extraction worker. Each Worker spawns a fresh V8 isolate, so the
// JIT inline-cache state, heap fragmentation, and minor-GC roots that
// accumulated while processing earlier sites don't bleed into this site's
// timings. The main bench spawns one worker per site and awaits its result.
import { parentPort, workerData } from 'worker_threads';
import fs from 'fs';
import path from 'path';
import fingerprintCollector from '../fingerprint-collector';

interface WorkerInput { site: string; siteSrcDir: string }
const { site, siteSrcDir } = workerData as WorkerInput;

function collectJsFiles(dir: string): string[] {
  const out: string[] = [];
  if (!fs.existsSync(dir)) return out;
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, e.name);
    if (e.isDirectory()) out.push(...collectJsFiles(full));
    else if (e.isFile()) out.push(full);
  }
  return out;
}

const dir = path.join(siteSrcDir, site);
const files = collectJsFiles(dir);
const hashesArr: string[] = [];
const seen = new Set<string>();
let failCount = 0;
const timings = { parseMs: 0, scMs: 0, collectorMs: 0, pogMs: 0, hashMs: 0 };
type GlobalWithGc = typeof globalThis & { gc?: () => void };
const exposedGlobal = global as GlobalWithGc;

for (const f of files) {
  let raw: string;
  try { raw = fs.readFileSync(f, 'utf-8'); } catch { failCount++; continue; }
  try {
    for (const h of fingerprintCollector(raw, undefined, { timings })) {
      if (h.hash && !seen.has(h.hash)) { seen.add(h.hash); hashesArr.push(h.hash); }
    }
  } catch { failCount++; }
}

if (process.env['BENCH_FORCE_GC'] === '1' && exposedGlobal.gc) {
  exposedGlobal.gc();
}

parentPort!.postMessage({
  hashes: hashesArr,
  fileCount: files.length,
  failCount,
  timings,
});
