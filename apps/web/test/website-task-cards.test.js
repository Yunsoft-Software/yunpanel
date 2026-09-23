import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { domainTreeRows } from '../src/domain-tree.js';
import { siteListPage } from '../src/workspace/site-list-model.js';
import { createWebsiteTaskResolver } from '../src/workspace/website-task-model.js';
import { certificateState } from '../src/workspace/site-model.js';
const source = (path) => readFile(new URL(`../src/workspace/${path}`, import.meta.url), 'utf8');
const d = (id, parentDomainId = null, extra = {}) => ({ id, serverId: 'local', websiteId: `ws-${id}`, primaryDomain: `${id}.example.test`, parentDomainId, aliases: [], state: 'active', targetType: 'proxy', ...extra });
const ready = (items) => ({ status: 'ready', items });
const domains = [d('a'), d('b', 'a'), d('c', 'b'), d('x')];
const bindings = domains.map((item) => ({ id: item.websiteId, serverId: 'local', runtimeType: 'static', applicationId: null }));
const get = createWebsiteTaskResolver({ domains: ready(domains), websites: ready(bindings), applications: ready([]), canManage: true });

test('paged hierarchy assigns every visible child its own site tool targets', () => {
  const result = siteListPage(domainTreeRows(domains), { perPage: 1 });
  assert.deepEqual(result.rows.map(({ domain }) => domain.id), ['a', 'b', 'c']);
  for (const row of result.rows) assert.equal(get(row.domain.id).tools[0].href, `/websites/${row.domain.id}/files`);
  assert.deepEqual(siteListPage(domainTreeRows(domains), { perPage: 1, page: 2 }).rows.map(({ domain }) => domain.id), ['x']);
});
test('child collapse never removes the parent card tools; search expands ancestors', () => {
  const collapsed = new Set(['a']);
  assert.deepEqual(domainTreeRows(domains, { collapsed }).map(({ domain }) => domain.id), ['a', 'x']);
  assert.equal(get('a').tools.length, 6);
  assert.deepEqual(domainTreeRows(domains, { collapsed, query: 'c.example' }).map(({ domain }) => domain.id), ['a', 'b', 'c']);
});
test('alias matches retain their domain and parent context', () => {
  const input = [d('a'), d('b', 'a', { aliases: ['other-name.test'] }), d('x')];
  assert.deepEqual(domainTreeRows(input, { query: 'other-name' }).map(({ domain }) => domain.id), ['a', 'b']);
});
test('status and type filters preserve ancestors without claiming parent matches', () => {
  const tree = domainTreeRows([d('a', null, { state: 'draft' }), d('b', 'a', { targetType: 'static' }), d('x')]);
  const result = siteListPage(tree, { status: 'active', type: 'static' });
  assert.deepEqual(result.rows.map(({ domain }) => domain.id), ['a', 'b']);
  assert.equal(result.rows[0].contextOnly, true); assert.equal(result.rows[1].contextOnly, false);
});
test('sort order and out-of-range page clamp keep children with their root', () => {
  const tree = domainTreeRows(domains);
  const descending = siteListPage(tree, { sort: 'desc', perPage: 1 });
  assert.equal(descending.rows[0].domain.id, 'x');
  assert.deepEqual(siteListPage(tree, { sort: 'desc', perPage: 1, page: 999 }).rows.map(({ domain }) => domain.id), ['a', 'b', 'c']);
});
test('cycles and missing parents remain finite visible diagnostic records', () => {
  const tree = domainTreeRows([d('a', 'b'), d('b', 'a'), d('c', 'gone')]);
  assert.equal(tree.length, 3); assert.equal(new Set(tree.map(({ domain }) => domain.id)).size, 3);
  assert.ok(tree.every((row) => row.warning));
});
test('not-yet-loaded certificates remain unknown instead of SSL off or fabricated days', () => {
  assert.equal(certificateState(d('a'), null).state, 'unknown');
  assert.equal(certificateState(d('a'), []).state, 'off');
});
test('source: list keeps existing tree, pagination, preferences and query state', async () => {
  const page = await source('WebsitesPage.jsx');
  for (const name of ['domainTreeRows', 'siteListPage', 'useWebsitePreferences', 'siteListFilterParams', 'clearSiteListFilters']) assert.ok(page.includes(name));
  assert.match(page, /collapsed: filtering \? new Set\(\) : collapsed/);
  assert.match(page, /page: Number\(params.get\('page'\)/);
  assert.match(page, /key=\{row.domain.id\}/);
  assert.match(page, /tasks=\{resolveTasks\(row.domain.id\)\}/);
  assert.match(page, /<ul className="ws-website-task-list"/);
  assert.doesNotMatch(page, /selectedApplication|matchingApplications|<table/);
});
test('source: refresh updates all binding and certificate resources, not only domains', async () => {
  const page = await source('WebsitesPage.jsx');
  assert.match(page, /onClick=\{refreshAll\}/);
  assert.doesNotMatch(page, /onClick=\{domains.refresh\}/);
  for (const name of ['domains', 'websites', 'applications', 'certificates']) assert.match(page, new RegExp(`<CollectionNotice resource=\\{${name}\\}`));
});
test('source: create entry is Owner-only in heading and empty state; no mutation is introduced', async () => {
  const page = await source('WebsitesPage.jsx');
  assert.match(page, /isOwner && canManage && <LinkButton to="\/websites\/new"/);
  assert.match(page, /action=\{isOwner && canManage \? <LinkButton to="\/websites\/new"/);
  assert.doesNotMatch(page, /panelRequest|fetch\(|localStorage|sessionStorage/);
  const card = await source('WebsiteTaskCard.jsx');
  assert.match(card, /tasks.createSubdomainHref && <LinkButton to=\{tasks.createSubdomainHref\}/);
  assert.doesNotMatch(card, /panelRequest|fetch\(|localStorage|sessionStorage/);
});
test('source: every daily tool is outside disclosures and has an accessible destination', async () => {
  const card = await source('WebsiteTaskCard.jsx');
  const start = card.indexOf('className="ws-website-task-grid"');
  assert.ok(start > 0 && start < card.indexOf('<details'));
  assert.match(card, /tasks.tools.map\(\(tool\) => <TaskLink/);
  assert.match(card, /to=\{tool.href\}/);
  assert.match(card, /<Button disabled icon=\{tool.icon\}/);
  assert.match(card, /aria-describedby=\{`\$\{id\}-\$\{tool.key\}`\}/);
  assert.match(card, /<small id=\{`\$\{id\}-\$\{tool.key\}`\}>\{tool.reason\}/);
  assert.doesNotMatch(card, /Diğer|dangerouslySetInnerHTML|<iframe|<FilesPanel/);
});
test('source: scoped article title, context, parent disclosure and safe external link remain explicit', async () => {
  const card = await source('WebsiteTaskCard.jsx');
  assert.match(card, /useId\(\)/);
  assert.match(card, /aria-labelledby=\{`\$\{id\}-title`\}/);
  assert.match(card, /contextOnly && <small>/);
  assert.match(card, /aria-expanded=\{expanded\}/);
  assert.match(card, /onToggle\(domain.id\)/);
  assert.match(card, /externalSiteUrl\(domain\)/);
  assert.match(card, /rel="noopener noreferrer"/);
});
test('source: stale state is not rendered as a fresh green site or SSL result', async () => {
  const card = await source('WebsiteTaskCard.jsx');
  assert.match(card, /tasks.domainReady && certificates\?\.status === 'ready' \? certificates.items : null/);
  assert.match(card, /state=\{tasks.domainReady \? domain.state : 'unknown'\}/);
});
test('source: responsive cards reuse theme tokens and cannot hide primary tasks in overflow', async () => {
  const css = await source('ui/website-task-cards.css');
  assert.match(css, /var\(--ws-radius\)/);
  assert.match(css, /var\(--ws-surface\)/);
  assert.match(css, /minmax\(min\(100%, 10rem\), 1fr\)/);
  assert.match(css, /white-space: normal/);
  assert.match(css, /flex-wrap: wrap/);
  assert.match(css, /min-height: 44px/);
  assert.match(css, /ws-site-table-compact/);
  assert.doesNotMatch(css, /display:\s*none|overflow:\s*hidden|#[a-f0-9]{3,8}\b|font-family:|:root/i);
});
