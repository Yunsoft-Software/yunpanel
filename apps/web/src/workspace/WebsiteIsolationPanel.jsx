import { useCallback, useEffect, useRef, useState } from 'react';
import { Badge, Button, ConfirmDialog, EmptyState, ErrorNotice, KeyValues, Section } from './PanelKit.jsx';
import {
  applyPassengerMigration,
  applyWebsiteIsolationMigration,
  getPassengerMigrationPreview,
  getWebsiteIsolationAudit,
  listWebsiteIsolationMigrations,
  rollbackWebsiteIsolationMigration,
  websiteIsolationRollbackConfirmation,
} from './website-isolation-client.js';
import {
  isolationFindingPresentation,
  isolationMigrationStatusPresentation,
  isolationRuntimeLabel,
  isolationStatusPresentation,
  isolationStepPresentation,
} from './website-isolation-model.js';

function migrationAction(audit) {
  return audit?.migration?.changes?.length === 1 ? audit.migration.changes[0]?.action : null;
}

function passengerMigrationHandoffRequired(audit) {
  if (audit?.runtimeType !== 'node' || !Array.isArray(audit?.migration?.changes)) return false;
  return audit.migration.changes.some((change) => {
    const preview = change?.current?.passengerMigrationPreview;
    return preview?.automaticMigration === false
      && preview?.migrationBlockedReason === 'passenger_legacy_runtime_not_operation_owned';
  });
}

function identityMigrationOperation(operation) {
  return operation?.adapter === 'identity'
    || (operation?.adapter == null && Array.isArray(operation?.targets) && operation.targets.length === 0);
}

function sftpMigrationOperation(operation) {
  return operation?.adapter === 'sftp';
}

function phpMigrationOperation(operation) {
  return operation?.adapter === 'php';
}

function phpContainerMigrationOperation(operation) {
  return operation?.adapter === 'php_container';
}

function migrationResultText(operation) {
  if (operation?.result) {
    if (identityMigrationOperation(operation)) {
      return operation.result.createdUnixIdentity ? 'Unix identity oluşturuldu' : 'Unix identity doğrulandı';
    }
    if (sftpMigrationOperation(operation)) {
      return operation.result.activatedSftpIsolation
        ? `SFTP izolasyonu aktif · ${operation.result.authorizedKeyCount ?? 0} anahtar`
        : 'SFTP izolasyonu doğrulandı';
    }
    if (phpMigrationOperation(operation)) {
      return operation.result.createdPhpFpmPool ? 'PHP-FPM site pool oluşturuldu' : 'PHP-FPM site pool doğrulandı';
    }
    if (phpContainerMigrationOperation(operation)) {
      return operation.result.migratedPhpContainer ? 'PHP container metadata düzeltildi' : 'PHP container metadata doğrulandı';
    }
    return `${operation.result.createdWorkspaceDirectories ?? 0} dizin oluşturuldu`;
  }
  if (operation?.compensation) {
    if (identityMigrationOperation(operation)) {
      if (operation.compensation.preservedHomeData) return 'User/group geri alındı; HOME verisi korundu';
      return operation.compensation.removedHome ? 'Unix identity ve boş HOME geri alındı' : 'Unix identity geri alındı';
    }
    if (sftpMigrationOperation(operation)) return 'Receipt-owned SFTP izolasyonu geri alındı';
    if (phpMigrationOperation(operation)) return 'Receipt-owned PHP-FPM site pool geri alındı';
    if (phpContainerMigrationOperation(operation)) return 'Receipt-owned PHP container metadata geri alındı';
    return `${operation.compensation.removedWorkspaceDirectories ?? 0} dizin kaldırıldı`;
  }
  return '—';
}

export default function WebsiteIsolationPanel({ websiteId, onChanged = null }) {
  const [audit, setAudit] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const [migrations, setMigrations] = useState([]);
  const [migrationError, setMigrationError] = useState(null);
  const [passengerPreview, setPassengerPreview] = useState(null);
  const [passengerLoading, setPassengerLoading] = useState(false);
  const [passengerError, setPassengerError] = useState(null);
  const [passengerJob, setPassengerJob] = useState(null);
  const [confirmation, setConfirmation] = useState(null);
  const [busy, setBusy] = useState(false);
  const generation = useRef(0);
  const requests = useRef(null);

  const load = useCallback(async ({ signal, showLoading = true } = {}) => {
    if (!websiteId) return;
    const current = ++generation.current;
    if (showLoading) setLoading(true);
    setError(null); setMigrationError(null);
    const [auditResult, migrationResult] = await Promise.allSettled([
      getWebsiteIsolationAudit(websiteId, { signal }),
      listWebsiteIsolationMigrations(websiteId, { signal }),
    ]);
    if (current !== generation.current) return;
    const nextAudit = auditResult.status === 'fulfilled' ? auditResult.value : null;
    if (nextAudit) setAudit(nextAudit);
    else if (auditResult.reason?.name !== 'AbortError') setError(auditResult.reason?.message ?? 'Website izolasyon denetimi yüklenemedi.');
    if (migrationResult.status === 'fulfilled') setMigrations(migrationResult.value);
    else if (migrationResult.reason?.name !== 'AbortError') setMigrationError(migrationResult.reason?.message ?? 'Migration geçmişi yüklenemedi.');

    if (nextAudit?.applicationId && passengerMigrationHandoffRequired(nextAudit)) {
      setPassengerLoading(true);
      setPassengerError(null);
      try {
        const preview = await getPassengerMigrationPreview(nextAudit.applicationId, { signal });
        if (current === generation.current) setPassengerPreview(preview);
      } catch (failure) {
        if (current === generation.current && failure.name !== 'AbortError') {
          setPassengerPreview(null);
          setPassengerError(failure.message ?? 'Passenger migration preview yüklenemedi.');
        }
      } finally {
        if (current === generation.current) setPassengerLoading(false);
      }
    } else {
      setPassengerPreview(null);
      setPassengerLoading(false);
      setPassengerError(null);
      setPassengerJob(null);
    }
    if (current === generation.current) setLoading(false);
  }, [websiteId]);

  useEffect(() => {
    if (!websiteId) {
      setAudit(null);
      setLoading(false);
      return undefined;
    }
    const controller = new AbortController();
    requests.current = controller;
    load({ signal: controller.signal });
    return () => {
      generation.current += 1;
      controller.abort();
    };
  }, [websiteId, load]);

  async function mutate(action) {
    if (busy || !requests.current) return;
    setBusy(true); setMigrationError(null);
    try {
      await action(requests.current.signal);
      setConfirmation(null);
      await load({ signal: requests.current.signal, showLoading: false });
    } catch (failure) {
      if (failure.name !== 'AbortError') setMigrationError(failure.message);
    } finally {
      if (!requests.current.signal.aborted) setBusy(false);
    }
  }

  async function queuePassengerMigration() {
    if (busy || !requests.current || !audit?.applicationId || passengerPreview?.ready !== true) return;
    setBusy(true); setPassengerError(null);
    try {
      const result = await applyPassengerMigration(audit.applicationId, passengerPreview, {
        signal: requests.current.signal,
      });
      setPassengerJob(result?.job ?? null);
      setConfirmation(null);
      if (typeof onChanged === 'function') onChanged();
      await load({ signal: requests.current.signal, showLoading: false });
    } catch (failure) {
      if (failure.name !== 'AbortError') setPassengerError(failure.message);
    } finally {
      if (!requests.current.signal.aborted) setBusy(false);
    }
  }

  if (!websiteId) return null;
  const status = isolationStatusPresentation(audit);
  const activeMigrationAction = migrationAction(audit);
  const identityApplyAvailable = audit?.migration?.applyAvailable
    && activeMigrationAction === 'create_canonical_unix_identity';
  const sftpApplyAvailable = audit?.migration?.applyAvailable
    && activeMigrationAction === 'create_sftp_isolation';
  const phpApplyAvailable = audit?.migration?.applyAvailable
    && activeMigrationAction === 'create_php_fpm_pool';
  const phpContainerApplyAvailable = audit?.migration?.applyAvailable
    && activeMigrationAction === 'repair_php_container_metadata';
  const passengerHandoffRequired = passengerMigrationHandoffRequired(audit);

  return <Section
    title="Website izolasyon denetimi"
    description="Canonical Unix kimliği, runtime yolları ve provisioning kanıtının canlı denetimi; yalnız exact preview ile operation-owned değişiklikler uygulanır."
    actions={<div className="ws-actions">
      {audit && <Badge state={status.badge}>{status.label}</Badge>}
      <Button icon="refresh" disabled={loading || busy} onClick={() => load({ signal: requests.current?.signal, showLoading: false })}>{loading ? 'Denetleniyor…' : 'Yeniden denetle'}</Button>
    </div>}
  >
    <div className="ws-section-body"><ErrorNotice error={error} />
      {loading && !audit && <div className="ws-loading" role="status"><span className="ws-spinner" />Website izolasyonu denetleniyor…</div>}
      {audit?.applicable === false && <p className="ws-muted">{isolationRuntimeLabel(audit.runtimeType)} runtime için dedicated Unix identity izolasyon denetimi uygulanmaz.</p>}
      {audit?.applicable && <KeyValues items={[
        ['Runtime', isolationRuntimeLabel(audit.runtimeType)],
        ['Beklenen Unix kullanıcısı', audit.expected?.unixUser],
        ['Beklenen HOME', audit.expected?.homeDirectory],
        ['Beklenen document root', audit.expected?.documentRoot],
        ['Beklenen geçici alan', audit.expected?.temporaryDirectory],
        ['Beklenen log alanı', audit.expected?.logDirectory],
      ]} />}
    </div>
    {audit?.inspectedSteps?.length > 0 && <div className="ws-table-scroll"><table className="ws-table">
      <thead><tr><th>İzolasyon adımı</th><th>Durum</th><th>Kanıt sonucu</th></tr></thead>
      <tbody>{audit.inspectedSteps.map((step) => {
        const presentation = isolationStepPresentation(step);
        return <tr key={step.stepId}><td><strong>{presentation.name}</strong><div className="ws-muted"><code>{step.stepId}</code></div></td><td><Badge state={presentation.badge}>{presentation.label}</Badge></td><td><code>{step.reason ?? 'satisfied'}</code></td></tr>;
      })}</tbody>
    </table></div>}
    {audit?.findings?.length > 0 && <div className="ws-table-scroll"><table className="ws-table">
      <thead><tr><th>Bulgu</th><th>Önem</th><th>Güvenli sonraki adım</th></tr></thead>
      <tbody>{audit.findings.map((finding) => {
        const presentation = isolationFindingPresentation(finding);
        return <tr key={finding.code}><td><strong>{finding.message}</strong><div className="ws-muted"><code>{finding.code}</code></div></td><td><Badge state={presentation.badge}>{presentation.label}</Badge></td><td>{finding.action}</td></tr>;
      })}</tbody>
    </table></div>}
    {audit?.applicable && audit.findings?.length === 0 && <EmptyState icon="check" title="İzolasyon doğrulandı" detail="Canonical Website kimliği ve denetlenebilen host izolasyon adımları mevcut desired state ile uyumlu." />}
    {passengerHandoffRequired && <div className="ws-section-body"><div className="ws-notice ws-notice-warn"><div>
      <strong>Passenger geçişi ayrı durable workflow ile yönetiliyor</strong>
      <p>Bu Node Website için isolation migration journal doğrudan runtime mutation yapmaz. Mevcut direct-systemd → Passenger akışı source route, release/environment evidence, Nginx checksum, target health ve systemd cleanup sınırlarını kendi operation/job ownership’i altında yönetir.</p>
      <ErrorNotice error={passengerError} />
      {passengerLoading && <div className="ws-loading" role="status"><span className="ws-spinner" />Passenger migration preview hazırlanıyor…</div>}
      {passengerPreview && <KeyValues items={[
        ['Passenger geçişi', passengerPreview.ready ? 'Hazır' : 'Bloklu'],
        ['Application', passengerPreview.application?.applicationId],
        ['Release', passengerPreview.application?.releaseId],
        ['Domain', passengerPreview.domain?.primaryDomain],
        ['Blocker', passengerPreview.blockers?.length ? passengerPreview.blockers.map((item) => item.detail ? `${item.code}:${item.detail}` : item.code).join(', ') : 'Yok'],
      ]} />}
      {passengerPreview?.ready && <Button variant="primary" disabled={busy} onClick={() => setConfirmation({ kind: 'passenger' })}>Passenger geçişini başlat</Button>}
      {passengerJob && <p className="ws-muted">Passenger migration job: <code>{passengerJob.id}</code> · <code>{passengerJob.status}</code>. Sonuç site işlem kayıtlarında izlenir.</p>}
    </div></div></div>}
    {audit?.migrationRequired && <div className="ws-section-body"><div className="ws-notice ws-notice-warn"><div><strong>{audit.migration?.applyAvailable ? (identityApplyAvailable ? 'Unix identity migration uygulanabilir' : sftpApplyAvailable ? 'SFTP migration uygulanabilir' : phpApplyAvailable ? 'PHP-FPM pool migration uygulanabilir' : phpContainerApplyAvailable ? 'PHP container metadata migration uygulanabilir' : 'Workspace migration uygulanabilir') : passengerHandoffRequired ? 'Bu runtime drift’i Passenger workflow tarafından yönetilir' : 'Bu drift için migration apply kapalı'}</strong><p>{audit.migration?.warning}</p>{audit.migration?.applyAvailable && <Button variant="primary" disabled={busy} onClick={() => setConfirmation({ kind: 'apply' })}>Exact değişiklikleri uygula</Button>}</div></div></div>}
    {audit?.migration?.changes?.some((change) => change.desired?.directories?.length > 0) && <div className="ws-table-scroll"><table className="ws-table">
      <thead><tr><th>Migration hedefi</th><th>Path</th><th>Mode</th><th>Ownership kapısı</th></tr></thead>
      <tbody>{audit.migration.changes.flatMap((change) => (change.desired?.directories ?? []).map((directory) => <tr key={`${change.action}:${directory.name}`}><td><code>{directory.name}</code></td><td><code>{directory.directory}</code></td><td><code>{directory.mode}</code></td><td><code>{change.ownership}</code></td></tr>))}</tbody>
    </table></div>}
    {(migrations.length > 0 || migrationError) && <div className="ws-section-body"><h3>Isolation migration geçmişi</h3><ErrorNotice error={migrationError} /></div>}
    {migrations.length > 0 && <div className="ws-table-scroll"><table className="ws-table">
      <thead><tr><th>Durum</th><th>Operation</th><th>Receipt sonucu</th><th>İşlem</th></tr></thead>
      <tbody>{[...migrations].reverse().map((operation) => {
        const presentation = isolationMigrationStatusPresentation(operation);
        const canRollback = ['succeeded', 'failed', 'compensation_failed'].includes(operation.status);
        return <tr key={operation.id}><td><Badge state={presentation.badge}>{presentation.label}</Badge>{operation.error && <div className="ws-muted"><code>{operation.error}</code></div>}</td><td><code>{operation.id}</code><div className="ws-muted">{identityMigrationOperation(operation) ? 'Unix identity' : sftpMigrationOperation(operation) ? 'SFTP isolation' : phpMigrationOperation(operation) ? 'PHP-FPM site pool' : phpContainerMigrationOperation(operation) ? 'PHP container metadata' : operation.targets?.map((target) => target.name).join(', ')}</div></td><td>{migrationResultText(operation)}</td><td>{canRollback ? <Button variant="danger" disabled={busy} onClick={() => setConfirmation({ kind: 'rollback', operation })}>Receipt rollback</Button> : '—'}</td></tr>;
      })}</tbody>
    </table></div>}
    {confirmation?.kind === 'passenger' && passengerPreview?.ready && <ConfirmDialog title="Direct-systemd uygulamayı Passenger’a geçir" message="Bu işlem mevcut source route ve release/environment evidence’ını yeniden doğrular, Passenger Nginx hedefini health-gated etkinleştirir ve ancak hedef sağlıklı olduktan sonra legacy systemd servisini durdurup disable etmeyi dener. Güvenli cutover kanıtlanamazsa mevcut route korunur veya operation actionable recovery state bırakır." confirmation={passengerPreview.confirmation} busy={busy} error={passengerError} onCancel={() => { setConfirmation(null); setPassengerError(null); }} onConfirm={queuePassengerMigration} confirmLabel="Passenger migration başlat" />}
    {confirmation?.kind === 'apply' && audit?.migration?.applyAvailable && <ConfirmDialog title={identityApplyAvailable ? 'Unix identity izolasyon migration’ını uygula' : sftpApplyAvailable ? 'SFTP izolasyon migration’ını uygula' : phpApplyAvailable ? 'PHP-FPM pool migration’ını uygula' : phpContainerApplyAvailable ? 'PHP container metadata migration’ını uygula' : 'Workspace izolasyon migration’ını uygula'} message={identityApplyAvailable ? 'Yalnız preview’da all-missing olduğu doğrulanan canonical Unix user/group/HOME durable receipt ile oluşturulacak. Önceden var olan identity/HOME state değiştirilmez; rollback HOME içeriğini recursive silmez.' : sftpApplyAvailable ? 'Yalnız preview’da all-missing olduğu doğrulanan site-specific SFTP chroot/mount/config/unit state durable receipt ile oluşturulacak. Foreign artifact varsa apply bloklanır; rollback yalnız receipt-owned artifact ve boş operation-created dizinleri kaldırır.' : phpApplyAvailable ? 'Yalnız container ownership, shared PHP-FPM service/package ve UMask zaten canonical iken eksik site-specific FPM pool receipt ile oluşturulacak. Migration shared runtime’ı kurmaz, enable etmez veya container ownership değiştirmez.' : phpContainerApplyAvailable ? 'Yalnız application root, releases dizini ve current symlink için preview’da kanıtlanan UID/GID/mode metadata’sı receipt ile düzeltilecek. Release içeriği site kullanıcısında kalır; recursive chown, chmod veya silme yapılmaz.' : 'Yalnız preview’da listelenen eksik tmp/log direct-child dizinleri operation receipt ile oluşturulacak. Unix hesabı, mevcut veri, runtime ve SFTP değiştirilmeyecek.'} confirmation={audit.migration.confirmation} busy={busy} error={migrationError} onCancel={() => { setConfirmation(null); setMigrationError(null); }} onConfirm={() => mutate((signal) => applyWebsiteIsolationMigration(websiteId, audit.migration, { signal }))} confirmLabel="Migration’ı uygula" />}
    {confirmation?.kind === 'rollback' && <ConfirmDialog title={identityMigrationOperation(confirmation.operation) ? 'Unix identity migration receipt’ini geri al' : sftpMigrationOperation(confirmation.operation) ? 'SFTP migration receipt’ini geri al' : phpMigrationOperation(confirmation.operation) ? 'PHP-FPM pool migration receipt’ini geri al' : phpContainerMigrationOperation(confirmation.operation) ? 'PHP container metadata migration receipt’ini geri al' : 'Workspace migration receipt’ini geri al'} message={identityMigrationOperation(confirmation.operation) ? 'Yalnız bu operation’ın oluşturduğu canonical user/group geri alınır. HOME boşsa kaldırılır; veri içeriyorsa recursive silinmeden korunur.' : sftpMigrationOperation(confirmation.operation) ? 'Yalnız receipt-owned SSH config, systemd mount unit ve operation-created boş chroot/mount dizinleri geri alınır. Veri içeren dizinler korunur; key registry silinmez.' : phpMigrationOperation(confirmation.operation) ? 'Yalnız bu operation’ın oluşturduğu site-specific PHP-FPM pool kaldırılır. Shared PHP paketi, servis durumu, UMask ve container ownership değiştirilmez.' : phpContainerMigrationOperation(confirmation.operation) ? 'Yalnız receipt’in kaydettiği application root, releases dizini ve current symlink UID/GID/mode metadata’sı geri yüklenir. Release içeriğine recursive işlem yapılmaz; arada yabancı drift oluşursa rollback bloklanır.' : 'Yalnız bu operation’ın oluşturduğu ve hâlâ boş olan dizinler kaldırılacak. Veri içeren veya önceden var olan dizinler korunur.'} confirmation={websiteIsolationRollbackConfirmation(confirmation.operation)} busy={busy} error={migrationError} onCancel={() => { setConfirmation(null); setMigrationError(null); }} onConfirm={() => mutate((signal) => rollbackWebsiteIsolationMigration(websiteId, confirmation.operation, { signal }))} confirmLabel="Receipt rollback" />}
  </Section>;
}
