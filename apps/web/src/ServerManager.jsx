import { useState } from 'react';
import { panelRequest } from './api.js';

export default function ServerManager({ servers, access, renderServer }) {
  const [label, setLabel] = useState('ubuntu-server');
  const [token, setToken] = useState(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);

  async function createEnrollmentToken(event) {
    event.preventDefault();
    setBusy(true);
    setError(null);
    setToken(null);
    try {
      setToken(await panelRequest('/servers/enrollment-tokens', {
        method: 'POST',
        body: { label, ttlMinutes: 15 },
      }));
    } catch (requestError) {
      setError(requestError.message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <>
      <section className="panel domain-panel">
        <div className="panel-heading">
          <div>
            <p className="eyebrow">Managed infrastructure</p>
            <h2>Servers</h2>
          </div>
          <span className="panel-meta">{access}</span>
        </div>
        {servers.length ? <div className="server-list">{servers.map(renderServer)}</div> : <div className="domain-empty"><strong>No server enrolled</strong></div>}
      </section>
      <section className="panel domain-panel">
        <div className="panel-heading">
          <div>
            <p className="eyebrow">One-time credential</p>
            <h2>Enroll a server</h2>
          </div>
        </div>
        <form className="inline-form" onSubmit={createEnrollmentToken}>
          <label>
            Token label
            <input value={label} maxLength="80" required onChange={(event) => setLabel(event.target.value)} />
          </label>
          <button className="primary-button" type="submit" disabled={busy}>{busy ? 'Creating…' : 'Create 15-minute token'}</button>
        </form>
        {token && (
          <div className="operation-result">
            <strong>Copy this token now</strong>
            <code>{token.token}</code>
            <span>Expires {new Date(token.expiresAt).toLocaleString()}</span>
          </div>
        )}
        {error && <div className="operation-error">{error}</div>}
      </section>
    </>
  );
}
