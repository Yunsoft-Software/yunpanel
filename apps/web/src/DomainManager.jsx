import { useRef, useState } from 'react';
import CertificateList from './CertificateList.jsx';
import DomainList from './DomainList.jsx';
import { domainCreatePayload } from './domain-form.js';
import { panelRequest, waitForJob } from './api.js';

const initialForm = { mode: 'domain', parentDomainId: '', prefix: '', primaryDomain: '', aliases: '', targetType: 'proxy', targetValue: '4301', redirectStatus: 301, preservePath: true, httpsMode: 'off' };

const ACCESS_LABELS = Object.freeze({
  ready: 'Hazır',
  checking: 'Kontrol ediliyor',
  loading: 'Yükleniyor',
  protected: 'Korumalı',
  stale: 'Gecikmiş',
  error: 'Hata',
  unavailable: 'Erişilemiyor',
});

const ACTION_LABELS = Object.freeze({
  stage: 'Hazırlama',
  activate: 'Yayınlama',
});

function formatAccessLabel(access) {
  return ACCESS_LABELS[access] ?? access ?? 'Bilinmiyor';
}

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
    setForm({ ...initialForm, mode: 'subdomain', parentDomainId: domain.id });
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
      try {
        const stageJob = await panelRequest(`/domains/${domain.id}/stage`, { method: 'POST', body: {} });
        await waitForJob(stageJob.id);
        const activateJob = await panelRequest(`/domains/${domain.id}/activate`, { method: 'POST', body: {} });
        await waitForJob(activateJob.id);
        setMessage(`${domain.primaryDomain} başarıyla oluşturuldu ve etkinleştirildi.`);
      } catch {
        setMessage(`${domain.primaryDomain} oluşturuldu. DNS kayıtlarını doğrulayıp SSL alabilirsiniz.`);
      }
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
      setMessage(`${domain.primaryDomain}: ${ACTION_LABELS[action] ?? action} tamamlandı.`);
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
      if (domain.httpsMode !== 'managed') {
        const preview = await panelRequest(`/domains/${encodeURIComponent(domain.id)}/update-preview`, {
          method: 'POST',
          body: { changes: { httpsMode: 'managed' } },
        });
        await panelRequest(`/domains/${encodeURIComponent(domain.id)}`, {
          method: 'PATCH',
          body: {
            changes: { httpsMode: 'managed' },
            previewDigest: preview.previewDigest,
            confirmation: preview.confirmation,
          },
        });
      }
      if (domain.state !== 'active' || domain.appliedRevision !== domain.desiredRevision) {
        try {
          const stageJob = await panelRequest(`/domains/${domain.id}/stage`, { method: 'POST', body: {} });
          await waitForJob(stageJob.id);
          const activateJob = await panelRequest(`/domains/${domain.id}/activate`, { method: 'POST', body: {} });
          await waitForJob(activateJob.id);
        } catch {}
      }
      const response = await panelRequest(`/domains/${domain.id}/certificates/issue`, {
        method: 'POST', body: { email, staging },
      });
      await waitForJob(response.job.id, { attempts: 720 });
      if (!staging) {
        try {
          const postStage = await panelRequest(`/domains/${domain.id}/stage`, { method: 'POST', body: {} });
          await waitForJob(postStage.id);
          const postActivate = await panelRequest(`/domains/${domain.id}/activate`, { method: 'POST', body: {} });
          await waitForJob(postActivate.id);
        } catch {}
      }
      setMessage(`${domain.primaryDomain}: ${staging ? 'ACME doğrulaması' : 'sertifika oluşturma'} tamamlandı.`);
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
      setMessage(`${certificate.certName}: yenileme testi tamamlandı.`);
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
        <div className="panel-heading"><div><p className="eyebrow">Alan adları ve alt alan adları</p><h2>Alan adı hiyerarşisi</h2></div><span className="panel-meta">{formatAccessLabel(domainAccess)}</span></div>
        <DomainList domains={domains} access={domainAccess} busyId={busyId} onAction={runDomainAction} onIssue={issueCertificate} onAddSubdomain={addSubdomain} />
      </section>
      <section className="panel domain-panel">
        <div className="panel-heading"><div><p className="eyebrow">Nginx yapılandırması</p><h2>{isSubdomain ? 'Yeni alt alan adı' : 'Yeni alan adı'}</h2></div></div>
        <form onSubmit={createDomain}>
          <fieldset className="inline-form domain-create-fields" disabled={busyId !== null || domainAccess !== 'ready'}>
            <legend className="domain-form-legend">Alan adı yapılandırması</legend>
            <label>Kayıt türü<select value={form.mode} onChange={(event) => update('mode', event.target.value)}><option value="domain">Bağımsız alan adı</option><option value="subdomain">Mevcut alan adının alt alan adı</option></select></label>
            {isSubdomain ? <>
              <label>Üst alan adı<select value={form.parentDomainId} required onChange={(event) => update('parentDomainId', event.target.value)}><option value="">Üst alan adı seçin</option>{domains.map((domain) => <option key={domain.id} value={domain.id}>{domain.primaryDomain}</option>)}</select></label>
              <label>Alt alan adı öneki<input ref={nameInput} value={form.prefix} placeholder="api" required onChange={(event) => update('prefix', event.target.value)} /><span className="domain-form-hint">{parent ? `${form.prefix.trim() || 'onek'}.${parent.primaryDomain}` : 'Önce üst alan adını seçin. Alt alan adı aynı sunucuyu kullanır.'}</span></label>
            </> : <>
              <label>Ana alan adı<input ref={nameInput} value={form.primaryDomain} placeholder="example.com" required onChange={(event) => update('primaryDomain', event.target.value)} /></label>
            </>}
            <label>Aliaslar (virgülle ayırın)<input value={form.aliases} onChange={(event) => update('aliases', event.target.value)} /><span className="domain-form-hint">Aliaslar aynı hedefi paylaşır; bağımsız alt alan adı oluşturmaz.</span></label>
            <label>Hedef türü<select value={form.targetType} onChange={(event) => setForm((current) => ({ ...current, targetType: event.target.value, targetValue: event.target.value === 'proxy' ? '4301' : '' }))}><option value="proxy">Yerel proxy</option><option value="static">Statik dizin</option><option value="redirect">Yönlendirme</option></select></label>
            <label>{form.targetType === 'proxy' ? 'Uygulama portu' : form.targetType === 'redirect' ? 'Hedef adres' : 'Tam yayın dizini'}<input type={form.targetType === 'proxy' ? 'number' : form.targetType === 'redirect' ? 'url' : 'text'} placeholder={form.targetType === 'redirect' ? 'https://yeni-alan.com' : undefined} min={form.targetType === 'proxy' ? 1024 : undefined} max={form.targetType === 'proxy' ? 65535 : undefined} value={form.targetValue} required onChange={(event) => update('targetValue', event.target.value)} /></label>
            {form.targetType === 'redirect' && <>
              <label>Yönlendirme türü<select value={form.redirectStatus} onChange={(event) => update('redirectStatus', Number(event.target.value))}><option value={301}>Kalıcı (301)</option><option value={302}>Geçici (302)</option></select></label>
              <label className="domain-form-check"><input type="checkbox" checked={form.preservePath} onChange={(event) => update('preservePath', event.target.checked)} />Yolu koru</label>
            </>}
            <label>HTTPS<select value={form.httpsMode} onChange={(event) => update('httpsMode', event.target.value)}><option value="off">Kapalı</option><option value="managed">Yönetilen</option></select></label>
            <button className="primary-button" type="submit" disabled={servers.length !== 1 || (isSubdomain && !parent)}>{busyId === 'create' ? 'Oluşturuluyor…' : isSubdomain ? 'Alt alan adı oluştur' : 'Alan adı oluştur'}</button>
          </fieldset>
        </form>
        <p className="domain-form-hint">Alan adı oluşturmak DNS kayıtlarını yayımlamaz veya e-posta hizmetini etkinleştirmez. Mevcut alan adları otomatik olarak yeniden gruplanmaz.</p>
      </section>
      <section className="panel domain-panel">
        <div className="panel-heading"><div><p className="eyebrow">ACME / TLS</p><h2>Sertifikalar</h2></div><span className="panel-meta">{formatAccessLabel(certificateAccess)}</span></div>
        <div className="inline-form"><label>ACME hesap e-postası<input ref={emailInput} type="email" required value={email} disabled={busyId !== null} onChange={(event) => setEmail(event.target.value)} /></label></div>
        <CertificateList certificates={certificates} access={certificateAccess} busyId={busyId} onRenew={renewCertificate} />
      </section>
    </>
  );
}
