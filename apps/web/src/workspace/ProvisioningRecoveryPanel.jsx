import { useCallback, useEffect, useRef, useState } from 'react';
import { Badge, Button, ConfirmDialog, ErrorNotice, Section } from './PanelKit.jsx';
import {
  compensateWebsiteProvisioningStep,
  continueWebsiteProvisioning,
  getLatestWebsiteProvisioning,
  provisioningConfirmation,
  retryWebsiteProvisioningStep,
} from './provisioning-client.js';
import {
  canContinueProvisioning,
  provisioningBadgeState,
  provisioningOperationLabel,
  provisioningRemediation,
  provisioningStepLabel,
  provisioningStepStateLabel,
} from './provisioning-model.js';

function operationBadgeState(operation) {
  if (operation?.ready) return 'succeeded';
  if ((operation?.steps ?? []).some((step) => step.state === 'failed')) return 'failed';
  if ((operation?.steps ?? []).some((step) => ['blocked', 'compensated'].includes(step.state))) return 'warning';
  if ((operation?.steps ?? []).some((step) => ['applying', 'compensating'].includes(step.state))) return 'running';
  return 'pending';
}

function actionCopy(action, step) {
  const label = provisioningStepLabel(step);
  if (action === 'retry') return {
    title: `${label} adımını tekrar dene`,
    message: 'Başarısız adım durable registry içinde yeniden pending duruma alınacak ve yalnız normal inspect/apply yolu üzerinden tekrar değerlendirilecek.',
    confirmLabel: 'Adımı tekrar dene',
  };
  if (action === 'compensate') return {
    title: `${label} adımını geri al`,
    message: 'Bu geri alma host durumunu değiştirebilir. Yalnız bu provisioning operation tarafından sahiplenildiği kanıtlanan kaynaklar kaldırılabilir; ownership doğrulanamazsa işlem fail-closed kalır.',
    confirmLabel: 'Geri almayı başlat',
  };
  return {
    title: 'Provisioning’e devam et',
    message: 'Sıradaki pending, blocked veya kesintiye uğramış adım durable durum ve host inspection sonucuna göre değerlendirilecek. Kör mutation tekrarı yapılmaz.',
    confirmLabel: 'Provisioning’e devam et',
  };
}

export default function ProvisioningRecoveryPanel({ websiteId, canManage = false, onChanged }) {
  const [operation, setOperation] = useState(null);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);
  const [confirm, setConfirm] = useState(null);
  const generation = useRef(0);

  const load = useCallback(async ({ signal, showLoading = true } = {}) => {
    if (!websiteId) return;
    const current = ++generation.current;
    if (showLoading) setLoading(true);
    setError(null);
    try {
      const latest = await getLatestWebsiteProvisioning(websiteId, { signal });
      if (current !== generation.current) return;
      setOperation(latest);
    } catch (failure) {
      if (failure.name === 'AbortError' || current !== generation.current) return;
      setError(failure.message);
    } finally {
      if (current === generation.current) setLoading(false);
    }
  }, [websiteId]);

  useEffect(() => {
    if (!websiteId) {
      setOperation(null);
      setLoading(false);
      return undefined;
    }
    const controller = new AbortController();
    load({ signal: controller.signal });
    return () => {
      generation.current += 1;
      controller.abort();
    };
  }, [websiteId, load]);

  async function perform(action, step = null) {
    if (busy || !operation) return;
    setBusy(true);
    setError(null);
    try {
      let result;
      if (action === 'retry') result = await retryWebsiteProvisioningStep(operation.operationId, step.id);
      else if (action === 'compensate') result = await compensateWebsiteProvisioningStep(operation.operationId, step.id);
      else result = await continueWebsiteProvisioning(operation.operationId);
      if (result?.operation) setOperation(result.operation);
      else await load({ showLoading: false });
      setConfirm(null);
      if (typeof onChanged === 'function') onChanged();
    } catch (failure) {
      if (failure.name !== 'AbortError') setError(failure.message);
    } finally {
      setBusy(false);
    }
  }

  if (!websiteId) return null;
  if (loading && !operation) {
    return <Section title="Provisioning durumu"><div className="ws-loading" role="status"><span className="ws-spinner" />Provisioning kaydı yükleniyor…</div></Section>;
  }
  if (!operation && !error) return null;

  const progress = operation?.progress;
  const continueAllowed = canManage && canContinueProvisioning(operation);
  const activeConfirmation = confirm && operation
    ? provisioningConfirmation(confirm.action, operation.operationId, confirm.step?.id ?? null)
    : null;
  const copy = confirm ? actionCopy(confirm.action, confirm.step) : null;

  return <>
    <Section
      title="Site provisioning"
      description="Website oluşturma akışının durable adımları ve güvenli recovery işlemleri."
      actions={<div className="ws-actions">
        {operation && <Badge state={operationBadgeState(operation)}>{provisioningOperationLabel(operation)}</Badge>}
        <Button icon="refresh" disabled={busy || loading} onClick={() => load({ showLoading: false })}>Durumu yenile</Button>
        {continueAllowed && <Button variant="primary" disabled={busy} onClick={() => setConfirm({ action: 'continue', step: null })}>Devam et</Button>}
      </div>}
    >
      <div className="ws-section-body">
        <ErrorNotice error={error} />
        {operation && <p className="ws-muted">
          Operation <code>{operation.operationId}</code>{progress ? ` · ${progress.completed}/${progress.required} zorunlu adım tamamlandı` : ''}.
          {operation.ready ? ' Site provisioning hazır.' : ' Hazır olmayan site başarılı kabul edilmez.'}
        </p>}
      </div>
      {operation && <div className="ws-table-scroll"><table className="ws-table">
        <thead><tr><th>Adım</th><th>Durum</th><th>Hata / recovery</th><th>İşlem</th></tr></thead>
        <tbody>{operation.steps.map((step) => {
          const remediation = provisioningRemediation(step);
          return <tr key={step.id}>
            <td><strong>{provisioningStepLabel(step)}</strong><div className="ws-muted"><code>{step.id}</code></div></td>
            <td><Badge state={provisioningBadgeState(step)}>{provisioningStepStateLabel(step)}</Badge></td>
            <td>
              {step.error ? <code>{step.error}</code> : step.compensation?.error ? <code>{step.compensation.error}</code> : <span className="ws-muted">—</span>}
              {remediation && <div className="ws-muted ws-provisioning-remediation">{remediation}</div>}
            </td>
            <td><div className="ws-actions">
              {canManage && step.canRetry === true && <Button disabled={busy} onClick={() => setConfirm({ action: 'retry', step })}>Tekrar dene</Button>}
              {canManage && step.canCompensate === true && <Button variant="danger" disabled={busy} onClick={() => setConfirm({ action: 'compensate', step })}>Geri al</Button>}
              {(!canManage || (step.canRetry !== true && step.canCompensate !== true)) && <span className="ws-muted">—</span>}
            </div></td>
          </tr>;
        })}</tbody>
      </table></div>}
      <div className="ws-section-body"><p className="ws-muted">Retry ve compensation yalnız operation + step’e bağlı yazılı onayla çalışır. Raw intent, evidence ve secret-bearing resource verileri bu ekrana gönderilmez.</p></div>
    </Section>
    {confirm && copy && activeConfirmation && <ConfirmDialog
      title={copy.title}
      message={copy.message}
      confirmation={activeConfirmation}
      error={error}
      busy={busy}
      onCancel={() => { if (!busy) setConfirm(null); }}
      onConfirm={() => perform(confirm.action, confirm.step)}
      confirmLabel={copy.confirmLabel}
    />}
  </>;
}
