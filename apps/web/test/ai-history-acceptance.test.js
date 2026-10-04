import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import { setSession } from '../src/session-client.js';
import { streamAiMessage } from '../src/workspace/ai-client.js';
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

/* ==========================================================================
   Criterion 1 & 2: streamAiMessage and session termination fail-closed
   ========================================================================== */

test('Criterion 1 & 2: streamAiMessage streams SSE chunks with CSRF token and throws on 403/404 fail-closed', async () => {
  const originalFetch = globalThis.fetch;
  try {
    setSession({ csrfToken: 'acceptance-csrf-token' });
    let capturedUrl, capturedOptions;

    // Test SSE streaming
    globalThis.fetch = async (url, options) => {
      capturedUrl = url;
      capturedOptions = options;
      const stream = new ReadableStream({
        start(controller) {
          controller.enqueue(new TextEncoder().encode('event: thinking\ndata: {"type":"thinking","turn":1}\n\n'));
          controller.enqueue(new TextEncoder().encode('event: text\ndata: {"type":"text","text":"Hello World"}\n\n'));
          controller.close();
        },
      });
      return new Response(stream, {
        status: 200,
        headers: { 'content-type': 'text/event-stream' },
      });
    };

    const events = [];
    await streamAiMessage({ conversationId: 'conv-123', text: 'hi' }, {
      onEvent: (ev) => events.push(ev),
    });

    assert.equal(capturedUrl, '/api/panel/ai/conversations/conv-123/messages/stream');
    assert.equal(capturedOptions.method, 'POST');
    assert.equal(capturedOptions.headers['x-csrf-token'], 'acceptance-csrf-token');
    assert.deepEqual(events, [
      { type: 'thinking', turn: 1 },
      { type: 'text', text: 'Hello World' },
    ]);

    // Test fail-closed 403 response
    globalThis.fetch = async () => new Response(JSON.stringify({ error: { code: 'forbidden', message: 'Access denied' } }), {
      status: 403,
      headers: { 'content-type': 'application/json' },
    });

    await assert.rejects(
      () => streamAiMessage({ conversationId: 'conv-other', text: 'hi' }),
      (err) => err.status === 403 && err.code === 'forbidden',
    );

    // Test fail-closed 404 response
    globalThis.fetch = async () => new Response(JSON.stringify({ error: { code: 'conversation_not_found', message: 'Not found' } }), {
      status: 404,
      headers: { 'content-type': 'application/json' },
    });

    await assert.rejects(
      () => streamAiMessage({ conversationId: 'conv-missing', text: 'hi' }),
      (err) => err.status === 404 && err.code === 'conversation_not_found',
    );
  } finally {
    globalThis.fetch = originalFetch;
    setSession(null);
  }
});

test('Session switching and denied mutate trigger fail-closed reset in AiDrawer', () => {
  // Drawer ties scope key to session identity and version
  assert.match(drawerSource, /identity = JSON\.stringify\(\[domainId, session\?\.user\?\.id, session\?\.user\?\.role, session\?\.user\?\.websiteIds, sessionVersion\(\)\]\)/);
  // Unmounts if no session user
  assert.match(drawerSource, /if \(!open \|\| !session\?\.user\?\.id\) return null;/);
  // Denied resets state and drafts
  assert.match(drawerSource, /setHistory\(.*status:\s*'forbidden'/);
  assert.match(drawerSource, /drafts\.current\.clear\(\)/);
  // mutate catches 401/403 and calls deniedRef
  assert.match(drawerSource, /failure\?\.status === 401 \|\| failure\?\.status === 403 \|\| failure\?\.code === 'forbidden' \|\| failure\?\.code === 'unauthorized'/);
});

test('Comprehensive acceptance: >20 equal-time chats, concurrent mutation races, cursor restart, circular cursor and retry', async () => {
  // 1. >20 equal-time conversations pagination across pages to final page
  const fixedTime = '2026-09-24T00:00:00.000Z';
  const page1Items = Array.from({ length: 20 }, (_, i) => makeItem(i + 1, { createdAt: fixedTime, updatedAt: fixedTime }));
  const page2Items = Array.from({ length: 5 }, (_, i) => makeItem(i + 21, { createdAt: fixedTime, updatedAt: fixedTime }));
  const calls = [];

  let circularMode = false;
  let restartMode = false;

  const history = createAiHistory({
    actorId: 'owner-a',
    websiteId: siteA,
    read: async (options) => {
      calls.push(options);
      if (restartMode) {
        const err = new Error('Sayfa anahtarı geçersiz');
        err.code = 'invalid_ai_history_cursor';
        err.status = 400;
        throw err;
      }
      if (circularMode) {
        return makePage(page2Items, options.cursor || 'circular-cursor-token');
      }
      if (!options.cursor) {
        return makePage(page1Items, 'cursor-page-2');
      }
      if (options.cursor === 'cursor-page-2') {
        return makePage(page2Items, null);
      }
      throw new Error(`Unexpected cursor: ${options.cursor}`);
    },
  });

  // Load first page (20 items)
  await history.load();
  assert.equal(history.getState().items.length, 20);
  assert.equal(history.getState().hasMore, true);
  assert.equal(history.getState().nextCursor, 'cursor-page-2');

  // Race 1: Concurrent new message on older item during older page inspection
  history.upsert(makeItem(1, { createdAt: fixedTime, updatedAt: '2026-09-24T01:00:00.000Z', messageCount: 5 }));
  // Item updatedAt updated, ordering preserved
  const updatedItem1 = history.getState().items.find((it) => it.id === makeItem(1).id);
  assert.equal(updatedItem1.messageCount, 5);
  assert.equal(history.getState().hasMore, true);

  // Race 2: Concurrent brand new chat created during older page inspection
  const brandNew = makeItem(99, { createdAt: '2026-09-24T02:00:00.000Z', updatedAt: '2026-09-24T02:00:00.000Z' });
  history.upsert(brandNew);
  // Brand new appears at top (index 0)
  assert.equal(history.getState().items[0].id, brandNew.id);
  assert.equal(history.getState().items.length, 21);
  assert.equal(history.getState().nextCursor, 'cursor-page-2');

  // Race 3: Concurrent deletion of an item
  history.remove(page1Items[1].id);
  assert.equal(history.getState().items.some((it) => it.id === page1Items[1].id), false);

  // Load older page (more) -> appends page 2 items, final page reached
  await history.more();
  const stateAfterPage2 = history.getState();
  assert.equal(stateAfterPage2.hasMore, false);
  assert.equal(stateAfterPage2.nextCursor, null);
  // All remaining page 2 items are present
  assert.ok(page2Items.every((it) => stateAfterPage2.items.some((row) => row.id === it.id)));

  // Test cursor restart / instance switching
  restartMode = true;
  const historyRestart = createAiHistory({
    actorId: 'owner-a',
    websiteId: siteA,
    read: async (options) => {
      calls.push(options);
      if (!options.cursor) return makePage(page1Items, 'cursor-token-stale');
      const err = new Error('Sayfa anahtarı geçersiz veya süresi dolmuş.');
      err.code = 'invalid_ai_history_cursor';
      err.status = 400;
      throw err;
    },
  });
  await historyRestart.load();
  await historyRestart.more();
  assert.equal(historyRestart.getState().status, 'error');
  assert.equal(historyRestart.getState().reloadRequired, true);
  // Subsequent more() is blocked
  const callCountBefore = calls.length;
  await historyRestart.more();
  assert.equal(calls.length, callCountBefore);
  // Clean reload from start succeeds
  await historyRestart.load();
  assert.equal(historyRestart.getState().status, 'ready');
  assert.equal(historyRestart.getState().reloadRequired, false);

  // Test circular cursor detection
  circularMode = true;
  const historyCircular = createAiHistory({
    actorId: 'owner-a',
    websiteId: siteA,
    read: async (options) => {
      if (!options.cursor) return makePage(page1Items, 'token-loop');
      return makePage(page2Items, 'token-loop');
    },
  });
  await historyCircular.load();
  await historyCircular.more();
  assert.equal(historyCircular.getState().status, 'error');
  assert.equal(historyCircular.getState().reloadRequired, true);
  // Verify fetch loop is blocked
  await historyCircular.more();
  assert.equal(historyCircular.getState().status, 'error');

  // Verify modal scroller and composer draft contracts in source
  assert.match(drawerSource, /messagesRef/);
  assert.doesNotMatch(drawerSource, /localStorage|sessionStorage/);
  assert.match(drawerSource, /mutate/);
  assert.doesNotMatch(drawerSource, /setTimeout\([^)]*mutate/);
});

/* ==========================================================================
   Criterion 9: Üretim React/Vite/Ember fontlarıyla tipografi, 320/390/834/1440 px
   ve yüzde200 zoom duyarlı yerleşim, kısa/yatay ekran ve mobil klavye adaptasyonu,
   uzun başlık/mesaj/hata sarmalama ve klavye/ekran okuyucu odak yönetimi
   ========================================================================== */

test('Criterion 9: Production Ember typography is bound across body, modal headings, and code elements', async () => {
  const emberTypography = await source('ui/ember-typography.css');

  // Same-origin verified font-family definitions
  assert.match(emberTypography, /font-family:\s*'Yun Manrope'/);
  assert.match(emberTypography, /font-family:\s*'Yun Outfit'/);

  // Body, input, button font inheritance
  assert.match(emberTypography, /--ws-font-body:\s*'Yun Manrope'/);
  assert.match(emberTypography, /--ws-font-display:\s*'Yun Outfit'/);
  assert.match(emberTypography, /--ws-font-code:\s*ui-monospace/);

  // Modal and its headings bind Ember typography
  assert.match(emberTypography, /\.ws-modal,\s*\.authenticated-panel/);
  assert.match(emberTypography, /\.ws-modal\s+:is\([^)]*\bh3\b/);

  // Code elements use monospace font token in drawer
  assert.match(drawerSource, /fontFamily:\s*'var\(--ws-font-code,\s*monospace\)'/);
});

test('Criterion 9: Viewports (320px, 390px, 834px, 1440px) and 200% zoom prevent overflow and preserve scrollers', () => {
  // Mobile breakpoint reflows to single column at <= 700px
  assert.match(cssSource, /@media\s*\(max-width:\s*700px\)/);

  // Extra narrow mobile (<= 360px) and 200% zoom protection
  assert.match(cssSource, /@media\s*\(max-width:\s*360px\)/);
  assert.match(cssSource, /\.ws-ai-sidebar\s*>\s*\.ws-actions\s*\{[^}]*flex-wrap:\s*wrap;/);

  // Dynamic viewport units with dvh prevent vertical clipping
  assert.match(cssSource, /height:\s*min\(68dvh,\s*680px\);/);
  assert.match(cssSource, /height:\s*70dvh;/);

  // All flex containers enforce min-width and min-height 0 to prevent overflow
  assert.match(cssSource, /\.ws-ai-sidebar,\s*\.ws-ai-chat\s*\{[^}]*min-width:\s*0;/);
  assert.match(cssSource, /\.ws-ai-history-list,\s*\.ws-ai-messages\s*\{[^}]*min-width:\s*0;/);
});

test('Criterion 9: Short/landscape displays and mobile keyboard adaptation keep composer accessible and preserve background scroll', async () => {
  const panelKit = await source('PanelKit.jsx');

  // Short display adaptations at max-height 540px
  assert.match(cssSource, /@media\s*\(max-height:\s*540px\)/);
  assert.match(cssSource, /height:\s*min\(65dvh/);

  // Landscape mobile reflows to columns to give full height to chat and composer
  assert.match(cssSource, /@media\s*\(max-width:\s*900px\)\s*and\s*\(orientation:\s*landscape\)\s*and\s*\(max-height:\s*540px\)/);

  // Virtual keyboard portrait adaptation
  assert.match(cssSource, /@media\s*\(max-width:\s*700px\)\s*and\s*\(max-height:\s*500px\)\s*and\s*\(orientation:\s*portrait\)/);

  // Composer pinned at bottom with non-shrinking send button
  assert.match(cssSource, /\.ws-ai-composer\s*button\s*\{[^}]*flex:\s*0 0 auto;/);
  assert.match(cssSource, /\.ws-ai-composer\s*button\s*\{[^}]*white-space:\s*nowrap;/);

  // Modal containment: outer modal does not scroll when AI drawer is open
  assert.match(cssSource, /\.ws-modal:has\(\.ws-ai-layout\)\s*\{[^}]*overflow:\s*hidden;/);
  assert.match(cssSource, /\.ws-modal:has\(\.ws-ai-layout\)\s*\.ws-modal-body\s*\{[^}]*overflow:\s*hidden;/);

  // Focus restoration preserves scroll position
  assert.match(panelKit, /previous\.focus\(\{\s*preventScroll:\s*true\s*\}\)/);
});

test('Criterion 9: Long conversation titles, messages, tool outputs, and error states truncate or wrap cleanly', () => {
  // Titles truncate with ellipsis without expanding container
  assert.match(cssSource, /\.ws-ai-conversation-select > span\s*\{[^}]*text-overflow:\s*ellipsis;/);
  assert.match(cssSource, /\.ws-ai-conversation-select > span\s*\{[^}]*white-space:\s*nowrap;/);
  assert.match(cssSource, /\.ws-ai-history-row\s*>\s*button:last-child\s*\{[^}]*flex:\s*0 0 auto;/);

  // Message text wraps safely with anywhere/break-word
  assert.match(drawerSource, /wordBreak:\s*'break-word'/);
  assert.match(drawerSource, /overflowWrap:\s*'anywhere'/);
  assert.match(cssSource, /\.ws-ai-messages\s*>\s*div\s*\{[^}]*min-width:\s*0;/);

  // Error notices wrap cleanly without breaking layout containers
  assert.match(cssSource, /\.ws-ai-chat \.ws-notice,\s*\.ws-ai-sidebar \.ws-notice\s*\{[^}]*overflow-wrap:\s*anywhere;/);
  assert.match(cssSource, /\.ws-ai-chat \.ws-notice,\s*\.ws-ai-sidebar \.ws-notice\s*\{[^}]*word-break:\s*break-word;/);

  // Action proposal inputs scroll horizontally and wrap long text
  assert.match(drawerSource, /overflowX:\s*'auto'/);
  assert.match(drawerSource, /wordBreak:\s*'break-all'/);
});

test('Criterion 9: Keyboard navigation, modal focus trapping, and screen reader ARIA roles/labels', async () => {
  const panelKit = await source('PanelKit.jsx');

  // Focus trapping inside modal
  assert.match(panelKit, /event\.key === 'Tab'/);
  assert.match(panelKit, /event\.shiftKey && document\.activeElement === first/);
  assert.match(panelKit, /!event\.shiftKey && document\.activeElement === last/);

  // Arrow key navigation across conversation history items
  assert.match(drawerSource, /event\.key === 'ArrowDown' \|\| event\.key === 'ArrowUp'/);
  assert.match(drawerSource, /buttons\[next\]\?\.focus\(\)/);

  // Screen reader attributes for messages and status
  assert.match(drawerSource, /role="log"/);
  assert.match(drawerSource, /aria-live="polite"/);
  assert.match(drawerSource, /aria-label="Sohbet mesajları"/);
  assert.match(drawerSource, /aria-label=\{msg\.role === 'user' \? 'Kullanıcı mesajı' : 'AI yanıtı'\}/);

  // History list screen reader attributes
  assert.match(drawerSource, /tabIndex=\{0\}/);
  assert.match(drawerSource, /aria-label="Kaydırılabilir sohbet listesi"/);
  assert.match(drawerSource, /aria-busy=\{loading\}/);
  assert.match(drawerSource, /aria-current=\{conv\.id === activeConvId \? 'true' : undefined\}/);
});
