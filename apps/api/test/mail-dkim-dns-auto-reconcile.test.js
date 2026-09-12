import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import express from 'express';
import test from 'node:test';
import { mountMailDkimRoutes } from '../src/mail-dkim-http.js';
import { MailDkimHttpError } from '../src/mail-dkim-http.js';
import { MailDkimRegistryError } from '../src/mail-dkim-registry.js';
import { JobRegistryError } from '../src/job-registry.js';

const serverId = randomUUID();
const webDomain = { id: randomUUID(), serverId, primaryDomain: 'example.com' };
const mailDomain = {
  id: randomUUID(),
  webDomainId: webDomain.id,
  domainName: 'example.com',
  managementMode: 'local',
  status: 'enabled',
};
const owner = Object.freeze({
  user: { role: 'owner' },
  access: { mode: 'management', permissions: ['*'] },
  security: { managementAllowed: true },
});

async function listen(t) {
  const calls = [];
  const app = express();
  app.use(express.json());
  app.use((request, _response, next) => { request.auth = owner; next(); });
  mountMailDkimRoutes(app, {
    localServerId: serverId,
    mailDomainRegistry: {
      async getMailDomain(id) { return id === mailDomain.id ? mailDomain : null; },
    },
    domainRegistry: {
      async getDomain(id) { return id === webDomain.id ? webDomain : null; },
    },
    mailDkimRegistry: {
      async getKey() { return null; },
      async createKey() { throw new Error('not used'); },
      async rotateKey(id, input) {
        calls.push(['rotate', id, structuredClone(input)]);
        return { mailDomainId: id, selector: input.selector, revision: input.expectedRevision + 1 };
      },
    },
    mailDkimRetirementRegistry: {
      async getRetirement() { return null; },
      async prepareRotation(id, input) {
        calls.push(['prepare', id, structuredClone(input)]);
      },
      async confirmRotation(id) {
        calls.push(['confirm', id]);
        return { mailDomainId: id, previousSelector: 'old', phase: 'dns_retirement_pending', revision: 2 };
      },
    },
    mailDkimDnsService: {
      async reconcileRetirement(id) {
        calls.push(['reconcile', id]);
        return { pending: false, cleared: true };
      },
    },
    mailDkimConfigurationService: {
      async previewApply() { throw new Error('not used'); },
    },
    jobRegistry: {
      async listJobs(filter) { calls.push(['listJobs', structuredClone(filter)]); return []; },
      async enqueue() { throw new Error('not used'); },
    },
  });
  app.use((error, _request, response, _next) => {
    const known = error instanceof MailDkimHttpError
      || error instanceof MailDkimRegistryError
      || error instanceof JobRegistryError;
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

test('rotation reconciles provider retirement evidence before preparing the next selector', async (t) => {
  const { base, calls } = await listen(t);
  const response = await fetch(`${base}/api/mail-domains/${mailDomain.id}/dkim/rotate`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ expectedRevision: 2, selector: 'mail-next' }),
  });
  assert.equal(response.status, 200);
  assert.deepEqual(calls.map(([name]) => name), [
    'listJobs',
    'reconcile',
    'prepare',
    'rotate',
    'confirm',
  ]);
});
