import { useEffect, useRef, useState } from 'react';
import {
  clearMailboxForwarding,
  clearMailboxQuota,
  createMailbox,
  getMailboxForwarding,
  getMailboxQuota,
  rotateMailboxPassword,
  setMailboxEnabled,
  setMailboxForwarding,
  setMailboxQuota,
} from './mail-client.js';
import { useUnsavedChanges } from './UnsavedChanges.jsx';
import { Badge, Button, ConfirmDialog, EmptyState, ErrorNotice, Modal, Section } from './PanelKit.jsx';

function destinationList(value) {
  return [...new Set(String(value ?? '').split(/[\n,]/).map((item) => item.trim()).filter(Boolean))];
}

function bytesLabel(value) {
  if (!Number.isFinite(value)) return '—';
  const gib = value / (1024 ** 3);
  if (gib >= 1) return `${gib.toFixed(gib >= 10 ? 0 : 1)} GiB`;
  return `${Math.round(value / (1024 ** 2))} MiB`;
}

function MailboxCreateModal({ domain, onClose, onChanged }) {
  const [localPart, setLocalPart] = useState('');
  const [password, setPassword] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);
  const pending = useRef(false);
  useUnsavedChanges(Boolean(localPart || password));
  async function submit(event) {
    event.preventDefault(); if (pending.current) return;
    pending.current = true; setBusy(true); setError(null);
    try {
      await createMailbox({ mailDomainId: domain.id, address: `${localPart}@${domain.domainName}`, password });
      onChanged?.(); onClose();
    } catch (failure) { if (failure.name !== 'AbortError') setError(failure.message); }
    finally { pending.current = false; setBusy(false); }
  }
  return <Modal title="Mailbox oluştur" onClose={onClose} busy={busy}><form className="ws-form" onSubmit={submit}><ErrorNotice error={error} /><fieldset disabled={busy}><label>Adres<div className="ws-inline-input"><input value={localPart} required autoCapitalize="none" spellCheck={false} onChange={(event) => setLocalPart(event.target.value)} /><span>@{domain.domainName}</span></div></label><label>İlk parola<input type="password" value={password} required autoComplete="new-password" onChange={(event) => setPassword(event.target.value)} /></label><p className="ws-muted">Parola public API’ye geri dönmez. Mailbox desired state oluşturulur; host mail konfigürasyonu ayrıca apply edilmelidir.</p><footer className="ws-modal-footer"><Button disabled={busy} onClick={onClose}>Vazgeç</Button><Button type="submit" variant="primary" disabled={busy || !localPart || !password}>{busy ? 'Oluşturuluyor…' : 'Mailbox oluştur'}</Button></footer></fieldset></form></Modal>;
}

function PasswordModal({ mailbox, onClose, onChanged }) {
  const [password, setPassword] = useState(''); const [busy, setBusy] = useState(false); const [error, setError] = useState(null);
  async function submit(event) {
    event.preventDefault(); setBusy(true); setError(null);
    try { await rotateMailboxPassword(mailbox.id, { expectedRevision: mailbox.revision, password }); onChanged?.(); onClose(); }
    catch (failure) { if (failure.name !== 'AbortError') setError(failure.message); }
    finally { setBusy(false); }
  }
  return <Modal title="Mailbox parolasını değiştir" onClose={onClose} busy={busy}><form className="ws-form" onSubmit={submit}><ErrorNotice error={error} /><label>Yeni parola<input type="password" value={password} required autoComplete="new-password" onChange={(event) => setPassword(event.target.value)} /></label><p className="ws-muted">Revision {mailbox.revision} değiştiyse istek fail-closed reddedilir.</p><footer className="ws-modal-footer"><Button disabled={busy} onClick={onClose}>Vazgeç</Button><Button type="submit" variant="primary" disabled={busy || !password}>{busy ? 'Kaydediliyor…' : 'Parolayı değiştir'}</Button></footer></form></Modal>;
}

function PolicyPanel({ mailbox, onChanged }) {
  const [quota, setQuota] = useState(undefined);
  const [forwarding, setForwarding] = useState(undefined);
  const [quotaMiB, setQuotaMiB] = useState('');
  const [mode, setMode] = useState('copy');
  const [destinations, setDestinations] = useState('');
  const [busy, setBusy] = useState(false); const [error, setError] = useState(null); const [confirm, setConfirm] = useState(null);
  async function refresh() {
    setError(null);
    try {
      const [nextQuota, nextForwarding] = await Promise.all([getMailboxQuota(mailbox.id), getMailboxForwarding(mailbox.id)]);
      setQuota(nextQuota); setForwarding(nextForwarding);
      setQuotaMiB(nextQuota ? String(Math.round(nextQuota.quotaBytes / (1024 ** 2))) : '');
      setMode(nextForwarding?.mode ?? 'copy'); setDestinations(nextForwarding?.destinations?.join('\n') ?? '');
    } catch (failure) { if (failure.name !== 'AbortError') setError(failure.message); }
  }
  useEffect(() => { refresh(); }, [mailbox.id]);
  useUnsavedChanges(Boolean((quotaMiB && Number(quotaMiB) * (1024 ** 2) !== quota?.quotaBytes) || destinations));
  async function mutate(callback) {
    setBusy(true); setError(null);
    try { await callback(); await refresh(); onChanged?.(); }
    catch (failure) { if (failure.name !== 'AbortError') setError(failure.message); }
    finally { setBusy(false); }
  }
  async function saveQuota(event) {
    event.preventDefault();
    const bytes = Number.parseInt(quotaMiB, 10) * (1024 ** 2);
    await mutate(() => setMailboxQuota(mailbox.id, { expectedRevision: quota?.revision ?? 0, quotaBytes: bytes }));
  }
  async function saveForwarding(event) {
    event.preventDefault();
    await mutate(() => setMailboxForwarding(mailbox.id, { expectedRevision: forwarding?.revision ?? 0, mode, destinations: destinationList(destinations), enabled: true }));
  }
  return <Section title={`Mailbox policy · ${mailbox.address}`} description="Quota ve forwarding desired policy değişiklikleri host konfigürasyonunu otomatik apply etmez."><div className="ws-section-body"><ErrorNotice error={error} /><div className="ws-form-grid"><form className="ws-form" onSubmit={saveQuota}><fieldset disabled={busy || quota === undefined}><label>Quota (MiB)<input type="number" min="1" value={quotaMiB} onChange={(event) => setQuotaMiB(event.target.value)} placeholder="1024" required /></label><p className="ws-muted">Mevcut: {quota ? `${bytesLabel(quota.quotaBytes)} · rev ${quota.revision}` : 'Yapılandırılmadı'}</p><div className="ws-actions"><Button type="submit" disabled={busy || !quotaMiB}>Quota kaydet</Button>{quota && <Button variant="danger" type="button" disabled={busy} onClick={() => setConfirm('quota')}>Quota kaldır</Button>}</div></fieldset></form><form className="ws-form" onSubmit={saveForwarding}><fieldset disabled={busy || forwarding === undefined}><label>Forwarding modu<select value={mode} onChange={(event) => setMode(event.target.value)}><option value="copy">Copy — yerel teslim + yönlendir</option><option value="redirect">Redirect — yalnız yönlendir</option></select></label><label>Hedefler<textarea rows="4" value={destinations} onChange={(event) => setDestinations(event.target.value)} placeholder="user@example.com" /></label><p className="ws-muted">Mevcut: {forwarding ? `${forwarding.destinations.join(', ')} · rev ${forwarding.revision}` : 'Yapılandırılmadı'}</p><div className="ws-actions"><Button type="submit" disabled={busy || destinationList(destinations).length === 0}>Forwarding kaydet</Button>{forwarding && <Button variant="danger" type="button" disabled={busy} onClick={() => setConfirm('forwarding')}>Forwarding kaldır</Button>}</div></fieldset></form></div></div>{confirm === 'quota' && quota && <ConfirmDialog title="Mailbox quota policy kaldır" message={`${mailbox.address} quota policy kaydı silinecek. Mail configuration apply ayrıca gerekir.`} confirmation={`clear-mailbox-quota:${mailbox.id}`} busy={busy} error={error} onCancel={() => setConfirm(null)} onConfirm={() => mutate(async () => { await clearMailboxQuota(mailbox.id, { expectedRevision: quota.revision }); setConfirm(null); })} confirmLabel="Quota policy kaldır" />}{confirm === 'forwarding' && forwarding && <ConfirmDialog title="Mailbox forwarding policy kaldır" message={`${mailbox.address} forwarding policy kaydı silinecek. Mail configuration apply ayrıca gerekir.`} confirmation={`clear-mailbox-forwarding:${mailbox.id}`} busy={busy} error={error} onCancel={() => setConfirm(null)} onConfirm={() => mutate(async () => { await clearMailboxForwarding(mailbox.id, { expectedRevision: forwarding.revision }); setConfirm(null); })} confirmLabel="Forwarding policy kaldır" />}</Section>;
}

export default function MailboxesPanel({ domain, mailboxes, onChanged }) {
  const [creating, setCreating] = useState(false); const [passwordFor, setPasswordFor] = useState(null); const [selected, setSelected] = useState(null);
  const [busyId, setBusyId] = useState(null); const [error, setError] = useState(null);
  async function toggle(mailbox) {
    setBusyId(mailbox.id); setError(null);
    try { await setMailboxEnabled(mailbox.id, { expectedRevision: mailbox.revision, enabled: !mailbox.enabled }); onChanged?.(); }
    catch (failure) { if (failure.name !== 'AbortError') setError(failure.message); }
    finally { setBusyId(null); }
  }
  return <><Section title="Mailboxlar" description="Mailbox desired state, parola ve teslim policy yönetimi."><div className="ws-section-body"><ErrorNotice error={error} /><div className="ws-actions"><Button variant="primary" icon="plus" onClick={() => setCreating(true)}>Mailbox oluştur</Button></div></div>{mailboxes.length > 0 ? <div className="ws-table-scroll"><table className="ws-table"><thead><tr><th>Adres</th><th>Durum</th><th>Revizyon</th><th>İşlemler</th></tr></thead><tbody>{mailboxes.map((mailbox) => <tr key={mailbox.id}><td><strong>{mailbox.address}</strong><small>Parola configured</small></td><td><Badge state={mailbox.enabled ? 'active' : 'offline'}>{mailbox.enabled ? 'enabled' : 'disabled'}</Badge></td><td>{mailbox.revision}</td><td><div className="ws-actions"><Button disabled={busyId === mailbox.id} onClick={() => toggle(mailbox)}>{mailbox.enabled ? 'Disable' : 'Enable'}</Button><Button onClick={() => setPasswordFor(mailbox)}>Parola</Button><Button onClick={() => setSelected((current) => current?.id === mailbox.id ? null : mailbox)}>Policy</Button></div></td></tr>)}</tbody></table></div> : <EmptyState icon="mail" title="Mailbox yok" detail="Bu local mail domain için ilk mailbox kaydını oluşturun." action={<Button variant="primary" icon="plus" onClick={() => setCreating(true)}>Mailbox oluştur</Button>} />}</Section>{selected && mailboxes.some((item) => item.id === selected.id) && <PolicyPanel key={`${selected.id}:${mailboxes.find((item) => item.id === selected.id)?.revision}`} mailbox={mailboxes.find((item) => item.id === selected.id)} onChanged={onChanged} />}{creating && <MailboxCreateModal domain={domain} onClose={() => setCreating(false)} onChanged={onChanged} />}{passwordFor && <PasswordModal mailbox={passwordFor} onClose={() => setPasswordFor(null)} onChanged={onChanged} />}</>;
}

export const mailboxesPanelInternals = Object.freeze({ destinationList, bytesLabel });
