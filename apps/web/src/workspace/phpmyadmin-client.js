const PHP_MYADMIN_PROTOCOL = 'yunpanel-phpmyadmin-signon-v1';
const PHP_MYADMIN_GATEWAY_BASE = '/tools/phpmyadmin/';
const PHP_MYADMIN_SIGNON_PATH = '/tools/phpmyadmin/__yunpanel/signon';
const CAPABILITY_PATTERN = /^[A-Za-z0-9_-]{43}$/;
const DATABASE_NAME_PATTERN = /^[A-Za-z0-9_]{1,64}$/;

export class PhpMyAdminBrowserHandoffError extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'PhpMyAdminBrowserHandoffError';
    this.code = code;
  }
}

function requiredString(value, label) {
  if (typeof value !== 'string' || value.length === 0) {
    throw new PhpMyAdminBrowserHandoffError(
      'phpmyadmin_handoff_input_invalid',
      `${label} eksik olduğu için phpMyAdmin açılamadı.`,
    );
  }
  return value;
}

function validateHandoff(handoff, expected, now) {
  if (!handoff || typeof handoff !== 'object'
    || handoff.protocol !== PHP_MYADMIN_PROTOCOL
    || !CAPABILITY_PATTERN.test(handoff.capability ?? '')
    || !Number.isInteger(handoff.expiresAt)
    || !handoff.target
    || typeof handoff.target !== 'object'
    || handoff.target.serverId !== expected.serverId
    || handoff.target.websiteId !== expected.websiteId
    || handoff.target.databaseCredentialId !== expected.credentialId
    || !DATABASE_NAME_PATTERN.test(handoff.target.databaseName ?? '')) {
    throw new PhpMyAdminBrowserHandoffError(
      'phpmyadmin_handoff_invalid',
      'phpMyAdmin oturum anahtarı güvenlik sözleşmesiyle eşleşmiyor. Yeniden deneyin.',
    );
  }
  if (handoff.expiresAt <= now) {
    throw new PhpMyAdminBrowserHandoffError(
      'phpmyadmin_handoff_expired',
      'phpMyAdmin oturum anahtarının süresi doldu. Yeniden deneyin.',
    );
  }
  return handoff;
}

function signonFailure(status) {
  if (status === 401) {
    return new PhpMyAdminBrowserHandoffError(
      'phpmyadmin_handoff_expired',
      'phpMyAdmin oturum anahtarı artık geçerli değil. Yeniden deneyin.',
    );
  }
  if (status === 403) {
    return new PhpMyAdminBrowserHandoffError(
      'phpmyadmin_handoff_forbidden',
      'phpMyAdmin erişimi bu yönetim oturumu için yetkili değil.',
    );
  }
  if (status === 503) {
    return new PhpMyAdminBrowserHandoffError(
      'phpmyadmin_handoff_unavailable',
      'phpMyAdmin signon servisi şu anda kullanılamıyor.',
    );
  }
  return new PhpMyAdminBrowserHandoffError(
    'phpmyadmin_handoff_failed',
    'phpMyAdmin oturumu başlatılamadı. Yeniden deneyin.',
  );
}

function validateNavigationResponse(response, origin) {
  if (!response || response.ok !== true) throw signonFailure(response?.status);
  let finalUrl;
  try {
    finalUrl = new URL(response.url, origin);
  } catch {
    throw new PhpMyAdminBrowserHandoffError(
      'phpmyadmin_handoff_navigation_invalid',
      'phpMyAdmin güvenli yönlendirmesi doğrulanamadı.',
    );
  }
  if (finalUrl.origin !== origin
    || !finalUrl.pathname.startsWith(PHP_MYADMIN_GATEWAY_BASE)
    || finalUrl.pathname === PHP_MYADMIN_SIGNON_PATH) {
    throw new PhpMyAdminBrowserHandoffError(
      'phpmyadmin_handoff_navigation_invalid',
      'phpMyAdmin güvenli yönlendirmesi doğrulanamadı.',
    );
  }
}

export async function openWebsitePhpMyAdmin({
  serverId,
  websiteId,
  credentialId,
  issueHandoff,
  fetchImpl = globalThis.fetch,
  locationImpl = globalThis.location,
  targetWindow = undefined,
  now = () => Date.now(),
} = {}) {
  const expected = {
    serverId: requiredString(serverId, 'serverId'),
    websiteId: requiredString(websiteId, 'websiteId'),
    credentialId: requiredString(credentialId, 'credentialId'),
  };
  if (typeof issueHandoff !== 'function') {
    throw new PhpMyAdminBrowserHandoffError(
      'phpmyadmin_handoff_client_missing',
      'phpMyAdmin handoff istemcisi kullanılamıyor.',
    );
  }
  if (targetWindow === null || targetWindow?.closed === true || locationImpl?.closed === true) {
    throw new PhpMyAdminBrowserHandoffError(
      'phpmyadmin_popup_blocked',
      'Tarayıcınız açılır pencereyi engelledi. Lütfen açılır pencerelere izin verip yeniden deneyin.',
    );
  }
  if (typeof fetchImpl !== 'function'
    || !locationImpl
    || typeof locationImpl.origin !== 'string'
    || typeof locationImpl.assign !== 'function') {
    throw new PhpMyAdminBrowserHandoffError(
      'phpmyadmin_browser_unavailable',
      'phpMyAdmin bu tarayıcı bağlamında açılamıyor.',
    );
  }

  let rawHandoff;
  try {
    rawHandoff = await issueHandoff(expected.serverId, expected.websiteId, expected.credentialId);
  } catch (err) {
    if (err instanceof PhpMyAdminBrowserHandoffError) throw err;
    const code = err?.code;
    const status = err?.status;
    const message = err?.message;

    if (code === 'managed_service_not_installed' || code === 'phpmyadmin_not_installed'
      || code === 'phpmyadmin_package_missing' || code === 'phpmyadmin_packages_missing'
      || code === 'service_not_installed') {
      throw new PhpMyAdminBrowserHandoffError(
        'phpmyadmin_package_missing',
        'phpMyAdmin paketleri sunucuda kurulu olmadığı için açılamadı. Sunucu yöneticisinden kurulum yapmasını isteyin.',
      );
    }
    if (status === 401 || code === 'phpmyadmin_handoff_expired' || code === 'unauthorized') {
      throw new PhpMyAdminBrowserHandoffError(
        'phpmyadmin_handoff_expired',
        'phpMyAdmin oturum anahtarının süresi doldu. Yeniden deneyin.',
      );
    }
    if (status === 403 || code === 'phpmyadmin_handoff_authorized_required'
      || code === 'phpmyadmin_handoff_forbidden' || code === 'phpmyadmin_handoff_session_binding_invalid'
      || code === 'site_scope_forbidden') {
      throw new PhpMyAdminBrowserHandoffError(
        'phpmyadmin_handoff_forbidden',
        'phpMyAdmin erişimi bu yönetim oturumu için yetkili değil.',
      );
    }
    if (code === 'popup_blocked' || code === 'phpmyadmin_popup_blocked') {
      throw new PhpMyAdminBrowserHandoffError(
        'phpmyadmin_popup_blocked',
        'Tarayıcınız açılır pencereyi engelledi. Lütfen açılır pencerelere izin verip yeniden deneyin.',
      );
    }
    if (code === 'phpmyadmin_handoff_binding_drift' || code === 'phpmyadmin_handoff_credential_not_applied'
      || code === 'phpmyadmin_handoff_credential_not_found') {
      throw new PhpMyAdminBrowserHandoffError(
        code,
        message || 'Veritabanı erişim durumu doğrulanamadı. Yeniden deneyin.',
      );
    }
    if (status === 503 || code === 'phpmyadmin_handoff_unavailable' || code === 'phpmyadmin_handoff_apply_state_unavailable') {
      throw new PhpMyAdminBrowserHandoffError(
        'phpmyadmin_handoff_unavailable',
        'phpMyAdmin signon servisi şu anda kullanılamıyor.',
      );
    }
    throw new PhpMyAdminBrowserHandoffError(
      code || 'phpmyadmin_handoff_failed',
      message || 'phpMyAdmin oturumu başlatılamadı. Yeniden deneyin.',
    );
  }

  const handoff = validateHandoff(
    rawHandoff,
    expected,
    now(),
  );

  const form = new URLSearchParams();
  form.set('capability', handoff.capability);
  let response;
  try {
    response = await fetchImpl(PHP_MYADMIN_SIGNON_PATH, {
      method: 'POST',
      credentials: 'same-origin',
      mode: 'same-origin',
      redirect: 'follow',
      cache: 'no-store',
      referrerPolicy: 'no-referrer',
      body: form,
    });
  } catch {
    throw new PhpMyAdminBrowserHandoffError(
      'phpmyadmin_handoff_network_failed',
      'phpMyAdmin signon servisine ulaşılamadı.',
    );
  } finally {
    form.delete('capability');
  }

  validateNavigationResponse(response, locationImpl.origin);
  if (targetWindow === null || targetWindow?.closed === true || locationImpl?.closed === true) {
    throw new PhpMyAdminBrowserHandoffError(
      'phpmyadmin_popup_blocked',
      'Tarayıcınız açılır pencereyi engelledi. Lütfen açılır pencerelere izin verip yeniden deneyin.',
    );
  }
  try {
    const nav = targetWindow?.location ?? locationImpl;
    nav.assign(PHP_MYADMIN_GATEWAY_BASE);
  } catch (error) {
    if (error?.name === 'SecurityError' || error?.name === 'NotAllowedError') {
      throw new PhpMyAdminBrowserHandoffError(
        'phpmyadmin_popup_blocked',
        'Tarayıcınız açılır pencereyi engelledi. Lütfen açılır pencerelere izin verip yeniden deneyin.',
      );
    }
    throw error;
  }
}

export const phpMyAdminBrowserHandoffInternals = Object.freeze({
  protocol: PHP_MYADMIN_PROTOCOL,
  gatewayBase: PHP_MYADMIN_GATEWAY_BASE,
  signonPath: PHP_MYADMIN_SIGNON_PATH,
  validateHandoff,
  validateNavigationResponse,
});
