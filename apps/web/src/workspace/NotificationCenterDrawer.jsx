import { useEffect, useMemo, useState } from 'react';
import { useWorkspace } from './WorkspaceContext.jsx';
import { Badge, Button, EmptyState, Icon, LinkButton } from './PanelKit.jsx';
import { certificateState, formatDate, jobActive, siteHref } from './site-model.js';
import { usagePercent } from './ui/console-model.js';

function collectionItems(resource) {
  if (Array.isArray(resource)) return resource;
  if (Array.isArray(resource?.items)) return resource.items;
  return [];
}

export function computeWorkspaceAlerts({ domains, websites, certificates, servers, jobs } = {}) {
  const alerts = [];
  const domainItems = collectionItems(domains);
  const websiteItems = collectionItems(websites);
  const certItems = collectionItems(certificates);
  const serverItems = collectionItems(servers);
  const jobItems = collectionItems(jobs);

  for (const domain of domainItems) {
    if (!domain) continue;
    const linkedCert = !domain.certificateId
      ? certItems.find((item) => item?.domainId === domain.id || (domain.primaryDomain && item?.primaryDomain === domain.primaryDomain))
      : null;
    const normalizedDomain = linkedCert ? { ...domain, certificateId: linkedCert.id } : domain;
    const normalizedCerts = certItems.map((item) => (
      item && !item.validTo && item.expiresAt ? { ...item, state: item.state === 'expired' ? 'active' : (item.state ?? 'active'), validTo: item.expiresAt } : item
    ));
    const ssl = certificateState(normalizedDomain, normalizedCerts);
    const sslState = typeof ssl === 'string' ? ssl : ssl?.state;
    if (['warning', 'expired', 'error', 'none', 'off'].includes(sslState)) {
      const isCritical = ['expired', 'error'].includes(sslState);
      alerts.push({
        id: `ssl-${domain.id}`,
        category: 'ssl',
        severity: isCritical ? 'critical' : 'warning',
        severityLabel: isCritical ? 'Kritik' : 'Uyarı',
        badgeState: isCritical ? 'failed' : 'warning',
        title: `SSL · ${domain.primaryDomain ?? domain.domain ?? domain.id}`,
        detail: ssl?.label ?? 'SSL sertifika durumu kontrol edilmeli.',
        href: siteHref(domain.id, 'ssl'),
        actionLabel: 'SSL’i incele',
      });
    }
  }

  for (const server of serverItems) {
    if (!server) continue;
    const serverName = server.displayName ?? server.name ?? server.hostname ?? 'Sunucu';
    if (server.connectivity && server.connectivity !== 'online') {
      alerts.push({
        id: `server-connectivity-${server.id ?? serverName}`,
        category: 'server',
        severity: 'critical',
        severityLabel: 'Kritik',
        badgeState: 'failed',
        title: `Sunucu bağlantısı · ${serverName}`,
        detail: `Sunucu erişim durumu: ${server.connectivity}`,
        href: '/servers',
        actionLabel: 'Sunucuyu incele',
      });
    }
    const inventory = server.inventory ?? {};
    const cpuUsage = inventory.cpu?.usagePercent ?? server.cpuPercent ?? null;
    if (Number.isFinite(cpuUsage) && cpuUsage >= 85) {
      const isCritical = cpuUsage >= 90;
      alerts.push({
        id: `server-cpu-${server.id ?? serverName}`,
        category: 'server',
        severity: isCritical ? 'critical' : 'warning',
        severityLabel: isCritical ? 'Kritik' : 'Uyarı',
        badgeState: isCritical ? 'failed' : 'warning',
        title: `Yüksek CPU kullanımı · %${Math.round(cpuUsage)}`,
        detail: `${serverName} üzerinde işlemci kullanımı %${Math.round(cpuUsage)} seviyesinde.`,
        href: '/servers',
        actionLabel: 'Sunucuyu incele',
      });
    }
    const memory = inventory.memory ?? {};
    const memoryUsage = usagePercent(memory.usedBytes, memory.totalBytes) ?? memory.usagePercent ?? server.memoryPercent ?? null;
    if (Number.isFinite(memoryUsage) && memoryUsage >= 85) {
      const isCritical = memoryUsage >= 90;
      alerts.push({
        id: `server-ram-${server.id ?? serverName}`,
        category: 'server',
        severity: isCritical ? 'critical' : 'warning',
        severityLabel: isCritical ? 'Kritik' : 'Uyarı',
        badgeState: isCritical ? 'failed' : 'warning',
        title: `Yüksek RAM kullanımı · %${Math.round(memoryUsage)}`,
        detail: `${serverName} üzerinde bellek kullanımı %${Math.round(memoryUsage)} seviyesinde.`,
        href: '/servers',
        actionLabel: 'Sunucuyu incele',
      });
    }
    const disk = inventory.filesystem ?? inventory.disk ?? {};
    const diskUsage = usagePercent(disk.usedBytes, disk.totalBytes) ?? disk.usagePercent ?? server.diskPercent ?? null;
    if (Number.isFinite(diskUsage) && diskUsage >= 85) {
      const isCritical = diskUsage >= 90;
      alerts.push({
        id: `server-disk-${server.id ?? serverName}`,
        category: 'server',
        severity: isCritical ? 'critical' : 'warning',
        severityLabel: isCritical ? 'Kritik' : 'Uyarı',
        badgeState: isCritical ? 'failed' : 'warning',
        title: `Yüksek Disk doluluğu · %${Math.round(diskUsage)}`,
        detail: `${serverName} üzerinde disk doluluğu %${Math.round(diskUsage)} seviyesinde.`,
        href: '/servers',
        actionLabel: 'Sunucuyu incele',
      });
    }
  }

  for (const job of jobItems) {
    if (job?.status !== 'failed') continue;
    alerts.push({
      id: `job-failed-${job.id}`,
      category: 'job',
      severity: 'critical',
      severityLabel: 'Kritik',
      badgeState: 'failed',
      title: `Başarısız görev · ${job.operation ?? job.type ?? job.id}`,
      detail: job.error?.message ?? job.summary ?? 'Görev yürütülürken hata oluştu.',
      href: '/jobs?status=failed',
      actionLabel: 'Hataları incele',
      job,
    });
  }

  const seenSuspendedDomains = new Set();
  for (const domain of domainItems) {
    if (!domain || (domain.state !== 'suspended' && domain.status !== 'suspended')) continue;
    seenSuspendedDomains.add(domain.id);
    alerts.push({
      id: `domain-suspended-${domain.id}`,
      category: 'domain',
      severity: 'warning',
      severityLabel: 'Uyarı',
      badgeState: 'warning',
      title: `Askıya alınmış alan adı · ${domain.primaryDomain ?? domain.domain ?? domain.id}`,
      detail: 'Alan adı askıya alınmış durumda.',
      href: siteHref(domain.id, 'settings'),
      actionLabel: 'Site ayarları',
    });
  }

  for (const site of websiteItems) {
    if (!site || (site.state !== 'suspended' && site.status !== 'suspended')) continue;
    const targetDomainId = site.primaryDomainId ?? site.domainId ?? site.id;
    if (seenSuspendedDomains.has(targetDomainId)) continue;
    alerts.push({
      id: `website-suspended-${site.id}`,
      category: 'domain',
      severity: 'warning',
      severityLabel: 'Uyarı',
      badgeState: 'warning',
      title: `Askıya alınmış site · ${site.primaryDomain ?? site.name ?? site.id}`,
      detail: 'Web sitesi askıya alınmış durumda.',
      href: siteHref(targetDomainId, 'settings'),
      actionLabel: 'Site ayarları',
    });
  }

  return alerts;
}

export function NotificationCenterDrawer({ open = true, onClose, initialTab = 'tasks' }) {
  const { domains, websites, certificates, servers, jobs, notice, setNotice, observe } = useWorkspace();
  const [activeTab, setActiveTab] = useState(initialTab);
  const [noticeHistory, setNoticeHistory] = useState([]);

  useEffect(() => {
    if (!notice) return;
    const text = typeof notice === 'string' ? notice : String(notice);
    setNoticeHistory((prev) => {
      if (prev.some((item) => item.text === text)) return prev;
      return [{ id: `notice-${Date.now()}`, text, createdAt: new Date().toISOString() }, ...prev].slice(0, 20);
    });
  }, [notice]);

  useEffect(() => {
    if (!open) return undefined;
    const onKeyDown = (event) => {
      if (event.key === 'Escape') {
        event.preventDefault();
        onClose?.();
      }
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [open, onClose]);

  const jobItems = collectionItems(jobs);
  const activeJobs = useMemo(
    () => jobItems.filter((job) => jobActive(job) || ['running', 'queued'].includes(job?.status)),
    [jobItems],
  );
  const recentJobs = useMemo(
    () => jobItems.filter((job) => ['succeeded', 'failed'].includes(job?.status)).slice(0, 15),
    [jobItems],
  );
  const alerts = useMemo(
    () => computeWorkspaceAlerts({ domains, websites, certificates, servers, jobs }),
    [domains, websites, certificates, servers, jobs],
  );
  const notices = useMemo(() => {
    if (!notice) return noticeHistory;
    const text = typeof notice === 'string' ? notice : String(notice);
    if (noticeHistory.some((item) => item.text === text)) return noticeHistory;
    return [{ id: 'current-notice', text, createdAt: null }, ...noticeHistory];
  }, [notice, noticeHistory]);

  if (!open) return null;

  function clearNotices() {
    setNotice?.(null);
    setNoticeHistory([]);
  }

  return (
    <div className="ws-drawer-backdrop" onClick={(event) => { if (event.target === event.currentTarget) onClose?.(); }}>
      <aside
        className="ws-drawer ws-notification-drawer"
        role="dialog"
        aria-modal="true"
        aria-label="Bildirim ve Görev Merkezi"
      >
        <header className="ws-drawer-header" style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: '0.75rem', paddingBottom: '0.75rem', borderBottom: '1px solid var(--ws-border)' }}>
          <div>
            <h2 style={{ margin: 0, fontSize: '1.05rem' }}>Bildirim ve Görev Merkezi</h2>
            <small className="ws-muted">{activeJobs.length} aktif görev · {alerts.length} sistem uyarısı</small>
          </div>
          <Button icon="close" aria-label="Bildirim merkezini kapat" onClick={() => onClose?.()} />
        </header>

        <div className="ws-tabs" role="tablist" aria-label="Merkez sekmeleri" style={{ display: 'flex', gap: '0.4rem', margin: '0.85rem 0' }}>
          <button
            type="button"
            role="tab"
            aria-selected={activeTab === 'tasks'}
            className={`ws-tab ${activeTab === 'tasks' ? 'is-active' : ''}`}
            onClick={() => setActiveTab('tasks')}
          >
            <span>Görev Kuyruğu</span>
            {activeJobs.length > 0 && <span className="ws-nav-count" style={{ marginLeft: '0.35rem' }}>{activeJobs.length}</span>}
          </button>
          <button
            type="button"
            role="tab"
            aria-selected={activeTab === 'alerts'}
            className={`ws-tab ${activeTab === 'alerts' ? 'is-active' : ''}`}
            onClick={() => setActiveTab('alerts')}
          >
            <span>Sistem Uyarıları</span>
            {alerts.length > 0 && <span className="ws-nav-count" style={{ marginLeft: '0.35rem' }}>{alerts.length}</span>}
          </button>
          <button
            type="button"
            role="tab"
            aria-selected={activeTab === 'notices'}
            className={`ws-tab ${activeTab === 'notices' ? 'is-active' : ''}`}
            onClick={() => setActiveTab('notices')}
          >
            <span>Bildirimler</span>
            {notices.length > 0 && <span className="ws-nav-count" style={{ marginLeft: '0.35rem' }}>{notices.length}</span>}
          </button>
        </div>

        <div className="ws-drawer-body" style={{ display: 'flex', flexDirection: 'column', gap: '0.85rem', overflowY: 'auto' }}>
          {activeTab === 'tasks' && (
            <section aria-label="Görev Kuyruğu" style={{ display: 'flex', flexDirection: 'column', gap: '0.75rem' }}>
              {activeJobs.length > 0 && (
                <div style={{ display: 'flex', flexDirection: 'column', gap: '0.5rem' }}>
                  <strong style={{ fontSize: '0.82rem', textTransform: 'uppercase', letterSpacing: '0.04em' }}>Aktif Görevler</strong>
                  {activeJobs.map((job) => (
                    <article key={job.id} className="ws-alert-item" style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: '0.75rem' }}>
                      <div style={{ display: 'flex', alignItems: 'center', gap: '0.6rem' }}>
                        <span className="ws-spinner" aria-hidden="true" />
                        <div>
                          <strong>{job.operation ?? job.type ?? job.id}</strong>
                          <p className="ws-muted" style={{ margin: 0 }}>{job.resourceType ? `${job.resourceType} · ` : ''}{job.status === 'running' ? 'Çalışıyor' : 'Sırada'}</p>
                        </div>
                      </div>
                      <div className="ws-actions" style={{ alignItems: 'center', gap: '0.4rem' }}>
                        <Badge state={job.status} />
                        <Button onClick={() => { observe?.(job); onClose?.(); }}>İncele</Button>
                      </div>
                    </article>
                  ))}
                </div>
              )}

              {recentJobs.length > 0 && (
                <div style={{ display: 'flex', flexDirection: 'column', gap: '0.5rem' }}>
                  <strong style={{ fontSize: '0.82rem', textTransform: 'uppercase', letterSpacing: '0.04em' }}>Son Tamamlanan Görevler</strong>
                  {recentJobs.map((job) => (
                    <article key={job.id} className="ws-alert-item" style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: '0.75rem' }}>
                      <div>
                        <strong>{job.operation ?? job.type ?? job.id}</strong>
                        <p className="ws-muted" style={{ margin: 0 }}>{formatDate(job.completedAt ?? job.updatedAt ?? job.createdAt)}</p>
                      </div>
                      <div className="ws-actions" style={{ alignItems: 'center', gap: '0.4rem' }}>
                        <Badge state={job.status} />
                        <Button onClick={() => { observe?.(job); onClose?.(); }}>İncele</Button>
                      </div>
                    </article>
                  ))}
                </div>
              )}

              {activeJobs.length === 0 && recentJobs.length === 0 && (
                <EmptyState
                  title="Kuyrukta görev yok"
                  detail="Çalışan veya yakın zamanda tamamlanan bir arka plan görevi bulunmuyor."
                  icon="jobs"
                  action={<LinkButton to="/jobs" onClick={() => onClose?.()}>Tüm işlemler</LinkButton>}
                />
              )}
            </section>
          )}

          {activeTab === 'alerts' && (
            <section aria-label="Sistem Uyarıları" style={{ display: 'flex', flexDirection: 'column', gap: '0.6rem' }}>
              {alerts.length > 0 ? alerts.map((alert) => (
                <article key={alert.id} className="ws-alert-item" style={{ display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between', gap: '0.75rem' }}>
                  <div style={{ display: 'flex', alignItems: 'flex-start', gap: '0.6rem' }}>
                    <Icon name={alert.category === 'ssl' ? 'shield' : alert.category === 'server' ? 'server' : 'alert'} />
                    <div>
                      <div style={{ display: 'flex', alignItems: 'center', gap: '0.45rem', flexWrap: 'wrap' }}>
                        <strong>{alert.title}</strong>
                        <Badge state={alert.badgeState}>{alert.severityLabel}</Badge>
                      </div>
                      <p className="ws-muted" style={{ margin: '0.2rem 0 0' }}>{alert.detail}</p>
                    </div>
                  </div>
                  <div className="ws-actions" style={{ alignItems: 'center', gap: '0.4rem' }}>
                    {alert.job ? (
                      <Button onClick={() => { observe?.(alert.job); onClose?.(); }}>İncele</Button>
                    ) : null}
                    <LinkButton to={alert.href} onClick={() => onClose?.()}>{alert.actionLabel}</LinkButton>
                  </div>
                </article>
              )) : (
                <EmptyState
                  title="Sistem uyarısı yok"
                  detail="SSL sertifikaları, sunucu kaynakları ve görev kuyruğunda dikkat gerektiren bir sorun tespit edilmedi."
                  icon="check"
                />
              )}
            </section>
          )}

          {activeTab === 'notices' && (
            <section aria-label="Bildirimler" style={{ display: 'flex', flexDirection: 'column', gap: '0.6rem' }}>
              {notices.length > 0 ? (
                <>
                  <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                    <span className="ws-muted">{notices.length} bildirim</span>
                    <Button onClick={clearNotices}>Temizle</Button>
                  </div>
                  {notices.map((item) => (
                    <article key={item.id} className="ws-alert-item" style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: '0.75rem' }}>
                      <div>
                        <strong>{item.text}</strong>
                        {item.createdAt && <p className="ws-muted" style={{ margin: 0 }}>{formatDate(item.createdAt)}</p>}
                      </div>
                    </article>
                  ))}
                </>
              ) : (
                <EmptyState
                  title="Yeni bildirim yok"
                  detail="Oturum boyunca oluşan panel bildirimleri burada listelenir."
                  icon="bell"
                />
              )}
            </section>
          )}
        </div>
      </aside>
    </div>
  );
}

export default NotificationCenterDrawer;
