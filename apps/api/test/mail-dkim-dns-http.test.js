import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import express from 'express';
import test from 'node:test';
import { MailDkimDnsError } from '../src/mail-dkim-dns.js';
import { MailDkimDnsHttpError, mountMailDkimDnsRoutes } from '../src/mail-dkim-dns-http.js';

const mailDomainId = randomUUID();
const previewDigest = 'a'.repeat(64);
const confirmation = `apply-mail-dkim-dns:${mailDomainId}:current:${previewDigest}`;
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

async function listen(t, auth, { immediate = false } = {}) {
  const calls = [];
  const app = express();
  app.use(express.json());
  app.use((request, _response, next) => { request.auth = auth; next(); });
  mountMailDkimDnsRoutes(app, {
    mailDkimDnsService: {
      async preview(input) {
        calls.push(['preview', structuredClone(input)]);
        return {
          kind: input.kind,
          expectedRevision: input.expectedRevision,
          previewDigest,
          confirmation,
          effect: 'create',
          sideEffects: false,
        };
      },
      async apply(input) {
        calls.push(['apply', structuredClone(input)]);
        return immediate
          ? {
              previewDigest,
              completed: true,
              job: null,
              retirementCleared: true,
              sideEffects: { dnsChanged: false },
            }
          : {
              previewDigest,
              completed: false,
              job: { id: 'dns-job-1', status: 'queued', operation: 'dns.record.apply' },
              retirementCleared: false,
              sideEffects: { dnsChanged: false },
            };
      },
      async reconcileRetirement(id) {
        calls.push(['reconcile', id]);
        return { pending: false, cleared: true };
      },
    },
  });
  app.use((error, _request, response, _next) => {
    const known = error instanceof MailDkimDnsError || error instanceof MailDkimDnsHttpError;
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

function post(base, suffix, body) {
  return fetch(`${base}/api/mail-domains/${mailDomainId}/dkim/${suffix}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
}

test('Owner previews and queues DKIM TXT through provider lifecycle', async (t) => {
  const { base, calls } = await listen(t, owner);
  const previewResponse = await post(base, 'dns-preview', { kind: 'current', expectedRevision: 2 });
  assert.equal(previewResponse.status, 200);
  const preview = (await previewResponse.json()).data;
  assert.equal(preview.previewDigest, previewDigest);

  const apply = await post(base, 'dns-apply', {
    kind: 'current',
    expectedRevision: 2,
    previewDigest,
    confirmation,
  });
  assert.equal(apply.status, 202);
  assert.equal((await apply.json()).data.job.operation, 'dns.record.apply');
  assert.deepEqual(calls, [
    ['preview', { mailDomainId, kind: 'current', expectedRevision: 2 }],
    ['apply', { mailDomainId, kind: 'current', expectedRevision: 2, previewDigest, confirmation }],
  ]);
});

test('already-absent retirement completes synchronously and reconcile is explicit mutation', async (t) => {
  const { base, calls } = await listen(t, owner, { immediate: true });
  const response = await post(base, 'dns-apply', {
    kind: 'retirement',
    expectedRevision: 2,
    previewDigest,
    confirmation,
  });
  assert.equal(response.status, 200);
  assert.equal((await response.json()).data.retirementCleared, true);

  const reconcile = await post(base, 'dns-reconcile', {});
  assert.equal(reconcile.status, 200);
  assert.deepEqual((await reconcile.json()).data, { pending: false, cleared: true });
  assert.deepEqual(calls.map(([name]) => name), ['apply', 'reconcile']);
});

test('Read Only cannot preview, mutate or reconcile provider DNS state', async (t) => {
  const { base, calls } = await listen(t, readOnly);
  assert.equal((await post(base, 'dns-preview', { kind: 'current', expectedRevision: 2 })).status, 403);
  assert.equal((await post(base, 'dns-apply', {
    kind: 'current', expectedRevision: 2, previewDigest, confirmation,
  })).status, 403);
  assert.equal((await post(base, 'dns-reconcile', {})).status, 403);
  assert.deepEqual(calls, []);
});

test('DKIM DNS HTTP rejects hidden fields before service access', async (t) => {
  const { base, calls } = await listen(t, owner);
  const response = await post(base, 'dns-preview', { kind: 'current', expectedRevision: 2, token: 'no' });
  assert.equal(response.status, 400);
  assert.equal((await response.json()).error.code, 'mail_dkim_dns_preview_input_invalid');
  assert.deepEqual(calls, []);
});
