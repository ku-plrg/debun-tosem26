import fs from 'fs';
import path from 'path';

const DUP_THRESHOLD = 0.3;
// POG-generation model suffix (see lib-database.ts): '' | '-cnt' | '-cfg'.
const METHOD_SUFFIX: Record<string, string> = { pog: '', cnt: '-cnt', cfg: '-cfg' };
const SUFFIX = METHOD_SUFFIX[process.env['MODEL'] ?? 'pog'] ?? '';
const versionInfo: Record<string, Record<string, string>> = JSON.parse(
  fs.readFileSync(
    path.join(__dirname, '../../data/birth_sanitized.json'),
    'utf-8'
  )
);

const getVersionBirth = (libName: string, versionName: string) => {
  if (!versionInfo[libName]) return undefined;
  if (!versionInfo[libName][versionName]) return undefined;
  return new Date(versionInfo[libName][versionName]);
};

const libInfos: Record<
  string,
  { id: number; versions: string[]; hashCnt: number[] }
> = JSON.parse(
  fs.readFileSync(
    path.join(__dirname, `../../data/debun-hashes/all-libs${SUFFIX}.json`),
    'utf-8'
  )
);

const libById: Record<
  number,
  { name: string; versions: string[]; hashCnt: number[] }
> = {};
Object.entries(libInfos).forEach(([name, info]) => {
  libById[info.id] = { name, versions: info.versions, hashCnt: info.hashCnt };
});

const displayLibName = (name: string) => name.split('____')[0];

const birthCache: Record<string, Date | null> = {};
const getVersionBirthCached = (libName: string, versionName: string) => {
  const key = `${libName}@${versionName}`;
  if (key in birthCache) return birthCache[key] ?? undefined;
  const birth = getVersionBirth(libName, versionName);
  birthCache[key] = birth ?? null;
  return birth;
};

const libHashes: Record<
  string,
  Record<string, Record<string, [number, number][]>>
> = JSON.parse(
  fs.readFileSync(
    path.join(__dirname, `../../data/debun-hashes/all-hash${SUFFIX}.json`),
    'utf-8'
  )
);

type DupMap = Record<string, number>;

const dupMap: DupMap = {};
let skippedBirthPairs = 0;

Object.entries(libHashes).forEach(([nodes, hashMatches]) => {
  Object.entries(hashMatches).forEach(([hash, matches]) => {
    const matchEntries = Object.entries(matches);
    const containedLibsCnt = matchEntries.length;
    if (containedLibsCnt < 2 || containedLibsCnt > 7) return;
    for (let i = 0; i < containedLibsCnt - 1; i++) {
      for (let j = i + 1; j < containedLibsCnt; j++) {
        const [l1Id, l1Versions] = matchEntries[i];
        const [l2Id, l2Versions] = matchEntries[j];
        const l1Info = libById[+l1Id];
        const l2Info = libById[+l2Id];
        if (!l1Info || !l2Info) continue;
        l1Versions.forEach(([l1Start, l1End]) => {
          l2Versions.forEach(([l2Start, l2End]) => {
            for (let l1Version = l1Start; l1Version <= l1End; l1Version++) {
              for (let l2Version = l2Start; l2Version <= l2End; l2Version++) {
                const l1Birth = getVersionBirthCached(
                  l1Info.name,
                  l1Info.versions[l1Version]
                );
                const l2Birth = getVersionBirthCached(
                  l2Info.name,
                  l2Info.versions[l2Version]
                );
                if (!l1Birth && !l2Birth) {
                  skippedBirthPairs++;
                  continue;
                }
                const dupmapKey = `${l1Id}-${l1Version}-${l2Id}-${l2Version}`;
                if (!dupMap[dupmapKey]) dupMap[dupmapKey] = 0;
                dupMap[dupmapKey]++;
              }
            }
          });
        });
      }
    }
  });
});
console.log('done counting dups');
console.log('skipped due to missing birth:', skippedBirthPairs);

const judgementCandidates: string[] = [];

Object.entries(dupMap).forEach(([dupmapKey, duplicateCnt]) => {
  const [l1Id, l1Version, l2Id, l2Version] = dupmapKey.split('-');
  const l1 = libById[+l1Id];
  const l2 = libById[+l2Id];
  if (!l1 || !l2) return;
  const l1Size = l1.hashCnt[+l1Version];
  const l1Percentage = duplicateCnt / l1Size;
  const l2Size = l2.hashCnt[+l2Version];
  const l2Percentage = duplicateCnt / l2Size;

  if (l1Percentage > DUP_THRESHOLD || l2Percentage > DUP_THRESHOLD) {
    judgementCandidates.push(dupmapKey);
  }
});

const winnerMap: Record<string, string[]> = {};
// winner -> loser[]

const getOldestVersionDate = (libId: string, versions: Set<number>) => {
  let oldestDate = new Date();
  const libInfo = libById[+libId];
  if (!libInfo) return oldestDate;
  for (const versionIdx of versions) {
    const versionName = libInfo.versions[versionIdx];
    const birth = getVersionBirthCached(libInfo.name, versionName);
    if (birth && birth < oldestDate) oldestDate = birth;
  }
  return oldestDate;
};

const pairVersions: Record<
  string,
  {
    l1Id: string;
    l2Id: string;
    l1Versions: Set<number>;
    l2Versions: Set<number>;
  }
> = {};

for (const dupmapKey of judgementCandidates) {
  const [l1Id, l1Version, l2Id, l2Version] = dupmapKey.split('-');
  const pairKey = `${l1Id}-${l2Id}`;
  if (!pairVersions[pairKey]) {
    pairVersions[pairKey] = {
      l1Id,
      l2Id,
      l1Versions: new Set<number>(),
      l2Versions: new Set<number>(),
    };
  }
  pairVersions[pairKey].l1Versions.add(+l1Version);
  pairVersions[pairKey].l2Versions.add(+l2Version);
}

Object.values(pairVersions).forEach(
  ({ l1Id, l2Id, l1Versions, l2Versions }) => {
    const oldestL1Version = getOldestVersionDate(l1Id, l1Versions);
    const oldestL2Version = getOldestVersionDate(l2Id, l2Versions);
    const [winner, loser] =
      oldestL1Version < oldestL2Version ? [l1Id, l2Id] : [l2Id, l1Id];
    console.log(
      'winner',
      libById[+winner] ? displayLibName(libById[+winner].name) : undefined,
      'loser',
      libById[+loser] ? displayLibName(libById[+loser].name) : undefined
    );
    if (!winnerMap[winner]) winnerMap[winner] = [];
    winnerMap[winner].push(loser);
  }
);

console.log(winnerMap);

const intraDupHashes: Record<
  string,
  Record<string, Record<string, [number, number][]>>
> = {};
// nodes->hashes->libId->versions

const intraDupLibs: Record<string, Record<string, Set<string>>> = {};
// libId->version->hashCnt

Object.entries(libHashes).forEach(([nodes, hashMatches]) => {
  Object.entries(hashMatches).forEach(([hash, matches]) => {
    const matchEntries = Object.entries(matches);
    const containedLibsCnt = matchEntries.length;
    if (containedLibsCnt < 2 || containedLibsCnt > 7) return;
    for (let i = 0; i < containedLibsCnt - 1; i++) {
      for (let j = i + 1; j < containedLibsCnt; j++) {
        const [l1Id, l1Versions] = matchEntries[i];
        const [l2Id, l2Versions] = matchEntries[j];
        const libInfo1 = libById[+l1Id];
        const libInfo2 = libById[+l2Id];
        if (!libInfo1 || !libInfo2) continue;
        let loserId: string, loserVersions: [number, number][];
        if (winnerMap[l1Id]?.includes(l2Id)) {
          loserId = l2Id;
          loserVersions = l2Versions;
        } else if (winnerMap[l2Id]?.includes(l1Id)) {
          loserId = l1Id;
          loserVersions = l1Versions;
        } else continue;

        if (!intraDupHashes[nodes]) intraDupHashes[nodes] = {};
        if (!intraDupHashes[nodes][hash]) intraDupHashes[nodes][hash] = {};
        intraDupHashes[nodes][hash][loserId] = loserVersions;
        loserVersions.forEach(([start, end]) => {
          for (let lIdx = start; lIdx <= end; lIdx++) {
            if (!intraDupLibs[loserId]) intraDupLibs[loserId] = {};
            if (!intraDupLibs[loserId][lIdx])
              intraDupLibs[loserId][lIdx] = new Set();
            intraDupLibs[loserId][lIdx].add(hash);
          }
        });
      }
    }
  });
});

fs.mkdirSync(path.join(__dirname, `../../data/debun-hashes`), { recursive: true });

fs.writeFileSync(
  path.join(__dirname, `../../data/debun-hashes/dups-${DUP_THRESHOLD}-hash${SUFFIX}.json`),
  JSON.stringify(intraDupHashes, null, 2)
);

const blacklistLibsForSave: Record<string, Record<string, number>> = {};
Object.entries(intraDupLibs).forEach(([libId, versions]) => {
  Object.entries(versions).forEach(([version, hashes]) => {
    if (!blacklistLibsForSave[libId]) blacklistLibsForSave[libId] = {};
    blacklistLibsForSave[libId][version] = hashes.size;
  });
});

fs.writeFileSync(
  path.join(__dirname, `../../data/debun-hashes/dups-${DUP_THRESHOLD}-libs${SUFFIX}.json`),
  JSON.stringify(blacklistLibsForSave, null, 2)
);

console.log(
  path.join(__dirname, `../../data/debun-hashes/dups-${DUP_THRESHOLD}-hash${SUFFIX}.json`),
  path.join(__dirname, `../../data/debun-hashes/dups-${DUP_THRESHOLD}-libs${SUFFIX}.json`)
);
