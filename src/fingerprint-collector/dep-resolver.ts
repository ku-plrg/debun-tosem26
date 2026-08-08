import fs from 'fs';
import path from 'path';

const EXTENSIONS = ['.js', '.mjs', '.cjs'];

function probeExtensions(base: string, pkgRoot: string): string | undefined {
  // Try exact path first
  if (fs.existsSync(base) && fs.statSync(base).isFile()) {
    return path.relative(pkgRoot, base);
  }
  // Try adding extensions
  for (const ext of EXTENSIONS) {
    const candidate = base + ext;
    if (fs.existsSync(candidate) && fs.statSync(candidate).isFile()) {
      return path.relative(pkgRoot, candidate);
    }
  }
  // Try index files
  for (const ext of EXTENSIONS) {
    const candidate = path.join(base, 'index' + ext);
    if (fs.existsSync(candidate) && fs.statSync(candidate).isFile()) {
      return path.relative(pkgRoot, candidate);
    }
  }
  return undefined;
}

export function resolveSpec(
  from: string,
  spec: string,
  pkgRoot: string
): { resolved: string } | { unresolved: true } {
  // Bare specifier (no leading . or /)
  if (!spec.startsWith('.') && !spec.startsWith('/')) {
    return { unresolved: true };
  }

  let absBase: string;
  if (spec.startsWith('/')) {
    // Absolute-like within package: treat as relative to pkgRoot
    absBase = path.join(pkgRoot, spec);
  } else {
    // Relative: resolve against from's directory
    const fromDir = path.dirname(path.join(pkgRoot, from));
    absBase = path.resolve(fromDir, spec);
  }

  // Ensure the resolved path stays within pkgRoot
  const rel = path.relative(pkgRoot, absBase);
  if (rel.startsWith('..')) {
    return { unresolved: true };
  }

  const resolved = probeExtensions(absBase, pkgRoot);
  if (resolved !== undefined) {
    return { resolved };
  }

  return { unresolved: true };
}
