/**
 * fetch-npm-corpus.ts — rebuild src/data/npm/ from the npm registry instead of a Zenodo tarball.
 *
 * Two inputs, both already here once ./download-files.sh has run:
 *   fingerprint-cache/alllibs.json   which (directory, version) pairs were fingerprinted
 *   src/data/npm-package-map.json    directory name -> npm package name
 *
 * The map is not cosmetic. Twelve of these directories are named after the cdnjs library
 * rather than the package it came from, and the difference is not guessable: `angular.js` is
 * npm's `angular`, `angular` is `@angular/core`, `move.js` is `move-js`, `socket.io` is
 * `socket.io-client`. It was read out of each package's own package.json, so it is the
 * corpus's own answer rather than a reconstruction.
 *
 * 72 packages, ~5,500 (package, version) tarballs, ~54 GB extracted. Registry tarballs are
 * immutable, so a version that still exists extracts to the same bytes the corpus holds —
 * checked against move-js 0.5.0, which matches file for file.
 *
 * Resumable per (package, version): a directory that already has content is left alone.
 * Versions the registry no longer serves are listed at the end and written to misses.json.
 *
 *   CONCURRENCY=8      parallel tarballs (default 8; each is unpacked as it lands)
 *   LIBS=lodash.js,d3  restrict to these directories
 *   OUT=src/data/npm
 */
import fs from 'fs';
import path from 'path';
import { execFileSync } from 'child_process';
import os from 'os';

const ROOT = process.cwd();
// An absolute OUT must not be joined onto the repo root — see fetch-cdn-corpus.ts.
const outEnv = process.env['OUT'] ?? 'src/data/npm';
const OUT = path.isAbsolute(outEnv) ? outEnv : path.join(ROOT, outEnv);
const CONCURRENCY = parseInt(process.env['CONCURRENCY'] ?? '8', 10);
const ONLY = process.env['LIBS'] ? new Set(process.env['LIBS'].split(',').map((s) => s.trim())) : null;
const REGISTRY = process.env['NPM_REGISTRY'] ?? 'https://registry.npmjs.org';

function need(p: string, remedy: string): string {
  const abs = path.isAbsolute(p) ? p : path.join(ROOT, p);
  if (!fs.existsSync(abs)) { console.error(`missing: ${p}\n${remedy}`); process.exit(1); }
  return abs;
}

const libsPath = need('src/data/fingerprint-cache/alllibs.json',
  'That is the fingerprint cache manifest — run ./download-files.sh first.');
const mapPath = need('src/data/npm-package-map.json', 'It is committed; run from the repo root.');

const alllibs = JSON.parse(fs.readFileSync(libsPath, 'utf8')) as Record<string, { versions?: string[] }>;
const pkgMap = (JSON.parse(fs.readFileSync(mapPath, 'utf8')) as { map: Record<string, string> }).map;

const byDir = new Map<string, Set<string>>();
for (const [key, info] of Object.entries(alllibs)) {
  const dir = key.split('____')[0];
  if (ONLY && !ONLY.has(dir)) continue;
  let s = byDir.get(dir);
  if (!s) { s = new Set(); byDir.set(dir, s); }
  for (const v of info.versions ?? []) s.add(v);
}

interface Job { dir: string; pkg: string; version: string }
const jobs: Job[] = [];
const unmapped: string[] = [];
for (const [dir, versions] of byDir) {
  const pkg = pkgMap[dir];
  if (!pkg) { unmapped.push(dir); continue; }
  for (const version of versions) jobs.push({ dir, pkg, version });
}
if (unmapped.length) {
  console.error(`no npm package name for: ${unmapped.join(', ')}`);
  console.error('Add them to src/data/npm-package-map.json — every directory needs one.');
  process.exit(1);
}

console.log(`[npm] ${jobs.length} (package, version) tarballs over ${byDir.size} packages -> ${OUT}`);

let done = 0, fetched = 0, skipped = 0;
const misses: Array<{ dir: string; pkg: string; version: string; status: number | string }> = [];
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'npm-corpus-'));

/** Scoped names tarball under their last segment: @angular/core -> core-10.0.0.tgz */
const tarballUrl = (pkg: string, version: string) =>
  `${REGISTRY}/${pkg}/-/${pkg.split('/').pop()}-${version}.tgz`;

async function run(job: Job, slot: number): Promise<void> {
  const dest = path.join(OUT, job.dir, job.version);
  if (fs.existsSync(dest) && fs.readdirSync(dest).length > 0) { skipped++; return; }
  const tgz = path.join(tmp, `slot-${slot}.tgz`);
  for (let attempt = 1; attempt <= 2; attempt++) {
    try {
      const res = await fetch(tarballUrl(job.pkg, job.version));
      if (!res.ok) {
        if (attempt === 2 || res.status === 404) {
          misses.push({ dir: job.dir, pkg: job.pkg, version: job.version, status: res.status });
          return;
        }
        continue;
      }
      fs.writeFileSync(tgz, Buffer.from(await res.arrayBuffer()));
      fs.mkdirSync(dest, { recursive: true });
      // Every npm tarball wraps its contents in package/, which the corpus does not have.
      execFileSync('tar', ['xzf', tgz, '-C', dest, '--strip-components=1']);
      fs.rmSync(tgz, { force: true });
      fetched++;
      return;
    } catch (e) {
      fs.rmSync(tgz, { force: true });
      if (attempt === 2) misses.push({ dir: job.dir, pkg: job.pkg, version: job.version, status: String(e) });
    }
  }
}

async function main(): Promise<void> {
  let next = 0;
  const workers = Array.from({ length: Math.min(CONCURRENCY, jobs.length) }, async (_v, slot) => {
    for (;;) {
      const i = next++;
      if (i >= jobs.length) return;
      await run(jobs[i], slot);
      if (++done % 250 === 0) {
        console.log(`[npm] ${done}/${jobs.length}  fetched=${fetched} skipped=${skipped} missing=${misses.length}`);
      }
    }
  });
  await Promise.all(workers);
  fs.rmSync(tmp, { recursive: true, force: true });

  console.log(`[npm] done. fetched=${fetched} already-present=${skipped} missing=${misses.length}`);
  if (misses.length) {
    const out = path.join(OUT, 'misses.json');
    fs.mkdirSync(path.dirname(out), { recursive: true });
    fs.writeFileSync(out, JSON.stringify(misses, null, 1));
    console.log(`[npm] unpublished or renamed since the corpus was collected; full list: ${out}`);
  }
}

main().catch((e) => { console.error(e); process.exit(1); });
