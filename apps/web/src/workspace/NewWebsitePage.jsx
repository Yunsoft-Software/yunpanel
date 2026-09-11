import { useEffect, useRef, useState } from 'react';
import { Link, useSearchParams } from 'react-router';
import { panelRequest } from '../api.js';
import { domainCreatePayload } from '../domain-form.js';
import { useWorkspace } from './WorkspaceContext.jsx';
import { useUnsavedChanges } from './UnsavedChanges.jsx';
import { Button, CollectionNotice, EmptyState, ErrorNotice, LinkButton, PageHeading, Section } from './PanelKit.jsx';
import { siteHref } from './site-model.js';

export default function NewWebsitePage() {
  const [params] = useSearchParams();
  return <WebsiteForm key={params.get('parent') ?? 'root'} parentId={params.get('parent') ?? ''} />;
}
function WebsiteForm({ parentId }) {
  const { domains, servers, applications, refreshAll } = useWorkspace();
  const [form, setForm] = useState({ mode: parentId ? 'subdomain' : 'domain', parentDomainId: parentId, prefix: '', primaryDomain: '', wwwMode: 'none', runtime: 'node', applicationId: '', targetValue: '', httpsMode: 'managed' });
  const [operationId] = useState(() => crypto.randomUUID());
  const [dirty, setDirty] = useState(false); const [busy, setBusy] = useState(false); const [error, setError] = useState(null); const [created, setCreated] = useState(null);
  const pending = useRef(false); const requests = useRef(null);
  useEffect(() => { const controller = new AbortController(); requests.current = controller; return () => controller.abort(); }, []);
  useUnsavedChanges(dirty && !created);
  const parent = domains.items.find((item) => item.id === form.parentDomainId);
  const serverId = servers.items.length === 1 ? servers.items[0].id : '';
  const eligible = applications.items.filter((app) => app.serverId === serverId && app.type === form.runtime);
  const baseLocked = busy || domains.status !== 'ready' || servers.status !== 'ready';
  const locked = baseLocked || (form.runtime !== 'proxy' && applications.status !== 'ready');
  function update(key, value) { setDirty(true); setForm((current) => ({ ...current, [key]: value, ...(['parentDomainId', 'mode', 'runtime'].includes(key) ? { applicationId: '' } : {}) })); }
  async function submit(event) {
    event.preventDefault(); if (locked || pending.current) return;
    pending.current = true; setBusy(true); setError(null);
    try {
      const selected = eligible.find((app) => app.id === form.applicationId);
      if (form.runtime !== 'proxy' && !selected) throw new Error('Bu yerel sunucudaki uygulamayı seçin.');
      const domain = domainCreatePayload({
        ...form,
        serverId,
        aliases: '',
        targetType: 'proxy',
        targetValue: form.runtime === 'proxy' ? form.targetValue : '4301',
      }, domains.items, servers.items);
      const input = {
        operationId,
        serverId,
        name: domain.primaryDomain,
        primaryDomain: domain.primaryDomain,
        parentDomainId: domain.parentDomainId,
        wwwMode: form.mode === 'subdomain' ? 'none' : form.wwwMode,
        httpsMode: form.httpsMode,
        source: form.runtime === 'proxy'
          ? { kind: 'external_proxy', target: { host: '127.0.0.1', port: Number(form.targetValue), websocket: true } }
          : { kind: 'existing_application', applicationId: selected.id },
      };
      const preview = await panelRequest('/sites/create-preview', { method: 'POST', body: { input }, signal: requests.current.signal });
      const result = await panelRequest('/sites', {
        method: 'POST', body: { input, previewDigest: preview.previewDigest, confirmation: preview.confirmation }, signal: requests.current.signal,
      });
      setCreated(result.primaryDomain); setDirty(false); refreshAll();
    } catch (failure) { if (failure.name !== 'AbortError') setError(failure.message); }
    finally { pending.current = false; if (!requests.current.signal.aborted) setBusy(false); }
  }
  return <>
    <nav className="ws-breadcrumb" aria-label="Konum"><Link to="/websites">Web siteleri</Link><span>/</span><span>Yeni kayıt</span></nav>
    <PageHeading title={form.mode === 'subdomain' ? 'Alt alan adı ekle' : 'Web sitesi ekle'} description="Alan adını seçin, çalışan uygulama veya dosya hedefine bağlayın ve HTTPS tercihini belirleyin." />
    {created ? <Section title="Site kaydı oluşturuldu"><EmptyState icon="check" title={created.primaryDomain} detail="Kayıt taslak olarak oluşturuldu. DNS kayıtlarını hazırlayın; ardından Nginx yapılandırmasını ve SSL’i site içinden etkinleştirin." action={<LinkButton variant="primary" icon="arrow" to={siteHref(created.id, 'domains')}>Siteyi yapılandır</LinkButton>} /></Section> : <Section title="Site yapılandırması" description="Mevcut uygulama, alan adı ve sertifika kayıtları korunur.">
      <CollectionNotice resource={domains} label="Alan adları" /><CollectionNotice resource={servers} label="Yerel sunucu" />{form.runtime !== 'proxy' && <CollectionNotice resource={applications} label="Uygulamalar" />}
      <form className="ws-form" onSubmit={submit}><ErrorNotice error={error} /><fieldset disabled={baseLocked}>
        <h3>1. Alan adı</h3><div className="ws-form-grid" style={{ marginTop: 16 }}>
          <label>Kayıt türü<select value={form.mode} onChange={(event) => update('mode', event.target.value)}><option value="domain">Bağımsız alan adı</option><option value="subdomain">Alt alan adı</option></select></label>
          {form.mode === 'subdomain' ? <><label>Üst alan adı<select value={form.parentDomainId} required onChange={(event) => update('parentDomainId', event.target.value)}><option value="">Alan adı seçin</option>{domains.items.map((item) => <option key={item.id} value={item.id}>{item.primaryDomain}</option>)}</select></label><label>Alt alan adı<input value={form.prefix} required placeholder="api" autoCapitalize="none" spellCheck={false} onChange={(event) => update('prefix', event.target.value)} /><span className="ws-field-hint">{parent ? `${form.prefix.trim() || 'api'}.${parent.primaryDomain}` : 'Önce üst alan adını seçin.'}</span></label></> : <label>Alan adı<input value={form.primaryDomain} required placeholder="example.com" autoCapitalize="none" spellCheck={false} onChange={(event) => update('primaryDomain', event.target.value)} /></label>}
          {form.mode === 'domain' && <label>www davranışı<select value={form.wwwMode} onChange={(event) => update('wwwMode', event.target.value)}><option value="none">www kaydı oluşturma</option><option value="alias">www aynı siteye alias olsun</option><option value="independent">www bağımsız alt alan adı olsun</option></select></label>}
        </div>
        <div className="ws-form-divider" style={{ marginTop: 24 }}><h3>2. Yayın hedefi</h3><div className="ws-form-grid" style={{ marginTop: 16 }}>
          <label>Uygulama türü<select value={form.runtime} onChange={(event) => update('runtime', event.target.value)}><option value="node">Mevcut Node.js uygulaması</option><option value="static">Mevcut statik uygulama</option><option value="proxy">Gelişmiş: yerel proxy</option></select></label>
          {form.runtime !== 'proxy' ? <label>{form.runtime === 'node' ? 'Node.js uygulaması' : 'Statik uygulama'}<select value={form.applicationId} required onChange={(event) => update('applicationId', event.target.value)}><option value="">Uygulama seçin</option>{eligible.map((app) => <option key={app.id} value={app.id}>{app.name}{app.type === 'node' ? ` · Node ${app.runtime.nodeMajor} · port ${app.runtime.port}` : ` · ${app.build?.outputDir ?? 'build'}`}</option>)}</select><span className="ws-field-hint">Kalıcı Website kimliği seçilen uygulamaya bağlanır; otomatik deploy yapılmaz.</span></label> : <label>Yerel uygulama portu<input type="number" min={1024} max={65535} value={form.targetValue} required placeholder="4301" onChange={(event) => update('targetValue', event.target.value)} /></label>}
        </div>{form.runtime !== 'proxy' && !eligible.length && <p className="ws-muted">Bu sunucuda uygun uygulama bulunmuyor. <Link to="/applications/new">Önce uygulama oluşturun.</Link></p>}</div>
        <div className="ws-form-divider" style={{ marginTop: 24 }}><h3>3. HTTPS</h3><label style={{ marginTop: 16 }}>Sertifika yönetimi<select value={form.httpsMode} onChange={(event) => update('httpsMode', event.target.value)}><option value="managed">Yönetilen HTTPS — sertifika daha sonra istenir</option><option value="off">Şimdilik HTTP</option></select><span className="ws-field-hint">Kayıt oluşturmak sertifika üretmez. DNS ve Nginx doğrulandıktan sonra SSL sekmesinden isteyin.</span></label></div>
        <footer className="ws-form-footer" style={{ marginTop: 24 }}><LinkButton to="/websites">Vazgeç</LinkButton><Button type="submit" variant="primary" icon="plus" disabled={locked || !serverId || (form.runtime !== 'proxy' && !form.applicationId)}>{busy ? 'Oluşturuluyor…' : 'Siteyi oluştur'}</Button></footer>
      </fieldset></form>
    </Section>}
  </>;
}
