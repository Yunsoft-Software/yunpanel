#!/usr/bin/env node
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { createDurableJobRegistry } from '../apps/api/src/durable-job-registry.js';
import { inspectDurableJobRecovery } from '../apps/api/src/job-recovery-inspection.js';
import {
  runRunningDatabaseCreateRecoveryFromStores,
  runRunningDatabaseDeleteRecoveryFromStores,
  runRunningDomainStageRecoveryFromStores,
  runRunningStaticDeploymentRecoveryFromStores,
  runTerminalRecoveryFromStores,
} from '../apps/api/src/job-recovery-runtime.js';
import { runRunningCertificateRecoveryFromStores } from '../apps/api/src/job-running-certificate-recovery-runtime.js';
import { runRunningDnsRecordRecoveryFromStores } from '../apps/api/src/job-running-dns-record-recovery-runtime.js';
import { runRunningDomainActivationRecoveryFromStores } from '../apps/api/src/job-running-domain-activation-recovery-runtime.js';
import { runRunningMailConfigRecoveryFromStores } from '../apps/api/src/job-running-mail-config-recovery-runtime.js';
import { runRunningMailDkimRecoveryFromStores } from '../apps/api/src/job-running-mail-dkim-recovery-runtime.js';
import { runRunningNodeDeploymentRecoveryFromStores } from '../apps/api/src/job-running-node-deployment-recovery-runtime.js';
import { runRunningNodeRestartRecoveryFromStores } from '../apps/api/src/job-running-node-restart-recovery-runtime.js';
import { runRunningNodeProcessRecoveryFromStores } from '../apps/api/src/job-running-node-process-recovery-runtime.js';
import { runRunningNodeRuntimeRecoveryFromStores } from '../apps/api/src/job-running-node-runtime-recovery-runtime.js';
import { runRunningNodeRollbackRecoveryFromStores } from '../apps/api/src/job-running-node-rollback-recovery-runtime.js';
import { runRunningReadOnlyRecoveryFromStores } from '../apps/api/src/job-running-readonly-recovery-runtime.js';
import { runRunningRoundcubeConfigRecoveryFromStores } from '../apps/api/src/job-running-roundcube-config-recovery-runtime.js';
import { runRunningServiceControlRecoveryFromStores } from '../apps/api/src/job-running-service-recovery-runtime.js';
import { runRunningServiceReceiptRecoveryFromStores } from '../apps/api/src/job-running-service-receipt-recovery-runtime.js';
import { runRunningStaticRollbackRecoveryFromStores } from '../apps/api/src/job-running-static-rollback-recovery-runtime.js';
import { runRunningSystemUpgradeRecoveryFromStores } from '../apps/api/src/job-running-system-upgrade-recovery-runtime.js';
import { createJobRegistry } from '../apps/api/src/job-registry.js';
import { resolveLocalMigrationPaths } from '../apps/api/src/local-migration-cli.js';
import { recordRecoveryAuditOutcome } from '../apps/api/src/recovery-audit.js';

const scriptPath = fileURLToPath(import.meta.url);
const PACKAGED_SCRIPT_ROOT = '/usr/lib/yunpanel/scripts';
const RECOVERY_ACTIONS = Object.freeze([
  'reconcile',
  'recover-readonly',
  'recover-domain-stage',
  'recover-domain-activate',
  'recover-static-deploy',
  'recover-static-rollback',
  'recover-node-deploy',
  'recover-node-restart',
  'recover-node-process',
  'recover-node-runtime-install',
  'recover-node-rollback',
  'recover-system-upgrade',
  'recover-certificate',
  'recover-database-create',
  'recover-database-delete',
  'recover-dns-record',
  'recover-service-control',
  'recover-service-mutation',
  'recover-mail-config',
  'recover-mail-dkim',
  'recover-roundcube-config',
]);
const USAGE = 'Usage: job-recovery.mjs status | reconcile <server-id> <job-id> --confirm | recover-readonly <server-id> <job-id> --confirm | recover-domain-stage <server-id> <job-id> --confirm | recover-domain-activate <server-id> <job-id> --confirm | recover-static-deploy <server-id> <job-id> --confirm | recover-static-rollback <server-id> <job-id> --confirm | recover-node-deploy <server-id> <job-id> --confirm | recover-node-restart <server-id> <job-id> --confirm | recover-node-process <server-id> <job-id> --confirm | recover-node-runtime-install <server-id> <job-id> --confirm | recover-node-rollback <server-id> <job-id> --confirm | recover-system-upgrade <server-id> <job-id> --confirm | recover-certificate <server-id> <job-id> --confirm | recover-database-create <server-id> <job-id> --confirm | recover-database-delete <server-id> <job-id> --confirm | recover-dns-record <server-id> <job-id> --confirm | recover-service-control <server-id> <job-id> --confirm | recover-service-mutation <server-id> <job-id> --confirm | recover-mail-config <server-id> <job-id> --confirm | recover-mail-dkim <server-id> <job-id> --confirm | recover-roundcube-config <server-id> <job-id> --confirm';

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
  recoverRunning = runRunningReadOnlyRecoveryFromStores,
  recoverDomainStage = runRunningDomainStageRecoveryFromStores,
  recoverDomainActivate = runRunningDomainActivationRecoveryFromStores,
  recoverStaticDeployment = runRunningStaticDeploymentRecoveryFromStores,
  recoverStaticRollback = runRunningStaticRollbackRecoveryFromStores,
  recoverNodeDeployment = runRunningNodeDeploymentRecoveryFromStores,
  recoverNodeRestart = runRunningNodeRestartRecoveryFromStores,
  recoverNodeProcess = runRunningNodeProcessRecoveryFromStores,
  recoverNodeRuntimeInstall = runRunningNodeRuntimeRecoveryFromStores,
  recoverNodeRollback = runRunningNodeRollbackRecoveryFromStores,
  recoverSystemUpgrade = runRunningSystemUpgradeRecoveryFromStores,
  recoverCertificate = runRunningCertificateRecoveryFromStores,
  recoverDatabaseCreate = runRunningDatabaseCreateRecoveryFromStores,
  recoverDatabaseDelete = runRunningDatabaseDeleteRecoveryFromStores,
  recoverDnsRecord = runRunningDnsRecordRecoveryFromStores,
  recoverServiceControl = runRunningServiceControlRecoveryFromStores,
  recoverServiceMutation = runRunningServiceReceiptRecoveryFromStores,
  recoverMailConfig = runRunningMailConfigRecoveryFromStores,
  recoverMailDkim = runRunningMailDkimRecoveryFromStores,
  recoverRoundcubeConfig = runRunningRoundcubeConfigRecoveryFromStores,
  recoveryAudit = recordRecoveryAuditOutcome,
  stdout = process.stdout,
} = {}) {
  const parsed = parseJobRecoveryArguments(argv);
  const packaged = isPackagedJobRecoveryScript(filePath);
  assertPackagedJobRecoveryRoot({ packaged, uid });

  if (RECOVERY_ACTIONS.includes(parsed.action)) {
    if (!packaged) throw new Error('Job recovery mutations are available only from the packaged YunPanel installation');
    let handler;
    if (parsed.action === 'reconcile') handler = recover;
    else if (parsed.action === 'recover-readonly') handler = recoverRunning;
    else if (parsed.action === 'recover-domain-stage') handler = recoverDomainStage;
    else if (parsed.action === 'recover-domain-activate') handler = recoverDomainActivate;
    else if (parsed.action === 'recover-static-deploy') handler = recoverStaticDeployment;
    else if (parsed.action === 'recover-static-rollback') handler = recoverStaticRollback;
    else if (parsed.action === 'recover-node-deploy') handler = recoverNodeDeployment;
    else if (parsed.action === 'recover-node-restart') handler = recoverNodeRestart;
    else if (parsed.action === 'recover-node-process') handler = recoverNodeProcess;
    else if (parsed.action === 'recover-node-runtime-install') handler = recoverNodeRuntimeInstall;
    else if (parsed.action === 'recover-node-rollback') handler = recoverNodeRollback;
    else if (parsed.action === 'recover-system-upgrade') handler = recoverSystemUpgrade;
    else if (parsed.action === 'recover-certificate') handler = recoverCertificate;
    else if (parsed.action === 'recover-database-create') handler = recoverDatabaseCreate;
    else if (parsed.action === 'recover-database-delete') handler = recoverDatabaseDelete;
    else if (parsed.action === 'recover-dns-record') handler = recoverDnsRecord;
    else if (parsed.action === 'recover-service-control') handler = recoverServiceControl;
    else if (parsed.action === 'recover-service-mutation') handler = recoverServiceMutation;
    else if (parsed.action === 'recover-mail-config') handler = recoverMailConfig;
    else if (parsed.action === 'recover-mail-dkim') handler = recoverMailDkim;
    else handler = recoverRoundcubeConfig;
    if (typeof handler !== 'function') throw new Error('Job recovery mutation dependency is invalid');
    const result = await handler({
      serverId: parsed.serverId,
      jobId: parsed.jobId,
      env,
      packaged: true,
      cwd,
    });
    if (typeof recoveryAudit === 'function') {
      try { recoveryAudit({ result, env, packaged: true, cwd }); } catch {}
    }
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