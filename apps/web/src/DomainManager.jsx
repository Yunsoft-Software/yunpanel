import { useRef, useState } from 'react';
import CertificateList from './CertificateList.jsx';
import DomainList from './DomainList.jsx';
import { domainCreatePayload } from './domain-form.js';
import { panelRequest, waitForJob } from './api.js';

const initialForm = { mode: 'domain', serverId: '', parentDomainId: '', prefix: '', primaryDomain: '', aliases: '', targetType: 'proxy', targetValue: '4301', httpsMode: 'off' };

export default function DomainManager({ domains, domainAccess, certificates, certificateAccess, servers, onChanged }) {
  const [form, setForm] = useState(initialForm);
  const [busyId, setBusyId] = useState(null);
  const [email, setEmail] = useState('');
  const [message, setMessage] = useState(null);
  const [error, setError] = useState(null);
  const nameInput = useRef(null);
  const emailInput = useRef(null);
  const parent = domains.find((domain) => domain.id === form.parentDomainId);
  const isSubdomain = form.mode === 'subdomain';

  function update(field, value) {
    setForm((current) => ({ ...current, [field]: value }));
  }

  function addSubdomain(domain) {
    if (busyId !== null) return;
    setForm({ ...initialForm, mode: 'subdomain', parentDomainId: domain.id, serverId: domain.serverId });
    setMessage(null);
    setError(null);
    requestAnimationFrame(() => {
      nameInput.current?.focus();
      nameInput.current?.scrollIntoView({ block: 'center', behavior: 'smooth' });
    });
  }

  async function createDomain(event) {
    event.preventDefault();
    if (busyId !== null) return;
    setBusyId('create');
    setError(null);
    setMessage(null);
    try {
      const domain = await panelRequest('/domains', { method: 'POST', body: domainCreatePayload(form, domains, servers) });
      setForm(initialForm);
      setMessage(`${domain.primaryDomain} created as draft. Stage and activate its configuration; DNS records are managed separately.`);
      onChanged();
    } catch (requestError) {
      setError(requestError.message);
    } finally {
      setBusyId(null);
    }
  }

  async function runDomainAction(domain, action) {
    if (busyId !== null) return;
    setBusyId(domain.id);
    setError(null);
    setMessage(null);
    try {
      const job = await panelRequest(`/domains/${domain.id}/${action}`, { method: 'POST', body: {} });
      await waitForJob(job.id);
      setMessage(`${domain.primaryDomain}: ${action} succeeded.`);
      onChanged();
    } catch (requestError) {
      setError(`${domain.primaryDomain}: ${requestError.message}`);
      onChanged();
    } finally {
      setBusyId(null);
    }
  }

  async function issueCertificate(domain, staging) {
    if (busyId !== null || !emailInput.current?.reportValidity()) return;
    setBusyId(domain.id);
    setError(null);
    setMessage(null);
    try {
      const response = await panelRequest(`/domains/${domain.id}/certificates/issue`, {
        method: 'POST', body: { email, staging },
      });
      await waitForJob(response.job.id, { attempts: 720 });
      setMessage(`${domain.primaryDomain}: ${staging ? 'ACME validation' : 'certificate issuance'} succeeded.`);
      onChanged();
    } catch (requestError) {
      setError(`${domain.primaryDomain}: ${requestError.message}`);
      onChanged();
    } finally {
      setBusyId(null);
    }
  }

  async function renewCertificate(certificate) {
    if (busyId !== null) return;
    setBusyId(certificate.id);
    setError(null);
    setMessage(null);
    try {
      const job = await panelRequest(`/certificates/${certificate.id}/renew`, { method: 'POST', body: { dryRun: true } });
      await waitForJob(job.id, { attempts: 900 });
      setMessage(`${certificate.certName}: renewal dry-run succeeded.`);
      onChanged();
    } catch (requestError) {
      setError(`${certificate.certName}: ${requestError.message}`);
      onChanged();
    } finally {
      setBusyId(null);
    }
  }

  return (
    <>
      {message && <div className="operation-result" role="status"><span>{message}</span></div>}
      {error && <div className="operation-error" role="alert">{error}</div>}
      <section className="panel domain-panel">
        <div className="panel-heading"><div><p className="eyebrow">Domains and subdomains</p><h2>Domain hierarchy</h2></div><span className="panel-meta">{domainAccess}</span></div>
        <DomainList domains={domains} access={domainAccess} busyId={busyId} onAction={runDomainAction} onIssue={issueCertificate} onAddSubdomain={addSubdomain} />
      </section>
      <section className="panel domain-panel">
        <div className="panel-heading"><div><p className="eyebrow">Nginx configuration</p><h2>{isSubdomain ? 'New subdomain' : 'New domain'}</h2></div></div>
        <form onSubmit={createDomain}>
          <fieldset className="inline-form domain-create-fields" disabled={busyId !== null || domainAccess !== 'ready'}>
            <legend className="domain-form-legend">Domain configuration</legend>
            <label>Type<select value={form.mode} onChange={(event) => update('mode', event.target.value)}><option value="domain">Independent domain</option><option value="subdomain">Subdomain of an existing domain</option></select></label>
            {isSubdomain ? <>
              <label>Parent domain<select value={form.parentDomainId} required onChange={(event) => update('parentDomainId', event.target.value)}><option value="">Select parent domain</option>{domains.map((domain) => <option key={domain.id} value={domain.id}>{domain.primaryDomain}</option>)}</select></label>
              <label>Subdomain prefix<input ref={nameInput} value={form.prefix} placeholder="api" required onChange={(event) => update('prefix', event.target.value)} /><span className="domain-form-hint">{parent ? `${form.prefix.trim() || 'prefix'}.${parent.primaryDomain}` : 'Select a parent first. The subdomain uses that server.'}</span></label>
            </> : <>
              <label>Primary domain<input ref={nameInput} value={form.primaryDomain} placeholder="example.com" required onChange={(event) => update('primaryDomain', event.target.value)} /></label>
              <label>Server<select value={form.serverId || (servers.length === 1 ? servers[0].id : '')} required onChange={(event) => update('serverId', event.target.value)}><option value="">Select server</option>{servers.map((server) => <option key={server.id} value={server.id}>{server.displayName || server.hostname || server.id}</option>)}</select></label>
            </>}
            <label>Aliases, comma separated<input value={form.aliases} onChange={(event) => update('aliases', event.target.value)} /><span className="domain-form-hint">Aliases share this target; they are not independent subdomains.</span></label>
            <label>Target type<select value={form.targetType} onChange={(event) => setForm((current) => ({ ...current, targetType: event.target.value, targetValue: event.target.value === 'proxy' ? '4301' : '' }))}><option value="proxy">Loopback proxy</option><option value="static">Static root</option></select></label>
            <label>{form.targetType === 'proxy' ? 'Upstream port' : 'Absolute web root'}<input type={form.targetType === 'proxy' ? 'number' : 'text'} min={form.targetType === 'proxy' ? 1024 : undefined} max={form.targetType === 'proxy' ? 65535 : undefined} value={form.targetValue} required onChange={(event) => update('targetValue', event.target.value)} /></label>
            <label>HTTPS<select value={form.httpsMode} onChange={(event) => update('httpsMode', event.target.value)}><option value="off">Off</option><option value="managed">Managed</option></select></label>
            <button className="primary-button" type="submit" disabled={!servers.length || (isSubdomain && !parent)}>{busyId === 'create' ? 'Creating…' : isSubdomain ? 'Create subdomain' : 'Create domain'}</button>
          </fieldset>
        </form>
        <p className="domain-form-hint">Creating a domain does not publish DNS records or enable mail. Existing domains are not automatically regrouped.</p>
      </section>
      <section className="panel domain-panel">
        <div className="panel-heading"><div><p className="eyebrow">ACME / TLS</p><h2>Certificates</h2></div><span className="panel-meta">{certificateAccess}</span></div>
        <div className="inline-form"><label>ACME account email<input ref={emailInput} type="email" required value={email} disabled={busyId !== null} onChange={(event) => setEmail(event.target.value)} /></label></div>
        <CertificateList certificates={certificates} access={certificateAccess} busyId={busyId} onRenew={renewCertificate} />
      </section>
    </>
  );
}
