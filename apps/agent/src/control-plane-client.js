import os from 'node:os';
import path from 'node:path';
import { validateOperationEnvelope } from '@yunpanel/protocol';
import { executeOperation } from './operations.js';
import { loadAgentIdentity, saveAgentIdentity } from './identity-store.js';

export const AGENT_VERSION = '0.0.1';
const DEFAULT_HEARTBEAT_MS = 30_000;
const DEFAULT_COMMAND_POLL_MS = 5_000;
const RESULT_REPORT_ATTEMPTS = 3;

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
    throw new Error(`${operationName} returned invalid JSON`);
  }

  if (!response.ok) {
    const code = body?.error?.code ?? `http_${response.status}`;
    const message = body?.error?.message ?? `${operationName} failed`;
    const error = new Error(message);
    error.code = code;
    error.status = response.status;
    throw error;
  }

  return body;
}

function agentAuthorization(identity) {
  return `Bearer ${identity.agentToken}`;
}

function safeCommandError(error) {
  return {
    code: typeof error?.code === 'string' ? error.code.slice(0, 120) : 'operation_failed',
    message: typeof error?.message === 'string' ? error.message.slice(0, 500) : 'Agent operation failed',
  };
}

export async function enrollWithControlPlane({
  baseUrl,
  enrollmentToken,
  hostname = os.hostname(),
  displayName = null,
  fetchImpl = fetch,
}) {
  if (!enrollmentToken) throw new Error('YUNPANEL_ENROLLMENT_TOKEN is required for first enrollment');

  const response = await fetchImpl(`${baseUrl}/api/servers/enroll`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ token: enrollmentToken, hostname, displayName }),
  });

  const body = await readJsonResponse(response, 'Server enrollment');
  return {
    serverId: body.data.server.id,
    agentToken: body.data.agentToken,
    controlPlaneUrl: baseUrl,
    enrolledAt: new Date().toISOString(),
  };
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
    const result = await execute(claimed.envelope.operation, claimed.envelope.payload);
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
  enrollmentToken = process.env.YUNPANEL_ENROLLMENT_TOKEN,
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
  let identity = await loadAgentIdentity(resolvedIdentityFile);

  if (identity && identity.controlPlaneUrl !== baseUrl) {
    throw new Error('Stored agent identity belongs to a different control plane');
  }

  if (!identity) {
    identity = await enrollWithControlPlane({
      baseUrl,
      enrollmentToken,
      fetchImpl,
    });
    await saveAgentIdentity(resolvedIdentityFile, identity);
    logger.info(`[yun-agent] enrolled server ${identity.serverId}`);
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
      logger.error(`[yun-agent] heartbeat failed: ${error.code ?? error.message}`);
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
      logger.error(`[yun-agent] command polling failed: ${error.code ?? error.message}`);
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
