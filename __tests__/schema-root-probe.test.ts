import { afterEach, beforeEach, expect, it } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { isInitialized, resolveServerRoot, IndexUnavailableError } from '../src/directory';
import { DatabaseConnection } from '../src/db';
import { createDatabase } from '../src/db/sqlite-adapter';
import { ToolHandler } from '../src/mcp/tools';

let root: string;
beforeEach(() => { root = fs.mkdtempSync(path.join(os.tmpdir(), 'cg-1895-')); });
afterEach(() => fs.rmSync(root, { recursive: true, force: true }));

function dbPath(dir: string) {
  fs.mkdirSync(path.join(dir, '.codegraph'), { recursive: true });
  return path.join(dir, '.codegraph/codegraph.db');
}

it.each(['empty', 'sqlite', 'garbage', 'directory'])('rejects an unusable %s database without repairing it', kind => {
  const file = dbPath(root);
  if (kind === 'directory') fs.mkdirSync(file);
  else if (kind === 'sqlite') {
    const { db } = createDatabase(file);
    db.exec('CREATE TABLE unrelated (x);');
    db.close();
  } else fs.writeFileSync(file, kind === 'empty' ? '' : 'not a database');
  const before = kind === 'directory' ? null : fs.readFileSync(file);
  expect(isInitialized(root)).toBe(false);
  if (before) expect(fs.readFileSync(file)).toEqual(before);
});

it('finds a real subproject past an unusable ancestor', () => {
  const ws = path.join(root, 'ws');
  const sub = path.join(ws, 'sub');
  fs.mkdirSync(path.join(ws, '.git'), { recursive: true });
  DatabaseConnection.initialize(dbPath(sub)).close();
  fs.writeFileSync(dbPath(root), '');
  expect(resolveServerRoot(ws)).toEqual({ root: sub, viaSubScan: true, candidates: [sub] });
});

it('recognizes a live WAL schema and a subsequently replaced empty database', () => {
  const file = dbPath(root);
  const conn = DatabaseConnection.initialize(file);
  try { expect(isInitialized(root)).toBe(true); } finally { conn.close(); }
  fs.writeFileSync(file, '');
  expect(isInitialized(root)).toBe(false);
  DatabaseConnection.initialize(file).close();
  expect(isInitialized(root)).toBe(true);
});

it('never falls back to a parent when the nearest schema is locked', async () => {
  const sub = path.join(root, 'sub');
  DatabaseConnection.initialize(dbPath(root)).close();
  DatabaseConnection.initialize(dbPath(sub)).close();
  const { db } = createDatabase(dbPath(sub));
  try {
    db.exec('PRAGMA journal_mode=DELETE; BEGIN EXCLUSIVE');
    expect(() => isInitialized(sub)).toThrow(IndexUnavailableError);
    expect(() => resolveServerRoot(sub)).toThrow(IndexUnavailableError);
    const result = await new ToolHandler(null).execute('codegraph_search', { projectPath: sub, query: 'anything' });
    expect(result.isError).not.toBe(true);
    expect(result.content[0]?.text).toContain('No parent index was selected');
    db.exec('ROLLBACK');
    expect(resolveServerRoot(sub).root).toBe(sub);
  } finally { db.close(); }
});
