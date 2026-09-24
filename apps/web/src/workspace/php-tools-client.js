import {
  PHP_TOOL_PATHS, PhpToolsError, phpToolsScope, phpToolsStatus, phpToolsErrorMessage,
  phpToolActionPreview, phpToolActionJob, phpToolQueueResult,
} from './php-tools-model.js';
const empty = () => Object.freeze({ data: null, loading: false, fresh: false, error: null });
const emptyAction = () => Object.freeze({ preview: null, job: null, actionId: null, busy: false, error: null });

// Status + reviewed mutation adapter. It never retries a POST automatically.
export function createPhpToolsClient({ scope: input, request, isCurrent = () => true, onJob = () => {} }) {
  const scope = phpToolsScope(input), listeners = new Set();
  const sequences = { wordpress: 0, composer: 0 }, controllers = {};
  let active = true, state = Object.freeze({ denied: false, wordpress: empty(), composer: empty(), action: emptyAction() });
  const current = () => active && isCurrent();
  function publish(patch) {
    if (!current()) return;
    state = Object.freeze({ ...state, ...patch });
    for (const listener of listeners) { try { listener(state); } catch { /* View errors never replay a request. */ } }
  }
  function section(tool, patch) { publish({ [tool]: Object.freeze({ ...state[tool], ...patch }) }); }
  function action(patch) { publish({ action: Object.freeze({ ...state.action, ...patch }) }); }
  function deny() {
    for (const tool of Object.keys(PHP_TOOL_PATHS)) { sequences[tool]++; controllers[tool]?.abort(); }
    const error = phpToolsErrorMessage({ code: 'php_tools_denied' });
    publish({ denied: true, wordpress: Object.freeze({ ...empty(), error }), composer: Object.freeze({ ...empty(), error }),
      action: Object.freeze({ ...emptyAction(), error }) });
  }
  function report(error, actionChannel = false) {
    if (!current()) return;
    if ([401, 403].includes(error?.status) || ['unauthorized', 'forbidden'].includes(error?.code)) deny();
    else if (actionChannel) action({ error: phpToolsErrorMessage(error) });
  }
  async function load(tool) {
    if (!Object.hasOwn(PHP_TOOL_PATHS, tool)) throw new PhpToolsError();
    if (!current() || state.denied) return false;
    const sequence = ++sequences[tool];
    controllers[tool]?.abort();
    const controller = new AbortController(); controllers[tool] = controller;
    section(tool, { loading: true, fresh: false, error: null });
    try {
      const value = await request(`/websites/${encodeURIComponent(scope.websiteId)}/${PHP_TOOL_PATHS[tool]}`, { signal: controller.signal });
      if (!current() || state.denied || sequence !== sequences[tool]) return false;
      section(tool, { data: phpToolsStatus(tool, value, scope), fresh: true });
      return true;
    } catch (error) {
      if (!current() || state.denied) return false;
      if ([401, 403].includes(error?.status) || ['unauthorized', 'forbidden'].includes(error?.code)) deny();
      else if (sequence === sequences[tool]) section(tool, { fresh: false, error: phpToolsErrorMessage(error) });
      return false;
    } finally { if (current() && !state.denied && sequence === sequences[tool]) section(tool, { loading: false }); }
  }
  async function prepareAction(actionId) {
    if (!current() || state.denied || state.action.busy) return null;
    action({ busy: true, error: null, preview: null });
    try {
      const value = await request(`/websites/${encodeURIComponent(scope.websiteId)}/actions/preview`, {
        method: 'POST', body: { actionId },
      });
      if (!current() || state.denied) return null;
      const preview = phpToolActionPreview(value, scope, actionId);
      action({ preview });
      return preview;
    } catch (error) { report(error, true); return null; }
    finally { if (current() && !state.denied) action({ busy: false }); }
  }
  async function queueAction() {
    const preview = state.action.preview;
    if (!current() || state.denied || state.action.busy || !preview) return null;
    action({ busy: true, error: null });
    let sent = false;
    try {
      sent = true;
      const value = await request(`/websites/${encodeURIComponent(scope.websiteId)}/actions/queue`, {
        method: 'POST',
        body: {
          actionId: preview.actionId,
          expectedWebsiteRevision: preview.websiteRevision,
          previewDigest: preview.previewDigest,
          confirmation: preview.confirmation,
        },
      });
      if (!current() || state.denied) return null;
      const queued = phpToolQueueResult(value, scope, preview);
      action({ preview: null, job: queued.job, actionId: queued.action.actionId });
      try { onJob(queued.job, true); } catch {}
      return queued.job;
    } catch (error) {
      if (sent && current() && ![400, 401, 403, 409].includes(error?.status)) {
        action({ preview: null, error: 'İsteğin sonucu bilinmiyor. Aynı işlemi tekrar göndermeden önce İşlem Geçmişi’ni kontrol edin.' });
      } else report(error, true);
      return null;
    } finally { if (current() && !state.denied) action({ busy: false }); }
  }
  async function refreshAction() {
    const known = state.action.job;
    if (!current() || state.denied || state.action.busy || !known || ['succeeded', 'failed', 'cancelled'].includes(known.status)) return known;
    action({ busy: true, error: null });
    try {
      const value = await request(`/jobs/${encodeURIComponent(known.id)}`);
      if (!current() || state.denied) return null;
      const job = phpToolActionJob(value, scope, state.action.actionId, known.id);
      action({ job });
      try { onJob(job, false); } catch {}
      if (job.status === 'succeeded') await Promise.all([load('wordpress'), load('composer')]);
      return job;
    } catch (error) { report(error, true); return null; }
    finally { if (current() && !state.denied) action({ busy: false }); }
  }
  return Object.freeze({
    getSnapshot: () => state, load, loadAll: () => Promise.all(Object.keys(PHP_TOOL_PATHS).map(load)),
    prepareAction, queueAction, refreshAction, dismissPreview: () => action({ preview: null, error: null }),
    subscribe(listener) { listeners.add(listener); return () => listeners.delete(listener); },
    dispose() { active = false; for (const controller of Object.values(controllers)) controller.abort(); listeners.clear(); },
  });
}
