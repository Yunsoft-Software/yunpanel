import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import test from 'node:test';
const source = (name) => readFile(new URL(`../src/workspace/${name}`, import.meta.url), 'utf8');
const [drawer, css] = await Promise.all([source('AiDrawer.jsx'), source('ai-history.css')]);

test('history and details are separate, session scoped and retain action proposal rendering', () => {
  assert.match(drawer, /createAiHistory\(/);
  assert.match(drawer, /createAiConversationReader\(/);
  assert.match(drawer, /version === sessionVersion\(\) && !sessionTransitionPending\(\)/);
  assert.match(drawer, /list.dispose\(\); reader.dispose\(\)/);
  assert.match(drawer, /resolveAiWebsiteContext\(domainId, panelRequest/);
  assert.match(drawer, /toolExecutions.map/);
  assert.match(drawer, /<ActionProposalCard/);
  assert.doesNotMatch(drawer, /listAiConversations\(|\.scrollIntoView\(/);
});

test('history uses keyboard controls, explicit retry and separate in-memory composer drafts', () => {
  assert.match(drawer, /className="ws-ai-history-list" tabIndex=\{0\}/);
  assert.match(drawer, /aria-current=/);
  assert.match(drawer, /aria-label="Geçmişi yenile"/);
  assert.match(drawer, /!loading && !history.error && history.hasMore/);
  assert.match(drawer, /Eski sayfayı yeniden dene/);
  assert.match(drawer, /drafts.current.set\(activeConvId/);
  assert.doesNotMatch(drawer, /localStorage|sessionStorage/);
});

test('layout constrains independent scrollers without a new visual theme', () => {
  assert.match(css, /\.ws-ai-history-list, \.ws-ai-messages/);
  assert.match(css, /min-height: 0/);
  assert.match(css, /overscroll-behavior: contain/);
  assert.match(css, /\.ws-ai-composer input \{ flex: 1; min-width: 0/);
  assert.match(css, /@media \(max-width: 700px\)/);
  assert.doesNotMatch(css, /#[a-fA-F0-9]{3,8}|font-family|background:/);
});

test('client executes old payload contracts and new encoded page requests with cancellation', () => {
  const url = new URL('../src/workspace/ai-client.js', import.meta.url).href;
  const script = `
    import assert from 'node:assert/strict';
    import { mock } from 'node:test';
    const url = ${JSON.stringify(url)};
    const calls = [];
    mock.module(new URL('../api.js', url).href, { namedExports: { panelRequest: (...args) => { calls.push(args); return {}; } } });
    const client = await import(url);
    client.listAiConversations();
    assert.deepEqual(calls.pop(), ['/ai/conversations']);
    client.getAiConversation('old-id');
    assert.deepEqual(calls.pop(), ['/ai/conversations/old-id']);
    const signal = new AbortController().signal;
    client.listAiConversationPage('site-a', { limit: 20, cursor: 'signed+cursor/value', signal });
    const [path, options] = calls.pop();
    const query = new URL(path, 'https://fixture.test').searchParams;
    assert.equal(query.get('websiteId'), 'site-a'); assert.equal(query.get('limit'), '20');
    assert.equal(query.get('cursor'), 'signed+cursor/value'); assert.equal(options.signal, signal);
    client.createAiConversation({ title: 'new', websiteId: null }, { signal });
    assert.deepEqual(calls.pop(), ['/ai/conversations', { method: 'POST', body: { title: 'new', websiteId: null }, signal }]);
    client.sendAiMessage({ conversationId: 'a/b', text: 'hello' }, { signal });
    assert.deepEqual(calls.pop(), ['/ai/conversations/a%2Fb/messages', { method: 'POST', body: { text: 'hello' }, signal }]);
    client.deleteAiConversation('a/b', { signal });
    assert.deepEqual(calls.pop(), ['/ai/conversations/a%2Fb', { method: 'DELETE', signal }]);
  `;
  assert.doesNotThrow(() => execFileSync(process.execPath, ['--experimental-test-module-mocks', '--input-type=module', '-e', script], {
    encoding: 'utf8', timeout: 10000, stdio: ['ignore', 'pipe', 'pipe'],
  }));
});
