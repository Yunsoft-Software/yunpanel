import { siteBackupBrowser, siteBackupErrorMessage, siteBackupScope } from './site-backup-model.js';

export function createSiteBackupClient({ scope: input, request, isCurrent = () => true }) {
  const scope = siteBackupScope(input);
  const listeners = new Set();
  let active = true;
  let sequence = 0;
  let controller = null;
  let state = Object.freeze({ data: null, loading: false, fresh: false, denied: false, error: null });
  const current = () => active && isCurrent();
  function publish(patch) {
    if (!current()) return;
    state = Object.freeze({ ...state, ...patch });
    for (const listener of listeners) { try { listener(state); } catch {} }
  }
  async function load() {
    if (!current() || state.denied) return false;
    const currentSequence = ++sequence;
    controller?.abort();
    controller = new AbortController();
    publish({ loading: true, fresh: false, error: null });
    try {
      const path = '/websites/' + encodeURIComponent(scope.websiteId) + '/backups';
      const value = await request(path, { signal: controller.signal });
      if (!current() || currentSequence !== sequence) return false;
      publish({ data: siteBackupBrowser(value, scope), fresh: true });
      return true;
    } catch (error) {
      if (!current() || currentSequence !== sequence) return false;
      if ([401, 403].includes(error?.status) || ['unauthorized', 'forbidden', 'site_scope_forbidden'].includes(error?.code)) {
        publish({ data: null, denied: true, fresh: false, error: 'Oturum veya site yedek erişimi geçerli değil.' });
      } else {
        publish({ fresh: false, error: siteBackupErrorMessage(error) });
      }
      return false;
    } finally {
      if (current() && currentSequence === sequence) publish({ loading: false });
    }
  }
  return Object.freeze({
    getSnapshot: () => state,
    load,
    subscribe(listener) { listeners.add(listener); return () => listeners.delete(listener); },
    dispose() { active = false; ++sequence; controller?.abort(); listeners.clear(); },
  });
}
