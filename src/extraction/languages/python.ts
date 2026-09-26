import { getNodeText, getChildByField } from '../tree-sitter-helpers';
import type { LanguageExtractor } from '../tree-sitter-types';
import type { Node as SyntaxNode } from 'web-tree-sitter';

/** Read prose from the first statement, never an arbitrary string in a body. */
export function pythonBodyDocstring(node: SyntaxNode): string | undefined {
  const body = node.type === 'module' ? node : node.childForFieldName('body');
  const statement = body?.namedChildren.find(child => child.type !== 'comment');
  if (statement?.type !== 'expression_statement') return undefined;
  function literal(value: SyntaxNode | null): string | undefined {
    if (!value) return undefined;
    if (value.type === 'parenthesized_expression') return literal(value.namedChildren.find(child => child.type !== 'comment') ?? null);
    if (value.type === 'concatenated_string') {
      const parts = value.namedChildren.filter(child => child.type !== 'comment').map(literal);
      return parts.every(part => part !== undefined) ? parts.join('') : undefined;
    }
    if (value.type !== 'string') return undefined;
    const match = /^([ru]*)("""|'''|"|')/i.exec(value.text);
    if (!match || !value.text.endsWith(match[2]!)) return undefined;
    // Keep source escapes verbatim, as with preceding comments; do not execute
    // or interpolate Python. Bytes and f-strings are not Python docstrings.
    return value.text.slice(match[0].length, -match[2]!.length);
  }
  const text = literal(statement.namedChildren[0] ?? null);
  if (text === undefined) return undefined;
  // Python whitespace and code-point columns, shared with the Rust walker.
  const whitespace = /[\u0009-\u000d\u001c-\u0020\u0085\u00a0\u1680\u2000-\u200a\u2028\u2029\u202f\u205f\u3000]/;
  const leading = (line: string[]) => {
    const first = line.findIndex(char => !whitespace.test(char));
    return first < 0 ? line.length : first;
  };
  const lines = text.replace(/\r\n?/g, '\n').split('\n').map(line => {
    const expanded: string[] = [];
    for (const char of line) {
      if (char === '\t') expanded.push(...' '.repeat(8 - expanded.length % 8));
      else expanded.push(char);
    }
    return expanded;
  });
  const margins = lines.slice(1).filter(line => leading(line) !== line.length).map(leading);
  const margin = margins.length ? Math.min(...margins) : 0;
  const cleaned = [lines[0]!.slice(leading(lines[0]!)), ...lines.slice(1).map(line => line.slice(margin))];
  while (cleaned.length && cleaned[0]!.every(char => whitespace.test(char))) cleaned.shift();
  while (cleaned.length && cleaned[cleaned.length - 1]!.every(char => whitespace.test(char))) cleaned.pop();
  return cleaned.map(line => line.join('')).join('\n') || undefined;
}

export const pythonExtractor: LanguageExtractor = {
  functionTypes: ['function_definition'],
  classTypes: ['class_definition'],
  methodTypes: ['function_definition'], // Methods are functions inside classes
  interfaceTypes: [],
  structTypes: [],
  enumTypes: [],
  typeAliasTypes: [],
  importTypes: ['import_statement', 'import_from_statement'],
  callTypes: ['call'],
  variableTypes: ['assignment'], // Python uses assignment for variable declarations
  nameField: 'name',
  bodyField: 'body',
  paramsField: 'parameters',
  returnField: 'return_type',
  getBodyDocstring: pythonBodyDocstring,
  getSignature: (node, source) => {
    const params = getChildByField(node, 'parameters');
    const returnType = getChildByField(node, 'return_type');
    if (!params) return undefined;
    let sig = getNodeText(params, source);
    if (returnType) {
      sig += ' -> ' + getNodeText(returnType, source);
    }
    return sig;
  },
  isAsync: (node) => {
    const prev = node.previousSibling;
    return prev?.type === 'async';
  },
  isStatic: (node) => {
    // Check for @staticmethod decorator
    const prev = node.previousNamedSibling;
    if (prev?.type === 'decorator') {
      const text = prev.text;
      return text.includes('staticmethod');
    }
    return false;
  },
  extractImport: (node, source) => {
    const importText = source.substring(node.startIndex, node.endIndex).trim();
    if (node.type === 'import_from_statement') {
      const moduleNode = node.childForFieldName('module_name');
      if (moduleNode) {
        return { moduleName: source.substring(moduleNode.startIndex, moduleNode.endIndex), signature: importText };
      }
    }
    // import_statement creates multiple imports - return null for core fallback
    return null;
  },
};
