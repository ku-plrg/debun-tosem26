import { ESTree } from 'meriyah';
import { rapidhash } from 'rapidhash-js';
import { Function, POGHash } from '../../types/pog';
import { builtIns } from '../../utils/builtins';

let propCnt: Record<'read' | 'write', string[]> = {
  read: [],
  write: [],
};

const SKIP_BUILTIN: string[] = builtIns.concat('arguments');

function normalizeLiteralProperty(
  value: ESTree.Literal['value']
): string | undefined {
  if (typeof value === 'string' || typeof value === 'number') {
    return String(value);
  }
  return undefined;
}

function visit(node: ESTree.Node): void {
  if (node.type === 'AssignmentExpression') {
    visit(node.right);
    if (node.left.type === 'MemberExpression') {
      const property = node.left.property;
      visit(node.left.object);
      visit(node.left.property);
      if (property.type === 'Identifier' && !node.left.computed) {
        propCnt.write.push(property.name);
      } else if (property.type === 'Literal') {
        const normalized = normalizeLiteralProperty(property.value);
        if (normalized !== undefined) propCnt.write.push(normalized);
        else propCnt.write.push('[]');
      } else {
        propCnt.write.push('[]');
      }
    } else {
      visit(node.left);
    }
  } else if (node.type === 'MemberExpression') {
    if (
      node.object.type === 'Identifier' &&
      SKIP_BUILTIN.includes(node.object.name)
    ) {
      visit(node.property);
      return;
    }
    visit(node.object);
    if (!node.computed && node.property.type === 'Identifier') {
      propCnt.read.push(node.property.name);
    } else if (node.computed && node.property.type === 'Literal') {
      const normalized = normalizeLiteralProperty(node.property.value);
      if (normalized !== undefined) propCnt.read.push(normalized);
      else propCnt.read.push('[]');
    } else {
      propCnt.read.push('[]');
    }
    visit(node.property);
  } else if (node.type === 'ObjectExpression') {
    const properties = node.properties
      .filter((prop) => prop.type === 'Property')
      .filter(
        (prop) =>
          !['AssignmentPattern', 'ObjectPattern', 'ArrayPattern'].includes(
            prop.value.type
          )
      );
    properties.forEach((prop) => {
      if (prop.type !== 'Property') {
        return;
      }
      if (prop.key.type === 'Identifier') {
        propCnt.write.push(prop.key.name);
      } else if (prop.key.type === 'Literal') {
        const normalized = normalizeLiteralProperty(prop.key.value);
        if (normalized !== undefined) propCnt.write.push(normalized);
        else propCnt.write.push('[]');
      } else {
        propCnt.write.push('[]');
      }
      visit(prop.key);
      visit(prop.value);
    });
  } else if (node.type === 'UpdateExpression') {
    visit(node.argument);
    if (node.argument.type === 'MemberExpression') {
      const property = node.argument.property;
      if (property.type === 'Identifier' && !node.argument.computed) {
        propCnt.write.push(property.name);
      } else if (property.type === 'Literal') {
        const normalized = normalizeLiteralProperty(property.value);
        if (normalized !== undefined) propCnt.write.push(normalized);
        else {
          propCnt.read.push('[]');
          propCnt.write.push('[]');
        }
      } else {
        propCnt.read.push('[]');
        propCnt.write.push('[]');
      }
    }
  } else {
    Object.entries(node).forEach(([key, value]) => {
      if (value && typeof value === 'object') {
        if (Array.isArray(value)) {
          for (let i = 0; i < value.length; i++) {
            if (value[i] && typeof value[i] === 'object') {
              visit(value[i]);
            }
          }
        } else {
          visit(value);
        }
      }
    });
  }
}

// ['b','c','a','b','c','a','b','c'] => 'a:2,b:3,c:3'
function makeSortedCntRecordStr(strList: string[]): string {
  const map: Record<string, number> = {};
  strList.forEach((str) => {
    if (map[str] === undefined) map[str] = 1;
    else map[str]++;
  });
  return Object.entries(map)
    .sort((a, b) => a[0].localeCompare(b[0]))
    .map(([k, v]) => `${k}:${v}`)
    .join(',');
}

function getPropertyCnt(node: ESTree.Node): { str: string; nodes: number } {
  propCnt = {
    read: [],
    write: [],
  };
  visit(node);
  return {
    str: `read-computed:${makeSortedCntRecordStr(
      propCnt.read
    )},read-not-computed:${makeSortedCntRecordStr(
      propCnt.read
    )},write-computed:${makeSortedCntRecordStr(
      propCnt.write
    )},write-not-computed:${makeSortedCntRecordStr(propCnt.write)}`,
    nodes: propCnt.read.length + propCnt.write.length,
  };
}

export function getPropertyCnthash(
  f: Function | undefined,
  node: ESTree.Node
): POGHash {
  const propCnt = getPropertyCnt(node);
  return {
    id: f?.id,
    hash: rapidhash(propCnt.str).toString(16),
    nodes: propCnt.nodes,
    body: node,
  };
}
