import assert from 'node:assert/strict';
import test from 'node:test';
import { createDockerStorageBackupView } from '../src/docker-storage-backup-view.js';

const serverId = '6f2cc8d7-995f-4c20-b9a8-e2ce07b760d7';
const projectId = '0bb78242-03a6-429f-9d17-7725c521437c';

function project(revision = 3) {
  return {
    id: projectId,
    serverId,
    projectName: 'shop_app',
    revision,
    services: [{
      name: 'web',
      storageMounts: [
        { kind: 'named_volume', source: 'data', sourceScope: 'project', target: '/data', readOnly: false },
        { kind: 'bind', source: './config', sourceScope: 'project', target: '/app/config', readOnly: true },
        { kind: 'bind', source: '/srv/shared', sourceScope: 'host', target: '/shared', readOnly: false },
        { kind: 'ephemeral', source: null, sourceScope: null, target: '/run/cache', readOnly: false },
      ],
    }],
  };
}

test('Docker storage backup view exposes the manifest policy without mutating Compose desired state', () => {
  const source = project();
  const before = JSON.stringify(source);
  const view = createDockerStorageBackupView(source);

  assert.equal(view.manifestVersion, 1);
  assert.equal(view.serverId, serverId);
  assert.equal(view.projectId, projectId);
  assert.equal(view.projectRevision, 3);
  assert.deepEqual(view.counts, { total: 4, included: 2, excluded: 1, rejected: 1 });
  assert.equal(view.resources.every((resource) => resource.identity.startsWith('docker-storage:')), true);
  assert.equal(view.resources.find((resource) => resource.storage.source === '/srv/shared').policy.disposition, 'reject');
  assert.equal(view.resources.find((resource) => resource.storage.kind === 'ephemeral').policy.disposition, 'exclude');
  assert.equal(JSON.stringify(source), before);
});

test('Docker storage backup view keeps resource identity stable while reporting the current project revision', () => {
  const first = createDockerStorageBackupView(project(3));
  const second = createDockerStorageBackupView(project(4));

  assert.equal(first.projectRevision, 3);
  assert.equal(second.projectRevision, 4);
  assert.deepEqual(
    first.resources.map((resource) => resource.identity),
    second.resources.map((resource) => resource.identity),
  );
});
