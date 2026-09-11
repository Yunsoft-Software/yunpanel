import { createHash } from 'node:crypto';
import path from 'node:path';
import {
  assertUuid,
  normalizeApplicationEnvironmentBundle,
  normalizeNodeRuntimeConfig,
} from '@yunpanel/shared';

const APP_USER_PATTERN = /^yunapp-[a-f0-9]{12}$/;
const NODE_PATHS = new Set(['/usr/bin/node', '/usr/local/bin/node']);
const PACKAGE_MANAGER_PATHS = Object.freeze({
  npm: new Set(['/usr/bin/npm', '/usr/local/bin/npm']),
  pnpm: new Set(['/usr/bin/pnpm', '/usr/local/bin/pnpm']),
  yarn: new Set(['/usr/bin/yarn', '/usr/local/bin/yarn']),
});
const APP_ROOT = '/var/lib/yunpanel/apps';
const DATA_ROOT = '/var/lib/yunpanel/data';
const ENV_ROOT = '/etc/yunpanel/apps';

export class SystemdTemplateError extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'SystemdTemplateError';
    this.code = code;
  }
}

export function nodeServiceName(applicationId) {
  const normalizedId = assertUuid(applicationId, 'applicationId');
  const digest = createHash('sha256').update(normalizedId).digest('hex').slice(0, 16);
  return `yunpanel-node-${digest}.service`;
}

export function nodeApplicationUser(applicationId) {
  const normalizedId = assertUuid(applicationId, 'applicationId');
  const digest = createHash('sha256').update(normalizedId).digest('hex').slice(0, 12);
  return `yunapp-${digest}`;
}

function validateUser(user, applicationId) {
  const expected = nodeApplicationUser(applicationId);
  if (typeof user !== 'string' || !APP_USER_PATTERN.test(user) || user !== expected) {
    throw new SystemdTemplateError('invalid_application_user', 'Node application user does not match the managed application identity');
  }
  return user;
}

function validateNodePath(value) {
  if (!NODE_PATHS.has(value)) {
    throw new SystemdTemplateError('invalid_node_path', 'Node executable path is not allowlisted');
  }
  return value;
}

function validatePackageManagerPath(value, packageManager) {
  if (!PACKAGE_MANAGER_PATHS[packageManager]?.has(value)) {
    throw new SystemdTemplateError('invalid_package_manager_path', 'Package manager executable path is not allowlisted');
  }
  return value;
}

function quoteEnvironmentValue(value) {
  return `"${value.replaceAll('\\', '\\\\').replaceAll('"', '\\"')}"`;
}

export function renderNodeEnvironmentFile({ applicationId, runtime, environment = {} }) {
  const appId = assertUuid(applicationId, 'applicationId');
  const normalizedRuntime = normalizeNodeRuntimeConfig(runtime);
  const customEnvironment = normalizeApplicationEnvironmentBundle(environment);
  const values = {
    NODE_ENV: normalizedRuntime.mode,
    HOST: '127.0.0.1',
    PORT: String(normalizedRuntime.port),
    YUNPANEL_APPLICATION_ID: appId,
  };

  for (const key of Object.keys(customEnvironment).sort()) values[key] = customEnvironment[key];
  return `${Object.entries(values).map(([key, value]) => `${key}=${quoteEnvironmentValue(value)}`).join('\n')}\n`;
}

export function renderNodeSystemdUnit({ applicationId, user, nodePath, packageManagerPath = null, npmPath = null, runtime }) {
  const appId = assertUuid(applicationId, 'applicationId');
  const account = validateUser(user, appId);
  const safeNodePath = validateNodePath(nodePath);
  const normalizedRuntime = normalizeNodeRuntimeConfig(runtime);
  const releaseDirectory = path.posix.join(APP_ROOT, appId, 'current');
  const currentDirectory = path.posix.join(releaseDirectory, normalizedRuntime.documentRoot);
  const dataDirectory = path.posix.join(DATA_ROOT, appId);
  const environmentFile = path.posix.join(ENV_ROOT, `${appId}.env`);

  let execStart;
  if (normalizedRuntime.start.mode === 'node') {
    execStart = `${safeNodePath} ${path.posix.join(currentDirectory, normalizedRuntime.start.entryFile)}`;
  } else {
    const executable = packageManagerPath ?? npmPath;
    const safePackageManagerPath = validatePackageManagerPath(executable, normalizedRuntime.packageManager);
    execStart = `${safePackageManagerPath} run ${normalizedRuntime.start.script}`;
  }

  return `[Unit]\nDescription=YunPanel Node application ${appId}\nAfter=network-online.target\nWants=network-online.target\n\n[Service]\nType=simple\nUser=${account}\nGroup=${account}\nWorkingDirectory=${currentDirectory}\nEnvironmentFile=${environmentFile}\nExecStart=${execStart}\nRestart=${normalizedRuntime.restartPolicy}\nRestartSec=3\nTimeoutStopSec=30\nKillSignal=SIGTERM\nKillMode=control-group\nSuccessExitStatus=143\nNoNewPrivileges=true\nPrivateTmp=true\nPrivateDevices=true\nProtectSystem=strict\nProtectHome=true\nProtectKernelTunables=true\nProtectKernelModules=true\nProtectControlGroups=true\nProtectKernelLogs=true\nProtectClock=true\nLockPersonality=true\nRestrictSUIDSGID=true\nRestrictAddressFamilies=AF_UNIX AF_INET AF_INET6\nSystemCallArchitectures=native\nCapabilityBoundingSet=\nAmbientCapabilities=\nReadWritePaths=${dataDirectory}\nUMask=0027\n\n[Install]\nWantedBy=multi-user.target\n`;
}
