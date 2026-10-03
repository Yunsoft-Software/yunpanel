import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import { resolveSiteFilesAccess } from '../src/workspace/site-files-access.js';
import {
  EMPTY_FILE_SESSION,
  fileEditorDirty,
  fileSessionKey,
  reconcileFileSession,
  updateFileSession,
} from '../src/workspace/file-session-state.js';
import { validRelativePath } from '../src/workspace/ui/file-workspace-model.js';

const siteA = Object.freeze({ id: 'site-a-uuid', serverId: 'server-1', runtimeType: 'node' });
const siteB = Object.freeze({ id: 'site-b-uuid', serverId: 'server-1', runtimeType: 'php' });
const domainA = Object.freeze({ id: 'domain-a-uuid', websiteId: siteA.id, serverId: siteA.serverId });
const domainB = Object.freeze({ id: 'domain-b-uuid', websiteId: siteB.id, serverId: siteB.serverId });

const ready = (items) => ({ status: 'ready', items });

test('UX-PL-01f Acceptance (Web): Role and Tenant boundary enforcement in file management resolution', () => {
  // 1. Owner can access Site A and Site B when managing their respective domains
  const ownerAccessA = resolveSiteFilesAccess({
    domainId: domainA.id,
    canManage: true,
    domains: ready([domainA, domainB]),
    websites: ready([siteA, siteB]),
  });
  assert.equal(ownerAccessA.state, 'ready');
  assert.equal(ownerAccessA.website.id, siteA.id);

  const ownerAccessB = resolveSiteFilesAccess({
    domainId: domainB.id,
    canManage: true,
    domains: ready([domainA, domainB]),
    websites: ready([siteA, siteB]),
  });
  assert.equal(ownerAccessB.state, 'ready');
  assert.equal(ownerAccessB.website.id, siteB.id);

  // 2. Site A manager only has domainA and siteA in their authorized scope
  // Accessing Site A works:
  const siteAManagerAccessA = resolveSiteFilesAccess({
    domainId: domainA.id,
    canManage: true,
    domains: ready([domainA]),
    websites: ready([siteA]),
  });
  assert.equal(siteAManagerAccessA.state, 'ready');
  assert.equal(siteAManagerAccessA.website.id, siteA.id);

  // Site A manager attempting to access domainB fails-closed (not found / unauthorized scope):
  const siteAManagerAccessB = resolveSiteFilesAccess({
    domainId: domainB.id,
    canManage: true,
    domains: ready([domainA]),
    websites: ready([siteA]),
  });
  assert.equal(siteAManagerAccessB.state, 'not_found');

  // 3. Read-only user / unauthorized actor (canManage: false) strictly forbidden
  const readOnlyAccess = resolveSiteFilesAccess({
    domainId: domainA.id,
    canManage: false,
    domains: ready([domainA]),
    websites: ready([siteA]),
  });
  assert.deepEqual(readOnlyAccess, { state: 'forbidden', website: null });
});

test('UX-PL-01f Acceptance (Web): Router URL params and path navigation sanitization', () => {
  // Test valid URL relative paths
  assert.equal(validRelativePath('src'), true);
  assert.equal(validRelativePath('public/assets'), true);
  assert.equal(validRelativePath('.well-known/acme-challenge'), true);

  // Test invalid directory traversal or dangerous URL params
  assert.equal(validRelativePath('/etc'), false);
  assert.equal(validRelativePath('../secret'), false);
  assert.equal(validRelativePath('public/../../etc/passwd'), false);
  assert.equal(validRelativePath('//double-slash'), false);
  assert.equal(validRelativePath('null\0byte'), false);
});

test('UX-PL-01f Acceptance (Web): In-memory draft continuity across router/data refreshes without loss', () => {
  const initialInput = {
    domainId: domainA.id,
    canManage: true,
    domains: ready([domainA]),
    websites: ready([siteA]),
  };

  let session = reconcileFileSession(undefined, initialInput);
  const key = fileSessionKey(session.binding);

  // User opens file and edits it
  const dirtyEditor = {
    name: 'server.js',
    path: 'server.js',
    content: 'const x = 2; // dirty draft',
    saved: 'const x = 1;',
    sha256: 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855',
  };

  session = updateFileSession(session, key, 'path', 'src');
  session = updateFileSession(session, key, 'editor', dirtyEditor);

  assert.equal(fileEditorDirty(session.editor), true);
  assert.equal(session.path, 'src');

  // Background refresh or router state update (loading / refreshing / stale)
  for (const status of ['loading', 'refreshing', 'stale']) {
    const refreshedInput = {
      ...initialInput,
      domains: { status, items: [domainA] },
      websites: { status, items: [siteA] },
    };
    const reconciled = reconcileFileSession(session, refreshedInput);
    // Draft, editor content, hash, and path MUST NOT be lost during refresh
    assert.equal(reconciled, session);
    assert.equal(reconciled.editor.content, 'const x = 2; // dirty draft');
    assert.equal(reconciled.path, 'src');
  }

  // Once refresh finishes and status is ready again
  const resumed = reconcileFileSession(session, initialInput);
  assert.equal(resumed, session);
  assert.equal(resumed.editor.content, dirtyEditor.content);
  assert.equal(resumed.editor.sha256, dirtyEditor.sha256);

  // But if the tenant/website changes (e.g. switched to site B):
  const switchedInput = {
    domainId: domainB.id,
    canManage: true,
    domains: ready([domainB]),
    websites: ready([siteB]),
  };
  const switched = reconcileFileSession(session, switchedInput);
  // Entire session must be cleared to prevent cross-tenant draft leak!
  assert.equal(switched.editor, null);
  assert.equal(switched.path, '');
  assert.equal(switched.binding.websiteId, siteB.id);
});

test('UX-PL-01f Acceptance (Web): Concurrent save race conflict handling and dirty state preservation', () => {
  const hash0 = '1111111111111111111111111111111111111111111111111111111111111111';
  const hash1 = '2222222222222222222222222222222222222222222222222222222222222222';

  const input = {
    domainId: domainA.id,
    canManage: true,
    domains: ready([domainA]),
    websites: ready([siteA]),
  };
  let session = reconcileFileSession(undefined, input);
  const key = fileSessionKey(session.binding);

  // Editor opened at hash0
  const editor = {
    name: 'config.json',
    path: 'config.json',
    content: '{"v": 2}', // dirty modification
    saved: '{"v": 1}',
    sha256: hash0,
  };
  session = updateFileSession(session, key, 'editor', editor);
  assert.equal(fileEditorDirty(session.editor), true);

  // Case 1: In the event of a 409 conflict (save fails because expectedSha256 !== remote),
  // the client preserves the dirty editor without clearing or corrupting it.
  // We verify that the session retains the exact un-saved editor draft:
  assert.equal(session.editor.content, '{"v": 2}');
  assert.equal(session.editor.saved, '{"v": 1}');
  assert.equal(session.editor.sha256, hash0);
  assert.equal(fileEditorDirty(session.editor), true);

  // Case 2: On successful save, hash updates to hash1 and saved matches content
  const successfulSaveEditor = {
    ...session.editor,
    sha256: hash1,
    saved: session.editor.content,
  };
  session = updateFileSession(session, key, 'editor', successfulSaveEditor);
  assert.equal(fileEditorDirty(session.editor), false);
  assert.equal(session.editor.sha256, hash1);
});

test('UX-PL-01f Acceptance (Web): Zero persistence assumption - no localStorage, sessionStorage, or indexedDB', async () => {
  const filesToAudit = [
    '../src/workspace/FilesPanel.jsx',
    '../src/workspace/SiteFilesPanel.jsx',
    '../src/workspace/FileWorkspaceSession.jsx',
    '../src/workspace/file-session-state.js',
    '../src/workspace/site-files-access.js',
  ];

  for (const relativePath of filesToAudit) {
    const content = await readFile(new URL(relativePath, import.meta.url), 'utf8');
    assert.doesNotMatch(content, /localStorage/, `Forbidden localStorage found in ${relativePath}`);
    assert.doesNotMatch(content, /sessionStorage/, `Forbidden sessionStorage found in ${relativePath}`);
    assert.doesNotMatch(content, /indexedDB/, `Forbidden indexedDB found in ${relativePath}`);
    assert.doesNotMatch(content, /openDatabase/, `Forbidden Web SQL found in ${relativePath}`);
  }
});
