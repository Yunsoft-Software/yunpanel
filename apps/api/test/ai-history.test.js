import assert from 'node:assert/strict';
import { chmod, mkdir, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { createAiConversationService, AiConversationError } from '../src/ai-conversation-service.js';
import { mountAiRoutes } from '../src/ai-http.js';
import { conversationScope, createConversationPager } from '../src/ai-conversation-history.js';
import { createProcessStoreLock } from '../src/process-store-lock.js';

const siteA = '11111111-1111-4111-8111-111111111111';
const siteB = '22222222-2222-4222-8222-222222222222';
const authOwner = (id = 'owner-a') => ({
  user: { id, role: 'owner', active: true },
  access: { mode: 'management', permissions: ['*'] },
  security: { managementAllowed: true },
});
const authManager = (id = 'manager-a', websiteIds = [siteA]) => ({
  user: { id, role: 'site_manager', websiteIds, active: true },
  access: { mode: 'site_management' },
  security: { managementAllowed: true },
});

test('unowned conversations migration and rollback preserve 0600 V1 backup, V2 ownership and avoid silent pruning', async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'ai-history-test-'));
  const filePath = path.join(dir, 'conversations.json');
  try {
    const legacy1 = {
      id: '33333333-3333-4333-8333-111111111111',
      title: 'Legacy Chat 1',
      websiteId: siteA,
      messages: [{ role: 'user', text: 'help with legacy site' }],
      createdAt: '2026-09-20T00:00:00.000Z',
      updatedAt: '2026-09-20T00:00:00.000Z',
    };
    const legacy2 = {
      id: '33333333-3333-4333-8333-222222222222',
      title: 'Legacy Chat 2',
      websiteId: siteB,
      messages: [{ role: 'user', text: 'dns setup' }],
      createdAt: '2026-09-21T00:00:00.000Z',
      updatedAt: '2026-09-21T00:00:00.000Z',
    };
    const v1Content = JSON.stringify({ version: 1, conversations: [legacy1, legacy2] });
    await writeFile(filePath, v1Content, { mode: 0o600 });

    const owner = authOwner('owner-1');
    const otherOwner = authOwner('owner-2');
    const manager = authManager('manager-1');

    const service = createAiConversationService({
      filePath,
      providerAdapter: { id: 'fixture-provider', defaultModel: 'fixture', complete: async () => ({ type: 'message', message: { text: 'reply' } }) },
      websiteRegistry: { getWebsite: async (id) => ({ id }) },
    });

    // 1. Unowned records are hidden from standard queries
    const pageBefore = await service.listConversationPage({ auth: owner });
    assert.equal(pageBefore.items.length, 0);
    assert.equal(pageBefore.legacyUnassigned, true);
    assert.equal(await service.getConversation(legacy1.id, { auth: owner }), null);

    // 2. Listing unowned conversations is Owner-only
    await assert.rejects(service.listUnownedConversations({ auth: manager }), { status: 403 });
    const unownedList = await service.listUnownedConversations({ auth: owner });
    assert.equal(unownedList.length, 2);
    assert.equal(unownedList[0].id, legacy2.id); // sorted by updatedAt desc

    // 3. Native V2 conversation creation creates .v1-backup with 0600 mode
    const v2Conv = await service.createConversation({ title: 'New V2 Chat', websiteId: siteA, auth: owner });
    const backupPath = `${filePath}.v1-backup`;
    assert.equal(await readFile(backupPath, 'utf8'), v1Content);
    assert.equal((await stat(backupPath)).mode & 0o777, 0o600);
    assert.equal((await stat(filePath)).mode & 0o777, 0o600);

    // 4. Migration to target actor
    await assert.rejects(service.migrateUnownedConversations({
      assignments: [{ conversationId: legacy1.id, targetActorId: 'owner-1' }],
      auth: manager,
    }), { status: 403 });

    const migrationResult = await service.migrateUnownedConversations({
      assignments: [{ conversationId: legacy1.id, targetActorId: 'owner-1' }],
      auth: owner,
    });
    assert.equal(migrationResult.count, 1);
    assert.equal(migrationResult.migrated[0].id, legacy1.id);
    assert.equal(migrationResult.migrated[0].title, 'Legacy Chat 1');

    // After migration, legacy1 is visible to owner-1, legacy2 remains unowned
    const conv1 = await service.getConversation(legacy1.id, { auth: owner });
    assert.ok(conv1);
    assert.equal(conv1.id, legacy1.id);
    assert.equal(await service.getConversation(legacy1.id, { auth: otherOwner }), null);

    const remainingUnowned = await service.listUnownedConversations({ auth: owner });
    assert.equal(remainingUnowned.length, 1);
    assert.equal(remainingUnowned[0].id, legacy2.id);

    // 5. Cannot re-migrate an already owned conversation
    await assert.rejects(service.migrateUnownedConversations({
      assignments: [{ conversationId: legacy1.id, targetActorId: 'owner-2' }],
      auth: owner,
    }), { code: 'conversation_already_owned', status: 409 });

    // 6. Capacity check: target actor reaching 100 limit fails with 409 without silent pruning
    const rawDisk = JSON.parse(await readFile(filePath, 'utf8'));
    const dummyConvs = Array.from({ length: 100 }, (_, i) => ({
      id: `44444444-4444-4444-8444-${String(i).padStart(12, '0')}`,
      actorId: 'owner-capped',
      title: `Bulk ${i}`,
      websiteId: siteA,
      messages: [],
      createdAt: '2026-09-22T00:00:00.000Z',
      updatedAt: '2026-09-22T00:00:00.000Z',
    }));
    rawDisk.conversations.push(...dummyConvs);
    await writeFile(filePath, JSON.stringify(rawDisk), { mode: 0o600 });

    const cappedService = createAiConversationService({ filePath, websiteRegistry: { getWebsite: async (id) => ({ id }) } });
    await assert.rejects(cappedService.migrateUnownedConversations({
      assignments: [{ conversationId: legacy2.id, targetActorId: 'owner-capped' }],
      auth: owner,
    }), { code: 'ai_conversation_limit', status: 409 });

    // Verify no silent pruning occurred
    const diskAfterAttempt = JSON.parse(await readFile(filePath, 'utf8'));
    assert.equal(diskAfterAttempt.conversations.length, rawDisk.conversations.length);

    // 7. Rollback specific conversation to unowned
    await assert.rejects(cappedService.rollbackUnownedConversations({
      conversationIds: [legacy1.id],
      auth: manager,
    }), { status: 403 });

    const rollbackResult = await cappedService.rollbackUnownedConversations({
      conversationIds: [legacy1.id],
      auth: owner,
    });
    assert.equal(rollbackResult.count, 1);
    assert.equal(rollbackResult.rolledBackIds[0], legacy1.id);
    assert.equal(await cappedService.getConversation(legacy1.id, { auth: owner }), null);

    // 8. Rollback to V1 backup: restores unowned legacy records while strictly preserving native V2 conversations
    const v1RollbackResult = await cappedService.rollbackToV1Backup({ auth: owner });
    assert.equal(v1RollbackResult.success, true);
    assert.equal(v1RollbackResult.restoredCount, 2);

    // V2 conversation remains intact with its actorId
    const preservedV2 = await cappedService.getConversation(v2Conv.id, { auth: owner });
    assert.ok(preservedV2);
    assert.equal(preservedV2.id, v2Conv.id);

    // Legacy records are back to unowned
    const unownedAfterV1Rollback = await cappedService.listUnownedConversations({ auth: owner });
    assert.equal(unownedAfterV1Rollback.some((c) => c.id === legacy1.id), true);
    assert.equal(unownedAfterV1Rollback.some((c) => c.id === legacy2.id), true);

    // 0600 permissions preserved
    assert.equal((await stat(backupPath)).mode & 0o777, 0o600);
    assert.equal((await stat(filePath)).mode & 0o777, 0o600);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('cross-process lock synchronization, crash recovery and error isolation', async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'ai-lock-test-'));
  const filePath = path.join(dir, 'conversations.json');
  try {
    const owner = authOwner('owner-lock');
    const service1 = createAiConversationService({
      filePath,
      websiteRegistry: { getWebsite: async (id) => ({ id }) },
    });
    const service2 = createAiConversationService({
      filePath,
      websiteRegistry: { getWebsite: async (id) => ({ id }) },
    });

    // Concurrent creation across two service instances sharing the same store file
    const c1 = await service1.createConversation({ title: 'Service 1 Chat', websiteId: siteA, auth: owner });
    const c2 = await service2.createConversation({ title: 'Service 2 Chat', websiteId: siteA, auth: owner });

    // Service 1 reads conversation created by Service 2 after disk reload
    const fetchedBy1 = await service1.getConversation(c2.id, { auth: owner });
    assert.ok(fetchedBy1);
    assert.equal(fetchedBy1.title, 'Service 2 Chat');

    // Stale lock crash recovery: simulate a dead process (ESRCH) holding the lock
    const lockPath = `${filePath}.lock`;
    const deadPid = 9999999;
    const fakeLock = JSON.stringify({
      version: 1,
      pid: deadPid,
      token: '11111111-1111-4111-8111-111111111111',
      createdAt: new Date().toISOString(),
    }) + '\n';
    await writeFile(lockPath, fakeLock, { mode: 0o600 });

    // Service with dead PID signal check recovers automatically and removes the dead lock
    const signalProcess = (pid) => {
      if (pid === deadPid) {
        const err = new Error('No such process');
        err.code = 'ESRCH';
        throw err;
      }
    };
    const recoveringService = createAiConversationService({
      filePath,
      signalProcess,
      websiteRegistry: { getWebsite: async (id) => ({ id }) },
    });
    const c3 = await recoveringService.createConversation({ title: 'Recovered Chat', websiteId: siteA, auth: owner });
    assert.ok(c3);
    assert.equal(c3.title, 'Recovered Chat');

    // Active lock timeout fails-closed: simulated living lock that does not yield
    const livingPid = process.pid;
    const activeLock = JSON.stringify({
      version: 1,
      pid: livingPid,
      token: '22222222-2222-4222-8222-222222222222',
      createdAt: new Date().toISOString(),
    }) + '\n';
    await writeFile(lockPath, activeLock, { mode: 0o600 });

    const timedOutService = createAiConversationService({
      filePath,
      storeLockFactory: ({ filePath: fp, now: n }) => {
        return createProcessStoreLock({ filePath: fp, now: n, waitMs: 50, retryMs: 10 });
      },
      websiteRegistry: { getWebsite: async (id) => ({ id }) },
    });
    await assert.rejects(timedOutService.createConversation({ title: 'Blocked', websiteId: siteA, auth: owner }), {
      code: 'ai_history_store_unavailable',
      status: 503,
    });
    await rm(lockPath, { force: true });
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('live authorization revocation during long provider call terminates fail-closed and prevents persisting messages', async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'ai-auth-test-'));
  const filePath = path.join(dir, 'conversations.json');
  try {
    const owner = authOwner('owner-auth');
    let sessionActive = true;
    let providerInvocationStarted = false;
    let providerAborted = false;

    const mockProvider = {
      id: 'fixture-provider',
      defaultModel: 'fixture',
      complete: async ({ signal }) => {
        providerInvocationStarted = true;
        return new Promise((resolve, reject) => {
          const timeout = setTimeout(() => {
            resolve({ type: 'message', message: { text: 'completed response' } });
          }, 200);

          if (signal) {
            signal.addEventListener('abort', () => {
              clearTimeout(timeout);
              providerAborted = true;
              const err = new Error('Provider aborted');
              err.name = 'AbortError';
              reject(err);
            });
          }
        });
      },
    };

    const authorizeActor = async () => {
      if (!sessionActive) {
        return { revoked: true, active: false };
      }
      return { active: true };
    };

    const service = createAiConversationService({
      filePath,
      providerAdapter: mockProvider,
      websiteRegistry: { getWebsite: async (id) => ({ id }) },
      authorizeActor,
    });

    const conv = await service.createConversation({ title: 'Live Auth Test', websiteId: siteA, auth: owner });

    // Start a long-running message and revoke authorization mid-flight
    const messagePromise = service.sendMessage({
      conversationId: conv.id,
      text: 'Long prompt requiring analysis',
      auth: owner,
    });

    let messageErr = null;
    messagePromise.catch((err) => { messageErr = err; });

    // Wait until provider starts, then revoke session immediately
    while (!providerInvocationStarted && !messageErr) {
      await new Promise((r) => setTimeout(r, 5));
    }
    if (messageErr) {
      throw messageErr;
    }
    sessionActive = false; // Revoke session live!

    await assert.rejects(messagePromise, {
      code: 'forbidden',
      status: 403,
    });

    assert.equal(providerAborted, true);

    // FAIL-CLOSED VERIFICATION: neither user message nor assistant message was persisted
    const convAfterRevocation = await service.getConversation(conv.id, { auth: owner });
    assert.equal(convAfterRevocation.messages.length, 0);

    const rawStored = JSON.parse(await readFile(filePath, 'utf8'));
    const storedRecord = rawStored.conversations.find((c) => c.id === conv.id);
    assert.equal(storedRecord.messages.length, 0);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('pagination cursor renews safely on service restart and unowned endpoints are protected', async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'ai-cursor-test-'));
  const filePath = path.join(dir, 'conversations.json');
  try {
    const owner = authOwner('owner-cursor');
    const service1 = createAiConversationService({
      filePath,
      websiteRegistry: { getWebsite: async (id) => ({ id }) },
    });

    // Create 5 conversations
    for (let i = 1; i <= 5; i++) {
      await service1.createConversation({ title: `Chat ${i}`, websiteId: siteA, auth: owner });
    }

    // Page with limit 2
    const page1 = await service1.listConversationPage({ limit: 2, auth: owner });
    assert.equal(page1.items.length, 2);
    assert.ok(page1.nextCursor);

    // Using cursor on same running service succeeds
    const page2 = await service1.listConversationPage({ limit: 2, cursor: page1.nextCursor, auth: owner });
    assert.equal(page2.items.length, 2);

    // Service restart: new service instance generates fresh HMAC secret
    const serviceRestarted = createAiConversationService({
      filePath,
      websiteRegistry: { getWebsite: async (id) => ({ id }) },
    });

    // Using previous cursor on restarted service fails-closed with invalid_ai_history_cursor
    await assert.rejects(
      serviceRestarted.listConversationPage({ limit: 2, cursor: page1.nextCursor, auth: owner }),
      { code: 'invalid_ai_history_cursor' },
    );

    // Requesting with cursor: null (refresh history) succeeds and produces a fresh valid cursor
    const refreshedPage = await serviceRestarted.listConversationPage({ limit: 2, cursor: null, auth: owner });
    assert.equal(refreshedPage.items.length, 2);
    assert.ok(refreshedPage.nextCursor);
    assert.notEqual(refreshedPage.nextCursor, page1.nextCursor);

    // HTTP unowned endpoints boundary check
    const routes = new Map();
    const app = {};
    for (const m of ['get', 'post', 'delete']) {
      app[m] = (p, ...h) => routes.set(`${m} ${p}`, h);
    }
    mountAiRoutes(app, {
      registry: { list() { return []; }, get() {}, prepare() {}, execute() {} },
      audit: { record() {} },
      conversationService: serviceRestarted,
    });

    // Verify unowned routes exist and are protected by owner guard
    const unownedGet = routes.get('get /api/ai/conversations/unowned');
    const unownedMigrate = routes.get('post /api/ai/conversations/unowned/migrate');
    const unownedRollback = routes.get('post /api/ai/conversations/unowned/rollback');

    assert.ok(unownedGet);
    assert.ok(unownedMigrate);
    assert.ok(unownedRollback);

    // Invoking with non-owner fails-closed
    const mockRes = {
      status(code) { this.statusCode = code; return this; },
      json(val) { this.body = val; return this; },
    };
    const managerReq = { auth: authManager('mgr-1'), params: {}, query: {}, body: {} };

    await unownedGet[0](managerReq, mockRes, () => {});
    assert.equal(mockRes.statusCode, 403);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
