import { useCallback, useEffect, useRef, useState } from 'react';
import { Badge, Button, ConfirmDialog, EmptyState, ErrorNotice, KeyValues, Section } from './PanelKit.jsx';
import {
  applyWebsiteIsolationMigration,
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

export default function WebsiteIsolationPanel({ websiteId }) {
  const [audit, setAudit] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const [migrations, setMigrations] = useState([]);
  const [migrationError, setMigrationError] = useState(null);
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
    if (auditResult.status === 'fulfilled') setAudit(auditResult.value);
    else if (auditResult.reason?.name !== 'AbortError') setError(auditResult.reason?.message ?? 'Website izolasyon denetimi yüklenemedi.');
    if (migrationResult.status === 'fulfilled') setMigrations(migrationResult.value);
    else if (migrationResult.reason?.name !== 'AbortError') setMigrationError(migrationResult.reason?.message ?? 'Migration geçmişi yüklenemedi.');
    setLoading(false);
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

  if (!websiteId) return null;
  const status = isolationStatusPresentation(audit);

  return <Section
    title="Website izolasyon denetimi"
    description="Canonical Unix kimliği, runtime yolları ve provisioning kanıtının canlı denetimi; güvenli workspace farkları receipt-bound uygulanır."
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
    {audit?.migrationRequired && <div className="ws-section-body"><div className="ws-notice ws-notice-warn"><div><strong>{audit.migration?.applyAvailable ? 'Workspace migration uygulanabilir' : 'Bu drift için migration apply kapalı'}</strong><p>{audit.migration?.warning}</p>{audit.migration?.applyAvailable && <Button variant="primary" disabled={busy} onClick={() => setConfirmation({ kind: 'apply' })}>Exact değişiklikleri uygula</Button>}</div></div></div>}
    {audit?.migration?.changes?.some((change) => change.desired?.directories?.length > 0) && <div className="ws-table-scroll"><table className="ws-table">
      <thead><tr><th>Migration hedefi</th><th>Path</th><th>Mode</th><th>Ownership kapısı</th></tr></thead>
      <tbody>{audit.migration.changes.flatMap((change) => (change.desired?.directories ?? []).map((directory) => <tr key={`${change.action}:${directory.name}`}><td><code>{directory.name}</code></td><td><code>{directory.directory}</code></td><td><code>{directory.mode}</code></td><td><code>{change.ownershipGate}</code></td></tr>))}</tbody>
    </table></div>}
    {(migrations.length > 0 || migrationError) && <div className="ws-section-body"><h3>Isolation migration geçmişi</h3><ErrorNotice error={migrationError} /></div>}
    {migrations.length > 0 && <div className="ws-table-scroll"><table className="ws-table">
      <thead><tr><th>Durum</th><th>Operation</th><th>Receipt sonucu</th><th>İşlem</th></tr></thead>
      <tbody>{[...migrations].reverse().map((operation) => {
        const presentation = isolationMigrationStatusPresentation(operation);
        const canRollback = ['succeeded', 'failed', 'compensation_failed'].includes(operation.status);
        return <tr key={operation.id}><td><Badge state={presentation.badge}>{presentation.label}</Badge>{operation.error && <div className="ws-muted"><code>{operation.error}</code></div>}</td><td><code>{operation.id}</code><div className="ws-muted">{operation.targets?.map((target) => target.name).join(', ')}</div></td><td>{operation.result ? `${operation.result.createdWorkspaceDirectories ?? 0} oluşturuldu` : operation.compensation ? `${operation.compensation.removedWorkspaceDirectories ?? 0} kaldırıldı` : '—'}</td><td>{canRollback ? <Button variant="danger" disabled={busy} onClick={() => setConfirmation({ kind: 'rollback', operation })}>Receipt rollback</Button> : '—'}</td></tr>;
      })}</tbody>
    </table></div>}
    {confirmation?.kind === 'apply' && audit?.migration?.applyAvailable && <ConfirmDialog title="Workspace izolasyon migration’ını uygula" message="Yalnız preview’da listelenen eksik tmp/log direct-child dizinleri operation receipt ile oluşturulacak. Unix hesabı, mevcut veri, runtime ve SFTP değiştirilmeyecek." confirmation={audit.migration.confirmation} busy={busy} error={migrationError} onCancel={() => { setConfirmation(null); setMigrationError(null); }} onConfirm={() => mutate((signal) => applyWebsiteIsolationMigration(websiteId, audit.migration, { signal }))} confirmLabel="Migration’ı uygula" />}
    {confirmation?.kind === 'rollback' && <ConfirmDialog title="Workspace migration receipt’ini geri al" message="Yalnız bu operation’ın oluşturduğu ve hâlâ boş olan dizinler kaldırılacak. Veri içeren veya önceden var olan dizinler korunur." confirmation={websiteIsolationRollbackConfirmation(confirmation.operation)} busy={busy} error={migrationError} onCancel={() => { setConfirmation(null); setMigrationError(null); }} onConfirm={() => mutate((signal) => rollbackWebsiteIsolationMigration(websiteId, confirmation.operation, { signal }))} confirmLabel="Receipt rollback" />}
  </Section>;
}
