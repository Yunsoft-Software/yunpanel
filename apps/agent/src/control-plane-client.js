import path from 'node:path';
import { OPERATIONS, validateOperationEnvelope } from '@yunpanel/protocol';
import { normalizeApplicationEnvironmentBundle, normalizeGitDeploymentCredential } from '@yunpanel/shared';
import { executeOperation } from './operations.js';
import { loadAgentIdentity } from './identity-store.js';
import { safeLegacyAgentDiagnosticCode, safeLegacyAgentError } from './legacy-safe-error.js';

export const AGENT_VERSION = '0.3.0';
const DEFAULT_HEARTBEAT_MS = 30_000;
const DEFAULT_COMMAND_POLL_MS = 5_000;
const RESULT_REPORT_ATTEMPTS = 3;
const ENVIRONMENT_OPERATIONS = new Set([
  OPERATIONS.APP_NODE_DEPLOY,
  OPERATIONS.APP_NODE_RESTART,
  OPERATIONS.APP_NODE_ROLLBACK,
]);
const DEPLOYMENT_OPERATIONS = new Set([OPERATIONS.APP_STATIC_DEPLOY, OPERATIONS.APP_NODE_DEPLOY]);

function sleep(milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

export function normalizeControlPlaneUrl(rawUrl, mode = process.env.YUN_AGENT_MODE) {
  if (!rawUrl) return null;

  const url = new URL(rawUrl);
  if (url.username || url.password || url.search || url.hash) {
    throw new Error('YUNPANEL_CONTROL_PLANE_URL must not contain credentials, query parameters or fragments');
  }

  if (mode !== 'development' && url.protocol !== 'https:') {
    throw new Error('YUNPANEL_CONTROL_PLANE_URL must use HTTPS outside development mode');
  }

  if (mode === 'development' && !['http:', 'https:'].includes(url.protocol)) {
    throw new Error('YUNPANEL_CONTROL_PLANE_URL must use HTTP or HTTPS');
  }

  return url.origin;
}

function resolveIdentityFile(mode = process.env.YUN_AGENT_MODE) {
  if (process.env.YUN_AGENT_IDENTITY_FILE) return path.resolve(process.env.YUN_AGENT_IDENTITY_FILE);
  if (mode === 'development') return path.resolve('.data/agent-identity.json');
  throw new Error('YUN_AGENT_IDENTITY_FILE is required outside development mode');
}

async function readJsonResponse(response, operationName) {
  let body;
  try {
    body = await response.json();
  } catch {
    const error = new Error(`${operationName} returned invalid JSON`);
    error.code = 'control_plane_invalid_json';
    error.status = response.status;
    throw error;
  }

  if (!response.ok) {
    const safe = safeLegacyAgentError({ code: body?.error?.code });
    const recognized = safe.code !== 'legacy_operation_failed';
    const error = new Error(recognized ? safe.message : `${operationName} failed`);
    error.code = recognized ? safe.code : 'control_plane_request_failed';
    error.status = response.status;
    throw error;
  }

  return body;
}

function agentAuthorization(identity) {
  return `Bearer ${identity.agentToken}`;
}

function safeCommandError(error) {
  return safeLegacyAgentError(error);
}

export async function sendHeartbeat({
  baseUrl,
  identity,
  inventory,
  services,
  fetchImpl = fetch,
}) {
  const response = await fetchImpl(`${baseUrl}/api/servers/${identity.serverId}/heartbeat`, {
    method: 'POST',
    headers: {
      authorization: agentAuthorization(identity),
      'content-type': 'application/json',
    },
    body: JSON.stringify({
      agentVersion: AGENT_VERSION,
      inventory,
      services,
    }),
  });

  const body = await readJsonResponse(response, 'Agent heartbeat');
  return body.data;
}

export async function fetchNextCommand({ baseUrl, identity, fetchImpl = fetch }) {
  const response = await fetchImpl(`${baseUrl}/api/servers/${identity.serverId}/commands/next`, {
    headers: { authorization: agentAuthorization(identity) },
  });

  if (response.status === 204) return null;
  const body = await readJsonResponse(response, 'Command claim');
  const claimed = body?.data;
  const validation = validateOperationEnvelope(claimed?.envelope);

  if (!claimed?.job || claimed.job.id !== claimed.envelope?.id || !validation.ok) {
    const error = new Error('Control plane returned an invalid command envelope');
    error.code = 'invalid_command_envelope';
    throw error;
  }

  return claimed;
}

export async function fetchApplicationEnvironment({
  baseUrl,
  identity,
  applicationId,
  environmentRevision = null,
  fetchImpl = fetch,
}) {
  const revisionQuery = environmentRevision === null ? '' : `?revision=${environmentRevision}`;
  const response = await fetchImpl(
    `${baseUrl}/api/servers/${identity.serverId}/applications/${applicationId}/environment${revisionQuery}`,
    { headers: { authorization: agentAuthorization(identity) } },
  );
  const body = await readJsonResponse(response, 'Application environment');
  try {
    if (environmentRevision !== null && body?.environmentRevision !== environmentRevision) throw new Error('revision mismatch');
    return normalizeApplicationEnvironmentBundle(body?.data ?? {});
  } catch {
    const error = new Error('Control plane returned an invalid application environment bundle');
    error.code = 'invalid_environment_bundle';
    throw error;
  }
}

export async function fetchApplicationDeploymentCredential({
  baseUrl,
  identity,
  applicationId,
  fetchImpl = fetch,
}) {
  const response = await fetchImpl(
    `${baseUrl}/api/servers/${identity.serverId}/applications/${applicationId}/deployment-credential`,
    { headers: { authorization: agentAuthorization(identity) } },
  );
  const body = await readJsonResponse(response, 'Application deployment credential');
  try {
    return normalizeGitDeploymentCredential(body?.data ?? null);
  } catch {
    const error = new Error('Control plane returned an invalid Git deployment credential');
    error.code = 'invalid_git_credential';
    throw error;
  }
}

export async function reportCommandResult({
  baseUrl,
  identity,
  jobId,
  completion,
  fetchImpl = fetch,
}) {
  const response = await fetchImpl(`${baseUrl}/api/servers/${identity.serverId}/commands/${jobId}/result`, {
    method: 'POST',
    headers: {
      authorization: agentAuthorization(identity),
      'content-type': 'application/json',
    },
    body: JSON.stringify(completion),
  });

  const body = await readJsonResponse(response, 'Command result');
  return body.data;
}

async function reportCommandResultWithRetry({ sleepFn = sleep, ...options }) {
  let lastError;
  for (let attempt = 1; attempt <= RESULT_REPORT_ATTEMPTS; attempt += 1) {
    try {
      return await reportCommandResult(options);
    } catch (error) {
      lastError = error;
      if (attempt < RESULT_REPORT_ATTEMPTS) await sleepFn(attempt * 250);
    }
  }
  throw lastError;
}

export async function executeClaimedCommand({
  claimed,
  execute = executeOperation,
  baseUrl,
  identity,
  fetchImpl = fetch,
  sleepFn = sleep,
}) {
  let completion;

  try {
    let executionPayload = claimed.envelope.payload;
    if (ENVIRONMENT_OPERATIONS.has(claimed.envelope.operation)) {
      const environment = await fetchApplicationEnvironment({
        baseUrl,
        identity,
        applicationId: claimed.envelope.payload.applicationId,
        environmentRevision: claimed.envelope.payload.environmentRevision ?? null,
        fetchImpl,
      });
      executionPayload = { ...executionPayload, environment };
    }
    if (DEPLOYMENT_OPERATIONS.has(claimed.envelope.operation)) {
      const gitCredential = await fetchApplicationDeploymentCredential({
        baseUrl,
        identity,
        applicationId: claimed.envelope.payload.applicationId,
        fetchImpl,
      });
      executionPayload = { ...executionPayload, gitCredential };
    }
    const result = await execute(claimed.envelope.operation, executionPayload);
    completion = { status: 'succeeded', result };
  } catch (error) {
    completion = { status: 'failed', error: safeCommandError(error) };
  }

  await reportCommandResultWithRetry({
    baseUrl,
    identity,
    jobId: claimed.job.id,
    completion,
    fetchImpl,
    sleepFn,
  });

  return completion;
}

export async function startControlPlaneLink({
  controlPlaneUrl = process.env.YUNPANEL_CONTROL_PLANE_URL,
  identityFile,
  heartbeatMs = Number.parseInt(process.env.YUN_AGENT_HEARTBEAT_MS ?? `${DEFAULT_HEARTBEAT_MS}`, 10),
  commandPollMs = Number.parseInt(process.env.YUN_AGENT_COMMAND_POLL_MS ?? `${DEFAULT_COMMAND_POLL_MS}`, 10),
  mode = process.env.YUN_AGENT_MODE,
  fetchImpl = fetch,
  inspect = () => executeOperation('server.inspect', {}),
  inspectServices = () => executeOperation('server.services', {}),
  inspectDocker = () => executeOperation('server.docker', {}),
  inspectNginx = () => executeOperation('server.nginx', {}),
  execute = executeOperation,
  sleepFn = sleep,
  logger = console,
} = {}) {
  const baseUrl = normalizeControlPlaneUrl(controlPlaneUrl, mode);
  if (!baseUrl) return { enabled: false, stop() {} };

  if (!Number.isInteger(heartbeatMs) || heartbeatMs < 10_000 || heartbeatMs > 5 * 60 * 1000) {
    throw new Error('YUN_AGENT_HEARTBEAT_MS must be between 10000 and 300000 milliseconds');
  }
  if (!Number.isInteger(commandPollMs) || commandPollMs < 1_000 || commandPollMs > 60_000) {
    throw new Error('YUN_AGENT_COMMAND_POLL_MS must be between 1000 and 60000 milliseconds');
  }

  const resolvedIdentityFile = identityFile ?? resolveIdentityFile(mode);
  const identity = await loadAgentIdentity(resolvedIdentityFile);

  if (!identity) {
    const error = new Error('Retained legacy agent requires an existing identity; new enrollment is retired');
    error.code = 'legacy_agent_identity_required';
    throw error;
  }
  if (identity.controlPlaneUrl !== baseUrl) {
    throw new Error('Stored agent identity belongs to a different control plane');
  }

  let stopped = false;
  let heartbeatTimer = null;
  let commandTimer = null;
  let heartbeatRunning = false;
  let commandRunning = false;

  async function heartbeat() {
    if (stopped || heartbeatRunning) return;
    heartbeatRunning = true;

    try {
      const [baseInventory, services, docker, nginx] = await Promise.all([
        inspect(),
        inspectServices(),
        inspectDocker(),
        inspectNginx(),
      ]);
      const inventory = { ...baseInventory, docker, nginx };
      await sendHeartbeat({ baseUrl, identity, inventory, services, fetchImpl });
    } catch (error) {
      logger.error(`[yun-agent] heartbeat failed: ${safeLegacyAgentDiagnosticCode(error, 'heartbeat_failed')}`);
    } finally {
      heartbeatRunning = false;
    }
  }

  async function pollCommands() {
    if (stopped || commandRunning) return;
    commandRunning = true;

    try {
      const claimed = await fetchNextCommand({ baseUrl, identity, fetchImpl });
      if (claimed) {
        await executeClaimedCommand({
          claimed,
          execute,
          baseUrl,
          identity,
          fetchImpl,
          sleepFn,
        });
      }
    } catch (error) {
      logger.error(`[yun-agent] command polling failed: ${safeLegacyAgentDiagnosticCode(error, 'command_poll_failed')}`);
    } finally {
      commandRunning = false;
    }
  }

  await heartbeat();
  await pollCommands();
  heartbeatTimer = setInterval(heartbeat, heartbeatMs);
  commandTimer = setInterval(pollCommands, commandPollMs);
  heartbeatTimer.unref?.();
  commandTimer.unref?.();

  return {
    enabled: true,
    serverId: identity.serverId,
    async heartbeatNow() {
      await heartbeat();
    },
    async pollCommandsNow() {
      await pollCommands();
    },
    stop() {
      stopped = true;
      if (heartbeatTimer) clearInterval(heartbeatTimer);
      if (commandTimer) clearInterval(commandTimer);
    },
  };
}
