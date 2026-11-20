import { useCallback, useEffect, useId, useMemo, useRef, useState } from 'react';
import { panelRequest, waitForJob } from '../api.js';
import { usePanelSession } from '../panel-session.jsx';
import { sessionTransitionPending, sessionVersion } from '../session-client.js';
import { useWorkspace } from './WorkspaceContext.jsx';
import { Badge, Button, CollectionNotice, EmptyState, ErrorNotice, KeyValues, LinkButton, Section } from './PanelKit.jsx';
import { siteHref } from './site-model.js';
import { useUnsavedChanges } from './UnsavedChanges.jsx';
import { DomainAliasError, aliasErrorMessage } from './domain-alias-model.js';
import { createDomainHostingClient } from './domain-hosting-client.js';
import { createHostingForm, editHostingForm, hostingFormDirty, hostingWriteBlock, refreshHostingForm, reloadHostingForm } from './domain-hosting-form.js';
import { listDockerProjects, resolveServerDockerProxyRule } from './docker-compose-client.js';
import NginxSettingsFields from './NginxSettingsFields.jsx';
import ProtectedPathUsers from './ProtectedPathUsers.jsx';
import RedirectTargetFields from './RedirectTargetFields.jsx';

export const JAMSTACK_FRAMEWORK_PRESETS = [
  { id: 'nextjs', label: 'Next.js', path: '/api', innerPort: '3000', outerPort: '127.0.0.1:13000', websocket: true },
  { id: 'astro', label: 'Astro', path: '/api', innerPort: '4321', outerPort: '127.0.0.1:14321', websocket: false },
  { id: 'vite', label: 'Vite', path: '/api', innerPort: '8080', outerPort: '127.0.0.1:18080', websocket: true },
  { id: 'nuxt', label: 'Nuxt', path: '/api', innerPort: '3000', outerPort: '127.0.0.1:13001', websocket: true },
  { id: 'remix', label: 'Remix', path: '/ws', innerPort: '3000', outerPort: '127.0.0.1:13002', websocket: true },
  { id: 'node', label: 'Node.js', path: '/api', innerPort: '4000', outerPort: '127.0.0.1:14000', websocket: true },
  { id: 'python', label: 'Python', path: '/api', innerPort: '8000', outerPort: '127.0.0.1:18000', websocket: true },
];

const PROXY_ROUTE_PATH_PATTERN = /^\/[A-Za-z0-9][A-Za-z0-9._-]*(?:\/[A-Za-z0-9][A-Za-z0-9._-]*)*$/;
const RESERVED_PROXY_PREFIXES = ['/.well-known', '/autodiscover', '/mail/config-v1.1.xml'];
const LOOPBACK_IPV4_PATTERN = /^127\.(?:25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)\.(?:25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)\.(?:25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)$/;

function isLoopbackHost(host) {
  return typeof host === 'string' && (LOOPBACK_IPV4_PATTERN.test(host) || host === '::1');
}

function normalizeLoopbackHost(hostIp) {
  if (hostIp === null || hostIp === undefined || hostIp === '' || hostIp === '0.0.0.0') return '127.0.0.1';
  if (hostIp === '::') return '::1';
  return isLoopbackHost(hostIp) ? hostIp : null;
}

export function normalizeSubPathRoute(rawPath) {
  if (typeof rawPath !== 'string') throw new Error('Geçersiz alt yol adresi.');
  const trimmed = rawPath.trim();
  if (!trimmed || trimmed === '/') throw new Error('Alt yol /api gibi kök dışı bir yol olmalıdır.');
  const prefixed = trimmed.startsWith('/') ? trimmed : `/${trimmed}`;
  const normalized = prefixed.length > 1 && prefixed.endsWith('/') ? prefixed.slice(0, -1) : prefixed;
  if (normalized.length > 128 || normalized === '/' || !PROXY_ROUTE_PATH_PATTERN.test(normalized)) {
    throw new Error('Geçersiz alt yol adresi.');
  }
  const lower = normalized.toLowerCase();
  if (RESERVED_PROXY_PREFIXES.some((prefix) => lower === prefix || lower.startsWith(`${prefix}/`))) {
    throw new Error('Bu alt yol sistem tarafından ayrılmıştır.');
  }
  return normalized;
}

export function eligibleDockerProxySlots(project) {
  const services = Array.isArray(project?.services) ? project.services : [];
  const slots = [];
  for (const service of services) {
    if (!service?.name || !Array.isArray(service.publishedPorts)) continue;
    const byTargetPort = new Map();
    for (const port of service.publishedPorts) {
      if ((port?.protocol ?? 'tcp') !== 'tcp') continue;
      const list = byTargetPort.get(port.targetPort) ?? [];
      list.push(port);
      byTargetPort.set(port.targetPort, list);
    }
    for (const [targetPort, matches] of byTargetPort.entries()) {
      if (matches.length !== 1) continue;
      const published = matches[0];
      const upstreamHost = normalizeLoopbackHost(published.hostIp ?? null);
      if (!upstreamHost || !Number.isSafeInteger(published.publishedPort)
        || published.publishedPort < 1024 || published.publishedPort > 65535) {
        continue;
      }
      slots.push({
        key: `${service.name}:${targetPort}`,
        serviceName: service.name,
        targetPort,
        protocol: 'tcp',
        upstreamHost,
        upstreamPort: published.publishedPort,
      });
    }
  }
  return slots;
}

function formatUpstreamAddress(host, port) {
  return host.includes(':') ? `[${host}]:${port}` : `${host}:${port}`;
}

export function buildNginxSubPathLocationBlock({
  path = '/api',
  innerPort = '3000',
  outerPort = '127.0.0.1:13000',
  websocket = true,
  stripPrefix = false,
} = {}) {
  const normalizedPath = normalizeSubPathRoute(path);
  const cleanInnerNum = Number(String(innerPort ?? '3000').trim());
  if (!Number.isInteger(cleanInnerNum) || cleanInnerNum < 1 || cleanInnerNum > 65535) {
    throw new Error('Konteyner portu 1–65535 aralığında olmalıdır.');
  }

  const rawOuter = String(outerPort ?? '127.0.0.1:13000').trim();
  let hostPart = '127.0.0.1';
  let portPart = rawOuter;
  if (rawOuter.startsWith('[')) {
    const match = /^\[([^\]]+)\]:(\d+)$/.exec(rawOuter);
    if (!match) throw new Error('Yerel hedef adresi geçerli bir loopback adresi ve 1024–65535 portu olmalıdır.');
    hostPart = match[1];
    portPart = match[2];
  } else if (rawOuter.includes(':')) {
    const parts = rawOuter.split(':');
    if (parts.length !== 2) throw new Error('Yerel hedef adresi geçerli bir loopback adresi ve 1024–65535 portu olmalıdır.');
    [hostPart, portPart] = parts;
  }
  const outerPortNum = Number(portPart);
  if (!isLoopbackHost(hostPart) || !Number.isInteger(outerPortNum) || outerPortNum < 1024 || outerPortNum > 65535) {
    throw new Error('Yerel hedef adresi geçerli bir loopback adresi ve 1024–65535 portu olmalıdır.');
  }

  const formattedHost = formatUpstreamAddress(hostPart, outerPortNum);
  const targetUrl = `http://${formattedHost}${stripPrefix ? '/' : ''}`;
  const renderBlock = (directive) => {
    const lines = [
      `location ${directive} {`,
      `    proxy_pass ${targetUrl};`,
      '    proxy_http_version 1.1;',
      '    proxy_set_header Host $host;',
      '    proxy_set_header X-Real-IP $remote_addr;',
      '    proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;',
      '    proxy_set_header X-Forwarded-Proto $scheme;',
    ];
    if (websocket) {
      lines.push(
        '    proxy_set_header Upgrade $http_upgrade;',
        '    proxy_set_header Connection "upgrade";',
      );
    }
    lines.push('}');
    return lines.join('\n');
  };
  return `${renderBlock(`= ${normalizedPath}`)}\n\n${renderBlock(`^~ ${normalizedPath}/`)}`;
}

export function NginxSubPathProxyBuilder({
  domain,
  routes = null,
  onChange = null,
  disabled = false,
  isOwner = false,
  projects: initialProjects = null,
  loadProjects = listDockerProjects,
  resolveRule = resolveServerDockerProxyRule,
}) {
  const activeRoutes = useMemo(
    () => (Array.isArray(routes) ? routes : (Array.isArray(domain?.nginxSettings?.proxyRoutes) ? domain.nginxSettings.proxyRoutes : [])),
    [routes, domain],
  );
  const editable = isOwner && typeof onChange === 'function';
  const [projects, setProjects] = useState(() => (Array.isArray(initialProjects) ? initialProjects : []));
  const [projectsStatus, setProjectsStatus] = useState(() => (Array.isArray(initialProjects) ? 'ready' : (editable ? 'loading' : 'idle')));
  const [selectedProjectId, setSelectedProjectId] = useState(() => (Array.isArray(initialProjects) && initialProjects[0]?.id ? initialProjects[0].id : ''));
  const [selectedSlotKey, setSelectedSlotKey] = useState('');
  const [proxyPath, setProxyPath] = useState('/api');
  const [websocket, setWebsocket] = useState(true);
  const [stripPrefix, setStripPrefix] = useState(false);
  const [resolving, setResolving] = useState(false);
  const [builderError, setBuilderError] = useState(null);
  const abortRef = useRef(null);

  const serverProjects = useMemo(
    () => projects.filter((project) => !domain?.serverId || !project?.serverId || project.serverId === domain.serverId),
    [projects, domain?.serverId],
  );

  const refreshProjects = useCallback(async () => {
    if (!editable || typeof loadProjects !== 'function') return;
    abortRef.current?.abort();
    const controller = new AbortController();
    abortRef.current = controller;
    setProjectsStatus('loading');
    setBuilderError(null);
    try {
      const result = await loadProjects({ signal: controller.signal });
      if (controller.signal.aborted) return;
      const list = Array.isArray(result) ? result : (Array.isArray(result?.data) ? result.data : []);
      setProjects(list);
      setProjectsStatus('ready');
    } catch (failure) {
      if (controller.signal.aborted || failure?.name === 'AbortError') return;
      setProjectsStatus('error');
      setBuilderError(aliasErrorMessage(failure));
    }
  }, [editable, loadProjects]);

  useEffect(() => {
    if (!editable || Array.isArray(initialProjects)) return undefined;
    refreshProjects();
    return () => abortRef.current?.abort();
  }, [editable, initialProjects, refreshProjects]);

  const effectiveProjectId = useMemo(() => {
    if (serverProjects.some((item) => item.id === selectedProjectId)) return selectedProjectId;
    return serverProjects[0]?.id ?? '';
  }, [serverProjects, selectedProjectId]);

  const selectedProject = useMemo(
    () => serverProjects.find((item) => item.id === effectiveProjectId) ?? null,
    [serverProjects, effectiveProjectId],
  );

  const slots = useMemo(() => eligibleDockerProxySlots(selectedProject), [selectedProject]);

  const effectiveSlotKey = useMemo(() => {
    if (slots.some((slot) => slot.key === selectedSlotKey)) return selectedSlotKey;
    return slots[0]?.key ?? '';
  }, [slots, selectedSlotKey]);

  const selectedSlot = useMemo(
    () => slots.find((slot) => slot.key === effectiveSlotKey) ?? null,
    [slots, effectiveSlotKey],
  );

  const projectById = useMemo(
    () => new Map(serverProjects.map((project) => [project.id, project])),
    [serverProjects],
  );

  async function addRoute() {
    if (!editable || disabled || resolving) return;
    setBuilderError(null);
    let normalizedPath;
    try {
      normalizedPath = normalizeSubPathRoute(proxyPath);
    } catch (failure) {
      setBuilderError(failure.message);
      return;
    }
    if (activeRoutes.length >= 20) {
      setBuilderError('En fazla 20 alt yol proxy kuralı tanımlanabilir.');
      return;
    }
    const conflict = activeRoutes.find((item) => (
      item.path === normalizedPath
      || item.path.startsWith(`${normalizedPath}/`)
      || normalizedPath.startsWith(`${item.path}/`)
    ));
    if (conflict) {
      setBuilderError(`${normalizedPath} yolu mevcut ${conflict.path} kuralıyla çakışıyor.`);
      return;
    }
    if (!selectedProject || !selectedSlot) {
      setBuilderError('Yönlendirme için yayınlanmış TCP portuna sahip bir Docker Compose servisi seçin.');
      return;
    }
    setResolving(true);
    try {
      const resolved = await resolveRule({
        domainId: domain?.id ?? null,
        hostname: domain?.primaryDomain ?? null,
        projectId: selectedProject.id,
        serviceName: selectedSlot.serviceName,
        innerPort: selectedSlot.targetPort,
        urlPath: normalizedPath,
      });
      const nextRoute = {
        path: resolved.urlPath ?? normalizedPath,
        projectId: resolved.projectId ?? selectedProject.id,
        serviceName: resolved.serviceName ?? selectedSlot.serviceName,
        targetPort: resolved.innerPort ?? selectedSlot.targetPort,
        protocol: 'tcp',
        upstreamHost: resolved.upstreamHost ?? selectedSlot.upstreamHost,
        upstreamPort: resolved.upstreamPort ?? selectedSlot.upstreamPort,
        websocket,
        stripPrefix,
      };
      onChange([...activeRoutes, nextRoute]);
      setProxyPath('');
    } catch (failure) {
      setBuilderError(aliasErrorMessage(failure));
    } finally {
      setResolving(false);
    }
  }

  function removeRoute(index) {
    if (!editable || disabled) return;
    setBuilderError(null);
    onChange(activeRoutes.filter((_, at) => at !== index));
  }

  return (
    <fieldset className="ws-form" aria-label="Alt yol proxy kuralları">
      <legend>Alt yol proxy kuralları</legend>
      <p className="ws-field-hint">
        Alan adı altındaki /api gibi yolları bu sunucudaki Docker Compose servislerine yönlendirin. Değişiklikler Kaydet ve uygula ile kalıcı olarak yayınlanır.
      </p>
      {activeRoutes.length > 0 ? (
        <div className="ws-table-scroll">
          <table className="ws-table">
            <thead>
              <tr>
                <th>URL yolu</th>
                <th>Docker servisi</th>
                <th>Yerel hedef</th>
                <th>Seçenekler</th>
                {editable && <th>İşlem</th>}
              </tr>
            </thead>
            <tbody>
              {activeRoutes.map((route, index) => {
                const project = projectById.get(route.projectId);
                return (
                  <tr key={`${route.path}-${route.projectId}-${route.serviceName}-${route.targetPort}`}>
                    <td><code>{route.path}</code></td>
                    <td>{project?.projectName ?? route.projectId.slice(0, 8)} / {route.serviceName}:{route.targetPort}</td>
                    <td><code>{formatUpstreamAddress(route.upstreamHost, route.upstreamPort)}</code></td>
                    <td>
                      <div className="ws-actions">
                        {route.websocket && <Badge state="active">WebSocket</Badge>}
                        {route.stripPrefix && <Badge state="neutral">Ön ek kaldırılır</Badge>}
                        {!route.websocket && !route.stripPrefix && <span className="ws-muted">Standart</span>}
                      </div>
                    </td>
                    {editable && (
                      <td>
                        <Button
                          variant="danger"
                          disabled={disabled}
                          onClick={() => removeRoute(index)}
                        >
                          Kaldır
                        </Button>
                      </td>
                    )}
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      ) : (
        <EmptyState title="Tanımlı alt yol proxy kuralı yok" />
      )}

      {editable ? (
        <>
          <div className="ws-form-grid">
            <label>
              URL yolu
              <input
                value={proxyPath}
                maxLength="128"
                placeholder="/api"
                spellCheck={false}
                disabled={disabled || resolving}
                onChange={(event) => setProxyPath(event.target.value)}
              />
            </label>
            <label>
              Docker projesi
              <select
                value={effectiveProjectId}
                disabled={disabled || resolving || serverProjects.length === 0}
                onChange={(event) => {
                  setSelectedProjectId(event.target.value);
                  setSelectedSlotKey('');
                }}
              >
                {serverProjects.length === 0 && (
                  <option value="">
                    {projectsStatus === 'loading' ? 'Projeler yükleniyor…' : 'Uygun Docker projesi yok'}
                  </option>
                )}
                {serverProjects.map((project) => (
                  <option key={project.id} value={project.id}>{project.projectName}</option>
                ))}
              </select>
            </label>
            <label>
              Servis ve port
              <select
                value={effectiveSlotKey}
                disabled={disabled || resolving || slots.length === 0}
                onChange={(event) => setSelectedSlotKey(event.target.value)}
              >
                {slots.length === 0 && (
                  <option value="">Yayınlanmış yerel TCP portu yok</option>
                )}
                {slots.map((slot) => (
                  <option key={slot.key} value={slot.key}>
                    {`${slot.serviceName} · :${slot.targetPort} → ${formatUpstreamAddress(slot.upstreamHost, slot.upstreamPort)}`}
                  </option>
                ))}
              </select>
            </label>
          </div>
          <div className="ws-actions">
            <label className="ws-check">
              <input
                type="checkbox"
                checked={websocket}
                disabled={disabled || resolving}
                onChange={(event) => setWebsocket(event.target.checked)}
              />
              WebSocket bağlantıları
            </label>
            <label className="ws-check">
              <input
                type="checkbox"
                checked={stripPrefix}
                disabled={disabled || resolving}
                onChange={(event) => setStripPrefix(event.target.checked)}
              />
              Ön eki kaldır
            </label>
          </div>
          <ErrorNotice error={builderError} />
          <div className="ws-actions">
            <Button
              disabled={disabled || resolving || !selectedProject || !selectedSlot}
              onClick={addRoute}
            >
              {resolving ? 'Doğrulanıyor…' : 'Alt yol kuralı ekle'}
            </Button>
            <Button
              icon="refresh"
              disabled={disabled || resolving || projectsStatus === 'loading'}
              onClick={refreshProjects}
            >
              Projeleri yenile
            </Button>
            <LinkButton to="/docker" icon="layers">Docker Projeleri</LinkButton>
          </div>
        </>
      ) : (
        <p className="ws-field-hint">Alt yol proxy kuralları yalnız sunucu sahibi tarafından yönetilebilir.</p>
      )}
    </fieldset>
  );
}

export default function DomainHostingPanel({ domain }) {
  const { session } = usePanelSession();
  const { canManage, isOwner } = useWorkspace();
  const generation = sessionVersion();
  const identity = JSON.stringify([domain.id, domain.serverId, domain.websiteId, domain.parentDomainId,
    session?.user?.id, session?.user?.role, generation, canManage, isOwner]);
  return <HostingForm key={identity} domain={domain} generation={generation} />;
}
function initialForm(domain) {
  try { return { form: createHostingForm(domain), error: null }; }
  catch (error) { return { form: null, error: aliasErrorMessage(error) }; }
}
function HostingForm({ domain, generation }) {
  const { domains, jobs, canManage, isOwner, resourceBusy, refreshAll, updateJob } = useWorkspace();
  const [initial] = useState(() => initialForm(domain));
  const [form, setForm] = useState(initial.form);
  const [error, setError] = useState(initial.error);
  const [notice, setNotice] = useState(null);
  const [busy, setBusy] = useState(false);
  const [progress, setProgress] = useState(null);
  const [reloadRequired, setReloadRequired] = useState(false);
  const runtime = useRef(null);
  const pending = useRef(false);
  const formRef = useRef(form);
  const reloadRef = useRef(reloadRequired);
  const live = useRef(null);
  live.current = { domain, canManage, domainsStatus: domains.status, jobsStatus: jobs.status,
    resourceBusy: resourceBusy('domain', domain.id) };
  const hintId = useId();
  useEffect(() => {
    const value = { active: true, controller: new AbortController() };
    runtime.current = value;
    return () => { value.active = false; value.controller.abort(); };
  }, []);
  function adopt(value) { formRef.current = value; setForm(value); }
  function requireReload(value) { reloadRef.current = value; setReloadRequired(value); }
  useEffect(() => {
    if (domains.status === 'ready') {
      const next = refreshHostingForm(formRef.current, domain);
      formRef.current = next; setForm(next);
    }
  }, [domain, domains.status]);
  const current = () => runtime.current?.active === true && live.current.canManage
    && sessionVersion() === generation && !sessionTransitionPending();
  const writeBlock = () => hostingWriteBlock({ ...live.current, form: formRef.current, reloadRequired: reloadRef.current });
  const client = useMemo(() => createDomainHostingClient({
    isCurrent: () => runtime.current?.active === true && live.current.canManage
      && sessionVersion() === generation && !sessionTransitionPending(),
    waitForJob,
    onProgress: setProgress,
    observe: job => updateJob(job),
    onSaved: domain => { if (runtime.current?.active) adopt(createHostingForm(domain)); },
    request: (path, options = {}) => {
      // Recheck live collection/job state after the client's verification GET,
      // immediately before each mutation; a disabled button alone is not enough.
      if (options.method === 'PATCH' || path.endsWith('/update-preview')) {
        const reason = hostingWriteBlock({ ...live.current, form: formRef.current, reloadRequired: reloadRef.current });
        if (reason) throw new DomainAliasError('hosting_context_unready', reason, true);
      }
      return panelRequest(path, { ...options, signal: runtime.current?.controller.signal });
    },
  }), [generation]);
  const dirty = hostingFormDirty(form);
  useUnsavedChanges(dirty);
  const blocked = hostingWriteBlock({ ...live.current, form, reloadRequired });
  const pendingPublication = form?.base && (form.base.desiredRevision !== form.base.appliedRevision || form.base.state !== 'active');
  async function perform(action) {
    if (pending.current || !current()) return;
    pending.current = true; setBusy(true); setError(null); setNotice(null);
    try { await action(); }
    catch (failure) {
      if (current()) {
        setError(aliasErrorMessage(failure));
        if (failure.needsReload || ['alias_stale', 'domain_update_preview_stale', 'hosting_context_changed'].includes(failure.code)) requireReload(true);
      }
    } finally {
      pending.current = false;
      if (runtime.current?.active) setBusy(false);
    }
  }
  function updateProxyRoutes(nextRoutes) {
    if (pending.current || !current() || !formRef.current) return;
    const nextSettings = { ...formRef.current.values.nginxSettings };
    if (nextRoutes.length > 0) {
      nextSettings.proxyRoutes = nextRoutes;
    } else if (Object.hasOwn(formRef.current.base.nginxSettings, 'proxyRoutes')) {
      nextSettings.proxyRoutes = Array.isArray(formRef.current.base.nginxSettings.proxyRoutes) ? [] : null;
    } else {
      delete nextSettings.proxyRoutes;
    }
    edit('nginxSettings', nextSettings);
  }
  function edit(field, value) {
    if (pending.current || !current() || !formRef.current) return;
    adopt(editHostingForm(formRef.current, field, value));
    setError(null); setNotice(null);
  }
  function reset() {
    if (pending.current || !current() || !formRef.current) return;
    adopt(createHostingForm(formRef.current.base)); setError(null); setNotice(null);
  }
  function reload() {
    perform(async () => {
      const value = await panelRequest(`/domains/${encodeURIComponent(domain.id)}`, { signal: runtime.current?.controller.signal });
      if (!current()) return;
      const hadDraft = hostingFormDirty(formRef.current);
      adopt(reloadHostingForm(formRef.current, value, live.current.domain));
      requireReload(false);
      setNotice(hadDraft ? 'Güncel kayıt yüklendi. Değiştirdiğiniz tercihler korundu; kaydetmeden önce yeniden inceleyin.' : 'Güncel kayıt yüklendi.');
      refreshAll();
    });
  }
  function save(event) {
    event.preventDefault();
    if (pending.current || !current() || writeBlock() || (!hostingFormDirty(formRef.current) && !pendingPublication)) return;
    perform(async () => {
      let result;
      if (hostingFormDirty(formRef.current)) {
        const preview = await client.preview(formRef.current.base, formRef.current.values);
        if (!current() || writeBlock()) return;
        result = await client.save(preview, { apply: true });
      } else result = await client.apply(formRef.current.base);
      if (!current()) return;
      adopt(createHostingForm(result.domain)); requireReload(false);
      setNotice('Barındırma ayarları uygulandı.'); refreshAll();
    });
  }
  return <>
    <Section title="Barındırma ayarları" description="Sitenin yönlendirme, yükleme ve web sunucusu tercihlerini tek seferde kaydedip uygulayın."
      actions={<Button icon="refresh" disabled={busy || !canManage} onClick={reload}>Güncel kaydı yükle</Button>}>
      <div className="ws-section-body">
        <CollectionNotice resource={jobs} label="Site işlemleri" />
        <ErrorNotice error={error} />
        {notice && <div className="ws-notice" role="status">{notice}</div>}
        {blocked && <p className="ws-notice ws-notice-warn" role="status">{blocked}</p>}
        {form && <form className="ws-form" onSubmit={save} aria-describedby={hintId}>
          {form.base.targetType === 'redirect' ? <RedirectTargetFields target={form.values.target}
            disabled={busy || !canManage || form.base.state === 'suspended'} onChange={value => edit('target', value)} /> : <>
          <label className="ws-check"><input type="checkbox" checked={form.values.httpsRedirect}
            disabled={busy || !canManage || form.base.state === 'suspended' || (form.base.httpsMode !== 'managed' && !form.values.httpsRedirect)}
            onChange={(event) => edit('httpsRedirect', event.target.checked)} />HTTP → HTTPS yönlendirmesi</label>
          <label className="ws-check"><input type="checkbox" checked={form.values.canonicalRedirect}
            disabled={busy || !canManage || form.base.state === 'suspended'}
            onChange={(event) => edit('canonicalRedirect', event.target.checked)} />Ek alan adlarını {form.values.nginxSettings.preferredDomain ?? form.base.primaryDomain} adresine yönlendir</label>
          <p id={hintId} className="ws-field-hint">Ayarlar yalnız {form.base.primaryDomain} sitesine uygulanır.</p>
          {form.base.httpsMode !== 'managed' && <p className="ws-notice ws-notice-warn">HTTP → HTTPS yönlendirmesinden önce SSL/TLS ekranında HTTPS yapılandırın.</p>}
          {form.base.httpsMode === 'managed' && form.values.httpsRedirect && !form.base.certificateId
            && <p className="ws-notice ws-notice-warn">SSL sertifikası bağlı değil. Bu tercihin kaydedilmesi HTTPS erişiminin hazır olduğunu göstermez.</p>}
          <NginxSettingsFields domainNames={[form.base.primaryDomain, ...form.base.aliases]} targetType={form.base.targetType} settings={form.values.nginxSettings}
            disabled={busy || !canManage || form.base.state === 'suspended'} onChange={value => edit('nginxSettings', value)} />
          <NginxSubPathProxyBuilder
            domain={form.base}
            routes={form.values.nginxSettings.proxyRoutes ?? []}
            disabled={busy || !canManage || !isOwner || form.base.state === 'suspended'}
            isOwner={isOwner}
            onChange={updateProxyRoutes}
          />
          </>}
          <div className="ws-actions">
            <Button type="submit" variant="primary" disabled={busy || Boolean(blocked) || (!dirty && !pendingPublication)}>{busy ? 'Ayarlar uygulanıyor…' : 'Kaydet ve uygula'}</Button>
            <Button disabled={busy || !canManage || !dirty} onClick={reset}>Değişiklikleri iptal et</Button>
          </div>
        </form>}
        {form && form.base.targetType !== 'redirect' && <ProtectedPathUsers domainId={domain.id} savedPaths={form.base.nginxSettings.protectedPaths}
          disabled={busy || !canManage || form.base.state === 'suspended'} />}
        {busy && <p role="status">{progress?.phase === 'stage' ? 'Yapılandırma kontrol ediliyor…' : progress?.phase === 'activate' ? 'Ayarlar siteye uygulanıyor…' : 'Ayarlar kaydediliyor…'}</p>}
        <div className="ws-actions"><Badge state={pendingPublication ? 'staged' : 'active'}>{pendingPublication ? 'Yayına uygulanmayı bekliyor' : 'Yayında (Güncel)'}</Badge></div>
        <p className="ws-muted">{!form ? 'Yayın durumu doğrulanamadı.' : pendingPublication
          ? 'Önceki ayar değişikliği tamamlanmamış. Kaydet ve uygula ile devam edebilirsiniz.' : 'Site güncel barındırma ayarlarını kullanıyor.'}</p>
        <div className="ws-actions">
          <LinkButton to={siteHref(domain.id, 'ssl')}>SSL/TLS Sertifikaları</LinkButton>
        </div>
        {dirty && <p className="ws-muted">Sayfadan ayrılmadan önce taslağı kaydedin veya değişiklikleri iptal edin.</p>}
        <details className="ws-section ws-disclosure"><summary>Tanılama ve teknik yayın bilgileri</summary><KeyValues items={[
          ['Alan adı kimliği', domain.id],
          ['Hedef revizyon', form?.base?.desiredRevision ?? '—'],
          ['Uygulanan revizyon', form?.base?.appliedRevision ?? '—'],
        ]}/></details>
      </div>
    </Section>
  </>;
}
