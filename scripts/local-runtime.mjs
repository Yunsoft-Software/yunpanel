#!/usr/bin/env node
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import {
  resolveLocalMigrationBackupDirectory,
  verifyLocalMigrationBackup,
} from '../apps/api/src/local-migration-backup.js';
import { runLocalMigrationCommand } from '../apps/api/src/local-migration-cli.js';

const scriptPath = fileURLToPath(import.meta.url);
const PACKAGED_SCRIPT_ROOT = '/usr/lib/yunpanel/scripts';
const READ_ONLY_ACTIONS = new Set(['status', 'validate']);
const USAGE = 'Usage: local-runtime.mjs create --backup-dir <snapshot> --confirm | status <server-uuid> | validate <server-uuid> | bind <server-uuid> --backup-dir <snapshot> --confirm | release <server-uuid> --backup-dir <snapshot> --confirm';
const SHA256_PATTERN = /^[a-f0-9]{64}$/;

function parseMutationOptions(values, action) {
  if (values.length !== 3 || values[0] !== '--backup-dir' || typeof values[1] !== 'string'
    || !path.isAbsolute(values[1]) || values[2] !== '--confirm') {
    throw new Error(`${action} requires exactly --backup-dir <absolute-snapshot> --confirm`);
  }
  return { backupDirectory: path.resolve(values[1]), confirm: true };
}

export function parseLocalRuntimeArguments(argv) {
  if (!Array.isArray(argv)) throw new Error(USAGE);
  const [action, value, ...rest] = argv;
  if (action === 'create') {
    const options = parseMutationOptions([value, ...rest], action);
    return { action: 'create', ...options };
  }
  if (!['status', 'validate', 'bind', 'release'].includes(action) || typeof value !== 'string' || !value) {
    throw new Error(USAGE);
  }
  if (READ_ONLY_ACTIONS.has(action)) {
    if (rest.length !== 0) throw new Error(`${action} does not accept extra arguments`);
    return { action, serverId: value, confirm: false };
  }
  return { action, serverId: value, ...parseMutationOptions(rest, action) };
}

export function isPackagedLocalRuntimeScript(filePath = scriptPath) {
  const resolved = path.resolve(filePath);
  return resolved === PACKAGED_SCRIPT_ROOT || resolved.startsWith(`${PACKAGED_SCRIPT_ROOT}${path.sep}`);
}

export function assertPackagedRoot({ packaged, uid = process.getuid?.() } = {}) {
  if (packaged && uid !== 0) throw new Error('Packaged local-runtime migration must be run as root');
}

function validateBackupVerification(result, expectedDirectory) {
  if (!result || result.verified !== true || result.backupDirectory !== expectedDirectory
    || result.archivePath !== path.join(expectedDirectory, 'state.tar')
    || result.manifestPath !== path.join(expectedDirectory, 'manifest.json')
    || typeof result.sha256 !== 'string' || !SHA256_PATTERN.test(result.sha256)) {
    throw new Error('Verified migration backup acknowledgement is invalid');
  }
  return result;
}

function formatStatus(result) {
  return [
    `server=${result.serverId}`,
    `hostname=${result.hostname}`,
    `executionMode=${result.executionMode}`,
    `apiActive=${result.apiActive}`,
    `agentActive=${result.agentActive}`,
    `activeJobs=${result.activeJobCount}`,
    `recoveryJobs=${result.recoveryJobCount}`,
    `serverStore=${result.statePaths.serverStore}`,
    `jobStore=${result.statePaths.jobStore}`,
  ].join('\n');
}

function formatValidation(result) {
  return [
    'validation=passed',
    `server=${result.serverId}`,
    `hostname=${result.hostname}`,
    `executionMode=${result.executionMode}`,
    `connectivity=${result.connectivity}`,
    `lastSeenAt=${result.lastSeenAt}`,
    `localRuntimeVersion=${result.localRuntimeVersion}`,
    `apiState=${result.apiState}`,
    `agentState=${result.agentState}`,
    `apiHealth=${result.apiHealth?.healthy === true}`,
    `apiHealthStatus=${result.apiHealth?.statusCode ?? 'unknown'}`,
    `activeJobs=${result.activeJobCount}`,
    `recoveryJobs=${result.recoveryJobCount}`,
    `inventoryPresent=${result.inventoryPresent}`,
    `servicesPresent=${result.servicesPresent}`,
    `serverStore=${result.statePaths.serverStore}`,
    `jobStore=${result.statePaths.jobStore}`,
  ].join('\n');
}

function formatMutation(result) {
  let summary;
  if (result.action === 'create') summary = `Created ${result.serverId} for local runtime ownership.`;
  else if (result.action === 'bind') summary = `Bound ${result.serverId} to local runtime ownership.`;
  else summary = `Released ${result.serverId} from local runtime ownership.`;

  const lines = [
    summary,
    `hostname=${result.hostname}`,
    `executionMode=${result.executionMode}`,
    `verifiedBackup=${result.verifiedBackupDirectory}`,
    `serverStore=${result.statePaths.serverStore}`,
    `jobStore=${result.statePaths.jobStore}`,
  ];
  if (result.action === 'create' || result.action === 'bind') {
    lines.push('Set this exact value in /etc/yunpanel/control-plane/api.env before starting yunpanel-api.service:');
    lines.push(`YUNPANEL_LOCAL_SERVER_ID=${result.serverId}`);
    lines.push('Keep yun-agent.service stopped while this local binding is active.');
    if (result.action === 'create') lines.push('No legacy agent credential was created for this server identity.');
  } else {
    lines.push('Remove YUNPANEL_LOCAL_SERVER_ID from /etc/yunpanel/control-plane/api.env before returning to agent ownership.');
  }
  return lines.join('\n');
}

export async function runLocalRuntimeCli({
  argv = process.argv.slice(2),
  env = process.env,
  hostname = os.hostname(),
  filePath = scriptPath,
  uid = process.getuid?.(),
  execute = runLocalMigrationCommand,
  verifyBackup = verifyLocalMigrationBackup,
  stdout = process.stdout,
} = {}) {
  const parsed = parseLocalRuntimeArguments(argv);
  const packaged = isPackagedLocalRuntimeScript(filePath);
  assertPackagedRoot({ packaged, uid });
  if (typeof execute !== 'function' || typeof verifyBackup !== 'function' || !stdout || typeof stdout.write !== 'function') {
    throw new Error('Local runtime CLI dependencies are invalid');
  }

  let verification = null;
  if (!READ_ONLY_ACTIONS.has(parsed.action)) {
    const backupDirectory = resolveLocalMigrationBackupDirectory(parsed.backupDirectory);
    verification = validateBackupVerification(await verifyBackup({ backupDirectory }), backupDirectory);
  }

  const { backupDirectory: _backupDirectory, ...migrationInput } = parsed;
  const executed = await execute({ ...migrationInput, hostname, env, packaged, cwd: process.cwd() });
  const result = verification
    ? Object.freeze({ ...executed, verifiedBackupDirectory: verification.backupDirectory })
    : executed;
  const output = parsed.action === 'status'
    ? formatStatus(result)
    : parsed.action === 'validate'
      ? formatValidation(result)
      : formatMutation(result);
  stdout.write(`${output}\n`);
  return result;
}

const invoked = process.argv[1] ? pathToFileURL(path.resolve(process.argv[1])).href : null;
if (invoked === import.meta.url) {
  runLocalRuntimeCli().catch((error) => {
    process.stderr.write(`${error.code ? `${error.code}: ` : ''}${error.message}\n`);
    process.exitCode = 1;
  });
}

export const localRuntimeCliInternals = Object.freeze({
  packagedScriptRoot: PACKAGED_SCRIPT_ROOT,
  readOnlyActions: READ_ONLY_ACTIONS,
  validateBackupVerification,
  formatStatus,
  formatValidation,
  formatMutation,
});
