import { useEffect, useRef, useState } from 'react';
import { panelRequest } from '../api.js';
import { sessionVersion, sessionTransitionPending } from '../session-client.js';
import { Button, ConfirmDialog, ErrorNotice, LinkButton } from './PanelKit.jsx';
import { createMailboxAccessPreparation, EMPTY_MAILBOX_ACCESS, mailboxAccessBusy } from './mailbox-access-preparation.js';

// Mounted inside the existing actor-keyed removal panel. This only prepares
// access; backup, data removal and finalization stay in the existing controller.
export default function MailboxAccessPreparation({ mailbox, domain, canManage, blocked = false, onChanged, onBusyChange }) {
  const [state, setState] = useState(EMPTY_MAILBOX_ACCESS);
  const [jobId, setJobId] = useState('');
  const flow = useRef(null), changed = useRef(onChanged), blockedRef = useRef(blocked);
  blockedRef.current = blocked;
  useEffect(() => { changed.current = onChanged; }, [onChanged]);
  useEffect(() => {
    const version = sessionVersion();
    const client = createMailboxAccessPreparation({
      target: { id: mailbox.id, address: mailbox.address, mailDomainId: domain.id }, request: panelRequest,
      isCurrent: () => version === sessionVersion() && !sessionTransitionPending(),
      canManage: () => canManage && !blockedRef.current, onState: setState,
    });
    flow.current = client; void client.load();
    return () => { client.dispose(); if (flow.current === client) flow.current = null; };
  }, [mailbox.id, mailbox.address, domain.id, canManage]);
  const busy = mailboxAccessBusy(state);
  const occupied = busy || state.status === 'waiting' || Boolean(state.approval);
  useEffect(() => { onBusyChange?.(occupied); return () => onBusyChange?.(false); }, [occupied, onBusyChange]);
  useEffect(() => { if (state.changes > 0 || state.applied) changed.current?.(); }, [state.changes, state.applied]);
  useEffect(() => {
    if (state.status !== 'waiting') return undefined;
    const timer = setTimeout(() => { void flow.current?.load(); }, 2000);
    return () => clearTimeout(timer);
  }, [state.status, state.job]);
  const view = state.snapshot;
  const available = canManage && !blocked && !occupied && state.status === 'ready';
  const approval = state.approval;
  const href = `/mail/${encodeURIComponent(domain.id)}?section=configuration`;
  return <div className="ws-section-body" aria-label="Tek posta hesabı erişim hazırlığı">
    <h3>Yalnız bu hesabın erişimini kapat</h3>
    <p>{mailbox.address} kapatılır; alan adının ve diğer hesapların açık/kapalı tercihleri değiştirilmez.</p>
    <ErrorNotice error={state.error} />
    {view && <p>Seçilen hesap: {view.enabled ? 'Etkin' : 'Kapalı kaydedildi'}. Alan adı: {view.domainStatus === 'enabled' ? 'Etkin kalır' : 'Mevcut kapalı durumu korunur'}.</p>}
    <div className="ws-actions">
      <Button disabled={!available || view?.enabled !== true} onClick={() => flow.current?.prepare('disable')}>Hesabı kapat…</Button>
      <Button disabled={!available || view?.enabled !== false} onClick={() => flow.current?.prepare('apply')}>Değişikliği sunucuya uygula…</Button>
      <Button icon="refresh" disabled={busy || blocked} onClick={() => flow.current?.load()}>Erişim durumunu yenile</Button>
    </div>
    <p className="ws-muted">Uygulama, mevcut ortak posta yapılandırmasını kullanır. Başka kaydedilmiş bekleyen düzenlemeler varsa onlar da uygulanabilir. <LinkButton to={href}>Yapılandırmayı incele</LinkButton></p>
    {occupied && !approval && <p role="status">{state.status === 'waiting' ? 'Yapılandırma işi sunucuda bekleniyor…' : 'Hesap ve yapılandırma doğrulanıyor…'}</p>}
    {state.applied && <p role="status">Yapılandırma işi doğrulandı. Yedekli silmeye devam edebilirsiniz; silme işi hesap erişimini ve Dovecot oturumlarını ayrıca denetler.</p>}
    {state.job && <p>Yapılandırma işi: <code>{state.job.id}</code></p>}
    {state.status === 'uncertain' && <form className="ws-form" onSubmit={(event) => { event.preventDefault(); if (!blocked) void flow.current?.resume(jobId.trim()); }}>
      <label>İşlem geçmişindeki uygulama iş kimliği<input value={jobId} maxLength={128} autoComplete="off" onChange={(event) => setJobId(event.target.value)} /></label>
      <Button type="submit" disabled={busy || blocked || !/^[A-Za-z0-9._:-]{8,128}$/.test(jobId.trim())}>Mevcut işi doğrula</Button>
    </form>}
    {approval && <ConfirmDialog key={approval.confirmation} title={approval.action === 'disable' ? 'Yalnız seçilen hesabı kapat' : 'Hesap değişikliğini uygula'}
      message={approval.action === 'disable' ? `${mailbox.address} kapalı olarak kaydedilecek. Diğer hesaplar ve alan adı kapatılmayacak. Sunucuya uygulama sonraki adımdır.`
        : `${mailbox.address} kapalı kalacak, alan adının mevcut durumu korunacak. Önizlemesi doğrulanan ortak posta yapılandırması uygulanacak; diğer bekleyen kayıt değişiklikleri de dahil olabilir.`}
      confirmation={approval.confirmation} busy={busy} error={state.error} onCancel={() => flow.current?.cancel()}
      onConfirm={() => { if (!blocked) return flow.current?.perform(approval, approval.confirmation); return undefined; }}
      confirmLabel={approval.action === 'disable' ? 'Bu hesabı kapat' : 'Önizlenen yapılandırmayı uygula'} />}
  </div>;
}
