import { useEffect, useRef, useState } from 'react';
import { useSearchParams } from 'react-router';
import { panelRequest } from '../api.js';
import { sessionVersion, sessionTransitionPending } from '../session-client.js';
import { useWorkspace } from './WorkspaceContext.jsx';
import { Badge, Button, ConfirmDialog, EmptyState, ErrorNotice, KeyValues, LinkButton, Modal, Section } from './PanelKit.jsx';
import { siteHref } from './site-model.js';

const labels = { install: 'WordPress kur', remove: 'WordPress’i kaldır', password: 'Yönetici parolasını değiştir', 'core.update': 'WordPress’i güncelle',
  clone: 'WordPress klonla', staging: 'Staging oluştur', 'plugin.install': 'Eklenti kur', 'theme.install': 'Tema kur' };
const unwrap = result => result?.data ?? result;
const terminal = job => ['succeeded', 'failed', 'cancelled'].includes(job?.status);
const wait = delay => new Promise(resolve => setTimeout(resolve, delay));

export default function SiteWordPressPanel({ domainId, scope }) {
  const { canManage, updateJob, jobs, websites } = useWorkspace();
  const [search, setSearch] = useSearchParams();
  const [status, setStatus] = useState(null), [error, setError] = useState(null), [loading, setLoading] = useState(true);
  const [job, setJob] = useState(null), [busy, setBusy] = useState(false), [phase, setPhase] = useState('');
  const [dialog, setDialog] = useState(null), [packageName, setPackageName] = useState(''), [password, setPassword] = useState('');
  const [username, setUsername] = useState(''), [removal, setRemoval] = useState(null);
  const [clone, setClone] = useState({ targetWebsiteId: '', scheme: 'https', action: 'staging' });
  const [install, setInstall] = useState({ title: '', adminUser: 'admin', adminEmail: '', locale: 'tr_TR', scheme: 'https', databaseBindingId: 'new', databaseName: `wp_${scope.websiteId.replaceAll('-', '').slice(0, 12)}` });
  const live = useRef(false), generation = useRef(sessionVersion()), requestRef = useRef(search.get('wordpressRequest'));
  const isCurrent = () => live.current && generation.current === sessionVersion() && !sessionTransitionPending();
  const root = `/websites/${encodeURIComponent(scope.websiteId)}/wordpress`;
  async function load() {
    if (!isCurrent()) return;
    setLoading(true);
    try {
      const data = unwrap(await panelRequest(root));
      if (!isCurrent()) return;
      setStatus(data); setInstall(previous => previous.title || previous.adminEmail ? previous : { ...previous, scheme: data.suggestedScheme ?? 'http' }); setUsername(previous => data.administrators?.includes(previous) ? previous : data.administrators?.[0] ?? '');
    } catch (failure) { if (isCurrent()) { setError(failure); if ([401, 403].includes(failure.status)) setStatus(null); } }
    finally { if (isCurrent()) setLoading(false); }
  }
  async function readRequest(id) {
    const current = unwrap(await panelRequest(`${root}/requests/${encodeURIComponent(id)}`));
    if (!isCurrent()) return null;
    setJob(current); updateJob(current);
    if (terminal(current)) { setBusy(false); setPhase(''); void load(); void jobs.refresh(); }
    return current;
  }
  useEffect(() => {
    live.current = true; generation.current = sessionVersion(); void load();
    if (requestRef.current) void readRequest(requestRef.current).catch(failure => { if (isCurrent()) setError(failure); });
    return () => { live.current = false; };
  }, [scope.websiteId]);
  useEffect(() => {
    if (!job || terminal(job) || !requestRef.current) return;
    const timer = setInterval(() => { void readRequest(requestRef.current).catch(failure => { if (isCurrent()) setError(failure); }); }, 1500);
    return () => clearInterval(timer);
  }, [job?.id, job?.status]);

  const disabled = !canManage || busy || (job && !terminal(job));
  async function prepareDatabase() {
    setPhase('Veritabanı ve kullanıcı hazırlanıyor');
    const selected = install.databaseBindingId === 'new' ? null : status.databases?.find(database => database.id === install.databaseBindingId);
    if (install.databaseBindingId !== 'new' && !selected) throw new Error('Seçilen site veritabanı doğrulanamadı. Listeyi yenileyin.');
    const databaseName = selected?.name ?? install.databaseName;
    const previous = selected ?? status.databases?.find(database => database.name === databaseName);
    const response = unwrap(await panelRequest(`/servers/${scope.serverId}/websites/${scope.websiteId}/databases`, { method: 'POST', body: {
      databaseName, mode: previous ? 'continue' : 'create', expectedWebsiteRevision: status.websiteRevision,
    } }));
    if (!isCurrent()) throw new Error('Oturum değişti');
    setInstall(value => ({ ...value, databaseBindingId: response.binding.id }));
    let databaseJob = response.job;
    for (let attempt = 0; attempt < 200 && !terminal(databaseJob); attempt++) {
      await wait(1500); if (!isCurrent()) throw new Error('Oturum değişti');
      databaseJob = unwrap(await panelRequest(`/jobs/${databaseJob.id}`)); updateJob(databaseJob);
    }
    if (databaseJob.status !== 'succeeded') throw new Error(databaseJob.error?.message ?? 'Veritabanı kurulumu tamamlanmadı. Mevcut kurulum kaydı korunuyor.');
    return response.binding.id;
  }
  async function prepareCloneDatabase(targetWebsiteId) {
    const target = unwrap(await panelRequest(`/websites/${targetWebsiteId}/wordpress`));
    if (!isCurrent()) throw new Error('Oturum değişti');
    const databaseName = `wp_${targetWebsiteId.replaceAll('-', '').slice(0, 12)}`;
    const existing = target.databases?.find(database => database.name === databaseName);
    const response = unwrap(await panelRequest(`/servers/${scope.serverId}/websites/${targetWebsiteId}/databases`, { method: 'POST', body: {
      databaseName, mode: existing ? 'continue' : 'create', expectedWebsiteRevision: target.websiteRevision,
    } }));
    let databaseJob = response.job;
    for (let attempt = 0; attempt < 200 && !terminal(databaseJob); attempt++) {
      await wait(1500); if (!isCurrent()) throw new Error('Oturum değişti');
      databaseJob = unwrap(await panelRequest(`/jobs/${databaseJob.id}`)); updateJob(databaseJob);
    }
    if (databaseJob.status !== 'succeeded') throw new Error('Hedef veritabanı hazırlanamadı; aynı işlem kaydını kontrol edin.');
    return response.binding.id;
  }
  async function perform(options, secret = null, typedConfirmation = null) {
    if (disabled || !isCurrent()) return;
    setBusy(true); setError(null);
    try {
      let desired = options;
      if (options.action === 'install') desired = { ...options, databaseBindingId: await prepareDatabase() };
      if (['clone', 'staging'].includes(options.action)) desired = { ...options, databaseBindingId: await prepareCloneDatabase(options.targetWebsiteId) };
      setPhase('İşlem kontrol ediliyor');
      const preview = unwrap(await panelRequest(`${root}/preview`, { method: 'POST', body: { options: desired } }));
      if (!isCurrent()) return;
      const requestId = requestRef.current && !job ? requestRef.current : crypto.randomUUID(); requestRef.current = requestId;
      const params = new URLSearchParams(search); params.set('wordpressRequest', requestId); setSearch(params, { replace: true });
      setPhase('WordPress işlemi başlatılıyor');
      const response = unwrap(await panelRequest(`${root}/actions`, { method: 'POST', body: { requestId, options: desired,
        expectedWebsiteRevision: preview.websiteRevision, previewDigest: preview.previewDigest,
        confirmation: typedConfirmation ?? preview.confirmation, ...(secret != null ? { password: secret } : {}) } }));
      if (!isCurrent()) return;
      setJob(response.job); updateJob(response.job); setPassword(''); setDialog(null); setRemoval(null); setPhase('');
    } catch (failure) {
      if (!isCurrent()) return;
      setError(failure);
      if (requestRef.current) {
        try { const recovered = await readRequest(requestRef.current); if (recovered) { setPassword(''); setDialog(null); } }
        catch { /* Keep the request reference visible for an explicit result check. */ }
      }
    } finally { if (isCurrent()) { setBusy(false); setPhase(''); } }
  }
  async function prepareRemoval() {
    setError(null);
    try { const preview = unwrap(await panelRequest(`${root}/preview`, { method: 'POST', body: { options: { action: 'remove' } } })); if (isCurrent()) setRemoval(preview); }
    catch (failure) { if (isCurrent()) setError(failure); }
  }
  const installed = status?.installed === true;
  const updateInstall = (key, value) => setInstall(previous => ({ ...previous, [key]: value }));
  return <>
    <Section title="WordPress" description="Kurulum ve günlük yönetim bu ekranda tamamlanır." actions={<Button icon="refresh" disabled={loading || busy} onClick={() => { setError(null); void load(); }}>Yenile</Button>}>
      <div className="ws-section-body">
        <ErrorNotice error={error} />
        {loading && <p role="status">WordPress kontrol ediliyor…</p>}
        {phase && <p role="status" className="ws-loading"><span className="ws-spinner" />{phase}</p>}
        {status && <KeyValues items={[
          ['Durum', installed ? <Badge state="active">Kurulu</Badge> : status.installed === false ? 'Kurulu değil' : 'Kontrol gerekli'],
          ['WordPress sürümü', status.coreVersion ?? '—'], ['Site', status.primaryDomain],
        ]} />}
        {installed && <div className="ws-actions">
          {status.loginUrl && <a className="ws-button ws-button-primary" href={status.loginUrl} target="_blank" rel="noopener noreferrer">Yönetici panelini aç</a>}
          <Button disabled={disabled} onClick={() => { setError(null); setPassword(''); setDialog('password'); }}>Yönetici parolası</Button>
          <Button disabled={disabled} icon="refresh" onClick={() => void perform({ action: 'core.update' })}>WordPress’i güncelle</Button>
          {status.cloneAvailable && <Button disabled={disabled} onClick={() => { setError(null); setDialog('clone'); }}>Klonla / staging</Button>}
          <LinkButton to={siteHref(domainId, 'backup')} icon="archive">Yedekler ve geri yükleme</LinkButton>
          <Button disabled={disabled} variant="danger" icon="trash" onClick={() => void prepareRemoval()}>WordPress’i kaldır</Button>
        </div>}
        {!status && !loading && <EmptyState icon="code" title="WordPress yönetimi açılamadı" detail="Yukarıdaki hata giderildikten sonra yeniden kontrol edin." action={<Button onClick={() => void load()}>Yeniden dene</Button>} />}
        {requestRef.current && !job && <div className="ws-notice"><span>Son isteğin sonucu henüz doğrulanmadı.</span><Button onClick={() => void readRequest(requestRef.current).catch(setError)}>İşlemi kontrol et</Button></div>}
      </div>
    </Section>
    {status?.installed === false && status.available === true && <Section title="WordPress kur" description="Site bilgilerini doldurun. Veritabanı ve kurulum aynı akışta hazırlanır.">
      <form className="ws-section-body ws-form-grid" onSubmit={event => { event.preventDefault(); void perform({ action: 'install', databaseBindingId: install.databaseBindingId,
        title: install.title, adminUser: install.adminUser, adminEmail: install.adminEmail, locale: install.locale, scheme: install.scheme }, password); }}>
        <label>Site başlığı<input required maxLength={120} value={install.title} disabled={disabled} onChange={event => updateInstall('title', event.target.value)} /></label>
        <label>Yönetici kullanıcı adı<input required maxLength={60} autoComplete="username" value={install.adminUser} disabled={disabled} onChange={event => updateInstall('adminUser', event.target.value)} /></label>
        <label>Yönetici e-posta adresi<input required type="email" maxLength={254} value={install.adminEmail} disabled={disabled} onChange={event => updateInstall('adminEmail', event.target.value)} /></label>
        <label>Yönetici parolası<input required type="password" minLength={16} maxLength={128} autoComplete="new-password" value={password} disabled={disabled} onChange={event => setPassword(event.target.value)} /><span className="ws-muted">En az 16 karakter. Parola işlem kaydına yazılmaz.</span></label>
        <label>Dil<select value={install.locale} disabled={disabled} onChange={event => updateInstall('locale', event.target.value)}><option value="tr_TR">Türkçe</option><option value="en_US">English</option></select></label>
        <label>Site adresi<select value={install.scheme} disabled={disabled} onChange={event => updateInstall('scheme', event.target.value)}><option value="https">https://{status.primaryDomain}</option><option value="http">http://{status.primaryDomain}</option></select></label>
        <label>Veritabanı<select value={install.databaseBindingId} disabled={disabled} onChange={event => updateInstall('databaseBindingId', event.target.value)}><option value="new">Yeni veritabanını otomatik oluştur</option>{(status.databases ?? []).map(database => <option value={database.id} key={database.id}>{database.name}</option>)}</select></label>
        {install.databaseBindingId === 'new' && <label>Yeni veritabanının adı<input required pattern="[A-Za-z0-9_]{1,64}" maxLength={64} value={install.databaseName} disabled={disabled} onChange={event => updateInstall('databaseName', event.target.value)} /></label>}
        <p className="ws-muted">Kurulum öncesi site yedeklenir. Kurulum sırasında bildirim e-postası gönderilmez.</p>
        <div className="ws-actions"><Button type="submit" variant="primary" disabled={disabled}>{busy ? 'Hazırlanıyor…' : 'WordPress kur'}</Button></div>
      </form>
    </Section>}
    {job && <Section title="Son WordPress işlemi"><div className="ws-section-body" role="status"><Badge state={job.status} />
      <p>{job.status === 'succeeded' ? 'WordPress işlemi doğrulandı. Güncel bilgiler yeniden alınıyor.' : job.status === 'failed' ? 'İşlem tamamlanamadı. Önceki site yedeği korunuyor.' : job.status === 'cancelled' ? 'İşlem iptal edildi.' : 'Site yedeği alınıyor ve işlem sunucuda yürütülüyor.'}</p>
      <ErrorNotice error={job.error} />
      <Button disabled={busy} onClick={() => void readRequest(requestRef.current).catch(setError)}>Sonucu kontrol et</Button>
    </div></Section>}
    {installed && <>
      <PackageTable title="Eklentiler" kind="plugin" items={status.plugins ?? []} disabled={disabled} onInstall={() => { setPackageName(''); setDialog('plugin.install'); }} onAction={options => void perform(options)} />
      <PackageTable title="Temalar" kind="theme" items={status.themes ?? []} disabled={disabled} onInstall={() => { setPackageName(''); setDialog('theme.install'); }} onAction={options => void perform(options)} />
    </>}
    {dialog && <Modal title={labels[dialog]} busy={busy} onClose={() => { setPassword(''); setDialog(null); }}>
      <form onSubmit={event => { event.preventDefault(); void perform(dialog === 'clone' ? { action: clone.action, targetWebsiteId: clone.targetWebsiteId, scheme: clone.scheme, databaseBindingId: '' } : dialog === 'password' ? { action: 'password', username } : { action: dialog, package: packageName }, dialog === 'password' ? password : null); }}>
        {dialog === 'clone' ? <>
          <label>Hedef PHP sitesi<select required value={clone.targetWebsiteId} disabled={disabled} onChange={event => setClone(value => ({ ...value, targetWebsiteId: event.target.value }))}>
            <option value="">Site seçin</option>{websites.items.filter(site => site.id !== scope.websiteId && site.runtimeType === 'php' && site.serverId === scope.serverId).map(site => <option value={site.id} key={site.id}>{site.name}</option>)}
          </select></label>
          <label>İşlem<select value={clone.action} disabled={disabled} onChange={event => setClone(value => ({ ...value, action: event.target.value }))}><option value="staging">Staging</option><option value="clone">Klon</option></select></label>
          <label>Hedef protokol<select value={clone.scheme} disabled={disabled} onChange={event => setClone(value => ({ ...value, scheme: event.target.value }))}><option value="https">HTTPS</option><option value="http">HTTP</option></select></label>
          <p className="ws-muted">Hedef site klasörü ve veritabanı boş olmalıdır. Başlangıç dosyasını Dosya Yöneticisi ile kaldırın. Kaynak korunur; ayrı hedef kullanıcısı ve DB parolası kullanılır. Staging indeksleme ve WP cron çalışmasını kapatır. Özel erişim korumasını ayrıca ayarlayın.</p>
        </> : dialog === 'password' ? <>
          <label>Yönetici hesabı<select required value={username} disabled={disabled} onChange={event => setUsername(event.target.value)}>{(status.administrators ?? []).map(name => <option key={name}>{name}</option>)}</select></label>
          <label>Yeni parola<input required type="password" minLength={16} maxLength={128} autoComplete="new-password" value={password} disabled={disabled} onChange={event => setPassword(event.target.value)} /></label>
        </> : <label>WordPress.org adı<input required pattern="[a-z0-9][a-z0-9-]{0,99}" placeholder={dialog === 'plugin.install' ? 'Örnek: wordpress-seo' : 'Örnek: twentytwentyfive'} value={packageName} disabled={disabled} onChange={event => setPackageName(event.target.value)} /><span className="ws-muted">WordPress.org adresindeki eklenti veya tema adını yazın.</span></label>}
        <ErrorNotice error={error} /><footer className="ws-modal-footer"><Button disabled={busy} onClick={() => { setPassword(''); setDialog(null); }}>Vazgeç</Button><Button type="submit" variant="primary" disabled={disabled}>{busy ? 'İşleniyor…' : labels[dialog]}</Button></footer>
      </form>
    </Modal>}
    {removal && <ConfirmDialog title="WordPress’i kaldır" message={removal.impact} confirmation={removal.confirmation} confirmLabel="Yedekle ve WordPress’i kaldır"
      busy={busy} error={error} onCancel={() => setRemoval(null)} onConfirm={() => void perform({ action: 'remove' }, null, removal.confirmation)} />}
  </>;
}

function PackageTable({ title, kind, items, disabled, onInstall, onAction }) {
  return <Section title={title} actions={<Button icon="plus" disabled={disabled} onClick={onInstall}>{kind === 'plugin' ? 'Eklenti kur' : 'Tema kur'}</Button>}>
    {!items.length ? <EmptyState title={`${title} bulunamadı`} detail="Listeyi yenileyebilir veya yeni bir paket kurabilirsiniz." /> : <div className="ws-table-wrap"><table className="ws-table"><thead><tr><th scope="col">Ad</th><th scope="col">Sürüm</th><th scope="col">Durum</th><th scope="col">İşlemler</th></tr></thead><tbody>{items.map(item => <tr key={item.name}>
      <td>{item.name}</td><td>{item.version ?? '—'}</td><td><Badge state={item.status === 'active' ? 'active' : 'off'}>{item.status === 'active' ? 'Etkin' : item.status === 'inactive' ? 'Devre dışı' : item.status}</Badge></td>
      <td><div className="ws-actions">
        {item.update === 'available' && <Button disabled={disabled} onClick={() => onAction({ action: `${kind}.update`, package: item.name })}>Güncelle{item.update_version ? ` (${item.update_version})` : ''}</Button>}
        {item.status === 'inactive' && <Button disabled={disabled} onClick={() => onAction({ action: `${kind}.activate`, package: item.name })}>Etkinleştir</Button>}
        {kind === 'plugin' && item.status === 'active' && <Button disabled={disabled} onClick={() => onAction({ action: 'plugin.deactivate', package: item.name })}>Devre dışı bırak</Button>}
        {!['must-use', 'dropin', 'parent'].includes(item.status) && <Button variant="danger" disabled={disabled || (kind === 'theme' && item.status === 'active')} onClick={() => onAction({ action: `${kind}.remove`, package: item.name })}>Kaldır</Button>}
      </div></td>
    </tr>)}</tbody></table></div>}
  </Section>;
}
