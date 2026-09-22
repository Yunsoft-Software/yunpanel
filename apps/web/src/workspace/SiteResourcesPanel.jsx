import { useCallback, useEffect, useRef, useState } from 'react';
import { applyDatabaseCredential, createPhpMyAdminHandoff, createWebsiteDatabaseBackup, deleteWebsiteDatabase, finalizeDatabaseCredentialDelete, finalizeWebsiteDatabaseDelete, getWebsiteDatabaseDeletePreview, getWebsiteDatabaseResources, panelRequest, previewDatabaseCredentialApply, previewDatabaseCredentialDelete, previewWebsiteDatabaseRestore, queueDatabaseCredentialDelete, restoreWebsiteDatabase, rotateDatabaseCredential, waitForJob } from '../api.js';
import { databaseBackupChoices, databaseRestorePreviewView, websiteDatabaseDeletePreviewView, formatDatabaseBytes, websiteDatabaseResourcesView } from './database-model.js';
import { Badge, Button, ConfirmDialog, EmptyState, ErrorNotice, Icon, KeyValues, LinkButton, Modal, Section } from './PanelKit.jsx';
import { useWorkspace } from './WorkspaceContext.jsx';
import { openWebsitePhpMyAdmin } from './phpmyadmin-client.js';
import { siteHref } from './site-model.js';
import SiteMailPanel from './SiteMailPanel.jsx';
import './ui/site-resource-workspace.css';

const DELETE_BLOCKER_LABELS = Object.freeze({
  database_not_found: 'Veritabanı bulunamadı; bağlantı kaydı henüz kapatılamaz.',
  database_credential_exists: 'Önce veritabanı kullanıcısını kaldırın.',
  database_current_binding_backup_required: 'Güncel site bağlantısına ait doğrulanmış bir yedek gerekli.',
  database_job_active: 'Bu veritabanında devam eden bir işlem var.',
});
export default function SiteResourcesPanel(props) {
  if (props.activeTab === 'mail') return <SiteMailPanel key={props.website?.id ?? props.domain.id} {...props} />;
  return <DatabaseWorkspace key={props.website?.id ?? props.domain.id} {...props} />;
}
function DatabaseWorkspace({ domain, website, application, server, activeTab }) {
  const { jobs, observe, resourceBusy, updateJob, canManage, isOwner } = useWorkspace();
  const operationPending = useRef(false), alive = useRef(true), generation = useRef(0);
  const [databaseResources, setDatabaseResources] = useState(undefined);
  const [error, setError] = useState(null), [busy, setBusy] = useState(false), [notice, setNotice] = useState(null);
  const [rotateTarget, setRotateTarget] = useState(null), [revokeTarget, setRevokeTarget] = useState(null);
  const [backupTarget, setBackupTarget] = useState(null), [restoreTarget, setRestoreTarget] = useState(null);
  const [dropImpact, setDropImpact] = useState(null), [deleteTarget, setDeleteTarget] = useState(null);
  const [phpMyAdminOpeningCredentialId, setPhpMyAdminOpeningCredentialId] = useState(null);
  const [selectedBinding, setSelectedBinding] = useState(null), [query, setQuery] = useState('');
  const [accessTarget, setAccessTarget] = useState(null);
  const load = useCallback(async () => {
    if (!server || !website) { setDatabaseResources(null); return; }
    const current = ++generation.current;
    setBusy(true); setError(null);
    try {
      // A database tab must not request a global mail inventory as a side effect.
      const resources = await getWebsiteDatabaseResources(server.id, website.id);
      const databaseView = resources ? websiteDatabaseResourcesView(resources) : null;
      if (resources && !databaseView) throw new Error('Site veritabanı durumu okunamadı.');
      if (alive.current && current === generation.current) setDatabaseResources(databaseView);
    } catch (failure) { if (alive.current && current === generation.current && failure.name !== 'AbortError') setError(failure.message); }
    finally { if (alive.current && current === generation.current) setBusy(false); }
  }, [server?.id, website?.id]);
  useEffect(() => { alive.current = true; void load(); return () => { alive.current = false; generation.current++; }; }, [load]);
  const databaseEndpoint = (bindingId) => `/servers/${encodeURIComponent(server.id)}/database-bindings/${encodeURIComponent(bindingId)}`;
  async function createAccess(binding) {
    if (!canManage || !server || operationPending.current) return;
    operationPending.current = true; setBusy(true); setError(null);
    try {
      const preview = await panelRequest(`${databaseEndpoint(binding.id)}/credential-create-preview`);
      if (preview.databaseBindingId !== binding.id || preview.databaseName !== binding.databaseName || !Array.isArray(preview.defaultPrivileges) || typeof preview.confirmation !== 'string') throw new Error('Erişim önizlemesi site kaydıyla eşleşmiyor.');
      setSelectedBinding(null); setAccessTarget({ binding, preview, credential: null, job: null });
    } catch (failure) { if (failure.name !== 'AbortError') setError(failure.message); }
    finally { operationPending.current = false; setBusy(false); }
  }
  async function applyAccess() {
    if (!accessTarget || operationPending.current || !canManage) return;
    operationPending.current = true; setBusy(true); setError(null); setNotice(null);
    try {
      let credential = accessTarget.credential;
      if (!credential) {
        credential = await panelRequest(`${databaseEndpoint(accessTarget.binding.id)}/credential`, { method: 'POST', body: { privileges: accessTarget.preview.defaultPrivileges, confirmation: accessTarget.preview.confirmation } });
        if (!credential?.id) throw new Error('Veritabanı kullanıcı kaydı alınamadı.');
        setAccessTarget((value) => value ? { ...value, credential } : value);
      }
      let job = accessTarget.job;
      if (!job) {
        const preview = await previewDatabaseCredentialApply(server.id, credential.id);
        const queued = await applyDatabaseCredential(server.id, credential.id, preview);
        job = queued?.job;
        if (!job?.id) throw new Error('Erişim uygulama işi oluşturulamadı.');
        setAccessTarget((value) => value ? { ...value, credential, job } : value);
        observe(job); jobs.refresh();
      }
      if (['failed', 'cancelled'].includes(job.status)) throw new Error('Erişim işi başarısız oldu. İşlem kaydını inceleyin; otomatik tekrar yapılmadı.');
      const terminal = job.status === 'succeeded' ? job : await waitForJob(job.id);
      updateJob(terminal); setAccessTarget((value) => value ? { ...value, credential, job: terminal } : value);
      if (terminal.status !== 'succeeded') throw new Error('Erişim henüz uygulanmadı. İşlem kaydını inceleyin.');
      await load(); setAccessTarget(null); setNotice('Siteye özel veritabanı erişimi oluşturuldu.');
    } catch (failure) { if (failure.name !== 'AbortError') setError(failure.message); }
    finally { operationPending.current = false; setBusy(false); }
  }
  async function openPhpMyAdmin(credential) {
    if (!server || !website || !credential || operationPending.current || !canManage) return;
    operationPending.current = true; setBusy(true); setError(null); setNotice(null); setPhpMyAdminOpeningCredentialId(credential.id);
    try { await openWebsitePhpMyAdmin({ serverId: server.id, websiteId: website.id, credentialId: credential.id, issueHandoff: createPhpMyAdminHandoff }); }
    catch (failure) { if (failure.name !== 'AbortError') setError(failure.message); }
    finally { operationPending.current = false; setPhpMyAdminOpeningCredentialId(null); setBusy(false); }
  }
  async function rotateCredential() {
    if (!server || !rotateTarget || operationPending.current || !canManage) return;
    operationPending.current = true; setBusy(true); setError(null); setNotice(null); let queued = null;
    try {
      let rotatedCredential = rotateTarget.rotatedCredential;
      if (!rotatedCredential) {
        rotatedCredential = await rotateDatabaseCredential(server.id, rotateTarget.credential.id, rotateTarget.credential.revision);
        setRotateTarget((current) => current?.credential.id === rotateTarget.credential.id ? { ...current, credential: rotatedCredential, rotatedCredential } : current);
      }
      const preview = await previewDatabaseCredentialApply(server.id, rotatedCredential.id);
      queued = await applyDatabaseCredential(server.id, rotatedCredential.id, preview);
      if (!queued?.job?.id) throw new Error('Database credential apply işi oluşturulamadı');
      observe(queued.job); jobs.refresh(); const terminal = await waitForJob(queued.job.id); updateJob(terminal);
      if (terminal.status !== 'succeeded') throw new Error('Parola değişikliği tamamlanmadı. İşlem kaydını inceleyin.');
      await load(); setRotateTarget(null); setNotice(`${rotateTarget.credential.username} parolası değiştirildi. Uygulamanızın bağlantı ayarlarını kontrol edin.`);
    } catch (failure) {
      if (failure.name !== 'AbortError') setError(failure.message); jobs.refresh();
      if (queued?.job?.id) { try { const currentJob = await panelRequest(`/jobs/${encodeURIComponent(queued.job.id)}`); updateJob(currentJob); if (['failed', 'cancelled'].includes(currentJob?.status)) setRotateTarget((current) => current?.credential.id === rotateTarget.credential.id ? { ...current, rotatedCredential: null } : current); } catch { /* Job drawer remains source of truth. */ } }
    } finally { operationPending.current = false; setBusy(false); }
  }
  async function revokeCredential() {
    if (!server || !revokeTarget || operationPending.current || !canManage) return;
    operationPending.current = true; setBusy(true); setError(null); setNotice(null); let deleteJob = revokeTarget.deleteJob;
    try {
      if (!deleteJob) {
        const preview = await previewDatabaseCredentialDelete(server.id, revokeTarget.credential.id);
        const queued = await queueDatabaseCredentialDelete(server.id, revokeTarget.credential.id, preview); deleteJob = queued?.job;
        if (!deleteJob?.id) throw new Error('Database credential delete işi oluşturulamadı');
        setRevokeTarget((current) => current?.credential.id === revokeTarget.credential.id ? { ...current, deleteJob } : current); observe(deleteJob); jobs.refresh();
      }
      if (['failed', 'cancelled'].includes(deleteJob.status)) throw new Error('Credential delete işi terminal hatayla kapandı; job tanısını inceleyin. Kör replay yapılmadı.');
      const terminal = deleteJob.status === 'succeeded' ? deleteJob : await waitForJob(deleteJob.id); updateJob(terminal);
      setRevokeTarget((current) => current?.credential.id === revokeTarget.credential.id ? { ...current, deleteJob: terminal } : current);
      if (terminal.status !== 'succeeded') throw new Error('Kullanıcı kaldırma işlemi tamamlanmadı.');
      await finalizeDatabaseCredentialDelete(server.id, revokeTarget.credential.id, revokeTarget.credential.revision, terminal.id);
      await load(); setRevokeTarget(null); setNotice('Veritabanı kullanıcısı kaldırıldı. Veritabanı ve site bağlantısı korundu.');
    } catch (failure) {
      if (failure.name !== 'AbortError') setError(failure.message); jobs.refresh();
      if (deleteJob?.id) { try { const currentJob = await panelRequest(`/jobs/${encodeURIComponent(deleteJob.id)}`); updateJob(currentJob); setRevokeTarget((current) => current?.credential.id === revokeTarget.credential.id ? { ...current, deleteJob: currentJob } : current); } catch { /* Never replay unknown outcomes. */ } }
    } finally { operationPending.current = false; setBusy(false); }
  }
  async function backupDatabase() {
    if (!server || !website || !backupTarget || operationPending.current || !canManage) return;
    operationPending.current = true; setBusy(true); setError(null); setNotice(null); let backupJob = backupTarget.backupJob;
    try {
      if (!backupJob) {
        const queued = await createWebsiteDatabaseBackup(server.id, website.id, backupTarget.binding.id, backupTarget.binding.revision); backupJob = queued?.job;
        if (!backupJob?.id) throw new Error('Database backup işi oluşturulamadı');
        setBackupTarget((current) => current?.binding.id === backupTarget.binding.id ? { ...current, backupJob } : current); observe(backupJob); jobs.refresh();
      }
      if (['failed', 'cancelled'].includes(backupJob.status)) throw new Error('Database backup işi terminal hatayla kapandı; job tanısını inceleyin. Kör replay yapılmadı.');
      const terminal = backupJob.status === 'succeeded' ? backupJob : await waitForJob(backupJob.id); updateJob(terminal);
      if (terminal.status !== 'succeeded') throw new Error('Yedek tamamlanmadı.');
      setBackupTarget(null); setNotice(`${backupTarget.binding.databaseName} yedeği doğrulandı. Yedek kimliği: ${terminal.result?.backupId ?? terminal.id}`);
    } catch (failure) {
      if (failure.name !== 'AbortError') setError(failure.message); jobs.refresh();
      if (backupJob?.id) { try { const currentJob = await panelRequest(`/jobs/${encodeURIComponent(backupJob.id)}`); updateJob(currentJob); setBackupTarget((current) => current?.binding.id === backupTarget.binding.id ? { ...current, backupJob: currentJob } : current); } catch { /* Never replay unknown outcomes. */ } }
    } finally { operationPending.current = false; setBusy(false); }
  }
  async function buildRestorePreview() {
    if (!server || !website || !restoreTarget || operationPending.current || !canManage) return;
    operationPending.current = true; setBusy(true); setError(null); setNotice(null);
    try {
      const raw = await previewWebsiteDatabaseRestore(server.id, website.id, restoreTarget.binding.id, restoreTarget.binding.revision, restoreTarget.backupId);
      const preview = databaseRestorePreviewView(raw, { serverId: server.id, databaseName: restoreTarget.binding.databaseName, backupId: restoreTarget.backupId, websiteId: website.id, applicationId: website.applicationId, bindingId: restoreTarget.binding.id, bindingRevision: restoreTarget.binding.revision });
      if (!preview) throw new Error('Database restore preview durumu geçersiz');
      setRestoreTarget((current) => current?.binding.id === restoreTarget.binding.id ? { ...current, preview, restoreJob: null } : current);
    } catch (failure) { if (failure.name !== 'AbortError') setError(failure.message); }
    finally { operationPending.current = false; setBusy(false); }
  }
  async function restoreDatabaseBackup() {
    if (!server || !website || !restoreTarget?.preview || operationPending.current || !canManage) return;
    operationPending.current = true; setBusy(true); setError(null); setNotice(null); let restoreJob = restoreTarget.restoreJob;
    try {
      if (!restoreJob) {
        const queued = await restoreWebsiteDatabase(server.id, website.id, restoreTarget.binding.id, restoreTarget.binding.revision, restoreTarget.preview); restoreJob = queued?.job;
        if (!restoreJob?.id) throw new Error('Database restore işi oluşturulamadı');
        setRestoreTarget((current) => current?.binding.id === restoreTarget.binding.id ? { ...current, restoreJob } : current); observe(restoreJob); jobs.refresh();
      }
      if (['failed', 'cancelled'].includes(restoreJob.status)) throw new Error('Database restore işi terminal hatayla kapandı; job tanısını inceleyin. Kör replay yapılmadı.');
      const terminal = restoreJob.status === 'succeeded' ? restoreJob : await waitForJob(restoreJob.id); updateJob(terminal);
      if (terminal.status !== 'succeeded') throw new Error('Geri yükleme tamamlanmadı.');
      await load(); setRestoreTarget(null); setNotice(`${restoreTarget.binding.databaseName} geri yüklendi. İşlem öncesi yedek: ${terminal.result?.preRestoreBackupId ?? 'işlem kaydında'}`);
    } catch (failure) {
      if (failure.name !== 'AbortError') setError(failure.message); jobs.refresh();
      if (restoreJob?.id) { try { const currentJob = await panelRequest(`/jobs/${encodeURIComponent(restoreJob.id)}`); updateJob(currentJob); setRestoreTarget((current) => current?.binding.id === restoreTarget.binding.id ? { ...current, restoreJob: currentJob } : current); } catch { /* Never replay unknown outcomes. */ } }
    } finally { operationPending.current = false; setBusy(false); }
  }
  async function previewDatabaseDrop(binding) {
    if (!server || !website || operationPending.current || !canManage) return;
    operationPending.current = true; setBusy(true); setError(null); setNotice(null); setDropImpact(null); setDeleteTarget(null);
    try {
      const raw = await getWebsiteDatabaseDeletePreview(server.id, website.id, binding.id);
      const preview = websiteDatabaseDeletePreviewView(raw, { serverId: server.id, websiteId: website.id, applicationId: website.applicationId, bindingId: binding.id, bindingRevision: binding.revision, databaseName: binding.databaseName });
      if (!preview) throw new Error('Website database delete preview durumu geçersiz');
      setDropImpact(preview);
    } catch (failure) { if (failure.name !== 'AbortError') setError(failure.message); }
    finally { operationPending.current = false; setBusy(false); }
  }
  async function deleteDatabaseLifecycle() {
    if (!server || !website || !deleteTarget || operationPending.current || !canManage) return;
    operationPending.current = true; setBusy(true); setError(null); setNotice(null); let deleteJob = deleteTarget.deleteJob;
    try {
      if (!deleteJob) {
        const queued = await deleteWebsiteDatabase(server.id, website.id, deleteTarget.bindingId, deleteTarget.bindingRevision, deleteTarget); deleteJob = queued?.job;
        if (!deleteJob?.id) throw new Error('Database delete işi oluşturulamadı');
        setDeleteTarget((current) => current?.bindingId === deleteTarget.bindingId ? { ...current, deleteJob } : current); observe(deleteJob); jobs.refresh();
      }
      if (['failed', 'cancelled'].includes(deleteJob.status)) throw new Error('Database delete işi terminal hatayla kapandı; job tanısını inceleyin. Kör replay yapılmadı.');
      const terminal = deleteJob.status === 'succeeded' ? deleteJob : await waitForJob(deleteJob.id); updateJob(terminal);
      setDeleteTarget((current) => current?.bindingId === deleteTarget.bindingId ? { ...current, deleteJob: terminal } : current);
      if (terminal.status !== 'succeeded') throw new Error('Veritabanı silme işlemi tamamlanmadı.');
      await finalizeWebsiteDatabaseDelete(server.id, website.id, deleteTarget.bindingId, deleteTarget.bindingRevision, terminal.id);
      await load(); setDeleteTarget(null); setDropImpact(null); setNotice(`${deleteTarget.databaseName} silindi ve site bağlantısı doğrulanarak kaldırıldı.`);
    } catch (failure) {
      if (failure.name !== 'AbortError') setError(failure.message); jobs.refresh();
      if (deleteJob?.id) { try { const currentJob = await panelRequest(`/jobs/${encodeURIComponent(deleteJob.id)}`); updateJob(currentJob); setDeleteTarget((current) => current?.bindingId === deleteTarget.bindingId ? { ...current, deleteJob: currentJob } : current); } catch { /* Never replay unknown outcomes. */ } }
    } finally { operationPending.current = false; setBusy(false); }
  }
  const databases = databaseResources?.databases ?? [];
  const filtered = databases.filter(({binding,credential}) => [binding.databaseName,credential?.username].some((value) => String(value ?? '').toLowerCase().includes(query.toLowerCase())));
  const chosen = databases.find(({binding}) => binding.id === selectedBinding);
  const backupsByBinding = new Map(databases.map(({binding}) => [binding.id, databaseBackupChoices(jobs.items, { serverId: server?.id, databaseName: binding.databaseName, websiteId: website?.id, bindingId: binding.id, bindingRevision: binding.revision })]));
  const openAction = (callback) => { setSelectedBinding(null); setError(null); setNotice(null); callback(); };
  const showOverview = !activeTab || activeTab === 'resources';
  const hasDialog = rotateTarget || revokeTarget || backupTarget || restoreTarget || dropImpact || deleteTarget || accessTarget || chosen;
  const compose = website?.managedComposeBinding;
  return <div className="ys-resources">
    {!hasDialog && <ErrorNotice error={error} />}{notice && <div className="ws-notice" role="status"><Icon name="check" /><span>{notice}</span></div>}
    {showOverview ? <><div className="ys-resource-links"><LinkButton to={siteHref(domain.id,'databases')} icon="database">Veritabanları · {databaseResources === undefined ? '…' : databases.length}</LinkButton><LinkButton to={siteHref(domain.id,'mail')} icon="mail">E-posta yönetimi</LinkButton><LinkButton to={siteHref(domain.id,'files')} icon="folder">Dosya yöneticisi</LinkButton></div><Section title="Site kaynakları"><KeyValues items={[
      ['Site',domain.primaryDomain],['Uygulama',application?.name ?? '—'],['Çalışma türü',website?.runtimeType],['Veritabanı',databaseResources === undefined ? 'Yükleniyor…' : databases.length],
    ]} />{compose && isOwner && <div className="ws-section-body"><LinkButton to={`/docker/${encodeURIComponent(compose.projectId)}`} icon="box">Compose projesini yönet</LinkButton></div>}</Section></> : <Section title="Veritabanları" description={`${domain.primaryDomain} sitesine bağlı veritabanları ve erişim kullanıcıları.`} actions={<Button icon="refresh" disabled={busy} onClick={load}>Yenile</Button>}>
      <div className="ys-resource-summary"><span><strong>{databaseResources === undefined ? '—' : databases.length}</strong> veritabanı</span><span><strong>{databaseResources === undefined ? '—' : databases.filter((entry) => entry.credential).length}</strong> erişim kullanıcısı</span><span><Icon name="shield" size={14} /> Bu siteye özel</span></div>
      <div className="ys-resource-search"><Icon name="search" /><label><span className="ws-sr-only">Site veritabanlarında ara</span><input type="search" placeholder="Veritabanı veya kullanıcı ara…" value={query} onChange={(event) => setQuery(event.target.value)} /></label></div>
      {busy && databaseResources === undefined && <div className="ws-loading" role="status"><span className="ws-spinner" />Veritabanları yükleniyor…</div>}
      {filtered.length > 0 ? <div className="ws-table-scroll"><table className="ys-resource-table" role="table" aria-label="Bu sitenin veritabanları"><thead><tr><th scope="col">Veritabanı</th><th scope="col">Kullanıcı</th><th scope="col">Erişim</th><th scope="col">İşlemler</th></tr></thead><tbody>{filtered.map(({binding,credential}) => <tr key={binding.id} role="row"><td role="cell"><div className="ys-db-title"><span><Icon name="database" size={21} /></span><div><strong>{binding.databaseName}</strong><small>{domain.primaryDomain}</small></div></div></td><td role="cell" data-label="Kullanıcı"><code>{credential?.username ?? 'Henüz oluşturulmadı'}</code></td><td role="cell"><Badge state={credential ? 'staged' : 'warning'}>{credential ? 'Kullanıcı tanımlı' : 'Erişim gerekli'}</Badge></td><td role="cell"><div className="ys-resource-actions">{credential ? <Button icon="external" disabled={busy || !canManage || resourceBusy('database', binding.databaseName)} onClick={() => openPhpMyAdmin(credential)}>{phpMyAdminOpeningCredentialId === credential.id ? 'phpMyAdmin açılıyor…' : 'phpMyAdmin aç'}</Button> : <Button icon="user" disabled={busy || !canManage || resourceBusy('database', binding.databaseName)} onClick={() => createAccess(binding)}>Erişimi oluştur</Button>}<Button icon="settings" disabled={busy} onClick={() => setSelectedBinding(binding.id)}>Yönet</Button></div></td></tr>)}</tbody></table></div> : databaseResources !== undefined && <EmptyState icon="database" title={query ? 'Eşleşen veritabanı yok' : 'Bu siteye bağlı veritabanı yok'} detail={query ? 'Aramanızı değiştirin.' : 'Site kurulumu sırasında oluşturulan veya yönetici tarafından bu siteye bağlanan veritabanları burada görünür.'} />}
    </Section>}
    {chosen && <Modal title={chosen.binding.databaseName} onClose={() => setSelectedBinding(null)} busy={busy}><KeyValues items={[
      ['Site',domain.primaryDomain],['Veritabanı kullanıcısı',chosen.credential?.username ?? 'Yok'],['İzinler',chosen.credential?.privileges.join(', ') ?? 'Yok'],
    ]} /><div className="ys-database-controls"><Button icon="archive" disabled={busy || !canManage || resourceBusy('database', chosen.binding.databaseName)} onClick={() => openAction(() => setBackupTarget({binding:chosen.binding,backupJob:null}))}>Yedek al</Button><Button icon="refresh" disabled={busy || !canManage || resourceBusy('database',chosen.binding.databaseName) || !backupsByBinding.get(chosen.binding.id)?.length} onClick={() => openAction(() => { const choices=backupsByBinding.get(chosen.binding.id); setRestoreTarget({binding:chosen.binding,choices,backupId:choices[0].id,preview:null,restoreJob:null}); })}>Geri yükle</Button>{chosen.credential && <><Button icon="check" disabled={busy || !canManage || resourceBusy('database',chosen.binding.databaseName)} onClick={() => openAction(() => setAccessTarget({binding:chosen.binding,credential:chosen.credential,preview:null,job:null}))}>Erişimi uygula</Button><Button icon="user" disabled={busy || !canManage || resourceBusy('database',chosen.binding.databaseName)} onClick={() => openAction(() => setRotateTarget({binding:chosen.binding,credential:chosen.credential,rotatedCredential:null}))}>Parolayı değiştir</Button><Button disabled={busy || !canManage || resourceBusy('database',chosen.binding.databaseName)} onClick={() => openAction(() => setRevokeTarget({binding:chosen.binding,credential:chosen.credential,deleteJob:null}))}>Kullanıcıyı kaldır…</Button></>}<Button icon="trash" variant="danger" disabled={busy || !canManage || resourceBusy('database',chosen.binding.databaseName)} onClick={() => openAction(() => previewDatabaseDrop(chosen.binding))}>Silme önizleme</Button></div><details className="ys-technical"><summary>Teknik ayrıntılar</summary><KeyValues items={[
      ['Bağlantı kimliği',chosen.binding.id],['Site kullanıcısı',chosen.binding.unixUser],['Revizyon',chosen.binding.revision],
    ]} /></details>{!backupsByBinding.get(chosen.binding.id)?.length && <p className="ws-muted">Geri yükleme için önce bu site bağlantısına ait doğrulanmış bir yedek alın.</p>}</Modal>}
    {accessTarget && <ConfirmDialog title={accessTarget.credential ? 'Veritabanı erişimini uygula' : 'Veritabanı erişimi oluştur'} message={`${accessTarget.binding.databaseName} için siteye özel bir kullanıcı hazırlanacak ve izinleri sunucuya uygulanacak. Parola sunucuda güvenle saklanır.`} confirmation={accessTarget.binding.databaseName} confirmLabel={accessTarget.credential ? 'Erişim uygulamasına devam et' : 'Erişimi oluştur'} busy={busy} error={error} onCancel={() => { if(!busy) {setAccessTarget(null);void load();} }} onConfirm={applyAccess} />}
    {rotateTarget && <ConfirmDialog key={`${rotateTarget.credential.id}:${rotateTarget.credential.revision}:${rotateTarget.rotatedCredential?.revision ?? 'pending'}`} title="Veritabanı parolasını değiştir" message={`${rotateTarget.binding.databaseName} için yeni parola atanacak. Bu kullanıcıyı kullanan uygulamanın bağlantı ayarları ayrıca güncellenmiyorsa bağlantı kesilebilir. Parola tarayıcıya açılmaz.`} confirmation={rotateTarget.credential.username} busy={busy} error={error} onCancel={() => {if(!busy){setRotateTarget(null);setError(null);}}} onConfirm={rotateCredential} confirmLabel="Parolayı döndür ve uygula" />}
    {revokeTarget && <ConfirmDialog key={`${revokeTarget.credential.id}:${revokeTarget.deleteJob?.id ?? 'preview'}`} title="Veritabanı kullanıcısını kaldır" message={`${revokeTarget.credential.username} hesabının bağlantıları kesilir. Schema ve Website binding silinmez; yalnız başarılı silme işi doğrulandıktan sonra kullanıcı kaydı kaldırılır.`} confirmation={revokeTarget.credential.username} busy={busy} error={error} onCancel={() => {if(!busy){setRevokeTarget(null);setError(null);}}} onConfirm={revokeCredential} confirmLabel="Kullanıcıyı kaldır" />}
    {backupTarget && <ConfirmDialog key={`${backupTarget.binding.id}:${backupTarget.backupJob?.id ?? 'queue'}`} title="Veritabanı yedeği al" message={`${backupTarget.binding.databaseName} için sunucuda korumalı bir yedek oluşturulacak; checksum kanıtı oluşmadan başarılı sayılmaz.`} confirmation={backupTarget.binding.databaseName} busy={busy} error={error} onCancel={() => {if(!busy){setBackupTarget(null);setError(null);}}} onConfirm={backupDatabase} confirmLabel="Yedeği başlat" />}
    {restoreTarget && !restoreTarget.preview && <Modal title="Yedek seç" busy={busy} onClose={() => {if(!busy){setRestoreTarget(null);setError(null);}}}><ErrorNotice error={error} /><form onSubmit={(event) => {event.preventDefault();buildRestorePreview();}}><label>Doğrulanmış yedek<select value={restoreTarget.backupId} onChange={(event) => setRestoreTarget({...restoreTarget,backupId:event.target.value,preview:null,restoreJob:null})} disabled={busy}>{restoreTarget.choices.map((choice) => <option key={choice.id} value={choice.id}>{choice.createdAt} · {formatDatabaseBytes(choice.dumpBytes)}</option>)}</select></label><p className="ws-muted">Yalnız bu site bağlantısına ait doğrulanmış yedekler listelenir.</p><footer className="ws-modal-footer"><Button disabled={busy} onClick={() => setRestoreTarget(null)}>Vazgeç</Button><Button type="submit" variant="primary" disabled={busy}>Geri yükleme önizlemesi</Button></footer></form></Modal>}
    {restoreTarget?.preview && <ConfirmDialog key={`${restoreTarget.binding.id}:${restoreTarget.backupId}:${restoreTarget.restoreJob?.id ?? 'apply'}`} title="Yedeği geri yükle" message={`${restoreTarget.binding.databaseName} seçilen yedeğe döndürülecek. İşlem önce pre-restore snapshot alır; checksum ve post-restore doğrulaması tamamlanmadan başarılı sayılmaz.`} confirmation={restoreTarget.binding.databaseName} busy={busy} error={error} onCancel={() => {if(!busy){setRestoreTarget(null);setError(null);}}} onConfirm={restoreDatabaseBackup} confirmLabel="Yedeği geri yükle" />}
    {dropImpact && <Modal title="Veritabanı silme etkisi" busy={busy} onClose={() => {if(!busy)setDropImpact(null);}}><KeyValues items={[
      ['Veritabanı',dropImpact.databaseName],['Kullanıcı',dropImpact.credential?.username ?? 'Yok'],['Doğrulanmış yedek',dropImpact.backup?.backupId ?? 'Yok'],['Aktif işlem',dropImpact.activeJobs.length],
    ]} /><p className="ws-muted">Silme için güncel bağlantıya ait yedek ve kaldırılmış kullanıcı gerekir. Bu önizleme veri silmez.</p>{dropImpact.blockers.length > 0 && <ul className="ys-blockers">{dropImpact.blockers.map((code) => <li key={code}>{DELETE_BLOCKER_LABELS[code] ?? code}</li>)}</ul>}{dropImpact.readyToFinalize && <div className="ws-notice" role="status">DROP tamamlandı, binding finalization bekliyor. Yeni silme işi oluşturulmayacak.</div>}<details className="ys-technical"><summary>Doğrulama ayrıntıları</summary><KeyValues items={[
      ['Bağlantı',`${dropImpact.bindingId} · ${dropImpact.bindingRevision}`],['Önizleme',dropImpact.previewDigest],
    ]} /></details><footer className="ws-modal-footer"><Button disabled={busy} onClick={() => setDropImpact(null)}>Kapat</Button>{dropImpact.readyToDelete && <Button variant="danger" disabled={busy || !canManage} onClick={() => {setError(null);setDeleteTarget({...dropImpact,deleteJob:null});setDropImpact(null);}}>Silme onayına geç</Button>}{dropImpact.readyToFinalize && <Button variant="primary" disabled={busy || !canManage} onClick={() => {setError(null);setDeleteTarget({...dropImpact,deleteJob:{id:dropImpact.completedDelete.jobId,status:'succeeded'}});setDropImpact(null);}}>Binding finalization’ı tamamla</Button>}</footer></Modal>}
    {deleteTarget && <ConfirmDialog key={`${deleteTarget.bindingId}:${deleteTarget.bindingRevision}:${deleteTarget.deleteJob?.id ?? 'queue'}`} title={deleteTarget.deleteJob?.status === 'succeeded' ? 'Site bağlantısını kaldırmayı tamamla' : 'Veritabanını kalıcı olarak sil'} message={deleteTarget.deleteJob?.status === 'succeeded' ? 'successful scoped DROP job zaten kanıtlandı. Yeni DROP oluşturulmayacak; yalnız site bağlantısının sonlandırılması doğrulanacak.' : `${deleteTarget.databaseName} güncel bağlantı revizyonuna ait doğrulanmış yedeği kontrol edilerek silinecek. Bu işlem uygulamanın veritabanı erişimini keser.`} confirmation={deleteTarget.databaseName} busy={busy} error={error} onCancel={() => {if(!busy){setDeleteTarget(null);setError(null);}}} onConfirm={deleteDatabaseLifecycle} confirmLabel={deleteTarget.deleteJob?.status === 'succeeded' ? 'Sonlandırmayı tamamla' : 'Veritabanını sil'} />}
  </div>;
}
