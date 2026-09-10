#!/usr/bin/env node
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { createDurableJobRegistry } from '../apps/api/src/durable-job-registry.js';
import { inspectDurableJobRecovery } from '../apps/api/src/job-recovery-inspection.js';
import { createJobRegistry } from '../apps/api/src/job-registry.js';
import { resolveLocalMigrationPaths } from '../apps/api/src/local-migration-cli.js';

const scriptPath = fileURLToPath(import.meta.url);
const PACKAGED_SCRIPT_ROOT = '/usr/lib/yunpanel/scripts';

export function parseJobRecoveryArguments(argv) {
  if (!Array.isArray(argv) || argv.length !== 1 || argv[0] !== 'status') {
    throw new Error('Usage: job-recovery.mjs status');
  }
  return { action: 'status' };
}

export function isPackagedJobRecoveryScript(filePath = scriptPath) {
  const resolved = path.resolve(filePath);
  return resolved === PACKAGED_SCRIPT_ROOT || resolved.startsWith(`${PACKAGED_SCRIPT_ROOT}${path.sep}`);
}

export function assertPackagedJobRecoveryRoot({ packaged, uid = process.getuid?.() } = {}) {
  if (packaged && uid !== 0) throw new Error('Packaged job recovery inspection must be run as root');
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

export async function runJobRecoveryCli({
  argv = process.argv.slice(2),
  env = process.env,
  filePath = scriptPath,
  uid = process.getuid?.(),
  cwd = process.cwd(),
  durableRegistryFactory = createDurableJobRegistry,
  jobRegistryFactory = createJobRegistry,
  inspect = inspectDurableJobRecovery,
  stdout = process.stdout,
} = {}) {
  parseJobRecoveryArguments(argv);
  const packaged = isPackagedJobRecoveryScript(filePath);
  assertPackagedJobRecoveryRoot({ packaged, uid });
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
  formatStatus,
});
