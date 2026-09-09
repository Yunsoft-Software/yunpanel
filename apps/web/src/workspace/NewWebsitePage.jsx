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
  const [form, setForm] = useState({ mode: parentId ? 'subdomain' : 'domain', parentDomainId: parentId, serverId: '', prefix: '', primaryDomain: '', aliases: '', runtime: 'node', applicationId: '', targetType: 'proxy', targetValue: '', httpsMode: 'managed' });
  const [dirty, setDirty] = useState(false); const [busy, setBusy] = useState(false); const [error, setError] = useState(null); const [created, setCreated] = useState(null);
  const pending = useRef(false); const requests = useRef(null);
  useEffect(() => { const controller = new AbortController(); requests.current = controller; return () => controller.abort(); }, []);
  useUnsavedChanges(dirty && !created);
  const parent = domains.items.find((item) => item.id === form.parentDomainId);
  const serverId = form.mode === 'subdomain' ? parent?.serverId : form.serverId || (servers.items.length === 1 ? servers.items[0].id : '');
  const eligible = applications.items.filter((app) => app.serverId === serverId && app.type === 'node' && Number.isInteger(app.runtime?.port));
  const baseLocked = busy || domains.status !== 'ready' || servers.status !== 'ready';
  const locked = baseLocked || (form.runtime === 'node' && applications.status !== 'ready');
  function update(key, value) { setDirty(true); setForm((current) => ({ ...current, [key]: value, ...(['serverId', 'parentDomainId', 'mode', 'runtime'].includes(key) ? { applicationId: '' } : {}) })); }
  async function submit(event) {
    event.preventDefault(); if (locked || pending.current) return;
    pending.current = true; setBusy(true); setError(null);
    try {
      const selected = eligible.find((app) => app.id === form.applicationId);
      if (form.runtime === 'node' && !selected) throw new Error('Bu sunucudaki Node.js uygulamasını seçin.');
      const input = { ...form, serverId, targetType: form.runtime === 'static' ? 'static' : 'proxy', targetValue: form.runtime === 'node' ? String(selected.runtime.port) : form.targetValue };
      const body = domainCreatePayload(input, domains.items, servers.items);
      if (body.targetType === 'static' && (!body.target.root.startsWith('/') || body.target.root.includes('\0'))) throw new Error('Statik site için mutlak bir document root yolu girin.');
      const result = await panelRequest('/domains', { method: 'POST', body, signal: requests.current.signal });
      setCreated(result); setDirty(false); refreshAll();
    } catch (failure) { if (failure.name !== 'AbortError') setError(failure.message); }
    finally { pending.current = false; if (!requests.current.signal.aborted) setBusy(false); }
  }
  return <>
    <nav className="ws-breadcrumb" aria-label="Konum"><Link to="/websites">Web siteleri</Link><span>/</span><span>Yeni kayıt</span></nav>
    <PageHeading title={form.mode === 'subdomain' ? 'Alt alan adı ekle' : 'Web sitesi ekle'} description="Alan adını seçin, çalışan uygulama veya dosya hedefine bağlayın ve HTTPS tercihini belirleyin." />
    {created ? <Section title="Site kaydı oluşturuldu"><EmptyState icon="check" title={created.primaryDomain} detail="Kayıt taslak olarak oluşturuldu. DNS kayıtlarını hazırlayın; ardından Nginx yapılandırmasını ve SSL’i site içinden etkinleştirin." action={<LinkButton variant="primary" icon="arrow" to={siteHref(created.id, 'domains')}>Siteyi yapılandır</LinkButton>} /></Section> : <Section title="Site yapılandırması" description="Mevcut uygulama, alan adı ve sertifika kayıtları korunur.">
      <CollectionNotice resource={domains} label="Alan adları" /><CollectionNotice resource={servers} label="Sunucular" />{form.runtime === 'node' && <CollectionNotice resource={applications} label="Uygulamalar" />}
      <form className="ws-form" onSubmit={submit}><ErrorNotice error={error} /><fieldset disabled={baseLocked}>
        <h3>1. Alan adı</h3><div className="ws-form-grid" style={{ marginTop: 16 }}>
          <label>Kayıt türü<select value={form.mode} onChange={(event) => update('mode', event.target.value)}><option value="domain">Bağımsız alan adı</option><option value="subdomain">Alt alan adı</option></select></label>
          {form.mode === 'subdomain' ? <><label>Üst alan adı<select value={form.parentDomainId} required onChange={(event) => update('parentDomainId', event.target.value)}><option value="">Alan adı seçin</option>{domains.items.map((item) => <option key={item.id} value={item.id}>{item.primaryDomain}</option>)}</select></label><label>Alt alan adı<input value={form.prefix} required placeholder="api" autoCapitalize="none" spellCheck={false} onChange={(event) => update('prefix', event.target.value)} /><span className="ws-field-hint">{parent ? `${form.prefix.trim() || 'api'}.${parent.primaryDomain}` : 'Önce üst alan adını seçin.'}</span></label></> : <><label>Alan adı<input value={form.primaryDomain} required placeholder="example.com" autoCapitalize="none" spellCheck={false} onChange={(event) => update('primaryDomain', event.target.value)} /></label><label>Sunucu<select value={serverId} required onChange={(event) => update('serverId', event.target.value)}><option value="">Sunucu seçin</option>{servers.items.map((item) => <option key={item.id} value={item.id}>{item.displayName ?? item.name ?? item.hostname}</option>)}</select></label></>}
          <label>Aliaslar<input value={form.aliases} placeholder="www.example.com" onChange={(event) => update('aliases', event.target.value)} /><span className="ws-field-hint">Virgülle ayırın. Aliaslar aynı hedefi kullanır; bağımsız site oluşturmaz.</span></label>
        </div>
        <div className="ws-form-divider" style={{ marginTop: 24 }}><h3>2. Yayın hedefi</h3><div className="ws-form-grid" style={{ marginTop: 16 }}>
          <label>Uygulama türü<select value={form.runtime} onChange={(event) => update('runtime', event.target.value)}><option value="node">Mevcut Node.js uygulaması</option><option value="static">Statik dosyalar</option><option value="proxy">Gelişmiş: yerel proxy</option></select></label>
          {form.runtime === 'node' ? <label>Node.js uygulaması<select value={form.applicationId} required onChange={(event) => update('applicationId', event.target.value)}><option value="">Uygulama seçin</option>{eligible.map((app) => <option key={app.id} value={app.id}>{app.name} · Node {app.runtime.nodeMajor} · port {app.runtime.port}</option>)}</select><span className="ws-field-hint">Port seçilen kayıttan alınır. Uygulama çalışır durumda olmalıdır; otomatik deploy yapılmaz.</span></label> : <label>{form.runtime === 'static' ? 'Document root' : 'Yerel uygulama portu'}<input type={form.runtime === 'proxy' ? 'number' : 'text'} min={form.runtime === 'proxy' ? 1024 : undefined} max={form.runtime === 'proxy' ? 65535 : undefined} value={form.targetValue} required placeholder={form.runtime === 'static' ? '/var/www/example/public' : '4301'} onChange={(event) => update('targetValue', event.target.value)} /></label>}
        </div>{form.runtime === 'node' && !eligible.length && <p className="ws-muted">Bu sunucuda uygun uygulama bulunmuyor. <Link to="/applications/new">Önce Node.js uygulaması oluşturun.</Link></p>}</div>
        <div className="ws-form-divider" style={{ marginTop: 24 }}><h3>3. HTTPS</h3><label style={{ marginTop: 16 }}>Sertifika yönetimi<select value={form.httpsMode} onChange={(event) => update('httpsMode', event.target.value)}><option value="managed">Yönetilen HTTPS — sertifika daha sonra istenir</option><option value="off">Şimdilik HTTP</option></select><span className="ws-field-hint">Kayıt oluşturmak sertifika üretmez. DNS ve Nginx doğrulandıktan sonra SSL sekmesinden isteyin.</span></label></div>
        <footer className="ws-form-footer" style={{ marginTop: 24 }}><LinkButton to="/websites">Vazgeç</LinkButton><Button type="submit" variant="primary" icon="plus" disabled={locked || !serverId || (form.runtime === 'node' && !form.applicationId)}>{busy ? 'Oluşturuluyor…' : 'Site kaydını oluştur'}</Button></footer>
      </fieldset></form>
    </Section>}
  </>;
}
