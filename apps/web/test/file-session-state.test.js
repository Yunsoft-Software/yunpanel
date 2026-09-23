import assert from 'node:assert/strict';
import test from 'node:test';
import { EMPTY_FILE_SESSION, fileEditorDirty, fileSessionKey, reconcileFileSession, updateFileSession } from '../src/workspace/file-session-state.js';
import { resolveSiteFilesAccess } from '../src/workspace/site-files-access.js';

const website = Object.freeze({ id: 'site-a', serverId: 'server-a', runtimeType: 'php' });
const domain = Object.freeze({ id: 'domain-a', websiteId: website.id, serverId: website.serverId });
const ready = (items) => ({ status: 'ready', items });
const input = (extra = {}) => ({ domainId: domain.id, canManage: true, domains: ready([domain]), websites: ready([website]), ...extra });
const editor = Object.freeze({ name: 'index.php', path: 'public/index.php', content: 'new text', saved: 'old text', sha256: 'a'.repeat(64) });
function draft() {
  let state = reconcileFileSession(undefined, input());
  const key = fileSessionKey(state.binding);
  state = updateFileSession(state, key, 'path', 'public');
  return updateFileSession(state, key, 'editor', editor);
}

test('fresh verified context starts empty and a repeated context keeps the exact state', () => {
  const state = reconcileFileSession(undefined, input());
  assert.deepEqual(state, { binding: { domainId: domain.id, websiteId: website.id, serverId: website.serverId, runtimeType: website.runtimeType }, path: '', editor: null });
  assert.equal(reconcileFileSession(state, input()), state);
  assert.equal(reconcileFileSession(), EMPTY_FILE_SESSION);
});
for (const status of ['idle', 'loading', 'refreshing', 'stale', 'error']) {
  test(`${status} retains only existing state while Files access remains unavailable`, () => {
    const state = draft();
    for (const side of ['domains', 'websites']) {
      const nextInput = input({ [side]: { status, items: [] } });
      assert.equal(reconcileFileSession(state, nextInput), state);
      assert.equal(resolveSiteFilesAccess(nextInput).state, 'unavailable');
      assert.equal(reconcileFileSession(undefined, nextInput), EMPTY_FILE_SESSION);
    }
    assert.equal(reconcileFileSession(state, input({ domains: { status }, websites: { status } })), state);
  });
}
for (const status of ['forbidden', 'unauthorized', 'unknown', undefined]) {
  test(`${status} clears retained state on either collection`, () => {
    for (const side of ['domains', 'websites']) {
      assert.equal(reconcileFileSession(draft(), input({ [side]: { status, items: [] } })), EMPTY_FILE_SESSION);
    }
  });
}
test('loss of capability discards an otherwise valid editor', () => {
  assert.equal(reconcileFileSession(draft(), input({ canManage: false })), EMPTY_FILE_SESSION);
});
for (const changed of [
  { domainId: 'domain-b' },
  { domains: ready([]) },
  { domains: ready([domain, domain]) },
  { domains: ready([{ ...domain, websiteId: null }]) },
  { websites: ready([]) },
  { websites: ready([website, website]) },
  { websites: ready([{ ...website, serverId: 'other-server' }]) },
  { websites: ready([{ ...website, runtimeType: 'docker' }]) },
  { domains: ready(null) },
  { websites: ready({}) },
]) {
  test(`authoritative invalid context drops the old draft: ${JSON.stringify(changed)}`, () => {
    assert.equal(reconcileFileSession(draft(), input(changed)), EMPTY_FILE_SESSION);
  });
}
test('changing valid Website, server or runtime starts a new empty scope', () => {
  for (const [nextDomain, nextWebsite] of [
    [{ ...domain, websiteId: 'site-b' }, { ...website, id: 'site-b' }],
    [{ ...domain, serverId: 'server-b' }, { ...website, serverId: 'server-b' }],
    [domain, { ...website, runtimeType: 'node' }],
  ]) {
    const state = reconcileFileSession(draft(), input({ domains: ready([nextDomain]), websites: ready([nextWebsite]) }));
    assert.notEqual(state.binding, null);
    assert.equal(state.path, '');
    assert.equal(state.editor, null);
  }
});
test('a fresh side changing its binding invalidates the draft before the other side finishes', () => {
  const refreshing = { status: 'refreshing', items: [] };
  assert.equal(reconcileFileSession(draft(), input({ domains: ready([{ ...domain, websiteId: 'site-b' }]), websites: refreshing })), EMPTY_FILE_SESSION);
  assert.equal(reconcileFileSession(draft(), input({ domains: refreshing, websites: ready([{ ...website, runtimeType: 'node' }]) })), EMPTY_FILE_SESSION);
  assert.equal(reconcileFileSession(draft(), input({ domains: refreshing, websites: ready(null) })), EMPTY_FILE_SESSION);
});
test('return from refresh preserves content, original hash and remembered path without mutation', () => {
  const state = Object.freeze(draft());
  const waiting = reconcileFileSession(state, input({ domains: { status: 'refreshing' } }));
  const resumed = reconcileFileSession(waiting, input());
  assert.equal(resumed, state);
  assert.equal(resumed.editor, editor);
  assert.equal(resumed.editor.sha256, 'a'.repeat(64));
  assert.equal(resumed.path, 'public');
});
test('dirty state clears only when saved text matches or editor is explicitly closed', () => {
  const state = draft(); const key = fileSessionKey(state.binding);
  assert.equal(fileEditorDirty(state.editor), true);
  const saved = updateFileSession(state, key, 'editor', (current) => ({ ...current, saved: current.content, sha256: 'b'.repeat(64) }));
  assert.equal(fileEditorDirty(saved.editor), false);
  assert.equal(saved.path, 'public');
  assert.equal(updateFileSession(saved, key, 'editor', null).editor, null);
  assert.equal(fileEditorDirty(null), false);
  assert.equal(fileEditorDirty({}), false);
});
test('late updates cannot recreate invalidated or differently bound state', () => {
  const old = draft(); const key = fileSessionKey(old.binding);
  const next = reconcileFileSession(old, input({ websites: ready([{ ...website, runtimeType: 'node' }]) }));
  assert.equal(updateFileSession(next, key, 'editor', editor), next);
  assert.equal(updateFileSession(EMPTY_FILE_SESSION, key, 'editor', editor), EMPTY_FILE_SESSION);
});
for (const path of ['/etc', '../other', 'public/../other', 'public//x', 'public\\x', 'bad\0path', 123]) {
  test(`invalid remembered path is rejected: ${JSON.stringify(path)}`, () => {
    const state = draft();
    assert.equal(updateFileSession(state, fileSessionKey(state.binding), 'path', path), state);
  });
}
test('root, Unicode and hidden directories remain valid paths', () => {
  for (const path of ['', 'içerik/şablonlar', '.well-known/acme-challenge']) {
    const state = draft();
    assert.equal(updateFileSession(state, fileSessionKey(state.binding), 'path', path).path, path);
  }
});
test('malformed editors and arbitrary cache fields are rejected', () => {
  const state = draft(); const key = fileSessionKey(state.binding);
  for (const invalid of [{ ...editor, path: '../other' }, { ...editor, content: undefined }, { ...editor, sha256: 'broken' }, { ...editor, saved: undefined }, { ...editor, path: '' }]) {
    assert.equal(updateFileSession(state, key, 'editor', invalid), state);
  }
  assert.equal(updateFileSession(state, key, 'entries', ['not cached']), state);
});
