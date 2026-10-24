import { useRef } from 'react';
import { waitForJob } from '../api.js';
import { getMailDomain, previewMailConfiguration, applyMailConfiguration, getMailConfigurationRequest } from './mail-client.js';
import { createMailChangeController } from './mail-change-controller.js';

export function useMailChange(domainId) {
  const task = useRef(null), intent = useRef(null);
  const run = async (mutate, key = 'form') => {
    if (task.current?.saved && !task.current.completed && intent.current !== key) throw new Error('Önce bekleyen posta değişikliğini aynı düğmeyle tamamlayın.');
    intent.current = key;
    if (!task.current || task.current.completed) task.current = createMailChangeController({ domainId,
      getDomain: getMailDomain, preview: previewMailConfiguration, apply: applyMailConfiguration,
      getRequest: getMailConfigurationRequest, waitForJob, requestId: crypto.randomUUID() });
    return task.current.run(mutate);
  };
  run.pending = Boolean(task.current?.saved && !task.current.completed);
  return run;
}
