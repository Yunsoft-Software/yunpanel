import assert from 'node:assert/strict';
import test from 'node:test';
import {
  createDockerVolumeInspector,
  DockerVolumeInspectorError,
} from '../src/docker-volume-inspector.js';

function fixture(result) {
  const calls = [];
  const inspect = createDockerVolumeInspector({
    accessFn: async (candidate) => {
      if (candidate !== '/usr/bin/docker') throw Object.assign(new Error('missing'), { code: 'ENOENT' });
    },
    run: async (file, args) => {
      calls.push({ file, args: [...args] });
      if (result instanceof Error) throw result;
      return { stdout: JSON.stringify(result) };
    },
  });
  return { inspect, calls };
}

test('Docker volume inspector accepts only local optionless managed volumes', async () => {
  const name = 'shop_app_data';
  const { inspect, calls } = fixture({
    Name: name,
    Driver: 'local',
    Scope: 'local',
    Mountpoint: '/var/lib/docker/volumes/shop_app_data/_data',
    Options: null,
  });
  const result = await inspect(name);
  assert.deepEqual(result, {
    name,
    driver: 'local',
    mountpoint: '/var/lib/docker/volumes/shop_app_data/_data',
  });
  assert.deepEqual(calls, [{
    file: '/usr/bin/docker',
    args: ['volume', 'inspect', '--format', '{{json .}}', name],
  }]);
});

test('Docker volume inspector rejects custom drivers and driver options', async () => {
  for (const state of [
    {
      Name: 'shop_app_data', Driver: 'nfs', Scope: 'local', Mountpoint: '/mnt/nfs', Options: null,
    },
    {
      Name: 'shop_app_data', Driver: 'local', Scope: 'local', Mountpoint: '/mnt/bind',
      Options: { type: 'none', device: '/srv/shared', o: 'bind' },
    },
  ]) {
    const { inspect } = fixture(state);
    await assert.rejects(
      () => inspect('shop_app_data'),
      (error) => error instanceof DockerVolumeInspectorError
        && ['docker_volume_state_invalid', 'docker_volume_options_unsupported'].includes(error.code),
    );
  }
});

test('Docker volume inspector fails closed without leaking Docker diagnostics', async () => {
  const { inspect } = fixture(new Error('Mountpoint=/secret host diagnostic'));
  await assert.rejects(
    () => inspect('shop_app_data'),
    (error) => error instanceof DockerVolumeInspectorError
      && error.code === 'docker_volume_inspect_failed'
      && !error.message.includes('/secret'),
  );
});

test('Docker volume inspector rejects unsafe names before execution', async () => {
  let calls = 0;
  const inspect = createDockerVolumeInspector({
    accessFn: async () => {},
    run: async () => { calls += 1; return { stdout: '{}' }; },
  });
  await assert.rejects(
    () => inspect('../host'),
    (error) => error instanceof DockerVolumeInspectorError && error.code === 'docker_volume_name_invalid',
  );
  assert.equal(calls, 0);
});
