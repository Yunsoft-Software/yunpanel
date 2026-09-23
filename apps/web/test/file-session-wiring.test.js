import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

// Source wiring checks, not React render/browser acceptance.
const source = (name) => readFile(new URL(`../src/workspace/${name}`, import.meta.url), 'utf8');
const [entry, session, files, state] = await Promise.all([
  source('SiteFilesPanel.jsx'), source('FileWorkspaceSession.jsx'), source('FilesPanel.jsx'), source('file-session-state.js'),
]);
test('outer memory scope changes with Domain, user, role, session generation and management capability', () => {
  assert.match(entry, /JSON\.stringify\(\[domainId, session\?\.user\?\.id, session\?\.user\?\.role, sessionVersion\(\), canManage\]\)/);
  assert.match(entry, /<FileWorkspaceSession key=\{identity\} input=\{input\}>/);
});
test('stale inventories still unmount the real FilesPanel without removing its memory provider', () => {
  assert.match(entry, /<FileWorkspaceSession[\s\S]*<SiteFilesContent[\s\S]*<\/FileWorkspaceSession>/);
  assert.match(entry, /if \(access.state === 'ready'\) return <FilesPanel key=\{access.website.id\}/);
  assert.match(entry, /websiteId=\{access.website.id\}/);
  assert.match(entry, /access.state === 'unbound' && legacyRepair/);
});
test('initial path remains fixed for one child mount and callbacks stay binding scoped', () => {
  assert.match(session, /const initialPath = useRef\(matching \? shared.path : ''\).current;/);
  assert.match(session, /updateFileSession\(current, key, 'path', path\)\), \[key\]\)/);
  assert.match(session, /updateFileSession\(current, key, 'editor', update\)\), \[key\]\)/);
});
test('only a validated current listing updates the remembered path and failed resume does not fall back to root', () => {
  const validation = files.indexOf('const items = fileListing(result, nextPath);');
  const fence = files.indexOf('if (!alive.current || current !== generation.current) return;', validation);
  const remember = files.indexOf('rememberPath(nextPath);');
  assert.ok(validation >= 0 && fence > validation && remember > fence);
  assert.match(files, /useState\(\{ path: initialPath,/);
  assert.match(files, /void load\(initialPath\)/);
  assert.doesNotMatch(files, /void load\(''\)/);
});
test('draft navigation registration survives a transient child unmount', () => {
  assert.match(session, /const dirty = fileEditorDirty\(state.editor\);\s+useUnsavedChanges\(dirty\);/);
  assert.match(session, /waiting && dirty && <p[^>]*role="status"/);
  assert.match(session, /useUnsavedChanges\(!matching && fileEditorDirty\(localEditor\)\)/);
});
test('save keeps the original optimistic hash and explicit discard still clears the editor', () => {
  assert.match(files, /expectedSha256: current.sha256/);
  assert.match(files, /sha256: result.sha256, saved: current.content/);
  assert.match(files, /setDiscard\(false\); setEditor\(null\); setError\(null\);/);
  assert.match(files, /if \(pending.current \|\| !canManage\) return;/);
});
test('binding changes remount pending file work and missing provider never looks like a match', () => {
  assert.match(files, /key=\{`\$\{websiteId\}:\$\{serverId\}:\$\{runtimeType\}`\}/);
  assert.match(session, /const matching = Boolean\(shared\?\.binding && shared.binding.websiteId === websiteId/);
  assert.match(files, /alive.current = false; generation.current\+\+; read.current\?\.abort\(\)/);
});
test('memory plumbing adds no storage, network mutations or automatic operation replay', () => {
  for (const content of [entry, session, state]) {
    assert.doesNotMatch(content, /localStorage|sessionStorage|indexedDB|panelRequest|uploadSiteFile|fetch\(|console\./);
  }
  assert.match(files, /const \[upload, setUpload\] = useState\(null\)/);
  assert.match(files, /const \[dialog, setDialog\] = useState\(null\)/);
  assert.match(files, /method: 'DELETE'/);
  assert.match(files, /batch-delete/);
  assert.match(files, /uploadSiteFile\(websiteId/);
});
