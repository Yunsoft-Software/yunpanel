import { useMemo, useRef, useState } from 'react';
import { createMailDomain } from './mail-client.js';
import { useWorkspace } from './WorkspaceContext.jsx';
import { Button, ErrorNotice, Modal } from './PanelKit.jsx';

export default function MailDomainCreateDialog({ onCreated, onClose }) {
  const { domains } = useWorkspace();
  const candidates = useMemo(() => domains.items
    .filter((domain) => domain.parentDomainId == null)
    .sort((left, right) => left.primaryDomain.localeCompare(right.primaryDomain)), [domains.items]);
  const [webDomainId, setWebDomainId] = useState(candidates[0]?.id ?? '');
  const [managementMode, setManagementMode] = useState('local');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);
  const pending = useRef(false);
  const selected = candidates.find((domain) => domain.id === webDomainId) ?? null;

  async function submit(event) {
    event.preventDefault();
    if (pending.current || !selected) return;
    pending.current = true; setBusy(true); setError(null);
    try {
      const created = await createMailDomain({
        name: selected.primaryDomain,
        webDomainId: selected.id,
        managementMode,
      });
      onCreated?.(created);
      onClose();
    } catch (failure) {
      if (failure.name !== 'AbortError') setError(failure.message);
    } finally { pending.current = false; setBusy(false); }
  }

  return <Modal title="Mail domain ekle" onClose={onClose} busy={busy}><form className="ws-form" onSubmit={submit}><ErrorNotice error={error} />{candidates.length === 0 ? <div className="ws-notice ws-notice-warn">Mail domain oluşturmak için önce bu yerel sunucuda bir üst seviye web Domain kaydı gerekir.</div> : <fieldset disabled={busy}><label>Web Domain<select value={webDomainId} onChange={(event) => setWebDomainId(event.target.value)}>{candidates.map((domain) => <option key={domain.id} value={domain.id}>{domain.primaryDomain}</option>)}</select></label><label>Yönetim modu<select value={managementMode} onChange={(event) => setManagementMode(event.target.value)}><option value="local">Local — Postfix/Dovecot/Rspamd</option><option value="external">External — yalnız takip</option></select></label><p className="ws-muted">Mail domain adı seçilen web Domain ile birebir aynıdır. Oluşturma tek başına host mail konfigürasyonunu değiştirmez.</p><footer className="ws-modal-footer"><Button disabled={busy} onClick={onClose}>Vazgeç</Button><Button variant="primary" type="submit" disabled={busy || !selected}>{busy ? 'Kaydediliyor…' : 'Mail domain oluştur'}</Button></footer></fieldset>}</form></Modal>;
}
