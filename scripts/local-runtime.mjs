#!/usr/bin/env node
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { runLocalMigrationCommand } from '../apps/api/src/local-migration-cli.js';

const scriptPath = fileURLToPath(import.meta.url);
const PACKAGED_SCRIPT_ROOT = '/usr/lib/yunpanel/scripts';
const USAGE = 'Usage: local-runtime.mjs create --confirm | status <server-uuid> | bind <server-uuid> --confirm | release <server-uuid> --confirm';

export function parseLocalRuntimeArguments(argv) {
  if (!Array.isArray(argv)) throw new Error(USAGE);
  const [action, serverId, ...rest] = argv;
  if (action === 'create') {
    if (serverId !== '--confirm' || rest.length !== 0) throw new Error('create requires exactly --confirm');
    return { action: 'create', confirm: true };
  }
  if (!['status', 'bind', 'release'].includes(action) || typeof serverId !== 'string' || !serverId) {
    throw new Error(USAGE);
  }
  const confirm = rest.length === 1 && rest[0] === '--confirm';
  if (action === 'status' && rest.length !== 0) throw new Error('status does not accept extra arguments');
  if ((action === 'bind' || action === 'release') && (!confirm || rest.length !== 1)) {
    throw new Error(`${action} requires exactly --confirm`);
  }
  return { action, serverId, confirm };
}

export function isPackagedLocalRuntimeScript(filePath = scriptPath) {
  const resolved = path.resolve(filePath);
  return resolved === PACKAGED_SCRIPT_ROOT || resolved.startsWith(`${PACKAGED_SCRIPT_ROOT}${path.sep}`);
}

export function assertPackagedRoot({ packaged, uid = process.getuid?.() } = {}) {
  if (packaged && uid !== 0) throw new Error('Packaged local-runtime migration must be run as root');
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

function formatMutation(result) {
  let summary;
  if (result.action === 'create') summary = `Created ${result.serverId} for local runtime ownership.`;
  else if (result.action === 'bind') summary = `Bound ${result.serverId} to local runtime ownership.`;
  else summary = `Released ${result.serverId} from local runtime ownership.`;

  const lines = [
    summary,
    `hostname=${result.hostname}`,
    `executionMode=${result.executionMode}`,
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
  stdout = process.stdout,
} = {}) {
  const parsed = parseLocalRuntimeArguments(argv);
  const packaged = isPackagedLocalRuntimeScript(filePath);
  assertPackagedRoot({ packaged, uid });
  const result = await execute({ ...parsed, hostname, env, packaged, cwd: process.cwd() });
  stdout.write(`${parsed.action === 'status' ? formatStatus(result) : formatMutation(result)}\n`);
  return result;
}

const invoked = process.argv[1] ? pathToFileURL(path.resolve(process.argv[1])).href : null;
if (invoked === import.meta.url) {
  runLocalRuntimeCli().catch((error) => {
    process.stderr.write(`${error.code ? `${error.code}: ` : ''}${error.message}\n`);
    process.exitCode = 1;
  });
}
