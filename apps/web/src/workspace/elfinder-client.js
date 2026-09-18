const ELFINDER_PROTOCOL = 'yunpanel-elfinder-handoff-v1';
const ELFINDER_AUDIENCE = 'elfinder';
const ELFINDER_GATEWAY_BASE = '/tools/elfinder/';
const CAPABILITY_PATTERN = /^[A-Za-z0-9_-]{43}$/;

export class ElFinderBrowserHandoffError extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'ElFinderBrowserHandoffError';
    this.code = code;
  }
}

function requiredString(value, label) {
  if (typeof value !== 'string' || value.length === 0) {
    throw new ElFinderBrowserHandoffError(
      'elfinder_handoff_input_invalid',
      `${label} eksik olduğu için dosya yöneticisi açılamadı.`,
    );
  }
  return value;
}

function validateHandoff(handoff, expected, now) {
  if (!handoff || typeof handoff !== 'object'
    || handoff.protocol !== ELFINDER_PROTOCOL
    || handoff.audience !== ELFINDER_AUDIENCE
    || !CAPABILITY_PATTERN.test(handoff.capability ?? '')
    || !Number.isInteger(handoff.expiresAt)
    || !handoff.target || typeof handoff.target !== 'object'
    || handoff.target.serverId !== expected.serverId
    || handoff.target.websiteId !== expected.websiteId) {
    throw new ElFinderBrowserHandoffError(
      'elfinder_handoff_invalid',
      'Dosya yöneticisi oturum anahtarı güvenlik sözleşmesiyle eşleşmiyor. Yeniden deneyin.',
    );
  }
  if (handoff.expiresAt <= now) {
    throw new ElFinderBrowserHandoffError(
      'elfinder_handoff_expired',
      'Dosya yöneticisi oturum anahtarının süresi doldu. Yeniden deneyin.',
    );
  }
  return handoff;
}

export async function openWebsiteElFinder({
  serverId,
  websiteId,
  issueHandoff,
  locationImpl = globalThis.location,
  now = () => Date.now(),
} = {}) {
  const expected = {
    serverId: requiredString(serverId, 'serverId'),
    websiteId: requiredString(websiteId, 'websiteId'),
  };
  if (typeof issueHandoff !== 'function') {
    throw new ElFinderBrowserHandoffError(
      'elfinder_handoff_client_missing',
      'Dosya yöneticisi handoff istemcisi kullanılamıyor.',
    );
  }
  if (!locationImpl
    || typeof locationImpl.origin !== 'string'
    || typeof locationImpl.assign !== 'function') {
    throw new ElFinderBrowserHandoffError(
      'elfinder_browser_unavailable',
      'Dosya yöneticisi bu tarayıcı bağlamında açılamıyor.',
    );
  }

  const handoff = validateHandoff(
    await issueHandoff(expected.serverId, expected.websiteId),
    expected,
    now(),
  );

  const destination = new URL(
    `${ELFINDER_GATEWAY_BASE}#handoff=${encodeURIComponent(handoff.capability)}`,
    locationImpl.origin,
  );
  if (destination.origin !== locationImpl.origin
    || destination.pathname !== ELFINDER_GATEWAY_BASE
    || destination.search) {
    throw new ElFinderBrowserHandoffError(
      'elfinder_handoff_navigation_invalid',
      'Dosya yöneticisi güvenli yönlendirmesi doğrulanamadı.',
    );
  }
  locationImpl.assign(`${destination.pathname}${destination.hash}`);
}

export const elFinderBrowserHandoffInternals = Object.freeze({
  protocol: ELFINDER_PROTOCOL,
  audience: ELFINDER_AUDIENCE,
  gatewayBase: ELFINDER_GATEWAY_BASE,
  validateHandoff,
});
