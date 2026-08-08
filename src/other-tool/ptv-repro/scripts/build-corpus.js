#!/usr/bin/env node
/**
 * Build the shared corpus for the PTV-vs-Debun empty-page experiment.
 *   corpus versions per lib = (Debun all-libs known versions) ∩ (libs_data sourceable)
 *   download identical cdnjs file locally (served to PTV, read by Debun) + record out_deps
 *
 * Every such version by default — Table 7 is the full population, so a cap has to be asked
 * for rather than inherited. K=<n> takes an even spread of n instead (first and last always
 * included) and says so, for smoke-testing the pipeline.
 * Env: LIBS="fabric.js,socket.io"  K=3   OUT=<corpus dir>
 */
const fs = require('fs'); const path = require('path'); const https = require('https');
// Self-contained defaults: scripts/ lives at <repo>/src/other-tool/ptv-repro/scripts.
const RP = path.join(__dirname, '..');                 // ptv-repro
const REPO = path.resolve(RP, '..', '..', '..');       // debun-tosem26 repo root
const LD = process.env.LIBS_DATA || path.join(RP, 'libs_data');           // vendored PTVgen libs_data (1125 lib)
const DEBUN_ALLLIBS = process.env.DEBUN_ALLLIBS || path.join(REPO, 'src/data/debun-hashes/all-libs.json');
const INTERSECT = process.env.INTERSECT || path.join(RP, 'corpus-intersect.json');
const OUT = process.env.OUT || path.join(REPO, 'tmp/ptv-repro/corpus');
const K = process.env.K ? parseInt(process.env.K, 10) : Infinity;
const LIBFILTER = process.env.LIBS ? new Set(process.env.LIBS.split(',').map((s) => s.trim())) : null;
// D/E: Debun DB-broken whole-libs (0-match all versions) → 코퍼스에서 제외
const EXCLUDE = new Set((process.env.EXCLUDE || 'velocity,modernizr,yepnope').split(',').map((s) => canonKey(s)).filter(Boolean));
// A: out_deps 공백 보완 (best-effort cdnjs dep URLs; dep은 버전별로 다를 수 있어 근사)
const CDNB = 'https://cdnjs.cloudflare.com/ajax/libs/';
const DEP_OVERRIDE = {
  dc: [CDNB + 'd3/3.5.17/d3.min.js', CDNB + 'crossfilter/1.3.12/crossfilter.min.js'],
  jquerymobile: [CDNB + 'jquery/1.11.3/jquery.min.js'],
  momenttimezone: [CDNB + 'moment.js/2.29.4/moment.min.js'],
  two: [CDNB + 'underscore.js/1.13.6/underscore-min.js'],
  highcharts: [CDNB + 'jquery/1.11.3/jquery.min.js'],
};
function canonKey(s) { return String(s).trim().toLowerCase().replace(/\.json$/, '').replace(/\.js$/, '').replace(/[.\-_ ]/g, ''); }
// libs_data가 잘못된/하위경로 파일명을 줄 때 시도할 main UMD 후보(첫 200 사용). URL은 e.url의 /<version>/ base에 붙임.
const FILE_CANDIDATES = {
  gsap: ['gsap.min.js', 'TweenMax.min.js', 'minified/TweenMax.min.js'],
  highcharts: ['highcharts.js', 'highcharts.min.js'],
  yui: ['yui/yui-min.js', 'yui/yui.js', 'yui-min.js'],
};

const canon = (s) => String(s).trim().toLowerCase().replace(/\.json$/, '').replace(/\.js$/, '').replace(/[.\-_ ]/g, '');
const verKey = (v) => String(v).split(/[.\-+]/).map((x) => (/^\d+$/.test(x) ? +x : x));
function verCmp(a, b) { const A = verKey(a), B = verKey(b); for (let i = 0; i < Math.max(A.length, B.length); i++) { const x = A[i], y = B[i]; if (x === undefined) return -1; if (y === undefined) return 1; if (typeof x === typeof y) { if (x < y) return -1; if (x > y) return 1; } else { const xn = typeof x === 'number'; if (xn !== (typeof y === 'number')) return xn ? 1 : -1; } } return 0; }
// even spread sample of K items from sorted array (always include first & last)
function spread(arr, k) {
  if (arr.length <= k) return arr.slice();
  // k === 1 would divide by (k-1) === 0 and index the array with NaN, handing an
  // undefined version on down the pipeline. Trying one version per library is the
  // obvious way to smoke-test this script, so it has to work.
  if (k <= 1) return arr.length ? [arr[0]] : [];
  const out = [];
  for (let i = 0; i < k; i++) out.push(arr[Math.round((i * (arr.length - 1)) / (k - 1))]);
  return [...new Set(out)];
}

function get(url) {
  return new Promise((resolve, reject) => {
    https.get(url, (res) => {
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) { res.resume(); return get(res.headers.location).then(resolve, reject); }
      if (res.statusCode !== 200) { res.resume(); return reject(new Error('HTTP ' + res.statusCode)); }
      const chunks = []; res.on('data', (c) => chunks.push(c)); res.on('end', () => resolve(Buffer.concat(chunks)));
    }).on('error', reject);
  });
}

(async () => {
  // The version universe comes from the flat hash DB, which is a download rather than part
  // of the checkout — say so instead of surfacing a bare ENOENT from readFileSync.
  if (!fs.existsSync(DEBUN_ALLLIBS)) {
    console.error(`DEBUN's library/version database is not present at ${DEBUN_ALLLIBS}.`);
    console.error('Run ./download-files.sh first; the corpus is built from the versions it lists.');
    process.exit(1);
  }
  const inter = JSON.parse(fs.readFileSync(INTERSECT, 'utf8')).matched;
  const debAll = JSON.parse(fs.readFileSync(DEBUN_ALLLIBS, 'utf8'));
  const debByCanon = {}; for (const k of Object.keys(debAll)) debByCanon[canon(k)] = { key: k, versions: debAll[k].versions || [] };
  // libs_data index
  const ldIdx = {}; for (const f of fs.readdirSync(LD)) { if (!f.endsWith('.json')) continue; ldIdx[canon(f)] = f.replace(/\.json$/, ''); }

  fs.mkdirSync(OUT, { recursive: true });
  const manifest = []; const report = [];
  for (const row of inter) {
    const c = row.n; const debName = row.deb;
    if (LIBFILTER && !LIBFILTER.has(debName)) continue;
    if (EXCLUDE.has(c)) { report.push(`${debName.padEnd(22)} EXCLUDED (D/E: Debun DB-broken)`); continue; }
    const ldFile = ldIdx[c]; const deb = debByCanon[c];
    if (!ldFile || !deb) { report.push(`${debName}: SKIP (ldFile=${!!ldFile} deb=${!!deb})`); continue; }
    const ldData = JSON.parse(fs.readFileSync(path.join(LD, ldFile + '.json'), 'utf8'));
    // libs_data: version -> entry (with url)
    const ldByVer = {}; for (const k of Object.keys(ldData)) { const e = ldData[k]; if (e && e.url && e.version) ldByVer[String(e.version)] = e; }
    const debSet = new Set(deb.versions.map(String));
    let common = Object.keys(ldByVer).filter((v) => debSet.has(v)).sort(verCmp);
    let src = 'common';
    if (common.length === 0) { common = Object.keys(ldByVer).sort(verCmp); src = 'ld-only'; } // fallback: sourceable only
    const chosen = spread(common, K);
    // Never let a cap pass unremarked: a corpus that is 3 versions per library rather than all
    // of them scores nothing like Table 7, and the difference is invisible in the output.
    if (chosen.length < common.length) console.error(`[K] ${c}: ${chosen.length} of ${common.length} versions`);
    let ok = 0;
    for (const v of chosen) {
      const e = ldByVer[v]; const dir = path.join(OUT, c, v); fs.mkdirSync(dir, { recursive: true });
      // 후보 파일명: FILE_CANDIDATES 우선, 없으면 libs_data filename. URL은 e.url의 /<version>/ base에 후보를 붙임.
      const origFn = e.filename || 'lib.js';
      const urlBase = e.url.slice(0, e.url.length - origFn.length); // .../lib/<version>/
      const candidates = FILE_CANDIDATES[c] || [origFn];
      let done = false, usedUrl = null, usedFn = null;
      for (const cand of candidates) {
        const candUrl = urlBase + cand;
        const fp = path.join(dir, path.basename(cand)); // basename → 하위경로 mkdir 불필요
        try {
          if (fs.existsSync(fp) && fs.statSync(fp).size > 0) { usedUrl = candUrl; usedFn = cand; var savedFp = fp; done = true; break; }
          const buf = await get(candUrl); fs.mkdirSync(path.dirname(fp), { recursive: true }); fs.writeFileSync(fp, buf);
          usedUrl = candUrl; usedFn = cand; savedFp = fp; done = true; break;
        } catch (err) { /* try next candidate */ }
      }
      if (!done) { report.push(`${debName}@${v}: DL FAIL (tried ${candidates.join(', ')})`); continue; }
      manifest.push({ canon: c, debName, ptvName: row.ptv, version: v, file: savedFp, url: usedUrl, filename: usedFn, outDeps: (e.out_deps && e.out_deps.length) ? e.out_deps : (DEP_OVERRIDE[c] || []), depOverride: !(e.out_deps && e.out_deps.length) && !!DEP_OVERRIDE[c], ptvHasLabel: row.ptvHasLabel, ptvVf: row.ptvVf, verSrc: src });
      ok++;
    }
    report.push(`${debName.padEnd(22)} versions ${ok}/${chosen.length} [${src}] common=${common.length}  (${chosen.join(', ')})`);
  }
  fs.writeFileSync(path.join(OUT, 'corpus-manifest.json'), JSON.stringify(manifest, null, 2));
  console.log(report.join('\n'));
  console.log(`\n== corpus: ${manifest.length} (lib,version) files across ${new Set(manifest.map((m) => m.canon)).size} libs -> ${OUT}/corpus-manifest.json ==`);
})().catch((e) => { console.error(e); process.exit(1); });
