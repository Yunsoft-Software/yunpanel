import { useMemo, useRef, useState } from 'react';
import { createMailDomain, getMailDomain, previewMailConfiguration, applyMailConfiguration, getMailConfigurationRequest } from './mail-client.js';
import { waitForJob } from '../api.js';
import { createMailChangeController } from './mail-change-controller.js';
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
  const pending = useRef(false), createdRef = useRef(null), applyRef = useRef(null);
  const selected = candidates.find((domain) => domain.id === webDomainId) ?? null;

  async function submit(event) {
    event.preventDefault();
    if (pending.current || !selected) return;
    pending.current = true; setBusy(true); setError(null);
    try {
      const created = createdRef.current ?? await createMailDomain({
        name: selected.primaryDomain,
        webDomainId: selected.id,
        managementMode,
      });
      createdRef.current = created;
      if (created.managementMode === 'local') {
        applyRef.current ??= createMailChangeController({ domainId: created.id, desiredStatus: 'enabled', requestId: crypto.randomUUID(),
          getDomain: getMailDomain, preview: previewMailConfiguration, apply: applyMailConfiguration,
          getRequest: getMailConfigurationRequest, waitForJob });
        await applyRef.current.run(async () => created);
      }
      onCreated?.(await getMailDomain(created.id));
      onClose();
    } catch (failure) {
      if (failure.name !== 'AbortError') setError(failure.message);
    } finally { pending.current = false; setBusy(false); }
  }

  return <Modal title="Posta alan adı ekle" onClose={onClose} busy={busy}><form className="ws-form" onSubmit={submit}><ErrorNotice error={error} />{candidates.length === 0 ? <div className="ws-notice ws-notice-warn">Posta hizmetini oluşturmak için önce bu yerel sunucuda bir üst seviye web Domain kaydı gerekir.</div> : <fieldset disabled={busy}><label>Alan adı<select disabled={Boolean(createdRef.current)} value={webDomainId} onChange={(event) => setWebDomainId(event.target.value)}>{candidates.map((domain) => <option key={domain.id} value={domain.id}>{domain.primaryDomain}</option>)}</select></label><label>Yönetim modu<select disabled={Boolean(createdRef.current)} value={managementMode} onChange={(event) => setManagementMode(event.target.value)}><option value="local">Bu sunucuda</option><option value="external">Harici posta sağlayıcısı</option></select></label><p className="ws-muted">Yerel posta seçildiğinde hizmet bu alan adı için hazırlanıp etkinleştirilir. Sonuç doğrulanana kadar bu pencere açık kalır.</p><footer className="ws-modal-footer"><Button disabled={busy} onClick={onClose}>Vazgeç</Button><Button variant="primary" type="submit" disabled={busy || !selected}>{busy ? 'Kaydediliyor…' : 'Posta hizmetini oluştur'}</Button></footer></fieldset>}</form></Modal>;
}
