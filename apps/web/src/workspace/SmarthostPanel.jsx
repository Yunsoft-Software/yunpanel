import { useEffect, useState } from 'react';
import { panelRequest } from '../api.js';
import { Button, ErrorNotice, Section } from './PanelKit.jsx';

export function smarthostPath(serverId) {
  return `/servers/${encodeURIComponent(serverId)}/mail/smarthost`;
}

// The stored password is never sent back; an empty field keeps it.
export function smarthostRequest(values) {
  return { host: values.host.trim(), port: Number(values.port), username: values.username.trim(), password: values.password, confirmation: 'smarthost-apply' };
}

export default function SmarthostPanel({ serverId }) {
  const [state, setState] = useState(null);
  const [values, setValues] = useState({ host: '', port: '587', username: '', password: '' });
  const [pending, setPending] = useState(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);
  const edit = (key) => (event) => setValues(current => ({ ...current, [key]: event.target.value }));

  async function load() {
    try {
      const data = await panelRequest(smarthostPath(serverId));
      setState(data);
      if (data.configured) setValues({ host: data.host, port: String(data.port), username: data.username, password: '' });
    } catch (failure) { setError(failure.message); }
  }
  useEffect(() => { void load(); }, [serverId]);

  async function confirm() {
    setBusy(true); setError(null);
    try {
      if (pending === 'apply') await panelRequest(smarthostPath(serverId), { method: 'PUT', body: smarthostRequest(values) });
      else await panelRequest(smarthostPath(serverId), { method: 'DELETE', body: { confirmation: 'smarthost-disable' } });
      setPending(null);
      setValues(current => ({ ...current, password: '' }));
      await load();
    } catch (failure) { setError(failure.message); }
    finally { setBusy(false); }
  }

  return <Section title="Smarthost">
    <ErrorNotice error={error} />
    <form className="ws-form" onSubmit={event => { event.preventDefault(); setPending('apply'); }}>
      <div className="ws-form-grid">
        <label>Sunucu<input value={values.host} required maxLength="253" placeholder="smtp.alan.com" spellCheck={false} onChange={edit('host')} /></label>
        <label>Port<input type="number" min="1" max="65535" value={values.port} required onChange={edit('port')} /></label>
        <label>Kullanıcı adı<input value={values.username} required maxLength="256" autoComplete="off" spellCheck={false} onChange={edit('username')} /></label>
        <label>Parola<input type="password" value={values.password} maxLength="256" autoComplete="new-password" required={!state?.configured}
          placeholder={state?.configured ? 'Değiştirmek için yazın' : ''} onChange={edit('password')} /></label>
      </div>
      {pending ? <div className="ws-actions" role="group" aria-label="Onay">
        <span>{pending === 'apply' ? 'Giden posta bu sunucu üzerinden gönderilecek.' : 'Giden posta doğrudan gönderilecek.'}</span>
        <Button variant="primary" disabled={busy} onClick={confirm}>Onayla</Button>
        <Button disabled={busy} onClick={() => setPending(null)}>Vazgeç</Button>
      </div> : <div className="ws-actions">
        <Button type="submit" variant="primary" disabled={busy}>Uygula</Button>
        {state?.configured && <Button disabled={busy} onClick={() => setPending('disable')}>Kapat</Button>}
      </div>}
    </form>
  </Section>;
}
