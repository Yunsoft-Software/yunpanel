import express from 'express';
import { inspectLocalAgent } from './agent-client.js';

export const API_VERSION = '0.0.1';

export function createApp({ inspectAgent = inspectLocalAgent, environment = process.env.NODE_ENV } = {}) {
  const app = express();

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

  app.use((request, response) => {
    response.status(404).json({ error: { code: 'not_found', message: 'Not found' } });
  });

  app.use((error, request, response, next) => {
    if (response.headersSent) return next(error);

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
