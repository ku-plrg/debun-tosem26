#!/usr/bin/env node
import { program } from 'commander';
import fs from 'fs';
import { downloadScripts } from '../cmd/crawler';
import { evaluate } from '../debun/phase2/lib-scorer';
import fingerprintCollector from '../fingerprint-collector';
import { POGHash } from '../types/pog';

program
  .name('DEBUN')
  .description(
    'DEBUN - Detecting JavaScript Libraries on the Web using Property-Order Graphs'
  )
  .usage('<command> [options]');

program
  .command('detect')
  .description('Detect libraries from the target website')
  .argument('<url>', 'URL of the target website')
  .action(async (url: string) => {
    console.log(`Detecting libraries from: ${url}`);
    const hashes: POGHash[] = [];
    const filePaths = await downloadScripts(url);
    for (const filePath of filePaths) {
      let raw;
      try {
        raw = fs.readFileSync(filePath, 'utf-8');
      } catch (e) {
        continue;
      }
      const fingerprints = fingerprintCollector(raw);
      for (const hash of fingerprints) {
        hashes.push(hash);
      }
    }
    const uniqueHashes = Array.from(
      new Map(hashes.map((hash) => [hash.hash, hash])).values()
    );
    const h: Record<number, string[]> = {};
    for (const hash of uniqueHashes) {
      if (!h[hash.nodes]) {
        h[hash.nodes] = [];
      }
      h[hash.nodes].push(hash.hash);
    }
    const scores = evaluate(h, { threshold: 0.2 });
    console.log('DETECTED LIBRARIES:');
    for (const score of scores) {
      const type3Version = score.type3Versions.join('@');
      const type2Version = score.type2Versions.join('@');
      const topVersion = score.topVersions.join('@');
      const version = type3Version || type2Version || topVersion;
      console.log(
        `${score.libName === 'react-dom' ? 'react' : score.libName}@${version}`
      );
    }
  });

program
  .command('fingerprint-collector')
  .description('Collect fingerprints from a target JavaScript file')
  .argument('<path>', 'path of the target JavaScript file')
  .action((path: string) => {
    console.log(`Collecting fingerprints from ${path} ...`);
    try {
      const raw = fs.readFileSync(path, 'utf-8');
      const hashes = fingerprintCollector(raw);
      const uniqueHashes = Array.from(
        new Map(hashes.map((hash) => [hash.hash, hash])).values()
      );
      const h: Record<number, string[]> = {};
      for (const hash of uniqueHashes) {
        if (!h[hash.nodes]) {
          h[hash.nodes] = [];
        }
        h[hash.nodes].push(hash.hash);
      }
      const jsonFilePath = path.replace(/\.js$/, '.json');
      fs.writeFileSync(jsonFilePath, JSON.stringify(h, null, 2));
      console.log(`Fingerprints collected and saved to ${jsonFilePath}`);
    } catch (error) {
      console.error(`Error processing file ${path}:`, error);
    }
  });

program
  .command('run')
  .description('Reproduce a paper research question (RQ1, RQ2, RQ3, RQ4)')
  .argument('<rq>', 'research question: RQ1 | RQ2 | RQ3 | RQ4')
  .action(async (rq: string) => {
    // Subcommand numbering matches the paper. The evaluation/ directory names are the older
    // scheme (rq1 = ablation, rq2 = library detection, rq3 = version detection).
    switch (rq.toUpperCase()) {
      case 'RQ1': {
        console.log('Executing performance (run RQ1; paper RQ1) — paper Table 1 ...');
        const { default: runPerf } = await import('../evaluation/rq1-performance/index');
        await runPerf();
        break;
      }
      case 'RQ2': {
        console.log('Executing ablation study (run RQ2; paper RQ2) — paper Tables 2-4 ...');
        const { runRQ1 } = await import('../evaluation/rq2-ablation/index');
        await runRQ1();
        break;
      }
      case 'RQ3': {
        console.log('Executing library detection (run RQ3; paper RQ3) — paper Table 5 ...');
        const { default: runRQ2 } = await import('../evaluation/rq3-library-detection/index');
        await runRQ2();
        break;
      }
      case 'RQ4': {
        console.log('Executing version detection (run RQ4; paper RQ4) — paper Table 6 ...');
        const { default: runRQ3 } = await import('../evaluation/rq4-version-detection/index');
        await runRQ3();
        break;
      }
      default:
        console.error('Invalid research question. Use RQ1, RQ2, RQ3, or RQ4.');
    }
  });

program.parse(process.argv);

if (!process.argv.slice(2).length) {
  program.outputHelp();
}
