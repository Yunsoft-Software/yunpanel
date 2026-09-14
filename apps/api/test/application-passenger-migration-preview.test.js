import assert from 'node:assert/strict';
import test from 'node:test';
import { createApplicationPassengerMigrationPreviewService } from '../src/application-passenger-migration-preview.js';

const applicationId = '9d4a4727-1aba-4d35-95fe-21db67042ce9';
const websiteId = '5c1c0247-139f-45d2-a6ac-c8a4bb00bc75';
const domainId = 'f05764d6-d5e8-4d2a-9bdd-493111b24478';
const releaseId = 'ff830043-9752-4640-83b4-3a1998de78a0';
const serverId = '57f8611c-0af7-4d2f-8291-2fe7dbab22fe';
const runtime = Object.freeze({
  nodeMajor: 24,
  port: 3100,
  start: Object.freeze({ mode: 'node', entryFile: 'server.js' }),
  healthPath: '/health',
});
const application = Object.freeze({
  id: applicationId,
  serverId,
  type: 'node',
  currentReleaseId: releaseId,
  activeRuntime: runtime,
  activeDeploymentId: null,
  desiredRevision: 2,
  appliedRevision: 2,
});
const website = Object.freeze({
  id: websiteId,
  serverId,
  applicationId,
  runtimeType: 'node',
  revision: 3,
});
const domain = Object.freeze({
  id: domainId,
  serverId,
  websiteId,
  primaryDomain: 'example.com',
  aliases: Object.freeze(['www.example.com']),
  state: 'active',
  desiredRevision: 4,
  appliedRevision: 4,
  httpsMode: 'off',
  targetType: 'proxy',
  target: Object.freeze({ upstreamHost: '127.0.0.1', upstreamPort: 3100, websocket: true }),
});

function defaultHostResult() {
  return {
    applicationId,
    releaseId,
    mode: 'read-only',
    mutationPerformed: false,
    source: {
      serviceName: 'yunpanel-node-example.service',
      releaseId,
      activeState: 'active',
      healthy: true,
      port: 3100,
      healthPath: '/health',
    },
    environment: { present: true, sha256: 'a'.repeat(64) },
    target: {
      intent: { appRoot: `/var/lib/yunpanel/apps/${applicationId}/current` },
      inspection: { satisfied: true, nodeBinary: '/usr/bin/node' },
      environmentBinding: {
        satisfied: true,
        sourcePath: `/etc/yunpanel/apps/${applicationId}.env`,
        environmentInclude: `/etc/nginx/yunpanel/passenger-env/${applicationId}.conf`,
        includeSha256: 'b'.repeat(64),
      },
    },
    ready: true,
    blockers: [],
  };
}

function service({ domains = [domain], hostResult = null, currentApplication = application } = {}) {
  const calls = [];
  const preview = createApplicationPassengerMigrationPreviewService({
    applicationRegistry: { async getApplication() { return currentApplication; } },
    websiteRegistry: { async listWebsites() { return [website]; } },
    domainRegistry: { async listDomains() { return domains; } },
    hostPreview: {
      async preview(spec) {
        calls.push(spec);
        return hostResult ?? defaultHostResult();
      },
    },
    localServerId: serverId,
  });
  return { preview, calls };
}

test('control-plane Passenger preview is read-only and binds persisted application, website and domain state', async () => {
  const { preview, calls } = service();
  const result = await preview.preview(applicationId);
  assert.equal(result.ready, true);
  assert.equal(result.mode, 'read-only');
  assert.equal(result.mutationPerformed, false);
  assert.equal(result.website.websiteId, websiteId);
  assert.equal(result.website.revision, 3);
  assert.equal(result.domain.domainId, domainId);
  assert.equal(result.domain.appliedRevision, 4);
  assert.match(result.previewDigest, /^[a-f0-9]{64}$/);
  assert.equal(result.confirmation, `migrate-node-passenger:${applicationId}:${result.previewDigest}`);
  assert.deepEqual(calls, [{ applicationId, releaseId, runtime }]);
});

test('Passenger preview digest is deterministic for the same control-plane and host evidence', async () => {
  const first = await service().preview.preview(applicationId);
  const second = await service().preview.preview(applicationId);
  assert.equal(first.previewDigest, second.previewDigest);
  assert.equal(first.confirmation, second.confirmation);
});

test('Passenger preview digest changes when the applied Application revision changes', async () => {
  const first = await service().preview.preview(applicationId);
  const changed = Object.freeze({ ...application, desiredRevision: 3, appliedRevision: 3 });
  const second = await service({ currentApplication: changed }).preview.preview(applicationId);
  assert.notEqual(first.previewDigest, second.previewDigest);
});

test('control-plane Passenger preview blocks multiple independent Domain routes before cutover', async () => {
  const second = {
    ...domain,
    id: '8d988625-d719-4fea-807b-3129894c5f85',
    primaryDomain: 'api.example.com',
    aliases: [],
  };
  const { preview } = service({ domains: [domain, second] });
  const result = await preview.preview(applicationId);
  assert.equal(result.ready, false);
  assert.equal(result.domain, null);
  assert.ok(result.blockers.some((entry) => entry.code === 'multiple_domain_routes_unsupported'));
});

test('control-plane Passenger preview blocks stale or non-systemd proxy routes', async () => {
  const { preview } = service({
    domains: [{
      ...domain,
      state: 'draft',
      appliedRevision: 3,
      target: { ...domain.target, upstreamPort: 3200 },
    }],
  });
  const result = await preview.preview(applicationId);
  assert.equal(result.ready, false);
  assert.ok(result.blockers.some((entry) => entry.code === 'domain_route_not_current'));
  assert.ok(result.blockers.some((entry) => entry.code === 'legacy_proxy_route_mismatch'));
});

test('control-plane Passenger preview reports host inspection failure without mutating state', async () => {
  const preview = createApplicationPassengerMigrationPreviewService({
    applicationRegistry: { async getApplication() { return application; } },
    websiteRegistry: { async listWebsites() { return [website]; } },
    domainRegistry: { async listDomains() { return [domain]; } },
    hostPreview: { async preview() { const error = new Error('no systemd'); error.code = 'systemd_not_available'; throw error; } },
    localServerId: serverId,
  });
  const result = await preview.preview(applicationId);
  assert.equal(result.ready, false);
  assert.ok(result.blockers.some((entry) => entry.code === 'host_preview_failed' && entry.detail === 'systemd_not_available'));
  assert.match(result.previewDigest, /^[a-f0-9]{64}$/);
});
