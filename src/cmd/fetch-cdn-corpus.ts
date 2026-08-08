/**
 * fetch-cdn-corpus.ts — rebuild src/data/cdn/ from cdnjs instead of a Zenodo tarball.
 *
 * The manifest is committed: `fingerprint-cache/cdn-alllibs.json` keys every library
 * submodule as `<library>____<submodule>` and carries its `relPath` and the versions it was
 * fingerprinted at. cdnjs serves exactly that layout —
 * https://cdnjs.cloudflare.com/ajax/libs/<library>/<version>/<relPath> — so the corpus is a
 * function of the manifest and needs no download of its own.
 *
 * 77 libraries, 4,556 (library, version) pairs, ~319k files, ~29 GB on disk.
 *
 * Resumable: a file already on disk is left alone, so re-running after an interruption only
 * fetches what is missing. Misses are listed at the end and written to misses.json — a
 * version cdnjs has since dropped is a real gap in the rebuilt corpus, not something to
 * discover later as a hash that fails to match.
 *
 *   CONCURRENCY=24  parallel requests (default 24)
 *   LIBS=jquery,d3  restrict to these libraries
 *   OUT=src/data/cdn
 */
import fs from 'fs';
import path from 'path';

const ROOT = process.cwd();
const MANIFEST = process.env['MANIFEST'] ?? 'src/data/fingerprint-cache/cdn-alllibs.json';
// An absolute OUT must not be joined onto the repo root: path.join(root, '/tmp/x') yields
// <repo>/tmp/x, which silently writes the corpus inside the checkout instead of failing.
const outEnv = process.env['OUT'] ?? 'src/data/cdn';
const OUT = path.isAbsolute(outEnv) ? outEnv : path.join(ROOT, outEnv);
const CONCURRENCY = parseInt(process.env['CONCURRENCY'] ?? '24', 10);
const ONLY = process.env['LIBS'] ? new Set(process.env['LIBS'].split(',').map((s) => s.trim())) : null;
const BASE = 'https://cdnjs.cloudflare.com/ajax/libs';

interface LibInfo { versions?: string[]; relPath?: string }

const manifestPath = path.isAbsolute(MANIFEST) ? MANIFEST : path.join(ROOT, MANIFEST);
if (!fs.existsSync(manifestPath)) {
  console.error(`manifest not found: ${manifestPath}`);
  console.error('It is committed at src/data/fingerprint-cache/cdn-alllibs.json — run from the repo root.');
  process.exit(1);
}
const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8')) as Record<string, LibInfo>;

interface Job { lib: string; version: string; rel: string; dest: string }
const jobs: Job[] = [];
for (const [key, info] of Object.entries(manifest)) {
  const lib = key.split('____')[0];
  if (ONLY && !ONLY.has(lib)) continue;
  const rel = info.relPath;
  if (!rel) continue;
  for (const version of info.versions ?? []) {
    const dest = path.join(OUT, lib, version, rel);
    jobs.push({ lib, version, rel, dest });
  }
}

const libCount = new Set(jobs.map((j) => j.lib)).size;
console.log(`[cdn] ${jobs.length} files over ${libCount} libraries -> ${OUT}`);

let done = 0, fetched = 0, skipped = 0;
const misses: Array<{ lib: string; version: string; rel: string; status: number | string }> = [];

/**
 * A handful of manifest paths carry a normalized extension: pixi.js 6.5.x is recorded as
 * `esm/pixi.js` where both cdnjs and the original corpus hold `esm/pixi.mjs`. Requesting the
 * recorded name verbatim would drop those 22 files and call them missing, so a `.js` that
 * 404s is retried once as `.mjs`. The file is written under the name the manifest uses, since
 * that is what the hash database was built against.
 */
function candidates(rel: string): string[] {
  return rel.endsWith('.js') ? [rel, `${rel.slice(0, -3)}.mjs`] : [rel];
}

async function run(job: Job): Promise<void> {
  if (fs.existsSync(job.dest) && fs.statSync(job.dest).size > 0) { skipped++; return; }
  let last: number | string = 'no attempt';
  for (const rel of candidates(job.rel)) {
    const url = `${BASE}/${job.lib}/${job.version}/${rel}`;
    // Two attempts each: cdnjs occasionally 5xxes under this much parallelism, and a retry is
    // cheaper than a corpus with holes that only surface as unmatched hashes much later.
    for (let attempt = 1; attempt <= 2; attempt++) {
      try {
        const res = await fetch(url);
        if (!res.ok) {
          last = res.status;
          if (res.status === 404) break;      // try the next candidate name
          if (attempt === 2) break;
          continue;
        }
        const body = Buffer.from(await res.arrayBuffer());
        fs.mkdirSync(path.dirname(job.dest), { recursive: true });
        fs.writeFileSync(job.dest, body);
        fetched++;
        return;
      } catch (e) {
        last = String(e);
        if (attempt === 2) break;
      }
    }
  }
  misses.push({ lib: job.lib, version: job.version, rel: job.rel, status: last });
}

async function main(): Promise<void> {
  let next = 0;
  const workers = Array.from({ length: Math.min(CONCURRENCY, jobs.length) }, async () => {
    for (;;) {
      const i = next++;
      if (i >= jobs.length) return;
      await run(jobs[i]);
      if (++done % 5000 === 0) {
        console.log(`[cdn] ${done}/${jobs.length}  fetched=${fetched} skipped=${skipped} missing=${misses.length}`);
      }
    }
  });
  await Promise.all(workers);

  console.log(`[cdn] done. fetched=${fetched} already-present=${skipped} missing=${misses.length}`);
  if (misses.length) {
    const out = path.join(OUT, 'misses.json');
    fs.mkdirSync(path.dirname(out), { recursive: true });
    fs.writeFileSync(out, JSON.stringify(misses, null, 1));
    const byLib = new Map<string, number>();
    for (const m of misses) byLib.set(m.lib, (byLib.get(m.lib) ?? 0) + 1);
    console.log('[cdn] cdnjs no longer serves these; the rebuilt corpus is that much smaller:');
    for (const [lib, n] of [...byLib].sort((a, b) => b[1] - a[1]).slice(0, 10)) {
      console.log(`        ${lib}: ${n}`);
    }
    console.log(`[cdn] full list: ${out}`);
  }
}

main().catch((e) => { console.error(e); process.exit(1); });
