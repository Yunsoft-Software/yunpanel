import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import express from 'express';
import test from 'node:test';
import { MailDataHttpError, mountMailDataRoutes } from '../src/mail-data-http.js';

const mailboxId = randomUUID();
const mailDomainId = randomUUID();
const digest = 'a'.repeat(64);
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

async function listen(t, auth) {
  const calls = [];
  const service = {
    async previewBackup(input) {
      calls.push(['previewBackup', structuredClone(input)]);
      return { expectedRevision: 2, previewDigest: digest, confirmation: 'backup-confirmation', sideEffects: false };
    },
    async queueBackup(input) {
      calls.push(['queueBackup', structuredClone(input)]);
      return { previewDigest: input.expectedPreviewDigest, job: { id: randomUUID(), status: 'queued' } };
    },
    async previewRestore(input) {
      calls.push(['previewRestore', structuredClone(input)]);
      return { expectedRevision: 2, previewDigest: digest, confirmation: 'restore-confirmation', sideEffects: false };
    },
    async queueRestore(input) {
      calls.push(['queueRestore', structuredClone(input)]);
      return { previewDigest: input.expectedPreviewDigest, job: { id: randomUUID(), status: 'queued' } };
    },
    async previewDelete(input) {
      calls.push(['previewDelete', structuredClone(input)]);
      return { expectedRevision: 2, previewDigest: digest, confirmation: 'delete-confirmation', sideEffects: false };
    },
    async queueDelete(input) {
      calls.push(['queueDelete', structuredClone(input)]);
      return { previewDigest: input.expectedPreviewDigest, job: { id: randomUUID(), status: 'queued' } };
    },
  };
  const app = express();
  app.use(express.json());
  app.use((request, _response, next) => { request.auth = auth; next(); });
  mountMailDataRoutes(app, { mailDataOperationsService: service });
  app.use((error, _request, response, _next) => {
    const known = error instanceof MailDataHttpError;
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

test('Owner previews and queues mailbox backup with exact request shape', async (t) => {
  const { base, calls } = await listen(t, owner);
  const preview = await fetch(`${base}/api/mailboxes/${mailboxId}/data/backup-preview`);
  assert.equal(preview.status, 200);
  const previewBody = (await preview.json()).data;
  assert.equal(previewBody.sideEffects, false);

  const queued = await fetch(`${base}/api/mailboxes/${mailboxId}/data/backup`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      expectedRevision: previewBody.expectedRevision,
      expectedPreviewDigest: previewBody.previewDigest,
      confirmation: previewBody.confirmation,
    }),
  });
  assert.equal(queued.status, 202);
  assert.deepEqual(calls, [
    ['previewBackup', { scope: 'mailbox', resourceId: mailboxId }],
    ['queueBackup', {
      scope: 'mailbox',
      resourceId: mailboxId,
      expectedRevision: 2,
      expectedPreviewDigest: digest,
      confirmation: 'backup-confirmation',
    }],
  ]);
});

test('Owner previews and queues domain restore with selected backup id', async (t) => {
  const { base, calls } = await listen(t, owner);
  const preview = await fetch(`${base}/api/mail-domains/${mailDomainId}/data/restore-preview`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ backupId: 'mail-backup-0001' }),
  });
  assert.equal(preview.status, 200);
  const previewBody = (await preview.json()).data;

  const queued = await fetch(`${base}/api/mail-domains/${mailDomainId}/data/restore`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      backupId: 'mail-backup-0001',
      expectedRevision: previewBody.expectedRevision,
      expectedPreviewDigest: previewBody.previewDigest,
      confirmation: previewBody.confirmation,
    }),
  });
  assert.equal(queued.status, 202);
  assert.deepEqual(calls, [
    ['previewRestore', { scope: 'domain', resourceId: mailDomainId, backupId: 'mail-backup-0001' }],
    ['queueRestore', {
      scope: 'domain',
      resourceId: mailDomainId,
      backupId: 'mail-backup-0001',
      expectedRevision: 2,
      expectedPreviewDigest: digest,
      confirmation: 'restore-confirmation',
    }],
  ]);
});

test('Owner previews and queues mailbox data delete with selected verified backup id', async (t) => {
  const { base, calls } = await listen(t, owner);
  const preview = await fetch(`${base}/api/mailboxes/${mailboxId}/data/delete-preview`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ backupId: 'mail-backup-0001' }),
  });
  assert.equal(preview.status, 200);
  const previewBody = (await preview.json()).data;

  const queued = await fetch(`${base}/api/mailboxes/${mailboxId}/data/delete`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      backupId: 'mail-backup-0001',
      expectedRevision: previewBody.expectedRevision,
      expectedPreviewDigest: previewBody.previewDigest,
      confirmation: previewBody.confirmation,
    }),
  });
  assert.equal(queued.status, 202);
  assert.deepEqual(calls, [
    ['previewDelete', { scope: 'mailbox', resourceId: mailboxId, backupId: 'mail-backup-0001' }],
    ['queueDelete', {
      scope: 'mailbox',
      resourceId: mailboxId,
      backupId: 'mail-backup-0001',
      expectedRevision: 2,
      expectedPreviewDigest: digest,
      confirmation: 'delete-confirmation',
    }],
  ]);
});

test('mail data routes reject extra fields and query parameters before service execution', async (t) => {
  const { base, calls } = await listen(t, owner);
  const query = await fetch(`${base}/api/mailboxes/${mailboxId}/data/backup-preview?refresh=true`);
  assert.equal(query.status, 400);
  assert.equal((await query.json()).error.code, 'mail_data_query_invalid');

  const extra = await fetch(`${base}/api/mailboxes/${mailboxId}/data/delete-preview`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ backupId: 'mail-backup-0001', privatePath: '/forbidden' }),
  });
  assert.equal(extra.status, 400);
  assert.equal((await extra.json()).error.code, 'mail_data_delete_preview_input_invalid');
  assert.deepEqual(calls, []);
});

test('Read Only may inspect backup preview but cannot queue backup restore or delete', async (t) => {
  const { base, calls } = await listen(t, readOnly);
  const preview = await fetch(`${base}/api/mailboxes/${mailboxId}/data/backup-preview`);
  assert.equal(preview.status, 200);
  const mutation = await fetch(`${base}/api/mailboxes/${mailboxId}/data/delete`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      backupId: 'mail-backup-0001',
      expectedRevision: 2,
      expectedPreviewDigest: digest,
      confirmation: 'delete-confirmation',
    }),
  });
  assert.equal(mutation.status, 403);
  assert.deepEqual(calls, [['previewBackup', { scope: 'mailbox', resourceId: mailboxId }]]);
});