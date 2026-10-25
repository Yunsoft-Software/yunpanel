import { useEffect, useRef, useState } from 'react';
import { LoginCredentialsFields } from './LoginCredentialsFields.jsx';
import { Link, useSearchParams } from 'react-router';
import { panelRequest } from '../api.js';
import { readHostingPage, readHostingAccount } from './hosting-account-client.js';
import { domainCreatePayload } from '../domain-form.js';
import { usePanelSession } from '../panel-session.jsx';
import { sessionVersion, sessionTransitionPending } from '../session-client.js';
import { useWorkspace } from './WorkspaceContext.jsx';
import { useUnsavedChanges } from './UnsavedChanges.jsx';
import { Button, CollectionNotice, ConfirmDialog, EmptyState, ErrorNotice, FileRootBadge, KeyValues, LinkButton, PageHeading, Section } from './PanelKit.jsx';
import {
  applyFrameworkPresetToForm,
  availableExistingApplications,
  availableSharedWebsites,
  existingApplicationType,
  JAMSTACK_FRAMEWORK_PRESETS,
  resolveSubdomainSharedFileRoot,
  sharedDomainCreateInput,
  sharedWebsiteConfirmation,
  siteCreateInputFromForm,
} from './new-website-form.js';
import { siteHref } from './site-model.js';
import { autoAdvanceWebsiteProvisioning } from './provisioning-client.js';
import { createSiteSubmission, EMPTY_SITE_SUBMISSION, siteSubmissionBusy } from './site-create-submission.js';
import SiteCreateResult, { SiteCreateProgress } from './SiteCreateResult.jsx';

export default function NewWebsitePage() {
  const [params] = useSearchParams();
  const { session } = usePanelSession();
  const parentId = params.get('parent') ?? '';
  const identity = JSON.stringify([parentId, session?.user?.id, session?.user?.role, sessionVersion()]);
  return <WebsiteForm key={identity} parentId={parentId} />;
}
function WebsiteForm({ parentId }) {
  const [params] = useSearchParams();
  const { domains, websites, servers, applications, refreshAll } = useWorkspace();
  const [form, setForm] = useState({
    mode: parentId || params.get('mode') === 'subdomain' ? 'subdomain' : 'domain',
    parentDomainId: parentId,
    prefix: '',
    primaryDomain: '',
    adminEmail: '',
    adminPassword: '',
    wwwMode: 'none',
    sourceMode: 'new_php',
    ownerMode: params.has('customer') ? 'customer' : 'owner',
    customerId: params.get('customer') ?? '',
    applicationId: '',
    websiteId: '',
    repositoryUrl: '',
    branch: 'main',
    entryFile: 'server.js',
    healthPath: '/health',
    outputDir: 'dist',
    targetValue: '',
    dockerProjectId: '',
    dockerServiceName: 'web',
    dockerTargetPort: '8080',
    dockerWorkloadId: '',
    initialDatabase: false,
    httpsMode: 'managed',
    dnsMode: 'local',
    mailMode: parentId ? 'none' : 'local',
  });

  const [step, setStep] = useState(1), [customers, setCustomers] = useState([]), [customerError, setCustomerError] = useState(null);
  useEffect(() => {
    let active = true; const controller = new AbortController();
    async function loadCustomers() {
      const rows = [], seen = new Set(); let offset = 0;
      for (let pageNumber = 0; pageNumber < 100; pageNumber++) {
        const filters = { kind: 'customer', offset, limit: 100 };
        const value = await panelRequest(`/users/hosting/accounts?kind=customer&offset=${offset}&limit=100`, { signal: controller.signal });
        const page = readHostingPage(value, filters);
        for (const account of page.accounts) { if (seen.has(account.id)) throw new Error('Müşteri listesi değişti. Sayfayı yenileyin.'); seen.add(account.id); if (account.active) rows.push(account); }
        if (offset + page.accounts.length >= page.total) break;
        offset += 100;
        if (pageNumber === 99) throw new Error('Müşteri listesini yenileyin veya Müşteriler ekranından ilgili hesaba site ekleyin.');
      }
      const selectedId = params.get('customer');
      if (selectedId && !rows.some(account => account.id === selectedId)) {
        const account = readHostingAccount(await panelRequest(`/users/hosting/accounts/${encodeURIComponent(selectedId)}`, { signal: controller.signal }));
        if (account.kind !== 'customer' || !account.active || account.id !== selectedId) throw new Error('Seçilen müşteri hesabı etkin değil.');
        rows.push(account);
      }
      if (active) setCustomers(rows);
    }
    void loadCustomers().catch(error => { if (active && error.name !== 'AbortError') setCustomerError('Müşteri hesapları okunamadı. Listeyi yenileyip tekrar deneyin.'); });
    return () => { active = false; controller.abort(); };
  }, []);
  const [operationId] = useState(() => crypto.randomUUID());
  const [dirty, setDirty] = useState(false); const [sharedBusy, setSharedBusy] = useState(false); const [error, setError] = useState(null); const [created, setCreated] = useState(null); const [sharedConfirmation, setSharedConfirmation] = useState(null);
  const [submission, setSubmission] = useState(EMPTY_SITE_SUBMISSION);
  const pending = useRef(false); const scope = useRef(null); const sharedResultRef = useRef(null);
  useEffect(() => {
    if (created) sharedResultRef.current?.focus();
  }, [created]);
  useEffect(() => {
    const controller = new AbortController();
    const version = sessionVersion();
    const isCurrent = () => !controller.signal.aborted && version === sessionVersion() && !sessionTransitionPending();
    const flow = createSiteSubmission({
      request: panelRequest, advance: autoAdvanceWebsiteProvisioning, isCurrent,
      onState: (state) => {
        setSubmission(state);
        if (state.created || state.phase === 'uncertain') {
          setDirty(false);
          setForm((value) => ({ ...value, adminPassword: '' }));
        } else if (state.phase === 'error' || state.error) {
          setForm((value) => ({ ...value, adminPassword: '' }));
        }
      },
    });
    scope.current = { flow, isCurrent, signal: controller.signal };
    return () => { flow.dispose(); controller.abort(); };
  }, []);
  const busy = sharedBusy || siteSubmissionBusy(submission);
  const finishedAttempt = Boolean(created || submission.created || submission.phase === 'uncertain');
  useUnsavedChanges(dirty && !finishedAttempt);
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
  const baseLocked = busy || finishedAttempt || domains.status !== 'ready' || servers.status !== 'ready';
  const bindingDataPending = (existingType || sharedMode) && (applications.status !== 'ready' || websites.status !== 'ready');
  const locked = baseLocked || Boolean(bindingDataPending);
  function update(key, value) { setDirty(true); setForm((current) => ({
    ...current,
    [key]: value,
    ...(['parentDomainId', 'mode', 'sourceMode'].includes(key) ? { applicationId: '', websiteId: '' } : {}),
    ...(key === 'mode' && value === 'subdomain' && current.ownerMode === 'new_admin' ? { ownerMode: 'owner', adminPassword: '' } : {}),
  })); }
  function selectFrameworkPreset(presetId) {
    setDirty(true);
    setForm((current) => applyFrameworkPresetToForm(current, presetId));
  }
  async function submit(event) {
    event.preventDefault();
    const current = scope.current;
    if (locked || pending.current || !current?.isCurrent()) return;
    if (step < 3) { setStep(value => value + 1); return; }
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
      const input = siteCreateInputFromForm({ form, operationId, serverId, domain, selectedApplication: selected });
      const state = await current.flow.submit(input, { signal: current.signal, customerId: form.ownerMode === 'customer' ? form.customerId : null });
      if (current.isCurrent() && (state.created || state.phase === 'uncertain')) refreshAll();
    } catch (failure) {
      if (current.isCurrent() && failure.name !== 'AbortError') setError(failure.message);
      setForm((value) => ({ ...value, adminPassword: '' }));
    }
    finally { pending.current = false; }
  }
  async function confirmSharedSite() {
    const current = scope.current;
    if (!sharedConfirmation || locked || pending.current || !current?.isCurrent()) return;
    pending.current = true; setSharedBusy(true); setError(null);
    try {
      const result = await panelRequest('/domains', {
        method: 'POST', body: sharedConfirmation.input, signal: current.signal,
      });
      if (!current.isCurrent()) return;
      setCreated(result); setSharedConfirmation(null); setDirty(false);
      setForm((value) => ({ ...value, adminPassword: '' })); refreshAll();
    } catch (failure) {
      if (current.isCurrent() && failure.name !== 'AbortError') {
        try {
          const list = await panelRequest('/domains', { signal: current.signal });
          const existing = Array.isArray(list)
            ? list.find((item) => item.primaryDomain === sharedConfirmation.input.primaryDomain && item.websiteId === sharedConfirmation.input.websiteId)
            : null;
          if (existing && current.isCurrent()) {
            setCreated(existing);
            setSharedConfirmation(null);
            setDirty(false);
            setForm((value) => ({ ...value, adminPassword: '' }));
            refreshAll();
            return;
          }
        } catch {}
        if (current.isCurrent()) setError(failure.message);
      }
    }
    finally { pending.current = false; if (current.isCurrent()) setSharedBusy(false); }
  }
  return <>
    <nav className="ws-breadcrumb" aria-label="Konum"><Link to="/websites">Web siteleri</Link><span>/</span><span>Yeni kayıt</span></nav>
    <PageHeading title={form.mode === 'subdomain' ? 'Alt alan adı ekle' : 'Web sitesi ekle'} description="Alan adını, site sahibini ve barındırma türünü seçin. Kurulumun sonucunu burada takip edin." />
    {submission.created || submission.phase === 'uncertain' ? <SiteCreateResult state={submission} /> : created ? <div ref={sharedResultRef} tabIndex={-1} aria-live="polite" aria-atomic="true" className="ws-site-create-result" style={{ outline: 'none' }}><Section title="Alan adı bağlantısı oluşturuldu"><EmptyState icon="check" title={created.primaryDomain} detail="Alan adı mevcut Website’e bağlandı. Yayın ve servis durumunu site araçlarından kontrol edin." action={<LinkButton variant="primary" icon="arrow" to={siteHref(created.id, 'files')}>Dosyaları aç</LinkButton>} /></Section></div> : <Section title={step === 1 ? 'Alan adı ve sahip' : step === 2 ? 'Barındırma türü' : 'Son kontrol ve kurulum'}>
      <CollectionNotice resource={domains} label="Alan adları" /><CollectionNotice resource={servers} label="Yerel sunucu" />{(existingType || sharedMode) && <><CollectionNotice resource={applications} label="Uygulamalar" /><CollectionNotice resource={websites} label="Website bağları" /></>}
      <ol className="ws-setup-steps" aria-label="Site oluşturma adımları">{['Alan adı ve sahip', 'Barındırma', 'Kurulum'].map((label, index) => <li key={label} aria-current={step === index + 1 ? 'step' : undefined}><span>{index + 1}</span>{label}</li>)}</ol>
      <form className="ws-form" onSubmit={submit}><ErrorNotice error={error ?? submission.error} /><fieldset disabled={baseLocked}>
        {step === 1 && <>        <h3>1. Alan adı</h3><div className="ws-form-grid" style={{ marginTop: 16 }}>
          <label>Kayıt türü<select value={form.mode} onChange={(event) => update('mode', event.target.value)}><option value="domain">Bağımsız alan adı</option><option value="subdomain">Alt alan adı</option></select></label>
          {form.mode === 'subdomain' ? <><label>Üst alan adı<select value={form.parentDomainId} required onChange={(event) => update('parentDomainId', event.target.value)}><option value="">Alan adı seçin</option>{domains.items.map((item) => <option key={item.id} value={item.id}>{item.primaryDomain}</option>)}</select></label><label>Alt alan adı<input aria-label="Alt alan adı" aria-describedby="website-subdomain-hint" value={form.prefix} required placeholder="api" autoCapitalize="none" spellCheck={false} onChange={(event) => update('prefix', event.target.value)} /><span id="website-subdomain-hint" className="ws-field-hint">{parent ? `${form.prefix.trim() || 'api'}.${parent.primaryDomain}` : 'Önce üst alan adını seçin.'}</span></label></> : <label>Alan adı<input value={form.primaryDomain} required placeholder="example.com" autoCapitalize="none" spellCheck={false} onChange={(event) => update('primaryDomain', event.target.value)} /></label>}
          {form.mode === 'domain' && <label>www davranışı<select value={form.wwwMode} onChange={(event) => update('wwwMode', event.target.value)}><option value="none">www kaydı oluşturma</option><option value="alias">www aynı siteye alias olsun</option></select><span className="ws-field-hint">www adresi aynı sitenin içeriğini kullanır.</span></label>}
        </div>
        {form.mode === 'subdomain' && <div className="yp-subdomain-branch" style={{ marginTop: 12 }}><div className="yp-subdomain-branch-main"><span className="yp-tree-connector" aria-hidden="true">└─</span><strong>Ortak Domain İçi Dosya Kökü:</strong><FileRootBadge path={resolveSubdomainSharedFileRoot(parent?.primaryDomain, form.prefix)} isSubdomain parentDomain={parent?.primaryDomain ?? 'example.com'} /></div><small className="ws-muted">Alt alan adı dosyaları ana domain dizini altında açılır; kendi başına PHP/Node.js/Statik uygulama, Veritabanı ve Docker proxy bağlayabilir.</small></div>}
        <div className="ws-form-grid">
          <label>Site sahibi<select aria-label="Site sahibi" value={form.ownerMode} onChange={event => { update('ownerMode', event.target.value); if (event.target.value !== 'new_admin') update('adminPassword', ''); if (event.target.value === 'customer' && sharedMode) update('sourceMode', 'new_php'); }}>
            <option value="owner">Yönetim hesabım</option><option value="customer">Mevcut müşteri</option>{form.mode === 'domain' && <option value="new_admin">Yeni site giriş hesabı</option>}
          </select></label>
          {form.ownerMode === 'customer' && <label>Müşteri<select required value={form.customerId} onChange={event => update('customerId', event.target.value)}><option value="">Müşteri seçin</option>{customers.map(account => <option key={account.id} value={account.id}>{account.username}</option>)}</select><ErrorNotice error={customerError} /></label>}
        </div>
        {form.mode === 'domain' && form.ownerMode === 'new_admin' && <div className="ws-form-divider" style={{ marginTop: 24 }}>
          <h3>Yeni site giriş hesabı</h3>
          <p className="ws-muted">Bu kullanıcı yalnız bu sitenin panel araçlarına erişebilir. WordPress yönetici hesabı kurulum sırasında ayrıca belirlenir.</p>
          <LoginCredentialsFields email={form.adminEmail} password={form.adminPassword}
            onEmailChange={value => update('adminEmail', value)} onPasswordChange={value => update('adminPassword', value)} />
        </div>}
        </>}
        {step === 2 && <>        <div className="ws-form-divider" style={{ marginTop: 24 }}><h3>Barındırma türü</h3>
          <div className="yp-jamstack-preset-bar" role="group" aria-label="Uygulama Şablonu Seçin" style={{ marginTop: 12, marginBottom: 16 }}>
            <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 8, marginBottom: 8, flexWrap: 'wrap' }}>
              <strong>Uygulama Şablonu Seçin</strong>
            </div>
            <div className="ws-actions" style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(210px, 1fr))', gap: 8, alignItems: 'stretch' }}>
              {JAMSTACK_FRAMEWORK_PRESETS.map((preset) => {
                const active = form.frameworkPreset === preset.id;
                return (
                  <button
                    key={preset.id}
                    type="button"
                    className={`ws-button ${active ? 'ws-button-primary' : 'ws-button-ghost'} yp-framework-preset-card`}
                    aria-pressed={active}
                    data-preset-id={preset.id}
                    onClick={() => selectFrameworkPreset(preset.id)}
                    style={{ display: 'flex', flexDirection: 'column', alignItems: 'flex-start', justifyContent: 'space-between', textAlign: 'left', padding: '10px 12px', height: '100%' }}
                  >
                    <span style={{ fontWeight: 600 }}>{preset.label}</span>
                    <small className="ws-muted" style={{ fontSize: '0.78rem' }}>
                      {preset.category} · {preset.outputDir ? `Çıktı: ${preset.outputDir}` : `Port: ${preset.defaultPort}`}
                    </small>
                  </button>
                );
              })}
            </div>
          </div>
          <div className="ws-form-grid" style={{ marginTop: 16 }}>
          <label>Site türü<select aria-label="Site türü" value={form.sourceMode} onChange={(event) => update('sourceMode', event.target.value)}><option value="new_node">Node.js — Git ile yayınla</option><option value="new_static_upload">Statik site — dosya yükleyerek başla</option><option value="new_static">Gelişmiş: statik siteyi Git ile yayınla</option><option value="new_php">PHP / WordPress — dosya yükleyerek başla</option><option value="new_python">Python (FastAPI / Django / Flask) — Git ile yayınla</option><option value="docker_compose">Docker / Compose Proxy</option><option value="existing_node">Kullanılmamış mevcut Node.js uygulaması</option><option value="existing_static">Kullanılmamış mevcut statik uygulama</option><option value="existing_managed_compose">Mevcut Compose Projesi</option><option value="existing_docker">Mevcut Docker Konteyner İş Yükü</option><option value="shared_website">Mevcut Website’i paylaş (shared-site)</option><option value="external_proxy">Gelişmiş: yerel proxy</option></select></label>
          {['new_node', 'new_static', 'new_python'].includes(form.sourceMode) && <><label>GitHub repository<input type="url" required placeholder="https://github.com/organization/repository" value={form.repositoryUrl} onChange={(event) => update('repositoryUrl', event.target.value)} /></label><label>Branch<input value={form.branch} required onChange={(event) => update('branch', event.target.value)} /></label></>}
          {['new_node', 'new_python'].includes(form.sourceMode) && <><label>Başlangıç dosyası<input value={form.entryFile} required onChange={(event) => update('entryFile', event.target.value)} /></label><label>Sağlık kontrolü yolu<input value={form.healthPath} required onChange={(event) => update('healthPath', event.target.value)} /></label></>}
          {form.sourceMode === 'new_static' && <label>Build çıktı klasörü<input value={form.outputDir} required onChange={(event) => update('outputDir', event.target.value)} /><span className="ws-field-hint">npm ci ve npm run build kullanılır; index.html sağlık dosyasıdır.</span></label>}
          {existingType && <label>{existingType === 'node' ? 'Node.js uygulaması' : 'Statik uygulama'}<select value={form.applicationId} required onChange={(event) => update('applicationId', event.target.value)}><option value="">Kullanılmamış uygulama seçin</option>{eligible.map((app) => <option key={app.id} value={app.id}>{app.name}{app.type === 'node' ? ` · Node ${app.runtime.nodeMajor}` : ` · ${app.build?.outputDir ?? 'build'}`}</option>)}</select><span className="ws-field-hint">Başka bir Website’e bağlı uygulamalar listelenmez; bir Application iki Website tarafından paylaşılamaz.</span></label>}
          {sharedMode && <label>Paylaşılacak Website<select value={form.websiteId} required onChange={(event) => update('websiteId', event.target.value)}><option value="">Mevcut Website seçin</option>{sharedWebsites.map((website) => { const bound = domains.items.find((item) => item.websiteId === website.id); return <option key={website.id} value={website.id}>{bound?.primaryDomain ?? website.name} · {website.runtimeType} · {website.unixUser ?? 'proxy'}</option>; })}</select><span className="ws-field-hint">Yalnız canonical routing hedefi doğrulanabilen yerel Website’ler gösterilir.</span></label>}
          {form.sourceMode === 'external_proxy' && <label>Yerel uygulama portu<input type="number" min={1024} max={65535} value={form.targetValue} required placeholder="4301" onChange={(event) => update('targetValue', event.target.value)} /></label>}
          {['existing_managed_compose', 'docker_compose'].includes(form.sourceMode) && <><label>Docker Compose proje kimliği<input value={form.dockerProjectId} required={form.sourceMode === 'existing_managed_compose'} placeholder="compose-project-id" onChange={(event) => update('dockerProjectId', event.target.value)} /></label><label>Compose servisi<input value={form.dockerServiceName} required placeholder="web" onChange={(event) => update('dockerServiceName', event.target.value)} /></label><label>Inner Port (Container targetPort)<input type="number" min={1} max={65535} value={form.dockerTargetPort} required placeholder="8080" onChange={(event) => update('dockerTargetPort', event.target.value)} /></label></>}
          {form.sourceMode === 'existing_docker' && <label>Docker iş yükü kimliği<input value={form.dockerWorkloadId} required placeholder="docker-workload-id" onChange={(event) => update('dockerWorkloadId', event.target.value)} /></label>}
          {form.sourceMode === 'new_static_upload' && <p className="ws-muted">HTML, CSS ve görsellerinizi Dosya Yöneticisi ile yükleyin. Git deposu veya derleme komutu gerekmez.</p>}
          {form.sourceMode === 'new_php' && <p className="ws-muted">Siteniz dosya yüklemeye hazır olarak açılır. Ardından Dosya Yöneticisi veya WordPress aracından devam edebilirsiniz.</p>}
        </div>{['new_php', 'new_node', 'new_python', 'new_static', 'new_static_upload', 'existing_node', 'existing_static'].includes(form.sourceMode) && <label className="ws-check" style={{ marginTop: 12 }}><input type="checkbox" checked={Boolean(form.initialDatabase)} onChange={(event) => update('initialDatabase', event.target.checked)} /><span><strong>Bu {form.mode === 'subdomain' ? 'alt alan adı' : 'site'} için otomatik veritabanı oluştur</strong><small>Veritabanı ve kullanıcı bilgileri kurulum sırasında hazırlanır.</small></span></label>}{existingType && !eligible.length && applications.status === 'ready' && websites.status === 'ready' && <p className="ws-muted">Bu sunucuda kullanılmamış uygun uygulama bulunmuyor. Yeni Application oluşturma seçeneklerinden birini kullanın.</p>}{sharedMode && !sharedWebsites.length && applications.status === 'ready' && websites.status === 'ready' && <p className="ws-muted">Canonical routing hedefi paylaşılabilecek yerel Website bulunmuyor.</p>}{selectedSharedWebsite && <div className="ws-notice ws-notice-warn"><div><strong>{selectedSharedDomain?.primaryDomain ?? selectedSharedWebsite.name} Website bağı paylaşılacak</strong><p>Website <code>{selectedSharedWebsite.id}</code> · runtime {selectedSharedWebsite.runtimeType} · Unix kullanıcı {selectedSharedWebsite.unixUser ?? 'uygulanamaz'}. Bu seçim yeni Application, Unix user, SFTP scope veya mailbox oluşturmaz.</p></div></div>}</div>
        </>}
        {step === 3 && <>
        <KeyValues items={[["Alan adı", form.mode === 'subdomain' ? `${form.prefix}.${parent?.primaryDomain ?? ''}` : form.primaryDomain], ...(form.mode === 'subdomain' ? [["Dosya dizini", resolveSubdomainSharedFileRoot(parent?.primaryDomain, form.prefix)]] : []), ["Site sahibi", form.ownerMode === 'customer' ? customers.find(account => account.id === form.customerId)?.username : form.ownerMode === 'new_admin' ? form.adminEmail : 'Yönetim hesabım'], ["Barındırma", form.sourceMode === 'new_php' ? 'PHP / WordPress' : form.sourceMode === 'new_node' ? 'Node.js' : form.sourceMode === 'new_python' ? 'Python API' : ['new_static', 'new_static_upload'].includes(form.sourceMode) ? 'Statik site' : ['existing_managed_compose', 'docker_compose'].includes(form.sourceMode) ? `Docker Compose (${form.dockerServiceName}:${form.dockerTargetPort})` : 'Mevcut hedef']]} />
        <div className="ws-form-divider" style={{ marginTop: 24 }}><h3>DNS</h3><label>DNS yönetimi<select aria-label="DNS yönetimi" aria-describedby="website-dns-hint" value={form.dnsMode} onChange={(event) => update('dnsMode', event.target.value)}><option value="local">Bu sunucuda yönet</option><option value="external">Harici DNS kullan</option></select><span id="website-dns-hint" className="ws-field-hint">Alan adı veya üst alanın NS kayıtları bu sunucuyu göstermelidir. Harici DNS kullanıyorsanız adres kaydını sağlayıcınızda oluşturun.</span></label></div>
        <div className="ws-form-divider" style={{ marginTop: 24 }}><h3>HTTPS</h3><label style={{ marginTop: 16 }}>Sertifika yönetimi<select aria-label="Sertifika yönetimi" aria-describedby="website-certificate-management-hint" value={form.httpsMode} onChange={(event) => update('httpsMode', event.target.value)}><option value="managed">Yönetilen HTTPS — sertifika daha sonra istenir</option><option value="off">Şimdilik HTTP</option></select><span id="website-certificate-management-hint" className="ws-field-hint">Kayıt oluşturmak sertifika üretmez. DNS ve Nginx doğrulandıktan sonra SSL sekmesinden isteyin.</span></label></div>
        {form.mode === 'domain' && <div className="ws-form-divider" style={{ marginTop: 24 }}><h3>Posta</h3><label className="ws-check" style={{ marginTop: 16 }}><input type="checkbox" checked={form.mailMode === 'local'} onChange={(event) => update('mailMode', event.target.checked ? 'local' : 'none')} /><span><strong>E-posta ve Webmail etkinleştir</strong><small><code>webmail.{form.primaryDomain.trim() || 'domain.com'}</code> için DNS A kaydı, SSL sertifikası ve webmail arayüzü otomatik olarak hazırlanır.</small></span></label></div>}
        </>}
        <SiteCreateProgress state={submission} />
        <footer className="ws-form-footer" style={{ marginTop: 24 }}><LinkButton to="/websites">Vazgeç</LinkButton>{step > 1 && <Button disabled={busy} onClick={() => setStep(value => value - 1)}>Geri</Button>}<Button type="submit" variant="primary" icon="plus" disabled={locked || !serverId || (step >= 2 && existingType && !form.applicationId) || (step >= 2 && sharedMode && !form.websiteId)}>{busy ? 'Site kuruluyor…' : step < 3 ? 'Devam et' : sharedMode ? 'Alan adını bağla' : 'Siteyi oluştur'}</Button></footer>

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
