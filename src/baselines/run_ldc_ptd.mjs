#!/usr/bin/env node
/**
 * run_ldc_ptd.mjs — run LDC and PTDetector against live URLs.
 *
 * Both are RUNTIME detectors: they inspect `window` in a loaded page, so unlike
 * DEBUN / D-Bundlr / Aletheia they cannot be pointed at a saved .js file. A live
 * page load is required.
 *
 * The detector scripts under upstream/{ldc,PTdetector}.js are vendored verbatim
 * from debun-playground/misc/evaluation/scripts/. Each is a single arrow function
 * that ends by `console.log(JSON.stringify([...]))`; this driver injects it and
 * captures that line, the same contract the original harness used.
 *
 *   node baselines/run_ldc_ptd.mjs example.com another.com -o results.json
 *   node baselines/run_ldc_ptd.mjs --urls-file sites.txt --tools ldc --versions
 *
 * PTDetector caching
 *   PTDetector fetches blacklist.json / pts.json / DetectFile.json from
 *   `refs/heads/main` of its GitHub repo at run time — a moving target that makes
 *   results drift as that branch changes. On first run these are cached under
 *   --ptd-cache and afterwards served from disk via request interception, so runs
 *   are stable and work offline. Delete the cache to pick up upstream changes.
 */
import { createRequire } from 'node:module';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const require = createRequire(import.meta.url);
const puppeteer = require('puppeteer');

const PTD_URLS = [
  'https://raw.githubusercontent.com/aaronxyliu/PTdetector/refs/heads/main/data/blacklist.json',
  'https://raw.githubusercontent.com/aaronxyliu/PTdetector/refs/heads/main/data/pts.json',
  'https://raw.githubusercontent.com/aaronxyliu/PTdetector/refs/heads/main/data/DetectFile.json',
];

function parseArgs(argv) {
  const o = {
    urls: [], tools: ['ldc', 'ptdetector'], out: null, versions: false,
    timeout: 120000, settle: 20000, ptdCache: path.join(HERE, '.ptd-cache'),
    headless: true, bypassCsp: false, waitUntil: 'networkidle2',
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '-o' || a === '--out') o.out = argv[++i];
    else if (a === '--tools') o.tools = argv[++i].split(',').map((s) => s.trim());
    else if (a === '--urls-file')
      o.urls.push(...fs.readFileSync(argv[++i], 'utf8').split('\n').map((s) => s.trim()).filter(Boolean));
    else if (a === '--versions') o.versions = true;
    else if (a === '--timeout') o.timeout = +argv[++i];
    else if (a === '--settle') o.settle = +argv[++i];
    else if (a === '--ptd-cache') o.ptdCache = argv[++i];
    else if (a === '--headful') o.headless = false;
    else if (a === '--bypass-csp') o.bypassCsp = true;
    else if (a === '--wait-until') o.waitUntil = argv[++i];
    else if (a.startsWith('-')) throw new Error(`unknown flag ${a}`);
    else o.urls.push(a);
  }
  if (!o.urls.length) throw new Error('no URLs given (positional or --urls-file)');
  return o;
}

/** Load the vendored detector and return its source as an injectable string. */
async function loadDetector(name, wantVersions) {
  const mod = await import(path.join(HERE, 'upstream', name));
  let src = mod.default.toString();
  if (wantVersions) {
    // The vendored LDC drops versions on its last line:
    //     console.log(JSON.stringify(libs.map((lib) => lib.name)));
    // Emit the full {name, version} objects instead. Single surgical edit, applied
    // to the source string only — the vendored file stays verbatim.
    const before = src;
    src = src.replace('JSON.stringify(libs.map((lib) => lib.name))', 'JSON.stringify(libs)');
    if (src === before) throw new Error('--versions: could not patch LDC emit line');
  }
  return src;
}

async function ensurePtdCache(dir) {
  fs.mkdirSync(dir, { recursive: true });
  const map = new Map();
  for (const url of PTD_URLS) {
    const file = path.join(dir, path.basename(url));
    if (!fs.existsSync(file)) {
      process.stderr.write(`[ptd-cache] fetching ${path.basename(url)}\n`);
      const r = await fetch(url);
      if (!r.ok) throw new Error(`fetch ${url} -> ${r.status}`);
      fs.writeFileSync(file, await r.text());
    }
    map.set(url, file);
  }
  return map;
}

async function runOne(browser, url, detectSrc, opts, ptdCache) {
  const page = await browser.newPage();
  const target = /^https?:\/\//.test(url) ? url : `https://${url}`;
  let settled = null;

  // PTDetector pulls its pattern data over the network from inside the page, so a
  // site whose CSP restricts connect-src blocks it and it returns nothing. Left on
  // by default to match the original harness; --bypass-csp is a debugging aid for
  // telling "found nothing" apart from "could not load its data".
  if (opts.bypassCsp) await page.setBypassCSP(true);

  if (ptdCache) {
    await page.setRequestInterception(true);
    page.on('request', (req) => {
      const file = ptdCache.get(req.url());
      if (file) {
        req.respond({
          status: 200,
          contentType: 'application/json',
          headers: { 'Access-Control-Allow-Origin': '*' },
          body: fs.readFileSync(file, 'utf8'),
        });
      } else req.continue();
    });
  }

  const done = new Promise((resolve) => {
    page.on('console', (msg) => {
      const t = msg.text();
      // Both detectors signal completion with a single JSON array line.
      if (settled === null && t.startsWith('[') && t.endsWith(']')) {
        try { settled = JSON.parse(t); resolve(settled); } catch { /* not ours */ }
      }
    });
  });

  try {
    await page.goto(target, { waitUntil: opts.waitUntil, timeout: opts.timeout });
    await page.evaluate((fnSrc) => { eval(`(${fnSrc})`)(); }, detectSrc);
    const result = await Promise.race([
      done,
      new Promise((r) => setTimeout(() => r(null), opts.settle)),
    ]);
    return result === null ? { error: 'timed out waiting for detector output' } : { result };
  } catch (e) {
    return { error: String(e.message || e) };
  } finally {
    await page.close().catch(() => {});
  }
}

async function main() {
  const opts = parseArgs(process.argv.slice(2));
  if (opts.versions && opts.tools.some((t) => t !== 'ldc'))
    process.stderr.write('[warn] --versions only affects ldc; ptdetector never emits versions\n');

  const detectors = {};
  if (opts.tools.includes('ldc')) detectors.ldc = await loadDetector('ldc.js', opts.versions);
  if (opts.tools.includes('ptdetector')) detectors.ptdetector = await loadDetector('PTdetector.js', false);

  const ptdCache = detectors.ptdetector ? await ensurePtdCache(opts.ptdCache) : null;

  const browser = await puppeteer.launch({ headless: opts.headless });
  const out = [];
  try {
    for (const url of opts.urls) {
      const row = { url };
      for (const [name, src] of Object.entries(detectors)) {
        const r = await runOne(browser, url, src, opts, name === 'ptdetector' ? ptdCache : null);
        row[name] = r.result ?? null;
        if (r.error) row[`${name}_error`] = r.error;
        const shown = r.error ? `ERROR ${r.error}` : JSON.stringify(r.result);
        console.log(`${url}  ${name.padEnd(11)} ${shown}`);
      }
      out.push(row);
    }
  } finally {
    await browser.close();
  }

  if (opts.out) {
    fs.writeFileSync(opts.out, JSON.stringify(out, null, 2));
    console.log(`\nwrote ${opts.out}`);
  }
}

main().catch((e) => { console.error(e); process.exit(1); });
