import fs, { readFileSync } from 'fs';
import path, { join } from 'path';
import semverSort from 'semver/functions/sort';
import semverValid from 'semver/functions/valid';
import fingerprintCollector from '../../fingerprint-collector';
import extractFunctions from '../../fingerprint-collector/function-collector';
import { generatePOGHash } from '../../fingerprint-collector/hash-function';
import { extractPOG } from '../../fingerprint-collector/pog-generator';
import { getPropertyCnthash } from '../../evaluation/rq2-ablation/property-cnt';
import { Function as Func, POGAnalysisOptions, POGHash } from '../../types/pog';

// POG-generation model for the ablation databases. MODEL selects the fingerprint
// method and the output-file suffix (mirrors gen-web-hashes.ts):
//   pog (default '')  full DEBUN (POG+FBCI)   cnt ('-cnt') Count   cfg ('-cfg') basic POG
type Method = 'pog' | 'cnt' | 'cfg';
const METHOD_SUFFIX: Record<Method, string> = { pog: '', cnt: '-cnt', cfg: '-cfg' };
const MODEL = (process.env['MODEL'] ?? 'pog') as Method;
if (!(MODEL in METHOD_SUFFIX)) {
  console.error(`[Fatal] MODEL must be one of pog|cnt|cfg, got '${MODEL}'`);
  process.exit(1);
}
const SUFFIX = METHOD_SUFFIX[MODEL];
// "cfg" model = basic POG: every refinement toggle off.
const OFF: POGAnalysisOptions = {
  branchFlipping: false,
  branchBypassing: false,
  pathCloning: false,
  literalProperty: false,
  assignmentPropagation: false,
  skipArguments: false,
  inlining: false,
};
function collectHashesForDb(code: string): POGHash[] {
  if (MODEL === 'pog') return fingerprintCollector(code, undefined, { extractFunctionId: false });
  const valid = extractFunctions(code, false).filter(
    (f) => f.id !== undefined && !f.id.startsWith('JSCA_null')
  );
  if (MODEL === 'cnt') return valid.map((f) => getPropertyCnthash(undefined, f.body));
  return valid.map((f: Func) => generatePOGHash({ body: f.body, graph: extractPOG(f, OFF).nodes }));
}

// Types
type HashData = Record<
  string,
  Record<string, Record<number, Array<[number, number]>>>
>;
type LibData = Record<
  string,
  { id: number; versions: string[]; hashCnt: number[] }
>;

const rootDir = process.cwd();

const parseVersionString = (version: string) => {
  const [major, minor, patch = '0'] = version.split('.');
  const [patchVersion, patchSuffix = '0'] = patch.split('-');
  return [
    parseInt(major),
    parseInt(minor),
    parseInt(patchVersion),
    patchSuffix,
  ];
};

// DB_DIR overrides the output database dir (used to rebuild into a scratch dir
// for reproducibility checks without clobbering the shipped databases).
const outputDir = process.env['DB_DIR']
  ? (path.isAbsolute(process.env['DB_DIR']) ? process.env['DB_DIR'] : join(rootDir, process.env['DB_DIR']))
  : join(rootDir, './src/data/debun-hashes');
const hashFilename = join(outputDir, `all-hash${SUFFIX}.json`);
const libFilename = join(outputDir, `all-libs${SUFFIX}.json`);
fs.mkdirSync(outputDir, { recursive: true });

// CDN_DIR overrides the library source dir (used for testing on a small subset).
const cdnDataDirPath = process.env['CDN_DIR']
  ? (path.isAbsolute(process.env['CDN_DIR']) ? process.env['CDN_DIR'] : join(rootDir, process.env['CDN_DIR']))
  : join(rootDir, './src/data/cdn');

/**
 * Checks if a version string follows semantic versioning without suffix
 * @param version - The version string to check
 * @returns Array of version numbers or false if invalid
 */
/**
 * Recursively gets all files from a directory
 * @param dirPath - Directory path to scan
 * @param basePath - Base path for generating relative paths
 * @returns Array of relative file paths
 */
function getAllFiles(dirPath: string, basePath: string = dirPath): string[] {
  const entries = fs.readdirSync(dirPath, { withFileTypes: true });

  let result: string[] = [];
  for (const entry of entries) {
    const fullPath = path.join(dirPath, entry.name);
    const relativePath = path.relative(basePath, fullPath);

    if (entry.isFile()) {
      result.push(relativePath);
    } else if (entry.isDirectory()) {
      result = result.concat(getAllFiles(fullPath, basePath));
    }
  }

  return result;
}

function isJS(files: string[]): string[] {
  return files.filter(
    (file) =>
      file.endsWith('js') || file.endsWith('mjs') || file.endsWith('cjs')
  );
}

/**
 * Main function to process libraries and generate hash data
 */
(async () => {
  const start = Date.now();
  let allLibs: LibData = {};
  let allHashes: HashData = {};
  try {
    let libIdx = 0;

    const libNames = fs.readdirSync(cdnDataDirPath);

    for (const libName of libNames) {
      console.log('processing', libName);
      allLibs[libName] = { id: libIdx, versions: [], hashCnt: [] };
      const versions = fs.readdirSync(join(cdnDataDirPath, libName));
      let versionIdx = 0;
      const v = versions.filter(
        (version) =>
          semverValid(version) && parseVersionString(version)[3] === '0'
      );
      for (const version of semverSort(v)) {
        const hashes: POGHash[] = [];
        const files = getAllFiles(join(cdnDataDirPath, libName, version));
        for (const file of isJS(files)) {
          try {
            const code = readFileSync(
              join(cdnDataDirPath, libName, version, file),
              'utf-8'
            );
            try {
              // Fingerprint with the selected POG model (pog/cnt/cfg). RQ2/RQ3
              // detection paths don't read Function.id, so pog mode skips the
              // per-function getId walk.
              const hash = collectHashesForDb(code);
              hashes.push(...hash);
            } catch (hashError) {
              console.log(
                '[Hash error]',
                (hashError as Error).message,
                libName,
                version,
                file
              );
            }
          } catch (readError) {
            console.log(
              '[Read error]',
              (readError as Error).message,
              libName,
              version,
              file
            );
          }
        }

        const uniqueHashes = Array.from(
          new Map(hashes.map((hash) => [hash.hash, hash])).values()
        );

        if (uniqueHashes.length === 0) continue;

        allLibs[libName].versions.push(version);
        allLibs[libName].hashCnt.push(uniqueHashes.length);

        uniqueHashes.forEach(({ hash, nodes }) => {
          if (allHashes[nodes]) {
            if (allHashes[nodes][hash]) {
              if (allHashes[nodes][hash][libIdx]) {
                const prevHash = allHashes[nodes][hash][libIdx];
                if (prevHash[prevHash.length - 1][1] === versionIdx - 1)
                  allHashes[nodes][hash][libIdx][prevHash.length - 1][1] =
                    versionIdx;
                else
                  allHashes[nodes][hash][libIdx].push([versionIdx, versionIdx]);
              } else {
                allHashes[nodes][hash][libIdx] = [[versionIdx, versionIdx]];
              }
            } else {
              allHashes[nodes][hash] = {
                [libIdx]: [[versionIdx, versionIdx]],
              };
            }
          } else {
            allHashes[nodes] = {
              [hash]: {
                [libIdx]: [[versionIdx, versionIdx]],
              },
            };
          }
        });
        versionIdx++;
      }
      libIdx++;
    }
  } catch (e) {
    console.error('error', (e as Error).message);
    console.log('write', hashFilename, 'before I die..');
    console.log('write', libFilename, 'before I die..');
    fs.writeFileSync(
      hashFilename.split('.')[0] + 'error' + '.json',
      JSON.stringify(allHashes, null, 2)
    );
    fs.writeFileSync(
      libFilename.split('.')[0] + 'error' + '.json',
      JSON.stringify(allLibs, null, 2)
    );
  }

  console.log('finish', Date.now() - start, 'ms');
  fs.writeFileSync(hashFilename, JSON.stringify(allHashes, null, 2));
  fs.writeFileSync(libFilename, JSON.stringify(allLibs, null, 2));
})();
