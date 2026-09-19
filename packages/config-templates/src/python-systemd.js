import { createHash } from 'node:crypto';
import path from 'node:path';
import { assertUuid, normalizePythonRuntimeConfig } from '@yunpanel/shared';

const APP_USER_PATTERN = /^yunapp-[a-f0-9]{12}$/;
const APP_ROOT = '/var/lib/yunpanel/apps';
const DATA_ROOT = '/var/lib/yunpanel/data';
const ENV_ROOT = '/etc/yunpanel/apps';
const RUN_ROOT = '/run/yunpanel';

export class PythonSystemdTemplateError extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'PythonSystemdTemplateError';
    this.code = code;
  }
}

export function pythonServiceName(applicationId) {
  const normalizedId = assertUuid(applicationId, 'applicationId');
  const digest = createHash('sha256').update(normalizedId).digest('hex').slice(0, 16);
  return `yunpanel-python-${digest}.service`;
}

export function pythonApplicationUser(applicationId) {
  const normalizedId = assertUuid(applicationId, 'applicationId');
  const digest = createHash('sha256').update(normalizedId).digest('hex').slice(0, 12);
  return `yunapp-${digest}`;
}

export function pythonSocketPath(applicationId) {
  const normalizedId = assertUuid(applicationId, 'applicationId');
  return path.posix.join(RUN_ROOT, `python-${normalizedId}.sock`);
}

function validateUser(user, applicationId) {
  const expected = pythonApplicationUser(applicationId);
  if (typeof user !== 'string' || !APP_USER_PATTERN.test(user) || user !== expected) {
    throw new PythonSystemdTemplateError('invalid_application_user', 'Python application user does not match the managed application identity');
  }
  return user;
}

function safeAbsolutePath(value, fieldName) {
  if (typeof value !== 'string' || !path.isAbsolute(value) || value.includes('..') || /[\u0000-\u001f\u007f]/.test(value)) {
    throw new PythonSystemdTemplateError('invalid_path', `${fieldName} must be a safe absolute path`);
  }
  return path.posix.normalize(value);
}

export function renderPythonSystemdUnit({
  applicationId,
  user,
  group = null,
  venvPath = null,
  runtime,
  environmentFile = null,
}) {
  const appId = assertUuid(applicationId, 'applicationId');
  const account = validateUser(user, appId);
  const accountGroup = group ?? account;
  const normalizedRuntime = normalizePythonRuntimeConfig(runtime);

  const defaultVenvPath = path.posix.join(DATA_ROOT, appId, 'venv');
  const safeVenvPath = safeAbsolutePath(venvPath ?? defaultVenvPath, 'venvPath');
  const releaseDirectory = path.posix.join(APP_ROOT, appId, 'current');
  const currentDirectory = normalizedRuntime.documentRoot === '.'
    ? releaseDirectory
    : path.posix.join(releaseDirectory, normalizedRuntime.documentRoot);
  const dataDirectory = path.posix.join(DATA_ROOT, appId);
  const safeEnvironmentFile = environmentFile
    ? safeAbsolutePath(environmentFile, 'environmentFile')
    : path.posix.join(ENV_ROOT, `${appId}.env`);

  const socketPath = pythonSocketPath(appId);
  const venvBin = path.posix.join(safeVenvPath, 'bin');

  let execStart;
  if (normalizedRuntime.appServer === 'gunicorn') {
    const serverBinary = path.posix.join(venvBin, 'gunicorn');
    const bindArg = normalizedRuntime.port
      ? `127.0.0.1:${normalizedRuntime.port}`
      : `unix:${socketPath}`;
    execStart = `${serverBinary} --workers ${normalizedRuntime.workers} --bind ${bindArg} ${normalizedRuntime.entryPoint}`;
  } else {
    const serverBinary = path.posix.join(venvBin, 'uvicorn');
    const bindArg = normalizedRuntime.port
      ? `--host 127.0.0.1 --port ${normalizedRuntime.port}`
      : `--uds ${socketPath}`;
    execStart = `${serverBinary} --workers ${normalizedRuntime.workers} ${bindArg} ${normalizedRuntime.entryPoint}`;
  }

  const readWritePaths = [dataDirectory, RUN_ROOT].join(' ');

  return `[Unit]
Description=YunPanel Python application ${appId}
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
User=${account}
Group=${accountGroup}
WorkingDirectory=${currentDirectory}
EnvironmentFile=-${safeEnvironmentFile}
Environment="PATH=${venvBin}:/usr/local/bin:/usr/bin:/bin"
Environment="PYTHONUNBUFFERED=1"
ExecStart=${execStart}
Restart=${normalizedRuntime.restartPolicy}
RestartSec=3
TimeoutStopSec=30
KillSignal=SIGTERM
KillMode=control-group
SuccessExitStatus=143
NoNewPrivileges=true
PrivateTmp=true
ProtectSystem=strict
ProtectHome=true
ProtectKernelTunables=true
ProtectKernelModules=true
ProtectControlGroups=true
ProtectKernelLogs=true
ProtectClock=true
LockPersonality=true
RestrictSUIDSGID=true
RestrictAddressFamilies=AF_UNIX AF_INET AF_INET6
SystemCallArchitectures=native
CapabilityBoundingSet=
AmbientCapabilities=
ReadWritePaths=${readWritePaths}
UMask=0027

[Install]
WantedBy=multi-user.target
`;
}
