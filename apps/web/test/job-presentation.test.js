import assert from 'node:assert/strict';
import test from 'node:test';
import {
  jobLifecycle,
  jobResourceTarget,
  jobSupportsDeployLogs,
  safeJobResultMetadata,
} from '../src/workspace/job-presentation.js';

test('job resource links prefer exact linked site routes when available', () => {
  const applicationId = '11111111-1111-4111-8111-111111111111';
  const websiteId = '22222222-2222-4222-8222-222222222222';
  const domainId = '33333333-3333-4333-8333-333333333333';
  const certificateId = '44444444-4444-4444-8444-444444444444';
  const resources = {
    websites: [{ id: websiteId, applicationId }],
    domains: [{ id: domainId, websiteId, certificateId }],
  };
  assert.deepEqual(jobResourceTarget({ resourceType: 'application', resourceId: applicationId }, resources), {
    label: 'Uygulama', href: `/websites/${domainId}/node`,
  });
  assert.deepEqual(jobResourceTarget({ resourceType: 'certificate', resourceId: certificateId }, resources), {
    label: 'Sertifika', href: `/websites/${domainId}/ssl`,
  });
  assert.deepEqual(jobResourceTarget({ resourceType: 'mail_domain', resourceId: domainId }), {
    label: 'Mail domain', href: `/mail/${domainId}`,
  });
  assert.deepEqual(jobResourceTarget({ resourceType: 'docker_project', resourceId: domainId }), {
    label: 'Docker projesi', href: `/docker/${domainId}`,
  });
});

test('job lifecycle reports queue, running and terminal progress without invented percentages', () => {
  assert.deepEqual(jobLifecycle({ status: 'queued' }), {
    stage: 'Kuyrukta', progress: '1 / 3', detail: 'Sunucu yürütücüsü işi henüz üstlenmedi.',
  });
  assert.equal(jobLifecycle({ status: 'running' }).progress, '2 / 3');
  assert.equal(jobLifecycle({ status: 'succeeded' }).progress, '3 / 3');
  assert.equal(jobLifecycle({ status: 'failed' }).stage, 'Başarısız');
});

test('safe job metadata exposes only bounded allowlisted scalars', () => {
  const metadata = safeJobResultMetadata({ result: {
    commitSha: 'a'.repeat(40),
    healthy: true,
    port: 3000,
    privateKey: 'do-not-render',
    environment: { SECRET: 'do-not-render' },
    status: 'validated',
    serviceName: 'yunpanel-node-deadbeef.service',
    ignoredLongValue: 'x'.repeat(300),
  } });
  assert.deepEqual(metadata, [
    ['Sonuç', 'validated'],
    ['Servis', 'yunpanel-node-deadbeef.service'],
    ['Commit', 'a'.repeat(40)],
    ['Port', 3000],
    ['Sağlık', 'Evet'],
  ]);
  assert.equal(JSON.stringify(metadata).includes('do-not-render'), false);
});

test('only deployment jobs expose deploy log surface', () => {
  assert.equal(jobSupportsDeployLogs({ operation: 'app.static.deploy' }), true);
  assert.equal(jobSupportsDeployLogs({ operation: 'app.node.deploy' }), true);
  assert.equal(jobSupportsDeployLogs({ operation: 'mail.config.apply' }), false);
});
