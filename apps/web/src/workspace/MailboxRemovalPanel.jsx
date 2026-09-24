import { useEffect, useRef, useState } from 'react';
import { panelRequest } from '../api.js';
import { usePanelSession } from '../panel-session.jsx';
import { sessionVersion, sessionTransitionPending } from '../session-client.js';
import { Button, ConfirmDialog, ErrorNotice, KeyValues, LinkButton, Section } from './PanelKit.jsx';
import MailboxAccessPreparation from './MailboxAccessPreparation.jsx';
import { createMailboxRemoval, EMPTY_MAILBOX_REMOVAL } from './mailbox-removal-controller.js';
import { mailboxRemovalBusy, mailboxRemovalEligible, mailboxRemovalJobId } from './mailbox-removal-model.js';

const ACTIONS = Object.freeze({
  backup: ['Silmeden önce yedekle', 'Yalnız seçilen posta kutusunun verisi yedeklenecek. Bu işlem hesabı veya mesajları silmez.', 'Yedeği oluştur'],
  delete: ['Posta verisini sil', 'Doğrulanmış yedek korunur; bu posta kutusunun sunucudaki mesajları kaldırılır. Hesap kaydı sonraki onayda kaldırılır.', 'Posta verisini sil'],
  finalize: ['Posta hesabını kaldır', 'Başarılı veri silme işi ve güncel bağımlılıklar yeniden doğrulanacak; yalnız seçilen posta hesabının kaydı kaldırılacak.', 'Hesap kaydını kaldır'],
});
const JOB_LABELS = Object.freeze({ queued: 'Kuyrukta', running: 'Çalışıyor', succeeded: 'Tamamlandı', failed: 'Başarısız', cancelled: 'İptal edildi' });
const KNOWN_BLOCKERS = new Set(['mail_data_backup_required', 'mailbox_quota_configured', 'mailbox_forwarding_configured', 'mailbox_alias_reference_configured', 'mail_domain_job_active']);

export default function MailboxRemovalPanel(props) {
  const { session, canManage } = usePanelSession();
  const identity = JSON.stringify([props.mailbox.id, props.mailbox.address, props.domain.id, session?.user?.id, session?.user?.role, sessionVersion(), canManage]);
  return <RemovalSession key={identity} {...props} canManage={canManage} />;
}
function RemovalSession({ mailbox, domain, canManage, onChanged, onPolicy, onClose }) {
  const [state, setState] = useState(EMPTY_MAILBOX_REMOVAL);
  const [jobId, setJobId] = useState('');
  const [accessBusy, setAccessBusy] = useState(false);
  const client = useRef(null), changed = useRef(onChanged), notified = useRef(false);
  useEffect(() => { changed.current = onChanged; }, [onChanged]);
  useEffect(() => {
    const version = sessionVersion();
    const flow = createMailboxRemoval({
      target: { id: mailbox.id, address: mailbox.address, mailDomainId: domain.id }, request: panelRequest,
      isCurrent: () => version === sessionVersion() && !sessionTransitionPending(), canManage: () => canManage,
      onState: setState,
    });
    client.current = flow; void flow.refresh();
    return () => { flow.dispose(); if (client.current === flow) client.current = null; };
  }, [mailbox.id, mailbox.address, domain.id, canManage]);
  useEffect(() => {
    if (state.status !== 'waiting') return undefined;
    const timer = setTimeout(() => { void client.current?.refresh(); }, 2000);
    return () => clearTimeout(timer);
  }, [state.status, state.job]);
  useEffect(() => {
    if (state.status === 'deleted' && !notified.current) { notified.current = true; changed.current?.(); }
  }, [state.status]);
  const removalBusy = mailboxRemovalBusy(state);
  const busy = removalBusy || accessBusy;
  const snapshot = state.snapshot;
  const usable = canManage && !accessBusy && state.status === 'ready' && !state.uncertain;
  const prepared = usable && mailboxRemovalEligible(snapshot);
  const approval = state.approval;
  const copy = approval ? ACTIONS[approval.action] : null;
  const href = (section) => `/mail/${encodeURIComponent(domain.id)}?section=${section}`;
  return <Section title={`Posta hesabını sil: ${mailbox.address}`} description="Önkoşullar → yedek → veri silme → kayıt kaldırma. Her yazma ayrı onay ister."
    actions={<div className="ws-actions"><Button icon="refresh" disabled={busy || state.status === 'deleted'} onClick={() => client.current?.refresh()}>Durumu yenile</Button><Button disabled={busy} onClick={onClose}>Kapat</Button></div>}>
    <div className="ws-section-body">
      <ErrorNotice error={state.error} />
      {!canManage && <p role="alert">Bu hesap silme işlemi başlatamaz.</p>}
      {busy && <p role="status"><span className="ws-spinner" />{state.status === 'sending' ? 'İşlem yanıtı bekleniyor…' : 'Güncel kayıt ve işlem durumu doğrulanıyor…'}</p>}
      {state.status === 'deleted' ? <>
        <p role="status">Posta verisinin silme işi doğrulandı ve hesap kaydı kaldırıldı. Yedek korundu.</p>
        <p>Bu silme akışı diğer posta hesaplarını veya alan adını kapatmaz. Önceden kapalı olan alan adı da kendiliğinden açılmaz.</p>
        <LinkButton to={href('configuration')}>Posta yapılandırmasını aç</LinkButton>
      </> : <>
        {!state.receipt && state.status !== 'absent' && <MailboxAccessPreparation mailbox={mailbox} domain={domain} canManage={canManage}
          blocked={removalBusy || state.status === 'waiting' || Boolean(state.approval) || state.uncertain}
          onBusyChange={setAccessBusy} onChanged={() => client.current?.refresh()} />}
        {snapshot && <>
          <KeyValues items={[
            ['Seçilen posta hesabı', snapshot.enabled ? 'Etkin — yalnız bu hesap kapatılmalı' : 'Kapalı kaydedildi; canlı erişim silme işinde denetlenir'],
            ['Alan adı posta kaydı', snapshot.domainStatus === 'disabled' ? 'Önceden kapalı; durumu korunur' : 'Etkin kalır'],
            ['Posta verisi', snapshot.present ? `${snapshot.bytes.toLocaleString('tr-TR')} bayt` : 'Veri bulunamadı; doğrulanmış boş yedek yine gereklidir'],
            ['Kota / yönlendirme', `${snapshot.quota ? 'Kota var' : 'Kota yok'} · ${snapshot.forwarding ? 'Yönlendirme var' : 'Yönlendirme yok'}`],
            ['Bağlı takma adlar', snapshot.aliases], ['Çalışan posta işlemleri', snapshot.activeJobs],
          ]} />
          {(snapshot.quota || snapshot.forwarding) && <p>Kayıt silinmeden önce kota ve yönlendirme politikalarını kaldırın. <Button onClick={onPolicy}>Kota / yönlendirmeyi düzenle</Button></p>}
          {snapshot.aliases > 0 && <p>Bu adrese yönlenen takma adları düzenleyin. Başka alan adından gelen bağlantılar için sunucu yöneticisine başvurun. <LinkButton to={href('aliases')}>Takma adları aç</LinkButton></p>}
          {snapshot.blockers.some((item) => !KNOWN_BLOCKERS.has(item.code)) && <p role="alert">Sunucu ek bir silme engeli bildirdi. İşlem kapalı; tanılama ayrıntılarını kontrol edin.</p>}
        </>}
        <div className="ws-actions">
          <Button disabled={!prepared || Boolean(state.receipt)} onClick={() => client.current?.prepare('backup')}>{state.backupId ? 'Güncel yedek hazırla' : '1. Yedeği hazırla'}</Button>
          <Button variant="danger" disabled={!prepared || !state.backupId || Boolean(state.receipt)} onClick={() => client.current?.prepare('delete')}>2. Posta verisini sil…</Button>
          <Button variant="danger" disabled={!usable || !state.receipt || state.receipt.revision !== snapshot?.revision || !mailboxRemovalEligible(snapshot, { allowData: false })} onClick={() => client.current?.prepare('finalize')}>3. Hesap kaydını kaldır…</Button>
        </div>
        {state.receipt && <p role="status">Veri silme işi doğrulandı. Hesap kaydı henüz kaldırılmadı; son onay gereklidir.</p>}
        {state.uncertain && <p role="alert">Yeni bir yedek/silme isteği başlatılmayacak. İşlem geçmişindeki mevcut yedek veya silme işinin kimliğini aşağıdan doğrulayın.</p>}
        {state.job && <p role="status">{state.job.action === 'backup' ? 'Yedek işi' : 'Veri silme işi'}: {JOB_LABELS[state.job.status]} · <code>{state.job.id}</code></p>}
        {state.backupId && <p>Korunan yedek: <code>{state.backupId}</code></p>}
        <details><summary>Var olan işten devam et</summary>
          <p>İşlem geçmişinden alınan kimlik yalnız okunur. Tamamlanmış sonuç bu posta kutusuna ait değilse kabul edilmez.</p>
          <form className="ws-form" onSubmit={(event) => { event.preventDefault(); void client.current?.resume(jobId.trim()); }}>
            <label>Yedek / veri silme iş kimliği<input value={jobId} onChange={(event) => setJobId(event.target.value)} autoComplete="off" spellCheck={false} maxLength={128} /></label>
            <Button type="submit" disabled={busy || !mailboxRemovalJobId(jobId.trim())}>Mevcut işi doğrula</Button>
          </form>
        </details>
      </>}
      <p className="ws-muted">Yenileme yalnız kayıt okur. Sayfadan ayrılmak sunucudaki işi geri almaz; iş kimliğini İşlem geçmişinden yeniden açabilirsiniz.</p>
      {snapshot && <details><summary>Silme engeli kodları</summary><p>{snapshot.blockers.map((item) => item.code).join(', ') || 'Kayıtlı engel yok'}</p></details>}
    </div>
    {approval && copy && <ConfirmDialog key={`${approval.action}:${approval.data.confirmation}:${approval.snapshot}`} title={copy[0]}
      message={`${mailbox.address}: ${copy[1]}`} confirmation={approval.data.confirmation} busy={busy} error={state.error}
      onCancel={() => client.current?.cancel()} onConfirm={() => client.current?.confirm(approval, approval.data.confirmation)} confirmLabel={copy[2]} />}
  </Section>;
}
