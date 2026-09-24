import { useEffect, useRef, useState } from 'react';
import { panelRequest } from '../api.js';
import { sessionVersion, sessionTransitionPending } from '../session-client.js';
import { Button, ConfirmDialog, ErrorNotice, KeyValues } from './PanelKit.jsx';
import { useWorkspace } from './WorkspaceContext.jsx';
import { formatDate } from './site-model.js';
import { createSslRenewal, EMPTY_SSL_RENEWAL, sslRenewalBusy } from './ssl-renewal.js';

const OUTCOMES = Object.freeze({
  tested: 'Yenileme testi tamamlandı. Bu test üretim sertifikası oluşturmaz veya geçerlilik süresini uzatmaz.',
  unchanged: 'İşlem tamamlandı; aynı sertifika kullanılıyor. Yenileme henüz gerekmemiş olabilir. Geçerlilik süresine gün eklenmedi.',
  renewed: 'Yenileme sonucu kalıcı sertifika kaydıyla eşleşti. Aşağıdaki tarihler ve parmak izi kayıtlı sertifikadan okundu.',
});
const ACTIVE = new Set(['waiting', 'syncing', 'paused', 'uncertain', 'unverified', 'forbidden']);

// The parent keys this component by the selected certificate, NOT its changing
// status or collection freshness, so refreshing metadata does not lose the job.
export default function SslRenewalPanel({ domain, certificate, disabled = false }) {
  const { canManage, observe, updateJob, refreshAll } = useWorkspace();
  const [state, setState] = useState(EMPTY_SSL_RENEWAL);
  const flow = useRef(null), permissions = useRef(null);
  permissions.current = { canManage, disabled };
  const callbacks = useRef({ observe, updateJob, refreshAll });
  callbacks.current = { observe, updateJob, refreshAll };
  const opened = useRef(null), invalidated = useRef('0:0');
  useEffect(() => {
    const version = sessionVersion();
    const client = createSslRenewal({ target: domain, request: panelRequest,
      isCurrent: () => version === sessionVersion() && !sessionTransitionPending(),
      canManage: () => permissions.current.canManage,
      canStart: () => !permissions.current.disabled,
      onState: setState,
    });
    flow.current = client;
    return () => { client.dispose(); if (flow.current === client) flow.current = null; };
  }, [domain.id, domain.certificateId, domain.serverId, domain.websiteId, domain.primaryDomain]);
  useEffect(() => {
    if (!state.job) return;
    if (opened.current !== state.job.id) { opened.current = state.job.id; callbacks.current.observe(state.job); }
    else callbacks.current.updateJob(state.job);
  }, [state.job]);
  useEffect(() => {
    const key = `${state.terminalVersion}:${state.syncVersion}`;
    if (invalidated.current !== key) { invalidated.current = key; callbacks.current.refreshAll(); }
  }, [state.terminalVersion, state.syncVersion]);
  useEffect(() => {
    if (!['waiting', 'syncing'].includes(state.status)) return undefined;
    const timer = setTimeout(() => { void flow.current?.refresh(); }, 2000);
    return () => clearTimeout(timer);
  }, [state]);
  const busy = sslRenewalBusy(state);
  const renewable = certificate?.state === 'active' && certificate.source === 'acme'
    && certificate.renewalMode === 'automatic' && certificate.staging === false;
  const locked = disabled || busy || ACTIVE.has(state.status) || Boolean(state.approval) || !renewable;
  const approval = state.approval;
  return <div className="ws-section-body" aria-label="SSL yenileme ve sonuç">
    <div className="ws-actions">
      <Button disabled={locked} onClick={() => flow.current?.prepare(true)}>Yenilemeyi test et</Button>
      <Button variant="primary" disabled={locked} onClick={() => flow.current?.prepare(false)}>Sertifikayı yenile</Button>
      <Button icon="refresh" disabled={busy} onClick={() => flow.current?.refresh()}>Sonucu yeniden oku</Button>
      {state.job && <Button onClick={() => callbacks.current.observe(state.job)}>İşlem ayrıntısı</Button>}
    </div>
    {certificate?.source === 'custom' && <p>Bu sertifika elle yönetiliyor; ACME yenilemesi başlatılamaz.</p>}
    <ErrorNotice error={state.error} />
    {(busy || state.status === 'waiting') && <p role="status"><span className="ws-spinner" />{state.status === 'waiting' ? 'Yenileme işi sunucuda devam ediyor…' : 'İşlem ve sertifika kaydı kontrol ediliyor…'}</p>}
    {state.status === 'paused' && <p role="status">Otomatik takip sınırına ulaşıldı. İş sunucuda devam ediyor olabilir; sonucu yeniden okuyun.</p>}
    {state.status === 'complete' && OUTCOMES[state.outcome] && <p role="status">{OUTCOMES[state.outcome]}</p>}
    {state.before && state.certificate && <>
      <KeyValues items={[
        ['İşlem öncesi bitiş', formatDate(state.before.validTo)],
        ['Kayıtlı başlangıç', formatDate(state.certificate.validFrom)],
        ['Kayıtlı bitiş', formatDate(state.certificate.validTo)],
      ]} />
      <details><summary>Sertifika karşılaştırması</summary>
        <p>Önceki SHA-256: <code>{state.before.fingerprint256}</code></p>
        <p>Kayıtlı SHA-256: <code>{state.certificate.fingerprint256}</code></p>
      </details>
    </>}
    <p className="ws-muted">Sonucu yeniden oku yalnız kayıt okur; yenilemeyi tekrar göndermez. Panel kaydıyla eşleşme, yayındaki TLS bağlantısının doğrulandığı anlamına gelmez.</p>
    {approval && <ConfirmDialog title={approval.dryRun ? 'SSL yenilemesini test et' : 'SSL yenilemesini başlat'}
      message={`${domain.primaryDomain}: ${approval.dryRun ? 'Üretim sertifikası değiştirilmeden yenileme testi yapılacak.' : 'Gerçek ACME yenilemesi istenecek. Sağlayıcı limitleri geçerlidir.'} Site veya sertifika değişirse bu onayla işlem yapılmaz.`}
      confirmation={approval.confirmation} busy={busy} error={state.error} onCancel={() => flow.current?.cancel()}
      onConfirm={() => flow.current?.confirm(approval, approval.confirmation)} confirmLabel={approval.dryRun ? 'Testi başlat' : 'Yenilemeyi başlat'} />}
  </div>;
}
