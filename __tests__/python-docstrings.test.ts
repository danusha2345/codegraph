import { beforeAll, afterEach, expect, it } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { extractFromSource } from '../src/extraction';
import { initGrammars, loadGrammarsForLanguages } from '../src/extraction/grammars';
import { tryKernelExtract } from '../src/extraction/kernel';
import { CodeGraph } from '../src';

const source = [
  '# module comment',
  '"""Ledger module vocabulary."""',
  '# Leading explanation',
  'def reconcile_ledger():',
  '    """Settle the nightly discrepancy with the bank.',
  '',
  '    Further detail.',
  '        Indented example.',
  '    """',
  '    return 1',
  '',
  '@decorate',
  'class Ledger:',
  '    r"""Class documentation."""',
  '    async def audit(self):',
  '        # harmless comment',
  '        u"Method documentation."',
  '        return 1',
  '',
  'def concatenated():',
  '    ("First " "second.")',
  '    pass',
  '',
  'def bytes_are_not_docs():',
  '    b"not prose"',
  '    pass',
  'def interpolation_is_not_docs():',
  '    f"not prose {value}"',
  '    pass',
  'def late_string():',
  '    x = 1',
  '    "not prose"',
  'def nested():',
  '    def inner():',
  '        """Nested documentation."""',
  '        return 1',
  'def empty():',
  '    """   """',
  '    pass',
].join('\n');

beforeAll(async () => {
  await initGrammars();
  await loadGrammarsForLanguages(['python']);
});
const originalKernel = process.env.CODEGRAPH_KERNEL;
afterEach(() => {
  if (originalKernel === undefined) delete process.env.CODEGRAPH_KERNEL;
  else process.env.CODEGRAPH_KERNEL = originalKernel;
});

it.each(['\n', '\r\n'])('extracts only genuine body docstrings and preserves indentation (%j)', newline => {
  process.env.CODEGRAPH_KERNEL = '0';
  const result = extractFromSource('ledger.py', source.replace(/\n/g, newline), 'python');
  const doc = (name: string) => result.nodes.find(n => n.name === name)?.docstring;
  expect(doc('ledger.py')).toBe('Ledger module vocabulary.');
  expect(doc('reconcile_ledger')).toBe('Leading explanation\n\nSettle the nightly discrepancy with the bank.\n\nFurther detail.\n    Indented example.');
  expect(doc('Ledger')).toBe('Class documentation.');
  expect(doc('audit')).toBe('Method documentation.');
  expect(doc('concatenated')).toBe('First second.');
  expect(doc('inner')).toBe('Nested documentation.');
  for (const name of ['bytes_are_not_docs', 'interpolation_is_not_docs', 'late_string', 'nested', 'empty']) {
    expect(doc(name), name).toBeUndefined();
  }
});

const kernelPath = path.resolve(__dirname, '../codegraph-kernel/prebuilds', process.platform + '-' + process.arch, 'codegraph-kernel.node');
it.each([
  ['unicode margin', 'def f():\n    """heading\n\u00a0text\n  next\n    """\n    pass', 'heading\ntext\n next'],
  ['tab after emoji', 'def f():\n    """😀\twords"""\n    pass', '😀       words'],
  ['Python whitespace', 'def f():\n    """head\n\u0085text\n  tail\n    """\n    pass', 'head\ntext\n tail'],
  ['comment before string', 'def f():\n    (\n      # comment\n      "hello world"\n    )\n    pass', 'hello world'],
  ['comment between strings', 'def f():\n    ("hello "\n      # comment\n      "world")\n    pass', 'hello world'],
])('%s is identical in WASM and native extraction', (_label, code, expected) => {
  process.env.CODEGRAPH_KERNEL = '0';
  const wasm = extractFromSource('a.py', code!, 'python');
  expect(wasm.nodes.find(n => n.name === 'f')?.docstring).toBe(expected);
  if (fs.existsSync(kernelPath)) {
    delete process.env.CODEGRAPH_KERNEL;
    const native = tryKernelExtract('a.py', code!, 'python');
    expect(native).not.toBeNull();
    expect(native!.nodes.find(n => n.name === 'f')?.docstring).toBe(expected);
  }
});

it.skipIf(!fs.existsSync(kernelPath))('native and WASM paths carry the same docstrings', () => {
  delete process.env.CODEGRAPH_KERNEL;
  const native = tryKernelExtract('ledger.py', source, 'python');
  expect(native).not.toBeNull();
  process.env.CODEGRAPH_KERNEL = '0';
  const wasm = extractFromSource('ledger.py', source, 'python');
  const docs = (nodes: typeof wasm.nodes) => nodes.map(n => [n.kind, n.qualifiedName, n.docstring]);
  expect(docs(native!.nodes)).toEqual(docs(wasm.nodes));
});

it('indexes authored prose, and removes stale prose on sync', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cg-1905-'));
  let cg: CodeGraph | undefined;
  try {
    const file = path.join(root, 'ledger.py');
    fs.writeFileSync(file, 'def reconcile_ledger():\n    """Settle the nightly discrepancy with the bank."""\n    return 1\n');
    cg = CodeGraph.initSync(root);
    await cg.indexAll();
    expect(cg.searchNodes('discrepancy bank').map(r => r.node.name)).toContain('reconcile_ledger');
    fs.writeFileSync(file, 'def reconcile_ledger():\n    return 12345\n');
    await cg.sync();
    expect(cg.searchNodes('discrepancy bank')).toEqual([]);
  } finally {
    cg?.close();
    fs.rmSync(root, { recursive: true, force: true });
  }
});
