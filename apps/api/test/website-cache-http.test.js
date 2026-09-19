import test from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import { mountWebsiteCacheRoutes } from '../src/website-cache-http.js';

const WEBSITE_ID = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';

function createTestApp({
  websiteCacheService = {},
  userRole = 'owner',
} = {}) {
  const app = express();
  app.use(express.json());

  const requirePanelRouteAccess = ({ minRole } = {}) => (req, res, next) => {
    if (!userRole) {
      return res.status(401).json({ error: { code: 'unauthorized', message: 'Authentication required' } });
    }
    if (minRole === 'operator' && userRole === 'readonly') {
      return res.status(403).json({ error: { code: 'forbidden', message: 'Operator role required' } });
    }
    next();
  };

  mountWebsiteCacheRoutes(app, {
    websiteCacheService,
    requirePanelRouteAccess,
  });

  return app;
}

test('GET /api/websites/:websiteId/cache returns policy', async () => {
  const app = createTestApp({
    websiteCacheService: {
      getCachePolicy: async (id) => {
        assert.equal(id, WEBSITE_ID);
        return { enabled: true, type: 'redis', redis: { username: 'yunapp-test' } };
      },
    },
  });

  const server = app.listen(0);
  const address = server.address();
  const url = `http://127.0.0.1:${address.port}/api/websites/${WEBSITE_ID}/cache`;

  try {
    const res = await fetch(url);
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(body.enabled, true);
    assert.equal(body.type, 'redis');
  } finally {
    server.close();
  }
});

test('POST /api/websites/:websiteId/cache/redis/enable enables redis', async () => {
  const app = createTestApp({
    websiteCacheService: {
      enableRedisCache: async (id, params) => {
        assert.equal(id, WEBSITE_ID);
        assert.equal(params.keyPrefix, 'site:');
        return { enabled: true, type: 'redis', redis: { password: 'plain_password' } };
      },
    },
  });

  const server = app.listen(0);
  const address = server.address();
  const url = `http://127.0.0.1:${address.port}/api/websites/${WEBSITE_ID}/cache/redis/enable`;

  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ keyPrefix: 'site:' }),
    });
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(body.enabled, true);
    assert.equal(body.redis.password, 'plain_password');
  } finally {
    server.close();
  }
});

test('POST /api/websites/:websiteId/cache/redis/rotate-password rotates password', async () => {
  const app = createTestApp({
    websiteCacheService: {
      rotateRedisPassword: async (id) => {
        assert.equal(id, WEBSITE_ID);
        return { rotated: true, redis: { password: 'new_password' } };
      },
    },
  });

  const server = app.listen(0);
  const address = server.address();
  const url = `http://127.0.0.1:${address.port}/api/websites/${WEBSITE_ID}/cache/redis/rotate-password`;

  try {
    const res = await fetch(url, { method: 'POST' });
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(body.rotated, true);
    assert.equal(body.redis.password, 'new_password');
  } finally {
    server.close();
  }
});

test('POST /api/websites/:websiteId/cache/memcached/enable enables memcached', async () => {
  const app = createTestApp({
    websiteCacheService: {
      enableMemcached: async (id) => {
        assert.equal(id, WEBSITE_ID);
        return { enabled: true, type: 'memcached' };
      },
    },
  });

  const server = app.listen(0);
  const address = server.address();
  const url = `http://127.0.0.1:${address.port}/api/websites/${WEBSITE_ID}/cache/memcached/enable`;

  try {
    const res = await fetch(url, { method: 'POST' });
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(body.enabled, true);
    assert.equal(body.type, 'memcached');
  } finally {
    server.close();
  }
});

test('DELETE /api/websites/:websiteId/cache disables cache', async () => {
  const app = createTestApp({
    websiteCacheService: {
      disableCache: async (id) => {
        assert.equal(id, WEBSITE_ID);
        return { disabled: true };
      },
    },
  });

  const server = app.listen(0);
  const address = server.address();
  const url = `http://127.0.0.1:${address.port}/api/websites/${WEBSITE_ID}/cache`;

  try {
    const res = await fetch(url, { method: 'DELETE' });
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(body.disabled, true);
  } finally {
    server.close();
  }
});
