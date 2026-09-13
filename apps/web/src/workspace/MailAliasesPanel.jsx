import { useRef, useState } from 'react';
import { createMailAlias, deleteMailAlias, updateMailAlias } from './mail-client.js';
import { useUnsavedChanges } from './UnsavedChanges.jsx';
import { Badge, Button, ConfirmDialog, EmptyState, ErrorNotice, Modal, Section } from './PanelKit.jsx';

function parseDestinations(value) {
  return [...new Set(String(value ?? '').split(/[\n,]/).map((item) => item.trim()).filter(Boolean))];
}

function AliasEditor({ domain, alias = null, onClose, onChanged }) {
  const [source, setSource] = useState(alias?.source?.split('@')[0] ?? '');
  const [destinations, setDestinations] = useState(alias?.destinations?.join('\n') ?? '');
  const [enabled, setEnabled] = useState(alias?.enabled ?? true);
  const [busy, setBusy] = useState(false); const [error, setError] = useState(null); const pending = useRef(false);
  const dirty = alias
    ? source !== alias.source.split('@')[0] || enabled !== alias.enabled || destinations !== alias.destinations.join('\n')
    : Boolean(source || destinations);
  useUnsavedChanges(dirty);
  async function submit(event) {
    event.preventDefault(); if (pending.current) return;
    pending.current = true; setBusy(true); setError(null);
    try {
      const values = parseDestinations(destinations);
      if (alias) await updateMailAlias(alias.id, { expectedRevision: alias.revision, destinations: values, enabled });
      else await createMailAlias({ mailDomainId: domain.id, source: `${source}@${domain.domainName}`, destinations: values });
      onChanged?.(); onClose();
    } catch (failure) { if (failure.name !== 'AbortError') setError(failure.message); }
    finally { pending.current = false; setBusy(false); }
  }
  return <Modal title={alias ? 'Alias düzenle' : 'Alias oluştur'} onClose={onClose} busy={busy}><form className="ws-form" onSubmit={submit}><ErrorNotice error={error} /><fieldset disabled={busy}><label>Kaynak adres<div className="ws-inline-input"><input value={source} required disabled={Boolean(alias)} autoCapitalize="none" spellCheck={false} onChange={(event) => setSource(event.target.value)} /><span>@{domain.domainName}</span></div></label><label>Hedefler<textarea rows="5" value={destinations} onChange={(event) => setDestinations(event.target.value)} placeholder="team@example.com\narchive@example.net" required /></label>{alias && <label>Durum<select value={enabled ? 'enabled' : 'disabled'} onChange={(event) => setEnabled(event.target.value === 'enabled')}><option value="enabled">Enabled</option><option value="disabled">Disabled</option></select></label>}<p className="ws-muted">Hedefleri satır veya virgülle ayırın. Alias değişikliği host config’e ancak ayrıca mail configuration apply edildiğinde yansır.</p><footer className="ws-modal-footer"><Button disabled={busy} onClick={onClose}>Vazgeç</Button><Button type="submit" variant="primary" disabled={busy || !source || parseDestinations(destinations).length === 0}>{busy ? 'Kaydediliyor…' : alias ? 'Aliası kaydet' : 'Alias oluştur'}</Button></footer></fieldset></form></Modal>;
}

export default function MailAliasesPanel({ domain, aliases, onChanged }) {
  const [editing, setEditing] = useState(null); const [creating, setCreating] = useState(false); const [removing, setRemoving] = useState(null);
  const [busy, setBusy] = useState(false); const [error, setError] = useState(null);
  async function remove() {
    if (!removing) return; setBusy(true); setError(null);
    try { await deleteMailAlias(removing.id, { expectedRevision: removing.revision, source: removing.source }); setRemoving(null); onChanged?.(); }
    catch (failure) { if (failure.name !== 'AbortError') setError(failure.message); }
    finally { setBusy(false); }
  }
  return <><Section title="Mail aliasları" description="Canonical alias source ve destination policy yönetimi."><div className="ws-section-body"><ErrorNotice error={error} /><Button variant="primary" icon="plus" onClick={() => setCreating(true)}>Alias oluştur</Button></div>{aliases.length > 0 ? <div className="ws-table-scroll"><table className="ws-table"><thead><tr><th>Kaynak</th><th>Hedefler</th><th>Durum</th><th>Revizyon</th><th>İşlemler</th></tr></thead><tbody>{aliases.map((alias) => <tr key={alias.id}><td><strong>{alias.source}</strong></td><td>{alias.destinations.join(', ')}</td><td><Badge state={alias.enabled ? 'active' : 'offline'}>{alias.enabled ? 'enabled' : 'disabled'}</Badge></td><td>{alias.revision}</td><td><div className="ws-actions"><Button onClick={() => setEditing(alias)}>Düzenle</Button><Button variant="danger" onClick={() => setRemoving(alias)}>Sil</Button></div></td></tr>)}</tbody></table></div> : <EmptyState icon="mail" title="Alias yok" detail="Bu local mail domain için forwarding aliası oluşturabilirsiniz." action={<Button variant="primary" icon="plus" onClick={() => setCreating(true)}>Alias oluştur</Button>} />}</Section>{creating && <AliasEditor domain={domain} onClose={() => setCreating(false)} onChanged={onChanged} />}{editing && <AliasEditor domain={domain} alias={editing} onClose={() => setEditing(null)} onChanged={onChanged} />}{removing && <ConfirmDialog title="Mail aliasını sil" message={`${removing.source} alias desired-state kaydı silinecek. Host mail configuration ayrıca apply edilmelidir.`} confirmation={`delete-mail-alias:${removing.source}`} busy={busy} error={error} onCancel={() => setRemoving(null)} onConfirm={remove} confirmLabel="Aliası sil" />}</>;
}

export const mailAliasesPanelInternals = Object.freeze({ parseDestinations });
