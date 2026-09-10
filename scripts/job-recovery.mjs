#!/usr/bin/env node
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { createDurableJobRegistry } from '../apps/api/src/durable-job-registry.js';
import { inspectDurableJobRecovery } from '../apps/api/src/job-recovery-inspection.js';
import {
  runRunningDomainStageRecoveryFromStores,
  runRunningInspectionRecoveryFromStores,
  runTerminalRecoveryFromStores,
} from '../apps/api/src/job-recovery-runtime.js';
import { createJobRegistry } from '../apps/api/src/job-registry.js';
import { resolveLocalMigrationPaths } from '../apps/api/src/local-migration-cli.js';

const scriptPath = fileURLToPath(import.meta.url);
const PACKAGED_SCRIPT_ROOT = '/usr/lib/yunpanel/scripts';
const RECOVERY_ACTIONS = Object.freeze(['reconcile', 'recover-readonly', 'recover-domain-stage']);
const USAGE = 'Usage: job-recovery.mjs status | reconcile <server-id> <job-id> --confirm | recover-readonly <server-id> <job-id> --confirm | recover-domain-stage <server-id> <job-id> --confirm';

export function parseJobRecoveryArguments(argv) {
  if (!Array.isArray(argv)) throw new Error(USAGE);
  if (argv.length === 1 && argv[0] === 'status') return { action: 'status' };
  if (argv.length === 4 && RECOVERY_ACTIONS.includes(argv[0]) && argv[3] === '--confirm'
    && typeof argv[1] === 'string' && argv[1] && typeof argv[2] === 'string' && argv[2]) {
    return { action: argv[0], serverId: argv[1], jobId: argv[2], confirm: true };
  }
  throw new Error(USAGE);
}

export function isPackagedJobRecoveryScript(filePath = scriptPath) {
  const resolved = path.resolve(filePath);
  return resolved === PACKAGED_SCRIPT_ROOT || resolved.startsWith(`${PACKAGED_SCRIPT_ROOT}${path.sep}`);
}

export function assertPackagedJobRecoveryRoot({ packaged, uid = process.getuid?.() } = {}) {
  if (packaged && uid !== 0) throw new Error('Packaged job recovery commands must be run as root');
}

function formatValue(value) {
  return value == null ? '-' : String(value);
}

function formatStatus(result) {
  const lines = [
    `state=${result.state}`,
    `version=${result.version}`,
    `code=${formatValue(result.code)}`,
    `detectedAt=${formatValue(result.detectedAt)}`,
    `jobs=${result.jobs.length}`,
    `jobStore=${result.statePaths.jobStore}`,
    `recoveryStore=${result.statePaths.recoveryStore}`,
  ];
  for (const job of result.jobs) {
    lines.push([
      'job',
      `server=${job.serverId}`,
      `id=${job.jobId}`,
      `status=${formatValue(job.status)}`,
      `operation=${formatValue(job.operation)}`,
      `resourceType=${formatValue(job.resourceType)}`,
      `resourceId=${formatValue(job.resourceId)}`,
      `createdAt=${formatValue(job.createdAt)}`,
      `startedAt=${formatValue(job.startedAt)}`,
      `finishedAt=${formatValue(job.finishedAt)}`,
      `attempts=${formatValue(job.attempts)}`,
    ].join(' '));
  }
  return lines.join('\n');
}

function formatReconciliation(result) {
  return [
    `reconciled server=${result.serverId} job=${result.jobId} status=${result.status}`,
    `jobStore=${result.statePaths.jobStore}`,
    `recoveryStore=${result.statePaths.recoveryStore}`,
  ].join('\n');
}

function formatRunningRecovery(result) {
  return [
    `recovered server=${result.serverId} job=${result.jobId} status=${result.status}`,
    `operation=${result.operation}`,
    `method=${result.recoveryMethod}`,
    `jobStore=${result.statePaths.jobStore}`,
    `recoveryStore=${result.statePaths.recoveryStore}`,
  ].join('\n');
}

export async function runJobRecoveryCli({
  argv = process.argv.slice(2),
  env = process.env,
  filePath = scriptPath,
  uid = process.getuid?.(),
  cwd = process.cwd(),
  durableRegistryFactory = createDurableJobRegistry,
  jobRegistryFactory = createJobRegistry,
  inspect = inspectDurableJobRecovery,
  recover = runTerminalRecoveryFromStores,
  recoverRunning = runRunningInspectionRecoveryFromStores,
  recoverDomainStage = runRunningDomainStageRecoveryFromStores,
  stdout = process.stdout,
} = {}) {
  const parsed = parseJobRecoveryArguments(argv);
  const packaged = isPackagedJobRecoveryScript(filePath);
  assertPackagedJobRecoveryRoot({ packaged, uid });

  if (RECOVERY_ACTIONS.includes(parsed.action)) {
    if (!packaged) throw new Error('Job recovery mutations are available only from the packaged YunPanel installation');
    const handler = parsed.action === 'reconcile'
      ? recover
      : parsed.action === 'recover-readonly'
        ? recoverRunning
        : recoverDomainStage;
    if (typeof handler !== 'function') throw new Error('Job recovery mutation dependency is invalid');
    const result = await handler({
      serverId: parsed.serverId,
      jobId: parsed.jobId,
      env,
      packaged: true,
      cwd,
    });
    stdout.write(`${parsed.action === 'reconcile' ? formatReconciliation(result) : formatRunningRecovery(result)}\n`);
    return result;
  }

  if (typeof durableRegistryFactory !== 'function' || typeof jobRegistryFactory !== 'function' || typeof inspect !== 'function') {
    throw new Error('Job recovery inspection dependencies are invalid');
  }
  const paths = resolveLocalMigrationPaths({ env, packaged, cwd });
  const registry = durableRegistryFactory({ filePath: paths.jobStore, registryFactory: jobRegistryFactory });
  const inspection = await inspect({ registry });
  const result = Object.freeze({
    action: 'status',
    ...inspection,
    statePaths: Object.freeze({
      jobStore: paths.jobStore,
      recoveryStore: `${paths.jobStore}.recovery.json`,
    }),
  });
  stdout.write(`${formatStatus(result)}\n`);
  return result;
}

const invoked = process.argv[1] ? pathToFileURL(path.resolve(process.argv[1])).href : null;
if (invoked === import.meta.url) {
  runJobRecoveryCli().catch((error) => {
    process.stderr.write(`${error.code ? `${error.code}: ` : ''}${error.message}\n`);
    process.exitCode = 1;
  });
}

export const jobRecoveryCliInternals = Object.freeze({
  packagedScriptRoot: PACKAGED_SCRIPT_ROOT,
  recoveryActions: RECOVERY_ACTIONS,
  formatStatus,
  formatReconciliation,
  formatRunningRecovery,
});
