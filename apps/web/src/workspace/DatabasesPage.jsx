import { useCallback, useEffect, useRef, useState } from 'react';
import { useSearchParams } from 'react-router';
import { createDatabase, createPhpMyAdminHandoff, deleteDatabase, getDatabases, waitForJob } from '../api.js';
import { Badge, Button, CollectionNotice, ConfirmDialog, EmptyState, ErrorNotice, Icon, KeyValues, LinkButton, Modal, PageHeading, Section } from './PanelKit.jsx';
import { useWorkspace } from './WorkspaceContext.jsx';
import { databaseInventoryView, formatDatabaseBytes, validDatabaseName } from './database-model.js';
import { openWebsitePhpMyAdmin } from './phpmyadmin-client.js';
import { databaseAccessView, filterConsoleDatabases, paginateConsoleItems } from './ui/console-model.js';

const SECURITY_REASON_LABELS = Object.freeze({
  database_security_inspection_unavailable: 'Güvenlik durumu okunamadı',
  database_native_socket_admin_auth_required: 'Yerel yönetici bağlantısı yapılandırılmalı',
  database_anonymous_accounts_present: 'Anonim hesap mevcut',
  database_remote_root_accounts_present: 'Uzak root hesabı mevcut',
  database_test_schema_present: 'Test veritabanı mevcut',
});
async function queueAndWait(queue, { observe, refreshJobs, updateJob }) {
  const queued = await queue();
  observe(queued); refreshJobs();
  const terminal = await waitForJob(queued.id);
  updateJob(terminal);
  return terminal;
}
export default function DatabasesPage() {
  const { servers, domains, jobs, observe, updateJob } = useWorkspace();
  const [params, setParams] = useSearchParams();
  const requestGeneration = useRef(0);
  const pending = useRef(false);
  const [status, setStatus] = useState('idle');
  const [inventory, setInventory] = useState(() => databaseInventoryView(null));
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);
  const [name, setName] = useState('');
  const [createdName, setCreatedName] = useState('');
  const [createOpen, setCreateOpen] = useState(false);
  const [accessTarget, setAccessTarget] = useState(null);
  const [deleteTarget, setDeleteTarget] = useState(null);
  const server = servers.items.length === 1 ? servers.items[0] : null;
  const query = params.get('q') ?? '';
  const access = ['ready', 'attention'].includes(params.get('access')) ? params.get('access') : 'all';
  const canAct = Boolean(server && servers.status === 'ready' && status === 'ready' && !busy);

  const load = useCallback(async () => {
    if (!server) { setInventory(databaseInventoryView(null)); setStatus('idle'); return; }
    const generation = ++requestGeneration.current;
    setStatus((current) => current === 'ready' ? 'refreshing' : 'loading');
    setError(null);
    try {
      const data = await getDatabases(server.id);
      if (generation !== requestGeneration.current) return;
      setInventory(databaseInventoryView(data)); setStatus('ready');
    } catch (failure) {
      if (generation !== requestGeneration.current || failure.name === 'AbortError') return;
      setError(failure.message); setStatus('error');
    }
  }, [server?.id]);
  useEffect(() => {
    setName(''); setDeleteTarget(null); setCreatedName(''); setCreateOpen(false); setAccessTarget(null);
    void load();
    return () => { requestGeneration.current += 1; };
  }, [load]);
  function filter(key, value) {
    setParams((current) => {
      const next = new URLSearchParams(current);
      if (value) next.set(key, value); else next.delete(key);
      if (key !== 'page') next.delete('page');
      return next;
    }, { replace: key === 'q' });
  }
  async function perform(queue) {
    if (!canAct || pending.current) return null;
    pending.current = true; setBusy(true); setError(null);
    try {
      const terminal = await queueAndWait(queue, { observe, refreshJobs: jobs.refresh, updateJob });
      await load();
      if (terminal?.status !== 'succeeded') {
        setError('İşlem tamamlanamadı. İşlem merkezindeki hata ayrıntılarını inceleyin.');
        return null;
      }
      return terminal;
    } catch (failure) {
      if (failure.name !== 'AbortError') setError(failure.message);
      return null;
    } finally { pending.current = false; setBusy(false); }
  }
  async function create(event) {
    event.preventDefault();
    if (!validDatabaseName(name)) { setError('1–64 karakter kullanın: harf, rakam veya alt çizgi. Sistem veritabanı adları kullanılamaz.'); return; }
    const requestedName = name;
    const terminal = await perform(() => createDatabase(server.id, requestedName));
    if (terminal) { setName(''); setCreateOpen(false); setCreatedName(requestedName); }
  }
  async function remove() {
    if (!deleteTarget) return;
    const target = deleteTarget;
    const terminal = await perform(() => deleteDatabase(server.id, target.name));
    if (terminal) setDeleteTarget(null);
  }
  async function openPhpMyAdmin(ownership) {
    if (!canAct || !ownership?.websiteId || !ownership?.credential?.id || pending.current) return;
    pending.current = true; setBusy(true); setError(null);
    try {
      await openWebsitePhpMyAdmin({ serverId: server.id, websiteId: ownership.websiteId, credentialId: ownership.credential.id, issueHandoff: createPhpMyAdminHandoff });
    } catch (failure) { if (failure.name !== 'AbortError') setError(failure.message); }
    finally { pending.current = false; setBusy(false); }
  }
  const engineLabel = inventory.engine === 'mariadb' ? 'MariaDB' : inventory.engine === 'mysql' ? 'MySQL' : 'Motor bilgisi yok';
  const securityLabel = inventory.health?.ready ? 'Güvenlik kontrolü tamam' : inventory.health?.available === false ? 'Güvenlik doğrulanamadı' : inventory.health ? 'Güvenlik kontrolü gerekli' : 'Güvenlik bilgisi yok';
  const page = paginateConsoleItems(filterConsoleDatabases(inventory.databases, { query, access, domains }), params.get('page'));
  const hasInventory = Array.isArray(inventory.databases);
  return <>
    <PageHeading title="Veritabanları" description="Veritabanlarınızı bulun, site erişimini yönetin ve phpMyAdmin’i açın." actions={<><Button icon="refresh" disabled={!server || busy || ['loading', 'refreshing'].includes(status)} onClick={load}>Yenile</Button><Button variant="primary" icon="plus" disabled={!canAct} onClick={() => { setError(null); setCreateOpen(true); }}>Veritabanı oluştur</Button></>} />
    <CollectionNotice resource={servers} label="Yerel sunucu" />
    {server && <CollectionNotice resource={domains} label="Site bağlantıları" />}
    {!createOpen && !deleteTarget && <ErrorNotice error={error} />}
    {createdName && <div className="ws-notice" role="status"><div><strong>{createdName} oluşturuldu.</strong><p>phpMyAdmin erişimi için sitenin Kaynaklar bölümünden bu veritabanını bağlayıp kullanıcı oluşturun.</p></div><LinkButton to="/websites">Site seç</LinkButton><Button icon="close" aria-label="Bildirimi kapat" onClick={() => setCreatedName('')} /></div>}
    {!server && ['ready', 'stale'].includes(servers.status) && <Section title="Veritabanları"><EmptyState title="Yerel sunucu kullanılamıyor" detail="Sunucu bağlantısı doğrulandıktan sonra veritabanları burada görünür." icon="database" /></Section>}
    {server && <>
      <Section title="Veritabanı listesi" description={status === 'refreshing' ? 'Liste güncelleniyor…' : inventory.live ? 'Yerel sunucudan alınan veritabanları.' : 'Canlı bağlantı bekleniyor.'}>
        {hasInventory && <div className="ws-inline-summary"><span><strong>{inventory.databases.length}</strong> veritabanı</span><span>{engineLabel} {inventory.version ?? ''}</span><span><strong>{formatDatabaseBytes(inventory.totalBytes)}</strong> toplam</span><Badge state={inventory.health?.ready ? 'active' : inventory.health ? 'warning' : 'unknown'}>{securityLabel}</Badge></div>}
        <div className="ws-filters"><label className="ws-filter-search">Veritabanı ara<input type="search" value={query} onChange={(event) => filter('q', event.target.value)} placeholder="Veritabanı, site veya kullanıcı" /></label><label>Erişim<select value={access} onChange={(event) => filter('access', event.target.value)}><option value="all">Tümü</option><option value="ready">phpMyAdmin erişimi hazır</option><option value="attention">Yapılandırma gerekli</option></select></label></div>
        {status === 'loading' && <div className="ws-loading" role="status"><span className="ws-spinner" />Veritabanları yükleniyor…</div>}
        {status === 'error' && hasInventory && <div className="ws-notice ws-notice-warn"><p>Son alınan liste gösteriliyor. Güncel erişim doğrulanana kadar değişiklikler ve phpMyAdmin geçişi kapalıdır.</p><Button onClick={load}>Yeniden dene</Button></div>}
        {status !== 'loading' && !hasInventory && <EmptyState title="Veritabanı listesi alınamadı" detail="Veritabanı servisini ve yerel bağlantıyı kontrol edip yeniden deneyin." icon="database" action={<Button onClick={load}>Yeniden dene</Button>} />}
        {hasInventory && status !== 'loading' && (page.count === 0 ? <EmptyState title={inventory.databases.length ? 'Eşleşen veritabanı yok' : 'Henüz veritabanı yok'} detail={inventory.databases.length ? 'Aramanızı veya erişim filtresini değiştirin.' : 'Yeni bir uygulama veritabanı oluşturarak başlayın.'} icon="database" action={inventory.databases.length ? <Button onClick={() => setParams({})}>Filtreleri temizle</Button> : <Button variant="primary" disabled={!canAct} onClick={() => setCreateOpen(true)}>Veritabanı oluştur</Button>} /> : <>
          <div className="ws-table-scroll"><table className="ws-table ws-db-table" role="table" aria-label="Veritabanları"><thead><tr><th scope="col">Veritabanı</th><th scope="col">Site / Kullanıcı</th><th scope="col">Boyut</th><th scope="col">phpMyAdmin</th><th scope="col" className="ws-row-end">İşlem</th></tr></thead><tbody>{page.items.map((database) => {
            const view = databaseAccessView(database, domains);
            return <tr key={database.name} role="row"><td role="cell"><div className="ws-db-name"><Icon name="database" size={22} /><div><strong>{database.name}</strong><small>{engineLabel}</small></div></div></td>
              <td role="cell" data-label="Site / Kullanıcı"><strong>{view.siteLabel}</strong><small>{database.ownership?.credential?.username ?? 'Veritabanı kullanıcısı yok'}</small></td>
              <td role="cell" data-label="Boyut">{database.sizeLabel}</td>
              <td role="cell"><div className="ws-db-access">{view.canOpen ? <Button icon="external" disabled={!canAct} onClick={() => openPhpMyAdmin(database.ownership)} aria-label={`${database.name}: phpMyAdmin’i yeni sekmede aç`}>phpMyAdmin’i aç</Button> : view.siteHref ? <LinkButton to={view.siteHref} icon="settings">{view.label}</LinkButton> : <Button icon="settings" onClick={() => setAccessTarget(database)}>{view.label}</Button>}<small>{view.detail}</small></div></td>
              <td role="cell" className="ws-row-end"><Button icon="trash" disabled={!canAct} aria-label={`${database.name} veritabanını sil`} title="Veritabanını sil" onClick={() => { setError(null); setDeleteTarget(database); }} /></td>
            </tr>;
          })}</tbody></table></div>
          <footer className="ws-pagination"><span>{page.count} sonuç · {page.page} / {page.pages}</span><div className="ws-actions"><Button disabled={page.page <= 1} onClick={() => filter('page', String(page.page - 1))}>Önceki</Button><Button disabled={page.page >= page.pages} onClick={() => filter('page', String(page.page + 1))}>Sonraki</Button></div></footer>
        </>)}
      </Section>
      <details className="ws-section ws-disclosure"><summary>Sunucu ve güvenlik ayrıntıları</summary><KeyValues items={[
        ['Motor', engineLabel], ['Sürüm', inventory.version ?? '—'], ['Güvenlik', securityLabel],
        ['Yönetici bağlantısı', inventory.health?.connection ? `${inventory.health.connection.adminAccount} · ${inventory.health.connection.authPlugin || '—'}` : '—'],
        ['Tanı', inventory.health?.reason ? SECURITY_REASON_LABELS[inventory.health.reason] ?? 'Bilinmeyen durum' : '—'],
        ['Site bağlantısı', inventory.ownership?.bindingCount], ['Veritabanı kullanıcısı', inventory.ownership?.credentialCount], ['Eksik veritabanı bağlantısı', inventory.ownership?.missingDatabaseBindingCount],
      ]} /></details>
    </>}
    {createOpen && <Modal title="Veritabanı oluştur" busy={busy} onClose={() => { if (!busy) setCreateOpen(false); }}><ErrorNotice error={error} /><form className="ws-form" onSubmit={create}><label>Veritabanı adı<input value={name} onChange={(event) => setName(event.target.value)} placeholder="ornek_uygulama" maxLength={64} autoComplete="off" autoCapitalize="none" spellCheck={false} required autoFocus /><span className="ws-field-hint">Harf, rakam ve alt çizgi kullanın.</span></label><p className="ws-muted">Bu adım veritabanını oluşturur. Site bağlantısı ve veritabanı kullanıcısı, sitenin Kaynaklar bölümünden yönetilir.</p><footer className="ws-modal-footer"><Button disabled={busy} onClick={() => setCreateOpen(false)}>Vazgeç</Button><Button variant="primary" type="submit" disabled={!canAct || !validDatabaseName(name)}>{busy ? 'Oluşturuluyor…' : 'Oluştur'}</Button></footer></form></Modal>}
    {accessTarget && <Modal title={`${accessTarget.name} · phpMyAdmin erişimi`} onClose={() => setAccessTarget(null)}><p className="ws-muted">phpMyAdmin, sitenin kendi veritabanı kullanıcısıyla açılır. Veritabanını ilgili sitenin Kaynaklar bölümünden bağlayın; ardından kullanıcı oluşturun. Sunucu yöneticisi hesabıyla sınırsız bir oturum açılmaz.</p>{accessTarget.ownership?.websiteId && <p className="ws-muted">Site adı henüz çözümlenemedi. Site listesini yenileyerek ilgili çalışma alanını açın.</p>}<footer className="ws-modal-footer"><Button onClick={() => setAccessTarget(null)}>Kapat</Button><LinkButton to="/websites" variant="primary">Site seç</LinkButton></footer></Modal>}
    {deleteTarget && <ConfirmDialog title={`${deleteTarget.name} silinsin mi?`} message="Veritabanı kalıcı olarak silinir. Siteye bağlı veritabanlarını ilgili sitenin Kaynaklar bölümünden yönetin. Devam etmeden önce güncel bir yedeğiniz olduğundan emin olun." confirmation={deleteTarget.name} confirmLabel="Veritabanını sil" busy={busy} error={error} onCancel={() => { if (!busy) setDeleteTarget(null); }} onConfirm={remove} />}
  </>;
}
