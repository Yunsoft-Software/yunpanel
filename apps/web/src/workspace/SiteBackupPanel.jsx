import { useEffect, useRef, useState } from 'react';
import { panelRequest } from '../api.js';
import { usePanelSession } from '../panel-session.jsx';
import { sessionTransitionPending, sessionVersion } from '../session-client.js';
import { useWorkspace } from './WorkspaceContext.jsx';
import { Badge, Button, ConfirmDialog, EmptyState, ErrorNotice, KeyValues, Modal, Section } from './PanelKit.jsx';
import { formatDate } from './site-model.js';
import { resolveSiteBackupAccess, siteBackupErrorMessage } from './site-backup-model.js';
import { createSiteBackupClient } from './site-backup-client.js';

const ACCESS = {
  forbidden: 'Bu sitenin yedeklerine erişim izniniz yok.',
  unavailable: 'Güncel site bilgileri bekleniyor.',
  not_found: 'Bu alan adına bağlı tek bir Website kaydı bulunamadı.',
  unbound: 'Alan adı henüz bir Website kaydına bağlı değil.',
  inconsistent: 'Site ve sunucu bağlantısı doğrulanamadı.',
};
const repoState = (value) => value === 'ready' ? 'Hazır' : value === 'error' ? 'Kontrol gerekli' : 'Hazırlanmadı';
const snapshotState = (value) => ({ ready: 'Güncel', partial: 'Kısmi liste', error: 'Okunamadı', unavailable: 'Depo hazır değil' })[value] ?? 'Bilinmiyor';

export default function SiteBackupPanel({ domainId }) {
  const { session } = usePanelSession();
  const { domains, websites, canManage, refreshAll, isOwner } = useWorkspace();
  const access = resolveSiteBackupAccess({ domainId, domains, websites, canManage });
  if (access.state !== 'ready') {
    return <Section title="Yedekleme ve Geri Yükleme"><EmptyState icon="archive" title="Yedekler açılamadı"
      detail={ACCESS[access.state]} action={access.state !== 'forbidden' && <Button icon="refresh" onClick={refreshAll}>Site bilgilerini yenile</Button>} /></Section>;
  }
  const generation = sessionVersion();
  const identity = JSON.stringify([domainId, access.scope, session?.user?.id, session?.user?.role, generation, canManage]);
  return <BackupWorkspace key={identity} scope={access.scope} generation={generation} isOwner={isOwner} />;
}

function BackupWorkspace({ scope, generation, isOwner }) {
  const ref = useRef(null);
  const live = useRef(true);
  const [state, setState] = useState(null);
  const [activeOp, setActiveOp] = useState(null);

  // Backup modal state
  const [backupModalOpen, setBackupModalOpen] = useState(false);
  const [selectedRepoId, setSelectedRepoId] = useState('');
  const [backupPreview, setBackupPreview] = useState(null);
  const [backupPreviewLoading, setBackupPreviewLoading] = useState(false);
  const [backupBusy, setBackupBusy] = useState(false);
  const [backupError, setBackupError] = useState(null);

  // Restore modal state
  const [restoreTarget, setRestoreTarget] = useState(null);
  const [restorePreview, setRestorePreview] = useState(null);
  const [restorePreviewLoading, setRestorePreviewLoading] = useState(false);
  const [restoreBusy, setRestoreBusy] = useState(false);
  const [restoreError, setRestoreError] = useState(null);

  useEffect(() => {
    live.current = true;
    const client = createSiteBackupClient({
      scope,
      request: panelRequest,
      isCurrent: () => live.current && generation === sessionVersion() && !sessionTransitionPending(),
    });
    ref.current = client;
    const unsubscribe = client.subscribe(setState);
    setState(client.getSnapshot());
    void client.load();
    return () => { live.current = false; unsubscribe(); client.dispose(); ref.current = null; };
  }, [scope.websiteId, scope.serverId, generation]);

  // Polling for active operation
  useEffect(() => {
    if (!activeOp || !['queued', 'running'].includes(activeOp.status)) return;
    const timer = setInterval(async () => {
      if (!live.current || !ref.current) return;
      try {
        const updated = await ref.current.getOperation(activeOp.id);
        if (!live.current) return;
        setActiveOp(updated);
        if (['succeeded', 'failed', 'rolled_back'].includes(updated.status)) {
          void ref.current.load();
        }
      } catch {
        // ignore polling error
      }
    }, 1500);
    return () => clearInterval(timer);
  }, [activeOp?.id, activeOp?.status]);

  const data = state?.data;
  const readyRepositories = (data?.repositories ?? []).filter((r) => r.status === 'ready');
  const isOperationBusy = activeOp && ['queued', 'running'].includes(activeOp.status);

  // Start backup preview flow
  const handleOpenBackupModal = async () => {
    const defaultRepo = readyRepositories[0];
    if (!defaultRepo) return;
    setSelectedRepoId(defaultRepo.id);
    setBackupModalOpen(true);
    setBackupPreview(null);
    setBackupError(null);
    setBackupPreviewLoading(true);
    try {
      const preview = await ref.current?.previewBackup(defaultRepo.id);
      setBackupPreview(preview);
    } catch (err) {
      setBackupError(siteBackupErrorMessage(err));
    } finally {
      setBackupPreviewLoading(false);
    }
  };

  const handleRepoChange = async (repoId) => {
    setSelectedRepoId(repoId);
    setBackupPreview(null);
    setBackupError(null);
    setBackupPreviewLoading(true);
    try {
      const preview = await ref.current?.previewBackup(repoId);
      setBackupPreview(preview);
    } catch (err) {
      setBackupError(siteBackupErrorMessage(err));
    } finally {
      setBackupPreviewLoading(false);
    }
  };

  const handleConfirmBackup = async () => {
    if (!backupPreview || !ref.current) return;
    setBackupBusy(true);
    setBackupError(null);
    try {
      const op = await ref.current.queueBackup({
        repositoryId: selectedRepoId,
        expectedPreviewDigest: backupPreview.backupSetDigest,
        confirmation: backupPreview.confirmation,
      });
      setActiveOp(op);
      setBackupModalOpen(false);
    } catch (err) {
      setBackupError(siteBackupErrorMessage(err));
    } finally {
      setBackupBusy(false);
    }
  };

  // Start restore preview flow
  const handleOpenRestore = async (repository, snapshot) => {
    setRestoreTarget({ repository, snapshot });
    setRestorePreview(null);
    setRestoreError(null);
    setRestorePreviewLoading(true);
    try {
      const preview = await ref.current?.previewRestore({
        repositoryId: repository.id,
        snapshotId: snapshot.id,
      });
      setRestorePreview(preview);
    } catch (err) {
      setRestoreError(siteBackupErrorMessage(err));
    } finally {
      setRestorePreviewLoading(false);
    }
  };

  const handleConfirmRestore = async () => {
    if (!restoreTarget || !restorePreview || !ref.current) return;
    setRestoreBusy(true);
    setRestoreError(null);
    try {
      const op = await ref.current.queueRestore({
        repositoryId: restoreTarget.repository.id,
        snapshotId: restoreTarget.snapshot.id,
        expectedPreviewDigest: restorePreview.previewDigest,
        confirmation: restorePreview.confirmation,
        healthPath: restorePreview.healthSpec?.healthPath ?? '/health',
        timeoutSeconds: restorePreview.healthSpec?.timeoutSeconds ?? 30,
      });
      setActiveOp(op);
      setRestoreTarget(null);
    } catch (err) {
      setRestoreError(siteBackupErrorMessage(err));
    } finally {
      setRestoreBusy(false);
    }
  };

  return <>
    <Section title="Yedekleme ve Geri Yükleme" description="Bu siteye ait yedek kapsamını ve geri yüklenebilir snapshotları görüntüleyin."
      actions={<div className="ws-actions">
        {isOwner && <Button icon="archive" disabled={state?.loading || isOperationBusy || readyRepositories.length === 0} onClick={handleOpenBackupModal}>Yedek Al</Button>}
        <Button icon="refresh" disabled={state?.loading || state?.denied} onClick={() => void ref.current?.load()}>Yedekleri yenile</Button>
      </div>}>
      <div className="ws-section-body"><ErrorNotice error={state?.error} />
        {state?.loading && !data && <p role="status">Yedekleme bilgileri okunuyor…</p>}
        {data && <><p className="ws-muted">{state.fresh ? 'Son kontrol' : 'Önceki kontrol'}: {formatDate(data.inspectedAt)}</p>
          <KeyValues items={[
            ['Dosya/veri hedef grubu', data.backupSet.pathCount],
            ['Veritabanı', data.backupSet.databaseCount],
            ['Posta kapsamı', data.backupSet.mailCount],
            ['DNS kapsamı', data.backupSet.dnsCount],
            ['Docker quiesce', data.backupSet.composeHooksEnabled ? 'Kullanılıyor' : 'Gerekli değil'],
          ]} /></>}
        <p className="ws-muted">{isOwner
          ? 'Bu ekranda mevcut yedekler güvenli şekilde listelenir. Yeni yedek/geri yükleme motoru senkron olduğu için bağlantı kopmasında sonucu belirsiz bırakabilir; durable işlem hattına taşınmadan buradan çalıştırılmaz. Yedekleme ve geri yükleme mutasyonları exact preview ve typed confirmation ile durable job olarak çalıştırılır.'
          : 'Site hesabı yalnız kendi yedeklerini görür. Depo hedefi, sunucu yolu ve diğer sitelerin snapshotları gösterilmez; yeni yedek ve geri yükleme Owner işlemi olarak kalır.'}</p>
      </div>
    </Section>

    {/* Active Durable Operation Card */}
    {activeOp && <Section title={activeOp.kind === 'backup' ? 'Yedekleme İşlemi (Durable Job)' : 'Geri Yükleme İşlemi (Durable Job)'}
      actions={!['queued', 'running'].includes(activeOp.status) && <Button icon="close" onClick={() => setActiveOp(null)}>Kapat</Button>}>
      <div className="ws-section-body">
        <div style={{ display: 'flex', alignItems: 'center', gap: '0.75rem', marginBottom: '0.5rem' }}>
          <Badge state={activeOp.status === 'succeeded' ? 'succeeded' : activeOp.status === 'rolled_back' ? 'warning' : activeOp.status === 'failed' ? 'error' : 'running'}>
            {activeOp.status === 'queued' ? 'Kuyrukta' : activeOp.status === 'running' ? 'Yürütülüyor' : activeOp.status === 'succeeded' ? 'Başarılı' : activeOp.status === 'rolled_back' ? 'Geri Alındı (Rollback)' : 'Başarısız'}
          </Badge>
          <span>{activeOp.progress?.message ?? (activeOp.status === 'queued' ? 'İşlem sırada bekliyor…' : 'İşlem devam ediyor…')}</span>
        </div>
        {activeOp.error && <ErrorNotice error={activeOp.error.message} />}
        {activeOp.status === 'rolled_back' && <div role="alert" className="ws-notice ws-notice-warn">
          <strong>Otomatik Geri Alma:</strong> Sağlık kontrolü başarısız olduğu için site önceki haline geri alındı ({activeOp.result?.rollbackReason ?? 'health_check_failed'}).
        </div>}
        {activeOp.restartEvidence && <p className="ws-muted" style={{ fontSize: '0.85rem' }}>
          Kurtarma kanıtı: Sistem yeniden başlatması sonrası durum başarıyla uzlaştırıldı.
        </p>}
      </div>
    </Section>}

    {data && data.repositories.length === 0 && <EmptyState icon="archive" title="Yedek deposu yok" detail="Bu sunucu için henüz yapılandırılmış bir Restic deposu bulunmuyor." />}
    {data?.repositories.map((repository) => <Repository key={repository.id} repository={repository} isOwner={isOwner} isOperationBusy={isOperationBusy} onRestore={(snapshot) => handleOpenRestore(repository, snapshot)} />)}

    {/* Backup Confirmation Modal */}
    {backupModalOpen && <Modal title="Yeni Site Yedeği Al" onClose={() => !backupBusy && setBackupModalOpen(false)} busy={backupBusy}>
      {readyRepositories.length > 1 && <div style={{ marginBottom: '1rem' }}>
        <label>Yedek Deposu Seçin:
          <select value={selectedRepoId} disabled={backupBusy || backupPreviewLoading} onChange={(e) => handleRepoChange(e.target.value)}>
            {readyRepositories.map((r) => <option key={r.id} value={r.id}>{r.name} ({r.backend === 'rclone' ? 'Uzak' : 'Yerel'})</option>)}
          </select>
        </label>
      </div>}
      {backupPreviewLoading && <p role="status">Yedekleme önizlemesi hazırlanıyor…</p>}
      <ErrorNotice error={backupError} />
      {backupPreview && <ConfirmDialog
        title="Yedekleme Onayı"
        message={`Bu site için seçilen depoya durable yedekleme başlatılacaktır. Veritabanları (${backupPreview.databases.length}), posta ve DNS kayıtları yedek setine dahildir.`}
        confirmation={backupPreview.confirmation}
        busy={backupBusy}
        error={backupError}
        confirmLabel="Yedeği Başlat"
        onCancel={() => !backupBusy && setBackupModalOpen(false)}
        onConfirm={handleConfirmBackup}
      />}
    </Modal>}

    {/* Restore Confirmation Modal */}
    {restoreTarget && <Modal title={`Snapshot Geri Yükle: ${restoreTarget.snapshot.shortId}`} onClose={() => !restoreBusy && setRestoreTarget(null)} busy={restoreBusy}>
      {restorePreviewLoading && <p role="status">Geri yükleme önizlemesi ve sağlık kontrolleri hazırlanıyor…</p>}
      <ErrorNotice error={restoreError} />
      {restorePreview && <ConfirmDialog
        title="Geri Yükleme Onayı"
        message={`UYARI: Bu işlem sitenin mevcut dosyalarını '${restoreTarget.snapshot.shortId}' (${formatDate(restoreTarget.snapshot.time)}) anlık görüntüsüyle değiştirecektir. İşlem öncesi otomatik bir geri yükleme öncesi anlık görüntü (pre-restore snapshot) alınacak, ardından sağlık kontrolü (/health) doğrulanacaktır. Sağlık kontrolü başarısız olursa sistem otomatik olarak geri alma (rollback) yapacaktır.`}
        confirmation={restorePreview.confirmation}
        busy={restoreBusy}
        error={restoreError}
        confirmLabel="Geri Yüklemeyi Başlat"
        onCancel={() => !restoreBusy && setRestoreTarget(null)}
        onConfirm={handleConfirmRestore}
      />}
    </Modal>}
  </>;
}

function Repository({ repository, isOwner, isOperationBusy, onRestore }) {
  const description = (repository.backend === 'rclone' ? 'Uzak depo' : 'Yerel depo') + ' · ' + repoState(repository.status);
  return <Section title={repository.name} description={description}>
    <div className="ws-section-body"><KeyValues items={[
      ['Depo durumu', repoState(repository.status)],
      ['Snapshot görünümü', snapshotState(repository.snapshotStatus)],
      ['Son depo kontrolü', formatDate(repository.lastCheckedAt)],
      ['Son kayıtlı snapshot', formatDate(repository.lastSnapshotAt)],
      ['Saklama politikası', retentionLabel(repository.retentionPolicy)],
    ]} /></div>
    {repository.snapshots.length === 0
      ? <EmptyState icon="archive" title="Bu site için snapshot yok"
        detail={repository.snapshotStatus === 'error'
          ? 'Snapshot listesi okunamadı; depo yolunu veya ham hatayı site hesabına göstermeden Owner kontrolü gerekir.'
          : 'Bu depoda bu Website etiketiyle eşleşen snapshot bulunamadı.'} />
      : <div className="ws-table-wrap"><table className="ws-table"><thead><tr><th>Snapshot</th><th>Tür</th><th>Tarih</th>{isOwner && <th>İşlem</th>}</tr></thead><tbody>
        {repository.snapshots.map((snapshot) => <tr key={snapshot.id}><td><code>{snapshot.shortId}</code></td>
          <td><Badge state={snapshot.kind === 'pre_restore' ? 'warning' : 'active'}>{snapshot.kind === 'pre_restore' ? 'Geri yükleme öncesi' : 'Site yedeği'}</Badge></td>
          <td>{formatDate(snapshot.time)}</td>
          {isOwner && <td>
            <Button variant="secondary" disabled={isOperationBusy || repository.status !== 'ready'} onClick={() => onRestore(snapshot)}>Geri Yükle</Button>
          </td>}</tr>)}
      </tbody></table></div>}
  </Section>;
}

function retentionLabel(value) {
  if (!value) return 'Tanımlı değil';
  const labels = [];
  if (value.keepLast) labels.push(`Son ${value.keepLast}`);
  if (value.keepDaily) labels.push(`Günlük ${value.keepDaily}`);
  if (value.keepWeekly) labels.push(`Haftalık ${value.keepWeekly}`);
  if (value.keepMonthly) labels.push(`Aylık ${value.keepMonthly}`);
  if (value.keepYearly) labels.push(`Yıllık ${value.keepYearly}`);
  if (Array.isArray(value.keepTags) && value.keepTags.length > 0) labels.push(`Etiketler: ${value.keepTags.join(', ')}`);
  return labels.length > 0 ? labels.join(' · ') : 'Tanımlı değil';
}
