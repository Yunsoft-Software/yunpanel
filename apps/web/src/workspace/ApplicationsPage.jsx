import { useEffect, useState } from 'react';
import { Link, Navigate, useSearchParams } from 'react-router';
import { panelRequest } from '../api.js';
import { useWorkspace } from './WorkspaceContext.jsx';
import { Badge, Button, CollectionNotice, EmptyState, LinkButton, PageHeading, Section } from './PanelKit.jsx';
import { formatDate, siteHref } from './site-model.js';

export default function ApplicationsPage({ create = false }) {
  if (create) return <Navigate to="/websites/new" replace />;
  return <ApplicationInventory />;
}

function ApplicationInventory() {
  const { applications, servers, websites, domains, refreshAll } = useWorkspace();
  const [params, setParams] = useSearchParams();
  const [siteBindings, setSiteBindings] = useState({ websites: [], domains: [] });
  const query = params.get('q') ?? '';

  useEffect(() => {
    let cancelled = false;
    async function loadBindings() {
      try {
        const [sitesRes, domainsRes] = await Promise.all([
          panelRequest('/websites').catch(() => ({ data: [] })),
          panelRequest('/domains').catch(() => ({ data: [] })),
        ]);
        if (!cancelled) {
          setSiteBindings({
            websites: Array.isArray(sitesRes?.data) ? sitesRes.data : (Array.isArray(sitesRes) ? sitesRes : []),
            domains: Array.isArray(domainsRes?.data) ? domainsRes.data : (Array.isArray(domainsRes) ? domainsRes : []),
          });
        }
      } catch {
        // fallback to empty
      }
    }
    loadBindings();
    return () => { cancelled = true; };
  }, []);

  const websiteList = websites?.items?.length ? websites.items : siteBindings.websites;
  const domainList = domains?.items?.length ? domains.items : siteBindings.domains;

  const items = applications.items.filter((app) =>
    app.name.toLowerCase().includes(query.toLowerCase())
  );

  function filter(key, value) {
    setParams((current) => {
      const next = new URLSearchParams(current);
      value ? next.set(key, value) : next.delete(key);
      return next;
    }, { replace: key === 'q' });
  }

  return (
    <>
      <nav className="ws-breadcrumb" aria-label="Konum">
        <Link to="/tools-settings">Araçlar ve Ayarlar</Link>
        <span>/</span>
        <span>Tanılama</span>
        <span>/</span>
        <span>Uygulama envanteri</span>
      </nav>
      <PageHeading
        title="Uygulama envanteri"
        description="Sistemde kayıtlı çalışma zamanı uygulamalarının Owner tanılama envanteri. Günlük uygulama yönetimi ve yayın işlemleri yalnızca ait oldukları web sitesi altında yürütülür."
        actions={
          <Button
            icon="refresh"
            onClick={refreshAll}
            disabled={applications.status === 'loading'}
          >
            Yenile
          </Button>
        }
      />
      <div className="ws-notice">
        <div>
          <strong>Site odaklı uygulama işletimi</strong>
          <p>Uygulama runtime, environment, yayın geçmişi, sağlık kontrolü ve rollback işlemleri doğrudan ilgili web sitesinin yönetim alanından yürütülür. Plesk eşdeğeri olmayan Python ve Docker uzantıları da site bağlamında sunulur.</p>
        </div>
        <LinkButton to="/websites">Web Sitelerine Git</LinkButton>
      </div>
      <Section title="Uygulama tanılama envanteri">
        <div className="ws-filters">
          <label className="ws-filter-search">
            Uygulama ara
            <input
              type="search"
              value={query}
              onChange={(event) => filter('q', event.target.value)}
              placeholder="Uygulama adına göre filtrele"
            />
          </label>
        </div>
        <CollectionNotice resource={applications} label="Uygulamalar" />
        {items.length ? (
          <div className="ws-table-scroll">
            <table className="ws-table">
              <thead>
                <tr>
                  <th>Uygulama</th>
                  <th>Runtime / Port</th>
                  <th>Durum</th>
                  <th>Son deploy</th>
                  <th>Bağlı web sitesi</th>
                  <th>İşlem</th>
                </tr>
              </thead>
              <tbody>
                {items.map((app) => {
                  const boundWebsite = websiteList.find((w) => w.applicationId === app.id);
                  const boundDomain = boundWebsite ? domainList.find((d) => d.websiteId === boundWebsite.id) : null;
                  const targetHref = boundDomain
                    ? siteHref(boundDomain.id, app.type === 'node' ? 'node' : 'deploy')
                    : (boundWebsite ? `/websites/${encodeURIComponent(boundWebsite.id)}` : '/websites');

                  return (
                    <tr key={app.id}>
                      <td>
                        <strong>{app.name}</strong>
                        <small>
                          {app.branch} · {servers.items.find((item) => item.id === app.serverId)?.hostname ?? 'Sunucu bilgisi yok'}
                        </small>
                      </td>
                      <td>
                        {app.type === 'node'
                          ? `Node.js ${app.runtime?.nodeMajor ?? ''}`
                          : app.type === 'python'
                          ? 'Python'
                          : 'Statik'}
                        <small>
                          {app.type === 'node'
                            ? `Port ${app.runtime?.port ?? '—'}`
                            : app.build?.outputDir ?? '—'}
                        </small>
                      </td>
                      <td>
                        <Badge state={app.state} />
                      </td>
                      <td>{formatDate(app.lastDeployedAt)}</td>
                      <td>
                        {boundDomain ? (
                          <strong>{boundDomain.primaryDomain}</strong>
                        ) : boundWebsite ? (
                          <span>{boundWebsite.name}</span>
                        ) : (
                          <span className="ws-muted">Bağlı site yok</span>
                        )}
                      </td>
                      <td>
                        <div className="ws-actions">
                          {boundDomain || boundWebsite ? (
                            <LinkButton to={targetHref}>
                              Siteye git
                            </LinkButton>
                          ) : (
                            <LinkButton to="/websites">
                              Web sitelerine git
                            </LinkButton>
                          )}
                        </div>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        ) : applications.status === 'ready' && (
          <EmptyState
            title="Uygulama bulunamadı"
            detail="Kayıtlı uygulama bulunmuyor veya arama terimine uygun sonuç yok."
            icon="code"
          />
        )}
      </Section>
    </>
  );
}
