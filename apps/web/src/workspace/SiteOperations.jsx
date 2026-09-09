import { useRef, useState } from 'react';
import { Link } from 'react-router';
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
  const { certificates, domains, jobs, runJob, resourceBusy } = useWorkspace();
  const [email, setEmail] = useState(''); const [requested, setRequested] = useState(false);
  const [confirm, setConfirm] = useState(null); const operation = useOperation();
  useUnsavedChanges(Boolean(email.trim()) && !requested);
  const ssl = certificateState(domain, certificates.status === 'ready' ? certificates.items : null);
  const certificate = ssl.certificate;
  const locked = operation.busy || certificates.status !== 'ready' || domains.status !== 'ready' || jobs.status !== 'ready'
    || resourceBusy('domain', domain.id) || (certificate && resourceBusy('certificate', certificate.id))
    || certificates.items.some((item) => item.domainId === domain.id && ['issuing', 'renewing'].includes(item.state));
  const canIssue = !locked && !domain.certificateId && domain.httpsMode === 'managed' && domain.state === 'active' && domain.appliedRevision === domain.desiredRevision;
  async function issue(staging) {
    const ok = await operation.perform(() => runJob(`/domains/${encodeURIComponent(domain.id)}/certificates/issue`, { email: email.trim(), staging }));
    if (ok) { setRequested(true); setConfirm(null); }
  }
  return <Section title="SSL sertifikası" description="Sertifika kapsamı, geçerlilik ve ACME işlemleri.">
    <div className="ws-section-body"><Badge state={ssl.state}>{ssl.label}</Badge><ErrorNotice error={operation.error} /></div>
    <KeyValues items={[
      ['Sertifika adı', certificate?.certName], ['Kapsam', certificate?.domains?.join(', ')],
      ['Başlangıç', formatDate(certificate?.validFrom)], ['Bitiş', formatDate(certificate?.validTo)],
      ['HTTPS tercihi', domain.httpsMode === 'managed' ? 'Yönetilen' : 'Kapalı'],
    ]} />
    {certificate?.state === 'active' ? <div className="ws-section-body"><div className="ws-actions"><Button disabled={locked} onClick={() => operation.perform(() => runJob(`/certificates/${encodeURIComponent(certificate.id)}/renew`, { dryRun: true }))}>Yenilemeyi test et</Button><Button variant="primary" disabled={locked} onClick={() => setConfirm('renew')}>Sertifikayı yenile</Button></div><p className="ws-muted">Test işlemi production sertifikası üretmez. İş sonucunu işlem durumundan takip edin.</p></div> : !domain.certificateId ? <form className="ws-form" onSubmit={(event) => { event.preventDefault(); if (canIssue) setConfirm('issue'); }}>
      <p className="ws-muted">Sertifika istemeden önce yönetilen HTTPS seçili ve alan adının güncel Nginx yapılandırması etkin olmalı. DNS bu sunucuyu göstermeli; HTTP doğrulama yolu erişilebilir olmalı.</p>
      <label>ACME hesap e-postası<input type="email" value={email} required onChange={(event) => { setEmail(event.target.value); setRequested(false); }} disabled={locked} /></label>
      <div className="ws-actions"><Button type="submit" variant="primary" disabled={!canIssue}>Production sertifikası iste</Button><Button disabled={!canIssue || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)} onClick={() => issue(true)}>ACME doğrulamasını test et</Button></div>
      {!canIssue && <p className="ws-muted">Önce Alan adları sekmesindeki yapılandırma durumunu kontrol edin. Devam eden sertifika işi varsa tamamlanmasını izleyin.</p>}
    </form> : <div className="ws-section-body"><p className="ws-muted">Sertifika kaydı henüz hazır değil veya okunamıyor. İşler ekranındaki sonucu kontrol edin.</p></div>}
    {confirm && <ConfirmDialog title={confirm === 'renew' ? 'SSL yenilemesini başlat' : 'Production sertifikası iste'} message={`${domain.primaryDomain} için gerçek ACME işlemi başlatılacak. DNS veya erişim hataları sağlayıcının deneme limitlerini tüketebilir.`} confirmation={domain.primaryDomain} error={operation.error} busy={operation.busy} onCancel={() => setConfirm(null)} onConfirm={async () => {
      if (confirm === 'issue') await issue(false);
      else if (certificate) { const ok = await operation.perform(() => runJob(`/certificates/${encodeURIComponent(certificate.id)}/renew`, { dryRun: false })); if (ok) setConfirm(null); }
    }} confirmLabel="İşlemi başlat" />}
  </Section>;
}
