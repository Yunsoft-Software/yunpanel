const ID = /^[A-Za-z0-9_-]{1,128}$/;
const USERNAME = /^[a-z0-9][a-z0-9._@+-]{2,127}$/;
const integer = (value, minimum = 0) => Number.isSafeInteger(value) && value >= minimum;
const object = (value) => value && typeof value === 'object' && !Array.isArray(value);
function problem(code) { const error = new Error(code); error.code = code; return error; }
function obsolete() { const error = problem('session_superseded'); error.name = 'AbortError'; return error; }
const denied = (error) => [401, 403].includes(error.status);

export function userAdminMessage(error) {
  const messages = {
    last_owner: 'Son aktif Owner silinemez, kapatılamaz veya Read Only rolüne düşürülemez.',
    user_revision_conflict: 'Bu hesap başka bir işlemde değişti. Formu kapatıp güncel kaydı yeniden açın; değişiklikleriniz gönderilmedi.',
    username_taken: 'Bu kullanıcı adı başka bir hesapta kullanılıyor.',
    invalid_username: 'Kullanıcı adı 3–128 karakter olmalı; harf, rakam ve . _ @ + - kullanılabilir.',
    invalid_password: 'Parola en az 12 karakter, en fazla 1024 bayt olmalı.',
    invalid_role: 'Geçerli bir hesap rolü seçin.',
    invalid_active: 'Geçerli bir hesap durumu seçin.',
    user_not_found: 'Hesap artık bulunmuyor. Formu kapatıp listeyi yenileyin.',
    invalid_revision: 'Güncel hesap sürümü alınamadı. Kaydı yeniden açın.',
    user_page_invalid: 'API geçerli bir kullanıcı listesi döndürmedi. API ve arayüz sürümlerini kontrol edin.',
    user_result_invalid: 'İşlem yanıtı doğrulanamadı. Yeniden göndermeden önce listeyi kontrol edin.',
    user_request_busy: 'Bir hesap işlemi zaten devam ediyor.',
    forbidden: 'Kullanıcı yönetimi için Owner yetkisi gerekiyor.',
    mfa_enrollment_required: 'Yönetim erişimi için iki adımlı doğrulamayı tamamlayın.',
    unauthorized: 'Oturumunuz kapatıldı. Yeniden giriş yapın.',
    csrf_invalid: 'Oturum doğrulanamadı. Yeniden giriş yapın.',
    auth_busy: 'Parola işlemleri şu anda yoğun. Biraz sonra tekrar deneyin.',
    rate_limited: 'Çok fazla deneme yapıldı. Biraz sonra tekrar deneyin.',
  };
  return messages[error?.code] ?? (error?.status === 404 ? 'Kullanıcı yönetimi API’si bulunamadı. API ve arayüz sürümlerini kontrol edin.' : 'İstek tamamlanamadı. Bağlantıyı ve sunucu durumunu kontrol edin.');
}

export function readAdminUser(value) {
  if (!object(value) || !ID.test(value.id) || typeof value.id !== 'string'
    || typeof value.username !== 'string' || !USERNAME.test(value.username)
    || !['owner', 'read_only'].includes(value.role) || typeof value.active !== 'boolean'
    || typeof value.mfaEnabled !== 'boolean' || !integer(value.revision, 1)
    || !integer(value.createdAt) || !integer(value.updatedAt)) throw problem('user_result_invalid');
  // Never retain arbitrary response fields (including any accidental credentials).
  const { id, username, role, active, mfaEnabled, revision, createdAt, updatedAt } = value;
  return { id, username, role, active, mfaEnabled, revision, createdAt, updatedAt };
}

export function readUserPage(value, { limit, offset }) {
  try {
    if (!object(value) || value.limit !== limit || value.offset !== offset || !integer(value.total)
      || !Array.isArray(value.users) || value.users.length !== Math.max(0, Math.min(limit, value.total - offset))) throw new Error();
    const users = value.users.map(readAdminUser);
    if (new Set(users.map((user) => user.id)).size !== users.length) throw new Error();
    return { users, total: value.total, offset, limit };
  } catch { throw problem('user_page_invalid'); }
}

export function userAdminInput(form, user = null) {
  const username = typeof form.username === 'string' ? form.username.trim().toLowerCase() : '';
  if (!USERNAME.test(username)) throw problem('invalid_username');
  if (!['owner', 'read_only'].includes(form.role)) throw problem('invalid_role');
  if (typeof form.active !== 'boolean') throw problem('invalid_active');
  const input = { username, role: form.role, active: form.active };
  if (user) {
    if (!integer(user.revision, 1)) throw problem('invalid_revision');
    return { ...input, revision: user.revision };
  }
  if (typeof form.password !== 'string' || [...form.password].length < 12 || new TextEncoder().encode(form.password).length > 1024) throw problem('invalid_password');
  return { ...input, password: form.password };
}

export const emptyUserPage = () => ({ status: 'loading', data: null, error: null });

/** Component-owned client. No persistent credential/user cache, auto-retry or timers.
 * Request sequence + session generation reject late results even when abort is ignored.
 */
export function createUserAdminClient({ request, generation, onPage, onAccessLost }) {
  let disposed = false; let sequence = 0; let reader = null; let writer = null;
  const live = (stamp) => !disposed && generation() === stamp;
  function accessLost(error) {
    reader?.abort(); sequence += 1;
    onPage({ status: 'error', data: null, error });
    onAccessLost();
  }
  return {
    async load({ offset = 0, limit = 25 } = {}) {
      if (disposed || writer) return;
      reader?.abort(); const controller = new AbortController(); reader = controller;
      const current = ++sequence; const stamp = generation();
      const valid = () => live(stamp) && !controller.signal.aborted && current === sequence;
      onPage(emptyUserPage());
      try {
        const result = await request(`/users?limit=${limit}&offset=${offset}`, { signal: controller.signal });
        if (valid()) onPage({ status: 'ready', data: readUserPage(result, { limit, offset }), error: null });
      } catch (error) {
        if (!valid() || error.name === 'AbortError') return;
        if (denied(error)) accessLost(error);
        else onPage({ status: 'error', data: null, error });
      }
    },
    async mutate({ method, id, body }) {
      if (disposed) throw obsolete();
      if (writer) throw problem('user_request_busy');
      if (!['POST', 'PATCH', 'DELETE'].includes(method) || (method !== 'POST' && (typeof id !== 'string' || !ID.test(id)))) throw problem('user_result_invalid');
      const controller = new AbortController(); writer = controller; const stamp = generation();
      reader?.abort(); sequence += 1; onPage(emptyUserPage());
      try {
        const result = await request(method === 'POST' ? '/users' : `/users/${encodeURIComponent(id)}`, { method, body, signal: controller.signal });
        if (!live(stamp) || controller.signal.aborted) throw obsolete();
        if (!object(result) || typeof result.sessionRevoked !== 'boolean') throw problem('user_result_invalid');
        const value = { sessionRevoked: result.sessionRevoked };
        if (method === 'DELETE') {
          if (result.deleted !== true) throw problem('user_result_invalid');
          value.deleted = true;
        } else {
          value.user = readAdminUser(result.user);
          if ((method === 'PATCH' && value.user.id !== id) || (method === 'POST' && value.sessionRevoked)) throw problem('user_result_invalid');
        }
        if (value.sessionRevoked) accessLost(problem('unauthorized'));
        return value;
      } catch (error) {
        if (!live(stamp) || controller.signal.aborted) throw obsolete();
        if (denied(error)) accessLost(error);
        else onPage({ status: 'error', data: null, error });
        // A transport/invalid response is not proof that the server did nothing.
        // Require explicit reconciliation rather than retrying a possible create.
        if (error.name !== 'AbortError' && (!error.status || error.status >= 500)) error.reconcile = true;
        throw error;
      } finally { if (writer === controller) writer = null; }
    },
    dispose() { disposed = true; sequence += 1; reader?.abort(); writer?.abort(); },
  };
}
