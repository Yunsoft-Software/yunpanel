import { useEffect, useId, useReducer, useRef, useState } from 'react';
import { Link } from 'react-router';
import { panelRequest, waitForJob } from '../api.js';
import { usePanelSession } from '../panel-session.jsx';
import { sessionVersion } from '../session-client.js';
import { createSslRequestDraft, sslContactEmail, sslDraftDirty, sslDraftKey, sslDraftSnapshot, sslRequestDraftReducer, validSslContactEmail } from './ssl-request-draft.js';
import { useWorkspace } from './WorkspaceContext.jsx';
import { Badge, Button, ConfirmDialog, EmptyState, ErrorNotice, KeyValues, Section } from './PanelKit.jsx';
import { certificateState, formatDate, siteHref } from './site-model.js';
import { useUnsavedChanges } from './UnsavedChanges.jsx';

function useOperation() {
  const [busy, setBusy] = useState(false); const [error, setError] = useState(null); const pending = useRef(false);
  async function perform(action) {
    if (pending.current) return false;
    pending.current = true; setBusy(true); setError(null);
    try { await action(); return true; }
    catch (failure) { if (failure.name !== 'AbortError') setError(failure.message); return false; }
    finally { pending.current = false; setBusy(false); }
  }
  return { busy, error, perform };
}

export function ApplicationOperations({ domain, application, deployOnly = false, disabled = false }) {
  const { applications, jobs, runJob, resourceBusy } = useWorkspace();
  const operation = useOperation(); const [rollback, setRollback] = useState(null);
  if (!application) return <Section title="Uygulama bağlantısı"><EmptyState icon="code" title="Bu hedef için uygulama seçilmedi" detail="Aynı sunucu ve portla eşleşen Node.js kaydını yukarıdan seçin. Statik sitelerin kalıcı uygulama bağlantısı henüz uygulanmadı; onları Uygulamalar ekranından yönetin." action={<Link to="/applications">Uygulama yönetimine git</Link>} /></Section>;
  const locked = disabled || operation.busy || jobs.status !== 'ready' || applications.status !== 'ready' || resourceBusy('application', application.id);
  const id = encodeURIComponent(application.id);
  async function run(action) {
    return operation.perform(() => runJob(`/applications/${id}/${action === 'status' ? 'status/refresh' : action}`, {}));
  }
  return <>
    <Section title={deployOnly ? 'Git ve yayın yönetimi' : 'Node.js uygulaması'} description={`${application.name} · ${domain.primaryDomain} hedefiyle port eşleşmesi`}>
      <div className="ws-section-body"><div className="ws-actions">
        <Badge state={application.state} />
        <Button icon="git" variant="primary" disabled={locked || Boolean(application.activeDeploymentId)} onClick={() => run('deploy')}>Deploy başlat</Button>
        {!deployOnly && <Button icon="refresh" disabled={locked || !application.currentReleaseId || Boolean(application.activeDeploymentId)} onClick={() => run('restart')}>Yeniden başlat</Button>}
        {!deployOnly && <Button disabled={locked || !application.currentReleaseId} onClick={() => run('status')}>Durumu kontrol et</Button>}
        <Button disabled={locked || !application.previousReleaseId || Boolean(application.activeDeploymentId)} onClick={() => setRollback(application.previousReleaseId)}>Önceki sürüme dön</Button>
      </div><ErrorNotice error={operation.error} /></div>
      <KeyValues items={[
        ['Uygulama', application.name], ['Node.js', application.runtime?.nodeMajor ? `Node.js ${application.runtime.nodeMajor}` : '—'],
        ['Başlangıç', application.runtime?.startMode === 'npm' ? `npm run ${application.runtime?.startScript ?? 'start'}` : application.runtime?.entryFile],
        ['Port', application.runtime?.port], ['Servis', application.serviceName], ['Sağlık yolu', application.runtime?.healthPath],
        ['Repository', application.repositoryUrl], ['Branch', application.branch], ['Commit', application.currentCommitSha],
        ['Son deploy', formatDate(application.lastDeployedAt)], ['Aktif release', application.currentReleaseId],
      ]} />
      <div className="ws-section-body"><p className="ws-muted">İşlemler mevcut uygulama kaydında yürütülür. Buradaki port eşleşmesi yeni bir kalıcı website–uygulama ilişkisi oluşturmaz. Runtime düzenleme ve başlat/durdur API’leri henüz eklenmedi.</p></div>
    </Section>
    {deployOnly && <Section title="Release geçmişi"><div className="ws-table-scroll"><table className="ws-table"><thead><tr><th>Release</th><th>Commit</th><th>Yayın zamanı</th><th>Durum</th></tr></thead><tbody>{(application.releases ?? []).map((release) => <tr key={release.releaseId}><td>{release.releaseId}</td><td>{release.commitSha?.slice(0, 12) ?? '—'}</td><td>{formatDate(release.deployedAt)}</td><td>{release.releaseId === application.currentReleaseId ? <Badge state="active" /> : 'Önceki sürüm'}</td></tr>)}</tbody></table></div>{!application.releases?.length && <EmptyState title="Henüz release yok" detail="İlk başarılı deploy sonrasında yayın geçmişi burada görünecek." icon="git" />}</Section>}
    {rollback && <ConfirmDialog title="Önceki sürüme dön" message={`${application.name} uygulaması ${rollback} release’ine dönecek. Başarılı dönüş uygulamanın yayınını değiştirir.`} confirmation={application.name} busy={operation.busy} error={operation.error} onCancel={() => setRollback(null)} onConfirm={async () => {
      const success = await operation.perform(async () => { if (application.previousReleaseId !== rollback) throw new Error('Önceki release değişti. Pencereyi kapatıp güncel hedefi inceleyin.'); await runJob(`/applications/${id}/rollback`, { releaseId: rollback }); });
      if (success) setRollback(null);
    }} confirmLabel="Rollback başlat" />}
  </>;
}

export function DomainOperations({ domain }) {
  const { domains, jobs, runJob, resourceBusy } = useWorkspace(); const operation = useOperation();
  const children = domains.items.filter((item) => item.parentDomainId === domain.id);
  const locked = operation.busy || domains.status !== 'ready' || jobs.status !== 'ready' || resourceBusy('domain', domain.id);
  return <Section title="Alan adı ve Nginx" description="Bu kayıt ve aliasları aynı hedefi kullanır." actions={<Link to={`/websites/new?parent=${encodeURIComponent(domain.id)}`}>Alt alan adı ekle</Link>}>
    <div className="ws-section-body"><div className="ws-actions"><Badge state={domain.state} /><Button disabled={locked} onClick={() => operation.perform(() => runJob(`/domains/${encodeURIComponent(domain.id)}/stage`))}>Yapılandırmayı hazırla</Button><Button variant="primary" disabled={locked || domain.stagedRevision !== domain.desiredRevision || !domain.stagedChecksum} onClick={() => operation.perform(() => runJob(`/domains/${encodeURIComponent(domain.id)}/activate`))}>Yapılandırmayı etkinleştir</Button></div><ErrorNotice error={operation.error} /></div>
    <KeyValues items={[
      ['Alan adı', domain.primaryDomain], ['Aliaslar', domain.aliases?.join(', ') || 'Yok'],
      ['Hedef', domain.targetType === 'static' ? domain.target?.root : `127.0.0.1:${domain.target?.upstreamPort ?? '—'}`],
      ['HTTPS tercihi', domain.httpsMode === 'managed' ? 'Yönetilen sertifika' : 'Kapalı'],
      ['İstenen / uygulanan revizyon', `${domain.desiredRevision ?? '—'} / ${domain.appliedRevision ?? '—'}`],
      ['Son etkinleştirme', formatDate(domain.lastAppliedAt)],
    ]} />
    <div className="ws-section-body"><h3>Alt alan adları</h3>{children.length ? <div className="ws-actions">{children.map((item) => <Link key={item.id} to={siteHref(item.id)}>{item.primaryDomain}</Link>)}</div> : <p className="ws-muted">Bu kayda bağlı alt alan adı bulunmuyor.</p>}<p className="ws-muted">Bu işlem DNS sağlayıcınızda kayıt oluşturmaz. A/AAAA/CNAME kayıtları ayrı yönetilir.</p></div>
  </Section>;
}

export function SslOperations({ domain }) {
  const { session } = usePanelSession();
  return <SslOperationForm key={sslDraftKey(domain, session, sessionVersion())} domain={domain} session={session} />;
}

function SslOperationForm({ domain, session }) {
  const { certificates, domains, jobs, runJob, resourceBusy, canManage } = useWorkspace();
  const defaultEmail = sslContactEmail(session);
  const [draft, dispatchDraft] = useReducer(sslRequestDraftReducer, defaultEmail, createSslRequestDraft);
  const { email, includeWww, includeWebmail, includeMail, assignToMail, includeWildcard } = draft.values;
  const [confirm, setConfirm] = useState(null); const operation = useOperation();
  const emailHintId = useId();
  const dirty = sslDraftDirty(draft);
  const edit = (field, value) => dispatchDraft({ type: 'edit', field, value });

  useEffect(() => { dispatchDraft({ type: 'email-default', email: defaultEmail }); }, [defaultEmail]);
  // A hidden issuance form must not block navigation on the renewal screen.
  // Running server jobs are tracked separately, not treated as unsaved input.
  useUnsavedChanges(!domain.certificateId && dirty);
  const ssl = certificateState(domain, certificates.status === 'ready' ? certificates.items : null);
  const certificate = ssl.certificate;
  const locked = !canManage || operation.busy || certificates.status !== 'ready' || domains.status !== 'ready' || jobs.status !== 'ready'
    || resourceBusy('domain', domain.id) || (certificate && resourceBusy('certificate', certificate.id))
    || certificates.items.some((item) => item.domainId === domain.id && ['issuing', 'renewing'].includes(item.state));
  const canIssue = !locked && !domain.certificateId;

  const buildRequestedDomains = (values) => {
    const list = [domain.primaryDomain];
    if (values.includeWww && !list.includes(`www.${domain.primaryDomain}`)) {
      list.push(`www.${domain.primaryDomain}`);
    }
    if (values.includeWebmail && !list.includes(`webmail.${domain.primaryDomain}`)) {
      list.push(`webmail.${domain.primaryDomain}`);
    }
    if (values.includeMail && !list.includes(`mail.${domain.primaryDomain}`)) {
      list.push(`mail.${domain.primaryDomain}`);
    }
    if (values.includeWildcard && !list.includes(`*.${domain.primaryDomain}`)) {
      list.push(`*.${domain.primaryDomain}`);
    }
    if (Array.isArray(domain.aliases)) {
      for (const alias of domain.aliases) {
        if (!list.includes(alias)) list.push(alias);
      }
    }
    return list;
  };

  async function issue(staging) {
    if (!canIssue) return;
    // Capture the user's intent before any asynchronous preparation begins.
    const submitted = sslDraftSnapshot(draft);
    const requestedDomains = buildRequestedDomains(submitted);
    let completed = false;
    const ok = await operation.perform(async () => {
      if (!validSslContactEmail(submitted.email)) throw new Error('Geçerli bir e-posta adresi girin.');
      let currentDomain = domain;
      if (currentDomain.httpsMode !== 'managed') {
        const preview = await panelRequest(`/domains/${encodeURIComponent(currentDomain.id)}/update-preview`, {
          method: 'POST',
          body: { changes: { httpsMode: 'managed' } },
        });
        await panelRequest(`/domains/${encodeURIComponent(currentDomain.id)}`, {
          method: 'PATCH',
          body: {
            changes: { httpsMode: 'managed' },
            previewDigest: preview.previewDigest,
            confirmation: preview.confirmation,
          },
        });
        currentDomain = await panelRequest(`/domains/${encodeURIComponent(currentDomain.id)}`);
      }
      if (currentDomain.stagedRevision !== currentDomain.desiredRevision || !currentDomain.stagedChecksum) {
        const stageJob = await panelRequest(`/domains/${encodeURIComponent(currentDomain.id)}/stage`, { method: 'POST', body: {} });
        await waitForJob(stageJob.id);
        currentDomain = await panelRequest(`/domains/${encodeURIComponent(currentDomain.id)}`);
      }
      if (currentDomain.appliedRevision !== currentDomain.desiredRevision || currentDomain.state !== 'active') {
        const activateJob = await panelRequest(`/domains/${encodeURIComponent(currentDomain.id)}/activate`, { method: 'POST', body: {} });
        await waitForJob(activateJob.id);
      }
      const issueJob = await runJob(`/domains/${encodeURIComponent(currentDomain.id)}/certificates/issue`, {
        email: submitted.email,
        staging,
        domains: requestedDomains,
        assignToMail: submitted.assignToMail,
      });
      if (issueJob?.id && !staging) {
        const finished = await waitForJob(issueJob.id);
        if (finished?.status === 'succeeded') {
          const postStage = await panelRequest(`/domains/${encodeURIComponent(currentDomain.id)}/stage`, { method: 'POST', body: {} });
          await waitForJob(postStage.id);
          const postActivate = await panelRequest(`/domains/${encodeURIComponent(currentDomain.id)}/activate`, { method: 'POST', body: {} });
          await waitForJob(postActivate.id);
          if (submitted.assignToMail) {
            try {
              const currentIdentity = await panelRequest('/mail-service-identity').catch(() => null);
              await panelRequest('/mail-service-identity', {
                method: 'PUT',
                body: {
                  webDomainId: currentDomain.id,
                  expectedRevision: currentIdentity?.data?.revision ?? 0,
                },
              });
            } catch (err) {
              console.error('Mail service identity bind failed:', err);
            }
          }
          completed = true;
        }
      }
    });
    if (ok) {
      if (!staging && completed) dispatchDraft({ type: 'submitted', values: submitted });
      setConfirm(null);
    }
  }
  return <Section title="SSL sertifikası" description="Sertifika kapsamı, geçerlilik ve ACME işlemleri.">
    <div className="ws-section-body"><Badge state={ssl.state}>{ssl.label}</Badge><ErrorNotice error={operation.error} /></div>
    <KeyValues items={[
      ['Sertifika adı', certificate?.certName], ['Kapsam', certificate?.domains?.join(', ')],
      ['Başlangıç', formatDate(certificate?.validFrom)], ['Bitiş', formatDate(certificate?.validTo)],
      ['HTTPS tercihi', domain.httpsMode === 'managed' ? 'Yönetilen' : 'Kapalı'],
    ]} />
    {certificate?.state === 'active' ? <div className="ws-section-body"><div className="ws-actions"><Button disabled={locked} onClick={() => operation.perform(() => runJob(`/certificates/${encodeURIComponent(certificate.id)}/renew`, { dryRun: true }))}>Yenilemeyi test et</Button><Button variant="primary" disabled={locked} onClick={() => setConfirm('renew')}>Sertifikayı yenile</Button></div><p className="ws-muted">Test işlemi production sertifikası üretmez. İş sonucunu işlem durumundan takip edin.</p></div> : !domain.certificateId ? <form className="ws-form" onSubmit={(event) => { event.preventDefault(); if (canIssue && validSslContactEmail(email)) setConfirm('issue'); }}>
      <p className="ws-muted">Let's Encrypt ile ücretsiz SSL sertifikası alın. Alan adının DNS kayıtlarının bu sunucuya yönlendiğinden emin olun.</p>
      {domain.appliedRevision !== domain.desiredRevision && <div className="ws-actions" style={{ marginBottom: 16 }}><Button disabled={locked} onClick={() => operation.perform(() => runJob(`/domains/${encodeURIComponent(domain.id)}/stage`))}>Yapılandırmayı hazırla</Button><Button variant="primary" disabled={locked || domain.stagedRevision !== domain.desiredRevision || !domain.stagedChecksum} onClick={() => operation.perform(() => runJob(`/domains/${encodeURIComponent(domain.id)}/activate`))}>Yapılandırmayı etkinleştir</Button></div>}
      <label>Sertifika iletişim e-postası<input type="email" value={email} required maxLength={254} placeholder="E-posta adresiniz" aria-describedby={emailHintId} onChange={(event) => edit('email', event.target.value)} disabled={locked} /></label>
      <p id={emailHintId} className="ws-muted">{defaultEmail ? 'Başlangıç adresi hesabınızdan alınır; gerektiğinde değiştirebilirsiniz.' : 'Hesabınızda kullanılabilir e-posta adresi bulunamadı. Sertifika için iletişim adresinizi girin.'}</p>
      <div style={{ margin: '14px 0', padding: '12px', border: '1px solid var(--ws-color-border, #e2e8f0)', borderRadius: '6px' }}>
        <strong style={{ display: 'block', marginBottom: '8px' }}>Korunacak alan adları:</strong>
        <div style={{ display: 'flex', flexDirection: 'column', gap: '8px' }}>
          <label style={{ display: 'flex', alignItems: 'center', gap: '8px', cursor: 'default' }}>
            <input type="checkbox" checked disabled />
            <span><strong>{domain.primaryDomain}</strong> (Ana alan adı — zorunlu)</span>
          </label>
          <label style={{ display: 'flex', alignItems: 'center', gap: '8px', cursor: 'pointer' }}>
            <input
              type="checkbox"
              checked={includeWww}
              onChange={(e) => edit('includeWww', e.target.checked)}
              disabled={locked}
            />
            <span><strong>www.{domain.primaryDomain}</strong> ve alan adını koru</span>
          </label>
          <label style={{ display: 'flex', alignItems: 'center', gap: '8px', cursor: 'pointer' }}>
            <input
              type="checkbox"
              checked={includeWebmail}
              onChange={(e) => edit('includeWebmail', e.target.checked)}
              disabled={locked}
            />
            <span><strong>webmail.{domain.primaryDomain}</strong> webmail arayüzünü koru</span>
          </label>
          <label style={{ display: 'flex', alignItems: 'center', gap: '8px', cursor: 'pointer' }}>
            <input
              type="checkbox"
              checked={includeMail}
              onChange={(e) => edit('includeMail', e.target.checked)}
              disabled={locked}
            />
            <span><strong>mail.{domain.primaryDomain}</strong> posta sunucusunu koru</span>
          </label>
          <label style={{ display: 'flex', alignItems: 'center', gap: '8px', cursor: 'pointer' }}>
            <input
              type="checkbox"
              checked={assignToMail}
              onChange={(e) => edit('assignToMail', e.target.checked)}
              disabled={locked}
            />
            <span>Sertifikayı posta alan adına ata (Postfix/Dovecot TLS SNI)</span>
          </label>
          <label style={{ display: 'flex', alignItems: 'center', gap: '8px', cursor: 'pointer' }}>
            <input
              type="checkbox"
              checked={includeWildcard}
              onChange={(e) => edit('includeWildcard', e.target.checked)}
              disabled={locked}
            />
            <span>Joker (Wildcard) sertifika çıkar (<strong>*.{domain.primaryDomain}</strong>)</span>
          </label>
          {includeWildcard && (
            <p className="ws-muted" style={{ margin: '0 0 0 24px', fontSize: '0.85rem', color: '#f59e0b' }}>
              ⚠️ Joker sertifikalar Cloudflare DNS-01 doğrulaması gerektirir.
            </p>
          )}
          {domain.aliases?.length > 0 && <p className="ws-muted">Bu sitenin ek alan adları da kapsama dahildir: {domain.aliases.join(', ')}</p>}
        </div>
      </div>
      <div className="ws-actions"><Button type="submit" variant="primary" disabled={!canIssue || !validSslContactEmail(email)}>SSL sertifikası al</Button><Button disabled={!canIssue || !validSslContactEmail(email)} onClick={() => issue(true)}>ACME doğrulamasını test et</Button><Button type="button" disabled={locked || !dirty} onClick={() => dispatchDraft({ type: 'reset' })}>Değişiklikleri sıfırla</Button></div>
    </form> : <div className="ws-section-body"><p className="ws-muted">Sertifika kaydı henüz hazır değil veya okunamıyor. İşler ekranındaki sonucu kontrol edin.</p></div>}
    {domain.appliedRevision !== domain.desiredRevision && certificate?.state === 'active' && <div className="ws-section-body"><p className="ws-muted">Sertifika aktif edildi, Nginx yapılandırmasını güncelleyip etkinleştirin.</p><div className="ws-actions"><Button disabled={locked} onClick={() => operation.perform(() => runJob(`/domains/${encodeURIComponent(domain.id)}/stage`))}>Yapılandırmayı hazırla</Button><Button variant="primary" disabled={locked || domain.stagedRevision !== domain.desiredRevision || !domain.stagedChecksum} onClick={() => operation.perform(() => runJob(`/domains/${encodeURIComponent(domain.id)}/activate`))}>Yapılandırmayı etkinleştir</Button></div></div>}
    {confirm && <ConfirmDialog title={confirm === 'renew' ? 'SSL yenilemesini başlat' : 'SSL sertifikası al'} message={`${domain.primaryDomain} için gerçek ACME işlemi başlatılacak. DNS veya erişim hataları sağlayıcının deneme limitlerini tüketebilir.`} confirmation={domain.primaryDomain} error={operation.error} busy={operation.busy} onCancel={() => setConfirm(null)} onConfirm={async () => {
      if (confirm === 'issue') await issue(false);
      else if (certificate) { const ok = await operation.perform(() => runJob(`/certificates/${encodeURIComponent(certificate.id)}/renew`, { dryRun: false })); if (ok) setConfirm(null); }
    }} confirmLabel="İşlemi başlat" />}
  </Section>;
}
