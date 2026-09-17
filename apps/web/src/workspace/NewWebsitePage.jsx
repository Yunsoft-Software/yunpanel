import { useEffect, useRef, useState } from 'react';
import { Link, useSearchParams } from 'react-router';
import { panelRequest } from '../api.js';
import { domainCreatePayload } from '../domain-form.js';
import { useWorkspace } from './WorkspaceContext.jsx';
import { useUnsavedChanges } from './UnsavedChanges.jsx';
import { Button, CollectionNotice, ConfirmDialog, EmptyState, ErrorNotice, LinkButton, PageHeading, Section } from './PanelKit.jsx';
import {
  availableExistingApplications,
  availableSharedWebsites,
  existingApplicationType,
  sharedDomainCreateInput,
  sharedWebsiteConfirmation,
  siteCreateInputFromForm,
} from './new-website-form.js';
import { siteHref } from './site-model.js';

export default function NewWebsitePage() {
  const [params] = useSearchParams();
  return <WebsiteForm key={params.get('parent') ?? 'root'} parentId={params.get('parent') ?? ''} />;
}
function WebsiteForm({ parentId }) {
  const { domains, websites, servers, applications, refreshAll } = useWorkspace();
  const [form, setForm] = useState({
    mode: parentId ? 'subdomain' : 'domain',
    parentDomainId: parentId,
    prefix: '',
    primaryDomain: '',
    wwwMode: 'none',
    sourceMode: 'new_node',
    applicationId: '',
    websiteId: '',
    repositoryUrl: '',
    branch: 'main',
    entryFile: 'server.js',
    healthPath: '/health',
    outputDir: 'dist',
    targetValue: '',
    httpsMode: 'managed',
  });
  const [operationId] = useState(() => crypto.randomUUID());
  const [dirty, setDirty] = useState(false); const [busy, setBusy] = useState(false); const [error, setError] = useState(null); const [created, setCreated] = useState(null); const [sharedConfirmation, setSharedConfirmation] = useState(null);
  const pending = useRef(false); const requests = useRef(null);
  useEffect(() => { const controller = new AbortController(); requests.current = controller; return () => controller.abort(); }, []);
  useUnsavedChanges(dirty && !created);
  const parent = domains.items.find((item) => item.id === form.parentDomainId);
  const serverId = servers.items.length === 1 ? servers.items[0].id : '';
  const existingType = existingApplicationType(form.sourceMode);
  const eligible = availableExistingApplications({
    applications: applications.items,
    websites: websites.items,
    serverId,
    sourceMode: form.sourceMode,
  });
  const sharedMode = form.sourceMode === 'shared_website';
  const sharedWebsites = availableSharedWebsites({ websites: websites.items, applications: applications.items, serverId });
  const selectedSharedWebsite = sharedWebsites.find((website) => website.id === form.websiteId) ?? null;
  const selectedSharedDomain = selectedSharedWebsite
    ? domains.items.find((item) => item.websiteId === selectedSharedWebsite.id) ?? null
    : null;
  const baseLocked = busy || domains.status !== 'ready' || servers.status !== 'ready';
  const bindingDataPending = (existingType || sharedMode) && (applications.status !== 'ready' || websites.status !== 'ready');
  const locked = baseLocked || Boolean(bindingDataPending);
  function update(key, value) { setDirty(true); setForm((current) => ({ ...current, [key]: value, ...(['parentDomainId', 'mode', 'sourceMode'].includes(key) ? { applicationId: '', websiteId: '' } : {}) })); }
  async function submit(event) {
    event.preventDefault(); if (locked || pending.current) return;
    pending.current = true; setError(null);
    try {
      const selected = eligible.find((app) => app.id === form.applicationId);
      const domain = domainCreatePayload({
        ...form,
        serverId,
        aliases: '',
        targetType: 'proxy',
        targetValue: form.sourceMode === 'external_proxy' ? form.targetValue : '4301',
      }, domains.items, servers.items);
      if (sharedMode) {
        const input = sharedDomainCreateInput({
          domain,
          website: selectedSharedWebsite,
          applications: applications.items,
          wwwMode: form.wwwMode,
        });
        setSharedConfirmation({
          input,
          website: selectedSharedWebsite,
          currentDomain: selectedSharedDomain,
          confirmation: sharedWebsiteConfirmation(input.primaryDomain, input.websiteId),
        });
        return;
      }
      setBusy(true);
      const input = siteCreateInputFromForm({ form, operationId, serverId, domain, selectedApplication: selected });
      const preview = await panelRequest('/sites/create-preview', { method: 'POST', body: { input }, signal: requests.current.signal });
      const result = await panelRequest('/sites', {
        method: 'POST', body: { input, previewDigest: preview.previewDigest, confirmation: preview.confirmation }, signal: requests.current.signal,
      });
      setCreated(result.primaryDomain); setDirty(false); refreshAll();
    } catch (failure) { if (failure.name !== 'AbortError') setError(failure.message); }
    finally { pending.current = false; if (!requests.current.signal.aborted) setBusy(false); }
  }
  async function confirmSharedSite() {
    if (!sharedConfirmation || busy || pending.current) return;
    pending.current = true; setBusy(true); setError(null);
    try {
      const result = await panelRequest('/domains', {
        method: 'POST', body: sharedConfirmation.input, signal: requests.current.signal,
      });
      setCreated(result); setSharedConfirmation(null); setDirty(false); refreshAll();
    } catch (failure) { if (failure.name !== 'AbortError') setError(failure.message); }
    finally { pending.current = false; if (!requests.current.signal.aborted) setBusy(false); }
  }
  return <>
    <nav className="ws-breadcrumb" aria-label="Konum"><Link to="/websites">Web siteleri</Link><span>/</span><span>Yeni kayıt</span></nav>
    <PageHeading title={form.mode === 'subdomain' ? 'Alt alan adı ekle' : 'Web sitesi ekle'} description="Ayrı bir uygulama oluşturun, kullanılmamış bir uygulamayı bağlayın veya açıkça mevcut Website’i paylaşın." />
    {created ? <Section title="Site kaydı oluşturuldu"><EmptyState icon="check" title={created.primaryDomain} detail="Kayıt taslak olarak oluşturuldu. DNS kayıtlarını hazırlayın; ardından Nginx yapılandırmasını ve SSL’i site içinden etkinleştirin." action={<LinkButton variant="primary" icon="arrow" to={siteHref(created.id, 'domains')}>Siteyi yapılandır</LinkButton>} /></Section> : <Section title="Site yapılandırması" description="Bağımsız alan adı ve alt alan adı varsayılan olarak ayrı Website, Application ve Unix kimliği alır.">
      <CollectionNotice resource={domains} label="Alan adları" /><CollectionNotice resource={servers} label="Yerel sunucu" />{(existingType || sharedMode) && <><CollectionNotice resource={applications} label="Uygulamalar" /><CollectionNotice resource={websites} label="Website bağları" /></>}
      <form className="ws-form" onSubmit={submit}><ErrorNotice error={error} /><fieldset disabled={baseLocked}>
        <h3>1. Alan adı</h3><div className="ws-form-grid" style={{ marginTop: 16 }}>
          <label>Kayıt türü<select value={form.mode} onChange={(event) => update('mode', event.target.value)}><option value="domain">Bağımsız alan adı</option><option value="subdomain">Alt alan adı</option></select></label>
          {form.mode === 'subdomain' ? <><label>Üst alan adı<select value={form.parentDomainId} required onChange={(event) => update('parentDomainId', event.target.value)}><option value="">Alan adı seçin</option>{domains.items.map((item) => <option key={item.id} value={item.id}>{item.primaryDomain}</option>)}</select></label><label>Alt alan adı<input value={form.prefix} required placeholder="api" autoCapitalize="none" spellCheck={false} onChange={(event) => update('prefix', event.target.value)} /><span className="ws-field-hint">{parent ? `${form.prefix.trim() || 'api'}.${parent.primaryDomain}` : 'Önce üst alan adını seçin.'}</span></label></> : <label>Alan adı<input value={form.primaryDomain} required placeholder="example.com" autoCapitalize="none" spellCheck={false} onChange={(event) => update('primaryDomain', event.target.value)} /></label>}
          {form.mode === 'domain' && <label>www davranışı<select value={form.wwwMode} onChange={(event) => update('wwwMode', event.target.value)}><option value="none">www kaydı oluşturma</option><option value="alias">www aynı siteye alias olsun</option></select><span className="ws-field-hint">Bağımsız www için bu Website’i oluşturduktan sonra üst alan adı olarak seçip ayrı bir alt alan adı Website’i oluşturun.</span></label>}
        </div>
        <div className="ws-form-divider" style={{ marginTop: 24 }}><h3>2. Yayın hedefi</h3><div className="ws-form-grid" style={{ marginTop: 16 }}>
          <label>Uygulama kaynağı<select value={form.sourceMode} onChange={(event) => update('sourceMode', event.target.value)}><option value="new_node">Yeni Node.js 24 / Passenger uygulaması</option><option value="new_static">Yeni statik uygulama</option><option value="new_php">Yeni PHP-FPM uygulaması</option><option value="existing_node">Kullanılmamış mevcut Node.js uygulaması</option><option value="existing_static">Kullanılmamış mevcut statik uygulama</option><option value="shared_website">Mevcut Website’i paylaş (shared-site)</option><option value="external_proxy">Gelişmiş: yerel proxy</option></select></label>
          {['new_node', 'new_static'].includes(form.sourceMode) && <><label>GitHub repository<input type="url" required placeholder="https://github.com/organization/repository" value={form.repositoryUrl} onChange={(event) => update('repositoryUrl', event.target.value)} /></label><label>Branch<input value={form.branch} required onChange={(event) => update('branch', event.target.value)} /></label></>}
          {form.sourceMode === 'new_node' && <><label>Başlangıç dosyası<input value={form.entryFile} required onChange={(event) => update('entryFile', event.target.value)} /></label><label>Sağlık kontrolü yolu<input value={form.healthPath} required onChange={(event) => update('healthPath', event.target.value)} /></label></>}
          {form.sourceMode === 'new_static' && <label>Build çıktı klasörü<input value={form.outputDir} required onChange={(event) => update('outputDir', event.target.value)} /><span className="ws-field-hint">npm ci ve npm run build kullanılır; index.html sağlık dosyasıdır.</span></label>}
          {existingType && <label>{existingType === 'node' ? 'Node.js uygulaması' : 'Statik uygulama'}<select value={form.applicationId} required onChange={(event) => update('applicationId', event.target.value)}><option value="">Kullanılmamış uygulama seçin</option>{eligible.map((app) => <option key={app.id} value={app.id}>{app.name}{app.type === 'node' ? ` · Node ${app.runtime.nodeMajor}` : ` · ${app.build?.outputDir ?? 'build'}`}</option>)}</select><span className="ws-field-hint">Başka bir Website’e bağlı uygulamalar listelenmez; bir Application iki Website tarafından paylaşılamaz.</span></label>}
          {sharedMode && <label>Paylaşılacak Website<select value={form.websiteId} required onChange={(event) => update('websiteId', event.target.value)}><option value="">Mevcut Website seçin</option>{sharedWebsites.map((website) => { const bound = domains.items.find((item) => item.websiteId === website.id); return <option key={website.id} value={website.id}>{bound?.primaryDomain ?? website.name} · {website.runtimeType} · {website.unixUser ?? 'proxy'}</option>; })}</select><span className="ws-field-hint">Yalnız canonical routing hedefi doğrulanabilen yerel Website’ler gösterilir.</span></label>}
          {form.sourceMode === 'external_proxy' && <label>Yerel uygulama portu<input type="number" min={1024} max={65535} value={form.targetValue} required placeholder="4301" onChange={(event) => update('targetValue', event.target.value)} /></label>}
          {form.sourceMode === 'new_php' && <p className="ws-muted">Ayrı Application, Unix kullanıcısı, PHP-FPM pool/socket ve private site yolları provisioning planına eklenir.</p>}
        </div>{existingType && !eligible.length && applications.status === 'ready' && websites.status === 'ready' && <p className="ws-muted">Bu sunucuda kullanılmamış uygun uygulama bulunmuyor. Yeni Application oluşturma seçeneklerinden birini kullanın.</p>}{sharedMode && !sharedWebsites.length && applications.status === 'ready' && websites.status === 'ready' && <p className="ws-muted">Canonical routing hedefi paylaşılabilecek yerel Website bulunmuyor.</p>}{selectedSharedWebsite && <div className="ws-notice ws-notice-warn"><div><strong>{selectedSharedDomain?.primaryDomain ?? selectedSharedWebsite.name} Website bağı paylaşılacak</strong><p>Website <code>{selectedSharedWebsite.id}</code> · runtime {selectedSharedWebsite.runtimeType} · Unix kullanıcı {selectedSharedWebsite.unixUser ?? 'uygulanamaz'}. Bu seçim yeni Application, Unix user, SFTP scope veya mailbox oluşturmaz.</p></div></div>}</div>
        <div className="ws-form-divider" style={{ marginTop: 24 }}><h3>3. HTTPS</h3><label style={{ marginTop: 16 }}>Sertifika yönetimi<select value={form.httpsMode} onChange={(event) => update('httpsMode', event.target.value)}><option value="managed">Yönetilen HTTPS — sertifika daha sonra istenir</option><option value="off">Şimdilik HTTP</option></select><span className="ws-field-hint">Kayıt oluşturmak sertifika üretmez. DNS ve Nginx doğrulandıktan sonra SSL sekmesinden isteyin.</span></label></div>
        <footer className="ws-form-footer" style={{ marginTop: 24 }}><LinkButton to="/websites">Vazgeç</LinkButton><Button type="submit" variant="primary" icon="plus" disabled={locked || !serverId || (existingType && !form.applicationId) || (sharedMode && !form.websiteId)}>{busy ? 'Oluşturuluyor…' : sharedMode ? 'Website bağını oluştur' : 'Siteyi oluştur'}</Button></footer>
      </fieldset></form>
    </Section>}
    {sharedConfirmation && <ConfirmDialog
      title="Mevcut Website’i paylaş"
      message={`${sharedConfirmation.input.primaryDomain}, ${sharedConfirmation.currentDomain?.primaryDomain ?? sharedConfirmation.website.name} Website kimliğine bağlanacak. Yeni Application, Unix user, runtime, SFTP scope veya mailbox oluşturulmayacak; seçili www kaydı varsa yalnız aynı Domain kaydının alias’ı olacak.`}
      confirmation={sharedConfirmation.confirmation}
      error={error}
      busy={busy}
      onCancel={() => { if (!busy) setSharedConfirmation(null); }}
      onConfirm={confirmSharedSite}
      confirmLabel="Website bağını oluştur"
    />}
  </>;
}
