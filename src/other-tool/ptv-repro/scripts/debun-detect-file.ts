/**
 * Standalone Debun single-file / batch detector (repo NOT modified).
 * Mirrors src/dist/index.ts `detect` action but on local files.
 * Usage: ts-node --transpile-only debun-detect-file.ts <file1> [file2 ...]
 *   or:  ts-node --transpile-only debun-detect-file.ts --json <manifest.json>
 *        manifest = [{id, file}] -> prints [{id, detections:[{lib,type3,type2,top,topScore}]}]
 */
import fs from 'fs';
const ROOT = process.env.DEBUN_ROOT || require('path').resolve(__dirname, '..', '..', '..', '..');
// eslint-disable-next-line @typescript-eslint/no-var-requires
const fingerprintCollector = require(ROOT + '/src/fingerprint-collector').default;
// eslint-disable-next-line @typescript-eslint/no-var-requires
const { evaluate } = require(ROOT + '/src/debun/phase2/lib-scorer');

const THRESHOLD = parseFloat(process.env.DEBUN_THRESHOLD || '0.2');

function detectFile(file: string) {
  const raw = fs.readFileSync(file, 'utf-8');
  const fps = fingerprintCollector(raw);
  const uniq = Array.from(new Map(fps.map((x: any) => [x.hash, x])).values()) as any[];
  const h: Record<number, string[]> = {};
  for (const x of uniq) { (h[x.nodes] = h[x.nodes] || []).push(x.hash); }
  const scores = evaluate(h, { threshold: THRESHOLD });
  return scores.map((s: any) => ({
    lib: s.libName === 'react-dom' ? 'react' : s.libName,
    type3: s.type3Versions, type2: s.type2Versions, top: s.topVersions, topScore: s.topScore,
  }));
}

const args = process.argv.slice(2);
if (args[0] === '--json') {
  const manifest = JSON.parse(fs.readFileSync(args[1], 'utf-8')) as { id: string; file: string }[];
  const out = manifest.map((m) => {
    try { return { id: m.id, detections: detectFile(m.file) }; }
    catch (e: any) { return { id: m.id, error: String(e.message).split('\n')[0] }; }
  });
  process.stdout.write(JSON.stringify(out));
} else {
  for (const f of args) {
    console.log('### ' + f);
    console.log(JSON.stringify(detectFile(f), null, 1));
  }
}
