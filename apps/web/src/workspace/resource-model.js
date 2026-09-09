export const initialCollection = () => ({ items: [], status: 'loading', error: null, updatedAt: null });

export function collectionError(error) {
  if (error?.status === 401) return { kind: 'unauthorized', message: 'Oturumunuz sona erdi. Yeniden giriş yapın.' };
  if (error?.status === 403) return { kind: 'forbidden', message: error.code === 'mfa_enrollment_required' ? 'Yönetim için doğrulayıcı kurulumunu tamamlayın.' : 'Bu verilere erişim yetkiniz yok.' };
  if (error?.status === 404) return { kind: 'unsupported', message: 'Bu veri uç noktası mevcut API sürümünde bulunmuyor.' };
  if (error?.status === 409) return { kind: 'conflict', message: 'Kaynak değişti veya başka bir işlem sürüyor. Verileri yenileyin.' };
  return { kind: 'error', message: 'Veriler alınamadı. Bağlantıyı ve API durumunu kontrol edin.' };
}

export function collectionReducer(state, action) {
  if (action.type === 'success') {
    if (!Array.isArray(action.items)) return collectionReducer(state, { type: 'failure', error: new Error('Invalid collection') });
    return { items: action.items, status: 'ready', error: null, updatedAt: action.now ?? Date.now() };
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
