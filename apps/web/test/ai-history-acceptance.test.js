import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import {
  createAiHistory,
  createAiConversationReader,
  resolveAiWebsiteContext,
  EMPTY_AI_HISTORY,
} from '../src/workspace/ai-history.js';

const source = (name) => readFile(new URL(`../src/workspace/${name}`, import.meta.url), 'utf8');
const [drawerSource, cssSource] = await Promise.all([source('AiDrawer.jsx'), source('ai-history.css')]);

const siteA = '11111111-1111-4111-8111-111111111111';
const siteB = '22222222-2222-4222-8222-222222222222';

const makeItem = (n, patch = {}) => ({
  id: `33333333-3333-4333-8333-${String(n).padStart(12, '0')}`,
  title: `Sohbet Başlığı ${n}`,
  websiteId: siteA,
  createdAt: new Date(Date.parse('2026-09-24T00:00:00.000Z') - n * 1000).toISOString(),
  updatedAt: new Date(Date.parse('2026-09-24T00:00:00.000Z') - n * 1000).toISOString(),
  messageCount: 1,
  ...patch,
});

const makePage = (items, nextCursor = null, patch = {}) => ({
  items,
  hasMore: nextCursor !== null,
  nextCursor,
  legacyUnassigned: false,
  scope: { actorId: 'owner-a', websiteId: siteA },
  ...patch,
});

/* ==========================================================================
   Criterion 3: AI modal/pencere veya arka sayfa dikey olarak kontrolsüz
   uzamaz; sol geçmiş listesi sınırlı yükseklikte kendi içinde bağımsız kayar.
   ========================================================================== */

test('Criterion 3: layout constrains modal and background page, enforcing independent scrollers', () => {
  // Modal layout strictly constrains height with dynamic viewport units
  assert.match(cssSource, /height:\s*min\(68vh,\s*680px\);/);
  assert.match(cssSource, /height:\s*min\(68dvh,\s*680px\);/);
  assert.match(cssSource, /overflow:\s*hidden;/);
  assert.match(cssSource, /min-height:\s*0;/);

  // Both sidebar and chat panels are flex columns with hidden overflow
  assert.match(cssSource, /\.ws-ai-sidebar,\s*\.ws-ai-chat\s*\{[^}]*overflow:\s*hidden;/);
  assert.match(cssSource, /\.ws-ai-sidebar,\s*\.ws-ai-chat\s*\{[^}]*min-height:\s*0;/);

  // Independent scrollers on history list and message container
  assert.match(cssSource, /\.ws-ai-history-list,\s*\.ws-ai-messages\s*\{[^}]*overflow-y:\s*auto;/);
  assert.match(cssSource, /\.ws-ai-history-list,\s*\.ws-ai-messages\s*\{[^}]*overscroll-behavior:\s*contain;/);
  assert.match(cssSource, /\.ws-ai-history-list,\s*\.ws-ai-messages\s*\{[^}]*scrollbar-gutter:\s*stable;/);
  assert.match(cssSource, /\.ws-ai-history-list,\s*\.ws-ai-messages\s*\{[^}]*flex:\s*1 1 0;/);

  // Modal or outer document is never scrolled with scrollIntoView
  assert.doesNotMatch(drawerSource, /\.scrollIntoView\(/);
  assert.match(drawerSource, /element\.scrollTop = element\.scrollHeight;/);
});

/* ==========================================================================
   Criterion 4: Aktör kapsamlı cursor sayfalama (actor-scoped cursor pagination)
   ile eski konuşmalar scroll sınırında sorunsuz yüklenir.
   ========================================================================== */

test('Criterion 4: actor-scoped cursor pagination loads older pages near scroll boundary without re-fetching first page', async () => {
  const calls = [];
  const itemsPage1 = Array.from({ length: 20 }, (_, i) => makeItem(i + 1));
  const itemsPage2 = Array.from({ length: 15 }, (_, i) => makeItem(i + 21));

  const history = createAiHistory({
    actorId: 'owner-a',
    websiteId: siteA,
    read: async (options) => {
      calls.push(options);
      if (!options.cursor) {
        return makePage(itemsPage1, 'cursor-token-page-2');
      }
      if (options.cursor === 'cursor-token-page-2') {
        return makePage(itemsPage2, null);
      }
      throw new Error('Unexpected cursor');
    },
  });

  // Initial load
  await history.load();
  assert.equal(calls.length, 1);
  assert.equal(calls[0].cursor, null);
  assert.equal(calls[0].limit, 20);
  assert.equal(history.getState().items.length, 20);
  assert.equal(history.getState().hasMore, true);
  assert.equal(history.getState().nextCursor, 'cursor-token-page-2');

  // Verify scroll threshold in component: node.scrollHeight - node.clientHeight - node.scrollTop < 64
  assert.match(drawerSource, /node\.scrollHeight\s*-\s*node\.clientHeight\s*-\s*node\.scrollTop\s*<\s*64/);

  // Scroll boundary triggers second page load (more)
  await history.more();
  assert.equal(calls.length, 2);
  assert.equal(calls[1].cursor, 'cursor-token-page-2');
  assert.equal(calls[1].limit, 20);

  // Total 35 items accumulated in continuous order without resetting existing items
  const state = history.getState();
  assert.equal(state.items.length, 35);
  assert.equal(state.hasMore, false);
  assert.equal(state.nextCursor, null);
  assert.equal(state.items[0].id, itemsPage1[0].id);
  assert.equal(state.items[19].id, itemsPage1[19].id);
  assert.equal(state.items[20].id, itemsPage2[0].id);
  assert.equal(state.items[34].id, itemsPage2[14].id);
});

/* ==========================================================================
   Criterion 5: Aktif sohbet seçimi, kaydırma konumu ve composer taslağı korunur;
   sağ mesaj alanı sol geçmişten bağımsız kayar.
   ========================================================================== */

test('Criterion 5: active conversation selection and in-memory composer drafts are preserved across pagination', async () => {
  // In-memory drafts map pattern per conversation
  assert.match(drawerSource, /drafts\s*=\s*useRef\(new Map\(\)\)/);
  assert.match(drawerSource, /drafts\.current\.set\(activeConvId \?\? 'new',\s*event\.target\.value\)/);
  assert.match(drawerSource, /setInputVal\(drafts\.current\.get\(id \?\? 'new'\) \?\? ''\)/);

  // Composer fixed at bottom
  assert.match(cssSource, /\.ws-ai-composer\s*\{[^}]*flex:\s*0 0 auto;/);
  assert.match(cssSource, /\.ws-ai-composer\s*\{[^}]*padding-top:\s*12px;/);

  // Verification that list.more() preserves state items reference identity for earlier items
  const item1 = makeItem(1);
  const item2 = makeItem(2);
  const item3 = makeItem(3);

  const history = createAiHistory({
    actorId: 'owner-a',
    websiteId: siteA,
    read: async ({ cursor }) => (cursor ? makePage([item3], null) : makePage([item1, item2], 'cursor-next')),
  });

  await history.load();
  const initialSelected = history.getState().items[0];

  await history.more();
  const updatedItems = history.getState().items;
  assert.equal(updatedItems.length, 3);
  // Initial item reference remains intact
  assert.equal(updatedItems[0], initialSelected);
});

/* ==========================================================================
   Criterion 6: Paralel veya tekrarlanan fetch istekleri önlenir/tekilleştirilir;
   kopya konuşma kaydı veya sıra bozulması engellenir.
   ========================================================================== */

test('Criterion 6: concurrent and repeated fetch triggers are deduplicated and items maintain strict descending order', async () => {
  let pendingResolve;
  const pendingPromise = new Promise((resolve) => { pendingResolve = resolve; });

  let callCount = 0;
  const history = createAiHistory({
    actorId: 'owner-a',
    websiteId: siteA,
    read: async ({ cursor }) => {
      callCount++;
      if (cursor) {
        await pendingPromise;
        return makePage([makeItem(3)], null);
      }
      return makePage([makeItem(1), makeItem(2)], 'cursor-2');
    },
  });

  await history.load();
  assert.equal(callCount, 1);

  // Fire multiple concurrent more() calls
  const p1 = history.more();
  const p2 = history.more();
  const p3 = history.more();

  assert.equal(callCount, 2); // Only one additional in-flight request was initiated
  pendingResolve();
  await Promise.all([p1, p2, p3]);

  assert.equal(callCount, 2);
  assert.equal(history.getState().items.length, 3);

  // Strict descending order by createdAt desc, id desc
  const items = history.getState().items;
  for (let i = 0; i < items.length - 1; i++) {
    const a = items[i];
    const b = items[i + 1];
    const cmp = `${a.createdAt}:${a.id}` > `${b.createdAt}:${b.id}`;
    assert.ok(cmp, `Items not strictly descending at index ${i}`);
  }
});

/* ==========================================================================
   Criterion 7: Boş/son sayfa sınırları ile ağ hatası/yeniden deneme
   durumları kullanıcıya kontrollü biçimde yansıtılır.
   ========================================================================== */

test('Criterion 7: empty state, end-of-history, network failure and explicit retry are handled gracefully', async () => {
  // Empty history representation
  assert.match(drawerSource, /!loading && !history\.items\.length && !history\.error && <p>Kayıtlı sohbet bulunamadı\.<\/p>/);

  // End of history representation
  assert.match(drawerSource, /!history\.hasMore && history\.items\.length > 0 && <p className="ws-muted">Geçmişin sonuna ulaşıldı\.<\/p>/);

  // Explicit retry button when error occurs on older page
  assert.match(drawerSource, /history\.error \? 'Eski sayfayı yeniden dene' : 'Daha eski sohbetler'/);

  // Behavior: network failure preserves existing items and cursor
  let shouldFail = true;
  const history = createAiHistory({
    actorId: 'owner-a',
    websiteId: siteA,
    read: async ({ cursor }) => {
      if (!cursor) return makePage([makeItem(1)], 'valid-cursor');
      if (shouldFail) throw new Error('Network error');
      return makePage([makeItem(2)], null);
    },
  });

  await history.load();
  assert.equal(history.getState().items.length, 1);

  await history.more();
  assert.equal(history.getState().status, 'error');
  assert.equal(history.getState().items.length, 1); // Existing items preserved
  assert.equal(history.getState().nextCursor, 'valid-cursor'); // Cursor preserved for retry

  // Retry succeeded
  shouldFail = false;
  await history.more();
  assert.equal(history.getState().status, 'ready');
  assert.equal(history.getState().items.length, 2);
  assert.equal(history.getState().hasMore, false);
});

/* ==========================================================================
   Criterion 8: Uzun konuşma geçmişi, dar/mobil görünüm ve klavye/ekran
   okuyucu odak yönetimi doğrulanır.
   ========================================================================== */

test('Criterion 8: long history, responsive mobile layout, and accessibility keyboard/screen-reader controls', () => {
  // Text truncation for long conversation titles
  assert.match(cssSource, /\.ws-ai-conversation-select > span\s*\{[^}]*text-overflow:\s*ellipsis;/);
  assert.match(cssSource, /\.ws-ai-conversation-select > span\s*\{[^}]*white-space:\s*nowrap;/);

  // Delete button accessibility aria-label and title
  assert.match(drawerSource, /aria-label=\{`\$\{conv\.title \|\| 'Sohbet'\} sohbetini sil`\}/);

  // Responsive mobile layout at max-width 700px
  assert.match(cssSource, /@media\s*\(max-width:\s*700px\)\s*\{/);
  assert.match(cssSource, /grid-template-columns:\s*minmax\(0,\s*1fr\);/);
  assert.match(cssSource, /grid-template-rows:\s*minmax\(110px,\s*32%\)\s*minmax\(0,\s*1fr\);/);

  // Keyboard navigation on list container
  assert.match(drawerSource, /className="ws-ai-history-list"\s*tabIndex=\{0\}/);
  assert.match(drawerSource, /aria-label="Kaydırılabilir sohbet listesi"/);
  assert.match(drawerSource, /aria-busy=\{loading\}/);
  assert.match(drawerSource, /aria-current=\{conv\.id === activeConvId \? 'true' : undefined\}/);

  // Screen reader role="log" and aria-live="polite" on messages
  assert.match(drawerSource, /role="log"/);
  assert.match(drawerSource, /aria-live="polite"/);
  assert.match(drawerSource, /aria-label="Sohbet mesajları"/);
});
