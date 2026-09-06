/**
 * A function nested inside another function is only callable from inside its
 * container. matchByExactName already filters candidates that way; matchFuzzy
 * must too, or a call to a builtin method (`res.text()`) whose only same-named
 * project symbol is some file's closure resolves onto that closure.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { CodeGraph } from '../src';

describe('fuzzy matching respects lexical reachability of nested functions', () => {
  let tempDir: string;
  let cg: CodeGraph | null = null;

  beforeEach(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'codegraph-fuzzy-reach-'));
  });

  afterEach(() => {
    cg?.destroy();
    cg = null;
    try {
      fs.rmSync(tempDir, { recursive: true, force: true });
    } catch {
      // Windows can still hold the SQLite handle for a moment; the OS temp dir is swept anyway.
    }
  });

  it('does not resolve a builtin method call onto another file\'s closure of the same name', async () => {
    fs.writeFileSync(
      path.join(tempDir, 'seed.ts'),
      [
        'export function readSeedState(raw: string): string {',
        '  function text(): string {',
        '    return raw.trim();',
        '  }',
        '  return text();',
        '}',
        '',
      ].join('\n')
    );
    fs.writeFileSync(
      path.join(tempDir, 'fetch.ts'),
      [
        'export async function readOkText(settled: { value: Response }): Promise<string> {',
        '  // A chained receiver reaches the resolver as the bare method name.',
        '  return settled.value.text();',
        '}',
        '',
      ].join('\n')
    );
    cg = await CodeGraph.init(tempDir, { index: true });
    cg.resolveReferences();

    const closure = cg
      .getNodesByKind('function')
      .find((n) => n.name === 'text' && n.filePath === 'seed.ts');
    const caller = cg.getNodesByKind('function').find((n) => n.name === 'readOkText');
    expect(closure).toBeDefined();
    expect(caller).toBeDefined();

    const fromCaller = cg.getOutgoingEdges(caller!.id).filter((e) => e.kind === 'calls');
    expect(fromCaller.map((e) => e.target)).not.toContain(closure!.id);

    // The in-container call still resolves.
    const container = cg.getNodesByKind('function').find((n) => n.name === 'readSeedState');
    const inside = cg.getOutgoingEdges(container!.id).filter((e) => e.kind === 'calls');
    expect(inside.map((e) => e.target)).toContain(closure!.id);
  });

  it.each([
    ["import { resolve } from 'node:path';", 'resolve'],
    ["import { resolve as joinPath } from 'node:path';", 'joinPath'],
    ["import resolve from 'external-resolver';", 'resolve'],
  ])('does not promote the sole survivor for %s', async (declaration, name) => {
    fs.writeFileSync(path.join(tempDir, 'nested.ts'),
      `export function owner() { function ${name}() {} return ${name}(); }`);
    fs.writeFileSync(path.join(tempDir, 'plugin.ts'),
      `export class Plugin { ${name}() { return 'plugin'; } }`);
    fs.writeFileSync(path.join(tempDir, 'config.ts'),
      `${declaration}\nexport function configure() { return ${name}('src'); }`);
    cg = await CodeGraph.init(tempDir, { index: true });
    cg.resolveReferences();
    const wrong = cg.getNodesByKind('method').find(n => n.filePath === 'plugin.ts' && n.name === name)!;
    expect(wrong).toBeDefined();
    const badEdges = cg.getNodesByKind('file')
      .concat(cg.getNodesByKind('function'), cg.getNodesByKind('import'))
      .filter(n => n.filePath === 'config.ts')
      .flatMap(n => cg!.getOutgoingEdges(n.id))
      .filter(e => e.target === wrong.id && (e.kind === 'calls' || e.kind === 'imports'));
    expect(badEdges).toEqual([]);
  });

  it('keeps a real imported target despite unreachable same-named closures', async () => {
    fs.writeFileSync(path.join(tempDir, 'nested.ts'),
      'export function owner() { function resolve() {} return resolve(); }');
    fs.writeFileSync(path.join(tempDir, 'local.ts'),
      "export function resolve(value: string) { return value; }");
    fs.writeFileSync(path.join(tempDir, 'config.ts'),
      "import { resolve } from './local';\nexport function configure() { return resolve('src'); }");
    cg = await CodeGraph.init(tempDir, { index: true });
    cg.resolveReferences();
    const target = cg.getNodesByKind('function').find(n => n.name === 'resolve' && n.filePath === 'local.ts')!;
    const caller = cg.getNodesByKind('function').find(n => n.name === 'configure')!;
    expect(target).toBeDefined();
    expect(cg.getOutgoingEdges(caller.id).filter(e => e.kind === 'calls').map(e => e.target))
      .toContain(target.id);
  });


  it('does not promote a case-insensitive survivor after rejecting a closure', async () => {
    fs.writeFileSync(path.join(tempDir, 'nested.ts'),
      'export function owner() { function resolve() {} return resolve(); }');
    fs.writeFileSync(path.join(tempDir, 'plugin.ts'),
      "export class Plugin { Resolve() { return 'plugin'; } }");
    fs.writeFileSync(path.join(tempDir, 'config.ts'),
      "export function configure() { return resolve('src'); }");
    cg = await CodeGraph.init(tempDir, { index: true });
    cg.resolveReferences();
    const caller = cg.getNodesByKind('function').find(n => n.name === 'configure')!;
    const wrong = cg.getNodesByKind('method').find(n => n.name === 'Resolve')!;
    expect(wrong).toBeDefined();
    expect(cg.getOutgoingEdges(caller.id).filter(e => e.kind === 'calls').map(e => e.target))
      .not.toContain(wrong.id);
  });

  it('keeps a same-file function shadowing an external import', async () => {
    fs.writeFileSync(path.join(tempDir, 'config.ts'),
      "import { resolve } from 'node:path';\n" +
      "export function configure() {\n function resolve() { return 'local'; }\n return resolve();\n}");
    cg = await CodeGraph.init(tempDir, { index: true });
    cg.resolveReferences();
    const caller = cg.getNodesByKind('function').find(n => n.name === 'configure')!;
    const local = cg.getNodesByKind('function').find(n => n.name === 'resolve')!;
    expect(local).toBeDefined();
    expect(cg.getOutgoingEdges(caller.id).filter(e => e.kind === 'calls').map(e => e.target))
      .toContain(local.id);
  });

});
