export const initialCollection = () => ({ items: [], status: 'loading', error: null, updatedAt: null });

export function collectionError(error) {
  if (error?.status === 401) return { kind: 'unauthorized', message: 'Oturumunuz sona erdi. Yeniden giriş yapın.' };
  if (error?.status === 403) return { kind: 'forbidden', message: error.code === 'mfa_enrollment_required' ? 'Yönetim için doğrulayıcı kurulumunu tamamlayın.' : 'Bu verilere erişim yetkiniz yok.' };
  if (error?.status === 404) return { kind: 'unsupported', message: 'Bu veri uç noktası mevcut API sürümünde bulunmuyor.' };
  if (error?.status === 409) return { kind: 'conflict', message: 'Kaynak değişti veya başka bir işlem sürüyor. Verileri yenileyin.' };
  return { kind: 'error', message: 'Veriler alınamadı. Bağlantıyı ve API durumunu kontrol edin.' };
}

function mergeCollectionItem(existing, incoming) {
  if (!existing || typeof existing !== 'object') return incoming;
  if (!incoming || typeof incoming !== 'object') return incoming;

  // For certificates: guard against stale polls rolling back validTo, lastRenewedAt, or state
  if (existing.validTo && incoming.validTo) {
    const existingTo = Date.parse(existing.validTo);
    const incomingTo = Date.parse(incoming.validTo);
    if (Number.isFinite(existingTo) && Number.isFinite(incomingTo) && existingTo > incomingTo) {
      return {
        ...incoming,
        validTo: existing.validTo,
        validFrom: existing.validFrom ?? incoming.validFrom,
        fingerprint256: existing.fingerprint256 ?? incoming.fingerprint256,
        lastRenewedAt: existing.lastRenewedAt ?? incoming.lastRenewedAt,
        state: existing.state === 'active' ? 'active' : incoming.state,
        updatedAt: existing.updatedAt && incoming.updatedAt && Date.parse(existing.updatedAt) > Date.parse(incoming.updatedAt)
          ? existing.updatedAt
          : incoming.updatedAt,
      };
    }
  }

  if (existing.lastRenewedAt && incoming.lastRenewedAt) {
    const existingRenewed = Date.parse(existing.lastRenewedAt);
    const incomingRenewed = Date.parse(incoming.lastRenewedAt);
    if (Number.isFinite(existingRenewed) && Number.isFinite(incomingRenewed) && existingRenewed > incomingRenewed) {
      return {
        ...incoming,
        lastRenewedAt: existing.lastRenewedAt,
        validTo: existing.validTo ?? incoming.validTo,
        validFrom: existing.validFrom ?? incoming.validFrom,
        fingerprint256: existing.fingerprint256 ?? incoming.fingerprint256,
        state: existing.state === 'active' ? 'active' : incoming.state,
      };
    }
  }

  if (existing.state === 'active' && incoming.state === 'renewing' && existing.validTo) {
    return {
      ...incoming,
      state: 'active',
      validTo: existing.validTo,
      validFrom: existing.validFrom ?? incoming.validFrom,
      fingerprint256: existing.fingerprint256 ?? incoming.fingerprint256,
      lastRenewedAt: existing.lastRenewedAt ?? incoming.lastRenewedAt,
    };
  }

  // For domains: do not allow an older desiredRevision from a delayed poll to overwrite newer domain state
  if (Number.isSafeInteger(existing.desiredRevision) && Number.isSafeInteger(incoming.desiredRevision)) {
    if (existing.desiredRevision > incoming.desiredRevision) {
      return existing;
    }
  }

  // For domains: do not allow a stale poll with null certificateId to erase an existing certificateId
  if (existing.certificateId && !incoming.certificateId && existing.id === incoming.id) {
    if (!incoming.desiredRevision || incoming.desiredRevision <= (existing.desiredRevision ?? 0)) {
      return { ...incoming, certificateId: existing.certificateId };
    }
  }

  return incoming;
}

export function collectionReducer(state, action) {
  if (action.type === 'success') {
    if (!Array.isArray(action.items)) return collectionReducer(state, { type: 'failure', error: new Error('Invalid collection') });
    const existingById = new Map((state.items || []).filter((it) => it && it.id).map((it) => [it.id, it]));
    const items = action.items.map((incoming) => {
      if (incoming && incoming.id && existingById.has(incoming.id)) {
        return mergeCollectionItem(existingById.get(incoming.id), incoming);
      }
      return incoming;
    });
    return { items, status: 'ready', error: null, updatedAt: action.now ?? Date.now() };
  }
  if (action.type === 'failure') {
    if (action.error?.name === 'AbortError') return state;
    const error = collectionError(action.error);
    // Retain stale data on transport failure, never after an access denial.
    const clear = ['unauthorized', 'forbidden', 'unsupported'].includes(error.kind);
    return { ...state, items: clear ? [] : state.items, status: !clear && state.updatedAt !== null ? 'stale' : error.kind, error };
  }
  return state;
}

export function knownCount(collection, predicate = () => true) {
  return collection.status === 'ready' || collection.status === 'stale' ? collection.items.filter(predicate).length : null;
}
