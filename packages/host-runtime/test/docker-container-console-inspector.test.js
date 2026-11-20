import assert from 'node:assert/strict';
import test from 'node:test';
import {
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
      PidMode: '',
      NetworkMode: 'demo_app_default',
      IpcMode: 'private',
      UTSMode: '',
      CgroupnsMode: 'private',
    },
    Mounts: [
      { Type: 'volume', Name: 'demo_app_data', Source: '/var/lib/docker/volumes/demo_app_data/_data', Destination: '/data' },
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

test('evaluateContainerConsoleInspect accepts verified non-root managed Compose container and pins working_dir to project workspace', () => {
  const verified = evaluateContainerConsoleInspect(validInspect(), {
    projectId: PROJECT_ID,
    projectName: PROJECT_NAME,
    allowedServices: ['web', 'worker'],
    expectedContainerId: CONTAINER_ID,
  });
  assert.equal(verified.containerId, CONTAINER_ID);
  assert.equal(verified.containerName, 'demo_app-web-1');
  assert.equal(verified.serviceName, 'web');
  assert.equal(verified.projectName, PROJECT_NAME);
  assert.equal(verified.userSpec, '101:101');
  assert.equal(verified.cwd, '/app');
});

test('evaluateContainerConsoleInspect fails closed on root user, stopped state, ownership mismatch, and every hard security denylist rule', () => {
  const ctx = {
    projectId: PROJECT_ID,
    projectName: PROJECT_NAME,
    allowedServices: ['web'],
    expectedContainerId: CONTAINER_ID,
  };

  // Root / empty user specs
  for (const badUser of ['', '   ', null, undefined, 'root', 'ROOT', '0', '0:101', '101:0', '101:root', 'root:root']) {
    assert.throws(
      () => evaluateContainerConsoleInspect(validInspect({ Config: { User: badUser } }), ctx),
      (err) => err instanceof DockerContainerConsoleInspectorError && err.code === 'container_console_root_user_forbidden' && err.status === 409,
    );
  }

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

  // Ownership / label mismatch (foreign project, unlisted service, foreign working_dir)
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

  // Privileged
  assert.throws(
    () => evaluateContainerConsoleInspect(validInspect({ HostConfig: { Privileged: true } }), ctx),
    (err) => err instanceof DockerContainerConsoleInspectorError && err.code === 'container_console_privileged_forbidden' && err.status === 409,
  );

  // Dangerous capabilities
  for (const cap of ['ALL', 'SYS_ADMIN', 'CAP_SYS_PTRACE', 'NET_ADMIN', 'DAC_OVERRIDE']) {
    assert.throws(
      () => evaluateContainerConsoleInspect(validInspect({ HostConfig: { CapAdd: [cap] } }), ctx),
      (err) => err instanceof DockerContainerConsoleInspectorError && err.code === 'container_console_unsafe_capability_forbidden' && err.status === 409,
    );
  }

  // Dangerous SecurityOpt
  for (const opt of ['seccomp=unconfined', 'apparmor:unconfined', 'label=disable', 'no-new-privileges=false']) {
    assert.throws(
      () => evaluateContainerConsoleInspect(validInspect({ HostConfig: { SecurityOpt: [opt] } }), ctx),
      (err) => err instanceof DockerContainerConsoleInspectorError && err.code === 'container_console_unsafe_security_opt_forbidden' && err.status === 409,
    );
  }

  // Host Devices
  assert.throws(
    () => evaluateContainerConsoleInspect(validInspect({ HostConfig: { Devices: [{ PathOnHost: '/dev/kmsg' }] } }), ctx),
    (err) => err instanceof DockerContainerConsoleInspectorError && err.code === 'container_console_host_device_forbidden' && err.status === 409,
  );

  // Host / shared namespaces
  for (const badHostConfig of [
    { PidMode: 'host' },
    { PidMode: 'container:deadbeef' },
    { NetworkMode: 'host' },
    { NetworkMode: 'service:other' },
    { IpcMode: 'host' },
    { UTSMode: 'host' },
  ]) {
    assert.throws(
      () => evaluateContainerConsoleInspect(validInspect({ HostConfig: badHostConfig }), ctx),
      (err) => err instanceof DockerContainerConsoleInspectorError && err.code === 'container_console_host_namespace_forbidden' && err.status === 409,
    );
  }

  // Docker socket and sensitive host bind mounts
  for (const badMount of [
    { Type: 'bind', Source: '/var/run/docker.sock', Destination: '/var/run/docker.sock' },
    { Type: 'bind', Source: '/run/containerd/containerd.sock', Destination: '/sock' },
    { Type: 'bind', Source: '/etc', Destination: '/host-etc' },
    { Type: 'bind', Source: '/var/lib/yunpanel/auth.db', Destination: '/auth.db' },
    { Type: 'bind', Source: '/', Destination: '/host' },
  ]) {
    assert.throws(
      () => evaluateContainerConsoleInspect(validInspect({ Mounts: [badMount] }), ctx),
      (err) => err instanceof DockerContainerConsoleInspectorError && err.code === 'container_console_unsafe_mount_forbidden' && err.status === 409,
    );
  }
});

test('parseContainerShellProbe requires positive non-root numeric uid/gid and allowlisted shell', () => {
  assert.deepEqual(parseContainerShellProbe('101:101:/bin/sh\n'), {
    uid: 101,
    gid: 101,
    user: '101:101',
    shell: '/bin/sh',
  });
  assert.deepEqual(parseContainerShellProbe('1000:1000:/bin/bash'), {
    uid: 1000,
    gid: 1000,
    user: '1000:1000',
    shell: '/bin/bash',
  });

  // Effective UID 0 or GID 0 (e.g. aliased passwd entry) is strictly forbidden
  for (const badProbe of ['0:101:/bin/sh', '101:0:/bin/sh', '0:0:/bin/bash']) {
    assert.throws(
      () => parseContainerShellProbe(badProbe),
      (err) => err instanceof DockerContainerConsoleInspectorError && err.code === 'container_console_root_user_forbidden' && err.status === 409,
    );
  }

  // Non-allowlisted shell or empty shell rejected
  for (const badShell of ['101:101:', '101:101:/usr/bin/python3', '101:101:/bin/ash', 'garbage']) {
    assert.throws(
      () => parseContainerShellProbe(badShell),
      (err) => err instanceof DockerContainerConsoleInspectorError && err.code === 'container_console_shell_unavailable' && err.status === 409,
    );
  }
});

test('createDockerContainerConsoleInspector enforces local Unix socket pinning and 64-hex container IDs', async () => {
  assert.equal(dockerContainerConsoleInspectorInternals.dockerSocket, 'unix:///var/run/docker.sock');
  assert.deepEqual(dockerContainerConsoleInspectorInternals.dockerPaths, ['/usr/bin/docker', '/usr/local/bin/docker']);

  const inspector = createDockerContainerConsoleInspector();
  await assert.rejects(
    inspector.inspectContainer({
      projectId: PROJECT_ID,
      projectName: PROJECT_NAME,
      allowedServices: ['web'],
      containerId: 'short123',
    }),
    (err) => err instanceof DockerContainerConsoleInspectorError && err.code === 'container_console_id_invalid' && err.status === 400,
  );
  await assert.rejects(
    inspector.inspectContainer({
      projectId: PROJECT_ID,
      projectName: PROJECT_NAME,
      allowedServices: ['web'],
      containerId: '--privileged',
    }),
    (err) => err instanceof DockerContainerConsoleInspectorError && err.code === 'container_console_id_invalid' && err.status === 400,
  );
});
