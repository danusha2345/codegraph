import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { CodeGraph } from '../src';

let root = '';
let cg: CodeGraph;

beforeAll(async () => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'cg-rust-use-call-'));
  const files: Record<string, string> = {
    'Cargo.toml': '[package]\nname = "app"\nversion = "0.1.0"\nedition = "2021"\n\n[dependencies]\nexternal = "1"\n',
    'src/lib.rs': 'pub mod a;\npub mod util;\npub mod caller;\npub mod child;\npub mod api;\npub mod method_only;\npub fn root_take() {}\npub enum Root { RootGood(i32) }\n',
    'src/a.rs': 'pub fn take() {}\npub fn consume() {}\npub fn selected() {}\npub enum Noise { take }\n',
    'src/util.rs': `pub struct Buf;
impl Buf { pub fn take(&self) {} }
pub fn outer() {
    fn take() {}
    take();
}
pub fn take() {}
`,
    'src/api.rs': 'pub use crate::util::take;\n',
    'src/method_only.rs': 'pub struct Buf;\nimpl Buf { pub fn take(&self) {} }\n',
    'src/caller.rs': `use crate::util::take;
pub fn imported() { take(); }
pub fn shadowed() {
    fn take() {}
    take();
}
pub fn parameter(take: fn()) { take(); }
pub fn destructured((take, _): (fn(), i32)) { take(); }
pub fn type_label(callback: fn(take: i32)) { take(); }
pub fn generic<T: Fn(i32)>(callback: T) { take(); }
pub fn after_binding() {
    take();
    let take = || {};
    take();
}
`,
    'src/alias.rs': `use crate::util::take as consume;
pub fn aliased() { consume(); }
`,
    'src/group.rs': `use crate::{util::{take as selected}, a::{take as other}};
pub fn grouped() { selected(); }
pub fn second() { other(); }
`,
    'src/child/mod.rs': `use super::util::take;
use self::util::take as local_take;
pub fn parent() { take(); }
pub fn child() { local_take(); }
`,
    'src/child/util.rs': 'pub fn take() {}\n',
    'src/scoped.rs': `pub fn first() {
    use crate::util::take;
    take();
}
pub fn second() {
    use crate::a::take;
    take();
}
`,
    'src/outer_shadow.rs': `fn take() {}
pub fn imported_in_block() {
    use crate::util::take;
    take();
}
pub fn inner_import(take: fn()) {
    {
        use crate::util::take;
        take();
    }
}
pub fn before_binding() {
    use crate::util::take;
    take();
    let take = || {};
}
`,
    'src/ambiguous.rs': `use crate::util::take;
use crate::a::take;
pub fn ambiguous() { take(); }
`,
    'src/missing.rs': 'use crate::missing::take;\npub fn missing() { take(); }\n',
    'src/method_caller.rs': 'use crate::method_only::take;\npub fn invalid() { take(); }\n',
    'src/reexport.rs': 'use crate::api::take;\npub fn reexported() { take(); }\n',
    'src/external.rs': 'use external::take as consume;\npub fn external_call() { consume(); }\n',
    'src/models.rs': 'pub enum E { Good(i32) }\n',
    'src/model_decoy.rs': 'pub enum E { Real(i32) }\nmod hidden { pub enum E { Good(i32) } }\n',
    'src/model_decoy_call.rs': 'use crate::model_decoy::E::Good;\npub fn model_decoy() { Good(1); }\n',
    'src/variant.rs': 'use crate::models::E::Good;\npub fn variant() { Good(1); }\n',
    'src/variant_alias.rs': 'use crate::models::E::Good as Build;\npub fn alias_variant() { Build(1); }\n',
    'src/root_call.rs': 'use crate::root_take as consume;\npub fn root_call() { consume(); }\n',
    'src/root_variant.rs': 'use crate::Root::RootGood;\npub fn root_variant() { RootGood(1); }\n',
    'src/same_file.rs': 'fn same_take() {}\nuse self::same_take as consume;\npub fn same_file() { consume(); }\n',
    'src/inline_only.rs': 'mod hidden { pub fn lone() {} }\nuse self::lone as nonexistent;\npub fn inline_only() { nonexistent(); }\n',
    'src/duplicate.rs': '#[cfg(unix)]\npub fn take() {}\n#[cfg(windows)]\npub fn take() {}\n',
    'src/duplicate_call.rs': 'use crate::duplicate::take;\npub fn duplicate_call() { take(); }\n',
    'tests/bad_inline.rs': 'mod hidden { mod support { pub mod panic; } }\nuse support::panic::test_panic;\npub fn bad_inline() { test_panic(); }\n',
    'tests/support/panic.rs': 'pub fn test_panic() {}\n',
    'src/sync.rs': 'use crate::a::take;\npub fn synced() { take(); }\n',
    'src/unicode.rs': 'use crate::util::take;\npub fn unicode() { let crab = "🦀Я"; take(); }\n',
    'src/unicode_scoped.rs': 'pub fn unicode_scoped() { let crab = "🦀Я"; { use crate::util::take as consume; consume(); } }\n',
    'crates/one/Cargo.toml': '[package]\nname = "one"\nversion = "0.1.0"\n',
    'crates/one/src/lib.rs': 'pub mod util;\n',
    'crates/one/src/util.rs': 'pub fn take() {}\n',
    'crates/two/Cargo.toml': '[package]\nname = "two"\nversion = "0.1.0"\n',
    'crates/two/src/lib.rs': 'pub mod util;\npub mod caller;\n',
    'crates/two/src/util.rs': 'pub fn take() {}\n',
    'crates/two/src/caller.rs': 'use crate::util::take;\npub fn workspace_call() { take(); }\n',
  };
  for (const [relative, content] of Object.entries(files)) {
    fs.mkdirSync(path.dirname(path.join(root, relative)), { recursive: true });
    fs.writeFileSync(path.join(root, relative), content);
  }
  cg = await CodeGraph.init(root, { index: true });
});

afterAll(() => {
  cg?.close();
  if (root) fs.rmSync(root, { recursive: true, force: true });
});

const calls = (file: string, name: string) => {
  const caller = cg.getNodesInFile(file).find((n) => n.name === name && n.kind === 'function');
  expect(caller).toBeDefined();
  return cg.getOutgoingEdgesFrom([caller!.id]).filter((e) => e.kind === 'calls')
    .map((e) => cg.getNode(e.target)!)
    .map((n) => `${n.kind} ${n.qualifiedName} ${n.filePath}:${n.startLine}`);
};

const take = 'function take src/util.rs:7';

describe('Rust bare calls bound by use', () => {
  it('chooses the imported free function among same-name methods and functions', () => {
    expect(calls('src/caller.rs', 'imported')).toEqual([take]);
  });

  it('follows an alias even when no declaration carries its local name', () => {
    expect(calls('src/alias.rs', 'aliased')).toEqual([take]);
    expect(calls('src/group.rs', 'grouped')).toEqual([take]);
    expect(calls('src/group.rs', 'second')).toEqual(['function take src/a.rs:1']);
  });

  it('anchors self and super imports on the current module', () => {
    expect(calls('src/child/mod.rs', 'parent')).toEqual([take]);
    expect(calls('src/child/mod.rs', 'child')).toEqual(['function take src/child/util.rs:1']);
  });

  it('keeps block-local imports in their own scopes', () => {
    expect(calls('src/scoped.rs', 'first')).toEqual([take]);
    expect(calls('src/scoped.rs', 'second')).toEqual(['function take src/a.rs:1']);
  });

  it('does not replace a local function or parameter with an imported function', () => {
    expect(calls('src/caller.rs', 'shadowed')).toEqual(['function shadowed::take src/caller.rs:4']);
    expect(calls('src/caller.rs', 'parameter')).toEqual([]);
    expect(calls('src/caller.rs', 'destructured')).toEqual([]);
    expect(calls('src/caller.rs', 'type_label')).toEqual([take]);
    expect(calls('src/caller.rs', 'generic')).toEqual([take]);
    expect(calls('src/caller.rs', 'after_binding')).toEqual([take]);
  });

  it('lets a closer use shadow an outer declaration, and ignores later let bindings', () => {
    expect(calls('src/outer_shadow.rs', 'imported_in_block')).toEqual([take]);
    expect(calls('src/outer_shadow.rs', 'inner_import')).toEqual([take]);
    expect(calls('src/outer_shadow.rs', 'before_binding')).toEqual([take]);
  });

  it('does not guess when the binding conflicts or its function is unavailable', () => {
    expect(calls('src/ambiguous.rs', 'ambiguous')).toEqual([]);
    expect(calls('src/missing.rs', 'missing')).toEqual([]);
    expect(calls('src/method_caller.rs', 'invalid')).toEqual([]);
    expect(calls('src/external.rs', 'external_call')).toEqual([]);
    expect(calls('src/duplicate_call.rs', 'duplicate_call')).toEqual([]);
    expect(calls('tests/bad_inline.rs', 'bad_inline')).toEqual([]);
    expect(calls('src/inline_only.rs', 'inline_only')).toEqual([]);
    expect(calls('src/model_decoy_call.rs', 'model_decoy')).toEqual([]);
  });

  it('does not guess through an unsupported re-export', () => {
    expect(calls('src/reexport.rs', 'reexported')).toEqual([]);
  });

  it('keeps a variant attached to its imported enum, including a renamed variant', () => {
    expect(calls('src/variant.rs', 'variant')).toEqual(['enum_member E::Good src/models.rs:1']);
    expect(calls('src/variant_alias.rs', 'alias_variant')).toEqual(['enum_member E::Good src/models.rs:1']);
    expect(calls('src/root_variant.rs', 'root_variant')).toEqual(['enum_member Root::RootGood src/lib.rs:8']);
  });

  it('binds crate-root functions and same-file aliases', () => {
    expect(calls('src/root_call.rs', 'root_call')).toEqual(['function root_take src/lib.rs:7']);
    expect(calls('src/same_file.rs', 'same_file')).toEqual(['function same_take src/same_file.rs:1']);
  });

  it('uses UTF-16 source columns after Cyrillic and emoji on the call line', () => {
    expect(calls('src/unicode.rs', 'unicode')).toEqual([take]);
    expect(calls('src/unicode_scoped.rs', 'unicode_scoped')).toEqual([take]);
  });

  it('resolves crate relative to the caller rather than another package', () => {
    expect(calls('crates/two/src/caller.rs', 'workspace_call'))
      .toEqual(['function take crates/two/src/util.rs:1']);
  });

  it('refreshes the exact binding after a source edit and sync', async () => {
    expect(calls('src/sync.rs', 'synced')).toEqual(['function take src/a.rs:1']);
    fs.writeFileSync(path.join(root, 'src/sync.rs'), 'use crate::util::take;\npub fn synced() { take(); }\n');
    await cg.sync();
    expect(calls('src/sync.rs', 'synced')).toEqual([take]);
  });
});
