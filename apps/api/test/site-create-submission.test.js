import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import http from 'node:http';
import { once } from 'node:events';
import test from 'node:test';

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

import { createSiteSubmission, EMPTY_SITE_SUBMISSION, siteSubmissionBusy } from '../../web/src/workspace/site-create-submission.js';

// Run web controller unit and wiring tests alongside API integration tests
import '../../web/test/site-create-submission.test.js';
import '../../web/test/site-create-result-wiring.test.js';

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

function provisioningRuntime() {
  const checksum = 'f'.repeat(64);
  return createWebsiteProvisioningRuntime({
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

async function resources() {
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
  const websiteProvisioningRuntime = provisioningRuntime();
  await Promise.all([
    applicationRegistry.init(), dockerWorkloadRegistry.init(), websiteRegistry.init(), domainRegistry.init(),
    dnsHostingRegistry.init(), mailDomainRegistry.init(), websiteProvisioningRuntime.init(),
  ]);
  return {
    registry,
    applicationRegistry,
    dockerWorkloadRegistry,
    websiteRegistry,
    domainRegistry,
    dnsHostingRegistry,
    mailDomainRegistry,
    websiteProvisioningRuntime,
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
