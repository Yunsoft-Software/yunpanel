import { register } from 'node:module';
import test from 'node:test';
import assert from 'node:assert/strict';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';

register('./jsx-loader.js', import.meta.url);
const { default: LogsPanel, mergeLiveEntries, siteLogPath } = await import('../src/workspace/LogsPanel.jsx');

const domain = { id: 'domain-a', websiteId: 'website-a', primaryDomain: 'example.com' };

test('site logs never use the Owner-only server log endpoint', () => {
  for (const source of ['nginx-access', 'nginx-error', 'node']) {
    for (const live of [false, true]) {
      const path = siteLogPath({ domain, source, live });
      assert.ok(path.startsWith('/websites/website-a/application/logs'), path);
      assert.doesNotMatch(path, /\/servers\//);
    }
  }
  assert.equal(siteLogPath({ domain, source: 'nginx-error' }), '/websites/website-a/application/logs?kind=error&domainId=domain-a');
  assert.equal(siteLogPath({ domain, source: 'nginx-access', live: true }), '/websites/website-a/application/logs/follow?kind=access&domainId=domain-a');
});

test('live entries are shown newest first and the table is capped', () => {
  const current = [{ cursor: 'c2' }, { cursor: 'c1' }];
  assert.deepEqual(mergeLiveEntries(current, [{ cursor: 'c3' }, { cursor: 'c4' }]).map(entry => entry.cursor), ['c4', 'c3', 'c2', 'c1']);
  assert.equal(mergeLiveEntries([], Array.from({ length: 600 }, (_, i) => ({ cursor: `c${i}` })), 500).length, 500);
});

test('the live control is offered for web server logs, not for Node application logs', () => {
  const nginx = renderToStaticMarkup(React.createElement(LogsPanel, { application: null, domain }));
  assert.match(nginx, />Canlı</);
  const node = renderToStaticMarkup(React.createElement(LogsPanel, { application: { id: 'app-a', type: 'node' }, domain }));
  assert.doesNotMatch(node, />Canlı</);
});
