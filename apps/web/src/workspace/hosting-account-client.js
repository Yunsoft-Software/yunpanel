const ROOT = '/users/hosting/accounts';
const ID = /^[A-Za-z0-9_-]{1,128}$/;
const USERNAME = /^[a-z0-9][a-z0-9._@+-]{2,127}$/;
const object = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);
const identifier = (value) => typeof value === 'string' && ID.test(value);
const integer = (value, min = 0) => Number.isSafeInteger(value) && value >= min;
const problem = (code) => Object.assign(new Error(code), { code });
const obsolete = () => Object.assign(problem('session_superseded'), { name: 'AbortError' });

export function hostingAccountMessage(error) {
  const messages = {
    hosting_account_revision_conflict: 'Profil değişti. Pencereyi kapatıp güncel kaydı yeniden açın.',
    user_revision_conflict: 'Kullanıcı hesabı değişti. Pencereyi kapatıp kullanıcı listesini yenileyin.',
    hosting_account_exists: 'Bu hesaba zaten bir profil bağlı. Listeyi yenileyip profili açın.',
    hosting_account_in_use: 'Profile bağlı müşteri, site veya ayrılmış kontenjan var. Profil kaldırılamadı; kayıtlar korunuyor.',
    hosting_site_migration_required: 'Bu hesabın mevcut site yetkileri var. Otomatik sahiplik aktarımı yapılmaz.',
    hosting_profile_requires_site_manager: 'Profil için site atanmamış bir Site Yöneticisi hesabı seçin.',
    reseller_limit_reached: 'Bayinin adet sınırı doldu. Yeni kayıt eklenmedi.',
    reseller_scope_forbidden: 'Seçilen bayinin etkin olduğunu kontrol edin; bu ilişki kurulamadı.',
    hosting_account_not_found: 'Profil artık bulunmuyor. Listeyi yenileyin.',
    username_taken: 'Bu kullanıcı adı zaten kullanımda. Başka bir kullanıcı adı seçin.',
    invalid_username: 'Kullanıcı adı 3–128 karakter olmalı; harf, rakam ve . _ @ + - kullanılabilir.',
    invalid_password: 'Parola en az 12 karakter olmalı.',
    empty_hosting_customer_update: 'Değiştirilecek bir kullanıcı adı veya yeni parola girin.',
    hosting_customer_credentials_unavailable: 'Müşteri giriş hesabı yönetimi bu API sürümünde kullanılamıyor.',
    invalid_active: 'Hesap durumu geçersiz. Profili yenileyip işlemi tekrar seçin.',
    hosting_user_not_found: 'Kullanıcı hesabı artık bulunmuyor. Listeyi yenileyin.',
    invalid_reseller_limits: 'Her iki adet sınırını da girin veya ayrı ayrı Sınırsız seçin. Sıfır yeni kayıt eklenmesini engeller.',
    invalid_hosting_parent: 'Müşterinin bağlı olacağı bayiyi seçin veya doğrudan yönetimi işaretleyin.',
    hosting_result_invalid: 'API yanıtı doğrulanamadı. Tekrar göndermeden önce güncel profili kontrol edin.',
    hosting_request_busy: 'Bir profil işlemi zaten devam ediyor.',
    hosting_reconciliation_required: 'Önce pencereyi kapatıp güncel profili yeniden açın; işlem otomatik tekrarlanmaz.',
    hosting_accounts_unavailable: 'Hesap API’si kullanılamıyor. API ve arayüz sürümlerini kontrol edin.',
    forbidden: 'Bu işlem için Owner yetkisi gerekiyor.',
    unauthorized: 'Oturum kapandı. Yeniden giriş yapın.',
    csrf_invalid: 'Oturum doğrulanamadı. Yeniden giriş yapın.',
    mfa_enrollment_required: 'Yönetim için iki adımlı doğrulamayı tamamlayın.',
  };
  return messages[error?.code] ?? (error?.status === 404 ? 'Hesap API’si bulunamadı. API ve arayüz sürümlerini kontrol edin.' : 'İşlem tamamlanamadı. Bağlantıyı ve güncel kaydı kontrol edin.');
}

export function readHostingAccount(value) {
  if (!object(value) || !identifier(value.id) || typeof value.username !== 'string' || !USERNAME.test(value.username)
    || !['reseller', 'customer'].includes(value.kind) || typeof value.active !== 'boolean'
    || !integer(value.revision, 1) || !integer(value.userRevision, 1)
    || !integer(value.createdAt) || !integer(value.updatedAt) || value.stage !== 'profile_only'
    || (value.resellerId !== null && (!identifier(value.resellerId) || value.resellerId === value.id))
    || (value.kind === 'reseller' && value.resellerId !== null)) throw problem('hosting_result_invalid');
  const { id, username, kind, resellerId, active, revision, userRevision, createdAt, updatedAt, stage } = value;
  const result = { id, username, kind, resellerId, active, revision, userRevision, createdAt, updatedAt, stage };
  if (kind === 'reseller') {
    if (!object(value.limits) || !['maxCustomers', 'maxWebsites'].every((key) => value.limits[key] === null || integer(value.limits[key]))
      || !object(value.usage) || !integer(value.usage.customers) || !integer(value.usage.websites)
      || !['registered_ownership', 'registered_and_reserved_ownership'].includes(value.usageScope)) throw problem('hosting_result_invalid');
    result.limits = { maxCustomers: value.limits.maxCustomers, maxWebsites: value.limits.maxWebsites };
    result.usage = { customers: value.usage.customers, websites: value.usage.websites };
    result.usageScope = value.usageScope;
  }
  return result; // Only documented fields; no accidental credentials or server messages.
}

export function readHostingPage(value, { kind, offset, limit, resellerId }) {
  if (!object(value) || value.offset !== offset || value.limit !== limit || !integer(value.total)
    || !Array.isArray(value.accounts) || value.accounts.length !== Math.max(0, Math.min(limit, value.total - offset))) throw problem('hosting_result_invalid');
  const accounts = value.accounts.map(readHostingAccount);
  if (new Set(accounts.map((account) => account.id)).size !== accounts.length
    || accounts.some((account) => account.kind !== kind || (resellerId !== undefined && account.resellerId !== resellerId))) throw problem('hosting_result_invalid');
  return { accounts, total: value.total, offset, limit };
}

export function hostingLimitsInput(form) {
  const limits = {};
  for (const key of ['maxCustomers', 'maxWebsites']) {
    const value = form?.[key];
    if (value === null) { limits[key] = null; continue; }
    if (typeof value !== 'string' || !/^\d+$/.test(value.trim()) || !integer(Number(value.trim()))) throw problem('invalid_reseller_limits');
    limits[key] = Number(value.trim());
  }
  return limits;
}

export function hostingRegistrationInput(user, form) {
  if (!identifier(user?.id) || !integer(user.revision, 1) || user.role !== 'site_manager'
    || !Array.isArray(user.websiteIds) || user.websiteIds.length) throw problem('hosting_profile_requires_site_manager');
  const base = { userId: user.id, expectedUserRevision: user.revision };
  if (form?.kind === 'reseller') return { ...base, kind: 'reseller', limits: hostingLimitsInput(form) };
  if (form?.kind !== 'customer' || (form.resellerId !== null && (!identifier(form.resellerId) || form.resellerId === user.id))) throw problem('invalid_hosting_parent');
  return { ...base, kind: 'customer', resellerId: form.resellerId };
}

function normalizedCustomerUsername(value) {
  if (typeof value !== 'string') throw problem('invalid_username');
  const normalized = value.trim().toLowerCase();
  if (!USERNAME.test(normalized)) throw problem('invalid_username');
  return normalized;
}
function customerPassword(value) {
  if (typeof value !== 'string' || [...value].length < 12 || new TextEncoder().encode(value).length > 1024) throw problem('invalid_password');
  return value;
}
export function hostingCustomerCreateInput(form) {
  return { username: normalizedCustomerUsername(form?.username), password: customerPassword(form?.password) };
}
export function hostingCustomerLoginInput(account, form) {
  const body = { revision: account.revision };
  if (form && Object.hasOwn(form, 'username')) {
    const username = normalizedCustomerUsername(form.username);
    if (username !== account.username) body.username = username;
  }
  if (form && typeof form.password === 'string' && form.password.length) body.password = customerPassword(form.password);
  if (Object.keys(body).length === 1) throw problem('empty_hosting_customer_update');
  return body;
}

/** Instance belongs to one mounted Owner component. No cache, storage, automatic
 * writes/retries or new auth mechanism. Separate read lanes keep picker/page reads
 * independent; generations also reject stale responses when abort is ignored.
 */
export function createHostingAccountClient({ request, generation, onAccessLost }) {
  const readers = new Map();
  let disposed = false, writer = null, blockedTarget = null;
  const stamp = generation();
  const live = () => !disposed && generation() === stamp;
  const cancelReads = () => { for (const controller of readers.values()) controller.abort(); readers.clear(); };
  const lost = (error) => {
    if (live() && [401, 403].includes(error?.status)) {
      disposed = true; cancelReads(); writer?.abort(); onAccessLost();
    }
  };
  async function read(lane, path, parse, absentId = null) {
    if (!live()) throw obsolete();
    if (writer) throw problem('hosting_request_busy');
    readers.get(lane)?.abort(); const controller = new AbortController(); readers.set(lane, controller);
    const valid = () => live() && !controller.signal.aborted && readers.get(lane) === controller;
    try {
      const result = await request(path, { signal: controller.signal });
      if (!valid()) throw obsolete();
      const parsed = parse(result);
      if (absentId === blockedTarget) blockedTarget = null;
      return parsed;
    } catch (error) {
      if (!valid()) throw obsolete();
      // A missing endpoint / HTML 404 is NOT an absent profile.
      if (absentId && error.status === 404 && error.code === 'hosting_account_not_found') {
        if (blockedTarget === absentId) blockedTarget = null;
        return null;
      }
      lost(error); throw error;
    } finally { if (readers.get(lane) === controller) readers.delete(lane); }
  }
  return Object.freeze({
    get(id) {
      if (!identifier(id)) return Promise.reject(problem('hosting_result_invalid'));
      return read('profile', `${ROOT}/${encodeURIComponent(id)}`, (value) => {
        const account = readHostingAccount(value);
        if (account.id !== id) throw problem('hosting_result_invalid');
        return account;
      }, id);
    },
    list({ kind, offset = 0, limit = 25, resellerId } = {}, lane = 'list') {
      if (!['reseller', 'customer'].includes(kind) || !integer(offset) || !integer(limit, 1) || limit > 100
        || (resellerId !== undefined && (kind !== 'customer' || (resellerId !== null && !identifier(resellerId))))) {
        return Promise.reject(problem('hosting_result_invalid'));
      }
      const query = new URLSearchParams({ kind, offset: String(offset), limit: String(limit) });
      if (resellerId === null) query.set('direct', 'true');
      else if (resellerId !== undefined) query.set('resellerId', resellerId);
      return read(lane, `${ROOT}?${query}`, (value) => readHostingPage(value, { kind, offset, limit, resellerId }));
    },
    async mutate({ action, user, account, form }) {
      if (!live()) throw obsolete();
      if (writer) throw problem('hosting_request_busy');
      if (blockedTarget) throw problem('hosting_reconciliation_required');
      let method, path, body, target, expectedKind, expectedParent;
      if (action === 'createCustomer') {
        account = readHostingAccount(account);
        if (account.kind !== 'reseller' || !account.active) throw problem('hosting_result_invalid');
        body = hostingCustomerCreateInput(form); target = account.id; expectedKind = 'customer'; expectedParent = account.id;
        method = 'POST'; path = `${ROOT}/self/customers`;
      } else if (action === 'register') {
        body = hostingRegistrationInput(user, form); target = user.id; expectedKind = body.kind;
        expectedParent = body.kind === 'customer' ? body.resellerId : null;
        method = 'POST'; path = ROOT;
      } else {
        account = readHostingAccount(account); target = account.id; expectedKind = account.kind; expectedParent = account.resellerId;
        if (action === 'limits' && account.kind === 'reseller') {
          method = 'PATCH'; path = `${ROOT}/${encodeURIComponent(target)}/limits`;
          body = { revision: account.revision, limits: hostingLimitsInput(form) };
        } else if (action === 'status' && typeof form?.active === 'boolean' && form.active !== account.active) {
          method = 'PATCH'; path = `${ROOT}/${encodeURIComponent(target)}/status`;
          body = { revision: account.revision, active: form.active };
        } else if (action === 'login' && account.kind === 'customer') {
          method = 'PATCH'; path = `${ROOT}/${encodeURIComponent(target)}/login`;
          body = hostingCustomerLoginInput(account, form);
        } else if (action === 'unregister') {
          method = 'DELETE'; path = `${ROOT}/${encodeURIComponent(target)}/profile`;
          body = { revision: account.revision, confirmation: `unregister-hosting-profile:${target}:${account.revision}` };
        } else throw problem('hosting_result_invalid');
      }
      const controller = new AbortController(); writer = controller; cancelReads();
      try {
        const result = await request(path, { method, body, signal: controller.signal });
        if (!live() || controller.signal.aborted) throw obsolete();
        if (!object(result) || result.accessGranted !== false
          || (['createCustomer', 'login'].includes(action) && result.siteAccessGranted !== false)) throw problem('hosting_result_invalid');
        if (action === 'unregister') {
          if (result.id !== target || result.unregistered !== true || result.loginDeleted !== false) throw problem('hosting_result_invalid');
          return { id: target, unregistered: true, loginDeleted: false, accessGranted: false };
        }
        if (action === 'status' && result.hostSitesSuspended !== false) throw problem('hosting_result_invalid');
        const next = readHostingAccount(result.account);
        if ((action === 'createCustomer' ? next.id === target || next.username !== body.username : next.id !== target)
          || next.kind !== expectedKind || next.resellerId !== expectedParent
          || (action === 'createCustomer' && (next.revision !== 1 || next.userRevision < 2))
          || (action === 'register' && next.userRevision <= user.revision)
          || (action === 'register' && expectedKind === 'reseller' && (next.limits.maxCustomers !== body.limits.maxCustomers || next.limits.maxWebsites !== body.limits.maxWebsites))
          || (action === 'limits' && (next.revision < account.revision || next.limits.maxCustomers !== body.limits.maxCustomers || next.limits.maxWebsites !== body.limits.maxWebsites))
          || (action === 'status' && (next.active !== body.active || next.revision <= account.revision))
          || (action === 'login' && (next.revision <= account.revision || next.userRevision <= account.userRevision
            || (body.username !== undefined && next.username !== body.username)))) throw problem('hosting_result_invalid');
        if (action === 'status') return { account: next, accessGranted: false, hostSitesSuspended: false };
        if (['createCustomer', 'login'].includes(action)) return { account: next, accessGranted: false, siteAccessGranted: false };
        return { account: next, accessGranted: false };
      } catch (error) {
        if (!live() || controller.signal.aborted) throw obsolete();
        if (!error.status || error.status >= 500 || ['user_revision_conflict', 'hosting_account_revision_conflict', 'hosting_account_exists', 'hosting_account_not_found'].includes(error.code)) {
          error.reconcile = true; blockedTarget = target;
        }
        lost(error); throw error;
      } finally { if (writer === controller) writer = null; }
    },
    dispose() { disposed = true; cancelReads(); writer?.abort(); },
  });
}
