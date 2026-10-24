import { useCallback, useEffect, useMemo, useState } from 'react';
import { Link, useParams } from 'react-router';
import {
  getDockerCatalog,
  getDockerDiagnosis,
  getDockerHistory,
  getDockerLogs,
  getDockerProject,
  getDockerRuntime,
  getDockerStorageBackup,
  listDockerProjects,
  listOneClickApps,
  prepareOneClickApp,
} from './docker-compose-client.js';
import DockerConfigPanel from './DockerConfigPanel.jsx';
import DockerLifecyclePanel from './DockerLifecyclePanel.jsx';
import DockerProjectCreateDialog from './DockerProjectCreateDialog.jsx';
import { Badge, Button, DEFAULT_DOCKER_STACK_TEMPLATES, EmptyState, KeyValues, LinkButton, PageHeading, Section } from './PanelKit.jsx';
import { formatDate } from './site-model.js';

function useAsyncResource(loader, dependencies = [], { enabled = true } = {}) {
  const [state, setState] = useState({ status: enabled ? 'loading' : 'idle', data: null, error: null });
  const [revision, setRevision] = useState(0);
  const refresh = useCallback(() => setRevision((value) => value + 1), []);
  useEffect(() => {
    if (!enabled) { setState({ status: 'idle', data: null, error: null }); return undefined; }
    const controller = new AbortController();
    setState((current) => ({ ...current, status: current.data ? 'stale' : 'loading', error: null }));
    Promise.resolve(loader(controller.signal))
      .then((data) => { if (!controller.signal.aborted) setState({ status: 'ready', data, error: null }); })
      .catch((error) => { if (!controller.signal.aborted) setState((current) => ({ status: current.data ? 'stale' : 'error', data: current.data, error })); });
    return () => controller.abort();
    // Callers pass stable identity primitives in dependencies; loader is intentionally excluded.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [...dependencies, enabled, revision]);
  return { ...state, refresh };
}

function Loading({ label }) {
  return <div className="ws-loading" role="status"><span className="ws-spinner" />{label} yükleniyor…</div>;
}

function LoadNotice({ resource, label }) {
  if (resource.status === 'loading') return <Loading label={label} />;
  if (!resource.error) return null;
  return <div className="ws-notice ws-notice-warn" role="alert"><div><strong>{label}</strong><p>{resource.error.message ?? 'Veri alınamadı.'}</p></div><Button icon="refresh" onClick={resource.refresh}>Yeniden dene</Button></div>;
}

function publishedPorts(service) {
  return Array.isArray(service?.publishedPorts) ? service.publishedPorts : [];
}

function storageMounts(service) {
  return Array.isArray(service?.storageMounts) ? service.storageMounts : [];
}

function portLabel(port) {
  const host = port.hostIp ?? '*';
  return `${host}:${port.publishedPort} → ${port.targetPort}/${port.protocol}`;
}

function innerOuterPortLabel(port) {
  const host = port.hostIp ?? '127.0.0.1';
  return `Inner: ${port.targetPort}/${port.protocol ?? 'tcp'} ↔ Outer: ${host}:${port.publishedPort}`;
}

function storageKindLabel(mount) {
  if (mount.kind === 'named_volume') return 'Named volume';
  if (mount.kind === 'bind' && mount.sourceScope === 'project') return 'Project bind';
  if (mount.kind === 'bind' && mount.sourceScope === 'host') return 'Host bind';
  return 'Ephemeral';
}

function storageResourceKey(serviceName, mount) {
  return JSON.stringify([serviceName, mount?.kind ?? null, mount?.sourceScope ?? null, mount?.source ?? null, mount?.target ?? null]);
}

function storagePolicyLabel(policy) {
  if (policy?.disposition === 'include') return "Manifest'e dahil";
  if (policy?.disposition === 'exclude') return 'Backup dışı';
  if (policy?.disposition === 'reject') return 'Varsayılan reddedilir';
  return 'Policy kullanılamıyor';
}

function storagePolicyBadge(policy) {
  if (policy?.disposition === 'include') return 'active';
  if (policy?.disposition === 'reject') return 'warning';
  return 'off';
}

function runtimeBadge(status) {
  if (status === 'running') return 'active';
  if (['degraded', 'restarting'].includes(status)) return 'warning';
  if (['absent', 'stopped'].includes(status)) return 'offline';
  if (status === 'starting') return 'running';
  return 'unknown';
}

const EASYPANEL_CATEGORY_FILTERS = [
  { id: 'all', label: 'Tümü' },
  { id: 'jamstack_baas', label: 'JAMstack & BaaS' },
  { id: 'headless_cms', label: 'Headless CMS' },
  { id: 'automation_ai', label: 'Otomasyon & AI' },
  { id: 'analytics_monitoring', label: 'İzleme & Analitik' },
  { id: 'database_cache', label: 'Veritabanı & Cache' },
  { id: 'docker_hub_live', label: 'Canlı Docker Hub Arama' },
];

const FALLBACK_EASYPANEL_ONE_CLICK_APPS = [
  { id: 'pocketbase', name: 'PocketBase', label: 'PocketBase', image: 'ghcr.io/muchobien/pocketbase:latest', innerPort: 8090, targetPort: 8090, outerPort: 18090, publishedPort: 18090, category: 'jamstack_baas', categoryLabel: 'JAMstack & BaaS', oneClick: true, hasAutoSecrets: true, description: 'JAMstack Backend-in-a-file: Auth, Realtime DB, File Storage ve REST API.' },
  { id: 'n8n', name: 'n8n Workflow Automation', label: 'n8n Workflow Automation', image: 'n8nio/n8n:latest', innerPort: 5678, targetPort: 5678, outerPort: 15678, publishedPort: 15678, category: 'automation_ai', categoryLabel: 'Otomasyon & AI', oneClick: true, hasAutoSecrets: true, description: 'Self-hosted workflow automation ve AI ajan orkestrasyon platformu.' },
  { id: 'directus', name: 'Directus Headless CMS', label: 'Directus Headless CMS', image: 'directus/directus:11', innerPort: 8055, targetPort: 8055, outerPort: 18055, publishedPort: 18055, category: 'headless_cms', categoryLabel: 'Headless CMS', oneClick: true, hasAutoSecrets: true, description: 'SQL veritabanları için anında REST + GraphQL API üreten modern Headless CMS.' },
  { id: 'strapi', name: 'Strapi Headless CMS', label: 'Strapi Headless CMS', image: 'strapi/strapi:latest', innerPort: 1337, targetPort: 1337, outerPort: 13370, publishedPort: 13370, category: 'headless_cms', categoryLabel: 'Headless CMS', oneClick: true, hasAutoSecrets: true, description: 'JAMstack siteler için açık kaynaklı Node.js Headless CMS ve içerik API motoru.' },
  { id: 'umami', name: 'Umami Web Analytics', label: 'Umami Web Analytics', image: 'ghcr.io/umami-software/umami:postgresql-latest', innerPort: 3000, targetPort: 3000, outerPort: 13005, publishedPort: 13005, category: 'analytics_monitoring', categoryLabel: 'İzleme & Analitik', oneClick: true, hasAutoSecrets: true, description: 'Gizlilik odaklı, çerezsiz Google Analytics alternatifi web analitik platformu.' },
  { id: 'meilisearch', name: 'Meilisearch', label: 'Meilisearch', image: 'getmeili/meilisearch:v1.11', innerPort: 7700, targetPort: 7700, outerPort: 17700, publishedPort: 17700, category: 'jamstack_baas', categoryLabel: 'JAMstack & BaaS', oneClick: true, hasAutoSecrets: true, description: 'JAMstack ve modern web uygulamaları için milisaniye hızında tam metin arama motoru.' },
  { id: 'ghost', name: 'Ghost Publishing & Newsletter', label: 'Ghost Publishing & Newsletter', image: 'ghost:5-alpine', innerPort: 2368, targetPort: 2368, outerPort: 12368, publishedPort: 12368, category: 'headless_cms', categoryLabel: 'Headless CMS', oneClick: true, hasAutoSecrets: false, description: 'Modern içerik yayıncılığı, blog, üyelik ve e-posta bülteni platformu.' },
  { id: 'wordpress-stack', name: 'WordPress + MariaDB Stack', label: 'WordPress + MariaDB Stack', image: 'wordpress:6.6-apache', innerPort: 80, targetPort: 80, outerPort: 18081, publishedPort: 18081, category: 'headless_cms', categoryLabel: 'Headless CMS', oneClick: true, hasAutoSecrets: true, description: 'Alan adı veya alt alan adı reverse proxy için hazır konteyner WordPress yığını.' },
  { id: 'uptime-kuma', name: 'Uptime Kuma', label: 'Uptime Kuma', image: 'louislam/uptime-kuma:1', innerPort: 3001, targetPort: 3001, outerPort: 13001, publishedPort: 13001, category: 'analytics_monitoring', categoryLabel: 'İzleme & Analitik', oneClick: true, hasAutoSecrets: false, description: 'HTTP, TCP, DNS ve SSL sertifika sürelerini izleyen self-hosted durum sayfası.' },
  { id: 'minio', name: 'MinIO S3 Storage', label: 'MinIO S3 Storage', image: 'minio/minio:latest', innerPort: 9000, targetPort: 9000, outerPort: 19000, publishedPort: 19000, category: 'storage', categoryLabel: 'Depolama & S3', oneClick: true, hasAutoSecrets: true, description: 'Yüksek performanslı, AWS S3 uyumlu nesne depolama sunucusu.' },
  { id: 'grafana', name: 'Grafana Dashboards', label: 'Grafana Dashboards', image: 'grafana/grafana:latest', innerPort: 3000, targetPort: 3000, outerPort: 13000, publishedPort: 13000, category: 'analytics_monitoring', categoryLabel: 'İzleme & Analitik', oneClick: true, hasAutoSecrets: true, description: 'Metrik görselleştirme, sunucu gözlemlenebilirliği ve alarm panoları.' },
  { id: 'redis', name: 'Redis 7 Cache', label: 'Redis 7 Cache', image: 'redis:7-alpine', innerPort: 6379, targetPort: 6379, outerPort: 16379, publishedPort: 16379, category: 'database_cache', categoryLabel: 'Veritabanı & Cache', oneClick: true, hasAutoSecrets: false, description: 'Yüksek hızlı bellek içi anahtar-değer deposu, önbellek ve mesaj kuyruğu.' },
  { id: 'postgres', name: 'PostgreSQL 16', label: 'PostgreSQL 16', image: 'postgres:16-alpine', innerPort: 5432, targetPort: 5432, outerPort: 15432, publishedPort: 15432, category: 'database_cache', categoryLabel: 'Veritabanı & Cache', oneClick: true, hasAutoSecrets: true, description: 'Kalıcı disk (named volume) tanımlı kurumsal ilişkisel PostgreSQL veritabanı.' },
  { id: 'ollama-webui', name: 'Open WebUI (AI Chat)', label: 'Open WebUI (AI Chat)', image: 'ghcr.io/open-webui/open-webui:main', innerPort: 8080, targetPort: 8080, outerPort: 18088, publishedPort: 18088, category: 'automation_ai', categoryLabel: 'Otomasyon & AI', oneClick: true, hasAutoSecrets: true, description: 'Ollama ve OpenAI uyumlu LLM modelleri için kendi kendine barındırılan yapay zeka arayüzü.' },
];

function DockerProjectList() {
  const projects = useAsyncResource(() => listDockerProjects(), [], { enabled: true });
  const [creating, setCreating] = useState(false);
  const [selectedTemplate, setSelectedTemplate] = useState(null);
  const [activeCategory, setActiveCategory] = useState('all');
  const [preparingTemplateId, setPreparingTemplateId] = useState(null);
  const [catalogQuery, setCatalogQuery] = useState('');
  const [debouncedQuery, setDebouncedQuery] = useState('');
  useEffect(() => {
    const timer = setTimeout(() => setDebouncedQuery(catalogQuery.trim()), catalogQuery.trim() ? 220 : 0);
    return () => clearTimeout(timer);
  }, [catalogQuery]);

  const oneClickCatalog = useAsyncResource(
    (signal) => listOneClickApps({
      q: debouncedQuery,
      category: activeCategory !== 'all' && activeCategory !== 'docker_hub_live' ? activeCategory : '',
      signal,
    }),
    [debouncedQuery, activeCategory],
    { enabled: activeCategory !== 'docker_hub_live' },
  );

  const liveCatalog = useAsyncResource(
    (signal) => getDockerCatalog(debouncedQuery, { live: true, signal }),
    [debouncedQuery],
    { enabled: activeCategory === 'docker_hub_live' || Boolean(debouncedQuery) },
  );

  const items = Array.isArray(projects.data) ? projects.data : [];
  const filteredCatalog = useMemo(() => {
    const q = catalogQuery.trim().toLowerCase();
    const isHubMode = activeCategory === 'docker_hub_live';

    if (!isHubMode && !q) {
      const sourceOneClick = Array.isArray(oneClickCatalog.data) && oneClickCatalog.data.length > 0
        ? oneClickCatalog.data
        : FALLBACK_EASYPANEL_ONE_CLICK_APPS;
      if (activeCategory === 'all') return sourceOneClick;
      return sourceOneClick.filter((item) => item.category === activeCategory);
    }

    if (!isHubMode && q) {
      const sourceOneClick = Array.isArray(oneClickCatalog.data) && oneClickCatalog.data.length > 0
        ? oneClickCatalog.data
        : FALLBACK_EASYPANEL_ONE_CLICK_APPS.filter((item) => (
            (activeCategory === 'all' || item.category === activeCategory)
            && (
              (item.label ?? item.name ?? '').toLowerCase().includes(q)
              || item.image.toLowerCase().includes(q)
              || (item.description ?? '').toLowerCase().includes(q)
            )
          ));
      const hubExtras = Array.isArray(liveCatalog.data)
        ? liveCatalog.data.filter((hubItem) => !sourceOneClick.some((oc) => oc.id === hubItem.id || oc.image === hubItem.image))
        : [];
      const combined = [...sourceOneClick, ...hubExtras];
      if (combined.length > 0) return combined;
    }

    if (Array.isArray(liveCatalog.data) && liveCatalog.data.length > 0) {
      return liveCatalog.data;
    }
    if (!q) return DEFAULT_DOCKER_STACK_TEMPLATES;
    return DEFAULT_DOCKER_STACK_TEMPLATES.filter((item) => (
      (item.label ?? item.name ?? '').toLowerCase().includes(q)
      || item.image.toLowerCase().includes(q)
      || (item.category ?? '').toLowerCase().includes(q)
    ));
  }, [oneClickCatalog.data, liveCatalog.data, catalogQuery, activeCategory]);

  function openWithTemplate(tpl = null) {
    setSelectedTemplate(tpl);
    setCreating(true);
  }

  async function handleOneClickInstall(tpl) {
    const innerPort = tpl.targetPort ?? tpl.innerPort ?? 80;
    const outerPort = tpl.publishedPort ?? tpl.outerPort ?? 18080;
    const title = tpl.label || tpl.name || tpl.image;
    if (!tpl.oneClick && !FALLBACK_EASYPANEL_ONE_CLICK_APPS.some((item) => item.id === tpl.id)) {
      openWithTemplate({ ...tpl, label: title, targetPort: innerPort, publishedPort: outerPort });
      return;
    }
    setPreparingTemplateId(tpl.id);
    try {
      const prepared = await prepareOneClickApp({
        templateId: tpl.id,
        innerPort,
        outerPort,
      });
      openWithTemplate({
        ...tpl,
        label: title,
        oneClick: true,
        projectName: prepared?.projectName || `${tpl.id.replace(/[^a-z0-9_-]/g, '_')}_stack`,
        defaultComposeDocument: prepared?.document || tpl.defaultComposeDocument,
        targetPort: prepared?.portMapping?.innerPort ?? innerPort,
        publishedPort: prepared?.portMapping?.outerPort ?? outerPort,
        generatedSecretsCount: prepared?.generatedSecretsCount ?? 0,
        generatedSecretKeys: prepared?.generatedSecretKeys ?? [],
        proxyPreview: prepared?.proxyPreview ?? null,
      });
    } catch {
      openWithTemplate({
        ...tpl,
        label: title,
        oneClick: true,
        projectName: `${String(tpl.id || 'app').replace(/[^a-z0-9_-]/g, '_')}_stack`,
        targetPort: innerPort,
        publishedPort: outerPort,
      });
    } finally {
      setPreparingTemplateId(null);
    }
  }

  return <>
    <PageHeading
      title="Docker & Compose Stack Yönetimi"
      description="Docker Hub üzerinden dilediğiniz imajı arayın, tek tıkla konteyner veya Compose stack oluşturun, .yml dosyası yükleyin ve alan adlarınıza proxy olarak bağlayın."
      actions={<>
        <Button icon="refresh" onClick={projects.refresh}>Yenile</Button>
        <LinkButton to="/websites/new?mode=subdomain" icon="globe">Subdomain'e Docker Bağla</LinkButton>
        <Button variant="primary" icon="plus" onClick={() => openWithTemplate(null)}>Compose / Stack Ekle</Button>
      </>}
    />
    <LoadNotice resource={projects} label="Docker projeleri" />
    <Section title="Compose projeleri" description="Çalışan ve tanımlı Compose stack'leri, Inner ↔ Outer port eşlemeleri ve Domain/Subdomain proxy bağlantıları.">
      {items.length > 0 ? (
        <div className="ws-table-scroll">
          <table className="ws-table">
            <thead>
              <tr>
                <th>Proje</th>
                <th>Servis</th>
                <th>Inner ↔ Outer Port Eşlemesi</th>
                <th>Network</th>
                <th>Volume</th>
                <th>Revizyon</th>
                <th />
              </tr>
            </thead>
            <tbody>
              {items.map((project) => {
                const allPorts = (project.services ?? []).flatMap((svc) => publishedPorts(svc).map((p) => ({ service: svc.name, ...p })));
                return (
                  <tr key={project.id}>
                    <td><strong>{project.projectName}</strong><small>{project.id}</small></td>
                    <td>{project.services?.length ?? 0}</td>
                    <td>
                      {allPorts.length > 0
                        ? allPorts.map((p) => (
                            <span key={`${p.service}:${p.publishedPort}:${p.targetPort}`} className="yp-port-mapping-badge" style={{ marginRight: '6px' }}>
                              {p.service}: Inner {p.targetPort}/{p.protocol ?? 'tcp'} ↔ Outer {p.hostIp ?? '127.0.0.1'}:{p.publishedPort}
                            </span>
                          ))
                        : <span className="ws-muted">Port yayımlanmadı</span>}
                    </td>
                    <td>{project.networks?.length ?? 0}</td>
                    <td>{project.volumes?.length ?? 0}</td>
                    <td>{project.revision}</td>
                    <td><LinkButton to={`/docker/${encodeURIComponent(project.id)}`}>Yönet</LinkButton></td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      ) : projects.status === 'ready' && (
        <EmptyState
          icon="box"
          title="Henüz Compose projesi yok"
          detail="Aşağıdaki canlı Docker Hub aramasından herhangi bir imajı seçip tek tıkla başlatabilir veya kendi docker-compose.yml dosyanızı yükleyebilirsiniz."
          action={<Button variant="primary" icon="plus" onClick={() => openWithTemplate(null)}>Compose projesi ekle</Button>}
        />
      )}
    </Section>
    <Section
      title="Easypanel 1-Click Uygulama Marketi & Docker Hub Canlı İmaj Arama"
      description="PocketBase, n8n, Directus, Strapi, Umami, Meilisearch gibi 1-Click şablonları otomatik secret üretimiyle tek tıkla kurun veya Docker Hub üzerindeki tüm imajları canlı arayın."
      actions={(liveCatalog.status === 'loading' || oneClickCatalog.status === 'loading') ? <Badge state="running">Katalog yükleniyor…</Badge> : <Badge state="active">{debouncedQuery ? `Docker Hub: ${filteredCatalog.length} sonuç` : `${filteredCatalog.length} Hazır Şablon · Docker Hub Bağlı`}</Badge>}
    >
      <div className="yp-category-pills" role="tablist" aria-label="1-Click Uygulama Kategorileri" style={{ display: 'flex', flexWrap: 'wrap', gap: '6px', padding: '14px 18px 0 18px' }}>
        {EASYPANEL_CATEGORY_FILTERS.map((cat) => {
          const isSelected = activeCategory === cat.id;
          return (
            <Button
              key={cat.id}
              variant={isSelected ? 'primary' : 'default'}
              onClick={() => setActiveCategory(cat.id)}
            >
              {cat.label}
            </Button>
          );
        })}
      </div>
      <div className="ws-filters">
        <label className="ws-filter-search" style={{ flex: '1 1 320px', width: '100%' }}>
          Docker Hub'da imaj veya servis ara
          <input
            type="search"
            value={catalogQuery}
            onChange={(event) => setCatalogQuery(event.target.value)}
            placeholder="Docker Hub'da ara: pocketbase, directus, strapi, umami, meilisearch, n8n, grafana, redis, postgres..."
          />
        </label>
      </div>
      <div className="ws-section-body">
        <div className="yp-docker-catalog-grid">
          {filteredCatalog.map((tpl) => {
            const innerPort = tpl.targetPort ?? tpl.innerPort ?? 80;
            const outerPort = tpl.publishedPort ?? tpl.outerPort ?? 18080;
            const title = tpl.label || tpl.name || tpl.image;
            const isOneClick = Boolean(tpl.oneClick || FALLBACK_EASYPANEL_ONE_CLICK_APPS.some((item) => item.id === tpl.id));
            const isPreparing = preparingTemplateId === tpl.id;
            return (
              <article key={tpl.id || tpl.image} className="yp-docker-catalog-card">
                <div>
                  <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'flex-start', gap: '4px', marginBottom: '8px' }}>
                    <strong style={{ fontSize: '14px', lineHeight: 1.35, wordBreak: 'break-word', width: '100%' }}>{title}</strong>
                    <span className="yp-port-mapping-badge" style={{ maxWidth: '100%', overflow: 'hidden', textOverflow: 'ellipsis' }}>{tpl.image}</span>
                  </div>
                  <div style={{ display: 'flex', flexWrap: 'wrap', gap: '6px', marginBottom: '8px' }}>
                    {isOneClick && <Badge state="active">Tek Tıkla Kur (Easypanel)</Badge>}
                    {isOneClick && <span className="yp-port-mapping-badge">Otomatik Secret & Volume</span>}
                    {tpl.official && <Badge state="active">Resmi İmaj</Badge>}
                    {tpl.starCount > 0 && <span className="yp-port-mapping-badge">★ {tpl.starCount.toLocaleString('tr-TR')}</span>}
                    {(tpl.categoryLabel || tpl.category) && <span className="yp-port-mapping-badge">{tpl.categoryLabel || tpl.category}</span>}
                  </div>
                  {tpl.description && <p className="ws-muted" style={{ margin: '0 0 10px 0', fontSize: '12px' }}>{tpl.description}</p>}
                  <div style={{ display: 'flex', flexWrap: 'wrap', gap: '6px' }}>
                    <span className="yp-port-mapping-badge">Inner: {innerPort}/tcp</span>
                    <span className="yp-port-mapping-badge">Outer: 127.0.0.1:{outerPort}</span>
                  </div>
                </div>
                <div style={{ display: 'flex', justifyContent: 'flex-end', gap: '6px', marginTop: '8px' }}>
                  {isOneClick ? (
                    <Button
                      variant="primary"
                      icon="plus"
                      disabled={isPreparing}
                      onClick={() => handleOneClickInstall(tpl)}
                    >
                      {isPreparing ? 'Hazırlanıyor…' : 'Tek Tıkla Kur'}
                    </Button>
                  ) : (
                    <Button
                      variant="primary"
                      icon="plus"
                      onClick={() => openWithTemplate({ ...tpl, label: title, targetPort: innerPort, publishedPort: outerPort })}
                    >
                      Bu İmajla Oluştur
                    </Button>
                  )}
                </div>
              </article>
            );
          })}
        </div>
      </div>
    </Section>
    {creating && <DockerProjectCreateDialog initialTemplate={selectedTemplate} onClose={() => { setCreating(false); setSelectedTemplate(null); }} />}
  </>;
}

function DiagnosisPanel({ project }) {
  const options = useMemo(() => (project.services ?? []).flatMap((service) => publishedPorts(service)
    .filter((port) => port.protocol === 'tcp')
    .map((port) => ({ serviceName: service.name, targetPort: port.targetPort, key: `${service.name}:${port.targetPort}` }))), [project]);
  const [selected, setSelected] = useState(options[0]?.key ?? '');
  useEffect(() => { if (!options.some((item) => item.key === selected)) setSelected(options[0]?.key ?? ''); }, [options, selected]);
  const binding = options.find((item) => item.key === selected) ?? null;
  const diagnosis = useAsyncResource(
    () => binding ? getDockerDiagnosis(project.id, { service: binding.serviceName, targetPort: binding.targetPort }) : null,
    [project.id, selected],
    { enabled: Boolean(binding) },
  );
  if (options.length === 0) return <EmptyState icon="alert" title="HTTP target seçilemiyor" detail="Projede TCP published port özeti yok. Website/Nginx binding için açık bir service target port publish edilmelidir." />;
  const result = diagnosis.data;
  return <div className="ws-section-body"><div className="ws-filters"><label>Website target<select value={selected} onChange={(event) => setSelected(event.target.value)}>{options.map((item) => <option key={item.key} value={item.key}>{item.serviceName} · {item.targetPort}/tcp</option>)}</select></label><Button icon="refresh" onClick={diagnosis.refresh}>Kontrol et</Button></div><LoadNotice resource={diagnosis} label="Target diagnosis" />{result && <><KeyValues items={[
    ['Durum', <Badge key="status" state={result.status === 'ready' ? 'active' : result.status === 'attention' ? 'warning' : 'error'}>{result.status}</Badge>],
    ['Nginx target', result.target?.ready ? `${result.target.host}:${result.target.port}` : 'Hazır değil'],
    ['Runtime', result.runtime?.status ?? 'unknown'],
    ['Container', result.runtime?.containerCount ?? 0],
  ]} />{result.issues?.length > 0 && <div className="ws-table-scroll"><table className="ws-table"><thead><tr><th>Sorun</th><th>Aksiyon</th><th>Açıklama</th></tr></thead><tbody>{result.issues.map((item) => <tr key={`${item.code}:${item.action}`}><td><Badge state={item.severity === 'error' ? 'error' : 'warning'}>{item.code}</Badge></td><td><code>{item.action}</code></td><td>{item.message}</td></tr>)}</tbody></table></div>}</>}</div>;
}

function StoragePanel({ project, backup }) {
  const mounts = (project.services ?? []).flatMap((service) => storageMounts(service).map((mount) => ({ ...mount, serviceName: service.name })));
  const currentBackup = backup?.projectRevision === project.revision ? backup : null;
  const policyByMount = new Map((currentBackup?.resources ?? []).map((resource) => [
    storageResourceKey(resource.serviceName, resource.storage),
    resource.policy,
  ]));
  return <Section title="Depolama" description="Konteyner servislerinin kalıcı disk (volume) ve dizin bağlantıları.">
    {currentBackup && <div className="ws-section-body"><KeyValues items={[
      ['Manifest', `v${currentBackup.manifestVersion}`],
      ['Dahil', currentBackup.counts?.included ?? 0],
      ['Backup dışı', currentBackup.counts?.excluded ?? 0],
      ['Reddedilen', currentBackup.counts?.rejected ?? 0],
    ]} /></div>}
    {mounts.length > 0 ? <div className="ws-table-scroll"><table className="ws-table"><thead><tr><th>Servis</th><th>Tür</th><th>Kaynak</th><th>Container hedefi</th><th>Mod</th><th>Backup</th></tr></thead><tbody>{mounts.map((mount) => {
      const policy = policyByMount.get(storageResourceKey(mount.serviceName, mount)) ?? null;
      return <tr key={`${mount.serviceName}:${mount.target}`}><td><strong>{mount.serviceName}</strong></td><td>{storageKindLabel(mount)}</td><td><code>{mount.source ?? '—'}</code></td><td><code>{mount.target}</code></td><td>{mount.readOnly ? 'Read only' : 'Read / write'}</td><td><Badge state={storagePolicyBadge(policy)}>{storagePolicyLabel(policy)}</Badge></td></tr>;
    })}</tbody></table></div> : <EmptyState icon="archive" title="Kalıcı veya ephemeral mount yok" detail="Bu Compose projesinin doğrulanmış servis tanımlarında storage mount bulunmuyor." />}
  </Section>;
}

function RuntimePanel({ projectId }) {
  const runtime = useAsyncResource(() => getDockerRuntime(projectId), [projectId]);
  const result = runtime.data;
  return <Section title="Runtime" actions={<Button icon="refresh" onClick={runtime.refresh}>Yenile</Button>}><LoadNotice resource={runtime} label="Runtime" />{result && <div className="ws-section-body"><KeyValues items={[
    ['Durum', <Badge key="runtime" state={runtimeBadge(result.status)}>{result.status}</Badge>],
    ['Container', result.containerCount],
    ['Proje', result.projectName],
  ]} />{result.containers?.length > 0 && <div className="ws-table-scroll"><table className="ws-table"><thead><tr><th>Container</th><th>Durum</th><th>Health</th><th>Exit</th></tr></thead><tbody>{result.containers.map((container) => <tr key={container.id}><td><strong>{container.name ?? container.id.slice(0, 12)}</strong><small>{container.image ?? '—'}</small></td><td><Badge state={container.runtime?.running ? 'active' : container.runtime?.restarting ? 'warning' : 'offline'}>{container.runtime?.status ?? 'unknown'}</Badge></td><td>{container.runtime?.health?.status ?? '—'}</td><td>{container.runtime?.exitCode ?? '—'}</td></tr>)}</tbody></table></div>}</div>}</Section>;
}

function LogsPanel({ project }) {
  const serviceNames = project.services?.map((service) => service.name) ?? [];
  const [service, setService] = useState(serviceNames[0] ?? '');
  const [tail, setTail] = useState(100);
  const logs = useAsyncResource(() => getDockerLogs(project.id, { service: service || null, tail }), [project.id, service, tail]);
  const result = logs.data;
  return <Section title="Container logları" actions={<Button icon="refresh" onClick={logs.refresh}>Yenile</Button>}><div className="ws-section-body"><div className="ws-filters"><label>Servis<select value={service} onChange={(event) => setService(event.target.value)}>{serviceNames.map((name) => <option key={name} value={name}>{name}</option>)}</select></label><label>Satır<select value={tail} onChange={(event) => setTail(Number(event.target.value))}><option value={50}>50</option><option value={100}>100</option><option value={200}>200</option><option value={500}>500</option></select></label></div><LoadNotice resource={logs} label="Container logları" />{result?.containers?.map((container) => <div key={container.id} className="ws-log-block"><strong>{container.name ?? container.id}</strong>{container.unavailable ? <p className="ws-muted">Log okunamadı.</p> : <pre>{container.lines?.join('\n') || 'Log satırı yok.'}</pre>}</div>)}</div></Section>;
}

function HistoryPanel({ projectId }) {
  const history = useAsyncResource(() => getDockerHistory(projectId), [projectId]);
  const items = Array.isArray(history.data) ? history.data : [];
  return <Section title="Deploy / lifecycle geçmişi" actions={<Button icon="refresh" onClick={history.refresh}>Yenile</Button>}><LoadNotice resource={history} label="Docker geçmişi" />{items.length > 0 ? <div className="ws-table-scroll"><table className="ws-table"><thead><tr><th>İşlem</th><th>Durum</th><th>Başlangıç</th><th>İş</th></tr></thead><tbody>{items.slice(0, 30).map((job) => <tr key={job.id}><td>{job.operation ?? job.type}</td><td><Badge state={job.status}>{job.status}</Badge></td><td>{formatDate(job.createdAt)}</td><td><code>{job.id}</code></td></tr>)}</tbody></table></div> : history.status === 'ready' && <EmptyState icon="clock" title="Henüz lifecycle işi yok" detail="Build, pull, start, stop veya restart işlemleri burada görünecek." />}</Section>;
}

function DockerProjectDetail({ projectId }) {
  const detail = useAsyncResource(() => getDockerProject(projectId), [projectId]);
  const data = detail.data;
  const project = data?.project ?? null;
  const storageBackup = useAsyncResource(
    () => getDockerStorageBackup(projectId),
    [projectId, project?.revision ?? 0],
    { enabled: Boolean(project) },
  );
  const storageCount = project?.services?.reduce((total, service) => total + storageMounts(service).length, 0) ?? 0;
  const refresh = () => { detail.refresh(); storageBackup.refresh(); };
  return <><nav className="ws-breadcrumb"><Link to="/docker">Docker</Link><span>/ {project?.projectName ?? projectId}</span></nav><PageHeading title={project?.projectName ? project.projectName : 'Docker projesi'} description="Compose desired state, depolama yedekleme politikası, yayınlanan portlar, runtime ve işlem geçmişi." actions={<Button icon="refresh" onClick={refresh}>Yenile</Button>} /><LoadNotice resource={detail} label="Docker proje detayı" />{project && <><Section title="Desired state"><div className="ws-section-body"><KeyValues items={[
    ['Revizyon', project.revision], ['Compose SHA-256', project.composeSha256], ['Servis', project.services?.length ?? 0], ['Network', project.networks?.length ?? 0], ['Named volume', project.volumes?.length ?? 0], ['Mount', storageCount], ['Env revizyonu', data.environment?.revision ?? 0], ['Registry credential', data.credentials?.length ?? 0],
  ]} /><div className="ws-table-scroll"><table className="ws-table"><thead><tr><th>Servis</th><th>Kaynak</th><th>Inner Port (Container targetPort)</th><th>Outer Port (Host publishedPort)</th><th>Published ports</th><th>Domain / Subdomain Proxy Hedefi</th></tr></thead><tbody>{project.services?.map((service) => <tr key={service.name}><td><strong>{service.name}</strong></td><td>{service.imageConfigured ? 'image' : service.buildConfigured ? 'build' : '—'}</td><td>{publishedPorts(service).length ? publishedPorts(service).map((port) => <span key={`in:${portLabel(port)}`} className="yp-port-mapping-badge">Inner: {port.targetPort}/{port.protocol ?? 'tcp'}</span>) : '—'}</td><td>{publishedPorts(service).length ? publishedPorts(service).map((port) => <span key={`out:${portLabel(port)}`} className="yp-port-mapping-badge">Outer: {(port.hostIp ?? '127.0.0.1')}:{port.publishedPort}</span>) : '—'}</td><td>{publishedPorts(service).length ? publishedPorts(service).map((port) => <small key={portLabel(port)}>{portLabel(port)}</small>) : '—'}</td><td>{publishedPorts(service).length ? publishedPorts(service).map((port) => <code key={`proxy:${portLabel(port)}`}>{innerOuterPortLabel(port)}</code>) : '—'}</td></tr>)}</tbody></table></div></div></Section><LoadNotice resource={storageBackup} label="Docker storage backup policy" /><StoragePanel project={project} backup={storageBackup.data} /><DockerConfigPanel data={data} onChanged={detail.refresh} /><DockerLifecyclePanel project={project} onChanged={detail.refresh} /><Section title="Website / Nginx diagnosis" description="Konteyner servislerinin web sitesi ve alan adı yönlendirme durumu."><DiagnosisPanel project={project} /></Section><RuntimePanel projectId={project.id} /><LogsPanel project={project} /><HistoryPanel projectId={project.id} /></>}</>;
}

export default function DockerProjectsPage() {
  const { dockerProjectId } = useParams();
  return dockerProjectId ? <DockerProjectDetail projectId={dockerProjectId} /> : <DockerProjectList />;
}

export const dockerProjectsPageInternals = Object.freeze({
  publishedPorts,
  storageMounts,
  portLabel,
  innerOuterPortLabel,
  storageKindLabel,
  storageResourceKey,
  storagePolicyLabel,
  storagePolicyBadge,
  runtimeBadge,
});
