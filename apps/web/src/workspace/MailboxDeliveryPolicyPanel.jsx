import { useCallback, useEffect, useRef, useState } from 'react';
import { getMailboxDeliveryPolicy, setMailboxDeliveryPolicy } from './mail-client.js';
import { Button, ConfirmDialog, ErrorNotice, Section } from './PanelKit.jsx';
import { useMailChange } from './useMailChange.js';
import { useUnsavedChanges } from './UnsavedChanges.jsx';

const EMPTY_POLICY = { vacation: null, allow: [], deny: [] };
const STALE = 'stale_mailbox_revision';
const ERRORS = {
  [STALE]: 'Posta kutusu değişti. Devam etmek için güncel ayarları yükleyin.',
  invalid_mailbox_address: 'Gönderici listelerindeki e-posta adreslerini kontrol edin.',
  mail_spam_sender_conflict: 'Bir gönderici iki listede birden yer alamaz.',
  mail_spam_senders_invalid: 'Her listeye en fazla 64 gönderici ekleyebilirsiniz.',
  mail_vacation_subject_invalid: 'Otomatik yanıt konusu boş, çok uzun veya geçersiz.',
  mail_vacation_body_invalid: 'Otomatik yanıt metni boş, çok uzun veya geçersiz.',
};

function editorFor(policy) {
  const { vacation, allow, deny } = policy;
  return {
    policy,
    draft: {
      enabled: vacation !== null,
      subject: vacation?.subject ?? '',
      body: vacation?.body ?? '',
      allow: allow.join('\n'),
      deny: deny.join('\n'),
    },
  };
}

function senderList(value) {
  return [...new Set(value.split(/[\n,]/).map((address) => address.trim()).filter(Boolean))];
}

export default function MailboxDeliveryPolicyPanel({ mailbox, onChanged }) {
  const { id, mailDomainId } = mailbox;
  const change = useMailChange(mailDomainId);
  const scope = useRef(null);
  const saving = useRef(false);
  const [editor, setEditor] = useState(null);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);
  const [notice, setNotice] = useState(null);
  const [confirm, setConfirm] = useState(null);

  const load = useCallback(async (signal) => {
    setLoading(true);
    setError(null);
    setNotice(null);
    setEditor(null);
    try {
      const policy = await getMailboxDeliveryPolicy(id, { signal });
      if (!signal.aborted) setEditor(editorFor(policy));
    } catch (failure) {
      if (!signal.aborted && failure.name !== 'AbortError') setError(failure);
    } finally {
      if (!signal.aborted) setLoading(false);
    }
  }, [id]);

  useEffect(() => {
    const controller = new AbortController();
    scope.current = controller;
    void load(controller.signal);
    return () => controller.abort();
  }, [load]);

  const { draft, policy } = editor ?? {};
  const input = draft && {
    vacation: draft.enabled ? { subject: draft.subject, body: draft.body } : null,
    allow: senderList(draft.allow),
    deny: senderList(draft.deny),
  };
  const configured = Boolean(policy?.vacation || policy?.allow.length || policy?.deny.length);
  const dirty = Boolean(policy && JSON.stringify(input) !== JSON.stringify({
    vacation: policy.vacation, allow: policy.allow, deny: policy.deny,
  }));
  const stale = error?.code === STALE || Boolean(policy && mailbox.revision > policy.revision);
  const denied = [401, 403, 404].includes(error?.status ?? error?.cause?.status);
  const pending = change.pending;
  useUnsavedChanges(dirty);

  function edit(field, value) {
    setEditor((current) => ({ ...current, draft: { ...current.draft, [field]: value } }));
    setNotice(null);
  }

  async function save(nextPolicy) {
    const signal = scope.current?.signal;
    if (!policy || denied || stale || saving.current || !signal || signal.aborted) return;
    saving.current = true;
    setBusy(true);
    setConfirm(null);
    setError(null);
    setNotice(null);
    try {
      await change(async () => {
        const result = await setMailboxDeliveryPolicy(id, { expectedRevision: policy.revision, ...nextPolicy }, { signal });
        if (!signal.aborted) setEditor(editorFor(result));
        return result;
      }, 'delivery-policy', { signal });
      if (signal.aborted) return;
      setNotice('Teslimat ayarları kaydedildi.');
      onChanged?.();
    } catch (failure) {
      if (signal.aborted || failure.name === 'AbortError' || failure.cause?.name === 'AbortError') return;
      if ([401, 403, 404].includes(failure.status ?? failure.cause?.status)) setEditor(null);
      setError(failure);
      if (failure.saved) onChanged?.();
    } finally {
      saving.current = false;
      if (!signal.aborted) setBusy(false);
    }
  }

  function reload() {
    setConfirm(null);
    const signal = scope.current?.signal;
    if (signal && !signal.aborted) void load(signal);
  }

  let message = error && (ERRORS[error.code] ?? 'Teslimat ayarları işlenemedi.');
  if (stale) message = ERRORS[STALE];
  if (error?.saved) message = 'Ayarlar kaydedildi. Posta hizmetine uygulanması tamamlanmadı.';
  if (denied) message = 'Bu posta kutusunun teslimat ayarlarına erişilemiyor.';

  return <Section title="Otomatik yanıt ve spam ayarları">
    <div className="ws-section-body">
      <ErrorNotice error={message} />
      {notice && <p role="status">{notice}</p>}
      {(loading || busy) && <div className="ws-loading" role="status"><span className="ws-spinner" />{loading ? 'Teslimat ayarları yükleniyor…' : 'Teslimat ayarları işleniyor…'}</div>}
      {!loading && !busy && !denied && (!editor || stale) && <Button icon="refresh" onClick={() => dirty ? setConfirm('reload') : reload()}>Güncel ayarları yükle</Button>}
      {draft && !denied && <form className="ws-form" onSubmit={(event) => { event.preventDefault(); if (dirty) void save(input); }}>
        <fieldset disabled={loading || busy || stale || pending}>
          <label className="ws-check"><input type="checkbox" checked={draft.enabled} onChange={(event) => edit('enabled', event.target.checked)} />Otomatik yanıtı etkinleştir</label>
          {draft.enabled && <>
            <label>Yanıt konusu<input value={draft.subject} maxLength={200} required onChange={(event) => edit('subject', event.target.value)} /></label>
            <label>Yanıt metni<textarea value={draft.body} rows={5} maxLength={4000} required onChange={(event) => edit('body', event.target.value)} /></label>
          </>}
          <p className="ws-muted">Her satıra bir e-posta adresi yazın. Bu listeler gönderenin spam puanını etkiler.</p>
          <div className="ws-form-grid">
            <label>Güvenilen gönderenler<textarea value={draft.allow} rows={4} autoCapitalize="none" spellCheck={false} onChange={(event) => edit('allow', event.target.value)} /></label>
            <label>Şüpheli gönderenler<textarea value={draft.deny} rows={4} autoCapitalize="none" spellCheck={false} onChange={(event) => edit('deny', event.target.value)} /></label>
          </div>
          <div className="ws-actions">
            <Button type="submit" variant="primary" disabled={!dirty}>Ayarları kaydet</Button>
            {configured && <Button type="button" variant="danger" onClick={() => setConfirm('clear')}>Ayarları temizle</Button>}
          </div>
        </fieldset>
        {pending && !stale && <Button type="button" disabled={busy} onClick={() => save(input)}>Uygulamayı tamamla</Button>}
      </form>}
    </div>
    {confirm === 'clear' && <ConfirmDialog title="Teslimat ayarlarını temizle"
      message={`${mailbox.address} adresi için otomatik yanıt ve gönderici listeleri kaldırılacak.`}
      confirmLabel="Ayarları temizle" disabled={stale || pending} onCancel={() => setConfirm(null)} onConfirm={() => save(EMPTY_POLICY)} />}
    {confirm === 'reload' && <ConfirmDialog title="Güncel ayarları yükle"
      message="Kaydedilmemiş değişiklikler bırakılacak ve mevcut ayarlar yüklenecek."
      confirmLabel="Ayarları yükle" onCancel={() => setConfirm(null)} onConfirm={reload} />}
  </Section>;
}
