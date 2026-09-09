import { useEffect, useState } from 'react';
import { panelRequest } from './api.js';

export default function EnvironmentEditor({ application, onClose }) {
  const [variables, setVariables] = useState([]);
  const [form, setForm] = useState({ key: '', value: '', secret: true });
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);

  async function refresh() {
    try {
      setVariables(await panelRequest(`/applications/${application.id}/environment`));
      setError(null);
    } catch (requestError) {
      setError(requestError.message);
    }
  }

  useEffect(() => {
    refresh();
  }, [application.id]);

  async function save(event) {
    event.preventDefault();
    setBusy(true);
    setError(null);
    try {
      await panelRequest(`/applications/${application.id}/environment/${encodeURIComponent(form.key)}`, {
        method: 'PUT',
        body: { value: form.value, secret: form.secret },
      });
      setForm({ key: '', value: '', secret: true });
      await refresh();
    } catch (requestError) {
      setError(requestError.message);
    } finally {
      setBusy(false);
    }
  }

  async function remove(variable) {
    setBusy(true);
    setError(null);
    try {
      await panelRequest(`/applications/${application.id}/environment/${encodeURIComponent(variable.key)}`, { method: 'DELETE' });
      await refresh();
    } catch (requestError) {
      setError(requestError.message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <section className="panel domain-panel">
      <div className="panel-heading">
        <div><p className="eyebrow">Protected runtime values</p><h2>{application.name} environment</h2></div>
        <button className="secondary-button" type="button" onClick={onClose}>Close</button>
      </div>
      <div className="domain-list">
        {variables.map((variable) => (
          <article className="domain-row" key={variable.key}>
            <div className="domain-primary"><div><strong>{variable.key}</strong><span>{variable.secret ? 'Secret value is masked' : variable.value}</span></div></div>
            <div className={`domain-state ${variable.secret ? 'draft' : 'active'}`}>{variable.secret ? 'secret' : 'plain'}</div>
            <div className="row-actions"><button className="secondary-button" type="button" disabled={busy} onClick={() => remove(variable)}>Delete</button></div>
          </article>
        ))}
        {!variables.length && <div className="domain-empty"><strong>No custom environment variables</strong></div>}
      </div>
      <form className="inline-form" onSubmit={save}>
        <label>Variable name<input value={form.key} required pattern="[A-Za-z_][A-Za-z0-9_]*" onChange={(event) => setForm((current) => ({ ...current, key: event.target.value }))} /></label>
        <label>Value<input type={form.secret ? 'password' : 'text'} value={form.value} required onChange={(event) => setForm((current) => ({ ...current, value: event.target.value }))} /></label>
        <label>Visibility<select value={form.secret ? 'secret' : 'plain'} onChange={(event) => setForm((current) => ({ ...current, secret: event.target.value === 'secret' }))}><option value="secret">Secret</option><option value="plain">Plain</option></select></label>
        <button className="primary-button" type="submit" disabled={busy}>{busy ? 'Saving…' : 'Save variable'}</button>
      </form>
      {error && <div className="operation-error">{error}</div>}
    </section>
  );
}
