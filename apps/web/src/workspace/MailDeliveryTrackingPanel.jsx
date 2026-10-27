import { useEffect, useState } from 'react';
import { getMailDomainDeliveryTracking } from './mail-client.js';
import { Badge, Button, EmptyState, ErrorNotice, Section } from './PanelKit.jsx';
import { formatDate } from './site-model.js';

export const DELIVERY_STATUS = Object.freeze({
  sent: ['succeeded', 'Gönderildi'],
  deferred: ['pending', 'Ertelendi'],
  bounced: ['failed', 'Geri döndü'],
  expired: ['failed', 'Süresi doldu'],
  rejected: ['failed', 'Reddedildi'],
  queued: ['pending', 'Kuyrukta'],
});
const RANGES = Object.freeze([['24 saat', 1], ['3 gün', 3], ['7 gün', 7]]);

export function deliveryRange(days, now = Date.now()) {
  return { since: new Date(now - days * 24 * 60 * 60 * 1000).toISOString(), until: new Date(now).toISOString() };
}

export function DeliveryStatus({ status }) {
  const [state, label] = DELIVERY_STATUS[status] ?? ['unknown', status];
  return <Badge state={state}>{label}</Badge>;
}

export default function MailDeliveryTrackingPanel({ domain }) {
  const [days, setDays] = useState(1);
  const [search, setSearch] = useState('');
  const [result, setResult] = useState(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);

  async function load() {
    setBusy(true); setError(null);
    try { setResult(await getMailDomainDeliveryTracking(domain.id, { ...deliveryRange(days), search: search.trim() || null })); }
    catch (failure) { setError(failure.message); }
    finally { setBusy(false); }
  }
  useEffect(() => { void load(); }, [domain.id, days]);

  const messages = result?.messages ?? [];
  return <Section title="Teslimat takibi" actions={<Button icon="refresh" disabled={busy} onClick={load}>Yenile</Button>}>
    <ErrorNotice error={error} />
    <form className="ws-section-body ws-filters" onSubmit={event => { event.preventDefault(); void load(); }}>
      <label>Aralık<select value={days} onChange={event => setDays(Number(event.target.value))}>
        {RANGES.map(([label, value]) => <option key={value} value={value}>{label}</option>)}</select></label>
      <label className="ws-filter-search">Ara<input value={search} maxLength={100} placeholder="Adres veya kuyruk kimliği" onChange={event => setSearch(event.target.value)} /></label>
      <Button type="submit" disabled={busy}>Uygula</Button>
    </form>
    {busy && !result && <div className="ws-loading" role="status"><span className="ws-spinner" />Yükleniyor…</div>}
    {messages.length ? <div className="ws-table-scroll"><table className="ws-table"><thead><tr><th>Zaman</th><th>Gönderen</th><th>Alıcı</th><th>Durum</th><th>Sebep</th></tr></thead>
      <tbody>{messages.map((message, index) => <tr key={message.queueId ?? `rejected:${message.lastSeen}:${index}`}>
        <td>{formatDate(message.lastSeen)}</td>
        <td>{message.from ?? '—'}</td>
        <td>{message.recipients.map(recipient => <div key={recipient.address}>{recipient.address}{message.recipients.length > 1 && <> <DeliveryStatus status={recipient.status} /></>}</div>)}</td>
        <td><DeliveryStatus status={message.status} /></td>
        <td>{message.reason ? <code>{message.reason}</code> : '—'}</td>
      </tr>)}</tbody></table></div>
      : result && <EmptyState title="İleti bulunamadı" detail="Seçili aralıkta bu alan adına ait posta yok." icon="file" />}
  </Section>;
}
