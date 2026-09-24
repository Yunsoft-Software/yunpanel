import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const ACTOR = /^[A-Za-z0-9._:-]{1,128}$/;
export class AiHistoryError extends Error {
  constructor(code, message, status = 400) { super(message); this.name = 'AiHistoryError'; this.code = code; this.status = status; }
}
const invalidCursor = () => new AiHistoryError('invalid_ai_history_cursor', 'Sohbet sayfası geçersiz veya süresi dolmuş. Geçmişi yenileyin.');

export function conversationScope(auth, websiteId = null) {
  const user = auth?.user;
  if (!user || typeof user.id !== 'string' || !ACTOR.test(user.id)) {
    throw new AiHistoryError('unauthorized', 'Authenticated conversation owner is required.', 401);
  }
  const owner = user.role === 'owner' && auth.access?.mode === 'management' && auth.access?.permissions?.includes('*');
  const manager = user.role === 'site_manager' && auth.access?.mode === 'site_management' && Array.isArray(user.websiteIds);
  if (auth.security?.managementAllowed !== true || (!owner && !manager)) {
    throw new AiHistoryError('forbidden', 'Conversation access is not allowed.', 403);
  }
  if (websiteId !== null && (typeof websiteId !== 'string' || !UUID.test(websiteId))) {
    throw new AiHistoryError('invalid_ai_website', 'A Website identity is required.');
  }
  const grants = manager ? [...new Set(user.websiteIds.filter((id) => typeof id === 'string' && UUID.test(id)))].sort() : [];
  if (manager && websiteId !== null && !grants.includes(websiteId)) {
    throw new AiHistoryError('conversation_not_found', 'Conversation scope not found.', 404);
  }
  return Object.freeze({ actorId: user.id, websiteId, owner: Boolean(owner), grants: Object.freeze(grants) });
}
export function conversationVisible(conversation, scope) {
  return Boolean(conversation && conversation.actorId === scope.actorId
    && (scope.websiteId === null || conversation.websiteId === scope.websiteId)
    && (scope.owner || scope.grants.includes(conversation.websiteId)));
}
export function conversationSummary(conversation) {
  return Object.freeze({ id: conversation.id, title: conversation.title, websiteId: conversation.websiteId,
    createdAt: conversation.createdAt, updatedAt: conversation.updatedAt, messageCount: conversation.messages.length });
}
const key = (item) => [new Date(item.createdAt).toISOString(), item.id];
const compareKey = (a, b) => a[0] === b[0] ? (a[1] < b[1] ? -1 : a[1] > b[1] ? 1 : 0) : (a[0] < b[0] ? -1 : 1);

// Immutable creation order prevents messages/renames from moving unread rows
// across a page boundary. Cursors are scope-bound hints, never authorization.
export function createConversationPager() {
  const secret = randomBytes(32);
  const sign = (text) => createHmac('sha256', secret).update(text).digest();
  return (conversations, scope, { limit = 20, cursor = null } = {}) => {
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 50) {
      throw new AiHistoryError('invalid_ai_history_limit', 'History page size must be between 1 and 50.');
    }
    const scopeHash = sign(JSON.stringify(scope)).toString('base64url');
    let after = null;
    if (cursor !== null) {
      try {
        if (typeof cursor !== 'string' || cursor.length > 1024 || !/^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]{43}$/.test(cursor)) throw invalidCursor();
        const [payload, mac] = cursor.split('.');
        const signature = Buffer.from(mac, 'base64url');
        if (signature.length !== 32 || signature.toString('base64url') !== mac || !timingSafeEqual(signature, sign(payload))) throw invalidCursor();
        const decoded = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8'));
        if (decoded.version !== 1 || decoded.scope !== scopeHash || !Array.isArray(decoded.after) || decoded.after.length !== 2
          || typeof decoded.after[0] !== 'string' || !Number.isFinite(Date.parse(decoded.after[0]))
          || typeof decoded.after[1] !== 'string' || !UUID.test(decoded.after[1])) throw invalidCursor();
        after = decoded.after;
      } catch { throw invalidCursor(); }
    }
    const rows = conversations.filter((item) => conversationVisible(item, scope))
      .sort((a, b) => compareKey(key(b), key(a)))
      .filter((item) => after === null || compareKey(key(item), after) < 0);
    const selected = rows.slice(0, limit);
    const hasMore = rows.length > limit;
    let nextCursor = null;
    if (hasMore) {
      const payload = Buffer.from(JSON.stringify({ version: 1, scope: scopeHash, after: key(selected.at(-1)) })).toString('base64url');
      nextCursor = `${payload}.${sign(payload).toString('base64url')}`;
    }
    return Object.freeze({ items: Object.freeze(selected.map(conversationSummary)), hasMore, nextCursor,
      scope: Object.freeze({ actorId: scope.actorId, websiteId: scope.websiteId }),
      legacyUnassigned: scope.owner && conversations.some((item) => item.actorId == null) });
  };
}
