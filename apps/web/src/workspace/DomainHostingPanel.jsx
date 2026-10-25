import { useEffect, useId, useMemo, useRef, useState } from 'react';
import { panelRequest, waitForJob } from '../api.js';
import { usePanelSession } from '../panel-session.jsx';
import { sessionTransitionPending, sessionVersion } from '../session-client.js';
import { useWorkspace } from './WorkspaceContext.jsx';
import { Badge, Button, CollectionNotice, ErrorNotice, KeyValues, LinkButton, Section } from './PanelKit.jsx';
import { siteHref } from './site-model.js';
import { useUnsavedChanges } from './UnsavedChanges.jsx';
import { DomainAliasError, aliasErrorMessage } from './domain-alias-model.js';
import { createDomainHostingClient } from './domain-hosting-client.js';
import { createHostingForm, editHostingForm, hostingFormDirty, hostingWriteBlock, refreshHostingForm, reloadHostingForm } from './domain-hosting-form.js';
import NginxSettingsFields from './NginxSettingsFields.jsx';

export const JAMSTACK_FRAMEWORK_PRESETS = [
  { id: 'nextjs', label: 'Next.js', path: '/api', innerPort: '3000', outerPort: '127.0.0.1:13000', websocket: true },
  { id: 'astro', label: 'Astro', path: '/api', innerPort: '4321', outerPort: '127.0.0.1:14321', websocket: false },
  { id: 'vite', label: 'Vite', path: '/api', innerPort: '8080', outerPort: '127.0.0.1:18080', websocket: true },
  { id: 'nuxt', label: 'Nuxt', path: '/api', innerPort: '3000', outerPort: '127.0.0.1:13001', websocket: true },
  { id: 'remix', label: 'Remix', path: '/ws', innerPort: '3000', outerPort: '127.0.0.1:13002', websocket: true },
  { id: 'node', label: 'Node.js', path: '/api', innerPort: '4000', outerPort: '127.0.0.1:14000', websocket: true },
  { id: 'python', label: 'Python', path: '/api', innerPort: '8000', outerPort: '127.0.0.1:18000', websocket: true },
];

export function buildNginxSubPathLocationBlock({
  path = '/api',
  innerPort = '3000',
  outerPort = '127.0.0.1:13000',
  websocket = true,
} = {}) {
  const rawPath = String(path ?? '/api').trim();
  if (!rawPath || /[\s;{}'"\\$\r\n\0]/.test(rawPath) || rawPath.includes('..')) {
    throw new Error('Geçersiz Nginx alt yol (location) ifadesi.');
  }
  const normalizedPath = rawPath.startsWith('/') ? rawPath : `/${rawPath}`;

  const cleanInnerNum = Number(String(innerPort ?? '3000').trim());
  if (!Number.isInteger(cleanInnerNum) || cleanInnerNum < 1 || cleanInnerNum > 65535) {
    throw new Error('Inner (Konteyner) portu 1–65535 aralığında olmalıdır.');
  }

  const rawOuter = String(outerPort ?? '127.0.0.1:13000').trim();
  const upstreamHost = rawOuter.includes(':') ? rawOuter : `127.0.0.1:${rawOuter}`;
  const [hostPart, portPart, ...extraParts] = upstreamHost.split(':');
  const outerPortNum = Number(portPart);
  if (
    extraParts.length > 0
    || !hostPart
    || !/^[a-zA-Z0-9._-]+$/.test(hostPart)
    || !Number.isInteger(outerPortNum)
    || outerPortNum < 1
    || outerPortNum > 65535
  ) {
    throw new Error('Outer (Yerel Host) adresi geçerli bir host:port (1–65535) olmalıdır.');
  }

  const lines = [
    `# Alt yol yönlendirmesi: ${normalizedPath} -> Konteyner :${cleanInnerNum} (Host ${hostPart}:${outerPortNum})`,
    `location ${normalizedPath} {`,
    `    proxy_pass http://${hostPart}:${outerPortNum};`,
    `    proxy_http_version 1.1;`,
    `    proxy_set_header Host $host;`,
    `    proxy_set_header X-Real-IP $remote_addr;`,
    `    proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;`,
    `    proxy_set_header X-Forwarded-Proto $scheme;`,
  ];
  if (websocket) {
    lines.push(
      `    proxy_set_header Upgrade $http_upgrade;`,
      `    proxy_set_header Connection "upgrade";`,
    );
  }
  lines.push('}');
  return lines.join('\n');
}

export function NginxSubPathProxyBuilder({ domain }) {
  const [proxyPath, setProxyPath] = useState('/api');
  const [innerPort, setInnerPort] = useState('3000');
  const [outerPort, setOuterPort] = useState(
    domain?.target?.upstreamPort ? `127.0.0.1:${domain.target.upstreamPort}` : '127.0.0.1:13000',
  );
  const [websocket, setWebsocket] = useState(true);
  const [activeFramework, setActiveFramework] = useState('nextjs');

  function applyFrameworkPreset(preset) {
    setActiveFramework(preset.id);
    setProxyPath(preset.path);
    setInnerPort(preset.innerPort);
    setOuterPort(preset.outerPort);
    setWebsocket(preset.websocket);
  }

  let locationPreview = '';
  let previewError = null;
  try {
    locationPreview = buildNginxSubPathLocationBlock({
      path: proxyPath,
      innerPort,
      outerPort,
      websocket,
    });
  } catch (err) {
    previewError = err.message;
  }

  return (
    <Section
      title="Nginx Reverse Proxy & Alt Yol (Location) Kuralları"
      description="Aynı alan adı altında /api, /ws veya alt yolları yerel Docker konteynerlerine veya mikroservis portlarına yönlendirin."
      actions={<LinkButton to="/docker" icon="layers">Docker Stack Bağla</LinkButton>}
    >
      <div className="ws-section-body">
        <div className="ws-actions" role="group" aria-label="JAMstack ve Framework Ön-Ayarları">
          {JAMSTACK_FRAMEWORK_PRESETS.map(preset => (
            <Button
              key={preset.id}
              variant={activeFramework === preset.id ? 'primary' : 'default'}
              onClick={() => applyFrameworkPreset(preset)}
            >
              {preset.label}
            </Button>
          ))}
        </div>
        <div className="ws-form-grid">
          <label>
            URL Yolu
            <input
              value={proxyPath}
              maxLength="96"
              placeholder="/api"
              spellCheck={false}
              onChange={event => setProxyPath(event.target.value)}
            />
          </label>
          <label>
            Inner / Konteyner Portu
            <input
              value={innerPort}
              maxLength="16"
              placeholder="3000"
              spellCheck={false}
              onChange={event => setInnerPort(event.target.value)}
            />
          </label>
          <label>
            Outer / Yerel Host Portu
            <input
              value={outerPort}
              maxLength="64"
              placeholder="127.0.0.1:13000"
              spellCheck={false}
              onChange={event => setOuterPort(event.target.value)}
            />
          </label>
        </div>
        <label className="ws-check">
          <input
            type="checkbox"
            checked={websocket}
            onChange={event => setWebsocket(event.target.checked)}
          />
          WebSocket (Upgrade)
        </label>
        <ErrorNotice error={previewError} />
        <pre className="ws-code-block" aria-label="Nginx location bloğu önizlemesi">
          <code>{previewError ? `# Hata: ${previewError}` : locationPreview}</code>
        </pre>
      </div>
    </Section>
  );
}

export default function DomainHostingPanel({ domain }) {
  const { session } = usePanelSession();
  const { canManage } = useWorkspace();
  const generation = sessionVersion();
  const identity = JSON.stringify([domain.id, domain.serverId, domain.websiteId, domain.parentDomainId,
    session?.user?.id, session?.user?.role, generation, canManage]);
  return <HostingForm key={identity} domain={domain} generation={generation} />;
}
function initialForm(domain) {
  try { return { form: createHostingForm(domain), error: null }; }
  catch (error) { return { form: null, error: aliasErrorMessage(error) }; }
}
function HostingForm({ domain, generation }) {
  const { domains, jobs, canManage, resourceBusy, refreshAll, updateJob } = useWorkspace();
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
          <div className="ws-actions">
            <Button type="submit" variant="primary" disabled={busy || Boolean(blocked) || (!dirty && !pendingPublication)}>{busy ? 'Ayarlar uygulanıyor…' : 'Kaydet ve uygula'}</Button>
            <Button disabled={busy || !canManage || !dirty} onClick={reset}>Değişiklikleri iptal et</Button>
          </div>
        </form>}
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
    <NginxSubPathProxyBuilder domain={domain} />
  </>;
}
