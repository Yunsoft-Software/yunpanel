import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import express from 'express';
import test from 'node:test';
import { MailDiagnosticsHttpError, mountMailDiagnosticsRoutes } from '../src/mail-diagnostics-http.js';

const localServerId = randomUUID();
const remoteServerId = randomUUID();
const localWebDomain = { id: randomUUID(), serverId: localServerId, primaryDomain: 'example.com' };
const remoteWebDomain = { id: randomUUID(), serverId: remoteServerId, primaryDomain: 'remote.example' };
const localMailDomain = {
  id: randomUUID(),
  webDomainId: localWebDomain.id,
  domainName: localWebDomain.primaryDomain,
  managementMode: 'local',
  status: 'enabled',
};
const remoteMailDomain = {
  id: randomUUID(),
  webDomainId: remoteWebDomain.id,
  domainName: remoteWebDomain.primaryDomain,
  managementMode: 'local',
  status: 'enabled',
};
const externalMailDomain = {
  id: randomUUID(),
  webDomainId: localWebDomain.id,
  domainName: localWebDomain.primaryDomain,
  managementMode: 'external',
  status: 'unverified',
};
const localMailbox = Object.freeze({
  id: randomUUID(),
  mailDomainId: localMailDomain.id,
  address: 'owner@example.com',
  enabled: true,
});
const owner = Object.freeze({
  user: { role: 'owner' },
  access: { mode: 'management', permissions: ['*'] },
  security: { managementAllowed: true },
});
const readOnly = Object.freeze({
  user: { role: 'read_only' },
  access: { mode: 'read_only', permissions: ['mail.read'] },
  security: { managementAllowed: false },
});
const publicKey = Buffer.alloc(256, 3).toString('base64');
const dkim = Object.freeze({
  mailDomainId: localMailDomain.id,
  domainName: localMailDomain.domainName,
  selector: 'mail-2026',
  publicKey,
  dnsRecord: Object.freeze({
    type: 'TXT',
    name: 'mail-2026._domainkey.example.com',
    value: `v=DKIM1; k=rsa; p=${publicKey}`,
  }),
  revision: 1,
  createdAt: '2026-09-12T19:00:00.000Z',
  updatedAt: '2026-09-12T19:00:00.000Z',
});

async function listen(t, auth, {
  dkimState = dkim,
  forwardings = [],
  srsReady = true,
  srsServiceAvailable = true,
  srsInspectionFails = false,
} = {}) {
  const calls = [];
  const mailDomains = new Map([
    [localMailDomain.id, localMailDomain],
    [remoteMailDomain.id, remoteMailDomain],
    [externalMailDomain.id, externalMailDomain],
  ]);
  const webDomains = new Map([
    [localWebDomain.id, localWebDomain],
    [remoteWebDomain.id, remoteWebDomain],
  ]);
  const app = express();
  app.use((request, _response, next) => { request.auth = auth; next(); });
  mountMailDiagnosticsRoutes(app, {
    localServerId,
    mailDomainRegistry: {
      async getMailDomain(id) { return mailDomains.get(id) ?? null; },
      async listMailDomains() {
        calls.push(['mail-domains']);
        return [...mailDomains.values()];
      },
    },
    domainRegistry: {
      async getDomain(id) { return webDomains.get(id) ?? null; },
    },
    mailboxRegistry: {
      async listMailboxes(filter) {
        calls.push(['mailboxes', structuredClone(filter)]);
        return filter?.mailDomainId === localMailDomain.id ? [localMailbox] : [];
      },
    },
    mailboxForwardingRegistry: {
      async materializeEnabledForwardings() {
        calls.push(['forwardings']);
        return structuredClone(forwardings);
      },
    },
    mailSrsConfigurationService: srsServiceAvailable ? {
      async previewForServer(id) {
        calls.push(['srs', id]);
        if (srsInspectionFails) throw new Error('private SRS backend failure');
        return {
          version: 1,
          serverId: id,
          ready: srsReady,
          blockers: srsReady ? [] : ['mail_srs_secret_required'],
          privateSecret: 'MUST_NOT_LEAK',
        };
      },
    } : null,
    mailDkimRegistry: {
      async getKey(id) {
        calls.push(['dkim', id]);
        return id === localMailDomain.id ? dkimState : null;
      },
    },
    mailDiagnosticsInspector: {
      async inspect(domainName, options) {
        calls.push(['inspect', domainName, structuredClone(options)]);
        return {
          version: 1,
          domainName,
          mailHostname: 'mail.example.com',
          observedAt: '2026-09-12T18:45:00.000Z',
          diagnostics: {},
          attentionRequired: false,
          issues: [],
          sideEffects: false,
        };
      },
    },
  });
  app.use((error, _request, response, _next) => {
    const known = error instanceof MailDiagnosticsHttpError;
    return response.status(known ? error.status : 500).json({
      error: { code: known ? error.code : 'internal_error', message: known ? error.message : 'Unexpected error' },
    });
  });
  const server = app.listen(0, '127.0.0.1');
  await new Promise((resolve, reject) => {
    server.once('listening', resolve);
    server.once('error', reject);
  });
  t.after(() => new Promise((resolve) => server.close(resolve)));
  return { base: `http://127.0.0.1:${server.address().port}`, calls };
}

test('Owner reads local mail diagnostics with public DKIM and no-applicable forwarding state', async (t) => {
  const { base, calls } = await listen(t, owner);
  const response = await fetch(`${base}/api/mail-domains/${localMailDomain.id}/diagnostics`);
  assert.equal(response.status, 200);
  const body = await response.json();
  assert.equal(body.data.domainName, 'example.com');
  assert.equal(body.data.sideEffects, false);
  assert.deepEqual(body.data.diagnostics.forwardingDeliverability, {
    state: 'not_applicable',
    externalDestinationCount: 0,
    srsReady: null,
    deliveryAssurance: 'not_claimed',
    reasonCode: null,
    action: null,
  });
  assert.equal(body.data.attentionRequired, false);
  assert.equal(calls.some(([name, id]) => name === 'dkim' && id === localMailDomain.id), true);
  assert.equal(calls.some(([name, domainName, options]) => name === 'inspect'
    && domainName === 'example.com' && JSON.stringify(options) === JSON.stringify({ dkim })), true);
  assert.equal(calls.some(([name]) => name === 'srs'), false);
  assert.doesNotMatch(JSON.stringify({ calls, body }), /BEGIN PRIVATE KEY|private\.pem|MUST_NOT_LEAK/i);
});

test('diagnostics keeps DKIM explicitly unconfigured when no managed key exists', async (t) => {
  const { base, calls } = await listen(t, owner, { dkimState: null });
  const response = await fetch(`${base}/api/mail-domains/${localMailDomain.id}/diagnostics`);
  assert.equal(response.status, 200);
  assert.equal(calls.some(([name, domainName, options]) => name === 'inspect'
    && domainName === 'example.com' && JSON.stringify(options) === JSON.stringify({ dkim: null })), true);
});

test('external forwarding without ready SRS is explicitly action-required and never delivery-guaranteed', async (t) => {
  const { base, calls } = await listen(t, owner, {
    srsReady: false,
    forwardings: [{
      mailboxId: localMailbox.id,
      source: localMailbox.address,
      mode: 'copy',
      destinations: ['backup@gmail.com'],
    }],
  });
  const response = await fetch(`${base}/api/mail-domains/${localMailDomain.id}/diagnostics`);
  assert.equal(response.status, 200);
  const body = await response.json();
  assert.deepEqual(body.data.diagnostics.forwardingDeliverability, {
    state: 'action_required',
    externalDestinationCount: 1,
    srsReady: false,
    deliveryAssurance: 'not_guaranteed',
    reasonCode: 'mail_forwarding_srs_not_ready',
    action: 'prepare_mail_srs',
  });
  assert.equal(body.data.attentionRequired, true);
  assert.equal(body.data.issues.some((issue) => issue.kind === 'forwardingDeliverability'
    && issue.reasonCode === 'mail_forwarding_srs_not_ready'), true);
  assert.equal(calls.some(([name, id]) => name === 'srs' && id === localServerId), true);
  assert.doesNotMatch(JSON.stringify(body), /MUST_NOT_LEAK/);
});

test('ready SRS reports rewrite readiness while explicitly refusing a DMARC delivery guarantee', async (t) => {
  const { base } = await listen(t, owner, {
    srsReady: true,
    forwardings: [{
      mailboxId: localMailbox.id,
      source: localMailbox.address,
      mode: 'redirect',
      destinations: ['outside@external.test'],
    }],
  });
  const response = await fetch(`${base}/api/mail-domains/${localMailDomain.id}/diagnostics`);
  assert.equal(response.status, 200);
  const body = await response.json();
  assert.deepEqual(body.data.diagnostics.forwardingDeliverability, {
    state: 'srs_ready',
    externalDestinationCount: 1,
    srsReady: true,
    deliveryAssurance: 'not_guaranteed',
    reasonCode: null,
    action: null,
  });
  assert.equal(body.data.attentionRequired, false);
  assert.equal(JSON.stringify(body).includes('guaranteed'), true);
  assert.equal(JSON.stringify(body).includes('MUST_NOT_LEAK'), false);
});

test('missing or failed SRS inspection remains fail-closed for external forwarding diagnostics', async (t) => {
  const forwarding = [{
    mailboxId: localMailbox.id,
    source: localMailbox.address,
    mode: 'copy',
    destinations: ['outside@external.test'],
  }];
  const unavailable = await listen(t, owner, { forwardings: forwarding, srsServiceAvailable: false });
  const unavailableResponse = await fetch(`${unavailable.base}/api/mail-domains/${localMailDomain.id}/diagnostics`);
  assert.equal(unavailableResponse.status, 200);
  assert.equal((await unavailableResponse.json()).data.diagnostics.forwardingDeliverability.reasonCode, 'mail_forwarding_srs_unavailable');

  const failed = await listen(t, owner, { forwardings: forwarding, srsInspectionFails: true });
  const failedResponse = await fetch(`${failed.base}/api/mail-domains/${localMailDomain.id}/diagnostics`);
  assert.equal(failedResponse.status, 200);
  const failedBody = await failedResponse.json();
  assert.equal(failedBody.data.diagnostics.forwardingDeliverability.state, 'inspection_error');
  assert.equal(failedBody.data.diagnostics.forwardingDeliverability.deliveryAssurance, 'not_guaranteed');
  assert.equal(failedBody.data.attentionRequired, true);
});

test('Read Only may read local mail diagnostics', async (t) => {
  const { base, calls } = await listen(t, readOnly);
  const response = await fetch(`${base}/api/mail-domains/${localMailDomain.id}/diagnostics`);
  assert.equal(response.status, 200);
  assert.equal(calls.some(([name]) => name === 'inspect'), true);
});

test('remote and external mail domains are rejected before DKIM, forwarding, SRS or diagnostics inspection', async (t) => {
  const { base, calls } = await listen(t, owner);

  const remote = await fetch(`${base}/api/mail-domains/${remoteMailDomain.id}/diagnostics`);
  assert.equal(remote.status, 404);
  assert.equal((await remote.json()).error.code, 'mail_domain_not_found');

  const external = await fetch(`${base}/api/mail-domains/${externalMailDomain.id}/diagnostics`);
  assert.equal(external.status, 409);
  assert.equal((await external.json()).error.code, 'mail_diagnostics_local_domain_required');
  assert.deepEqual(calls, []);
});

test('diagnostics rejects query parameters before reading any managed mail state', async (t) => {
  const { base, calls } = await listen(t, owner);
  const query = await fetch(`${base}/api/mail-domains/${localMailDomain.id}/diagnostics?refresh=true`);
  assert.equal(query.status, 400);
  assert.equal((await query.json()).error.code, 'mail_diagnostics_query_invalid');
  assert.deepEqual(calls, []);
});
