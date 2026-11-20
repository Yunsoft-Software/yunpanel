import { useRef } from 'react';
import { waitForJob } from '../api.js';
import { sessionVersion } from '../session-client.js';
import { getMailDomain, previewMailConfiguration, applyMailConfiguration, getMailConfigurationRequest } from './mail-client.js';
import { createMailChangeController } from './mail-change-controller.js';

export function useMailChange(domainId) {
  const task = useRef(null), intent = useRef(null);
  const run = async (mutate, key = 'form', { signal } = {}) => {
    if (task.current?.saved && !task.current.completed && intent.current !== key) throw new Error('Önce bekleyen posta değişikliğini aynı düğmeyle tamamlayın.');
    const version = sessionVersion();
    const withinScope = (request) => signal ? (...args) => {
      signal.throwIfAborted();
      if (version !== sessionVersion()) throw new DOMException('The request belongs to an obsolete session.', 'AbortError');
      return request(...args, { signal });
    } : request;
    intent.current = key;
    if (!task.current || task.current.completed) task.current = createMailChangeController({ domainId,
      getDomain: withinScope(getMailDomain), preview: withinScope(previewMailConfiguration),
      apply: withinScope(applyMailConfiguration), getRequest: withinScope(getMailConfigurationRequest),
      waitForJob: withinScope(waitForJob), requestId: crypto.randomUUID() });
    return task.current.run(withinScope(mutate));
  };
  run.pending = Boolean(task.current?.saved && !task.current.completed);
  return run;
}
