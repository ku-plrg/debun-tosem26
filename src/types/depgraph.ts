export type DepKind = 'esm' | 'cjs' | 'amd';

export interface DepRef {
  from: string;
  kind: DepKind;
  spec: string;
}

export interface DepGraph {
  nodes: string[];
  edges: [string, string][];
  unresolved: [string, string][];
}

export interface FileHashRecord {
  hashes: string[];
  funcCount: number;
}

export interface FilterRecord {
  passed: boolean;
  fileHashCount: number;
  cdnHashCount: number;
  missingHashCount: number;
  versionSource: 'same' | 'superset';
}
