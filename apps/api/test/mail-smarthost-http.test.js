import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { once } from 'node:events';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import express from 'express';
import { MailSmarthostError } from '@yunpanel/host-runtime';
import { mountMailSmarthostRoutes } from '../src/mail-smarthost-http.js';
import { createMailSmarthostRegistry } from '../src/mail-smarthost-registry.js';
import { ownerManagementContext, withPanelContext } from './helpers/panel-auth-fixture.js';

const SERVER_ID = '6f2cc8d7-995f-4c20-b9a8-e2ce07b760d7';
const customer = Object.freeze({
  user: Object.freeze({ id: 'customer-1', username: 'cust', role: 'customer', hosting: { kind: 'customer' }, websiteIds: [] }),
  security: Object.freeze({ ownerMfaRequired: false, enrollmentRequired: false, managementAllowed: true }),
  access: Object.freeze({ mode: 'site_management', permissions: Object.freeze(['sites.manage']) }),
});
const body = { host: 'smtp.mailgun.org', port: 587, username: 'postmaster@mg.example.com', password: 'Gizli!Parola123', confirmation: 'smarthost-apply' };

// The host side (postconf/postmap/postfix) is verified against real Postfix in
// packages/host-runtime/test/mail-smarthost-manager.test.js; here the manager only records calls.
function recordingManager({ failWith = null } = {}) {
  const calls = [];
  return { calls, async apply(plan) { calls.push(['apply', plan]); if (failWith) throw failWith; },
    async disable() { calls.push(['disable']); }, async status() { return { relayhost: null }; } };
}

async function serve(t, { context = ownerManagementContext, manager = recordingManager() } = {}) {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'yp-smarthost-http-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const filePath = path.join(directory, 'mail-smarthost.json');
  const smarthostRegistry = createMailSmarthostRegistry({ filePath, masterKey: randomBytes(32) });
  const events = [];
  const app = express();
  app.use(express.json());
  mountMailSmarthostRoutes(app, { registry: { getServer: async id => id === SERVER_ID ? { id, executionMode: 'local' } : null },
    localServerId: SERVER_ID, smarthostRegistry, smarthostManager: manager, audit: { record: async event => events.push(event) } });
  app.use((error, request, response, next) => response.status(error.status ?? 500).json({ error: { code: error.code ?? 'error' } }));
  let current = context;
  const server = http.createServer(withPanelContext(app, () => current)).listen(0, '127.0.0.1');
  await once(server, 'listening');
  t.after(() => new Promise(resolve => { server.closeAllConnections(); server.close(resolve); }));
  const base = `http://127.0.0.1:${server.address().port}/api/servers/${SERVER_ID}/mail/smarthost`;
  const call = async (method, payload) => {
    const response = await fetch(base, { method, headers: { 'content-type': 'application/json' }, body: payload ? JSON.stringify(payload) : undefined });
    return { status: response.status, body: await response.json() };
  };
  return { call, manager, events, filePath, as: value => { current = value; } };
}

test('an Owner applies a relay: the plan reaches the host, the password is sealed and never returned', async (t) => {
  const f = await serve(t);
  const saved = await f.call('PUT', body);
  assert.equal(saved.status, 200);
  assert.equal(JSON.stringify(saved.body).includes('Gizli'), false);
  assert.equal(f.manager.calls[0][0], 'apply');
  assert.match(f.manager.calls[0][1].saslPasswd, /^\[smtp\.mailgun\.org\]:587 postmaster@mg\.example\.com:Gizli!Parola123\n$/);
  const read = await f.call('GET');
  assert.deepEqual({ ...read.body.data, updatedAt: undefined }, { configured: true, host: 'smtp.mailgun.org', port: 587,
    username: 'postmaster@mg.example.com', revision: 1, updatedAt: undefined, live: { relayhost: null } });
  assert.equal((await readFile(f.filePath, 'utf8')).includes('Gizli'), false, 'the password is encrypted at rest');
  assert.deepEqual(f.events.map(event => [event.action, event.outcome]), [['mail.smarthost.apply', 'success']]);
});

test('an empty password on edit keeps the stored one', async (t) => {
  const f = await serve(t);
  await f.call('PUT', body);
  const edited = await f.call('PUT', { ...body, port: 465, password: '' });
  assert.equal(edited.status, 200);
  assert.match(f.manager.calls[1][1].saslPasswd, /^\[smtp\.mailgun\.org\]:465 postmaster@mg\.example\.com:Gizli!Parola123\n$/);
  const first = await serve(t);
  assert.equal((await first.call('PUT', { ...body, password: '' })).body.error.code, 'smarthost_password_required');
});

test('changes need explicit confirmation and valid input', async (t) => {
  const f = await serve(t);
  assert.equal((await f.call('PUT', { ...body, confirmation: undefined })).body.error.code, 'smarthost_confirmation_required');
  assert.equal((await f.call('PUT', { ...body, host: 'smtp.example.com\nrelayhost=evil' })).status, 400);
  assert.equal((await f.call('DELETE', {})).body.error.code, 'smarthost_confirmation_required');
  assert.equal(f.manager.calls.length, 0);
});

test('a failed host apply is not saved and is audited as a failure', async (t) => {
  const f = await serve(t, { manager: recordingManager({ failWith: new MailSmarthostError('smarthost_postfix_check_failed', 'rejected') }) });
  const result = await f.call('PUT', body);
  assert.notEqual(result.status, 200);
  assert.equal((await f.call('GET')).body.data.configured, false);
  assert.deepEqual(f.events.map(event => [event.outcome, event.code]), [['failure', 'smarthost_postfix_check_failed']]);
});

test('disable restores the host and forgets the credential', async (t) => {
  const f = await serve(t);
  await f.call('PUT', body);
  assert.equal((await f.call('DELETE', { confirmation: 'smarthost-disable' })).status, 200);
  assert.deepEqual(f.manager.calls.map(call => call[0]), ['apply', 'disable']);
  assert.equal((await f.call('GET')).body.data.configured, false);
});

test('only the Owner can read or change the relay', async (t) => {
  const f = await serve(t, { context: customer });
  for (const [method, payload] of [['GET'], ['PUT', body], ['DELETE', { confirmation: 'smarthost-disable' }]]) {
    assert.equal((await f.call(method, payload)).status, 403, method);
  }
  assert.equal(f.manager.calls.length, 0);
});
