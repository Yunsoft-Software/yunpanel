import { useCallback, useEffect, useRef, useState } from 'react';
import {
  applyDatabaseCredential,
  createPhpMyAdminHandoff,
  createWebsiteDatabaseBackup,
  deleteWebsiteDatabase,
  finalizeDatabaseCredentialDelete,
  finalizeWebsiteDatabaseDelete,
  getWebsiteDatabaseDeletePreview,
  getWebsiteDatabaseResources,
  panelRequest,
  previewDatabaseCredentialApply,
  previewDatabaseCredentialDelete,
  previewWebsiteDatabaseRestore,
  queueDatabaseCredentialDelete,
  restoreWebsiteDatabase,
  rotateDatabaseCredential,
  waitForJob,
} from '../api.js';
import {
  databaseBackupChoices,
  databaseRestorePreviewView,
  websiteDatabaseDeletePreviewView,
  formatDatabaseBytes,
  websiteDatabaseResourcesView,
} from './database-model.js';
import {
  Badge,
  Button,
  ConfirmDialog,
  EmptyState,
  ErrorNotice,
  KeyValues,
  LinkButton,
  Modal,
  Section,
} from './PanelKit.jsx';
import { useWorkspace } from './WorkspaceContext.jsx';
import { openWebsitePhpMyAdmin } from './phpmyadmin-client.js';

const DELETE_BLOCKER_LABELS = Object.freeze({
  database_not_found: 'Canlı schema bulunamadı; binding finalize edilemez.',
  database_credential_exists: 'Önce managed database credential kaldırılmalı.',
  database_current_binding_backup_required: 'Mevcut Website binding revizyonuna ait doğrulanmış vendor dump yedeği gerekli.',
  database_job_active: 'Başka bir database işi queued/running durumda.',
});

export default function SiteResourcesPanel({ domain, website, application, server }) {
  const { jobs, observe, resourceBusy, updateJob, canManage } = useWorkspace();
  const operationPending = useRef(false);
  const [mailDomains, setMailDomains] = useState(undefined);
  const [databaseResources, setDatabaseResources] = useState(undefined);
  const [error, setError] = useState(null);
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState(null);
  const [rotateTarget, setRotateTarget] = useState(null);
  const [revokeTarget, setRevokeTarget] = useState(null);
  const [backupTarget, setBackupTarget] = useState(null);
  const [restoreTarget, setRestoreTarget] = useState(null);
  const [dropImpact, setDropImpact] = useState(null);
  const [deleteTarget, setDeleteTarget] = useState(null);
  const [phpMyAdminOpeningCredentialId, setPhpMyAdminOpeningCredentialId] = useState(null);

  const load = useCallback(async () => {
    if (!server) return;
    setBusy(true); setError(null);
    try {
      const [mail, resources] = await Promise.all([
        panelRequest('/mail-domains'),
        website ? getWebsiteDatabaseResources(server.id, website.id) : Promise.resolve(null),
      ]);
      setMailDomains((Array.isArray(mail) ? mail : []).filter((item) => item.webDomainId === domain.id));
      const databaseView = resources ? websiteDatabaseResourcesView(resources) : null;
      if (resources && !databaseView) throw new Error('Website veritabanı durumu geçersiz');
      setDatabaseResources(databaseView);
    } catch (failure) {
      if (failure.name !== 'AbortError') setError(failure.message);
    } finally {
      setBusy(false);
    }
  }, [server?.id, domain.id, website?.id, application?.id]);

  useEffect(() => { load(); }, [load]);


  async function openPhpMyAdmin(credential) {
    if (!server || !website || !credential || operationPending.current) return;
    operationPending.current = true;
    setBusy(true); setError(null); setNotice(null);
    setPhpMyAdminOpeningCredentialId(credential.id);
    try {
      await openWebsitePhpMyAdmin({
        serverId: server.id,
        websiteId: website.id,
        credentialId: credential.id,
        issueHandoff: createPhpMyAdminHandoff,
      });
    } catch (failure) {
      if (failure.name !== 'AbortError') setError(failure.message);
    } finally {
      operationPending.current = false;
      setPhpMyAdminOpeningCredentialId(null);
      setBusy(false);
    }
  }

  async function rotateCredential() {
    if (!server || !rotateTarget || operationPending.current) return;
    operationPending.current = true;
    setBusy(true); setError(null); setNotice(null);
    let queued = null;
    try {
      let rotatedCredential = rotateTarget.rotatedCredential;
      if (!rotatedCredential) {
        rotatedCredential = await rotateDatabaseCredential(
          server.id,
          rotateTarget.credential.id,
          rotateTarget.credential.revision,
        );
        setRotateTarget((current) => current?.credential.id === rotateTarget.credential.id
          ? { ...current, credential: rotatedCredential, rotatedCredential }
          : current);
      }
      const preview = await previewDatabaseCredentialApply(server.id, rotatedCredential.id);
      queued = await applyDatabaseCredential(server.id, rotatedCredential.id, preview);
      if (!queued?.job?.id) throw new Error('Database credential apply işi oluşturulamadı');
      observe(queued.job);
      jobs.refresh();
      const terminal = await waitForJob(queued.job.id);
      updateJob(terminal);
      await load();
      setRotateTarget(null);
      setNotice(`${rotateTarget.credential.username} parolası host üzerinde döndürüldü; secret arayüze veya job kaydına açılmadı.`);
    } catch (failure) {
      if (failure.name !== 'AbortError') setError(failure.message);
      jobs.refresh();
      if (queued?.job?.id) {
        try {
          const currentJob = await panelRequest(`/jobs/${encodeURIComponent(queued.job.id)}`);
          updateJob(currentJob);
          if (['failed', 'cancelled'].includes(currentJob?.status)) {
            setRotateTarget((current) => current?.credential.id === rotateTarget.credential.id
              ? { ...current, rotatedCredential: null }
              : current);
          }
        } catch {
          // Job drawer refresh remains the source of truth when this read is unavailable.
        }
      }
    } finally {
      operationPending.current = false;
      setBusy(false);
    }
  }

  async function revokeCredential() {
    if (!server || !revokeTarget || operationPending.current) return;
    operationPending.current = true;
    setBusy(true); setError(null); setNotice(null);
    let deleteJob = revokeTarget.deleteJob;
    try {
      if (!deleteJob) {
        const preview = await previewDatabaseCredentialDelete(server.id, revokeTarget.credential.id);
        const queued = await queueDatabaseCredentialDelete(server.id, revokeTarget.credential.id, preview);
        deleteJob = queued?.job;
        if (!deleteJob?.id) throw new Error('Database credential delete işi oluşturulamadı');
        setRevokeTarget((current) => current?.credential.id === revokeTarget.credential.id
          ? { ...current, deleteJob }
          : current);
        observe(deleteJob);
        jobs.refresh();
      }
      if (['failed', 'cancelled'].includes(deleteJob.status)) {
        throw new Error('Credential delete işi terminal hatayla kapandı; job tanısını inceleyin. Kör replay yapılmadı.');
      }
      const terminal = deleteJob.status === 'succeeded' ? deleteJob : await waitForJob(deleteJob.id);
      updateJob(terminal);
      setRevokeTarget((current) => current?.credential.id === revokeTarget.credential.id
        ? { ...current, deleteJob: terminal }
        : current);
      await finalizeDatabaseCredentialDelete(
        server.id,
        revokeTarget.credential.id,
        revokeTarget.credential.revision,
        terminal.id,
      );
      await load();
      setRevokeTarget(null);
      setNotice(`${revokeTarget.credential.username} hesabı hosttan kaldırıldı ve credential kaydı başarılı job kanıtıyla finalize edildi. Schema ve Website binding korundu.`);
    } catch (failure) {
      if (failure.name !== 'AbortError') setError(failure.message);
      jobs.refresh();
      if (deleteJob?.id) {
        try {
          const currentJob = await panelRequest(`/jobs/${encodeURIComponent(deleteJob.id)}`);
          updateJob(currentJob);
          setRevokeTarget((current) => current?.credential.id === revokeTarget.credential.id
            ? { ...current, deleteJob: currentJob }
            : current);
        } catch {
          // Unknown job outcome stays visible as an error and is never replayed automatically.
        }
      }
    } finally {
      operationPending.current = false;
      setBusy(false);
    }
  }

  async function backupDatabase() {
    if (!server || !website || !backupTarget || operationPending.current) return;
    operationPending.current = true;
    setBusy(true); setError(null); setNotice(null);
    let backupJob = backupTarget.backupJob;
    try {
      if (!backupJob) {
        const queued = await createWebsiteDatabaseBackup(
          server.id,
          website.id,
          backupTarget.binding.id,
          backupTarget.binding.revision,
        );
        backupJob = queued?.job;
        if (!backupJob?.id) throw new Error('Database backup işi oluşturulamadı');
        setBackupTarget((current) => current?.binding.id === backupTarget.binding.id
          ? { ...current, backupJob }
          : current);
        observe(backupJob);
        jobs.refresh();
      }
      if (['failed', 'cancelled'].includes(backupJob.status)) {
        throw new Error('Database backup işi terminal hatayla kapandı; job tanısını inceleyin. Kör replay yapılmadı.');
      }
      const terminal = backupJob.status === 'succeeded' ? backupJob : await waitForJob(backupJob.id);
      updateJob(terminal);
      setBackupTarget(null);
      setNotice(`${backupTarget.binding.databaseName} vendor dump yedeği doğrulandı. Backup kimliği: ${terminal.result?.backupId ?? terminal.id}`);
    } catch (failure) {
      if (failure.name !== 'AbortError') setError(failure.message);
      jobs.refresh();
      if (backupJob?.id) {
        try {
          const currentJob = await panelRequest(`/jobs/${encodeURIComponent(backupJob.id)}`);
          updateJob(currentJob);
          setBackupTarget((current) => current?.binding.id === backupTarget.binding.id
            ? { ...current, backupJob: currentJob }
            : current);
        } catch {
          // Unknown job outcome stays visible and the UI never queues a second backup automatically.
        }
      }
    } finally {
      operationPending.current = false;
      setBusy(false);
    }
  }

  async function buildRestorePreview() {
    if (!server || !website || !restoreTarget || operationPending.current) return;
    operationPending.current = true;
    setBusy(true); setError(null); setNotice(null);
    try {
      const raw = await previewWebsiteDatabaseRestore(
        server.id,
        website.id,
        restoreTarget.binding.id,
        restoreTarget.binding.revision,
        restoreTarget.backupId,
      );
      const preview = databaseRestorePreviewView(raw, {
        serverId: server.id,
        databaseName: restoreTarget.binding.databaseName,
        backupId: restoreTarget.backupId,
        websiteId: website.id,
        applicationId: website.applicationId,
        bindingId: restoreTarget.binding.id,
        bindingRevision: restoreTarget.binding.revision,
      });
      if (!preview) throw new Error('Database restore preview durumu geçersiz');
      setRestoreTarget((current) => current?.binding.id === restoreTarget.binding.id
        ? { ...current, preview, restoreJob: null }
        : current);
    } catch (failure) {
      if (failure.name !== 'AbortError') setError(failure.message);
    } finally {
      operationPending.current = false;
      setBusy(false);
    }
  }

  async function restoreDatabaseBackup() {
    if (!server || !website || !restoreTarget?.preview || operationPending.current) return;
    operationPending.current = true;
    setBusy(true); setError(null); setNotice(null);
    let restoreJob = restoreTarget.restoreJob;
    try {
      if (!restoreJob) {
        const queued = await restoreWebsiteDatabase(
          server.id,
          website.id,
          restoreTarget.binding.id,
          restoreTarget.binding.revision,
          restoreTarget.preview,
        );
        restoreJob = queued?.job;
        if (!restoreJob?.id) throw new Error('Database restore işi oluşturulamadı');
        setRestoreTarget((current) => current?.binding.id === restoreTarget.binding.id
          ? { ...current, restoreJob }
          : current);
        observe(restoreJob);
        jobs.refresh();
      }
      if (['failed', 'cancelled'].includes(restoreJob.status)) {
        throw new Error('Database restore işi terminal hatayla kapandı; job tanısını inceleyin. Kör replay yapılmadı.');
      }
      const terminal = restoreJob.status === 'succeeded' ? restoreJob : await waitForJob(restoreJob.id);
      updateJob(terminal);
      await load();
      setRestoreTarget(null);
      setNotice(`${restoreTarget.binding.databaseName} ${restoreTarget.backupId} yedeğinden doğrulandı ve geri yüklendi. Pre-restore backup: ${terminal.result?.preRestoreBackupId ?? 'job sonucunda kayıtlı'}`);
    } catch (failure) {
      if (failure.name !== 'AbortError') setError(failure.message);
      jobs.refresh();
      if (restoreJob?.id) {
        try {
          const currentJob = await panelRequest(`/jobs/${encodeURIComponent(restoreJob.id)}`);
          updateJob(currentJob);
          setRestoreTarget((current) => current?.binding.id === restoreTarget.binding.id
            ? { ...current, restoreJob: currentJob }
            : current);
        } catch {
          // Unknown restore outcome is never replayed automatically.
        }
      }
    } finally {
      operationPending.current = false;
      setBusy(false);
    }
  }

  async function previewDatabaseDrop(binding) {
    if (!server || !website || operationPending.current) return;
    operationPending.current = true;
    setBusy(true); setError(null); setNotice(null); setDropImpact(null); setDeleteTarget(null);
    try {
      const raw = await getWebsiteDatabaseDeletePreview(server.id, website.id, binding.id);
      const preview = websiteDatabaseDeletePreviewView(raw, {
        serverId: server.id,
        websiteId: website.id,
        applicationId: website.applicationId,
        bindingId: binding.id,
        bindingRevision: binding.revision,
        databaseName: binding.databaseName,
      });
      if (!preview) throw new Error('Website database delete preview durumu geçersiz');
      setDropImpact(preview);
    } catch (failure) {
      if (failure.name !== 'AbortError') setError(failure.message);
    } finally {
      operationPending.current = false;
      setBusy(false);
    }
  }

  async function deleteDatabaseLifecycle() {
    if (!server || !website || !deleteTarget || operationPending.current) return;
    operationPending.current = true;
    setBusy(true); setError(null); setNotice(null);
    let deleteJob = deleteTarget.deleteJob;
    try {
      if (!deleteJob) {
        const queued = await deleteWebsiteDatabase(
          server.id,
          website.id,
          deleteTarget.bindingId,
          deleteTarget.bindingRevision,
          deleteTarget,
        );
        deleteJob = queued?.job;
        if (!deleteJob?.id) throw new Error('Database delete işi oluşturulamadı');
        setDeleteTarget((current) => current?.bindingId === deleteTarget.bindingId
          ? { ...current, deleteJob }
          : current);
        observe(deleteJob);
        jobs.refresh();
      }
      if (['failed', 'cancelled'].includes(deleteJob.status)) {
        throw new Error('Database delete işi terminal hatayla kapandı; job tanısını inceleyin. Kör replay yapılmadı.');
      }
      const terminal = deleteJob.status === 'succeeded' ? deleteJob : await waitForJob(deleteJob.id);
      updateJob(terminal);
      setDeleteTarget((current) => current?.bindingId === deleteTarget.bindingId
        ? { ...current, deleteJob: terminal }
        : current);
      await finalizeWebsiteDatabaseDelete(
        server.id,
        website.id,
        deleteTarget.bindingId,
        deleteTarget.bindingRevision,
        terminal.id,
      );
      await load();
      setDeleteTarget(null);
      setDropImpact(null);
      setNotice(`${deleteTarget.databaseName} schema’sı doğrulanmış scoped backup kanıtıyla silindi ve Website binding’i başarılı DROP job kanıtından sonra finalize edildi.`);
    } catch (failure) {
      if (failure.name !== 'AbortError') setError(failure.message);
      jobs.refresh();
      if (deleteJob?.id) {
        try {
          const currentJob = await panelRequest(`/jobs/${encodeURIComponent(deleteJob.id)}`);
          updateJob(currentJob);
          setDeleteTarget((current) => current?.bindingId === deleteTarget.bindingId
            ? { ...current, deleteJob: currentJob }
            : current);
        } catch {
          // Unknown delete outcome remains visible; a second DROP is never queued automatically.
        }
      }
    } finally {
      operationPending.current = false;
      setBusy(false);
    }
  }

  const compose = website?.managedComposeBinding ?? null;
  const externalDocker = website?.dockerWorkloadId ?? null;
  const mails = mailDomains ?? [];
  const databases = databaseResources?.databases ?? [];
  const backupsByBinding = new Map(databases.map(({ binding }) => [
    binding.id,
    databaseBackupChoices(jobs.items, {
      serverId: server?.id,
      databaseName: binding.databaseName,
      websiteId: website?.id,
      bindingId: binding.id,
      bindingRevision: binding.revision,
    }),
  ]));

  return <>
    <Section
      title="Bağlı kaynaklar"
      description="Yalnız explicit Website/Application/Domain ilişkileri gösterilir; port, isim veya hostname tahmini yapılmaz."
      actions={<Button icon="refresh" disabled={busy} onClick={load}>Yenile</Button>}
    >
      <div className="ws-section-body">
        <ErrorNotice error={error} />
        {notice && <p role="status" className="ws-notice">{notice}</p>}
        <KeyValues items={[
          ['Website kimliği', website?.id ?? 'Legacy / bağlı değil'],
          ['Runtime', website?.runtimeType ?? domain.targetType],
          ['Uygulama', application?.name ?? '—'],
          ['Site kullanıcısı', website?.unixUser ?? '—'],
          ['Veritabanı bağı', databaseResources === undefined ? 'Yükleniyor…' : databases.length],
          ['DB credential', databaseResources === undefined ? 'Yükleniyor…' : databases.filter((entry) => entry.credential).length],
          ['Mail domain bağı', mailDomains === undefined ? 'Yükleniyor…' : mails.length],
          ['Docker bağı', compose ? 'Managed Compose' : externalDocker ? 'External workload' : 'Yok'],
        ]} />
      </div>
    </Section>
    <div className="ws-equal-columns">
      <Section title="Veritabanları" description="Bu Website’e explicit bağlı schema ve secret-free credential/grant durumu.">
        {databases.length ? <div className="ws-table-scroll">
          <table className="ws-table">
            <thead><tr><th>Veritabanı</th><th>Site user</th><th>DB user / grant</th><th>Revizyon</th><th className="ws-row-end">İşlem</th></tr></thead>
            <tbody>{databases.map(({ binding, credential }) => <tr key={binding.id}>
              <td><strong>{binding.databaseName}</strong><small>{binding.id}</small></td>
              <td><code>{binding.unixUser}</code></td>
              <td>{credential ? <><code>{credential.username}</code><small>{credential.privileges.join(', ')}</small></> : <span>Credential oluşturulmadı</span>}</td>
              <td>{binding.revision}{credential ? ` / ${credential.revision}` : ''}</td>
              <td className="ws-row-end"><div className="ws-actions">
                {credential && <Button
                  disabled={busy || !canManage || resourceBusy('database', binding.databaseName)}
                  title="Bu Website credential kapsamıyla phpMyAdmin aç"
                  onClick={() => openPhpMyAdmin(credential)}
                >{phpMyAdminOpeningCredentialId === credential.id ? 'phpMyAdmin açılıyor…' : 'phpMyAdmin aç'}</Button>}
                <Button
                  disabled={busy || !canManage || resourceBusy('database', binding.databaseName)}
                  onClick={() => {
                    setError(null); setNotice(null);
                    setBackupTarget({ binding, backupJob: null });
                  }}
                >Yedek al</Button>
                <Button
                  disabled={busy || !canManage || resourceBusy('database', binding.databaseName) || !backupsByBinding.get(binding.id)?.length}
                  title={backupsByBinding.get(binding.id)?.length ? 'Doğrulanmış bir vendor dump yedeğini geri yükle' : 'Bu schema için başarılı backup job kanıtı yok'}
                  onClick={() => {
                    setError(null); setNotice(null);
                    const choices = backupsByBinding.get(binding.id) ?? [];
                    if (!choices.length) return;
                    setRestoreTarget({ binding, choices, backupId: choices[0].id, preview: null, restoreJob: null });
                  }}
                >Geri yükle</Button>
                <Button
                  variant="danger"
                  disabled={busy || !canManage || resourceBusy('database', binding.databaseName)}
                  onClick={() => previewDatabaseDrop(binding)}
                >Silme önizleme</Button>
                {credential && <Button
                  disabled={busy || !canManage || resourceBusy('database', binding.databaseName)}
                  onClick={() => {
                    setError(null); setNotice(null);
                    setRotateTarget({ binding, credential, rotatedCredential: null });
                  }}
                >Parolayı döndür</Button>}
                {credential && <Button
                  variant="danger"
                  disabled={busy || !canManage || resourceBusy('database', binding.databaseName)}
                  onClick={() => {
                    setError(null); setNotice(null);
                    setRevokeTarget({ binding, credential, deleteJob: null });
                  }}
                >Credential’ı kaldır</Button>}
              </div></td>
            </tr>)}</tbody>
          </table>
        </div> : databaseResources !== undefined && <EmptyState icon="database" title="Bağlı veritabanı yok" detail="Sunucu veritabanları ayrı envanterde olabilir; burada yalnız bu siteye explicit bind edilmiş kayıtlar gösterilir." />}
        <div className="ws-section-body"><LinkButton to="/databases" icon="database">Veritabanlarını yönet</LinkButton></div>
      </Section>
      <Section title="Mail" description="Web Domain kimliğiyle explicit bağlı mail-domain kayıtları.">
        {mails.length ? <div className="ws-table-scroll"><table className="ws-table"><thead><tr><th>Domain</th><th>Mod</th><th>Durum</th></tr></thead><tbody>{mails.map((mail) => <tr key={mail.id}><td><strong>{mail.domainName}</strong></td><td>{mail.managementMode}</td><td><Badge state={mail.status === 'enabled' || mail.status === 'ready' ? 'active' : mail.status === 'degraded' ? 'warning' : 'offline'}>{mail.status}</Badge></td></tr>)}</tbody></table></div> : mailDomains !== undefined && <EmptyState icon="mail" title="Bağlı mail domain yok" detail="Bu web Domain için explicit mail-domain lifecycle kaydı bulunmuyor." />}
        <div className="ws-section-body">{mails[0] ? <LinkButton to={`/mail/${encodeURIComponent(mails[0].id)}`} icon="mail">Mail’i yönet</LinkButton> : <LinkButton to="/mail" icon="mail">Mail domainleri</LinkButton>}</div>
      </Section>
    </div>
    <Section title="Docker" description="Website runtime’ına bağlı Docker identity; transient host published port burada kalıcı state olarak tutulmaz.">
      <div className="ws-section-body">{compose ? <>
        <KeyValues items={[
          ['Tür', 'Managed Compose'], ['Project ID', compose.projectId], ['Servis', compose.serviceName], ['Target port', `${compose.targetPort}/${compose.protocol}`],
        ]} />
        <LinkButton to={`/docker/${encodeURIComponent(compose.projectId)}`} icon="box">Compose projesini yönet</LinkButton>
      </> : externalDocker ? <>
        <KeyValues items={[['Tür', 'External / unverified workload'], ['Workload ID', externalDocker]]} />
        <p className="ws-muted">Bu legacy/external workload Managed Compose project gibi varsayılmaz.</p>
      </> : <EmptyState icon="box" title="Docker bağı yok" detail="Bu Website Application/static runtime kullanıyor veya Docker ile ilişkilendirilmemiş." />}</div>
    </Section>
    {rotateTarget && <ConfirmDialog
      key={`${rotateTarget.credential.id}:${rotateTarget.credential.revision}:${rotateTarget.rotatedCredential?.revision ?? 'pending'}`}
      title="Database parolasını döndür"
      message={`${rotateTarget.binding.databaseName} için ${rotateTarget.credential.username} hesabına yeni, sunucu tarafından üretilen bir parola atanacak. Secret tarayıcıya dönmez. Bu hesaba bağlı uygulama yapılandırması ayrıca senkron değilse bağlantı kesilebilir.`}
      confirmation={rotateTarget.credential.username}
      busy={busy}
      error={error}
      onCancel={() => { if (!busy) { setRotateTarget(null); setError(null); } }}
      onConfirm={rotateCredential}
      confirmLabel="Parolayı döndür ve uygula"
    />}
    {revokeTarget && <ConfirmDialog
      key={`${revokeTarget.credential.id}:${revokeTarget.deleteJob?.id ?? 'preview'}`}
      title="Database credential’ını kaldır"
      message={`${revokeTarget.binding.databaseName} için ${revokeTarget.credential.username} hesabı önce hosttan durable job ile kaldırılacak, ardından yalnız başarılı exact job kanıtıyla credential kaydı finalize edilecek. Schema ve Website binding silinmez; bu hesabı kullanan bağlantılar kesilir.`}
      confirmation={revokeTarget.credential.username}
      busy={busy}
      error={error}
      onCancel={() => { if (!busy) { setRevokeTarget(null); setError(null); } }}
      onConfirm={revokeCredential}
      confirmLabel="Credential’ı kaldır"
    />}
    {backupTarget && <ConfirmDialog
      key={`${backupTarget.binding.id}:${backupTarget.backupJob?.id ?? 'queue'}`}
      title="Database yedeği al"
      message={`${backupTarget.binding.databaseName} schema’sı native vendor dump ile root-private backup artifact’ına yazılacak. İş aynı database resource lock’ını kullanır ve checksum kanıtı oluşmadan başarılı sayılmaz.`}
      confirmation={backupTarget.binding.databaseName}
      busy={busy}
      error={error}
      onCancel={() => { if (!busy) { setBackupTarget(null); setError(null); } }}
      onConfirm={backupDatabase}
      confirmLabel="Yedeği başlat"
    />}
    {restoreTarget && !restoreTarget.preview && <Modal
      title="Database yedeğini seç"
      busy={busy}
      onClose={() => { if (!busy) { setRestoreTarget(null); setError(null); } }}
    >
      <ErrorNotice error={error} />
      <form onSubmit={(event) => { event.preventDefault(); buildRestorePreview(); }}>
        <label>Doğrulanmış backup
          <select
            value={restoreTarget.backupId}
            onChange={(event) => setRestoreTarget({ ...restoreTarget, backupId: event.target.value, preview: null, restoreJob: null })}
            disabled={busy}
          >
            {restoreTarget.choices.map((choice) => <option key={choice.id} value={choice.id}>{choice.createdAt} · {formatDatabaseBytes(choice.dumpBytes)} · {choice.id}</option>)}
          </select>
        </label>
        <p className="ws-muted">Yalnız bu local server ve schema için checksum-validated başarılı database.backup job’ları listelenir.</p>
        <footer className="ws-modal-footer"><Button disabled={busy} onClick={() => setRestoreTarget(null)}>Vazgeç</Button><Button variant="primary" type="submit" disabled={busy}>{busy ? 'Hazırlanıyor…' : 'Restore preview oluştur'}</Button></footer>
      </form>
    </Modal>}
    {restoreTarget?.preview && <ConfirmDialog
      key={`${restoreTarget.binding.id}:${restoreTarget.backupId}:${restoreTarget.restoreJob?.id ?? 'apply'}`}
      title="Database yedeğini geri yükle"
      message={`${restoreTarget.binding.databaseName} schema’sı ${restoreTarget.backupId} yedeğine döndürülecek (${formatDatabaseBytes(restoreTarget.preview.backupBytes)}, ${restoreTarget.preview.engine}). Restore önce pre-restore snapshot alır; checksum ve post-restore doğrulaması tamamlanmadan başarılı sayılmaz.`}
      confirmation={restoreTarget.binding.databaseName}
      busy={busy}
      error={error}
      onCancel={() => { if (!busy) { setRestoreTarget({ ...restoreTarget, preview: null, restoreJob: null }); setError(null); } }}
      onConfirm={restoreDatabaseBackup}
      confirmLabel="Yedeği geri yükle"
    />}
    {dropImpact && <Modal title="Database silme etkisi" onClose={() => { if (!busy) setDropImpact(null); }}>
      <KeyValues items={[
        ['Schema', dropImpact.databaseName],
        ['Canlı schema', dropImpact.exists ? 'Mevcut' : 'Bulunamadı'],
        ['Website binding', `${dropImpact.bindingId} · rev ${dropImpact.bindingRevision}`],
        ['Credential', dropImpact.credential ? `${dropImpact.credential.username} · rev ${dropImpact.credential.revision}` : 'Yok'],
        ['Current binding backup', dropImpact.backup ? `${dropImpact.backup.backupId} · ${formatDatabaseBytes(dropImpact.backup.dumpBytes)}` : 'Yok'],
        ['Aktif DB işi', dropImpact.activeJobs.length],
        ['Preview digest', dropImpact.previewDigest],
      ]} />
      {dropImpact.readyToDelete
        ? <div className="ws-notice" role="status"><div><strong>Silme önkoşulları hazır</strong><p>Credential kaldırılmış ve current binding revizyonuna ait doğrulanmış backup mevcut. DROP job sırasında binding korunur; binding yalnız başarılı job ve canlı schema yokluğu doğrulandıktan sonra finalize edilir.</p></div></div>
        : <div className="ws-notice ws-notice-warn" role="status"><div><strong>Silme engelli</strong><p>Bu preview hiçbir kaynağı silmez. Aşağıdaki blocker’lar çözülmeden DROP job oluşturulmaz.</p></div></div>}
      {dropImpact.blockers.length > 0 && <ul>{dropImpact.blockers.map((code) => <li key={code}><strong>{code}</strong>: {DELETE_BLOCKER_LABELS[code]}</li>)}</ul>}
      {dropImpact.activeJobs.length > 0 && <div className="ws-table-scroll"><table className="ws-table"><thead><tr><th>İş</th><th>Operation</th><th>Durum</th></tr></thead><tbody>{dropImpact.activeJobs.map((job) => <tr key={job.id}><td><code>{job.id}</code></td><td>{job.operation}</td><td><Badge state={job.status}>{job.status}</Badge></td></tr>)}</tbody></table></div>}
      <footer className="ws-modal-footer">
        <Button disabled={busy} onClick={() => setDropImpact(null)}>Kapat</Button>
        {dropImpact.readyToDelete && <Button
          variant="danger"
          disabled={busy || !canManage}
          onClick={() => {
            setError(null);
            setDeleteTarget({ ...dropImpact, deleteJob: null });
            setDropImpact(null);
          }}
        >Silme onayına geç</Button>}
      </footer>
    </Modal>}
    {deleteTarget && <ConfirmDialog
      key={`${deleteTarget.bindingId}:${deleteTarget.bindingRevision}:${deleteTarget.deleteJob?.id ?? 'queue'}`}
      title="Database kalıcı olarak silinsin mi?"
      message={`${deleteTarget.databaseName} schema’sı current binding revizyonuna ait doğrulanmış ${deleteTarget.backup?.backupId ?? 'backup'} yedeği fence’iyle DROP edilecek. Binding DROP sırasında korunur ve yalnız successful job + canlı schema yokluğu kanıtından sonra kaldırılır. Bu işlem çalışan uygulamanın database erişimini kalıcı olarak keser.`}
      confirmation={deleteTarget.databaseName}
      busy={busy}
      error={error}
      onCancel={() => { if (!busy) { setDeleteTarget(null); setError(null); } }}
      onConfirm={deleteDatabaseLifecycle}
      confirmLabel={deleteTarget.deleteJob?.status === 'succeeded' ? 'Binding finalization’ı yeniden dene' : 'Database’i sil'}
    />}
  </>;
}
