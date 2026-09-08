import { timingSafeEqual } from 'node:crypto';
import { createServer } from 'node:http';
import { validateOperationEnvelope } from '@yunpanel/protocol';
import { executeOperation } from './operations.js';

const MAX_BODY_BYTES = 64 * 1024;
const DEVELOPMENT_TOKEN = 'development-only-token';

function resolveAgentToken() {
  if (process.env.YUN_AGENT_TOKEN) return process.env.YUN_AGENT_TOKEN;
  if (process.env.YUN_AGENT_MODE === 'development') return DEVELOPMENT_TOKEN;
  throw new Error('YUN_AGENT_TOKEN is required outside development mode');
}

function tokenMatches(headerValue, expectedToken) {
  if (typeof headerValue !== 'string' || !headerValue.startsWith('Bearer ')) return false;

  const provided = Buffer.from(headerValue.slice(7));
  const expected = Buffer.from(expectedToken);
  return provided.length === expected.length && timingSafeEqual(provided, expected);
}

function sendJson(response, statusCode, body) {
  const payload = JSON.stringify(body);
  response.writeHead(statusCode, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': Buffer.byteLength(payload),
    'cache-control': 'no-store',
  });
  response.end(payload);
}

async function readJsonBody(request) {
  let size = 0;
  const chunks = [];

  for await (const chunk of request) {
    size += chunk.length;
    if (size > MAX_BODY_BYTES) {
      const error = new Error('Request body is too large');
      error.code = 'body_too_large';
      throw error;
    }
    chunks.push(chunk);
  }

  if (chunks.length === 0) return {};

  try {
    return JSON.parse(Buffer.concat(chunks).toString('utf8'));
  } catch {
    const error = new Error('Request body must contain valid JSON');
    error.code = 'invalid_json';
    throw error;
  }
}

export function createAgentServer({ token = resolveAgentToken(), execute = executeOperation } = {}) {
  return createServer(async (request, response) => {
    if (request.method === 'GET' && request.url === '/health') {
      return sendJson(response, 200, {
        status: 'ok',
        service: 'yun-agent',
        mode: process.env.YUN_AGENT_MODE ?? 'protected',
      });
    }

    if (request.method !== 'POST' || request.url !== '/v1/operations') {
      return sendJson(response, 404, { error: { code: 'not_found', message: 'Not found' } });
    }

    if (!tokenMatches(request.headers.authorization, token)) {
      return sendJson(response, 401, {
        error: { code: 'unauthorized', message: 'Agent authentication failed' },
      });
    }

    try {
      const envelope = await readJsonBody(request);
      const validation = validateOperationEnvelope(envelope);

      if (!validation.ok) {
        return sendJson(response, 400, {
          error: {
            code: 'invalid_operation',
            message: 'Operation request failed validation',
            details: validation.errors,
          },
        });
      }

      const result = await execute(envelope.operation, envelope.payload);
      return sendJson(response, 200, {
        requestId: envelope.id,
        operation: envelope.operation,
        status: 'succeeded',
        result,
      });
    } catch (error) {
      const statusCode = error.code === 'body_too_large' ? 413 : error.code === 'invalid_json' ? 400 : 500;
      const code = error.code === 'body_too_large' || error.code === 'invalid_json' ? error.code : 'operation_failed';
      return sendJson(response, statusCode, {
        error: {
          code,
          message: statusCode === 500 ? 'Agent operation failed' : error.message,
        },
      });
    }
  });
}
