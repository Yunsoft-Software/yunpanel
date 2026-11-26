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

function staticControlMigrationOperation(operation) {
  return operation?.adapter === 'static_control';
}

function migrationResultText(operation) {
  if (operation?.result) {
    if (identityMigrationOperation(operation)) {
      return operation.result.createdUnixIdentity ? 'Sistem kullanıcısı oluşturuldu' : 'Sistem kullanıcısı doğrulandı';
    }
    if (sftpMigrationOperation(operation)) {
      return operation.result.activatedSftpIsolation
        ? `SFTP izolasyonu aktif · ${operation.result.authorizedKeyCount ?? 0} anahtar`
        : 'SFTP izolasyonu doğrulandı';
    }
    if (phpMigrationOperation(operation)) {
      return operation.result.createdPhpFpmPool ? 'PHP-FPM site havuzu oluşturuldu' : 'PHP-FPM site havuzu doğrulandı';
    }
    if (phpContainerMigrationOperation(operation)) {
      return operation.result.migratedPhpContainer ? 'PHP konteyner izinleri düzeltildi' : 'PHP konteyner izinleri doğrulandı';
    }
    if (staticControlMigrationOperation(operation)) {
      return operation.result.migratedStaticControlMetadata
        ? 'Statik site izinleri düzeltildi'
        : 'Statik site izinleri doğrulandı';
    }
    return `${operation.result.createdWorkspaceDirectories ?? 0} dizin oluşturuldu`;
  }
  if (operation?.compensation) {
    if (identityMigrationOperation(operation)) {
      if (operation.compensation.preservedHomeData) return 'Kullanıcı ve grup geri alındı; ana dizin verisi korundu';
      return operation.compensation.removedHome ? 'Sistem kullanıcısı ve boş ana dizin geri alındı' : 'Sistem kullanıcısı geri alındı';
    }
    if (sftpMigrationOperation(operation)) return 'SFTP izolasyonu geri alındı';
    if (phpMigrationOperation(operation)) return 'PHP-FPM site havuzu geri alındı';
    if (phpContainerMigrationOperation(operation)) return 'PHP konteyner izinleri geri alındı';
    if (staticControlMigrationOperation(operation)) return 'Statik site izinleri geri alındı';
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
    else if (auditResult.reason?.name !== 'AbortError') setError(auditResult.reason?.message ?? 'Site izolasyonu denetimi yüklenemedi.');
    if (migrationResult.status === 'fulfilled') setMigrations(migrationResult.value);
    else if (migrationResult.reason?.name !== 'AbortError') setMigrationError(migrationResult.reason?.message ?? 'Düzeltme geçmişi yüklenemedi.');

    if (nextAudit?.applicationId && passengerMigrationHandoffRequired(nextAudit)) {
      setPassengerLoading(true);
      setPassengerError(null);
      try {
        const preview = await getPassengerMigrationPreview(nextAudit.applicationId, { signal });
        if (current === generation.current) setPassengerPreview(preview);
      } catch (failure) {
        if (current === generation.current && failure.name !== 'AbortError') {
          setPassengerPreview(null);
          setPassengerError(failure.message ?? 'Passenger geçiş önizlemesi yüklenemedi.');
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
  const staticControlApplyAvailable = audit?.migration?.applyAvailable
    && activeMigrationAction === 'repair_static_control_metadata';
  const passengerHandoffRequired = passengerMigrationHandoffRequired(audit);

  return <Section
    title="Site izolasyonu denetimi"
    description="Sitenin sistem kullanıcısı, çalışma dizinleri ve kurulum kayıtları canlı denetlenir; değişiklikler yalnız onaylanan önizlemeyle uygulanır."
    actions={<div className="ws-actions">
      {audit && <Badge state={status.badge}>{status.label}</Badge>}
      <Button icon="refresh" disabled={loading || busy} onClick={() => load({ signal: requests.current?.signal, showLoading: false })}>{loading ? 'Denetleniyor…' : 'Yeniden denetle'}</Button>
    </div>}
  >
    <div className="ws-section-body"><ErrorNotice error={error} />
      {loading && !audit && <div className="ws-loading" role="status"><span className="ws-spinner" />Site izolasyonu denetleniyor…</div>}
      {audit?.applicable === false && <p className="ws-muted">{isolationRuntimeLabel(audit.runtimeType)} uygulamalarında ayrı sistem kullanıcısı denetimi yapılmaz.</p>}
      {audit?.applicable && <KeyValues items={[
        ['Çalışma ortamı', isolationRuntimeLabel(audit.runtimeType)],
        ['Beklenen Unix kullanıcısı', audit.expected?.unixUser],
        ['Beklenen HOME', audit.expected?.homeDirectory],
        ['Beklenen site kök dizini', audit.expected?.documentRoot],
        ['Beklenen geçici alan', audit.expected?.temporaryDirectory],
        ['Beklenen log alanı', audit.expected?.logDirectory],
      ]} />}
    </div>
    {audit?.inspectedSteps?.length > 0 && <div className="ws-table-scroll"><table className="ws-table">
      <thead><tr><th>İzolasyon adımı</th><th>Durum</th><th>Sonuç</th></tr></thead>
      <tbody>{audit.inspectedSteps.map((step) => {
        const presentation = isolationStepPresentation(step);
        return <tr key={step.stepId}><td><strong>{presentation.name}</strong><div className="ws-muted"><code>{step.stepId}</code></div></td><td><Badge state={presentation.badge}>{presentation.label}</Badge></td><td><code>{step.reason ?? 'uygun'}</code></td></tr>;
      })}</tbody>
    </table></div>}
    {audit?.findings?.length > 0 && <div className="ws-table-scroll"><table className="ws-table">
      <thead><tr><th>Bulgu</th><th>Önem</th><th>Güvenli sonraki adım</th></tr></thead>
      <tbody>{audit.findings.map((finding) => {
        const presentation = isolationFindingPresentation(finding);
        return <tr key={finding.code}><td><strong>{finding.message}</strong><div className="ws-muted"><code>{finding.code}</code></div></td><td><Badge state={presentation.badge}>{presentation.label}</Badge></td><td>{finding.action}</td></tr>;
      })}</tbody>
    </table></div>}
    {audit?.applicable && audit.findings?.length === 0 && <EmptyState icon="check" title="İzolasyon doğrulandı" detail="Sitenin sistem kullanıcısı ve denetlenen izolasyon adımları beklenen ayarlarla uyumlu." />}
    {passengerHandoffRequired && <div className="ws-section-body"><div className="ws-notice ws-notice-warn"><div>
      <strong>Passenger geçişi ayrı bir işlemle yönetilir</strong>
      <p>Bu Node.js sitesinde izolasyon düzeltmesi çalışan uygulamayı doğrudan değiştirmez. systemd’den Passenger’a geçiş; yönlendirme, sürüm ve ortam bilgisi, Nginx yapılandırması, uygulama sağlığı ve eski servisin kapatılması adımlarını kendi işleminde yürütür.</p>
      <ErrorNotice error={passengerError} />
      {passengerLoading && <div className="ws-loading" role="status"><span className="ws-spinner" />Passenger geçiş önizlemesi hazırlanıyor…</div>}
      {passengerPreview && <KeyValues items={[
        ['Passenger geçişi', passengerPreview.ready ? 'Hazır' : 'Hazır değil'],
        ['Uygulama', passengerPreview.application?.applicationId],
        ['Sürüm', passengerPreview.application?.releaseId],
        ['Alan adı', passengerPreview.domain?.primaryDomain],
        ['Engel', passengerPreview.blockers?.length ? passengerPreview.blockers.map((item) => item.detail ? `${item.code}:${item.detail}` : item.code).join(', ') : 'Yok'],
      ]} />}
      {passengerPreview?.ready && <Button variant="primary" disabled={busy} onClick={() => setConfirmation({ kind: 'passenger' })}>Passenger geçişini başlat</Button>}
      {passengerJob && <p className="ws-muted">Passenger geçiş işlemi: <code>{passengerJob.id}</code> · <code>{passengerJob.status}</code>. Sonuç site işlem kayıtlarında izlenir.</p>}
    </div></div></div>}
    {audit?.migrationRequired && <div className="ws-section-body"><div className="ws-notice ws-notice-warn"><div><strong>{audit.migration?.applyAvailable ? (identityApplyAvailable ? 'Sistem kullanıcısı düzeltmesi uygulanabilir' : sftpApplyAvailable ? 'SFTP izolasyon düzeltmesi uygulanabilir' : phpApplyAvailable ? 'PHP-FPM havuzu düzeltmesi uygulanabilir' : phpContainerApplyAvailable ? 'PHP konteyner izinleri düzeltmesi uygulanabilir' : staticControlApplyAvailable ? 'Statik site izinleri düzeltmesi uygulanabilir' : 'Çalışma alanı düzeltmesi uygulanabilir') : passengerHandoffRequired ? 'Bu fark Passenger geçişiyle giderilir' : 'Bu fark için otomatik düzeltme yok'}</strong><p>{audit.migration?.warning}</p>{audit.migration?.applyAvailable && <Button variant="primary" disabled={busy} onClick={() => setConfirmation({ kind: 'apply' })}>Önizlenen değişiklikleri uygula</Button>}</div></div></div>}
    {audit?.migration?.changes?.some((change) => change.desired?.directories?.length > 0) && <div className="ws-table-scroll"><table className="ws-table">
      <thead><tr><th>Düzeltme hedefi</th><th>Yol</th><th>İzin</th><th>Sahiplik</th></tr></thead>
      <tbody>{audit.migration.changes.flatMap((change) => (change.desired?.directories ?? []).map((directory) => <tr key={`${change.action}:${directory.name}`}><td><code>{directory.name}</code></td><td><code>{directory.directory}</code></td><td><code>{directory.mode}</code></td><td><code>{change.ownership}</code></td></tr>))}</tbody>
    </table></div>}
    {(migrations.length > 0 || migrationError) && <div className="ws-section-body"><h3>İzolasyon düzeltme geçmişi</h3><ErrorNotice error={migrationError} /></div>}
    {migrations.length > 0 && <div className="ws-table-scroll"><table className="ws-table">
      <thead><tr><th>Durum</th><th>İşlem kaydı</th><th>Sonuç</th><th>İşlem</th></tr></thead>
      <tbody>{[...migrations].reverse().map((operation) => {
        const presentation = isolationMigrationStatusPresentation(operation);
        const canRollback = ['succeeded', 'failed', 'compensation_failed'].includes(operation.status);
        return <tr key={operation.id}><td><Badge state={presentation.badge}>{presentation.label}</Badge>{operation.error && <div className="ws-muted"><code>{operation.error}</code></div>}</td><td><code>{operation.id}</code><div className="ws-muted">{identityMigrationOperation(operation) ? 'Sistem kullanıcısı' : sftpMigrationOperation(operation) ? 'SFTP izolasyonu' : phpMigrationOperation(operation) ? 'PHP-FPM site havuzu' : phpContainerMigrationOperation(operation) ? 'PHP konteyner izinleri' : staticControlMigrationOperation(operation) ? 'Statik site izinleri' : operation.targets?.map((target) => target.name).join(', ')}</div></td><td>{migrationResultText(operation)}</td><td>{canRollback ? <Button variant="danger" disabled={busy} onClick={() => setConfirmation({ kind: 'rollback', operation })}>Geri al</Button> : '—'}</td></tr>;
      })}</tbody>
    </table></div>}
    {confirmation?.kind === 'passenger' && passengerPreview?.ready && <ConfirmDialog title="systemd uygulamasını Passenger’a geçir" message="Bu işlem yönlendirme, sürüm ve ortam bilgisini yeniden doğrular, Passenger Nginx hedefini uygulama sağlıklıysa etkinleştirir ve ardından eski systemd servisini durdurup devre dışı bırakmayı dener. Güvenli geçiş doğrulanamazsa mevcut yönlendirme korunur veya işlem kurtarma için bekletilir." confirmation={passengerPreview.confirmation} busy={busy} error={passengerError} onCancel={() => { setConfirmation(null); setPassengerError(null); }} onConfirm={queuePassengerMigration} confirmLabel="Passenger geçişini başlat" />}
    {confirmation?.kind === 'apply' && audit?.migration?.applyAvailable && (
      <ConfirmDialog
        title={
          identityApplyAvailable
            ? 'Sistem kullanıcısı düzeltmesini uygula'
            : sftpApplyAvailable
              ? 'SFTP izolasyon düzeltmesini uygula'
              : phpApplyAvailable
                ? 'PHP-FPM havuzu düzeltmesini uygula'
                : phpContainerApplyAvailable
                  ? 'PHP konteyner izinleri düzeltmesini uygula'
                  : staticControlApplyAvailable
                    ? 'Statik site izinleri düzeltmesini uygula'
                    : 'Çalışma alanı düzeltmesini uygula'
        }
        message={
          identityApplyAvailable
            ? 'Önizlemede tamamen eksik olduğu doğrulanan site sistem kullanıcısı, grubu ve ana dizini oluşturulacak. Var olan kullanıcı veya ana dizin değiştirilmez; geri alma ana dizin içeriğini silmez.'
            : sftpApplyAvailable
              ? 'Önizlemede eksik olduğu doğrulanan siteye özel SFTP kök dizini, bağlama ve yapılandırması oluşturulacak. Başka bir kaynağa ait dosya varsa işlem durur; geri alma yalnız bu işlemin oluşturduklarını ve boş dizinleri kaldırır.'
              : phpApplyAvailable
                ? 'Konteyner sahipliği, ortak PHP-FPM servisi ve izin maskesi zaten doğruysa eksik olan siteye özel PHP-FPM havuzu oluşturulacak. Ortak PHP kurulumu, servis durumu veya konteyner sahipliği değiştirilmez.'
                : phpContainerApplyAvailable
                  ? 'Uygulama kök dizini, sürümler dizini ve geçerli sürüm bağlantısının önizlemede gösterilen sahiplik ve izinleri düzeltilecek. Sürüm dosyaları site kullanıcısında kalır; alt dizinlerde toplu sahiplik, izin değişikliği veya silme yapılmaz.'
                  : staticControlApplyAvailable
                    ? 'Statik yayın dizini, sürümler dizini ve geçerli sürüm bağlantısının sahiplik ve izinleri düzeltilecek. Sürüm dosyaları ve Nginx erişim izinleri zaten sağlıklı olmalıdır; alt dizinlerde toplu sahiplik veya izin değişikliği yapılmaz.'
                    : 'Önizlemede listelenen eksik geçici dosya ve günlük dizinleri oluşturulacak. Sistem kullanıcısı, mevcut veri, uygulama ve SFTP değiştirilmez.'
        }
        confirmation={audit.migration.confirmation}
        busy={busy}
        error={migrationError}
        onCancel={() => {
          setConfirmation(null);
          setMigrationError(null);
        }}
        onConfirm={() => mutate((signal) => applyWebsiteIsolationMigration(websiteId, audit.migration, { signal }))}
        confirmLabel="Düzeltmeyi uygula"
      />
    )}
    {confirmation?.kind === 'rollback' && (
      <ConfirmDialog
        title={
          identityMigrationOperation(confirmation.operation)
            ? 'Sistem kullanıcısı düzeltmesini geri al'
            : sftpMigrationOperation(confirmation.operation)
              ? 'SFTP izolasyon düzeltmesini geri al'
              : phpMigrationOperation(confirmation.operation)
                ? 'PHP-FPM havuzu düzeltmesini geri al'
                : phpContainerMigrationOperation(confirmation.operation)
                  ? 'PHP konteyner izinleri düzeltmesini geri al'
                  : staticControlMigrationOperation(confirmation.operation)
                    ? 'Statik site izinleri düzeltmesini geri al'
                    : 'Çalışma alanı düzeltmesini geri al'
        }
        message={
          identityMigrationOperation(confirmation.operation)
            ? 'Yalnız bu işlemin oluşturduğu kullanıcı ve grup geri alınır. Ana dizin boşsa kaldırılır; veri içeriyorsa silinmeden korunur.'
            : sftpMigrationOperation(confirmation.operation)
              ? 'Yalnız bu işlemin oluşturduğu SSH yapılandırması, bağlama birimi ve boş SFTP dizinleri geri alınır. Veri içeren dizinler ve kayıtlı SSH anahtarları korunur.'
              : phpMigrationOperation(confirmation.operation)
                ? 'Yalnız bu işlemin oluşturduğu siteye özel PHP-FPM havuzu kaldırılır. Ortak PHP kurulumu, servis durumu, izin maskesi ve konteyner sahipliği değiştirilmez.'
                : phpContainerMigrationOperation(confirmation.operation)
                  ? 'Uygulama kök dizini, sürümler dizini ve geçerli sürüm bağlantısının önceki sahiplik ve izinleri geri yüklenir. Sürüm dosyalarına dokunulmaz; arada başka bir değişiklik olduysa geri alma durur.'
                  : staticControlMigrationOperation(confirmation.operation)
                    ? 'Statik yayın dizini, sürümler dizini ve geçerli sürüm bağlantısının önceki sahiplik ve izinleri geri yüklenir. Sürüm dosyalarına ve erişim izinlerine dokunulmaz; arada başka bir değişiklik olduysa geri alma durur.'
                    : 'Yalnız bu işlemin oluşturduğu ve hâlâ boş olan dizinler kaldırılacak. Veri içeren veya önceden var olan dizinler korunur.'
        }
        confirmation={websiteIsolationRollbackConfirmation(confirmation.operation)}
        busy={busy}
        error={migrationError}
        onCancel={() => {
          setConfirmation(null);
          setMigrationError(null);
        }}
        onConfirm={() => mutate((signal) => rollbackWebsiteIsolationMigration(websiteId, confirmation.operation, { signal }))}
        confirmLabel="Geri al"
      />
    )}
  </Section>;
}
