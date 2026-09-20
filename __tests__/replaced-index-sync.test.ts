import { afterEach, expect, it, vi } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { CodeGraph } from '../src';
import { ToolHandler } from '../src/mcp/tools';

let root: string;
const connections: CodeGraph[] = [];
afterEach(async () => {
  for (const cg of connections.splice(0)) {
    cg.unwatch();
    await vi.waitFor(() => expect(cg.isIndexing()).toBe(false));
    cg.close();
  }
  if (root) fs.rmSync(root, { recursive: true, force: true });
});

async function replaced() {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'cg-1902-'));
  fs.writeFileSync(path.join(root, 'a.ts'), 'export function alpha() { return 1; }');
  fs.writeFileSync(path.join(root, 'b.ts'), 'export function before() { return 1; }');
  const held = CodeGraph.initSync(root);
  connections.push(held);
  await held.indexAll();
  const fresh = await CodeGraph.recreate(root);
  connections.push(fresh);
  await fresh.indexAll();
  fresh.close();
  fs.writeFileSync(path.join(root, 'a.ts'), 'export function missedAfterRebuild() { return 2; }');
  fs.writeFileSync(path.join(root, 'b.ts'), 'export function latestEvent() { return 3; }');
  return held;
}

it.runIf(process.platform !== 'win32')('reopens before scoped sync and reconciles files outside the event batch', async () => {
  const held = await replaced();
  await held.sync({ paths: ['b.ts'] });
  expect(held.searchNodes('missedAfterRebuild')).toHaveLength(1);
  expect(held.searchNodes('latestEvent')).toHaveLength(1);
  const live = CodeGraph.openSync(root);
  connections.push(live);
  expect(live.searchNodes('missedAfterRebuild')).toHaveLength(1);
  expect(live.searchNodes('latestEvent')).toHaveLength(1);
});

it.runIf(process.platform !== 'win32')('retains the full reconcile requirement after a query reopens the handle', async () => {
  const held = await replaced();
  expect(held.reopenIfReplaced()).toBe(true);
  await held.sync({ paths: ['b.ts'] });
  expect(held.searchNodes('missedAfterRebuild')).toHaveLength(1);
});

it.runIf(process.platform !== 'win32')('the first MCP query after replacement catches up before answering', async () => {
  const held = await replaced();
  const result = await new ToolHandler(held).execute('codegraph_search', { query: 'missedAfterRebuild' });
  expect(result.isError).not.toBe(true);
  expect(held.searchNodes('missedAfterRebuild')).toHaveLength(1);
});

it.runIf(process.platform !== 'win32')('a real watcher writes to the replacement without an MCP query', async () => {
  const held = await replaced();
  expect(held.watch({ debounceMs: 30 })).toBe(true);
  fs.writeFileSync(path.join(root, 'b.ts'), 'export function watcherEvent() { return 444; }');
  await vi.waitFor(() => expect(held.searchNodes('watcherEvent')).toHaveLength(1), { timeout: 5000 });
  expect(held.searchNodes('missedAfterRebuild')).toHaveLength(1);
  const live = CodeGraph.openSync(root);
  connections.push(live);
  expect(live.searchNodes('watcherEvent')).toHaveLength(1);
  expect(live.searchNodes('missedAfterRebuild')).toHaveLength(1);
});

it.runIf(process.platform !== 'win32')('retries a full reconcile after the writer lock prevented catch-up', async () => {
  const held = await replaced();
  expect(held.reopenIfReplaced()).toBe(true);
  const lock = path.join(root, '.codegraph/codegraph.lock');
  fs.writeFileSync(lock, String(process.pid), { flag: 'wx' });
  try {
    const response = await new ToolHandler(held).execute('codegraph_search', { query: 'missedAfterRebuild' });
    expect(response.isError).not.toBe(true);
    expect(response.content[0]?.text).toContain('catch-up is not complete');
  }
  finally { fs.unlinkSync(lock); }
  await held.sync({ paths: ['b.ts'] });
  expect(held.searchNodes('missedAfterRebuild')).toHaveLength(1);
});

it.runIf(process.platform !== 'win32').each([1, 5, 20])('shares one recovery across %i concurrent MCP calls', async count => {
  const held = await replaced();
  const spy = vi.spyOn(held, 'sync');
  const handler = new ToolHandler(held);
  const responses = await Promise.all(Array.from({ length: count }, () => handler.execute('codegraph_search', { query: 'missedAfterRebuild' })));
  expect(responses.every(r => !r.isError)).toBe(true);
  expect(spy).toHaveBeenCalledTimes(1);
  expect(held.searchNodes('missedAfterRebuild')).toHaveLength(1);
});

it.runIf(process.platform !== 'win32')('status reports pending recovery without starting a full scan', async () => {
  const held = await replaced();
  const spy = vi.spyOn(held, 'sync');
  const result = await new ToolHandler(held).execute('codegraph_status', {});
  expect(result.isError).not.toBe(true);
  expect(result.content[0]?.text).toContain('catch-up is not complete');
  expect(spy).not.toHaveBeenCalled();
  expect(await held.syncIfReplaced()).toBe(true);
});

it.runIf(process.platform !== 'win32')('does not mark a second replacement current while recovering the first', async () => {
  const held = await replaced();
  held.reopenIfReplaced();
  const orchestrator = (held as any).orchestrator;
  const original = orchestrator.sync.bind(orchestrator);
  vi.spyOn(orchestrator, 'sync').mockImplementationOnce(async (...args: unknown[]) => {
    const replacement = await CodeGraph.recreate(root);
    replacement.close();
    return original(...args);
  });
  expect(await held.syncIfReplaced()).toBe(false);
  expect(await held.syncIfReplaced()).toBe(true);
  expect(held.searchNodes('missedAfterRebuild')).toHaveLength(1);
  expect(held.searchNodes('latestEvent')).toHaveLength(1);
});

it.runIf(process.platform !== 'win32')('releases the lock and retries after a failed recovery', async () => {
  const held = await replaced();
  held.reopenIfReplaced();
  vi.spyOn((held as any).orchestrator, 'sync').mockRejectedValueOnce(new Error('injected read failure'));
  await expect(held.syncIfReplaced()).rejects.toThrow('injected read failure');
  expect(fs.existsSync(path.join(root, '.codegraph/codegraph.lock'))).toBe(false);
  expect(await held.syncIfReplaced()).toBe(true);
  expect(held.searchNodes('missedAfterRebuild')).toHaveLength(1);
});
