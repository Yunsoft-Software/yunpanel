import test from 'node:test';
import assert from 'node:assert/strict';
import { createWebsiteTaskResolver } from '../src/workspace/website-task-model.js';

test('unknown runtime names cannot resolve Object prototype members as UI labels', () => {
  for (const runtimeType of ['__proto__', 'constructor', 'toString', 'unrecognized']) {
    const resolve = createWebsiteTaskResolver({
      domains: { status: 'ready', items: [{ id: 'domain', websiteId: 'site', serverId: 'local' }] },
      websites: { status: 'ready', items: [{ id: 'site', serverId: 'local', runtimeType }] },
      applications: { status: 'ready', items: [] }, canManage: true,
    });
    assert.equal(resolve('domain').runtimeLabel, 'Tür bilgisi alınamadı');
  }
});
