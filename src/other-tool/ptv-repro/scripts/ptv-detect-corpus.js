#!/usr/bin/env node
/**
 * PTV empty-page detection over the shared corpus, PARALLEL + variant-skip.
 * Stateless server (manifest-indexed URLs) so pages run concurrently.
 * Tasks per entry: asShipped (always); noLabel (only if lib has a PTV label —
 * for unlabeled libs no-label≡as-shipped); bugfix (only react — the only lib the
 * react root->win fix changes).
 * Env: MANIFEST, OUT, POOL(=5), VARIANTS(unused; selection is automatic)
 */
const fs = require('fs'); const path = require('path'); const http = require('http');
// Self-contained defaults: scripts/ lives at <repo>/src/other-tool/ptv-repro/scripts.
const RP = path.join(__dirname, '..');                 // ptv-repro
const REPO = path.resolve(RP, '..', '..', '..');       // debun-tosem26 repo root
const PTV_DIR = process.env.PTV_DIR || path.join(REPO, 'src/other-tool/ptv');   // vendored PTV extension
const DATA_DIR = path.join(PTV_DIR, 'data');
const CHROME = process.env.CHROME || '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const puppeteer = require(path.join(REPO, 'node_modules/puppeteer'));
const CDN = 'https://cdnjs.cloudflare.com/ajax/libs/';
const PORT = parseInt(process.env.PORT || '9971', 10); const DATA_PREFIX = '/__ptvdata';
const MANIFEST = process.env.MANIFEST || path.join(REPO, 'tmp/ptv-repro/corpus/corpus-manifest.json');
const OUT = process.env.OUT || path.join(REPO, 'tmp/ptv-repro/ptv-results.json');
const POOL = parseInt(process.env.POOL || '5', 10);
// Delay after networkidle2 before snapshotting window (raise for a more stable, slower run).
const SETTLE_MS = parseInt(process.env.SETTLE_MS || '900', 10);
// Optional canon-lib filter for controlled subset experiments (comma-separated canon names).
const LIB_FILTER = process.env.LIB_FILTER ? new Set(process.env.LIB_FILTER.split(',').map((s) => s.trim())) : null;
// as-shipped detect.js is the vendored PTV original; noLabel/bugfix variants live alongside (bugfix present; noLabel falls back to as-shipped).
const DETECT = {
  asShipped: process.env.DETECT_ASSHIPPED || path.join(__dirname, 'detect-asshipped-ORIGINAL.js'),
  noLabel: path.join(__dirname, 'detect-asshipped-ORIGINAL.js'),
  bugfix: path.join(__dirname, 'detect-bugfix.js'),
};

const canonical = (s) => String(s).trim().toLowerCase().replace(/\.json$/, '').replace(/\.js$/, '').replace(/[.\-_ ]/g, '');
const MIME = { '.js': 'text/javascript', '.json': 'application/json' };
const mimeFor = (p) => MIME[path.extname(p.replace(/[?%].*$/, '')).toLowerCase()] || 'text/javascript';
const manifest = JSON.parse(fs.readFileSync(MANIFEST, 'utf8'));

const server = http.createServer((q, res) => {
  const u = new URL(q.url, 'http://x'); let p; try { p = decodeURIComponent(u.pathname); } catch { p = u.pathname; }
  if (p === '/page') {
    const i = +u.searchParams.get('i'); const m = manifest[i];
    const deps = (m.outDeps || []).map((d) => `<script src="${d}"></script>`).join('\n');
    return res.writeHead(200, { 'Content-Type': 'text/html' }).end(
      `<!doctype html><html><head><meta charset="utf-8"><meta id="lib-detect-result"><meta id="lib-detect-time">
<script src="${CDN}crypto-js/3.1.9-1/core.js"></script>
<script src="${CDN}crypto-js/3.1.9-1/md5.js"></script>
${deps}
<script src="/libfile?i=${i}"></script>
</head><body><div id="app"></div><div id="root"></div></body></html>`);
  }
  if (p === '/libfile') {
    const i = +u.searchParams.get('i'); const m = manifest[i];
    if (!m) return res.writeHead(404).end();
    return fs.readFile(m.file, (e, d) => e ? res.writeHead(404).end() : res.writeHead(200, { 'Content-Type': 'text/javascript' }).end(d));
  }
  if (p === DATA_PREFIX || p.startsWith(DATA_PREFIX + '/')) {
    const r = path.normalize(path.join(DATA_DIR, p.slice(DATA_PREFIX.length) || '/'));
    if (!r.startsWith(DATA_DIR)) return res.writeHead(403).end();
    return fs.readFile(r, (e, d) => e ? res.writeHead(404).end() : res.writeHead(200, { 'Content-Type': mimeFor(r) }).end(d));
  }
  res.writeHead(404).end();
});

async function detectTask(browser, idx, variant) {
  let page;
  const errs = [];
  try {
    page = await browser.newPage();               // inside try: a dead browser here becomes a retryable error, not a worker crash
    page.on('dialog', (d) => d.dismiss().catch(() => {}));
    page.on('pageerror', (e) => errs.push(String(e.message).split('\n')[0]));
    await page.goto(`http://localhost:${PORT}/page?i=${idx}`, { waitUntil: 'networkidle2', timeout: 45000 });
    await new Promise((r) => setTimeout(r, SETTLE_MS));
    await page.evaluate(() => { for (const id of ['lib-detect-result', 'lib-detect-time']) if (!document.getElementById(id)) { const m = document.createElement('meta'); m.id = id; document.head.appendChild(m); } });
    await page.addScriptTag({ path: DETECT[variant] });
    await page.evaluate((u) => window.postMessage({ type: 'detect', url: u }, '*'), `http://localhost:${PORT}${DATA_PREFIX}`);
    await page.waitForFunction(() => { const r = document.getElementById('lib-detect-result'); return r && r.getAttribute('content'); }, { timeout: 25000 });
    const det = await page.evaluate(() => JSON.parse(document.getElementById('lib-detect-result').getAttribute('content') || '[]'));
    const m = manifest[idx]; const hit = (det || []).find((d) => canonical(d.libname) === m.canon);
    return hit ? { detected: true, reported: hit.version || [], version_source: hit.version_source || 'none' }
               : { detected: false, reported: [], version_source: null, pageErr: errs[0] || null };
  } catch (err) { return { error: String(err.message).split('\n')[0] }; }
  finally { if (page) await page.close().catch(() => {}); }
}
const isBrowserDead = (e) => e && /Connection closed|Protocol error|Target closed|Session closed|browser has disconnected|Navigating frame was detached/i.test(e);

// A long single-browser session drops its CDP connection after a while (esp. slow POOL=1
// runs over thousands of pages). Each worker owns its own browser, recycles it every
// RECYCLE_EVERY tasks, and relaunches + retries once when the browser dies mid-task.
const RECYCLE_EVERY = parseInt(process.env.RECYCLE_EVERY || '150', 10);
const launchBrowser = () => puppeteer.launch({ headless: 'new', executablePath: CHROME, args: ['--no-sandbox', '--ignore-certificate-errors'] });

(async () => {
  await new Promise((r) => server.listen(PORT, r));
  // build results skeleton + task list
  const results = manifest.map((m) => ({ id: m.canon + '@' + m.version, canon: m.canon, debName: m.debName, version: m.version, ptvHasLabel: m.ptvHasLabel, ptvVf: m.ptvVf, variants: {} }));
  const tasks = [];
  const ONLY_AS = process.env.ONLY_ASSHIPPED === '1';
  manifest.forEach((m, i) => {
    if (LIB_FILTER && !LIB_FILTER.has(m.canon)) return;
    tasks.push({ i, variant: 'asShipped' });
    if (!ONLY_AS && m.ptvHasLabel) tasks.push({ i, variant: 'noLabel' });
    if (!ONLY_AS && m.canon === 'react') tasks.push({ i, variant: 'bugfix' });
  });
  console.log(`entries=${manifest.length} tasks=${tasks.length} pool=${POOL} settle=${SETTLE_MS}ms recycle=${RECYCLE_EVERY}`);
  let done = 0, cursor = 0;
  async function worker() {
    let browser = await launchBrowser();
    let sinceRecycle = 0;
    try {
      while (true) {
        const myIdx = cursor++;
        if (myIdx >= tasks.length) break;
        const t = tasks[myIdx];
        let r = await detectTask(browser, t.i, t.variant);
        if (r && r.error && isBrowserDead(r.error)) {           // browser died — relaunch and retry once
          try { await browser.close(); } catch {}
          browser = await launchBrowser(); sinceRecycle = 0;
          r = await detectTask(browser, t.i, t.variant);
        }
        results[t.i].variants[t.variant] = r;
        done++; sinceRecycle++;
        if (done % 20 === 0) { fs.writeFileSync(OUT, JSON.stringify(results, null, 2)); console.log(`  ${done}/${tasks.length}`); }
        if (sinceRecycle >= RECYCLE_EVERY) { try { await browser.close(); } catch {} browser = await launchBrowser(); sinceRecycle = 0; }
      }
    } finally { try { await browser.close(); } catch {} }
  }
  await Promise.all(Array.from({ length: POOL }, worker));
  fs.writeFileSync(OUT, JSON.stringify(results, null, 2));
  server.close();
  const miss = results.filter((r) => r.variants.asShipped && !r.variants.asShipped.detected).length;
  console.log(`\n== PTV done: ${results.length} entries, ${tasks.length} tasks; asShipped MISS=${miss} -> ${OUT} ==`);
})().catch((e) => { console.error(e); process.exit(1); });
