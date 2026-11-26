import test from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { access } from 'node:fs/promises';
import { constants as fsConstants } from 'node:fs';
import {
  DockerVolumeManagerError,
  createDockerVolumeManager,
  dockerVolumeManagerInternals,
} from '../src/index.js';
import { summarizeDockerComposeConfig } from '../src/docker-compose-validator.js';

function execFilePromise(file, args, stdinText) {
  return new Promise((resolve, reject) => {
    const child = execFile(file, args, { encoding: 'utf8', maxBuffer: 512 * 1024 }, (error, stdout, stderr) => {
      if (error) reject(Object.assign(error, { stdout, stderr }));
      else resolve({ stdout, stderr });
    });
    if (stdinText !== undefined) {
      child.stdin.end(stdinText);
    }
  });
}

async function resolveLocalDockerBinary() {
  for (const candidate of ['/usr/bin/docker', '/usr/local/bin/docker', '/opt/homebrew/bin/docker']) {
    try {
      await access(candidate, fsConstants.X_OK);
      return candidate;
    } catch {
      // keep searching
    }
  }
  return null;
}

test('summarizeDockerComposeConfig classifies project, external, and custom-named volumes with real Docker Compose CLI', async (t) => {
  const dockerBin = await resolveLocalDockerBinary();
  if (!dockerBin) {
    t.skip('docker CLI not installed on this host');
    return;
  }
  const yaml = [
    'services:',
    '  app:',
    '    image: alpine:3.20',
    '    volumes:',
    '      - app_data:/data',
    '      - shared_ext:/ext',
    '      - custom_host:/custom',
    'volumes:',
    '  app_data: {}',
    '  shared_ext:',
    '    external: true',
    '  custom_host:',
    '    name: custom_global_vol',
    '',
  ].join('\n');

  const { stdout } = await execFilePromise(
    dockerBin,
    ['compose', '--project-name', 'shop_stack', '-f', '-', 'config', '--format', 'json'],
    yaml,
  );
  const parsed = JSON.parse(stdout);
  const summary = summarizeDockerComposeConfig(parsed, {
    expectedProjectName: 'shop_stack',
    documentSha256: createHash('sha256').update(yaml).digest('hex'),
    documentBytes: Buffer.byteLength(yaml),
  });

  assert.deepEqual(summary.volumes, ['app_data', 'custom_host', 'shared_ext']);
  assert.deepEqual(summary.volumeDetails, [
    { name: 'app_data', scope: 'project', external: false, runtimeName: 'shop_stack_app_data' },
    { name: 'custom_host', scope: 'host', external: false, runtimeName: 'custom_global_vol' },
    { name: 'shared_ext', scope: 'host', external: true, runtimeName: 'shared_ext' },
  ]);
});

test('normalizeVolumeInspect and assertVolumeDeletableMetadata enforce Compose labels, local driver, empty options, and fingerprint', () => {
  const raw = {
    Name: 'shop_stack_app_data',
    Driver: 'local',
    Scope: 'local',
    Mountpoint: '/var/lib/docker/volumes/shop_stack_app_data/_data',
    Options: null,
    CreatedAt: '2026-11-20T03:00:00Z',
    Labels: {
      'com.docker.compose.project': 'shop_stack',
      'com.docker.compose.volume': 'app_data',
    },
  };

  const detail = dockerVolumeManagerInternals.normalizeVolumeInspect(raw, 'shop_stack_app_data');
  assert.equal(detail.present, true);
  assert.equal(detail.composeProject, 'shop_stack');
  assert.equal(detail.composeVolume, 'app_data');
  assert.match(detail.fingerprint, /^[a-f0-9]{64}$/);

  assert.equal(
    dockerVolumeManagerInternals.assertVolumeDeletableMetadata(detail, {
      projectName: 'shop_stack',
      volumeKey: 'app_data',
      expectedFingerprint: detail.fingerprint,
    }),
    detail,
  );

  // Wrong Compose project label -> fail closed
  assert.throws(
    () => dockerVolumeManagerInternals.assertVolumeDeletableMetadata(detail, {
      projectName: 'other_stack',
      volumeKey: 'app_data',
    }),
    (error) => error instanceof DockerVolumeManagerError && error.code === 'docker_volume_ownership_unverified' && error.status === 409,
  );

  // Missing Compose labels (e.g., externally created volume) -> fail closed
  const unlabelled = dockerVolumeManagerInternals.normalizeVolumeInspect({ ...raw, Labels: {} }, 'shop_stack_app_data');
  assert.throws(
    () => dockerVolumeManagerInternals.assertVolumeDeletableMetadata(unlabelled, {
      projectName: 'shop_stack',
      volumeKey: 'app_data',
    }),
    (error) => error instanceof DockerVolumeManagerError && error.code === 'docker_volume_ownership_unverified',
  );

  // Custom driver options (e.g., bind mount opts) -> fail closed
  const withOptions = dockerVolumeManagerInternals.normalizeVolumeInspect(
    { ...raw, Options: { type: 'none', o: 'bind', device: '/srv/shared' } },
    'shop_stack_app_data',
  );
  assert.throws(
    () => dockerVolumeManagerInternals.assertVolumeDeletableMetadata(withOptions, {
      projectName: 'shop_stack',
      volumeKey: 'app_data',
    }),
    (error) => error instanceof DockerVolumeManagerError && error.code === 'docker_volume_options_unsupported',
  );

  // Non-local driver -> fail closed
  const remoteDriver = dockerVolumeManagerInternals.normalizeVolumeInspect({ ...raw, Driver: 'nfs' }, 'shop_stack_app_data');
  assert.throws(
    () => dockerVolumeManagerInternals.assertVolumeDeletableMetadata(remoteDriver, {
      projectName: 'shop_stack',
      volumeKey: 'app_data',
    }),
    (error) => error instanceof DockerVolumeManagerError && error.code === 'docker_volume_driver_unsupported',
  );

  // Missing Scope must NOT default to local -> fail closed
  const missingScope = dockerVolumeManagerInternals.normalizeVolumeInspect({ ...raw, Scope: undefined }, 'shop_stack_app_data');
  assert.equal(missingScope.scope, null);
  assert.equal(missingScope.fingerprint, null);
  assert.throws(
    () => dockerVolumeManagerInternals.assertVolumeDeletableMetadata(missingScope, {
      projectName: 'shop_stack',
      volumeKey: 'app_data',
    }),
    (error) => error instanceof DockerVolumeManagerError && error.code === 'docker_volume_identity_incomplete',
  );

  // Missing or invalid CreatedAt must NOT produce a fingerprint -> fail closed
  for (const badCreatedAt of [undefined, null, '', 'not-a-timestamp']) {
    const missingTs = dockerVolumeManagerInternals.normalizeVolumeInspect({ ...raw, CreatedAt: badCreatedAt }, 'shop_stack_app_data');
    assert.equal(missingTs.createdAt, null);
    assert.equal(missingTs.fingerprint, null);
    assert.throws(
      () => dockerVolumeManagerInternals.assertVolumeDeletableMetadata(missingTs, {
        projectName: 'shop_stack',
        volumeKey: 'app_data',
      }),
      (error) => error instanceof DockerVolumeManagerError && error.code === 'docker_volume_identity_incomplete',
    );
  }

  // Drifted fingerprint -> fail closed stale preview
  assert.throws(
    () => dockerVolumeManagerInternals.assertVolumeDeletableMetadata(detail, {
      projectName: 'shop_stack',
      volumeKey: 'app_data',
      expectedFingerprint: 'f'.repeat(64),
    }),
    (error) => error instanceof DockerVolumeManagerError && error.code === 'docker_volume_preview_stale',
  );
});

test('parseVolumeContainersOutput parses stopped/exited and running containers and rejects malformed NDJSON', () => {
  const stdout = [
    JSON.stringify({ ID: 'aaa111', Names: '/shop_stack-app-1', State: 'exited', Status: 'Exited (0) 2 minutes ago' }),
    JSON.stringify({ ID: 'bbb222', Names: 'shop_stack-worker-1', State: 'running', Status: 'Up 5 minutes' }),
  ].join('\n');

  const parsed = dockerVolumeManagerInternals.parseVolumeContainersOutput(stdout, 'shop_stack_app_data');
  assert.equal(parsed.containerCount, 2);
  assert.deepEqual(parsed.containers, [
    { id: 'aaa111', name: 'shop_stack-app-1', state: 'exited', status: 'Exited (0) 2 minutes ago' },
    { id: 'bbb222', name: 'shop_stack-worker-1', state: 'running', status: 'Up 5 minutes' },
  ]);

  assert.equal(dockerVolumeManagerInternals.parseVolumeContainersOutput('', 'shop_stack_app_data').containerCount, 0);
  assert.throws(
    () => dockerVolumeManagerInternals.parseVolumeContainersOutput('not-json', 'shop_stack_app_data'),
    (error) => error instanceof DockerVolumeManagerError && error.code === 'docker_volume_usage_check_failed' && error.status === 503,
  );
});

test('createDockerVolumeManager enforces binary allowlist and strict volume identity validation', async () => {
  assert.throws(
    () => createDockerVolumeManager({ dockerPath: '/tmp/fake-docker' }),
    (error) => error instanceof DockerVolumeManagerError && error.code === 'docker_binary_invalid',
  );
  assert.throws(
    () => dockerVolumeManagerInternals.assertOwnedVolumeIdentity('shop_stack', 'db_data', 'other_stack_db_data'),
    (error) => error instanceof DockerVolumeManagerError && error.code === 'docker_volume_identity_mismatch',
  );
  assert.throws(
    () => dockerVolumeManagerInternals.assertSafeVolumeName('--force'),
    (error) => error instanceof DockerVolumeManagerError && error.code === 'docker_volume_name_invalid',
  );
});
