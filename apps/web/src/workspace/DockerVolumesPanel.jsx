import { useCallback, useEffect, useRef, useState } from 'react';
import {
  applyDockerVolumeDelete,
  getDockerProjectVolumes,
  previewDockerVolumeDelete,
} from './docker-compose-client.js';
import {
  Badge,
  Button,
  CollectionNotice,
  ConfirmDialog,
  EmptyState,
  ErrorNotice,
  Section,
} from './PanelKit.jsx';
import { useWorkspace } from './WorkspaceContext.jsx';

function scopeLabel(scope) {
  if (scope === 'external') return 'Harici';
  return 'Proje';
}

function volumeStatus(item) {
  if (item?.present === false) return { state: 'offline', label: 'Yok' };
  if (item?.deletable === true) return { state: 'active', label: 'Silinebilir' };
  if (Number(item?.containerCount ?? 0) > 0) return { state: 'warning', label: 'Kullanımda' };
  return { state: 'error', label: 'Engelli' };
}

function volumeBlockReason(item) {
  if (item?.deletable === true) return 'Silmeye uygun';
  if (typeof item?.blockReason === 'string' && item.blockReason.trim()) return item.blockReason.trim();
  if (item?.scope === 'external') return 'Harici volume bu projeden silinemez.';
  if (item?.present === false) return 'Volume sunucuda mevcut değil.';
  if (Number(item?.containerCount ?? 0) > 0) return 'Volume bir veya daha fazla konteynere bağlı.';
  if (Number(item?.crossProjectRefCount ?? 0) > 0) return 'Volume başka bir projede tanımlı.';
  if (item?.composeLabelsVerified === false) return 'Volume proje etiketleri doğrulanamadı.';
  return 'Bu volume şu anda silinemez.';
}

function buildDeleteMessage(preview) {
  const name = preview?.volumeName || preview?.volumeKey || 'Seçili volume';
  return `${name} adlı volume kalıcı olarak silinecek. Bu işlem geri alınamaz ve içindeki tüm veriler tamamen kaybolur.`;
}

function isDeleteLocked({ busy, jobsStatus, projectBusy }) {
  return Boolean(busy || jobsStatus !== 'ready' || projectBusy);
}

function useVolumeInventory(projectId, projectRevision, { enabled, initialData }) {
  const [state, setState] = useState(() => (
    initialData !== null && initialData !== undefined
      ? { status: 'ready', data: initialData, error: null, updatedAt: Date.now() }
      : { status: enabled ? 'loading' : 'disabled', data: null, error: null, updatedAt: null }
  ));
  const [reloadCount, setReloadCount] = useState(0);
  const refresh = useCallback(() => setReloadCount((value) => value + 1), []);

  useEffect(() => {
    if (!enabled || !projectId) {
      setState({ status: 'disabled', data: null, error: null, updatedAt: null });
      return undefined;
    }
    if (initialData !== null && initialData !== undefined && reloadCount === 0) {
      return undefined;
    }
    const controller = new AbortController();
    setState((current) => ({
      ...current,
      status: current.data ? 'stale' : 'loading',
      error: null,
    }));
    Promise.resolve(getDockerProjectVolumes(projectId, { signal: controller.signal }))
      .then((data) => {
        if (!controller.signal.aborted) {
          setState({ status: 'ready', data, error: null, updatedAt: Date.now() });
        }
      })
      .catch((error) => {
        if (!controller.signal.aborted && error?.name !== 'AbortError') {
          setState((current) => ({
            status: current.data ? 'stale' : 'error',
            data: current.data,
            error,
            updatedAt: current.updatedAt,
          }));
        }
      });
    return () => controller.abort();
  }, [enabled, projectId, projectRevision, reloadCount, initialData]);

  return { ...state, refresh };
}

export default function DockerVolumesPanel({ project, onChanged, initialData = null }) {
  const { isOwner, observe, jobs, resourceBusy, setNotice } = useWorkspace();
  const projectId = project?.id ?? '';
  const projectRevision = project?.revision ?? 0;
  const volumes = useVolumeInventory(projectId, projectRevision, {
    enabled: Boolean(isOwner && projectId),
    initialData,
  });
  const [pending, setPending] = useState(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);
  const inFlight = useRef(false);
  const projectBusy = Boolean(projectId && typeof resourceBusy === 'function' && resourceBusy('docker_project', projectId));
  const wasProjectBusy = useRef(projectBusy);

  useEffect(() => {
    setPending(null);
    setError(null);
  }, [projectId, projectRevision]);

  useEffect(() => {
    if (wasProjectBusy.current && !projectBusy && isOwner && projectId) {
      volumes.refresh();
    }
    wasProjectBusy.current = projectBusy;
  }, [projectBusy, isOwner, projectId, volumes.refresh]);

  if (!isOwner || !project) return null;

  const locked = isDeleteLocked({ busy, jobsStatus: jobs?.status, projectBusy });
  const items = Array.isArray(volumes.data?.volumes) ? volumes.data.volumes : [];

  async function requestPreview(item) {
    if (inFlight.current || locked || item?.deletable !== true) return;
    inFlight.current = true;
    setBusy(true);
    setError(null);
    try {
      const preview = await previewDockerVolumeDelete(project.id, item.volumeKey);
      setPending({ volumeKey: item.volumeKey, preview });
    } catch (failure) {
      if (failure?.name !== 'AbortError') setError(failure?.message ?? 'Volume silme önizlemesi alınamadı.');
    } finally {
      inFlight.current = false;
      setBusy(false);
    }
  }

  async function confirmDelete() {
    if (inFlight.current || !pending) return;
    inFlight.current = true;
    setBusy(true);
    setError(null);
    try {
      const result = await applyDockerVolumeDelete(project.id, {
        volumeKey: pending.volumeKey,
        preview: pending.preview,
      });
      if (result?.job) observe(result.job);
      setNotice(`${project.projectName}: ${pending.preview.volumeName || pending.volumeKey} volume silme işi sıraya alındı.`);
      setPending(null);
      jobs?.refresh?.();
      volumes.refresh();
      onChanged?.();
    } catch (failure) {
      if (failure?.name !== 'AbortError') setError(failure?.message ?? 'Volume silme işi başlatılamadı.');
    } finally {
      inFlight.current = false;
      setBusy(false);
    }
  }

  return <>
    <Section
      title="Kalıcı volume yönetimi"
      description="Yalnız bu projeye ait ve hiçbir konteynere bağlı olmayan tekil volume kayıtlarını kalıcı olarak silebilirsiniz."
      actions={<Button icon="refresh" disabled={busy} onClick={volumes.refresh}>Yenile</Button>}
    >
      <CollectionNotice resource={volumes} label="Proje volume listesi" />
      {error && !pending && <div className="ws-section-body"><ErrorNotice error={error} /></div>}
      {items.length > 0 ? (
        <div className="ws-table-scroll">
          <table className="ws-table">
            <thead>
              <tr>
                <th>Volume</th>
                <th>Kapsam</th>
                <th>Durum</th>
                <th>Konteyner</th>
                <th>Açıklama</th>
                <th />
              </tr>
            </thead>
            <tbody>
              {items.map((item) => {
                const status = volumeStatus(item);
                const containerCount = Number(item.containerCount ?? 0);
                const containerNames = Array.isArray(item.containers)
                  ? item.containers.map((entry) => entry?.name || entry?.id).filter(Boolean)
                  : [];
                return (
                  <tr key={`${item.volumeKey}:${item.volumeName}`}>
                    <td>
                      <strong>{item.volumeKey}</strong>
                      <small><code>{item.volumeName}</code></small>
                    </td>
                    <td>{scopeLabel(item.scope)}</td>
                    <td><Badge state={status.state}>{status.label}</Badge></td>
                    <td>
                      <span>{containerCount}</span>
                      {containerNames.length > 0 && <small>{containerNames.join(', ')}</small>}
                    </td>
                    <td>{volumeBlockReason(item)}</td>
                    <td>
                      {item.deletable === true ? (
                        <Button
                          variant="danger"
                          icon="trash"
                          disabled={locked}
                          onClick={() => requestPreview(item)}
                        >
                          Sil
                        </Button>
                      ) : (
                        <span className="ws-muted">—</span>
                      )}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      ) : volumes.status === 'ready' && (
        <EmptyState
          icon="archive"
          title="Kayıtlı volume bulunamadı"
          detail="Bu projede yönetilebilir kalıcı volume kaydı yer almıyor."
        />
      )}
    </Section>
    {pending && (
      <ConfirmDialog
        title="Volume kaydını kalıcı olarak sil"
        message={buildDeleteMessage(pending.preview)}
        confirmation={pending.preview.confirmation}
        busy={busy}
        error={error}
        onCancel={() => {
          if (!busy) {
            setPending(null);
            setError(null);
          }
        }}
        onConfirm={confirmDelete}
        confirmLabel="Kalıcı olarak sil"
      />
    )}
  </>;
}

export const dockerVolumesPanelInternals = Object.freeze({
  scopeLabel,
  volumeStatus,
  volumeBlockReason,
  buildDeleteMessage,
  isDeleteLocked,
});
