import os from 'node:os';
import path from 'node:path';
import { executeOperation } from './operations.js';
import { loadAgentIdentity, saveAgentIdentity } from './identity-store.js';

export const AGENT_VERSION = '0.0.1';
const DEFAULT_HEARTBEAT_MS = 30_000;

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
      authorization: `Bearer ${identity.agentToken}`,
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

export async function startControlPlaneLink({
  controlPlaneUrl = process.env.YUNPANEL_CONTROL_PLANE_URL,
  enrollmentToken = process.env.YUNPANEL_ENROLLMENT_TOKEN,
  identityFile,
  heartbeatMs = Number.parseInt(process.env.YUN_AGENT_HEARTBEAT_MS ?? `${DEFAULT_HEARTBEAT_MS}`, 10),
  mode = process.env.YUN_AGENT_MODE,
  fetchImpl = fetch,
  inspect = () => executeOperation('server.inspect', {}),
  inspectServices = () => executeOperation('server.services', {}),
  logger = console,
} = {}) {
  const baseUrl = normalizeControlPlaneUrl(controlPlaneUrl, mode);
  if (!baseUrl) return { enabled: false, stop() {} };

  if (!Number.isInteger(heartbeatMs) || heartbeatMs < 10_000 || heartbeatMs > 5 * 60 * 1000) {
    throw new Error('YUN_AGENT_HEARTBEAT_MS must be between 10000 and 300000 milliseconds');
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
  let timer = null;
  let heartbeatRunning = false;

  async function heartbeat() {
    if (stopped || heartbeatRunning) return;
    heartbeatRunning = true;

    try {
      const [inventory, services] = await Promise.all([inspect(), inspectServices()]);
      await sendHeartbeat({ baseUrl, identity, inventory, services, fetchImpl });
    } catch (error) {
      logger.error(`[yun-agent] heartbeat failed: ${error.code ?? error.message}`);
    } finally {
      heartbeatRunning = false;
    }
  }

  await heartbeat();
  timer = setInterval(heartbeat, heartbeatMs);
  timer.unref?.();

  return {
    enabled: true,
    serverId: identity.serverId,
    async heartbeatNow() {
      await heartbeat();
    },
    stop() {
      stopped = true;
      if (timer) clearInterval(timer);
    },
  };
}
