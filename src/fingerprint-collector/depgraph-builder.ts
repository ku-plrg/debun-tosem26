import fs from 'fs';
import path from 'path';
import { DepGraph } from '../types/depgraph';
import { extractFileDeps } from './dep-extractor';
import { resolveSpec } from './dep-resolver';

function getAllFiles(dirPath: string, basePath: string = dirPath): string[] {
  const entries = fs.readdirSync(dirPath, { withFileTypes: true });
  let result: string[] = [];
  for (const entry of entries) {
    const fullPath = path.join(dirPath, entry.name);
    if (entry.isFile()) {
      result.push(path.relative(basePath, fullPath));
    } else if (entry.isDirectory()) {
      result = result.concat(getAllFiles(fullPath, basePath));
    }
  }
  return result;
}

function isJS(files: string[]): string[] {
  return files.filter(
    (f) => f.endsWith('.js') || f.endsWith('.mjs') || f.endsWith('.cjs')
  );
}

export function buildDepGraph(pkgRoot: string): DepGraph {
  const allFiles = isJS(getAllFiles(pkgRoot));
  const nodes = [...allFiles].sort();

  const edgeSet = new Set<string>();
  const edges: [string, string][] = [];
  const unresolved: [string, string][] = [];

  for (const relFile of nodes) {
    let code: string;
    try {
      code = fs.readFileSync(path.join(pkgRoot, relFile), 'utf-8');
    } catch (e) {
      console.log('[Read error]', (e as Error).message, relFile);
      continue;
    }

    let deps: ReturnType<typeof extractFileDeps>;
    try {
      deps = extractFileDeps(relFile, code);
    } catch (e) {
      console.log('[parse error]', relFile, (e as Error).message);
      continue;
    }

    for (const dep of deps) {
      const result = resolveSpec(relFile, dep.spec, pkgRoot);
      if ('resolved' in result) {
        const key = `${relFile}::${result.resolved}`;
        if (!edgeSet.has(key)) {
          edgeSet.add(key);
          edges.push([relFile, result.resolved]);
        }
      } else {
        unresolved.push([relFile, dep.spec]);
      }
    }
  }

  return { nodes, edges, unresolved };
}
