import { useRef } from 'react';
import { waitForJob } from '../api.js';
import { sessionVersion } from '../session-client.js';
import { getMailDomain, previewMailConfiguration, applyMailConfiguration, getMailConfigurationRequest } from './mail-client.js';
import { createMailChangeController } from './mail-change-controller.js';

const RESETTABLE_APPLY_CODES = new Set([
  'mail_configuration_preview_stale',
  'mail_domain_revision_conflict',
  'mail_configuration_delivery_policy_mismatch',
  'mail_configuration_account_mismatch',
  'mail_configuration_forwarding_mismatch',
]);

function shouldDiscardController(error) {
  if (!error?.saved) return false;
  const cause = error.cause ?? error;
  const code = error.code ?? cause?.code;
  if (RESETTABLE_APPLY_CODES.has(code)) return true;
  const jobStatus = cause?.job?.status ?? error.job?.status;
  return jobStatus === 'failed' || jobStatus === 'cancelled';
}

export function useMailChange(domainId) {
  const task = useRef(null);
  const intent = useRef(null);
  const pendingReapply = useRef(false);
  const currentDomainId = useRef(domainId);
  const latestSignal = useRef(undefined);
  const latestVersion = useRef(sessionVersion());

  if (currentDomainId.current !== domainId) {
    currentDomainId.current = domainId;
    task.current = null;
    intent.current = null;
    pendingReapply.current = false;
  }

  const withinScope = (request) => (...args) => {
    const signal = latestSignal.current;
    if (!signal) return request(...args);
    signal.throwIfAborted();
    if (latestVersion.current !== sessionVersion()) {
      throw new DOMException('The request belongs to an obsolete session.', 'AbortError');
    }
    return request(...args, { signal });
  };

  function createController() {
    return createMailChangeController({
      domainId,
      getDomain: withinScope(getMailDomain),
      preview: withinScope(previewMailConfiguration),
      apply: withinScope(applyMailConfiguration),
      getRequest: withinScope(getMailConfigurationRequest),
      waitForJob: withinScope(waitForJob),
      requestId: crypto.randomUUID(),
    });
  }

  async function execute(mutate, key, { signal } = {}, { forceNoOp = false } = {}) {
    const hasPending = Boolean((task.current?.saved && !task.current.completed) || pendingReapply.current);
    if (hasPending && intent.current !== key) {
      throw new Error('Önce bekleyen posta değişikliğini aynı düğmeyle tamamlayın.');
    }
    latestSignal.current = signal;
    latestVersion.current = sessionVersion();
    intent.current = key;

    const reuseReapply = forceNoOp || (!task.current && pendingReapply.current);
    if (!task.current || task.current.completed) {
      task.current = createController();
    }
    const effectiveMutate = reuseReapply ? async () => null : mutate;
    try {
      const value = await task.current.run(withinScope(effectiveMutate));
      pendingReapply.current = false;
      return value;
    } catch (error) {
      if (shouldDiscardController(error)) {
        task.current = null;
        pendingReapply.current = true;
      }
      throw error;
    }
  }

  const run = (mutate, key = 'form', options = {}) => execute(mutate, key, options);
  run.reapply = (key = 'form', options = {}) => execute(async () => null, key, options, { forceNoOp: true });
  run.reset = () => {
    task.current = null;
    intent.current = null;
    pendingReapply.current = false;
  };
  run.pending = Boolean((task.current?.saved && !task.current.completed) || pendingReapply.current);
  return run;
}
