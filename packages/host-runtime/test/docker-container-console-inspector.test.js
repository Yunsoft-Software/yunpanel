import assert from 'node:assert/strict';
import test from 'node:test';
import {
  assertContainerVolumeInspectSafe,
  createDockerContainerConsoleInspector,
  DockerContainerConsoleInspectorError,
  dockerComposeManagerInternals,
  dockerContainerConsoleInspectorInternals,
  evaluateContainerConsoleInspect,
  parseContainerShellProbe,
} from '../src/index.js';

const PROJECT_ID = '22222222-2222-4222-8222-222222222222';
const PROJECT_NAME = 'demo_app';
const CONTAINER_ID = 'a'.repeat(64);
const EXPECTED_WORKDIR = dockerComposeManagerInternals.projectWorkspacePath(
  dockerComposeManagerInternals.defaultRoot,
  PROJECT_ID,
);

function validInspect(overrides = {}) {
  const base = {
    Id: CONTAINER_ID,
    Name: '/demo_app-web-1',
    State: { Running: true, Paused: false, Restarting: false, Dead: false },
    Config: {
      User: '101:101',
      WorkingDir: '/app',
      Labels: {
        'com.docker.compose.project': PROJECT_NAME,
        'com.docker.compose.service': 'web',
        'com.docker.compose.project.working_dir': EXPECTED_WORKDIR,
      },
    },
    HostConfig: {
      Privileged: false,
      CapAdd: null,
      SecurityOpt: null,
      Devices: null,
      DeviceRequests: null,
      DeviceCgroupRules: null,
      PidMode: '',
      NetworkMode: 'demo_app_default',
      IpcMode: 'private',
      UTSMode: '',
      CgroupnsMode: 'private',
    },
    Mounts: [
      { Type: 'volume', Name: 'demo_app_data', Driver: 'local', Source: '/var/lib/docker/volumes/demo_app_data/_data', Destination: '/data' },
      { Type: 'bind', Source: `${EXPECTED_WORKDIR}/config/nginx.conf`, Destination: '/etc/nginx/conf.d/default.conf' },
    ],
  };
  return {
    ...base,
    ...overrides,
    State: { ...base.State, ...(overrides.State ?? {}) },
    Config: {
      ...base.Config,
      ...(overrides.Config ?? {}),
      Labels: { ...base.Config.Labels, ...(overrides.Config?.Labels ?? {}) },
    },
    HostConfig: { ...base.HostConfig, ...(overrides.HostConfig ?? {}) },
    Mounts: overrides.Mounts ?? base.Mounts,
  };
}

test('evaluateContainerConsoleInspect maps default/root Config.User to fixed non-root 65534:65534 and keeps explicit non-root users intact', () => {
  const ctx = {
    projectId: PROJECT_ID,
    projectName: PROJECT_NAME,
    allowedServices: ['web', 'worker'],
    allowedVolumes: ['data'],
    expectedContainerId: CONTAINER_ID,
  };

  const explicitNonRoot = evaluateContainerConsoleInspect(validInspect(), ctx);
  assert.equal(explicitNonRoot.containerId, CONTAINER_ID);
  assert.equal(explicitNonRoot.userSpec, '101:101');
  assert.equal(explicitNonRoot.forcedNonRoot, false);
  assert.deepEqual(explicitNonRoot.mountedVolumeNames, ['demo_app_data']);

  // Standard images like nginx:alpine / alpine with empty or root Config.User
  // receive fixed non-root 65534:65534 without changing the running service.
  for (const rootUser of ['', '   ', null, undefined, 'root', 'ROOT', '0', '0:101', '101:0', '101:root', 'root:root']) {
    const resolved = evaluateContainerConsoleInspect(validInspect({ Config: { User: rootUser } }), ctx);
    assert.equal(resolved.userSpec, '65534:65534');
    assert.equal(resolved.forcedNonRoot, true);
  }
});

test('evaluateContainerConsoleInspect fails closed on CgroupnsMode=host, DeviceRequests/DeviceCgroupRules, external bind paths, and non-project/custom volumes', () => {
  const ctx = {
    projectId: PROJECT_ID,
    projectName: PROJECT_NAME,
    allowedServices: ['web'],
    allowedVolumes: ['data'],
    expectedContainerId: CONTAINER_ID,
  };

  // Not running / paused / restarting / dead
  for (const badState of [
    { Running: false },
    { Running: true, Paused: true },
    { Running: true, Restarting: true },
    { Running: true, Dead: true },
  ]) {
    assert.throws(
      () => evaluateContainerConsoleInspect(validInspect({ State: badState }), ctx),
      (err) => err instanceof DockerContainerConsoleInspectorError && err.code === 'container_console_not_running' && err.status === 409,
    );
  }

  // Ownership / label mismatch
  for (const badLabels of [
    { 'com.docker.compose.project': 'other_proj' },
    { 'com.docker.compose.service': 'unlisted' },
    { 'com.docker.compose.project.working_dir': '/tmp/fake-dir' },
  ]) {
    assert.throws(
      () => evaluateContainerConsoleInspect(validInspect({ Config: { Labels: badLabels } }), ctx),
      (err) => err instanceof DockerContainerConsoleInspectorError && err.code === 'container_console_ownership_mismatch' && err.status === 409,
    );
  }

  // Privileged, dangerous capabilities, unsafe security opts
  assert.throws(
    () => evaluateContainerConsoleInspect(validInspect({ HostConfig: { Privileged: true } }), ctx),
    (err) => err instanceof DockerContainerConsoleInspectorError && err.code === 'container_console_privileged_forbidden' && err.status === 409,
  );
  for (const cap of ['ALL', 'SYS_ADMIN', 'CAP_SYS_PTRACE', 'NET_ADMIN', 'DAC_OVERRIDE']) {
    assert.throws(
      () => evaluateContainerConsoleInspect(validInspect({ HostConfig: { CapAdd: [cap] } }), ctx),
      (err) => err instanceof DockerContainerConsoleInspectorError && err.code === 'container_console_unsafe_capability_forbidden' && err.status === 409,
    );
  }
  for (const opt of ['seccomp=unconfined', 'apparmor:unconfined', 'label=disable', 'no-new-privileges=false']) {
    assert.throws(
      () => evaluateContainerConsoleInspect(validInspect({ HostConfig: { SecurityOpt: [opt] } }), ctx),
      (err) => err instanceof DockerContainerConsoleInspectorError && err.code === 'container_console_unsafe_security_opt_forbidden' && err.status === 409,
    );
  }

  // Devices, DeviceRequests (GPU/host passthrough), DeviceCgroupRules
  for (const badDeviceConfig of [
    { Devices: [{ PathOnHost: '/dev/kmsg' }] },
    { DeviceRequests: [{ Driver: 'nvidia', Count: 1 }] },
    { DeviceCgroupRules: ['c 1:* rwm'] },
  ]) {
    assert.throws(
      () => evaluateContainerConsoleInspect(validInspect({ HostConfig: badDeviceConfig }), ctx),
      (err) => err instanceof DockerContainerConsoleInspectorError && err.code === 'container_console_host_device_forbidden' && err.status === 409,
    );
  }

  // Host / shared namespaces including CgroupnsMode=host
  for (const badHostConfig of [
    { PidMode: 'host' },
    { PidMode: 'container:deadbeef' },
    { NetworkMode: 'host' },
    { NetworkMode: 'service:other' },
    { IpcMode: 'host' },
    { UTSMode: 'host' },
    { CgroupnsMode: 'host' },
    { CgroupnsMode: 'container:deadbeef' },
  ]) {
    assert.throws(
      () => evaluateContainerConsoleInspect(validInspect({ HostConfig: badHostConfig }), ctx),
      (err) => err instanceof DockerContainerConsoleInspectorError && err.code === 'container_console_host_namespace_forbidden' && err.status === 409,
    );
  }

  // External bind mounts (ANY bind outside project workspace), socket mounts, non-project/custom volumes
  for (const badMount of [
    { Type: 'bind', Source: '/var/run/docker.sock', Destination: '/var/run/docker.sock' },
    { Type: 'bind', Source: '/run/containerd/containerd.sock', Destination: '/sock' },
    { Type: 'bind', Source: '/etc', Destination: '/host-etc' },
    { Type: 'bind', Source: '/srv/shared-host-data', Destination: '/shared' },
    { Type: 'bind', Source: '/var/lib/yunpanel/auth.db', Destination: '/auth.db' },
    { Type: 'bind', Source: '/', Destination: '/host' },
    { Type: 'volume', Name: 'external_shared_vol', Driver: 'local', Source: '/var/lib/docker/volumes/external_shared_vol/_data', Destination: '/ext' },
    { Type: 'volume', Name: 'other_app_data', Driver: 'local', Source: '/var/lib/docker/volumes/other_app_data/_data', Destination: '/foreign' },
    { Type: 'volume', Name: 'demo_app_data', Driver: 'nfs', Source: '/mnt/nfs', Destination: '/data' },
  ]) {
    assert.throws(
      () => evaluateContainerConsoleInspect(validInspect({ Mounts: [badMount] }), ctx),
      (err) => err instanceof DockerContainerConsoleInspectorError && err.code === 'container_console_unsafe_mount_forbidden' && err.status === 409,
    );
  }
});

test('assertContainerVolumeInspectSafe blocks custom local-driver bind/nfs Options and foreign Compose labels', () => {
  assert.equal(assertContainerVolumeInspectSafe({
    Name: 'demo_app_data',
    Driver: 'local',
    Scope: 'local',
    Options: null,
    Labels: {
      'com.docker.compose.project': 'demo_app',
      'com.docker.compose.volume': 'data',
    },
  }, { projectName: 'demo_app', expectedVolumeName: 'demo_app_data' }), true);

  for (const badVolume of [
    // Custom local-driver host bind escape
    { Name: 'demo_app_data', Driver: 'local', Scope: 'local', Options: { type: 'none', o: 'bind', device: '/etc' }, Labels: { 'com.docker.compose.project': 'demo_app', 'com.docker.compose.volume': 'data' } },
    // Non-local Scope
    { Name: 'demo_app_data', Driver: 'local', Scope: 'global', Options: null, Labels: { 'com.docker.compose.project': 'demo_app', 'com.docker.compose.volume': 'data' } },
    // Missing/foreign project label
    { Name: 'demo_app_data', Driver: 'local', Scope: 'local', Options: null, Labels: { 'com.docker.compose.project': 'other_app', 'com.docker.compose.volume': 'data' } },
    { Name: 'demo_app_data', Driver: 'local', Scope: 'local', Options: null, Labels: {} },
  ]) {
    assert.throws(
      () => assertContainerVolumeInspectSafe(badVolume, { projectName: 'demo_app', expectedVolumeName: 'demo_app_data' }),
      (err) => err instanceof DockerContainerConsoleInspectorError && err.code === 'container_console_unsafe_mount_forbidden' && err.status === 409,
    );
  }
});

test('parseContainerShellProbe enforces positive non-root uid/gid, forced 65534:65534 match, allowlisted shell, and valid cwd', () => {
  assert.deepEqual(parseContainerShellProbe('101:101:/bin/sh:/app\n'), {
    uid: 101,
    gid: 101,
    user: '101:101',
    shell: '/bin/sh',
    cwd: '/app',
  });
  assert.deepEqual(parseContainerShellProbe('65534:65534:/bin/sh:/', { forcedNonRoot: true }), {
    uid: 65534,
    gid: 65534,
    user: '65534:65534',
    shell: '/bin/sh',
    cwd: '/',
  });

  // Never allows root uid/gid
  for (const badProbe of ['0:101:/bin/sh:/', '101:0:/bin/sh:/', '0:0:/bin/bash:/']) {
    assert.throws(
      () => parseContainerShellProbe(badProbe),
      (err) => err instanceof DockerContainerConsoleInspectorError && err.code === 'container_console_root_user_forbidden' && err.status === 409,
    );
  }
  // Forced non-root must verify exact 65534:65534
  assert.throws(
    () => parseContainerShellProbe('1000:1000:/bin/sh:/', { forcedNonRoot: true }),
    (err) => err instanceof DockerContainerConsoleInspectorError && err.code === 'container_console_root_user_forbidden' && err.status === 409,
  );
  // Non-allowlisted shells rejected
  for (const badShell of ['65534:65534::/', '65534:65534:/usr/bin/python3:/', '65534:65534:/bin/ash:/', 'garbage']) {
    assert.throws(
      () => parseContainerShellProbe(badShell),
      (err) => err instanceof DockerContainerConsoleInspectorError && err.code === 'container_console_shell_unavailable' && err.status === 409,
    );
  }
});

test('createDockerContainerConsoleInspector pins local Unix socket and rejects non-64-hex container IDs', async () => {
  assert.equal(dockerContainerConsoleInspectorInternals.dockerSocket, 'unix:///var/run/docker.sock');
  assert.equal(dockerContainerConsoleInspectorInternals.fallbackNonRootUser, '65534:65534');
  assert.deepEqual(dockerContainerConsoleInspectorInternals.dockerPaths, ['/usr/bin/docker', '/usr/local/bin/docker']);

  const inspector = createDockerContainerConsoleInspector();
  for (const badId of ['short123', '--privileged', 'g'.repeat(64)]) {
    await assert.rejects(
      inspector.inspectContainer({
        projectId: PROJECT_ID,
        projectName: PROJECT_NAME,
        allowedServices: ['web'],
        containerId: badId,
      }),
      (err) => err instanceof DockerContainerConsoleInspectorError && err.code === 'container_console_id_invalid' && err.status === 400,
    );
  }
});
