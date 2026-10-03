import { siteBackupBrowser, siteBackupErrorMessage, siteBackupScope, siteBackupOperation, siteBackupPreview } from './site-backup-model.js';

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

  async function previewBackup(repositoryId) {
    const path = '/websites/' + encodeURIComponent(scope.websiteId) + '/backup/preview';
    const response = await request(path, {
      method: 'POST',
      body: { repositoryId },
    });
    return siteBackupPreview(response?.data ?? response);
  }

  async function queueBackup({ repositoryId, expectedPreviewDigest, confirmation, tags = [] }) {
    const path = '/websites/' + encodeURIComponent(scope.websiteId) + '/backup-operations';
    const response = await request(path, {
      method: 'POST',
      body: {
        kind: 'backup',
        repositoryId,
        expectedPreviewDigest,
        confirmation,
        tags,
      },
    });
    return siteBackupOperation(response?.data ?? response);
  }

  async function previewRestore({ repositoryId, snapshotId, healthPath = '/health', timeoutSeconds = 30, include = [] }) {
    const path = '/websites/' + encodeURIComponent(scope.websiteId) + '/restore/preview';
    const response = await request(path, {
      method: 'POST',
      body: { repositoryId, snapshotId, healthPath, timeoutSeconds, include },
    });
    return siteBackupPreview(response?.data ?? response);
  }

  async function queueRestore({ repositoryId, snapshotId, expectedPreviewDigest, confirmation, healthPath = '/health', timeoutSeconds = 30, include = [] }) {
    const path = '/websites/' + encodeURIComponent(scope.websiteId) + '/backup-operations';
    const response = await request(path, {
      method: 'POST',
      body: {
        kind: 'restore',
        repositoryId,
        snapshotId,
        expectedPreviewDigest,
        confirmation,
        healthPath,
        timeoutSeconds,
        include,
      },
    });
    return siteBackupOperation(response?.data ?? response);
  }

  async function queueCheck({ repositoryId, readDataSubset = null } = {}) {
    const path = '/websites/' + encodeURIComponent(scope.websiteId) + '/backup-operations';
    const response = await request(path, {
      method: 'POST',
      body: {
        kind: 'check',
        repositoryId,
        readDataSubset,
      },
    });
    return siteBackupOperation(response?.data ?? response);
  }

  async function queuePlan({ repositoryId, schedule, retentionPolicy } = {}) {
    const path = '/websites/' + encodeURIComponent(scope.websiteId) + '/backup-operations';
    const response = await request(path, {
      method: 'POST',
      body: {
        kind: 'plan',
        repositoryId,
        schedule,
        retentionPolicy,
      },
    });
    return siteBackupOperation(response?.data ?? response);
  }

  async function getOperation(operationId) {
    const path = '/websites/' + encodeURIComponent(scope.websiteId) + '/backup-operations/' + encodeURIComponent(operationId);
    const response = await request(path);
    return siteBackupOperation(response?.data ?? response);
  }

  async function listOperations() {
    const path = '/websites/' + encodeURIComponent(scope.websiteId) + '/backup-operations';
    const response = await request(path);
    const items = Array.isArray(response?.data) ? response.data : Array.isArray(response) ? response : [];
    return items.map(siteBackupOperation);
  }

  return Object.freeze({
    getSnapshot: () => state,
    load,
    previewBackup,
    queueBackup,
    previewRestore,
    queueRestore,
    queueCheck,
    queuePlan,
    getOperation,
    listOperations,
    subscribe(listener) { listeners.add(listener); return () => listeners.delete(listener); },
    dispose() { active = false; ++sequence; controller?.abort(); listeners.clear(); },
  });
}
