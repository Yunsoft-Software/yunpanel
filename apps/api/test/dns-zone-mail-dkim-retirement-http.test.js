import assert from 'node:assert/strict';
import test from 'node:test';
import {
  DnsZoneMailDkimRetirementHttpError,
  mountDnsZoneMailDkimRetirementRoutes,
} from '../src/dns-zone-mail-dkim-retirement-http.js';
import { DnsZoneMailDkimRetirementError } from '../src/dns-zone-mail-dkim-retirement.js';

function createFakeApp() {
  const routes = new Map();
  return {
    routes,
    post(route, ...handlers) { routes.set(`POST ${route}`, handlers); },
  };
}

async function invoke(app, key, request) {
  const handlers = app.routes.get(key);
  assert.ok(handlers, `route ${key} should be mounted`);
  const response = {
    payload: null,
    json(payload) { this.payload = payload; return payload; },
  };
  await handlers.at(-1)(request, response, (error) => {
    if (error) throw error;
  });
  return response.payload;
}

test('local DKIM retirement HTTP forwards exact preview and apply fences', async () => {
  const calls = [];
  const app = createFakeApp();
  mountDnsZoneMailDkimRetirementRoutes(app, {
    serviceForRequest: async () => ({
      preview: async (input) => { calls.push(['preview', input]); return { readyToApply: true }; },
      apply: async (input) => { calls.push(['apply', input]); return { completed: true }; },
    }),
  });
  const previewKey = 'POST /api/mail-domains/:mailDomainId/dkim/local-dns-retirement-preview';
  const applyKey = 'POST /api/mail-domains/:mailDomainId/dkim/local-dns-retirement-apply';
  const digest = 'a'.repeat(64);

  assert.deepEqual(await invoke(app, previewKey, {
    params: { mailDomainId: 'mail-domain-1' },
    query: {},
    body: { expectedRevision: 7 },
  }), { data: { readyToApply: true } });
  assert.deepEqual(await invoke(app, applyKey, {
    params: { mailDomainId: 'mail-domain-1' },
    query: {},
    body: { expectedRevision: 7, previewDigest: digest, confirmation: 'exact-confirmation' },
  }), { data: { completed: true } });
  assert.deepEqual(calls, [
    ['preview', { mailDomainId: 'mail-domain-1', expectedRevision: 7 }],
    ['apply', {
      mailDomainId: 'mail-domain-1',
      expectedRevision: 7,
      previewDigest: digest,
      confirmation: 'exact-confirmation',
    }],
  ]);
});

test('local DKIM retirement HTTP rejects extra fields and query parameters before service resolution', async () => {
  let resolutions = 0;
  const app = createFakeApp();
  mountDnsZoneMailDkimRetirementRoutes(app, {
    serviceForRequest: async () => {
      resolutions += 1;
      return { preview: async () => ({}), apply: async () => ({}) };
    },
  });
  const previewKey = 'POST /api/mail-domains/:mailDomainId/dkim/local-dns-retirement-preview';

  await assert.rejects(
    invoke(app, previewKey, {
      params: { mailDomainId: 'mail-domain-1' },
      query: {},
      body: { expectedRevision: 7, unexpected: true },
    }),
    (error) => error instanceof DnsZoneMailDkimRetirementHttpError
      && error.code === 'mail_dkim_local_retirement_preview_input_invalid',
  );
  await assert.rejects(
    invoke(app, previewKey, {
      params: { mailDomainId: 'mail-domain-1' },
      query: { unsafe: '1' },
      body: { expectedRevision: 7 },
    }),
    (error) => error instanceof DnsZoneMailDkimRetirementHttpError
      && error.code === 'mail_dkim_local_retirement_query_invalid',
  );
  assert.equal(resolutions, 0);
});

test('local DKIM retirement HTTP preserves typed service failures', async () => {
  const app = createFakeApp();
  mountDnsZoneMailDkimRetirementRoutes(app, {
    serviceForRequest: async () => ({
      preview: async () => {
        throw new DnsZoneMailDkimRetirementError('mail_dkim_retirement_not_found', 'Missing', 404);
      },
      apply: async () => ({}),
    }),
  });

  await assert.rejects(
    invoke(app, 'POST /api/mail-domains/:mailDomainId/dkim/local-dns-retirement-preview', {
      params: { mailDomainId: 'mail-domain-1' },
      query: {},
      body: { expectedRevision: 7 },
    }),
    (error) => error instanceof DnsZoneMailDkimRetirementHttpError
      && error.code === 'mail_dkim_retirement_not_found' && error.status === 404,
  );
});
