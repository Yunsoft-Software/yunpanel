import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtemp, readFile, rm, stat } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import {
  createMailDkimRetirementRegistry,
  MailDkimRetirementRegistryError,
} from '../src/mail-dkim-retirement-registry.js';

const mailDomainId = randomUUID();
const PUBLIC_ONE = Buffer.alloc(256, 1).toString('base64');
const PUBLIC_TWO = Buffer.alloc(256, 2).toString('base64');

function key({ selector = 'mail-old', publicKey = PUBLIC_ONE, revision = 1 } = {}) {
  return {
    mailDomainId,
    domainName: 'example.com',
    selector,
    publicKey,
    revision,
  };
}

async function withTempDirectory(run) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'yunpanel-dkim-retirement-'));
  try { return await run(root); }
  finally { await rm(root, { recursive: true, force: true }); }
}

test('persists previous selector metadata privately and confirms committed rotation after restart', async () => withTempDirectory(async (root) => {
  const filePath = path.join(root, 'state', 'dkim-retirements.json');
  let current = key();
  const first = createMailDkimRetirementRegistry({
    filePath,
    now: () => Date.parse('2026-09-12T20:30:00.000Z'),
    getDkimKey: async () => current,
  });
  await first.init();
  const prepared = await first.prepareRotation(mailDomainId, {
    expectedKeyRevision: 1,
    targetSelector: 'mail-new',
  });
  assert.equal(prepared.phase, 'rotation_prepared');
  assert.equal(prepared.previousSelector, 'mail-old');
  assert.equal(prepared.previousDnsRecord.name, 'mail-old._domainkey.example.com');
  assert.equal((await stat(path.dirname(filePath))).mode & 0o777, 0o700);
  assert.equal((await stat(filePath)).mode & 0o777, 0o600);
  assert.doesNotMatch(await readFile(filePath, 'utf8'), /PRIVATE KEY/i);

  current = key({ selector: 'mail-new', publicKey: PUBLIC_TWO, revision: 2 });
  const reopened = createMailDkimRetirementRegistry({
    filePath,
    now: () => Date.parse('2026-09-12T20:31:00.000Z'),
    getDkimKey: async () => current,
  });
  await reopened.init();
  const pending = await reopened.getRetirement(mailDomainId);
  assert.equal(pending.phase, 'dns_retirement_pending');
  assert.equal(pending.previousKeyRevision, 1);
  assert.equal(pending.currentKeyRevision, 2);
  assert.equal(pending.revision, 2);
  assert.equal(pending.targetSelector, 'mail-new');
}));

test('restart drops a prepared retirement when key rotation never committed', async () => withTempDirectory(async (root) => {
  const filePath = path.join(root, 'dkim-retirements.json');
  const current = key();
  const first = createMailDkimRetirementRegistry({ filePath, getDkimKey: async () => current });
  await first.init();
  await first.prepareRotation(mailDomainId, { expectedKeyRevision: 1, targetSelector: 'mail-new' });

  const reopened = createMailDkimRetirementRegistry({ filePath, getDkimKey: async () => current });
  await reopened.init();
  assert.equal(await reopened.getRetirement(mailDomainId), null);
  assert.deepEqual(JSON.parse(await readFile(filePath, 'utf8')).retirements, []);
}));

test('pending DNS retirement blocks another rotation until exact confirmed clear', async () => {
  let current = key();
  const registry = createMailDkimRetirementRegistry({ getDkimKey: async () => current });
  await registry.init();
  await registry.prepareRotation(mailDomainId, { expectedKeyRevision: 1, targetSelector: 'mail-new' });
  current = key({ selector: 'mail-new', publicKey: PUBLIC_TWO, revision: 2 });
  const pending = await registry.confirmRotation(mailDomainId);
  assert.equal(pending.phase, 'dns_retirement_pending');

  await assert.rejects(
    registry.prepareRotation(mailDomainId, { expectedKeyRevision: 2, targetSelector: 'mail-third' }),
    (error) => error instanceof MailDkimRetirementRegistryError && error.code === 'mail_dkim_retirement_pending',
  );
  await assert.rejects(
    registry.clearRetirement(mailDomainId, {
      expectedRevision: pending.revision,
      confirmation: 'clear-dkim-retirement:wrong',
    }),
    (error) => error instanceof MailDkimRetirementRegistryError
      && error.code === 'mail_dkim_retirement_confirmation_mismatch',
  );
  const cleared = await registry.clearRetirement(mailDomainId, {
    expectedRevision: pending.revision,
    confirmation: `clear-dkim-retirement:${mailDomainId}:mail-old:${pending.revision}`,
  });
  assert.equal(cleared.previousSelector, 'mail-old');
  assert.equal(await registry.getRetirement(mailDomainId), null);
});

test('ambiguous current key drift fails closed instead of discarding retirement evidence', async () => withTempDirectory(async (root) => {
  const filePath = path.join(root, 'dkim-retirements.json');
  let current = key();
  const first = createMailDkimRetirementRegistry({ filePath, getDkimKey: async () => current });
  await first.init();
  await first.prepareRotation(mailDomainId, { expectedKeyRevision: 1, targetSelector: 'mail-new' });

  current = key({ selector: 'unexpected', publicKey: PUBLIC_TWO, revision: 3 });
  const reopened = createMailDkimRetirementRegistry({ filePath, getDkimKey: async () => current });
  await assert.rejects(
    reopened.init(),
    (error) => error instanceof MailDkimRetirementRegistryError
      && error.code === 'mail_dkim_retirement_state_invalid',
  );
});
