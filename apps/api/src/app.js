import express from 'express';
import { inspectLocalAgent } from './agent-client.js';
import { createBootstrapAdminGuard, resolveBootstrapAdminToken } from './bootstrap-auth.js';
import { createServerRegistry, RegistryError } from './server-registry.js';

export const API_VERSION = '0.0.1';

function bearerToken(request) {
  const header = request.headers.authorization;
  return typeof header === 'string' && header.startsWith('Bearer ') ? header.slice(7) : null;
}

export function createApp({
  inspectAgent = inspectLocalAgent,
  environment = process.env.NODE_ENV,
  registry = createServerRegistry(),
  adminToken,
} = {}) {
  const app = express();
  const resolvedAdminToken = adminToken === undefined
    ? resolveBootstrapAdminToken({ environment })
    : adminToken;
  const requireBootstrapAdmin = createBootstrapAdminGuard({ token: resolvedAdminToken });

  app.disable('x-powered-by');
  app.use(express.json({ limit: '256kb' }));

  app.get('/api/health', (request, response) => {
    response.json({
      status: 'ok',
      service: 'yunpanel-api',
      version: API_VERSION,
    });
  });

  app.get('/api/dev/agent/inspect', async (request, response) => {
    if (environment !== 'development') {
      return response.status(404).json({ error: { code: 'not_found', message: 'Not found' } });
    }

    try {
      const result = await inspectAgent();
      return response.json(result);
    } catch (error) {
      return response.status(502).json({
        error: {
          code: 'agent_unavailable',
          message: error.message,
        },
      });
    }
  });

  app.get('/api/servers', requireBootstrapAdmin, async (request, response) => {
    const servers = await registry.listServers();
    return response.json({ data: servers });
  });

  app.get('/api/servers/:serverId', requireBootstrapAdmin, async (request, response) => {
    const server = await registry.getServer(request.params.serverId);
    if (!server) {
      return response.status(404).json({ error: { code: 'server_not_found', message: 'Server not found' } });
    }
    return response.json({ data: server });
  });

  app.post('/api/servers/enrollment-tokens', requireBootstrapAdmin, async (request, response) => {
    const ttlMinutes = request.body?.ttlMinutes;
    const options = { label: request.body?.label ?? null };
    if (ttlMinutes !== undefined) options.ttlMs = Number(ttlMinutes) * 60 * 1000;

    const enrollment = await registry.issueEnrollmentToken(options);
    return response.status(201).json({ data: enrollment });
  });

  app.post('/api/servers/enroll', async (request, response) => {
    const enrolled = await registry.enrollServer({
      token: request.body?.token,
      hostname: request.body?.hostname,
      displayName: request.body?.displayName ?? null,
    });

    return response.status(201).json({ data: enrolled });
  });

  app.post('/api/servers/:serverId/heartbeat', async (request, response) => {
    const server = await registry.heartbeat({
      serverId: request.params.serverId,
      agentToken: bearerToken(request),
      agentVersion: request.body?.agentVersion ?? null,
      inventory: request.body?.inventory ?? null,
      services: request.body?.services ?? null,
    });

    return response.json({ data: server });
  });

  app.use((request, response) => {
    response.status(404).json({ error: { code: 'not_found', message: 'Not found' } });
  });

  app.use((error, request, response, next) => {
    if (response.headersSent) return next(error);

    if (error instanceof RegistryError) {
      return response.status(error.status).json({
        error: {
          code: error.code,
          message: error.message,
        },
      });
    }

    const isJsonSyntaxError = error instanceof SyntaxError && error.status === 400;
    return response.status(isJsonSyntaxError ? 400 : 500).json({
      error: {
        code: isJsonSyntaxError ? 'invalid_json' : 'internal_error',
        message: isJsonSyntaxError ? 'Invalid JSON body' : 'Unexpected server error',
      },
    });
  });

  return app;
}
