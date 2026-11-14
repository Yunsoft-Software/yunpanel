import test from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { createConnection } from 'node:net';
import express from 'express';
import { mountWebsiteCacheRoutes } from '../src/website-cache-http.js';

const WEBSITE_ID = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';

function createTestApp({
  websiteCacheService = {},
  userRole = 'owner',
} = {}) {
  const app = express();
  app.use(express.json());
  app.use((req, res, next) => {
    if (userRole === 'owner') {
      req.auth = {
        user: { role: 'owner' },
        access: { mode: 'management', permissions: ['*'] },
        security: { managementAllowed: true },
      };
    } else if (userRole === 'read_only') {
      req.auth = {
        user: { role: 'read_only' },
        access: { mode: 'read_only', permissions: ['websites.read'] },
        security: { managementAllowed: false },
      };
    }
    next();
  });

  mountWebsiteCacheRoutes(app, {
    websiteCacheService,
  });

  return app;
}


async function withTestServer(app, action) {
  const server = app.listen(0, '127.0.0.1');
  await once(server, 'listening');
  try {
    const origin = `http://127.0.0.1:${server.address().port}`;
    return await action(origin, server);
  } finally {
    await new Promise((resolve, reject) => {
      server.close((error) => error ? reject(error) : resolve());
    });
  }
}

async function assertSocketRefused(port) {
  const socket = createConnection({ host: '127.0.0.1', port });
  const closed = new Promise((resolve) => socket.once('close', resolve));
  try {
    await new Promise((resolve, reject) => {
      socket.once('error', (error) => {
        if (error.code === 'ECONNREFUSED') resolve();
        else reject(error);
      });
      socket.once('connect', () => reject(new Error('Test server still accepts connections')));
    });
  } finally {
    socket.destroy();
    await closed;
  }
}

test('HTTP test server closes before a successful action returns', async () => {
  let closeObserved = false;
  let closed;
  let port;
  try {
    await withTestServer(express(), async (origin, server) => {
      port = server.address().port;
      closed = once(server, 'close');
      server.once('close', () => { closeObserved = true; });
      const response = await fetch(origin);
      await response.arrayBuffer();
      assert.equal(response.status, 404);
    });
    assert.equal(closeObserved, true);
    await assertSocketRefused(port);
  } finally {
    await closed;
  }
});

test('HTTP test server closes before propagating a failing action', async () => {
  let closeObserved = false;
  let closed;
  let port;
  const failure = new assert.AssertionError({ message: 'Action assertion failed after the real response' });
  try {
    await assert.rejects(withTestServer(express(), async (origin, server) => {
      port = server.address().port;
      closed = once(server, 'close');
      server.once('close', () => { closeObserved = true; });
      const response = await fetch(origin);
      await response.arrayBuffer();
      assert.equal(response.status, 404);
      throw failure;
    }), (error) => error === failure);
    assert.equal(closeObserved, true);
    await assertSocketRefused(port);
  } finally {
    await closed;
  }
});

test('GET /api/websites/:websiteId/cache returns policy', async () => {
  const app = createTestApp({
    websiteCacheService: {
      getCachePolicy: async (id) => {
        assert.equal(id, WEBSITE_ID);
        return { enabled: true, type: 'redis', redis: { username: 'yunapp-test' } };
      },
    },
  });

  await withTestServer(app, async (origin) => {
    const url = `${origin}/api/websites/${WEBSITE_ID}/cache`;
    const res = await fetch(url);
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(body.enabled, true);
    assert.equal(body.type, 'redis');
  });
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

  await withTestServer(app, async (origin) => {
    const url = `${origin}/api/websites/${WEBSITE_ID}/cache/redis/enable`;
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ keyPrefix: 'site:' }),
    });
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(body.enabled, true);
    assert.equal(body.redis.password, 'plain_password');
  });
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

  await withTestServer(app, async (origin) => {
    const url = `${origin}/api/websites/${WEBSITE_ID}/cache/redis/rotate-password`;
    const res = await fetch(url, { method: 'POST' });
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(body.rotated, true);
    assert.equal(body.redis.password, 'new_password');
  });
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

  await withTestServer(app, async (origin) => {
    const url = `${origin}/api/websites/${WEBSITE_ID}/cache/memcached/enable`;
    const res = await fetch(url, { method: 'POST' });
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(body.enabled, true);
    assert.equal(body.type, 'memcached');
  });
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

  await withTestServer(app, async (origin) => {
    const url = `${origin}/api/websites/${WEBSITE_ID}/cache`;
    const res = await fetch(url, { method: 'DELETE' });
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(body.disabled, true);
  });
});

test('cache routes require an authenticated Owner management context', async () => {
  const app = createTestApp({
    websiteCacheService: {},
    userRole: 'read_only',
  });
  await withTestServer(app, async (origin) => {
    const res = await fetch(`${origin}/api/websites/${WEBSITE_ID}/cache`);
    await res.arrayBuffer();
    assert.equal(res.status, 403);
  });
});
