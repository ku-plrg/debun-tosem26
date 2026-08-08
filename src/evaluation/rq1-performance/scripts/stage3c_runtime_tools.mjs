#!/usr/bin/env node
/**
 * RQ1 pilot, stage 3c — runtime detectors with cold, order-randomised measurement.
 *
 * What 3b got wrong
 * -----------------
 * 3b ran LDC then PTDetector for each site inside ONE browser instance, so LDC paid a
 * cold load and PTDetector inherited the warm HTTP/DNS/TLS caches. Measured directly:
 *
 *     same browser, repeated loads   microsoft.com  3420 -> 338 -> 300 ms
 *     fresh browser each time        microsoft.com  3495 / 4507 ms
 *
 * That is the entire explanation for PTDetector's 776 ms median page load against LDC's
 * 4430 ms — an artefact of execution order, not a property of the tools.
 *
 * Fixes here:
 *   - a FRESH browser per (site, tool), so every navigation is cold
 *   - tool order shuffled per site with a fixed seed, cancelling any residual ordering
 *     effect (e.g. the site's own CDN warming up between requests)
 *
 * Everything else is unchanged from 3b: the common settle before triggering, LDC's
 * redundant internal wait stripped, PTDetector's pattern data inlined so no CSP-blocked
 * fetch, PTV re-triggered after the settle and read from its own #lib-detect-time.
 */
import { createRequire } from 'node:module';
import fs from 'node:fs';
import path from 'node:path';

const require = createRequire(import.meta.url);
const ART = path.resolve(new URL('../../../..', import.meta.url).pathname);
const puppeteer = require(path.join(ART, 'node_modules/puppeteer'));

const UPSTREAM = path.join(ART, 'src/baselines/upstream');
const PTV_DIR = path.join(ART, 'src/other-tool/ptv');
const PTD_CACHE = path.join(ART, 'src/baselines/.ptd-cache');
const PTD_URLS = [
  'https://raw.githubusercontent.com/aaronxyliu/PTdetector/refs/heads/main/data/blacklist.json',
  'https://raw.githubusercontent.com/aaronxyliu/PTdetector/refs/heads/main/data/pts.json',
  'https://raw.githubusercontent.com/aaronxyliu/PTdetector/refs/heads/main/data/DetectFile.json',
];

function arg(n, d) { const i = process.argv.indexOf(`--${n}`); return i >= 0 ? process.argv[i + 1] : d; }
const STAGE1 = arg('stage1', null);
const OUT = arg('out', 'stage3c.json');
const SETTLE_MS = +arg('settle-ms', '5000');
const DETECT_TIMEOUT = +arg('detect-timeout', '60000');
const NAV_TIMEOUT = +arg('timeout', '60000');
const WAIT_UNTIL = arg('wait-until', 'domcontentloaded');
const SEED = +arg('seed', '20260801');

// work/ is not in the repository, so --out into it fails on a fresh checkout unless created.
fs.mkdirSync(path.dirname(path.resolve(OUT)), { recursive: true });

const sites = JSON.parse(fs.readFileSync(STAGE1, 'utf8')).rows.map((r) => ({ rank: r.rank, site: r.site }));
console.log(`sites: ${sites.length}  settle: ${SETTLE_MS}ms  fresh browser per measurement, order shuffled (seed ${SEED})`);

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const target = (s) => (/^https?:/.test(s) ? s : `https://${s}`);

/** Deterministic PRNG so the shuffle is reproducible across runs. */
function mulberry32(a) {
  return function () {
    a |= 0; a = (a + 0x6D2B79F5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
const rand = mulberry32(SEED);
function shuffled(arr) {
  const a = arr.slice();
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(rand() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

function stripLdcWait(src) {
  const out = src.replace('}, 2000);', '}, 0);');
  if (out === src) throw new Error('LDC settle-wait patch did not apply');
  return out;
}
function inlinePtdData(src) {
  const out = src.replace(
    `    return fetch(url).then((response) => {
      return response.json();
    });`,
    `    return Promise.resolve(window.__PTD_DATA__[url]);`
  );
  if (out === src) throw new Error('PTDetector data-inlining patch did not apply');
  return out;
}
/**
 * PTDetector's pattern data, from its own repository. Fetched on first use and cached, not
 * required to be there already: the cache is not redistributed with this artifact, so
 * demanding it meant this harness could only ever run on the machine that first populated it.
 * Cached because it must be inlined into the injected script — PTDetector fetches these at
 * runtime, and a page's CSP blocks that from an injected context.
 */
async function loadPtdData() {
  fs.mkdirSync(PTD_CACHE, { recursive: true });
  const d = {};
  for (const u of PTD_URLS) {
    const f = path.join(PTD_CACHE, path.basename(u));
    if (!fs.existsSync(f)) {
      console.log(`[ptd] fetching ${path.basename(u)}`);
      const r = await fetch(u);
      if (!r.ok) throw new Error(`PTDetector data ${u} -> HTTP ${r.status}`);
      fs.writeFileSync(f, await r.text());
    }
    d[u] = JSON.parse(fs.readFileSync(f, 'utf8'));
  }
  return d;
}

const launchPlain = () => puppeteer.launch({ headless: 'new', args: ['--no-sandbox', '--ignore-certificate-errors'] });
const launchPtv = () => puppeteer.launch({
  headless: 'new',
  args: ['--no-sandbox', '--ignore-certificate-errors',
    `--disable-extensions-except=${PTV_DIR}`, `--load-extension=${PTV_DIR}`],
});

async function measureInjected(site, src, preload) {
  const browser = await launchPlain();          // cold: fresh profile, empty caches
  const page = await browser.newPage();
  const row = {};
  let got = null;
  const done = new Promise((res) => {
    page.on('console', (m) => {
      const t = m.text();
      if (got === null && t.startsWith('[') && t.endsWith(']')) {
        try { got = JSON.parse(t); res(got); } catch { /* page noise */ }
      }
    });
  });
  try {
    const t0 = Date.now();
    await page.goto(target(site), { waitUntil: WAIT_UNTIL, timeout: NAV_TIMEOUT });
    row.pageLoadMs = Date.now() - t0;
    await sleep(SETTLE_MS);
    if (preload) await page.evaluate((d) => { window.__PTD_DATA__ = d; }, preload);
    const t1 = Date.now();
    await page.evaluate((s) => { eval(`(${s})`)(); }, src);
    const r = await Promise.race([done, sleep(DETECT_TIMEOUT).then(() => null)]);
    if (r === null) row.error = 'no output within detect timeout';
    else { row.computeMs = Date.now() - t1; row.detected = r.length; }
  } catch (e) {
    row.error = String(e.message || e).split('\n')[0];
  } finally {
    await browser.close().catch(() => {});
  }
  return row;
}

async function measurePtv(site) {
  const browser = await launchPtv();
  const page = await browser.newPage();
  const row = {};
  try {
    const t0 = Date.now();
    await page.goto(target(site), { waitUntil: WAIT_UNTIL, timeout: NAV_TIMEOUT });
    row.pageLoadMs = Date.now() - t0;
    await sleep(SETTLE_MS);
    const base = await page.evaluate(() => {
      const s = [...document.scripts].find((x) => x.src.includes('content_scripts/detect.js'));
      return s ? s.src.replace('content_scripts/detect.js', 'data') : null;
    });
    if (!base) throw new Error('PTV content script not present');
    await page.evaluate(() => {
      document.getElementById('lib-detect-result')?.removeAttribute('content');
      document.getElementById('lib-detect-time')?.removeAttribute('content');
    });
    const t1 = Date.now();
    await page.evaluate((b) => window.postMessage({ type: 'detect', url: b }, '*'), base);
    await page.waitForFunction(
      () => { const r = document.getElementById('lib-detect-result'); return r && r.getAttribute('content'); },
      { timeout: DETECT_TIMEOUT, polling: 100 }
    );
    row.wallMs = Date.now() - t1;
    const got = await page.evaluate(() => ({
      result: document.getElementById('lib-detect-result')?.getAttribute('content') || '',
      selfMs: document.getElementById('lib-detect-time')?.getAttribute('content') || '',
    }));
    row.computeMs = got.selfMs ? +got.selfMs : row.wallMs;
    try { row.detected = (JSON.parse(got.result) || []).length; } catch { row.detected = null; }
  } catch (e) {
    row.error = String(e.message || e).split('\n')[0];
  } finally {
    await browser.close().catch(() => {});
  }
  return row;
}

async function main() {
  const ldc = stripLdcWait((await import(path.join(UPSTREAM, 'ldc.js'))).default.toString());
  const ptd = inlinePtdData((await import(path.join(UPSTREAM, 'PTdetector.js'))).default.toString());
  const ptdData = await loadPtdData();

  const out = [];
  for (const { rank, site } of sites) {
    const row = { rank, site };
    const order = shuffled(['ldc', 'ptdetector', 'ptv']);
    row.order = order.join('>');
    for (const tool of order) {
      if (tool === 'ldc') row.ldc = await measureInjected(site, ldc, null);
      else if (tool === 'ptdetector') row.ptdetector = await measureInjected(site, ptd, ptdData);
      else row.ptv = await measurePtv(site);
    }
    out.push(row);
    const f = (t) => t.error ? `ERR(${t.error.slice(0, 20)})`
      : `load=${t.pageLoadMs}ms compute=${t.computeMs}ms n=${t.detected}`;
    console.log(`[${rank}] ${site.padEnd(21)} (${row.order}) ldc: ${f(row.ldc)} | ptd: ${f(row.ptdetector)} | ptv: ${f(row.ptv)}`);
    fs.writeFileSync(OUT, JSON.stringify({ settleMs: SETTLE_MS, seed: SEED, coldPerMeasurement: true, rows: out }, null, 1));
  }
  console.log(`\nwrote ${OUT}`);
}

main().catch((e) => { console.error(e); process.exit(1); });
