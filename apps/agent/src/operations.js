import os from 'node:os';
import { OPERATIONS } from '@yunpanel/protocol';

function inspectServer() {
  const cpus = os.cpus();

  return {
    hostname: os.hostname(),
    platform: os.platform(),
    release: os.release(),
    architecture: os.arch(),
    uptimeSeconds: Math.floor(os.uptime()),
    cpu: {
      count: cpus.length,
      model: cpus[0]?.model ?? 'unknown',
    },
    memory: {
      totalBytes: os.totalmem(),
      freeBytes: os.freemem(),
    },
    mode: process.env.YUN_AGENT_MODE ?? 'development',
  };
}

function inspectServices() {
  return {
    services: [],
    source: 'development-placeholder',
    note: 'systemd service inspection is implemented in Milestone 1',
  };
}

export const operationHandlers = Object.freeze({
  [OPERATIONS.SERVER_INSPECT]: inspectServer,
  [OPERATIONS.SERVER_SERVICES]: inspectServices,
});

export async function executeOperation(operation, payload) {
  const handler = operationHandlers[operation];
  if (!handler) {
    const error = new Error('Operation handler is not available');
    error.code = 'operation_unavailable';
    throw error;
  }

  return handler(payload);
}
