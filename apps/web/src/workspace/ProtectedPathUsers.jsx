import { useEffect, useState } from 'react';
import { panelRequest } from '../api.js';
import { Button, ErrorNotice, Section } from './PanelKit.jsx';

const usersPath = (domainId, key, username) =>
  `/domains/${encodeURIComponent(domainId)}/protected-paths/${encodeURIComponent(key)}/users/${encodeURIComponent(username)}`;

// Users of the saved protected directories. Paths themselves are edited in the
// web server settings form; a path needs to be saved before it accepts users.
export default function ProtectedPathUsers({ domainId, savedPaths, disabled }) {
  const [paths, setPaths] = useState(null);
  const [error, setError] = useState(null);
  const [busy, setBusy] = useState(false);
  const [draft, setDraft] = useState({});
  const version = JSON.stringify(savedPaths ?? []);

  async function load(signal) {
    const result = await panelRequest(`/domains/${encodeURIComponent(domainId)}/protected-paths`, { signal });
    setPaths(result.data.paths);
  }

  useEffect(() => {
    if (!savedPaths?.length) { setPaths([]); return undefined; }
    const controller = new AbortController();
    load(controller.signal).catch(failure => { if (!controller.signal.aborted) setError(failure); });
    return () => controller.abort();
  }, [domainId, version]);

  async function run(operation) {
    setBusy(true); setError(null);
    try { await operation(); await load(); }
    catch (failure) { setError(failure); }
    finally { setBusy(false); }
  }

  if (!paths?.length) return error ? <ErrorNotice error={error} /> : null;
  return <Section title="Korumalı dizin kullanıcıları">
    <ErrorNotice error={error} />
    {paths.map(item => {
      const value = draft[item.key] ?? { username: '', password: '' };
      const set = (field, text) => setDraft({ ...draft, [item.key]: { ...value, [field]: text } });
      return <fieldset className="ws-form" key={item.key} disabled={disabled || busy}>
        <legend>{item.path}</legend>
        {item.users.length === 0 && <p className="ws-muted">Kullanıcı yok.</p>}
        {item.users.map(username => <div className="ws-actions" key={username}>
          <span>{username}</span>
          <Button onClick={() => run(() => panelRequest(usersPath(domainId, item.key, username), { method: 'DELETE' }))}>{username} sil</Button>
        </div>)}
        <form className="ws-form-grid" onSubmit={event => { event.preventDefault();
          run(async () => {
            await panelRequest(usersPath(domainId, item.key, value.username), { method: 'PUT', body: { password: value.password } });
            setDraft({ ...draft, [item.key]: { username: '', password: '' } });
          }); }}>
          <label>Kullanıcı adı<input value={value.username} required maxLength="64" pattern="[A-Za-z0-9._\-]+" autoComplete="off" spellCheck={false}
            onChange={event => set('username', event.target.value)} /></label>
          <label>Parola<input type="password" value={value.password} required minLength="8" maxLength="128" autoComplete="new-password"
            onChange={event => set('password', event.target.value)} /></label>
          <div className="ws-actions"><Button type="submit">Kaydet</Button></div>
        </form>
      </fieldset>;
    })}
  </Section>;
}
