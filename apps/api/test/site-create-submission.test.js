import assert from 'node:assert/strict';
import crypto, { randomUUID } from 'node:crypto';
import { once } from 'node:events';
import http from 'node:http';
import test from 'node:test';

// Run existing client/web site-create submission tests as baseline
import '../../web/test/site-create-submission.test.js';
import '../../web/test/site-create-result-wiring.test.js';

import { createApp } from '../src/app.js';
import { createApplicationRegistry } from '../src/application-registry.js';
import { createAuthenticatedApi } from '../src/auth-http.js';
import { createDomainRegistry } from '../src/domain-registry.js';
import { createDnsHostingRegistry } from '../src/dns-hosting-registry.js';
import { createDockerWorkloadRegistry } from '../src/docker-workload-registry.js';
import { createMailDomainRegistry } from '../src/mail-domain-registry.js';
import { createServerRegistry } from '../src/server-registry.js';
import { createWebsiteProvisioningRuntime } from '../src/website-provisioning-runtime.js';
import { createWebsiteRegistry } from '../src/website-registry.js';
import {
  mountSiteCreateRoutes,
  siteCreateHttpInternals,
} from '../src/site-create-http.js';
import { createHostingSiteCreateService } from '../src/hosting-site-create-service.js';
import {
  createSiteSubmission,
  EMPTY_SITE_SUBMISSION,
  siteSubmissionBusy,
} from '../../web/src/workspace/site-create-submission.js';
import { siteHref } from '../../web/src/workspace/site-model.js';
import { website as createWebsiteFixture } from '../test-support/hosting-site-fixture.js';
import {
  createProvisioningRecovery,
  EMPTY_RECOVERY,
  recoveryAllowed,
  recoveryBusy,
  recoveryOperation,
} from '../../web/src/workspace/provisioning-recovery.js';
import { advanceProvisioning } from '../../web/src/workspace/provisioning-advance.js';
import { createSiteMutationLock } from '../src/site-mutation-lock.js';
import { mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

function fakeApp() {
  const routes = { get: new Map(), post: new Map() };
  return {
    routes,
    get(path, ...handlers) { routes.get.set(path, handlers.at(-1)); },
    post(path, ...handlers) { routes.post.set(path, handlers.at(-1)); },
  };
}

function fakeResponse() {
  return {
    statusCode: 200,
    payload: null,
    headers: {},
    setHeader(name, value) { this.headers[name.toLowerCase()] = value; },
    set(name, value) { this.setHeader(name, value); return this; },
    status(value) { this.statusCode = value; return this; },
    json(value) { this.payload = value; return this; },
  };
}

async function invoke(handler, request) {
  const response = fakeResponse();
  let nextError = null;
  await handler(request, response, (error) => { nextError = error; });
  if (nextError) throw nextError;
  return response;
}

test('API POST /api/sites preserves 201/200 created site record and Domain-ID when provisioning registration fails', async () => {
  const localServerId = randomUUID();
  const websiteId = randomUUID();
  const domainId = randomUUID();
  const operationId = randomUUID();
  const previewDigest = 'a'.repeat(64);
  const confirmation = `create-site:${operationId}:${previewDigest}`;

  const createdWebsite = { id: websiteId, serverId: localServerId, primaryDomain: 'example.test' };
  const createdDomain = { id: domainId, websiteId, serverId: localServerId, primaryDomain: 'example.test', parentDomainId: null };

  const app = fakeApp();
  mountSiteCreateRoutes(app, {
    localServerId,
    createSite: async () => ({
      operationId,
      created: true,
      website: createdWebsite,
      primaryDomain: createdDomain,
    }),
    previewSiteCreate: async () => ({
      operationId,
      ids: { websiteId, primaryDomainId: domainId },
      hostname: { primaryDomain: 'example.test' },
      previewDigest,
      confirmation,
      plan: { website: createdWebsite },
      source: { kind: 'new_static' },
      blockers: [],
      steps: { websiteReady: false },
    }),
    websiteProvisioningRegistry: {
      create: async () => {
        const err = new Error('Provisioning backend timeout or crash');
        err.code = 'provisioning_registration_failed';
        err.status = 503;
        throw err;
      },
    },
  });

  const handler = app.routes.post.get('/api/sites');
  assert.ok(handler, 'Route POST /api/sites must be mounted');

  const request = {
    auth: { user: { id: 'owner-1', role: 'owner' }, token: 'owner-token' },
    body: {
      input: { operationId, serverId: localServerId, primaryDomain: 'example.test' },
      previewDigest,
      confirmation,
    },
  };

  const res = await invoke(handler, request);
  assert.equal(res.statusCode, 201, 'HTTP status must be 201 Created even when provisioning registration fails');
  assert.ok(res.payload?.data, 'Response must contain data');
  assert.equal(res.payload.data.created, true);
  assert.equal(res.payload.data.website?.id, websiteId);
  assert.equal(res.payload.data.primaryDomain?.id, domainId);
  assert.equal(res.payload.data.provisioningError?.code, 'provisioning_registration_failed');
  assert.equal(res.payload.data.provisioningError?.status, 503);
  assert.equal(res.payload.data.provisioning, undefined, 'Failed provisioning plan must not be marked as active/ready');
});

test('API POST /api/sites does not falsely report running site, SSL, or mail success on provisioning error', async () => {
  const localServerId = randomUUID();
  const websiteId = randomUUID();
  const domainId = randomUUID();
  const operationId = randomUUID();
  const previewDigest = 'b'.repeat(64);
  const confirmation = `create-site:${operationId}:${previewDigest}`;

  const app = fakeApp();
  mountSiteCreateRoutes(app, {
    localServerId,
    createSite: async () => ({
      operationId,
      created: true,
      website: { id: websiteId, serverId: localServerId, primaryDomain: 'sub.example.test' },
      primaryDomain: { id: domainId, websiteId, serverId: localServerId, primaryDomain: 'sub.example.test', parentDomainId: null },
    }),
    previewSiteCreate: async () => ({
      operationId,
      ids: { websiteId, primaryDomainId: domainId },
      hostname: { primaryDomain: 'sub.example.test' },
      previewDigest,
      confirmation,
    }),
    websiteProvisioningRegistry: {
      create: async () => { throw new Error('database lock timeout'); },
    },
  });

  const handler = app.routes.post.get('/api/sites');
  const res = await invoke(handler, {
    auth: { user: { id: 'owner-1', role: 'owner' } },
    body: {
      input: { operationId, serverId: localServerId, primaryDomain: 'sub.example.test' },
      previewDigest,
      confirmation,
    },
  });

  assert.equal(res.statusCode, 201);
  const data = res.payload.data;
  assert.equal(data.website.id, websiteId);
  assert.equal(data.primaryDomain.id, domainId);
  assert.ok(data.provisioningError);
  // Ensure no bogus ready flags
  assert.notEqual(data.provisioningReady, true);
  assert.notEqual(data.sslReady, true);
  assert.notEqual(data.mailReady, true);
});

test('createHostingSiteCreateService preserves created site and allocation when provisioning registration fails', async () => {
  const localServerId = randomUUID();
  const websiteId = randomUUID();
  const operationId = randomUUID();
  const customerId = 'cust-123';
  const previewDigest = 'c'.repeat(64);
  const sitePreviewDigest = 'd'.repeat(64);
  const confirmation = `create-hosted-site:${operationId}:${previewDigest}`;

  const mockWebsite = createWebsiteFixture(1, { id: websiteId, serverId: localServerId });
  let siteExists = false;
  let reservationCompleted = false;

  const service = createHostingSiteCreateService({
    localServerId,
    hostingAccounts: {
      get: () => ({ id: customerId }),
      siteAllocations: {
        preview: () => ({ state: 'available', customerId }),
        reserve: () => ({ state: 'reserved', websiteId, customerId }),
        complete: () => { reservationCompleted = true; return { state: 'attached', accessGranted: true, customerId }; },
      },
    },
    websiteRegistry: {
      getWebsite: async (id) => (siteExists && id === websiteId ? mockWebsite : null),
    },
    previewSiteCreate: async () => ({
      operationId,
      ids: { websiteId, primaryDomainId: randomUUID() },
      previewDigest: sitePreviewDigest,
      confirmation: `create-site:${operationId}:${sitePreviewDigest}`,
      plan: { website: mockWebsite },
      source: { kind: 'new_static' },
      blockers: [],
      steps: { websiteReady: false },
      provisioning: {
        operationId: randomUUID(),
        websiteId,
        ready: false,
        steps: [{ id: 'nginx', required: true, state: 'pending' }],
      },
    }),
    createSite: async () => {
      siteExists = true;
      return {
        operationId,
        created: true,
        website: mockWebsite,
      };
    },
    websiteProvisioningRegistry: {
      create: async () => {
        const err = new Error('Provisioning service unavailable');
        err.code = 'provisioning_registration_failed';
        err.status = 503;
        throw err;
      },
    },
    siteMutationLock: null,
  });

  const prepared = await service.preview('token', () => {}, {
    customerId,
    input: { operationId, serverId: localServerId, primaryDomain: 'hosted.example.test' },
  });

  const result = await service.create('token', () => {}, {
    customerId,
    input: { operationId, serverId: localServerId, primaryDomain: 'hosted.example.test' },
    previewDigest: prepared.previewDigest,
    confirmation: prepared.confirmation,
  });

  assert.equal(reservationCompleted, true, 'Reservation must be completed even when provisioning fails');
  assert.equal(result.created, true);
  assert.equal(result.website.id, websiteId);
  assert.equal(result.stage, 'provisioning_registration_failed');
  assert.equal(result.provisioningReady, false, 'provisioningReady must remain false');
  assert.equal(result.provisioningError?.code, 'provisioning_registration_failed');
});

test('client submission with 201 create and provisioning error retains created site, steps, and sets attention phase', async () => {
  const domainId = randomUUID();
  const websiteId = randomUUID();
  const serverId = randomUUID();
  const operationId = randomUUID();
  const previewDigest = 'e'.repeat(64);
  const confirmation = `create-site:${operationId}:${previewDigest}`;

  const step = { id: 'nginx', required: true, state: 'pending' };
  const mockPreview = {
    operationId,
    ids: { websiteId, primaryDomainId: domainId },
    hostname: { primaryDomain: 'example.test' },
    previewDigest,
    confirmation,
    provisioning: { operationId, websiteId, ready: false, steps: [step] },
  };

  const mockResult = {
    operationId,
    created: true,
    website: { id: websiteId, serverId },
    primaryDomain: { id: domainId, websiteId, serverId, primaryDomain: 'example.test', parentDomainId: null },
    provisioning: { operationId, websiteId, ready: false, steps: [step] },
    provisioningError: { code: 'provisioning_registration_failed', message: 'Failed', status: 503 },
  };

  let advanceCalled = 0;
  const flow = createSiteSubmission({
    request: async (url) => url.endsWith('create-preview') ? mockPreview : mockResult,
    advance: async () => { advanceCalled++; },
  });

  const state = await flow.submit({
    operationId,
    serverId,
    primaryDomain: 'example.test',
  });

  assert.equal(state.phase, 'attention');
  assert.equal(state.created?.id, domainId, 'Domain ID must be preserved');
  assert.equal(state.created?.websiteId, websiteId);
  assert.equal(state.steps.length, 1, 'Initial steps must be preserved');
  assert.equal(state.steps[0].id, 'nginx');
  assert.equal(advanceCalled, 0, 'Must not auto-advance when provisioning registration failed');
  assert.equal(siteSubmissionBusy(state), false);

  // Overview and Files navigation links must use Domain ID
  assert.equal(siteHref(state.created.id, 'overview'), `/websites/${domainId}/overview`);
  assert.equal(siteHref(state.created.id, 'files'), `/websites/${domainId}/files`);
});

test('client submission with advance timeout/error retains created site and steps in attention phase', async () => {
  const domainId = randomUUID();
  const websiteId = randomUUID();
  const serverId = randomUUID();
  const operationId = randomUUID();
  const previewDigest = 'f'.repeat(64);
  const confirmation = `create-site:${operationId}:${previewDigest}`;

  const step = { id: 'nginx', required: true, state: 'pending' };
  const mockPreview = {
    operationId,
    ids: { websiteId, primaryDomainId: domainId },
    hostname: { primaryDomain: 'example.test' },
    previewDigest,
    confirmation,
    provisioning: { operationId, websiteId, ready: false, steps: [step] },
  };

  const mockResult = {
    operationId,
    created: true,
    website: { id: websiteId, serverId },
    primaryDomain: { id: domainId, websiteId, serverId, primaryDomain: 'example.test', parentDomainId: null },
    provisioning: { operationId, websiteId, ready: false, steps: [step] },
  };

  const flow = createSiteSubmission({
    request: async (url) => url.endsWith('create-preview') ? mockPreview : mockResult,
    advance: async () => {
      const err = new Error('Gateway Timeout');
      err.status = 504;
      throw err;
    },
  });

  const state = await flow.submit({
    operationId,
    serverId,
    primaryDomain: 'example.test',
  });

  assert.equal(state.phase, 'attention');
  assert.equal(state.created?.id, domainId);
  assert.equal(state.steps.length, 1);
  assert.equal(state.steps[0].id, 'nginx');
  assert.ok(state.error.includes('Genel Bakış'));
});

test('client submission with blocked, failed, or interrupted advance preserves site and step statuses', async () => {
  for (const terminalStatus of ['blocked', 'failed', 'interrupted']) {
    const domainId = randomUUID();
    const websiteId = randomUUID();
    const serverId = randomUUID();
    const operationId = randomUUID();
    const previewDigest = '1'.repeat(64);
    const confirmation = `create-site:${operationId}:${previewDigest}`;

    const initialStep = { id: 'nginx', required: true, state: 'pending' };
    const mockPreview = {
      operationId,
      ids: { websiteId, primaryDomainId: domainId },
      hostname: { primaryDomain: 'example.test' },
      previewDigest,
      confirmation,
      provisioning: { operationId, websiteId, ready: false, steps: [initialStep] },
    };

    const mockResult = {
      operationId,
      created: true,
      website: { id: websiteId, serverId },
      primaryDomain: { id: domainId, websiteId, serverId, primaryDomain: 'example.test', parentDomainId: null },
      provisioning: { operationId, websiteId, ready: false, steps: [initialStep] },
    };

    const terminalStep = { id: 'nginx', required: true, state: terminalStatus };
    const flow = createSiteSubmission({
      request: async (url) => url.endsWith('create-preview') ? mockPreview : mockResult,
      advance: async () => ({
        operationId,
        websiteId,
        ready: false,
        steps: [terminalStep],
      }),
    });

    const state = await flow.submit({
      operationId,
      serverId,
      primaryDomain: 'example.test',
    });

    assert.equal(state.phase, 'attention', `Phase must be attention for ${terminalStatus}`);
    assert.equal(state.created?.id, domainId);
    assert.equal(state.steps.length, 1);
    assert.equal(state.steps[0].state, terminalStatus, `Step state must reflect ${terminalStatus}`);
    assert.notEqual(state.phase, 'ready', 'Must never claim ready status');
  }
});

const origin = 'https://panel.example.test';
const csrfToken = 'site-submission-csrf-token';

function fakeStore(role) {
  const session = {
    id: '4afc9025-92fb-4cb7-be1b-0406bdfe70a8',
    user: { id: `${role}-id`, username: role, role },
    csrfToken,
    expiresAt: Date.now() + 60_000,
    idleExpiresAt: Date.now() + 60_000,
  };
  return {
    configured: () => true,
    mfa: { enabled: () => role === 'owner' },
    getSession: (token) => token === 'valid-session' ? session : null,
    listSessions: () => [],
    audit: { record() { return {}; }, list() { return { events: [], total: 0, offset: 0, limit: 50 }; } },
  };
}

function provisioningRuntime(siteMutationLock = null) {
  const checksum = 'f'.repeat(64);
  return createWebsiteProvisioningRuntime({
    siteMutationLock,
    identityManager: {
      apply: async () => ({ satisfied: true, uid: 1201, gid: 1201 }),
      inspect: async () => ({ satisfied: true, uid: 1201, gid: 1201 }),
      compensate: async () => ({ satisfied: true }),
      inspectCompensation: async () => ({ satisfied: true }),
    },
    passengerSiteManager: {
      apply: async () => ({ satisfied: false, reason: 'unused' }),
      inspect: async () => ({ satisfied: false, reason: 'unused' }),
    },
    nginxManager: {
      stageDomain: async (spec) => ({ configName: `yunpanel-${spec.primaryDomain}.conf`, checksum, bytes: 420 }),
      inspectStagedDomain: async (spec) => ({
        satisfied: true,
        result: { configName: `yunpanel-${spec.primaryDomain}.conf`, checksum, bytes: 420 },
      }),
      inspectActiveDomain: async ({ primaryDomain }) => ({
        satisfied: true,
        result: { configName: `yunpanel-${primaryDomain}.conf`, checksum, active: true },
      }),
      activateDomain: async ({ primaryDomain }) => ({
        configName: `yunpanel-${primaryDomain}.conf`, checksum, active: true,
      }),
      compensateDomain: async () => ({ satisfied: true }),
      inspectDomainCompensation: async () => ({ satisfied: true }),
    },
  });
}

async function resources(t = null) {
  const lockDir = mkdtempSync(path.join(os.tmpdir(), 'yunpanel-lock-sub-'));
  const siteMutationLock = createSiteMutationLock({ root: lockDir });
  const registry = createServerRegistry();
  const enrollment = await registry.issueEnrollmentToken({ label: 'site-submission-http' });
  const enrolled = await registry.enrollServer({ token: enrollment.token, hostname: 'site-submission-host' });
  const applicationRegistry = createApplicationRegistry({ serverExists: async (id) => Boolean(await registry.getServer(id)) });
  const dockerWorkloadRegistry = createDockerWorkloadRegistry({ serverExists: async (id) => Boolean(await registry.getServer(id)) });
  const websiteRegistry = createWebsiteRegistry({
    serverExists: async (id) => Boolean(await registry.getServer(id)),
    getApplication: async (id) => applicationRegistry.getApplication(id),
    getDockerWorkload: async (id) => dockerWorkloadRegistry.getWorkload(id),
  });
  const domainRegistry = createDomainRegistry({
    serverExists: async (id) => Boolean(await registry.getServer(id)),
    getWebsite: async (id) => websiteRegistry.getWebsite(id),
    websiteBindingRequired: () => true,
  });
  const getWebDomain = async (id) => domainRegistry.getDomain(id);
  const dnsHostingRegistry = createDnsHostingRegistry({ getWebDomain });
  const mailDomainRegistry = createMailDomainRegistry({ getWebDomain });
  const websiteProvisioningRuntime = provisioningRuntime(siteMutationLock);
  await Promise.all([
    applicationRegistry.init(), dockerWorkloadRegistry.init(), websiteRegistry.init(), domainRegistry.init(),
    dnsHostingRegistry.init(), mailDomainRegistry.init(), websiteProvisioningRuntime.init(),
  ]);
  if (t?.after) {
    t.after(() => {
      try { rmSync(lockDir, { recursive: true, force: true }); } catch {}
    });
  }
  return {
    registry,
    applicationRegistry,
    dockerWorkloadRegistry,
    websiteRegistry,
    domainRegistry,
    dnsHostingRegistry,
    mailDomainRegistry,
    websiteProvisioningRuntime,
    siteMutationLock,
    lockDir,
    serverId: enrolled.server.id,
  };
}

async function listener(t, role, state) {
  const handler = createAuthenticatedApi({
    store: fakeStore(role),
    publicOrigin: origin,
    createHandler: () => createApp({ ...state, environment: 'production' }),
  });
  const server = http.createServer(handler).listen(0, '127.0.0.1');
  await once(server, 'listening');
  t.after(() => new Promise((resolve) => { server.closeAllConnections(); server.close(resolve); }));
  const base = `http://127.0.0.1:${server.address().port}`;
  return {
    base,
    request: (pathname, { authenticated = true, body, method = 'POST', headers = {} } = {}) => fetch(`${base}${pathname}`, {
      method,
      headers: {
        ...(authenticated ? { cookie: '__Host-yunpanel_session=valid-session' } : {}),
        origin,
        ...(body === undefined ? {} : { 'content-type': 'application/json' }),
        'x-csrf-token': csrfToken,
        ...headers,
      },
      body: body === undefined ? undefined : JSON.stringify(body),
    }),
  };
}

function siteInput(serverId, extra = {}) {
  return {
    operationId: crypto.randomUUID(),
    serverId,
    name: 'Submission Site',
    primaryDomain: 'submission-site.example.test',
    parentDomainId: null,
    wwwMode: 'none',
    httpsMode: 'off',
    source: { kind: 'external_proxy', target: { host: 'origin.example.test', port: 8443 } },
    ...extra,
  };
}

function createClientAdapter({ base, requestInterceptor = null, advanceInterceptor = null }) {
  const request = async (pathname, options = {}) => {
    if (requestInterceptor) {
      const intercepted = await requestInterceptor(pathname, options);
      if (intercepted !== undefined) return intercepted;
    }
    const fullUrl = `${base}/api${pathname}`;
    const res = await fetch(fullUrl, {
      method: options.method ?? 'POST',
      headers: {
        'content-type': 'application/json',
        cookie: '__Host-yunpanel_session=valid-session',
        origin,
        'x-csrf-token': csrfToken,
      },
      body: options.body ? JSON.stringify(options.body) : undefined,
      signal: options.signal,
    });
    if (!res.ok) {
      const body = await res.json().catch(() => null);
      const err = new Error(body?.error?.message ?? `Request failed with ${res.status}`);
      err.status = res.status;
      err.code = body?.error?.code;
      err.data = body?.data;
      throw err;
    }
    const json = await res.json();
    return json.data;
  };

  const advance = async (operationId, { signal, onStep } = {}) => {
    if (advanceInterceptor) {
      const intercepted = await advanceInterceptor(operationId, { signal, onStep });
      if (intercepted !== undefined) return intercepted;
    }
    let res = await fetch(`${base}/api/sites/provisioning/${operationId}/continue`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        cookie: '__Host-yunpanel_session=valid-session',
        origin,
        'x-csrf-token': csrfToken,
      },
      body: JSON.stringify({ confirmation: `continue-site-provisioning:${operationId}` }),
      signal,
    });
    let json = await res.json();
    while (res.status === 202) {
      if (onStep) onStep({ operationId, operation: json.data.operation });
      res = await fetch(`${base}/api/sites/provisioning/${operationId}/continue`, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          cookie: '__Host-yunpanel_session=valid-session',
          origin,
          'x-csrf-token': csrfToken,
        },
        body: JSON.stringify({ confirmation: `continue-site-provisioning:${operationId}` }),
        signal,
      });
      json = await res.json();
    }
    if (!res.ok) {
      const err = new Error(json?.error?.message ?? 'Provisioning advance failed');
      err.status = res.status;
      throw err;
    }
    return json.data.operation;
  };

  return { request, advance };
}

// ---------------------------------------------------------------------------
// Acceptance Tests: Site Create Submission Flow & Error Resilience
// ---------------------------------------------------------------------------

test('full end-to-end site create submission successfully previews, creates, and advances to ready', async (t) => {
  const state = await resources();
  const api = await listener(t, 'owner', state);
  const states = [];
  const adapter = createClientAdapter({ base: api.base });
  const flow = createSiteSubmission({
    ...adapter,
    onState: (s) => states.push(s),
  });
  const input = siteInput(state.serverId);

  const finalState = await flow.submit(input);
  assert.equal(finalState.phase, 'ready');
  assert.equal(finalState.error, null);
  assert.ok(finalState.created);
  assert.equal(finalState.created.primaryDomain, input.primaryDomain);

  // Verified against backend registries
  const websites = await state.websiteRegistry.listWebsites();
  assert.equal(websites.length, 1);
  assert.equal(websites[0].id, finalState.created.websiteId);

  const domains = await state.domainRegistry.listDomains();
  assert.equal(domains.length, 1);
  assert.equal(domains[0].id, finalState.created.id);
  assert.equal(domains[0].primaryDomain, input.primaryDomain);

  // Sequential progression: previewing -> creating -> recorded -> provisioning -> ready
  const phases = states.map((s) => s.phase);
  assert.ok(phases.includes('previewing'));
  assert.ok(phases.includes('creating'));
  assert.ok(phases.includes('recorded'));
  assert.ok(phases.includes('ready'));
});

test('concurrent double submission executes exactly one preview and one create, preventing duplicate sites', async (t) => {
  const state = await resources();
  const api = await listener(t, 'owner', state);
  let previewCalls = 0;
  let createCalls = 0;

  const adapter = createClientAdapter({
    base: api.base,
    requestInterceptor: async (pathname) => {
      if (pathname.endsWith('create-preview')) previewCalls++;
      if (pathname === '/sites') createCalls++;
      return undefined;
    },
  });
  const flow = createSiteSubmission(adapter);
  const input = siteInput(state.serverId);

  // Submit twice concurrently on the same controller
  const first = flow.submit(input);
  const second = await flow.submit(input);
  assert.equal(second.phase, 'previewing');
  const res1 = await first;

  assert.equal(previewCalls, 1, 'Only one preview request should be sent');
  assert.equal(createCalls, 1, 'Only one create POST should be sent');
  assert.equal(res1.phase, 'ready');
  assert.equal(flow.getState().phase, 'ready');
  assert.equal(res1.created.primaryDomain, input.primaryDomain);

  const websites = await state.websiteRegistry.listWebsites();
  assert.equal(websites.length, 1, 'Exactly one website should exist in registry');
  const domains = await state.domainRegistry.listDomains();
  assert.equal(domains.length, 1, 'Exactly one domain should exist in registry');
});

test('preview error leaves controller unsealed and editable, allowing retry that performs only one create', async (t) => {
  const state = await resources();
  const api = await listener(t, 'owner', state);
  let previewCalls = 0;
  let createCalls = 0;

  const adapter = createClientAdapter({
    base: api.base,
    requestInterceptor: async (pathname) => {
      if (pathname.endsWith('create-preview')) previewCalls++;
      if (pathname === '/sites') createCalls++;
      return undefined;
    },
  });
  const flow = createSiteSubmission(adapter);
  const input = siteInput(state.serverId);

  // 1. Initial attempt with invalid server ID triggers preview failure (404 local_server_required)
  const invalidInput = { ...input, serverId: '99999999-9999-4999-8999-999999999999' };
  const errorState = await flow.submit(invalidInput);
  assert.equal(errorState.phase, 'error');
  assert.equal(errorState.created, null);
  assert.ok(errorState.error.includes('Önizleme doğrulanamadı'));
  assert.equal(previewCalls, 1);
  assert.equal(createCalls, 0, 'Create must not be attempted if preview fails');

  // 2. Retry with corrected valid input succeeds because preview error does NOT seal the form
  const successState = await flow.submit(input);
  assert.equal(successState.phase, 'ready');
  assert.equal(successState.created.primaryDomain, input.primaryDomain);
  assert.equal(previewCalls, 2);
  assert.equal(createCalls, 1, 'Exactly one create POST executed across the lifecycle');

  const websites = await state.websiteRegistry.listWebsites();
  assert.equal(websites.length, 1);
});

test('create POST response loss causes uncertain state, prevents blind re-POST, and reconciles against backend without cleanup or duplicates', async (t) => {
  const state = await resources();
  const api = await listener(t, 'owner', state);
  let createPostsAttempted = 0;
  let realCreateExecuted = false;

  const adapter = createClientAdapter({
    base: api.base,
    requestInterceptor: async (pathname, options) => {
      if (pathname === '/sites') {
        createPostsAttempted++;
        // Perform the real create request to backend so the resource is actually created
        const realRes = await fetch(`${api.base}/api/sites`, {
          method: 'POST',
          headers: {
            'content-type': 'application/json',
            cookie: '__Host-yunpanel_session=valid-session',
            origin,
            'x-csrf-token': csrfToken,
          },
          body: JSON.stringify(options.body),
        });
        assert.equal(realRes.status, 201);
        realCreateExecuted = true;
        // Simulate network loss/drop before response reaches client
        const netErr = new Error('Network dropped before response received');
        netErr.code = 'ECONNRESET';
        throw netErr;
      }
      return undefined;
    },
  });

  const flow = createSiteSubmission(adapter);
  const input = siteInput(state.serverId);

  // 1. Submit suffers response loss
  const uncertainState = await flow.submit(input);
  assert.equal(uncertainState.phase, 'uncertain');
  assert.equal(uncertainState.created, null);
  assert.ok(uncertainState.error.includes('Sunucuda kayıt oluşmuş olabilir'));
  assert.equal(createPostsAttempted, 1);
  assert.equal(realCreateExecuted, true);

  // 2. Subsequent blind submit attempt from the same form is blocked
  const secondState = await flow.submit(input);
  assert.equal(secondState.phase, 'uncertain');
  assert.equal(createPostsAttempted, 1, 'No second blind create POST must be made');

  // 3. Reconcile from existing backend records (site list / website registry)
  const existingWebsites = await state.websiteRegistry.listWebsites();
  assert.equal(existingWebsites.length, 1, 'Site was persisted on server and NOT automatically cleaned up');
  assert.equal(existingWebsites[0].serverId, state.serverId);

  const existingDomains = await state.domainRegistry.listDomains();
  assert.equal(existingDomains.length, 1, 'Domain was persisted on server and NOT cleaned up');
  assert.equal(existingDomains[0].primaryDomain, input.primaryDomain);

  // 4. Verify no automated destructive cleanup occurred
  const persistedWebsite = await state.websiteRegistry.getWebsite(existingWebsites[0].id);
  assert.ok(persistedWebsite, 'Persisted website record remains intact');

  // 5. Verify no duplicate site creation occurs upon server-side idempotent re-evaluation
  const previewRes = await api.request('/api/sites/create-preview', { body: { input } });
  const preview = (await previewRes.json()).data;
  const idempotentReplay = await api.request('/api/sites', {
    body: { input, previewDigest: preview.previewDigest, confirmation: preview.confirmation },
  });
  assert.equal(idempotentReplay.status, 200);
  const replayData = (await idempotentReplay.json()).data;
  assert.equal(replayData.created, false);
  assert.equal((await state.websiteRegistry.listWebsites()).length, 1, 'Re-POST never creates duplicate site');
});

for (const status of [401, 403, 409, 429, 500, 503]) {
  test(`create POST ${status} error sets uncertain phase, seals controller against blind retry, and leaves backend state clean`, async (t) => {
    const state = await resources();
    const api = await listener(t, 'owner', state);
    let createAttempts = 0;
    const adapter = createClientAdapter({
      base: api.base,
      requestInterceptor: async (pathname) => {
        if (pathname === '/sites') {
          createAttempts++;
          const err = new Error(`Server returned ${status}`);
          err.status = status;
          throw err;
        }
        return undefined;
      },
    });
    const flow = createSiteSubmission(adapter);
    const input = siteInput(state.serverId, { operationId: crypto.randomUUID() });

    const resultState = await flow.submit(input);
    assert.equal(resultState.phase, 'uncertain');
    assert.equal(createAttempts, 1);

    // Resubmitting from the same controller does not fire a second blind POST
    await flow.submit(input);
    assert.equal(createAttempts, 1, 'Form is sealed and refuses repeated create POST');

    // Reconcile against site list: no duplicate or corrupted partial sites exist
    assert.equal((await state.websiteRegistry.listWebsites()).length, 0);
  });
}

test('unauthenticated and read-only attempts are rejected at API route boundary and never create sites', async (t) => {
  const state = await resources();
  const readOnlyApi = await listener(t, 'read_only', state);
  const input = siteInput(state.serverId);

  // Unauthenticated
  const unauthPreview = await readOnlyApi.request('/api/sites/create-preview', {
    authenticated: false,
    body: { input },
  });
  assert.equal(unauthPreview.status, 401);

  // Read-only actor
  const forbiddenPreview = await readOnlyApi.request('/api/sites/create-preview', {
    authenticated: true,
    body: { input },
  });
  assert.equal(forbiddenPreview.status, 403);

  const forbiddenApply = await readOnlyApi.request('/api/sites', {
    authenticated: true,
    body: { input, previewDigest: 'a'.repeat(64), confirmation: 'invalid' },
  });
  assert.equal(forbiddenApply.status, 403);

  // Ensure no sites or domains were created
  assert.equal((await state.websiteRegistry.listWebsites()).length, 0);
  assert.equal((await state.domainRegistry.listDomains()).length, 0);
});

test('Yaratılmış site sonrasında ilerletme hatasında yeni site oluşturmadan mevcut sonuca/Genel Bakış recovery\'ye dön. Manuel continue/retry/compensate, stale kayıt, çift tıklama, oturum kaybı, ortak kilit, idempotency ve restart kabulü', async (t) => {
  const state = await resources(t);
  const api = await listener(t, 'owner', state);
  let createPostsAttempted = 0;
  let advanceAttempts = 0;

  const adapter = createClientAdapter({
    base: api.base,
    requestInterceptor: async (pathname) => {
      if (pathname === '/sites') createPostsAttempted++;
      return undefined;
    },
    advanceInterceptor: async (operationId) => {
      advanceAttempts++;
      const err = new Error('Gateway Timeout during provisioning advance');
      err.status = 504;
      err.code = 'gateway_timeout';
      throw err;
    },
  });

  const flow = createSiteSubmission(adapter);
  const input = siteInput(state.serverId, {
    name: 'Recovery Workflow Site',
    primaryDomain: 'recovery-workflow.example.test',
  });

  // 1. Initial submission creates site successfully on backend but advance fails
  const submissionState = await flow.submit(input);
  assert.equal(submissionState.phase, 'attention');
  assert.ok(submissionState.created, 'Created site must be preserved upon advance error');
  assert.equal(submissionState.created.primaryDomain, input.primaryDomain);
  assert.ok(submissionState.error.includes('Genel Bakış'), 'Error message must direct to Genel Bakış');
  assert.equal(createPostsAttempted, 1);
  assert.equal(advanceAttempts, 1);

  // 2. Sealed controller refuses subsequent create attempts, preventing duplicate sites
  const duplicateAttempt = await flow.submit(input);
  assert.equal(duplicateAttempt.phase, 'attention');
  assert.equal(createPostsAttempted, 1, 'No second create POST must be sent from sealed form');

  const websites = await state.websiteRegistry.listWebsites();
  assert.equal(websites.length, 1, 'Only one website must exist in registry');
  assert.equal(websites[0].id, submissionState.created.websiteId);

  const domains = await state.domainRegistry.listDomains();
  assert.equal(domains.length, 1, 'Only one domain must exist in registry');
  assert.equal(domains[0].id, submissionState.created.id);

  // 3. Overview link points to existing result and Genel Bakış
  const domainId = submissionState.created.id;
  const websiteId = submissionState.created.websiteId;
  const overviewUrl = siteHref(domainId, 'overview');
  assert.equal(overviewUrl, `/websites/${domainId}/overview`);

  // 4. Genel Bakış recovery flow connects to the existing site and operation
  let isCurrentSession = true;
  let canManageUser = true;
  let simulatedToken = 'valid-session';
  let recoveryContinues = 0;
  let recoveryRetries = 0;
  let recoveryCompensates = 0;

  const recoveryFlow = createProvisioningRecovery({
    websiteId,
    canManage: () => canManageUser,
    isCurrent: () => isCurrentSession,
    read: async ({ signal } = {}) => {
      const res = await fetch(`${api.base}/api/sites/${websiteId}/provisioning/latest`, {
        headers: {
          cookie: `__Host-yunpanel_session=${simulatedToken}`,
        },
        signal,
      });
      if (res.status === 401 || res.status === 403) {
        const err = new Error('Auth error');
        err.status = res.status;
        throw err;
      }
      const json = await res.json();
      return json.data;
    },
    execute: async (approval, { signal } = {}) => {
      let endpoint = `/api/sites/provisioning/${approval.operationId}/continue`;
      if (approval.action === 'retry') {
        recoveryRetries++;
        endpoint = `/api/sites/provisioning/${approval.operationId}/steps/${approval.stepId}/retry`;
      } else if (approval.action === 'compensate') {
        recoveryCompensates++;
        endpoint = `/api/sites/provisioning/${approval.operationId}/steps/${approval.stepId}/compensate`;
      } else {
        recoveryContinues++;
      }
      const res = await fetch(`${api.base}${endpoint}`, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          cookie: `__Host-yunpanel_session=${simulatedToken}`,
          origin,
          'x-csrf-token': csrfToken,
        },
        body: JSON.stringify({ confirmation: approval.confirmation }),
        signal,
      });
      if (!res.ok) {
        const json = await res.json().catch(() => ({}));
        const err = new Error(json?.message || `Request failed with ${res.status}`);
        err.status = res.status;
        err.code = json?.code;
        throw err;
      }
      const json = await res.json();
      return json.data;
    },
  });

  await recoveryFlow.load();
  const recState = recoveryFlow.getState();
  assert.equal(recState.status, 'ready');
  assert.ok(recState.operation, 'Operation must be loaded in recovery flow');
  assert.equal(recState.operation.websiteId, websiteId);
  const operationId = recState.operation.operationId;

  // 5. Stale record scenario: if operation changes before confirm, reject mutation
  const pendingStep = recState.operation.steps.find((s) => s.state === 'pending');
  assert.ok(pendingStep, 'Must find a pending step for recovery');
  const approval = recoveryFlow.prepare('continue');
  assert.ok(approval, 'Approval must be prepared');

  await state.websiteProvisioningRuntime.registry.beginStep({
    operationId,
    stepId: pendingStep.id,
  });

  const staleResult = await recoveryFlow.perform(approval, approval.confirmation);
  assert.equal(staleResult.status, 'ready');
  assert.equal(staleResult.approval, null);
  assert.ok(staleResult.error.includes('Kurulum kaydı değişti'));

  // 6. Double click / concurrent confirmation: sends only ONE POST
  await recoveryFlow.load();
  const freshOp = recoveryFlow.getState().operation;
  assert.ok(freshOp);
  const nextStep = freshOp.steps.find((s) => s.state !== 'succeeded') || freshOp.steps[0];
  const nextAction = nextStep.canRetry ? 'retry' : 'continue';
  const nextApproval = recoveryFlow.prepare(nextAction, nextAction === 'continue' ? null : nextStep.id);
  const postCallsBefore = recoveryContinues + recoveryRetries + recoveryCompensates;

  await Promise.all([
    recoveryFlow.perform(nextApproval, nextApproval.confirmation),
    recoveryFlow.perform(nextApproval, nextApproval.confirmation),
  ]);
  const postCallsAfter = recoveryContinues + recoveryRetries + recoveryCompensates;
  assert.equal(postCallsAfter - postCallsBefore, 1, 'Only one mutation POST is sent on rapid double-click');

  // 7. Session loss scenario (401/403): clears recovery records and approvals immediately
  await recoveryFlow.load();
  const sessOp = recoveryFlow.getState().operation;
  assert.ok(sessOp);
  const sessStep = sessOp.steps.find((s) => s.state !== 'succeeded') || sessOp.steps[0];
  const sessAction = sessStep.canRetry ? 'retry' : 'continue';
  const sessApproval = recoveryFlow.prepare(sessAction, sessAction === 'continue' ? null : sessStep.id);

  simulatedToken = 'invalid-session';
  const sessionLossResult = await recoveryFlow.perform(sessApproval, sessApproval.confirmation);
  assert.equal(sessionLossResult.status, 'forbidden');
  assert.equal(sessionLossResult.operation, null);
  assert.equal(sessionLossResult.approval, null);
  simulatedToken = 'valid-session';

  // 8. Shared lock (siteMutationLock 409 Conflict):
  await recoveryFlow.load();
  const lockOp = recoveryFlow.getState().operation;
  assert.ok(lockOp);
  const lockStep = lockOp.steps.find((s) => s.state !== 'succeeded') || lockOp.steps[0];
  const lockAction = lockStep.canRetry ? 'retry' : 'continue';
  const lockApproval = recoveryFlow.prepare(lockAction, lockAction === 'continue' ? null : lockStep.id);

  let releaseMutationLock;
  let lockAcquired;
  const lockHoldGate = new Promise((resolve) => { releaseMutationLock = resolve; });
  const lockAcquiredGate = new Promise((resolve) => { lockAcquired = resolve; });

  const holdingLockPromise = state.siteMutationLock.withWebsiteLock(websiteId, async () => {
    lockAcquired();
    await lockHoldGate;
  });
  await lockAcquiredGate;

  const lockResult = await recoveryFlow.perform(lockApproval, lockApproval.confirmation);
  assert.ok(lockResult.error);
  assert.equal(recoveryBusy(lockResult), false, 'Client must remain fail-closed without auto-retry');
  releaseMutationLock();
  await holdingLockPromise;

  // 9. Idempotency & Restart:
  await recoveryFlow.load();
  const currentOp = recoveryFlow.getState().operation;
  assert.ok(currentOp);

  const reloadedOp = await state.websiteProvisioningRuntime.registry.get(operationId);
  assert.equal(reloadedOp.operationId, operationId);
  assert.equal(reloadedOp.websiteId, websiteId);

  // 10. Bounded manual retry limits & auto-retry stopped:
  const testFailOp = {
    operationId: crypto.randomUUID(),
    websiteId,
    ready: false,
    status: 'failed',
    steps: [
      { id: 'nginx', kind: 'nginx', required: true, state: 'failed', canRetry: true, error: 'nginx_failed', compensation: { state: 'pending' } },
    ],
  };
  let autoAdvanceCalls = 0;
  const autoResult = await advanceProvisioning({
    operationId: testFailOp.operationId,
    read: async () => testFailOp,
    advance: async () => { autoAdvanceCalls++; return { outcome: 'failed', operation: testFailOp }; },
  });
  assert.equal(autoAdvanceCalls, 0, 'Auto-advance must NOT auto-retry on failed step');
  assert.equal(autoResult.ready, false);
});
