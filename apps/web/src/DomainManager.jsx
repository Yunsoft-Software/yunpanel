import { useState } from 'react';
import CertificateList from './CertificateList.jsx';
import DomainList from './DomainList.jsx';
import { panelRequest, waitForJob } from './api.js';

const initialForm = { primaryDomain: '', aliases: '', targetType: 'proxy', targetValue: '4301', httpsMode: 'off' };

export default function DomainManager({ domains, domainAccess, certificates, certificateAccess, servers, onChanged }) {
  const [form, setForm] = useState(initialForm);
  const [busyId, setBusyId] = useState(null);
  const [email, setEmail] = useState('admin@cryptoraichu.website');
  const [message, setMessage] = useState(null);
  const [error, setError] = useState(null);

  function update(field, value) {
    setForm((current) => ({ ...current, [field]: value }));
  }

  async function createDomain(event) {
    event.preventDefault();
    if (!servers[0]) return;
    setBusyId('create');
    setError(null);
    try {
      const target = form.targetType === 'proxy'
        ? { upstreamHost: '127.0.0.1', upstreamPort: Number(form.targetValue), websocket: true }
        : { root: form.targetValue, spaFallback: true };
      const domain = await panelRequest('/domains', {
        method: 'POST',
        body: {
          serverId: servers[0].id,
          primaryDomain: form.primaryDomain,
          aliases: form.aliases.split(',').map((value) => value.trim()).filter(Boolean),
          targetType: form.targetType,
          target,
          httpsMode: form.httpsMode,
        },
      });
      setForm(initialForm);
      setMessage(`${domain.primaryDomain} created as draft.`);
      onChanged();
    } catch (requestError) {
      setError(requestError.message);
    } finally {
      setBusyId(null);
    }
  }

  async function runDomainAction(domain, action) {
    setBusyId(domain.id);
    setError(null);
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
    setBusyId(domain.id);
    setError(null);
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
    setBusyId(certificate.id);
    setError(null);
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
      <section className="panel domain-panel">
        <div className="panel-heading"><div><p className="eyebrow">Desired state</p><h2>Domains</h2></div><span className="panel-meta">{domainAccess}</span></div>
        <DomainList domains={domains} access={domainAccess} busyId={busyId} onAction={runDomainAction} onIssue={issueCertificate} />
      </section>
      <section className="panel domain-panel">
        <div className="panel-heading"><div><p className="eyebrow">ACME / TLS</p><h2>Certificates</h2></div><span className="panel-meta">{certificateAccess}</span></div>
        <div className="inline-form"><label>ACME account email<input type="email" value={email} onChange={(event) => setEmail(event.target.value)} /></label></div>
        <CertificateList certificates={certificates} access={certificateAccess} busyId={busyId} onRenew={renewCertificate} />
        {message && <div className="operation-result"><span>{message}</span></div>}
        {error && <div className="operation-error">{error}</div>}
      </section>
      <section className="panel domain-panel">
        <div className="panel-heading"><div><p className="eyebrow">Nginx configuration</p><h2>New domain</h2></div></div>
        <form className="inline-form" onSubmit={createDomain}>
          <label>Primary domain<input value={form.primaryDomain} required onChange={(event) => update('primaryDomain', event.target.value)} /></label>
          <label>Aliases, comma separated<input value={form.aliases} onChange={(event) => update('aliases', event.target.value)} /></label>
          <label>Target type<select value={form.targetType} onChange={(event) => update('targetType', event.target.value)}><option value="proxy">Loopback proxy</option><option value="static">Static root</option></select></label>
          <label>{form.targetType === 'proxy' ? 'Upstream port' : 'Absolute web root'}<input type={form.targetType === 'proxy' ? 'number' : 'text'} value={form.targetValue} required onChange={(event) => update('targetValue', event.target.value)} /></label>
          <label>HTTPS<select value={form.httpsMode} onChange={(event) => update('httpsMode', event.target.value)}><option value="off">Off</option><option value="managed">Managed</option></select></label>
          <button className="primary-button" type="submit" disabled={!servers.length || busyId === 'create'}>{busyId === 'create' ? 'Creating…' : 'Create domain'}</button>
        </form>
      </section>
    </>
  );
}
