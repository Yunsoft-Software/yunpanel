import test from 'node:test';
import assert from 'node:assert/strict';
import { OPERATIONS } from '@yunpanel/protocol';
import { createDockerVolumeManager } from '@yunpanel/host-runtime';
import { createDockerComposeRemoval } from '../src/docker/docker-compose-removal.js';

const projectId = '0bb78242-03a6-429f-9d17-7725c521437c';
const serverId = '6f2cc8d7-995f-4c20-b9a8-e2ce07b760d7';
const payload = { projectId, projectName: 'owned-project', expectedProjectRevision: 3,
  expectedEnvironmentRevision: 2, expectedComposeSha256: 'a'.repeat(64), credentialRevisions: [] };
function fixture({ bound = false, absent = true, stale = false, interrupt = false } = {}) {
  const calls = [];
  let project = { id: projectId, serverId, projectName: payload.projectName,
    revision: stale ? 4 : 3, composeSha256: payload.expectedComposeSha256 };
  let environment = true, credentials = true, failOnce = interrupt;
  const service = createDockerComposeRemoval({
    websiteRegistry: { listWebsites: async () => bound ? [{ managedComposeBinding: { projectId } }] : [] },
    observer: { inspectRemoved: async ({ projectName }) => {
      calls.push('observe'); assert.equal(projectName, payload.projectName); return { absent };
    } },
    projectRegistry: { getProject: async () => project, removeProject: async () => { calls.push('project'); project = null; } },
    environmentRegistry: { removeForProject: async () => {
      calls.push('environment'); environment = false;
      if (failOnce) { failOnce = false; throw new Error('lost environment acknowledgement'); }
    } },
    credentialRegistry: { removeForProject: async () => { calls.push('credentials'); credentials = false; } },
  });
  const job = { operation: OPERATIONS.DOCKER_COMPOSE_REMOVE, serverId, payload,
    authorize: async () => { calls.push('authorize'); } };
  return { service, calls, job, get state() { return { project, environment, credentials }; } };
}
test('bound Websites block project removal before any resource or metadata mutation', async () => {
  const f = fixture({ bound: true });
  await assert.rejects(f.service.authorize(payload, f.job), { code: 'docker_compose_project_in_use' });
  assert.deepEqual(f.calls, ['authorize']); assert.ok(f.state.project);
});
test('metadata retirement requires observed container and network absence', async () => {
  const f = fixture({ absent: false });
  await assert.rejects(f.service.finalize(f.job), { code: 'docker_compose_removal_unverified' });
  assert.deepEqual(f.calls, ['authorize', 'observe']);
  assert.ok(f.state.project); assert.equal(f.state.environment, true); assert.equal(f.state.credentials, true);
});
test('a changed project is preserved even after its old runtime is absent', async () => {
  const f = fixture({ stale: true });
  await assert.rejects(f.service.finalize(f.job), { code: 'docker_compose_preview_stale' });
  assert.deepEqual(f.calls, ['authorize', 'observe']); assert.equal(f.state.project.revision, 4);
});
test('interrupted metadata retirement resumes after observation and removes the project last', async () => {
  const f = fixture({ interrupt: true });
  await assert.rejects(f.service.finalize(f.job)); assert.ok(f.state.project); assert.equal(f.state.credentials, true);
  await f.service.finalize(f.job);
  assert.deepEqual(f.calls, ['authorize', 'observe', 'environment', 'authorize', 'observe', 'environment', 'credentials', 'project']);
  assert.deepEqual(f.state, { project: null, environment: false, credentials: false });
});
test('revoked authorization preserves all project metadata', async () => {
  const f = fixture();
  f.job.authorize = async () => { throw Object.assign(new Error('revoked'), { code: 'panel_job_actor_forbidden' }); };
  await assert.rejects(f.service.finalize(f.job), { code: 'panel_job_actor_forbidden' });
  assert.deepEqual(f.calls, []); assert.ok(f.state.project);
});

// T969: named volumes must be listed in the removal preview and deleted only on
// explicit opt-in, through the same verified single-volume safety checks. The
// real host-runtime volume manager runs against a scripted Docker CLI.
function fakeDockerHost(initial) {
  const volumes = new Map(initial.map((volume) => [volume.Name, { ...volume }]));
  const commands = [];
  const missing = () => Object.assign(new Error('Error: No such volume'), { stderr: 'Error response from daemon: No such volume' });
  async function execFn(_binary, args) {
    const command = args.slice(2);
    commands.push(command.join(' '));
    if (command[0] === 'volume' && command[1] === 'inspect') {
      const volume = volumes.get(command.at(-1));
      if (!volume) throw missing();
      return { stdout: JSON.stringify(volume), stderr: '' };
    }
    if (command[0] === 'ps') return { stdout: '', stderr: '' };
    if (command[0] === 'volume' && command[1] === 'rm') {
      if (!volumes.delete(command.at(-1))) throw missing();
      return { stdout: '', stderr: '' };
    }
    throw new Error(`unexpected docker command ${command.join(' ')}`);
  }
  return { volumes, commands, execFn };
}

function hostVolume(projectName, volumeKey, createdAt = '2026-11-06T10:00:00Z') {
  return {
    Name: `${projectName}_${volumeKey}`,
    Driver: 'local',
    Scope: 'local',
    Mountpoint: `/var/lib/docker/volumes/${projectName}_${volumeKey}/_data`,
    Options: null,
    CreatedAt: createdAt,
    Labels: { 'com.docker.compose.project': projectName, 'com.docker.compose.volume': volumeKey },
  };
}

function volumeFixture({ extraHostVolumes = [], otherProjects = [] } = {}) {
  const calls = [];
  const host = fakeDockerHost([hostVolume(payload.projectName, 'data'), hostVolume(payload.projectName, 'cache'), ...extraHostVolumes]);
  let project = {
    id: projectId, serverId, projectName: payload.projectName, revision: 3, composeSha256: payload.expectedComposeSha256,
    volumeDetails: [
      { name: 'cache', scope: 'project', external: false, runtimeName: `${payload.projectName}_cache` },
      { name: 'data', scope: 'project', external: false, runtimeName: `${payload.projectName}_data` },
      { name: 'never', scope: 'project', external: false, runtimeName: `${payload.projectName}_never` },
      { name: 'shared', scope: 'external', external: true, runtimeName: 'shared_uploads' },
    ],
  };
  const service = createDockerComposeRemoval({
    websiteRegistry: { listWebsites: async () => [] },
    observer: { inspectRemoved: async () => { calls.push('observe'); return { absent: true }; } },
    projectRegistry: {
      getProject: async () => project,
      listProjects: async () => [project, ...otherProjects].filter(Boolean),
      removeProject: async () => { calls.push('project'); project = null; },
    },
    environmentRegistry: { removeForProject: async () => { calls.push('environment'); } },
    credentialRegistry: { removeForProject: async () => { calls.push('credentials'); } },
    volumeManager: createDockerVolumeManager({ dockerPath: '/usr/bin/docker', accessFn: async () => {}, execFn: host.execFn }),
  });
  return { service, calls, host, get project() { return project; } };
}

function removalJob(volumes) {
  return {
    operation: OPERATIONS.DOCKER_COMPOSE_REMOVE,
    serverId,
    authorize: async () => {},
    payload: { ...payload, ...(volumes ? { deleteVolumes: true, volumes } : {}) },
  };
}

function pinsOf(preview) {
  return preview.volumes.filter((volume) => volume.deletable)
    .map(({ volumeKey, volumeName, fingerprint }) => ({ volumeKey, volumeName, volumeFingerprint: fingerprint }));
}

test('removal preview lists every named project volume with host presence and deletability', async () => {
  const f = volumeFixture();
  const preview = await f.service.preview({ projectId, projectName: payload.projectName, serverId });
  assert.equal(preview.ready, true);
  assert.deepEqual(preview.volumes.map((volume) => [volume.volumeKey, volume.volumeName, volume.present, volume.deletable, volume.blockCode]), [
    ['cache', 'owned-project_cache', true, true, null],
    ['data', 'owned-project_data', true, true, null],
    ['never', 'owned-project_never', false, false, 'docker_volume_not_found'],
    ['shared', 'shared_uploads', null, false, 'docker_volume_external_forbidden'],
  ]);
  for (const volume of preview.volumes.filter((item) => item.deletable)) assert.match(volume.fingerprint, /^[a-f0-9]{64}$/);
  assert.ok(preview.volumes.filter((item) => !item.deletable).every((item) => item.fingerprint === null && typeof item.blockReason === 'string'));
  assert.equal(f.host.commands.some((command) => command.startsWith('volume rm')), false);
});

test('removal preview keeps a volume referenced by another managed project', async () => {
  const other = { id: '7bb78242-03a6-429f-9d17-7725c521437c', serverId, projectName: 'other-project', revision: 1,
    volumeDetails: [{ name: 'owned-project_data', scope: 'external', external: true, runtimeName: 'owned-project_data' }] };
  const f = volumeFixture({ otherProjects: [other] });
  const preview = await f.service.preview({ projectId, projectName: payload.projectName, serverId });
  const data = preview.volumes.find((volume) => volume.volumeKey === 'data');
  assert.equal(data.deletable, false);
  assert.equal(data.blockCode, 'docker_volume_cross_project_referenced');
});

test('default removal keeps named volumes on the host while retiring metadata', async () => {
  const f = volumeFixture();
  await f.service.finalize(removalJob(null));
  assert.deepEqual(f.calls, ['observe', 'environment', 'credentials', 'project']);
  assert.equal(f.host.commands.some((command) => command.startsWith('volume rm')), false);
  assert.deepEqual([...f.host.volumes.keys()].sort(), ['owned-project_cache', 'owned-project_data']);
});

test('opted-in removal deletes the pinned named volumes before metadata retirement', async () => {
  const f = volumeFixture();
  const job = removalJob(pinsOf(await f.service.preview({ projectId, projectName: payload.projectName, serverId })));
  await f.service.authorize(job.payload, job);
  await f.service.finalize(job);
  assert.deepEqual([...f.host.volumes.keys()], []);
  assert.deepEqual(f.host.commands.filter((command) => command.startsWith('volume rm')), ['volume rm owned-project_cache', 'volume rm owned-project_data']);
  assert.deepEqual(f.calls, ['observe', 'environment', 'credentials', 'project']);
  assert.equal(f.project, null);
  // Recovery replay after metadata retirement does not touch the host again.
  const before = f.host.commands.length;
  await f.service.finalize(job);
  assert.equal(f.host.commands.length, before);
});

test('opted-in removal refuses a recreated volume before compose down and preserves metadata', async () => {
  const f = volumeFixture();
  const job = removalJob(pinsOf(await f.service.preview({ projectId, projectName: payload.projectName, serverId })));
  f.host.volumes.set('owned-project_data', hostVolume(payload.projectName, 'data', '2026-11-28T00:00:00Z'));
  await assert.rejects(f.service.authorize(job.payload, job), { code: 'docker_volume_preview_stale' });
  await assert.rejects(f.service.finalize(job), { code: 'docker_volume_preview_stale' });
  assert.ok(f.project);
  assert.deepEqual(f.calls, ['observe']);
  // Every pin is verified before any deletion, so no partial set is removed.
  assert.deepEqual([...f.host.volumes.keys()].sort(), ['owned-project_cache', 'owned-project_data']);
  assert.equal(f.host.commands.some((command) => command.startsWith('volume rm')), false);
});

test('opted-in removal rejects pins outside the project volume scope', async () => {
  const f = volumeFixture({ extraHostVolumes: [hostVolume('other-project', 'data')] });
  const job = removalJob([{ volumeKey: 'data', volumeName: 'other-project_data', volumeFingerprint: 'c'.repeat(64) }]);
  await assert.rejects(f.service.authorize(job.payload, job), { code: 'docker_compose_removal_volumes_invalid' });
  await assert.rejects(f.service.finalize(job), { code: 'docker_compose_removal_volumes_invalid' });
  assert.ok(f.host.volumes.has('other-project_data'));
  assert.ok(f.project);
});
