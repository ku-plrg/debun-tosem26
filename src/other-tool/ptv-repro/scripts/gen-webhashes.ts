/**
 * Generate per-corpus-file POG hash-sets in tosem26 allWebHashes format, so each
 * corpus (lib,version) becomes a single-file "site" for the REAL web-detect-eval
 * scorer (strictVersions). Writes <OUTDIR>/ptvc<idx>.json + mapping.
 * Usage: ts-node --transpile-only gen-webhashes.ts <manifest.json> <outDir> <mappingOut>
 */
import fs from 'fs';
import path from 'path';
const ROOT = process.env['DEBUN_ROOT'] || path.resolve(__dirname, '..', '..', '..', '..');
// eslint-disable-next-line @typescript-eslint/no-var-requires
const fingerprintCollector = require(ROOT + '/src/fingerprint-collector').default;

const canon = (s: string) => String(s).toLowerCase().replace(/\.json$/, '').replace(/\.js$/, '').replace(/[.\-_ ]/g, '');
// npm dir name lookup. This used to read the directory names out of src/data/npm, which made
// Table 7 depend on fetching 54 GB of package source to learn 72 names. The same names are
// committed in npm-package-map.json, so the corpus itself is not a prerequisite; it falls back
// to the directory when the map is absent.
const npmByCanon: Record<string, string> = {};
const MAP = ROOT + '/src/data/npm-package-map.json';
const npmDirs = fs.existsSync(MAP)
  ? Object.keys((JSON.parse(fs.readFileSync(MAP, 'utf8')) as { map: Record<string, string> }).map)
  : fs.readdirSync(ROOT + '/src/data/npm');
for (const n of npmDirs) npmByCanon[canon(n)] = n;

const [manifestPath, outDir, mappingOut] = process.argv.slice(2);
const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8')) as any[];
fs.mkdirSync(outDir, { recursive: true });
const mapping: any[] = [];
let ok = 0, fail = 0;
manifest.forEach((m, i) => {
  const site = 'ptvc' + i;
  try {
    const raw = fs.readFileSync(m.file, 'utf8');
    const fps = fingerprintCollector(raw);
    const uniq = Array.from(new Map(fps.map((x: any) => [x.hash, x])).values()) as any[];
    const h: Record<number, string[]> = {};
    for (const x of uniq) { (h[x.nodes] = h[x.nodes] || []).push(x.hash); }
    fs.writeFileSync(path.join(outDir, site + '.json'), JSON.stringify(h));
    mapping.push({ site, canon: m.canon, version: m.version, npmName: npmByCanon[m.canon] || m.canon, debName: m.debName, ptvHasLabel: m.ptvHasLabel });
    ok++;
  } catch (e: any) { mapping.push({ site, canon: m.canon, version: m.version, error: String(e.message).split('\n')[0] }); fail++; }
});
fs.writeFileSync(mappingOut, JSON.stringify(mapping, null, 2));
const npmNames = [...new Set(mapping.filter((x) => x.npmName).map((x) => x.npmName))];
console.log(`hashed ${ok}/${manifest.length} (fail ${fail}) -> ${outDir}`);
console.log('SITE_FILTER=' + mapping.filter((x) => !x.error).map((x) => x.site).join(','));
console.log('NPM_FILTER_LIB=' + npmNames.join(','));
