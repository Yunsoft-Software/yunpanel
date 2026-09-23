import { useEffect, useRef, useState } from 'react';
import { usePanelSession } from '../panel-session.jsx';
import { sessionVersion, sessionTransitionPending } from '../session-client.js';
import { Badge, Button, ConfirmDialog, ErrorNotice, Section } from './PanelKit.jsx';
import {
  compensateWebsiteProvisioningStep, continueWebsiteProvisioning,
  getLatestWebsiteProvisioning, retryWebsiteProvisioningStep,
} from './provisioning-client.js';
import {
  provisioningBadgeState, provisioningOperationLabel, provisioningRemediation,
  provisioningStepLabel, provisioningStepStateLabel,
} from './provisioning-model.js';
import { createProvisioningRecovery, EMPTY_RECOVERY, recoveryAllowed, recoveryBusy } from './provisioning-recovery.js';

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
    message: 'Başarısız adım yeniden değerlendirilecek. Sunucu önce mevcut durumu kontrol eder; tamamlanmış kaynaklar körlemesine yeniden oluşturulmaz.',
    confirmLabel: 'Adımı tekrar dene',
  };
  if (action === 'compensate') return {
    title: `${label} adımını geri al`,
    message: 'Bu adımın oluşturduğu kaynaklar kaldırılabilir. Sunucu yalnız bu işleme ait olduğu doğrulanan kaynakları geri alır. İlgili hizmet etkilenebilir.',
    confirmLabel: 'Geri almayı başlat',
  };
  return {
    title: 'Site kurulumuna devam et',
    message: 'Sunucu sıradaki bekleyen veya kesintiye uğramış adımı kontrol edecek. Kayıt değişmişse bu onayla işlem yapılmayacak.',
    confirmLabel: 'Kuruluma devam et',
  };
}

export default function ProvisioningRecoveryPanel({ websiteId, canManage = false, onChanged }) {
  const { session } = usePanelSession();
  const identity = JSON.stringify([websiteId, session?.user?.id, session?.user?.role, sessionVersion(), canManage]);
  if (!websiteId) return null;
  return <RecoveryPanel key={identity} websiteId={websiteId} canManage={canManage} onChanged={onChanged} />;
}
function RecoveryPanel({ websiteId, canManage, onChanged }) {
  const [state, setState] = useState(EMPTY_RECOVERY);
  const client = useRef(null);
  const changed = useRef(onChanged);
  useEffect(() => { changed.current = onChanged; }, [onChanged]);
  useEffect(() => {
    const version = sessionVersion();
    const flow = createProvisioningRecovery({
      websiteId, canManage: () => canManage,
      isCurrent: () => version === sessionVersion() && !sessionTransitionPending(),
      read: (options) => getLatestWebsiteProvisioning(websiteId, options),
      execute: (approval, options) => approval.action === 'retry'
        ? retryWebsiteProvisioningStep(approval.operationId, approval.stepId, options)
        : approval.action === 'compensate'
          ? compensateWebsiteProvisioningStep(approval.operationId, approval.stepId, options)
          : continueWebsiteProvisioning(approval.operationId, options),
      onState: setState,
    });
    client.current = flow;
    void flow.load();
    return () => { flow.dispose(); if (client.current === flow) client.current = null; };
  }, [websiteId, canManage]);
  useEffect(() => {
    if (state.changes > 0 && typeof changed.current === 'function') changed.current();
  }, [state.changes]);

  const { operation, approval, error, notice } = state;
  const busy = recoveryBusy(state);
  const available = canManage && state.status === 'ready' && !busy;
  const step = approval ? operation?.steps.find((item) => item.id === approval.stepId) : null;
  const copy = approval ? actionCopy(approval.action, step) : null;
  if (['idle', 'loading'].includes(state.status) && !operation) {
    return <Section title="Site kurulumu"><div className="ws-loading" role="status"><span className="ws-spinner" />Kurulum kaydı yükleniyor…</div></Section>;
  }
  if (state.status === 'ready' && !operation) return null;

  return <>
    <Section title="Site kurulumu" description="Kurulum adımlarını inceleyin; sorun giderildikten sonra devam edin veya ilgili adımı tekrar deneyin."
      actions={<div className="ws-actions">
        {operation && <Badge state={state.status === 'ready' ? operationBadgeState(operation) : 'unknown'}>{state.status === 'ready' ? provisioningOperationLabel(operation) : 'Güncel durum doğrulanmalı'}</Badge>}
        <Button icon="refresh" disabled={busy} onClick={() => client.current?.load()}>Durumu yenile</Button>
        {canManage && recoveryAllowed(operation, 'continue') && <Button variant="primary" disabled={!available} onClick={() => client.current?.prepare('continue')}>Devam et</Button>}
      </div>}
    >
      <div className="ws-section-body">
        <ErrorNotice error={error} />
        {notice && <p role="status">{notice}</p>}
        {busy && <p role="status"><span className="ws-spinner" />{state.status === 'checking' ? 'Onayladığınız kayıt yeniden kontrol ediliyor…' : state.status === 'mutating' ? 'İşlem sonucu bekleniyor…' : 'Kurulum kaydı yenileniyor…'}</p>}
        {operation && <p className="ws-muted">
          {state.status !== 'ready' ? 'Son doğrulanmış kayıt: ' : ''}{operation.progress.completed}/{operation.progress.required} zorunlu adım tamamlandı.
          {' '}Bu sayı deneme sınırı değildir. {operation.ready ? 'Yayın, SSL ve posta durumunu ilgili araçlardan ayrıca doğrulayın.' : 'Kalan adımlar tamamlanmadan kurulum hazır sayılmaz.'}
        </p>}
      </div>
      {operation && <div className="ws-table-scroll"><table className="ws-table">
        <thead><tr><th>Adım</th><th>Durum</th><th>Hata / çözüm</th><th>İşlem</th></tr></thead>
        <tbody>{operation.steps.map((item) => {
          const remediation = provisioningRemediation(item);
          return <tr key={item.id}>
            <td><strong>{provisioningStepLabel(item)}</strong><div className="ws-muted"><code>{item.id}</code></div></td>
            <td><Badge state={provisioningBadgeState(item)}>{provisioningStepStateLabel(item)}</Badge></td>
            <td>{item.error ? <code>{item.error}</code> : item.compensation.error ? <code>{item.compensation.error}</code> : <span className="ws-muted">—</span>}
              {remediation && <div className="ws-muted ws-provisioning-remediation">{remediation}</div>}
            </td>
            <td><div className="ws-actions">
              {canManage && item.canRetry && <Button disabled={!available} onClick={() => client.current?.prepare('retry', item.id)}>Tekrar dene</Button>}
              {canManage && item.canCompensate && <Button variant="danger" disabled={!available} onClick={() => client.current?.prepare('compensate', item.id)}>Geri al</Button>}
              {(!canManage || (!item.canRetry && !item.canCompensate)) && <span className="ws-muted">—</span>}
            </div></td>
          </tr>;
        })}</tbody>
      </table></div>}
      <div className="ws-section-body">
        <p className="ws-muted">Durumu yenile yalnızca kayıt okur; işlemi tekrar başlatmaz. Sayfadan ayrılmak sunucuda başlamış bir işi geri almaz.</p>
        {operation && <details><summary>Teknik bilgiler</summary><p>İşlem kimliği: <code>{operation.operationId}</code></p><p>Tekrar deneme ve geri alma onayı bu işlem ve seçilen adımla sınırlıdır.</p></details>}
      </div>
    </Section>
    {approval && copy && <ConfirmDialog key={`${approval.confirmation}:${approval.snapshot}`}
      title={copy.title} message={copy.message} confirmation={approval.confirmation}
      error={error} busy={busy} onCancel={() => client.current?.cancel()}
      onConfirm={() => client.current?.perform(approval, approval.confirmation)} confirmLabel={copy.confirmLabel}
    />}
  </>;
}
