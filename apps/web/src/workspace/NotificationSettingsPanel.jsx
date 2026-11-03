import { useEffect, useState } from 'react';
import { panelRequest } from '../api.js';
import { Badge, Button, ErrorNotice, Section } from './PanelKit.jsx';

const CATEGORIES = [['ssl', 'SSL sertifikaları'], ['backup', 'Yedekler'], ['disk', 'Disk alanı'], ['service', 'Servisler']];

export function notificationFormValues(preferences) {
  return {
    enabled: preferences.enabled !== false,
    address: preferences.channels?.email?.address ?? '',
    email: preferences.channels?.email?.enabled !== false,
    panel: preferences.channels?.panel?.enabled !== false,
    categories: Object.fromEntries(CATEGORIES.map(([key]) => [key, preferences.categories?.[key] !== false])),
  };
}

export function notificationPreferencesRequest(values) {
  return {
    enabled: values.enabled,
    categories: values.categories,
    channels: {
      email: { enabled: values.email, address: values.address.trim() || null },
      panel: { enabled: values.panel },
    },
  };
}

export function deliveryProblem(entry) {
  if (entry.status === 'delivered') return null;
  if (entry.error?.code === 'recipient_email_missing') return 'E-posta adresi yok';
  return 'Gönderilemedi';
}

const CHECK_ROW = { display: 'flex', flexDirection: 'row', alignItems: 'center', gap: 8 };

const date = (value) => (value ? new Date(value).toLocaleString('tr-TR') : '—');

export default function NotificationSettingsPanel() {
  const [values, setValues] = useState(null);
  const [history, setHistory] = useState([]);
  const [senderMissing, setSenderMissing] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);
  const [notice, setNotice] = useState('');

  async function load() {
    const [preferences, deliveries, status] = await Promise.all([
      panelRequest('/notifications/preferences'),
      panelRequest('/notifications/deliveries?channel=email&limit=10'),
      panelRequest('/notifications/status'),
    ]);
    setSenderMissing(status.channels?.email?.senderConfigured === false);
    setValues(notificationFormValues(preferences));
    setHistory(deliveries);
  }
  useEffect(() => { load().catch((failure) => setError(failure.message)); }, []);

  async function run(operation) {
    setBusy(true); setError(null); setNotice('');
    try { await operation(); await load(); }
    catch (failure) { setError(failure.message); }
    finally { setBusy(false); }
  }
  const save = () => panelRequest('/notifications/preferences', { method: 'PATCH', body: notificationPreferencesRequest(values) });

  return <Section title="Bildirimler">
    <div className="ws-section-body">
      <ErrorNotice error={error} />
      {notice && <div className="ws-notice" role="status">{notice}</div>}
      {senderMissing && <div className="ws-notice ws-notice-warn" role="alert">Gönderen adresi ayarlı değil; e-postalar alıcıda reddedilebilir.</div>}
      {values && <form className="ws-form" onSubmit={(event) => {
        event.preventDefault();
        run(async () => { await save(); setNotice('Kaydedildi.'); });
      }}>
        <label style={CHECK_ROW}><input type="checkbox" checked={values.enabled}
          onChange={(event) => setValues({ ...values, enabled: event.target.checked })} /> Bildirimler açık</label>
        <label>E-posta adresi<input type="email" value={values.address} maxLength="254" placeholder="Hesap e-postası kullanılır"
          onChange={(event) => setValues({ ...values, address: event.target.value })} /></label>
        <label style={CHECK_ROW}><input type="checkbox" checked={values.email}
          onChange={(event) => setValues({ ...values, email: event.target.checked })} /> E-posta gönder</label>
        <label style={CHECK_ROW}><input type="checkbox" checked={values.panel}
          onChange={(event) => setValues({ ...values, panel: event.target.checked })} /> Panelde göster</label>
        <fieldset><legend>Olaylar</legend>
          {CATEGORIES.map(([key, label]) => <label key={key} style={CHECK_ROW}><input type="checkbox" checked={values.categories[key]}
            onChange={(event) => setValues({ ...values, categories: { ...values.categories, [key]: event.target.checked } })} /> {label}</label>)}
        </fieldset>
        <div className="ws-actions">
          <Button type="submit" variant="primary" disabled={busy}>Kaydet</Button>
          <Button disabled={busy} onClick={() => run(async () => {
            await save();
            const result = await panelRequest('/notifications/test', {
              method: 'POST', body: { channel: 'email', target: values.address.trim() || null },
            });
            setNotice(`Deneme ${result.recipient} için posta sunucusuna iletildi. Gelmezse spam klasörüne bakın.`);
          })}>Deneme gönder</Button>
        </div>
      </form>}
      {history.length > 0 && <div className="ws-table-scroll"><table className="ws-table">
        <caption className="ws-muted">Son e-postalar</caption>
        <thead><tr><th scope="col">Tarih</th><th scope="col">Konu</th><th scope="col">Durum</th></tr></thead>
        <tbody>{history.map((entry) => <tr key={entry.id}>
          <td>{date(entry.timestamp)}</td><td style={{ overflowWrap: 'anywhere' }}>{entry.title}</td>
          <td><Badge state={deliveryProblem(entry) ? 'error' : 'active'}>{deliveryProblem(entry) ?? 'İletildi'}</Badge></td>
        </tr>)}</tbody>
      </table></div>}
    </div>
  </Section>;
}
