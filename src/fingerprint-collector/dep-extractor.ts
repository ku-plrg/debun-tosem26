import { ESTree, parse } from 'meriyah';
import walk from '../utils/walk';
import { DepKind, DepRef } from '../types/depgraph';

function extractDeps(code: string): { kind: DepKind; spec: string }[] {
  let ast: ESTree.Program;
  try {
    ast = parse(code, { next: true, module: false, loc: true });
  } catch {
    ast = parse(code, { next: true, module: true, loc: true });
  }

  const refs: { kind: DepKind; spec: string }[] = [];

  walk(ast as ESTree.Node, {
    ImportDeclaration(node: ESTree.Node) {
      if (node.type !== 'ImportDeclaration') return;
      const src = (node as any).source;
      if (src?.type === 'Literal' && typeof src.value === 'string') {
        refs.push({ kind: 'esm', spec: src.value });
      }
    },
    ExportAllDeclaration(node: ESTree.Node) {
      if (node.type !== 'ExportAllDeclaration') return;
      const src = (node as any).source;
      if (src?.type === 'Literal' && typeof src.value === 'string') {
        refs.push({ kind: 'esm', spec: src.value });
      }
    },
    ExportNamedDeclaration(node: ESTree.Node) {
      if (node.type !== 'ExportNamedDeclaration') return;
      const src = (node as any).source;
      if (src?.type === 'Literal' && typeof src.value === 'string') {
        refs.push({ kind: 'esm', spec: src.value });
      }
    },
    ImportExpression(node: ESTree.Node) {
      if (node.type !== 'ImportExpression') return;
      const src = (node as any).source;
      if (src?.type === 'Literal' && typeof src.value === 'string') {
        refs.push({ kind: 'esm', spec: src.value });
      }
    },
    CallExpression(node: ESTree.Node) {
      if (node.type !== 'CallExpression') return;
      const n = node as any;
      const callee = n.callee;
      const args = n.arguments;

      // CJS: require('literal')
      if (
        callee.type === 'Identifier' &&
        callee.name === 'require' &&
        args.length >= 1 &&
        args[0].type === 'Literal' &&
        typeof args[0].value === 'string'
      ) {
        refs.push({ kind: 'cjs', spec: args[0].value });
        return;
      }

      // CJS: require.resolve('literal')
      if (
        callee.type === 'MemberExpression' &&
        callee.object?.type === 'Identifier' &&
        callee.object.name === 'require' &&
        callee.property?.type === 'Identifier' &&
        callee.property.name === 'resolve' &&
        args.length >= 1 &&
        args[0].type === 'Literal' &&
        typeof args[0].value === 'string'
      ) {
        refs.push({ kind: 'cjs', spec: args[0].value });
        return;
      }

      // AMD: define([deps], fn) or require([deps], fn)
      if (
        callee.type === 'Identifier' &&
        (callee.name === 'define' || callee.name === 'require') &&
        args.length >= 1 &&
        args[0].type === 'ArrayExpression'
      ) {
        for (const el of args[0].elements) {
          if (el?.type === 'Literal' && typeof el.value === 'string') {
            refs.push({ kind: 'amd', spec: el.value });
          }
        }
      }
    },
  });

  return refs;
}

export function extractFileDeps(from: string, code: string): DepRef[] {
  const results = extractDeps(code);
  return results.map(r => ({ from, kind: r.kind, spec: r.spec }));
}

export default extractDeps;
