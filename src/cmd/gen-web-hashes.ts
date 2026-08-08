#!/usr/bin/env node
import fs from 'fs';
import path from 'path';
import extractFunctions from '../fingerprint-collector/function-collector';
import { generatePOGHash } from '../fingerprint-collector/hash-function';
import { extractPOG } from '../fingerprint-collector/pog-generator';
import fingerprintCollector from '../fingerprint-collector';
import { Function as Func, POGAnalysisOptions, POGHash } from '../types/pog';
import { getPropertyCnthash } from '../evaluation/rq2-ablation/property-cnt';
import { TARGET_URLS } from '../utils/urls';

import {
  ModelKey as Method,
  MODEL_KEYS,
  MODEL_SUFFIX as METHOD_SUFFIX,
  collectHashesForModel,
} from '../fingerprint-collector/pog-models';

const SRC_ROOT = path.join(__dirname, '../data/data-never-remove');
const OUT_ROOT = path.join(__dirname, '../data/allWebHashes');

// Website hashing uses minFnLoc = 0 (keep every function).
function collectHashes(raw: string, method: Method): POGHash[] {
  return collectHashesForModel(raw, method);
}

function collectJsFilesRecursive(dir: string): string[] {
  const out: string[] = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) out.push(...collectJsFilesRecursive(full));
    else if (entry.isFile()) out.push(full);
  }
  return out;
}

function processUrl(url: string, methods: Method[]): void {
  const dir = path.join(SRC_ROOT, url);
  if (!fs.existsSync(dir)) {
    console.warn(`[skip] no source dir: ${url}`);
    return;
  }
  const files = collectJsFilesRecursive(dir);

  const buckets = {} as Record<Method, Map<string, POGHash>>;
  const failCount = {} as Record<Method, number>;
  for (const m of methods) { buckets[m] = new Map(); failCount[m] = 0; }
  for (const filePath of files) {
    let raw: string;
    try {
      raw = fs.readFileSync(filePath, 'utf-8');
    } catch {
      continue;
    }
    for (const method of methods) {
      try {
        for (const h of collectHashes(raw, method)) {
          if (!h.hash) continue;
          if (!buckets[method].has(h.hash)) buckets[method].set(h.hash, h);
        }
      } catch {
        failCount[method]++;
      }
    }
  }

  fs.mkdirSync(OUT_ROOT, { recursive: true });
  for (const method of methods) {
    const out: Record<number, string[]> = {};
    for (const h of buckets[method].values()) {
      if (!out[h.nodes]) out[h.nodes] = [];
      out[h.nodes].push(h.hash);
    }
    const outPath = path.join(OUT_ROOT, `${url}${METHOD_SUFFIX[method]}.json`);
    fs.writeFileSync(outPath, JSON.stringify(out));
    console.log(
      `[${method}] ${url} -> ${outPath} (${buckets[method].size} unique, ${failCount[method]}/${files.length} files failed)`
    );
  }
}

function parseMethods(arg: string | undefined): Method[] {
  if (!arg || arg === 'all') return [...MODEL_KEYS];
  const parts = arg.split(',').map((s) => s.trim()) as Method[];
  for (const p of parts) {
    if (!MODEL_KEYS.includes(p)) {
      throw new Error(`Invalid method: ${p}. Use ${MODEL_KEYS.join('|')}|all`);
    }
  }
  return parts;
}

function main() {
  const methods = parseMethods(process.argv[2]);
  const urls = process.argv[3] ? process.argv[3].split(',') : TARGET_URLS;
  console.log(
    `Regenerating allWebHashes — methods=[${methods.join(',')}] urls=${urls.length}`
  );
  for (let i = 0; i < urls.length; i++) {
    const url = urls[i];
    console.log(`(${i + 1}/${urls.length}) ${url}`);
    try {
      processUrl(url, methods);
    } catch (e) {
      console.error(`[fail] ${url}: ${(e as Error)?.message ?? e}`);
    }
  }
  console.log('done.');
}

main();
