const CAPABILITY_PATTERN = /^[A-Za-z0-9_-]{43}$/;
const ID_PATTERN = /^[0-9a-f-]{36}$/i;
const PROTOCOL = 'yunpanel-terminal-v1';
const CAPABILITY_PREFIX = 'yunpanel-terminal-capability.';

function exactObject(value, fields) {
  return value && typeof value === 'object' && !Array.isArray(value)
    && Object.keys(value).length === fields.length
    && Object.keys(value).every((key) => fields.includes(key));
}

function targetIdentity(target) {
  if (!target || typeof target !== 'object' || Array.isArray(target)) return null;
  if (target.scope === 'server' && typeof target.serverId === 'string'
    && target.user === 'root' && target.cwd === '/root') return `server:${target.serverId}:root:/root`;
  if (target.scope === 'site' && typeof target.serverId === 'string' && typeof target.websiteId === 'string'
    && /^yunapp-[a-f0-9]{12}$/.test(target.user ?? '') && typeof target.cwd === 'string') {
    return `site:${target.serverId}:${target.websiteId}:${target.user}:${target.cwd}`;
  }
  return null;
}

export function normalizeTerminalCapability(value, now = Date.now()) {
  if (!exactObject(value, ['capability', 'expiresAt', 'protocol', 'target'])
    || !CAPABILITY_PATTERN.test(value.capability ?? '') || value.protocol !== PROTOCOL
    || !Number.isSafeInteger(value.expiresAt) || value.expiresAt <= now
    || !targetIdentity(value.target)) throw new Error('API geçerli bir terminal yetkisi döndürmedi.');
  return Object.freeze({ ...value, target: Object.freeze({ ...value.target }) });
}

export function terminalWebSocketUrl(locationLike = globalThis.location) {
  if (!locationLike?.href) throw new Error('Terminal adresi oluşturulamadı.');
  const url = new URL('/api/terminal', locationLike.href);
  if (url.protocol === 'https:') url.protocol = 'wss:';
  else if (url.protocol === 'http:') url.protocol = 'ws:';
  else throw new Error('Terminal yalnız HTTP(S) panel adresinde kullanılabilir.');
  url.username = '';
  url.password = '';
  url.search = '';
  url.hash = '';
  return url.href;
}

export function createTerminalWebSocket(rawCapability, {
  WebSocketClass = globalThis.WebSocket,
  locationLike = globalThis.location,
} = {}) {
  if (typeof WebSocketClass !== 'function') throw new Error('Tarayıcı WebSocket bağlantısını desteklemiyor.');
  const capability = normalizeTerminalCapability(rawCapability);
  return new WebSocketClass(terminalWebSocketUrl(locationLike), [
    PROTOCOL,
    `${CAPABILITY_PREFIX}${capability.capability}`,
  ]);
}

export function parseTerminalMessage(raw) {
  if (typeof raw !== 'string' || raw.length > 17 * 1024 * 1024) throw new Error('Terminal iletisi geçersiz.');
  let message;
  try { message = JSON.parse(raw); } catch { throw new Error('Terminal iletisi geçersiz.'); }
  if (message?.type === 'ready' && exactObject(message, ['type', 'sessionId', 'target'])
    && ID_PATTERN.test(message.sessionId ?? '') && targetIdentity(message.target)) return message;
  if (message?.type === 'output' && exactObject(message, ['type', 'data']) && typeof message.data === 'string') return message;
  if (message?.type === 'exit' && exactObject(message, ['type', 'exitCode', 'signal'])
    && (message.exitCode === null || Number.isInteger(message.exitCode))
    && (message.signal === null || Number.isInteger(message.signal))) return message;
  if (message?.type === 'error' && exactObject(message, ['type', 'code', 'message'])
    && typeof message.code === 'string' && typeof message.message === 'string') return message;
  if (message?.type === 'revoked' && exactObject(message, ['type', 'reason']) && typeof message.reason === 'string') return message;
  if (message?.type === 'pong' && exactObject(message, ['type'])) return message;
  throw new Error('Terminal iletisi geçersiz.');
}

export const terminalClientInternals = Object.freeze({ protocol: PROTOCOL, capabilityPrefix: CAPABILITY_PREFIX, targetIdentity });
