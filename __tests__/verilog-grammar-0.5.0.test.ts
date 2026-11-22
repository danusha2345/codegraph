import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { Parser, Language } from 'web-tree-sitter';
import { CodeGraph } from '../src';

let parser: Parser;
let root: string;
let cg: CodeGraph | undefined;

beforeAll(async () => {
  await Parser.init();
  parser = new Parser();
  parser.setLanguage(await Language.load(path.join(__dirname, '../src/extraction/wasm/tree-sitter-systemverilog.wasm')));
});
afterAll(() => { parser?.delete(); });
beforeEach(() => { root = fs.mkdtempSync(path.join(os.tmpdir(), 'sv050-')); });
afterEach(() => { cg?.close(); cg = undefined; fs.rmSync(root, { recursive: true, force: true }); });

function parse(source: string) {
  const tree = parser.parse(source)!;
  return tree;
}

describe('tree-sitter-systemverilog 0.5.0 compatibility', () => {
  it('records the vendored grammar source and checksum', () => {
    const wasm = fs.readFileSync(path.join(__dirname, '../src/extraction/wasm/tree-sitter-systemverilog.wasm'));
    // gmlarumbe/tree-sitter-systemverilog v0.5.0 release asset
    // https://github.com/gmlarumbe/tree-sitter-systemverilog/releases/tag/v0.5.0
    const sha256 = createHash('sha256').update(wasm).digest('hex');
    expect(sha256).toBe('bdd8246dd326e174ec7904f391e472d9a8d5212b2e3eee9c8ec6f692dbdb0920');
  });

  it('#85: bit-selected port connection stays a module instantiation and binds base signal', async () => {
    // Before 0.5.0 this could parse as udp_instantiation; the module-to-module
    // edge was lost. After 0.5.0 it is a normal module_instantiation.
    const source = `module top(input [1:0] a, b, output y);
  f u1(a[0], b[1]);
  assign y = a[0];
endmodule
module f(input x, y); endmodule
`;
    const tree = parse(source);
    try {
      expect(tree.rootNode.hasError).toBe(false);
      expect(tree.rootNode.descendantsOfType('module_instantiation').length).toBe(1);
      expect(tree.rootNode.descendantsOfType('udp_instantiation').length).toBe(0);
    } finally { tree.delete(); }

    fs.writeFileSync(path.join(root, 'top.sv'), source);
    cg = CodeGraph.initSync(root); await cg.indexAll();
    const inst = cg.getNodesByKind('variable').find(n => n.name === 'u1');
    expect(inst).toBeDefined();
    const edges = cg.getOutgoingEdges(inst!.id);
    expect(edges.some(e => e.kind === 'instantiates' && cg.getNode(e.target)?.name === 'f')).toBe(true);
    // Port binding should identify the base signal, not the select expression.
    const portBindings = cg.getNodesByKind('property').filter(n => n.qualifiedName.startsWith('top::u1::port['));
    expect(portBindings).toHaveLength(2);
    const boundSignals = portBindings.flatMap(p => cg.getOutgoingEdges(p.id)
      .filter(e => e.kind === 'references' && cg.getNode(e.target)?.kind === 'field')
      .map(e => cg.getNode(e.target)!.name));
    expect(boundSignals).toEqual(expect.arrayContaining(['a', 'b']));
  });

  it('#86: part-select range stays a select sibling and signal refs keep base/index signals', async () => {
    // Before 0.5.0, a multi-index select could nest ranges under bit_select.
    // After 0.5.0, select contains bit_select and constant_range as siblings.
    const source = `module m(input [7:0] a, input [1:0] i, output [3:0] x);
  assign x = a[i][3:0];
endmodule
`;
    const tree = parse(source);
    try {
      expect(tree.rootNode.hasError).toBe(false);
      const selects = tree.rootNode.descendantsOfType('select');
      expect(selects).toHaveLength(1);
      expect(selects[0].namedChildren.map(c => c.type)).toEqual(['bit_select', 'constant_range']);
    } finally { tree.delete(); }

    fs.writeFileSync(path.join(root, 'm.sv'), source);
    cg = CodeGraph.initSync(root); await cg.indexAll();
    const refs = (cg as any).db.db.prepare("SELECT metadata FROM edges WHERE kind='references'").all();
    const names = refs.flatMap((r: any) => {
      const m = (r.metadata ?? '').match(/"refName":"(hdl:signal:[^"]+)"/g) ?? [];
      return m.map((x: string) => x.slice('"refName":"'.length, -1));
    });
    expect(names).toEqual(expect.arrayContaining(['hdl:signal:a', 'hdl:signal:i', 'hdl:signal:x']));
  });

  it('#80: package/static method calls keep call edges; no-paren member is not a method call', async () => {
    // Before 0.5.0, Class::member could be parsed as a zero-arg method call.
    // After 0.5.0, static calls require parentheses and non-call members are
    // represented differently.
    const source = `package pkg;
  function automatic int method(); return 1; endfunction
  parameter int member = 7;
endpackage
module m(output int y);
  initial begin
    y = pkg::method();
  end
endmodule
`;
    const tree = parse(source);
    try {
      expect(tree.rootNode.hasError).toBe(false);
      const methodCalls = tree.rootNode.descendantsOfType('method_call');
      expect(methodCalls.some(c => c.text.includes('pkg::method'))).toBe(true);
    } finally { tree.delete(); }

    fs.writeFileSync(path.join(root, 'pkg.sv'), source);
    cg = CodeGraph.initSync(root); await cg.indexAll();
    const calls = (cg as any).db.db.prepare("SELECT kind, metadata FROM edges WHERE kind='calls'").all();
    expect(calls.some((e: any) => (e.metadata ?? '').includes('"refName":"pkg::method"'))).toBe(true);

    const memberSource = `package pkg;
  parameter int member = 7;
endpackage
module m(output int y);
  initial y = pkg::member;
endmodule
`;
    const memberTree = parse(memberSource);
    try {
      expect(memberTree.rootNode.hasError).toBe(false);
      expect(memberTree.rootNode.descendantsOfType('method_call').length).toBe(0);
    } finally { memberTree.delete(); }

    fs.rmSync(root, { recursive: true, force: true });
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'sv050-'));
    cg?.close();
    cg = CodeGraph.initSync(root);
    fs.writeFileSync(path.join(root, 'member.sv'), memberSource);
    await cg.indexAll();
    const memberCalls = (cg as any).db.db.prepare("SELECT metadata FROM edges WHERE kind='calls'").all();
    expect(memberCalls.some((e: any) => (e.metadata ?? '').includes('pkg::member'))).toBe(false);
  });
});
