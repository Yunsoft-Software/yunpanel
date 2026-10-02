import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';

function createExpressMockApp() {
  const globalMiddlewares = [];
  const errorHandlers = [];
  const routes = [];

  const app = {
    use(fn) {
      if (typeof fn === 'function') {
        if (fn.length === 4) {
          errorHandlers.push(fn);
        } else {
          globalMiddlewares.push(fn);
        }
      }
      return app;
    },
    get(pathPattern, ...handlers) {
      const paramNames = [];
      const regexStr = '^' + pathPattern.replace(/:([a-zA-Z0-9_]+)/g, (_, name) => {
        paramNames.push(name);
        return '([^/]+)';
      }) + '$';
      routes.push({
        method: 'GET',
        pathPattern,
        regex: new RegExp(regexStr),
        paramNames,
        handlers,
      });
      return app;
    },
    post(pathPattern, ...handlers) {
      const paramNames = [];
      const regexStr = '^' + pathPattern.replace(/:([a-zA-Z0-9_]+)/g, (_, name) => {
        paramNames.push(name);
        return '([^/]+)';
      }) + '$';
      routes.push({
        method: 'POST',
        pathPattern,
        regex: new RegExp(regexStr),
        paramNames,
        handlers,
      });
      return app;
    },
    listen(port, callback) {
      const server = http.createServer(async (req, res) => {
        res.status = function (statusCode) {
          res.statusCode = statusCode;
          return res;
        };
        res.set = function (headerName, headerValue) {
          if (!res.headersSent) {
            if (typeof headerName === 'object' && headerName !== null) {
              for (const [k, v] of Object.entries(headerName)) {
                res.setHeader(k, v);
              }
            } else if (typeof headerName === 'string') {
              res.setHeader(headerName, headerValue);
            }
          }
          return res;
        };
        res.json = function (data) {
          if (!res.headersSent) {
            res.setHeader('content-type', 'application/json');
            res.end(JSON.stringify(data));
          }
          return res;
        };
        res.send = function (data) {
          if (!res.headersSent) {
            if (typeof data === 'object' && data !== null) {
              return res.json(data);
            }
            res.end(data);
          }
          return res;
        };

        req.originalUrl = req.url;

        if (['POST', 'PUT', 'PATCH'].includes(req.method)) {
          try {
            const chunks = [];
            for await (const chunk of req) {
              chunks.push(chunk);
            }
            const raw = Buffer.concat(chunks).toString('utf8');
            req.body = raw.trim() ? JSON.parse(raw) : {};
          } catch {
            req.body = {};
          }
        } else {
          req.body = {};
        }

        const urlObj = new URL(req.url, 'http://127.0.0.1');
        const pathname = urlObj.pathname;
        req.query = Object.fromEntries(urlObj.searchParams.entries());

        let matchedRoute = null;
        const routeParams = {};

        for (const r of routes) {
          if (r.method !== req.method) continue;
          const match = pathname.match(r.regex);
          if (match) {
            matchedRoute = r;
            r.paramNames.forEach((name, idx) => {
              routeParams[name] = match[idx + 1];
            });
            break;
          }
        }

        req.params = routeParams;

        if (!matchedRoute) {
          res.status(404).json({ error: { code: 'not_found', message: 'Not Found' } });
          return;
        }

        const chain = [...globalMiddlewares, ...matchedRoute.handlers];
        let idx = 0;

        const handleError = async (err) => {
          if (res.headersSent) return;
          let errIdx = 0;
          const runErrHandler = async (e) => {
            if (res.headersSent) return;
            if (errIdx < errorHandlers.length) {
              const h = errorHandlers[errIdx++];
              try {
                await h(e, req, res, runErrHandler);
              } catch (handlerError) {
                await runErrHandler(handlerError);
              }
            } else {
              const status = e.status ?? 500;
              const code = e.code ?? 'internal_error';
              res.status(status).json({ error: { code, message: e.message } });
            }
          };
          await runErrHandler(err);
        };

        const next = async (err) => {
          if (res.headersSent) return;
          if (err) {
            return handleError(err);
          }
          if (idx < chain.length) {
            const handler = chain[idx++];
            try {
              await handler(req, res, next);
            } catch (handlerErr) {
              await handleError(handlerErr);
            }
          }
        };

        await next();
      });

      return server.listen(port, callback);
    },
  };

  return app;
}

const express = () => createExpressMockApp();
express.json = () => (req, res, next) => next();

import {
  mountDomainRemovalRoutes,
} from '../src/domain-removal-http.js';

function createTestApp(runtime) {
  const app = express();
  app.use(express.json());
  app.use((req, res, next) => {
    req.auth = {
      user: { role: 'owner' },
      access: { mode: 'management', permissions: ['*'] },
      security: { managementAllowed: true },
    };
    next();
  });
  mountDomainRemovalRoutes(app, { runtime });
  app.use((err, req, res, next) => {
    res.status(err.status || 500).json({ error: { code: err.code || err.message } });
  });
  return app;
}

test('domain-removal-http routes handle preview, start, continue and retry requests', async () => {
  const checksum = 'a'.repeat(64);
  const mockOperation = {
    id: 'op-1',
    domainId: 'dom-1',
    status: 'running',
    checksum,
    updatedAt: '2026-09-19T20:00:00.000Z',
    steps: [
      { id: 'step-1', kind: 'routing_suspend', status: 'failed' },
      { id: 'step-2', kind: 'certificate', status: 'pending' },
    ],
  };

  const mockRuntime = {
    preview: async ({ domainId }) => ({
      domain: { id: domainId },
      readyToStart: true,
      previewDigest: checksum,
      confirmation: `start-domain-remove:${domainId}:1:${checksum}`,
    }),
    listForDomain: async () => [mockOperation],
    get: async (id) => (id === 'op-1' ? mockOperation : null),
    start: async ({ domainId }) => ({ ...mockOperation, domainId }),
    retryRouting: async () => ({ ...mockOperation, status: 'running' }),
    continueStep: async () => ({ ...mockOperation, status: 'succeeded' }),
  };

  const app = createTestApp(mockRuntime);
  const server = app.listen(0);
  const address = server.address();
  const baseUrl = `http://127.0.0.1:${address.port}`;

  try {
    // 1. GET /api/domains/:domainId/removal
    const getRes = await fetch(`${baseUrl}/api/domains/dom-1/removal`);
    assert.equal(getRes.status, 200);
    const getData = await getRes.json();
    assert.equal(getData.preview.readyToStart, true);
    assert.equal(getData.operations.length, 1);

    // 2. POST /api/domains/:domainId/removal-preview
    const previewRes = await fetch(`${baseUrl}/api/domains/dom-1/removal-preview`, { method: 'POST' });
    assert.equal(previewRes.status, 200);
    const previewData = await previewRes.json();
    assert.equal(previewData.preview.readyToStart, true);

    // 3. POST /api/domains/:domainId/removal (start)
    const startRes = await fetch(`${baseUrl}/api/domains/dom-1/removal`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        previewDigest: checksum,
        confirmation: `start-domain-remove:dom-1:1:${checksum}`,
      }),
    });
    assert.equal(startRes.status, 201);
    const startData = await startRes.json();
    assert.equal(startData.operation.id, 'op-1');

    // 4. GET /api/domains/:domainId/removal-operations
    const listRes = await fetch(`${baseUrl}/api/domains/dom-1/removal-operations`);
    assert.equal(listRes.status, 200);
    const listData = await listRes.json();
    assert.equal(listData.operations.length, 1);

    // 5. GET /api/domains/:domainId/removal-operations/:operationId
    const opRes = await fetch(`${baseUrl}/api/domains/dom-1/removal-operations/op-1`);
    assert.equal(opRes.status, 200);
    const opData = await opRes.json();
    assert.equal(opData.operation.id, 'op-1');

    // 6. POST retry-routing
    const retryRes = await fetch(`${baseUrl}/api/domains/dom-1/removal-operations/op-1/retry-routing`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        expectedUpdatedAt: '2026-09-19T20:00:00.000Z',
        checksum,
        confirmation: 'retry-domain-routing:op-1',
      }),
    });
    assert.equal(retryRes.status, 200);

    // 7. POST continue
    const continueRes = await fetch(`${baseUrl}/api/domains/dom-1/removal-operations/op-1/continue`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        expectedUpdatedAt: '2026-09-19T20:00:00.000Z',
        stepId: 'step-2',
        checksum,
        confirmation: 'continue-domain-step:op-1:step-2',
      }),
    });
    assert.equal(continueRes.status, 200);

    // 8. Invalid body rejected
    const badRes = await fetch(`${baseUrl}/api/domains/dom-1/removal`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ bad: 'input' }),
    });
    assert.equal(badRes.status, 400);
  } finally {
    server.close();
  }
});
