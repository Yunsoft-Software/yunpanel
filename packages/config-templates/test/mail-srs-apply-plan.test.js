import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import test from 'node:test';
import {
  enableManagedMailSrs,
  MailApplyPlanError,
  mailSrsTemplatePolicy,
  previewManagedMailApplyPlan,
  previewManagedMailSubmissionConfiguration,
} from '../src/index.js';

const ARGON2ID_HASH = `$argon2id$v=19$m=65536,t=3,p=1$${Buffer.alloc(16, 41).toString('base64').replace(/=+$/, '')}$${Buffer.alloc(32, 42).toString('base64').replace(/=+$/, '')}`;
const SECRET_CONTENT = `${'Q'.repeat(43)}\n`;

function sha256(value) {
  return createHash('sha256').update(value).digest('hex');
}

function basePreview() {
  return previewManagedMailSubmissionConfiguration({
    domains: ['example.com'],
    mailboxes: ['owner@example.com'],
    accounts: [{ address: 'owner@example.com', passwordHash: ARGON2ID_HASH }],
    postmasterAddress: 'owner@example.com',
    forwardings: [{ source: 'owner@example.com', mode: 'copy', destinations: ['outside@gmail.com'] }],
  });
}

function srsPreview() {
  return enableManagedMailSrs(basePreview(), {
    domains: ['example.com'],
    forwardings: [{ source: 'owner@example.com', mode: 'copy', destinations: ['outside@gmail.com'] }],
    srsDomain: 'mail.example.com',
    secretRevision: 3,
    secretSha256: sha256(SECRET_CONTENT),
    secretBytes: Buffer.byteLength(SECRET_CONTENT),
  });
}

function commandIdentity(command) {
  return `${command.file} ${command.args.join(' ')}`;
}

test('SRS apply plan carries protected artifacts and exact PostSRSd restart and health without secret content', () => {
  const preview = srsPreview();
  const plan = previewManagedMailApplyPlan(preview);

  assert.equal(plan.srs.required, true);
  assert.equal(plan.srs.serviceUnit, mailSrsTemplatePolicy.serviceUnit);
  assert.deepEqual(plan.srs.removePostfixParameters, []);
  assert.equal(plan.requirements.includes(mailSrsTemplatePolicy.requirement), true);
  assert.equal(plan.artifacts.some((artifact) => artifact.path === mailSrsTemplatePolicy.defaultsPath && artifact.sensitive === false), true);
  assert.equal(plan.artifacts.some((artifact) => artifact.path === mailSrsTemplatePolicy.secretPath && artifact.sensitive === true), true);
  assert.deepEqual(plan.stages.configureSrs.map(commandIdentity), [
    `/usr/bin/systemctl restart ${mailSrsTemplatePolicy.serviceUnit}`,
  ]);
  assert.equal(plan.stages.health.map(commandIdentity).includes(
    `/usr/bin/systemctl is-active --quiet ${mailSrsTemplatePolicy.serviceUnit}`,
  ), true);
  assert.equal(plan.stages.configurePostfix.some((command) => command.args[1] === 'sender_canonical_maps = tcp:127.0.0.1:10001'), true);
  assert.equal(plan.stages.configurePostfix.some((command) => command.args[1] === 'recipient_canonical_maps = tcp:127.0.0.1:10002'), true);
  assert.equal(JSON.stringify(plan).includes(SECRET_CONTENT.trim()), false);
  assert.equal(JSON.stringify(plan).includes(ARGON2ID_HASH), false);
});

test('non-SRS apply plan explicitly removes all YunPanel SRS canonical overrides', () => {
  const plan = previewManagedMailApplyPlan(basePreview());
  assert.equal(plan.srs.required, false);
  assert.deepEqual(plan.srs.removePostfixParameters, [
    'recipient_canonical_classes',
    'recipient_canonical_maps',
    'sender_canonical_classes',
    'sender_canonical_maps',
  ]);
  assert.deepEqual(plan.stages.configureSrs.map(commandIdentity), [
    '/usr/sbin/postconf -X recipient_canonical_classes',
    '/usr/sbin/postconf -X recipient_canonical_maps',
    '/usr/sbin/postconf -X sender_canonical_classes',
    '/usr/sbin/postconf -X sender_canonical_maps',
  ]);
  assert.equal(plan.stages.health.some((command) => command.args.includes(mailSrsTemplatePolicy.serviceUnit)), false);
});

test('forged or incomplete SRS metadata is rejected before any executable plan is returned', () => {
  const preview = srsPreview();
  const forged = {
    ...preview,
    srs: { ...preview.srs, forwardEndpoint: 'tcp:0.0.0.0:10001' },
  };
  assert.throws(
    () => previewManagedMailApplyPlan(forged),
    (error) => error instanceof MailApplyPlanError && error.code === 'invalid_mail_srs_state',
  );
});
