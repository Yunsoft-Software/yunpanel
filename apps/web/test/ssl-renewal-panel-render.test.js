import { register } from 'node:module';
import assert from 'node:assert/strict';
import test from 'node:test';
import { createElement } from 'react';
import { renderToString } from 'react-dom/server';

register('./jsx-loader.js', import.meta.url);
const { WorkspaceContext } = await import('../src/workspace/WorkspaceContext.jsx');
const { default: SslRenewalPanel } = await import('../src/workspace/SslRenewalPanel.jsx');

for (const status of ['loading', 'ready', 'error']) {
  test(`an existing ACME certificate renders while jobs are ${status} without starting an operation`, () => {
    let actions = 0;
    const action = () => { actions++; };
    const html = renderToString(createElement(WorkspaceContext.Provider, {
      value: { canManage: true, observe: action, updateJob: action, refreshAll: action,
        jobs: { status, items: [], refresh: action } },
    }, createElement(SslRenewalPanel, {
      domain: { id: 'domain-1', certificateId: 'certificate-1', serverId: 'server-1', primaryDomain: 'example.com' },
      certificate: { state: 'active', source: 'acme', renewalMode: 'automatic', staging: false },
    })));
    assert.match(html, /SSL yenileme ve sonuç/);
    assert.match(html, /Yenilemeyi test et/);
    assert.match(html, /Sertifikayı yenile/);
    assert.equal(actions, 0);
  });
}
