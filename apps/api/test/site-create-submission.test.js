import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import test from 'node:test';

// Run existing client/web site-create submission tests as baseline
import '../../web/test/site-create-submission.test.js';

import {
  mountSiteCreateRoutes,
  siteCreateHttpInternals,
} from '../src/site-create-http.js';
import { createHostingSiteCreateService } from '../src/hosting-site-create-service.js';
import { createSiteSubmission, siteSubmissionBusy } from '../../web/src/workspace/site-create-submission.js';
import { siteHref } from '../../web/src/workspace/site-model.js';
import { website as createWebsiteFixture } from '../test-support/hosting-site-fixture.js';

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
