import { PHP_TOOL_PATHS, PhpToolsError, phpToolsScope, phpToolsStatus, phpToolsErrorMessage } from './php-tools-model.js';
const empty = () => Object.freeze({ data: null, loading: false, fresh: false, error: null });

// Read-only status adapter. No command submission or background polling.
export function createPhpToolsClient({ scope: input, request, isCurrent = () => true }) {
  const scope = phpToolsScope(input), listeners = new Set();
  const sequences = { wordpress: 0, composer: 0 }, controllers = {};
  let active = true, state = Object.freeze({ denied: false, wordpress: empty(), composer: empty() });
  const current = () => active && isCurrent();
  function publish(patch) {
    if (!current()) return;
    state = Object.freeze({ ...state, ...patch });
    for (const listener of listeners) { try { listener(state); } catch { /* Do not retry a status command for a view error. */ } }
  }
  function section(tool, patch) { publish({ [tool]: Object.freeze({ ...state[tool], ...patch }) }); }
  function deny() {
    for (const tool of Object.keys(PHP_TOOL_PATHS)) { sequences[tool]++; controllers[tool]?.abort(); }
    const error = phpToolsErrorMessage({ code: 'php_tools_denied' });
    publish({ denied: true, wordpress: Object.freeze({ ...empty(), error }), composer: Object.freeze({ ...empty(), error }) });
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
      // Permission failures invalidate both channels, even when a newer read exists.
      if ([401, 403].includes(error?.status) || ['unauthorized', 'forbidden'].includes(error?.code)) deny();
      else if (sequence === sequences[tool]) section(tool, { fresh: false, error: phpToolsErrorMessage(error) });
      return false;
    } finally { if (current() && !state.denied && sequence === sequences[tool]) section(tool, { loading: false }); }
  }
  return Object.freeze({ getSnapshot: () => state, load, loadAll: () => Promise.all(Object.keys(PHP_TOOL_PATHS).map(load)),
    subscribe(listener) { listeners.add(listener); return () => listeners.delete(listener); },
    dispose() { active = false; for (const controller of Object.values(controllers)) controller.abort(); listeners.clear(); },
  });
}
