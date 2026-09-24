const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const record = (value) => Boolean(value && typeof value === 'object' && !Array.isArray(value));
const bad = () => new Error('Sohbet geçmişi doğrulanamadı.');
const timestamp = (value) => typeof value === 'string' && value.length <= 40 && Number.isFinite(Date.parse(value));
export const EMPTY_AI_HISTORY = Object.freeze({ items: Object.freeze([]), status: 'idle', nextCursor: null, hasMore: false, legacyUnassigned: false, error: null, reloadRequired: false });
export function aiHistorySummary(value, websiteId) {
  if (!record(value) || typeof value.id !== 'string' || !UUID.test(value.id)
    || typeof value.title !== 'string' || value.title.length > 100
    || (value.websiteId !== null && (typeof value.websiteId !== 'string' || !UUID.test(value.websiteId)))
    || (websiteId !== null && value.websiteId !== websiteId)
    || !timestamp(value.createdAt) || !timestamp(value.updatedAt)
    || !Number.isSafeInteger(value.messageCount) || value.messageCount < 0) throw bad();
  return Object.freeze({ id: value.id, title: value.title, websiteId: value.websiteId,
    createdAt: new Date(value.createdAt).toISOString(), updatedAt: new Date(value.updatedAt).toISOString(), messageCount: value.messageCount });
}
function merge(old, incoming, removed) {
  const rows = new Map(old.map((item) => [item.id, item]));
  for (const item of incoming) {
    const previous = rows.get(item.id);
    if (!removed.has(item.id) && (!previous || previous.updatedAt <= item.updatedAt)) rows.set(item.id, item);
  }
  return Object.freeze([...rows.values()].filter((item) => !removed.has(item.id)).sort((a, b) => {
    const left = `${a.createdAt}:${a.id}`, right = `${b.createdAt}:${b.id}`;
    return left > right ? -1 : left < right ? 1 : 0;
  }));
}
export function createAiHistory({ actorId, websiteId = null, read, isCurrent = () => true, onState = () => {} }) {
  if (typeof actorId !== 'string' || !actorId || [read, isCurrent, onState].some((fn) => typeof fn !== 'function')) throw new TypeError('AI history scope is required.');
  let state = EMPTY_AI_HISTORY, generation = 0, controller = null, disposed = false, loading = false;
  const consumed = new Set(), removed = new Set(), edits = new Map();
  let editSerial = 0;
  const active = (version) => !disposed && version === generation && isCurrent() === true;
  const publish = (patch) => { state = Object.freeze({ ...state, ...patch }); onState(state); };
  async function load(more = false) {
    if (disposed || isCurrent() !== true || (more && (loading || !state.hasMore || state.reloadRequired))) return state;
    controller?.abort(); controller = new AbortController(); const signal = controller.signal, version = ++generation;
    const cursor = more ? state.nextCursor : null;
    const startedAt = editSerial;
    if (!more) consumed.clear();
    loading = true; publish({ status: more ? 'loadingMore' : 'loading', error: null, reloadRequired: false });
    try {
      const page = await read({ limit: 20, cursor, signal });
      if (!active(version)) return state;
      if (!record(page) || page.scope?.actorId !== actorId || page.scope?.websiteId !== websiteId
        || !Array.isArray(page.items) || page.items.length > 20 || typeof page.hasMore !== 'boolean'
        || typeof page.legacyUnassigned !== 'boolean'
        || (page.hasMore ? typeof page.nextCursor !== 'string' || !page.nextCursor || page.nextCursor.length > 1024 || !page.items.length
          : page.nextCursor !== null)) throw bad();
      if (page.hasMore && (page.nextCursor === cursor || consumed.has(page.nextCursor))) throw bad();
      const items = page.items.map((item) => aiHistorySummary(item, websiteId));
      if (new Set(items.map((item) => item.id)).size !== items.length) throw bad();
      if (cursor) consumed.add(cursor);
      publish({ status: 'ready', items: merge(more ? state.items : [...edits.values()].filter((edit) => edit.serial > startedAt).map((edit) => edit.item), items, removed),
        hasMore: page.hasMore, nextCursor: page.nextCursor, legacyUnassigned: page.legacyUnassigned });
    } catch (error) {
      if (!active(version)) return state;
      if ([401, 403].includes(error?.status)) publish({ ...EMPTY_AI_HISTORY, status: 'forbidden', error: 'Geçmişe erişim yetkiniz değişti.' });
      else publish({ status: 'error', reloadRequired: error?.code === 'invalid_ai_history_cursor',
        error: error?.code === 'invalid_ai_history_cursor' ? 'Sayfa anahtarı yenilenmeli. Geçmişi yenileyin.' : 'Geçmiş yüklenemedi. Mevcut sohbet korunuyor; yeniden deneyin.' });
    } finally { if (version === generation) loading = false; }
    return state;
  }
  return Object.freeze({ load: () => load(false), more: () => load(true), getState: () => state,
    upsert: (value) => { if (!active(generation) || state.status === 'forbidden') return; const item = aiHistorySummary(value, websiteId); edits.set(item.id, { item, serial: ++editSerial }); publish({ items: merge(state.items, [item], removed) }); },
    remove: (id) => { if (!active(generation)) return; removed.add(id); publish({ items: Object.freeze(state.items.filter((item) => item.id !== id)) }); },
    dispose: () => { disposed = true; generation++; controller?.abort(); },
  });
}

export function createAiConversationReader({ websiteId = null, read, isCurrent = () => true, onState = () => {} }) {
  let generation = 0, disposed = false, controller = null;
  return Object.freeze({
    async load(id) {
      if (disposed || isCurrent() !== true) return;
      if (id !== null && (typeof id !== 'string' || !UUID.test(id))) throw bad();
      controller?.abort(); controller = new AbortController(); const signal = controller.signal, version = ++generation;
      const current = () => !disposed && version === generation && isCurrent() === true;
      onState({ id, status: id ? 'loading' : 'idle', conversation: null, error: null });
      if (!id) return;
      try {
        const value = await read(id, { signal });
        if (!current()) return;
        const header = aiHistorySummary(value, websiteId);
        if (header.id !== id || !Array.isArray(value.messages) || value.messages.length !== header.messageCount) throw bad();
        onState({ id, status: 'ready', conversation: { ...header, messages: value.messages }, error: null });
      } catch (error) {
        if (current()) onState({ id, status: [401, 403].includes(error?.status) ? 'forbidden' : 'error', conversation: null, error: 'Sohbet ayrıntısı yüklenemedi. Yeniden deneyin.' });
      }
    },
    dispose: () => { disposed = true; generation++; controller?.abort(); },
  });
}

// Site routes use Domain IDs; the AI conversation schema uses Website IDs.
export async function resolveAiWebsiteContext(domainId, request, { signal } = {}) {
  if (typeof domainId !== 'string' || !UUID.test(domainId)) throw bad();
  const domain = await request(`/domains/${encodeURIComponent(domainId)}`, { signal });
  if (signal?.aborted || domain?.id !== domainId || typeof domain.websiteId !== 'string' || !UUID.test(domain.websiteId)) throw bad();
  const website = await request(`/websites/${encodeURIComponent(domain.websiteId)}`, { signal });
  if (signal?.aborted || website?.id !== domain.websiteId || !domain.serverId || website.serverId !== domain.serverId) throw bad();
  return website.id;
}
