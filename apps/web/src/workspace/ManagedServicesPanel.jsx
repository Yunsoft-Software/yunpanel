import { useCallback, useEffect, useRef, useState } from 'react';
import { getManagedServices, waitForJob } from '../api.js';
import { Badge, Button, ConfirmDialog, EmptyState, ErrorNotice, Section } from './PanelKit.jsx';
import { useWorkspace } from './WorkspaceContext.jsx';
import {
  managedServiceActions,
  managedServiceCategoryLabel,
  managedServiceStatus,
  managedServiceVersion,
} from './managed-service-model.js';
import { formatDate } from './site-model.js';

function actionCopy(selection) {
  if (!selection) return null;
  const label = selection.service.label ?? selection.service.id;
  if (selection.kind === 'install') {
    return {
      title: `${label} kurulsun mu?`,
      message: `${label} paketleri APT üzerinden kurulacak, systemd servisi etkinleştirilecek ve başlatılacak.`,
      confirmLabel: 'Kur ve başlat',
    };
  }
  if (selection.action === 'stop') {
    return {
      title: `${label} durdurulsun mu?`,
      message: `${label} durdurulduğunda bu servise bağlı web sitesi veya sistem özellikleri erişilemez olabilir.`,
      confirmLabel: 'Servisi durdur',
    };
  }
  if (selection.action === 'restart') {
    return {
      title: `${label} yeniden başlatılsın mı?`,
      message: `${label} yeniden başlatılırken kısa süreli servis kesintisi oluşabilir.`,
      confirmLabel: 'Yeniden başlat',
    };
  }
  return {
    title: `${label} başlatılsın mı?`,
    message: `${label} systemd üzerinden başlatılacak ve çalışan durum tekrar doğrulanacak.`,
    confirmLabel: 'Servisi başlat',
  };
}

export default function ManagedServicesPanel({ server }) {
  const { runJob, resourceBusy, updateJob } = useWorkspace();
  const generation = useRef(0);
  const pending = useRef(false);
  const [status, setStatus] = useState('loading');
  const [services, setServices] = useState(null);
  const [snapshot, setSnapshot] = useState(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);
  const [selection, setSelection] = useState(null);

  const loadSnapshot = useCallback(async () => {
    const request = ++generation.current;
    setStatus((current) => current === 'ready' ? 'refreshing' : 'loading');
    setError(null);
    try {
      const data = await getManagedServices(server.id);
      if (request !== generation.current) return;
      setServices(Array.isArray(data?.services) ? data.services : null);
      setSnapshot(data?.snapshot ?? null);
      setStatus('ready');
    } catch (failure) {
      if (request !== generation.current || failure.name === 'AbortError') return;
      setError(failure.message);
      setStatus('error');
    }
  }, [server.id]);

  useEffect(() => {
    void loadSnapshot();
    return () => { generation.current += 1; };
  }, [loadSnapshot]);

  async function runAndWait(path, body) {
    const queued = await runJob(path, body);
    const terminal = await waitForJob(queued.id);
    updateJob(terminal);
    return terminal;
  }

  async function inspectHost() {
    if (pending.current) return;
    pending.current = true;
    setBusy(true);
    setError(null);
    try {
      const terminal = await runAndWait(`/servers/${encodeURIComponent(server.id)}/services/inspect`, {});
      if (!Array.isArray(terminal.result)) throw new Error('Sunucu servis taraması geçerli bir sonuç döndürmedi.');
      setServices(terminal.result);
      setSnapshot({ jobId: terminal.id, refreshedAt: terminal.finishedAt ?? terminal.createdAt });
      setStatus('ready');
    } catch (failure) {
      if (failure.name !== 'AbortError') setError(failure.message);
    } finally {
      pending.current = false;
      setBusy(false);
    }
  }

  async function performSelection() {
    if (!selection || pending.current) return;
    const current = selection;
    pending.current = true;
    setBusy(true);
    setError(null);
    try {
      const serviceId = encodeURIComponent(current.service.id);
      const serverId = encodeURIComponent(server.id);
      const terminal = current.kind === 'install'
        ? await runAndWait(`/servers/${serverId}/services/${serviceId}/install`, { confirmation: `install:${current.service.id}` })
        : await runAndWait(`/servers/${serverId}/services/${serviceId}/control`, {
            action: current.action,
            confirmation: `control:${current.service.id}:${current.action}`,
          });
      if (!terminal.result || terminal.result.id !== current.service.id) throw new Error('Servis işlemi doğrulanmış bir durum döndürmedi.');
      setServices((existing) => Array.isArray(existing)
        ? existing.map((service) => service.id === terminal.result.id ? terminal.result : service)
        : existing);
      setSnapshot({ jobId: terminal.id, refreshedAt: terminal.finishedAt ?? terminal.createdAt });
      setSelection(null);
      setStatus('ready');
    } catch (failure) {
      if (failure.name !== 'AbortError') setError(failure.message);
    } finally {
      pending.current = false;
      setBusy(false);
    }
  }

  const systemBusy = busy || resourceBusy('system', server.id);
  const copy = actionCopy(selection);
  const title = `${server.displayName ?? server.name ?? server.hostname} · Sistem servisleri`;

  return <>
    <Section
      title={title}
      description={snapshot?.refreshedAt ? `Son doğrulama: ${formatDate(snapshot.refreshedAt)}` : 'Nginx, veritabanı, Docker, cron ve mail servislerini kurun ve yönetin.'}
      actions={<div className="ws-actions"><Button icon="refresh" disabled={systemBusy} onClick={loadSnapshot}>Kaydı yenile</Button><Button variant="primary" icon="refresh" disabled={systemBusy} onClick={inspectHost}>{busy ? 'İşlem sürüyor…' : 'Sunucuyu tara'}</Button></div>}
    >
      <ErrorNotice error={error} />
      {status === 'loading' && <div className="ws-loading" role="status"><span className="ws-spinner" />Servis durumu yükleniyor…</div>}
      {status !== 'loading' && !services && <EmptyState title="Henüz servis taraması yok" detail="Gerçek kurulum ve systemd durumlarını görmek için sunucuyu tarayın. Tarama bir YunPanel işi olarak çalışır." icon="server" action={<Button variant="primary" disabled={systemBusy} onClick={inspectHost}>Servisleri tara</Button>} />}
      {Array.isArray(services) && <div className="ws-table-scroll"><table className="ws-table"><thead><tr><th>Servis</th><th>Tür</th><th>Paket</th><th>Durum</th><th className="ws-row-end">İşlemler</th></tr></thead><tbody>{services.map((service) => {
        const serviceStatus = managedServiceStatus(service);
        const actions = managedServiceActions(service, services);
        const version = managedServiceVersion(service);
        return <tr key={service.id}><td><strong>{service.label ?? service.id}</strong><small>{service.units?.map((unit) => unit.unit).join(', ') ?? '—'}</small>{actions.conflict && <small>{actions.conflict}</small>}</td><td>{managedServiceCategoryLabel(service.category)}</td><td>{service.installed ? (version ?? 'Kurulu') : 'Kurulu değil'}</td><td><Badge state={serviceStatus.state}>{serviceStatus.label}</Badge></td><td className="ws-row-end"><div className="ws-actions" style={{ justifyContent: 'flex-end' }}>{actions.install && <Button variant="primary" disabled={systemBusy} onClick={() => setSelection({ kind: 'install', service })}>Kur</Button>}{actions.start && <Button disabled={systemBusy} onClick={() => setSelection({ kind: 'control', action: 'start', service })}>Başlat</Button>}{actions.restart && <Button disabled={systemBusy} onClick={() => setSelection({ kind: 'control', action: 'restart', service })}>Yeniden başlat</Button>}{actions.stop && <Button variant="danger" disabled={systemBusy} onClick={() => setSelection({ kind: 'control', action: 'stop', service })}>Durdur</Button>}</div></td></tr>;
      })}</tbody></table></div>}
    </Section>
    {selection && copy && <ConfirmDialog title={copy.title} message={copy.message} busy={busy} error={error} onCancel={() => { if (!busy) setSelection(null); }} onConfirm={performSelection} confirmLabel={copy.confirmLabel} />}
  </>;
}
