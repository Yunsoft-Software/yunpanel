import { useEffect, useId, useMemo, useRef, useState } from 'react';
import { panelRequest, waitForJob } from '../api.js';
import { usePanelSession } from '../panel-session.jsx';
import { sessionVersion, sessionTransitionPending } from '../session-client.js';
import { useWorkspace } from './WorkspaceContext.jsx';
import { Button, ConfirmDialog, EmptyState, ErrorNotice, KeyValues, LinkButton, Modal, Section } from './PanelKit.jsx';
import { formatDate, siteHref } from './site-model.js';
import { useUnsavedChanges } from './UnsavedChanges.jsx';
import { createDomainAliasClient } from './domain-alias-client.js';
import { aliasDomainSnapshot, aliasDomainFingerprint, refreshAliasPublication, aliasList, sameAliases, aliasErrorMessage, MAX_DOMAIN_ALIASES } from './domain-alias-model.js';

export default function DomainOperations({ domain }) {
  const { session } = usePanelSession();
  const generation = sessionVersion();
  const identity = JSON.stringify([domain.id, domain.serverId, session?.user?.id, session?.user?.role, generation]);
  return <DomainAliasWorkspace key={identity} domain={domain} generation={generation} />;
}
function initialState(domain) {
  try { return { base: aliasDomainSnapshot(domain), error: null }; }
  catch (error) { return { base: null, error: aliasErrorMessage(error) }; }
}
function DomainAliasWorkspace({ domain, generation }) {
  const { domains, jobs, canManage, isOwner, resourceBusy, observe, updateJob, refreshAll } = useWorkspace();
  const [initial] = useState(() => initialState(domain));
  const [base, setBase] = useState(initial.base);
  useEffect(() => {
    if (domains.status === 'ready') setBase((previous) => refreshAliasPublication(previous, domain));
  }, [domain, domains.status]);
  const [aliases, setAliases] = useState(initial.base?.aliases ?? []);
  const [input, setInput] = useState('');
  const [error, setError] = useState(initial.error);
  const [busy, setBusy] = useState(false);
  const [plan, setPlan] = useState(null);
  const [applyConfirm, setApplyConfirm] = useState(false);
  const [reloadRequired, setReloadRequired] = useState(false);
  const [notice, setNotice] = useState(null);
  const [progress, setProgress] = useState(null);
  const pending = useRef(false);
  const runtime = useRef(null);
  const access = useRef(canManage); access.current = canManage;
  const callbacks = useRef({ observe, updateJob }); callbacks.current = { observe, updateJob };
  const hintId = useId();
  useEffect(() => {
    const value = { active: true, controller: new AbortController() }; runtime.current = value;
    return () => { value.active = false; value.controller.abort(); };
  }, []);
  const current = () => runtime.current?.active === true && access.current
    && sessionVersion() === generation && !sessionTransitionPending();
  const client = useMemo(() => createDomainAliasClient({
    request: (path, options = {}) => panelRequest(path, { ...options, signal: runtime.current?.controller.signal }),
    waitForJob,
    isCurrent: () => runtime.current?.active === true && access.current
      && sessionVersion() === generation && !sessionTransitionPending(),
    onProgress: (value) => setProgress((previous) => ({ ...value, jobId: value.jobId ?? previous?.jobId ?? null })),
    observe: (job) => { callbacks.current.updateJob(job); if (job.status !== 'succeeded') callbacks.current.observe(job); },
  }), [generation]);
  const changed = Boolean(base) && !sameAliases(base.aliases, aliases);
  const dirty = changed || Boolean(input.trim());
  useUnsavedChanges(dirty);
  const stale = Boolean(base) && (domain.desiredRevision > base.desiredRevision
    || (domain.desiredRevision === base.desiredRevision && aliasDomainFingerprint(domain) !== aliasDomainFingerprint(base)));
  const locked = !canManage || busy || !base || domains.status !== 'ready' || jobs.status !== 'ready'
    || base.state === 'suspended' || reloadRequired || stale || resourceBusy('domain', domain.id);
  const pendingPublication = Boolean(base) && (base.appliedRevision !== base.desiredRevision || base.state !== 'active');
  const children = domains.status === 'ready' ? domains.items.filter((item) => item.parentDomainId === domain.id && item.serverId === domain.serverId) : [];
  async function perform(action) {
    if (pending.current || !current()) return;
    pending.current = true; setBusy(true); setError(null);
    try { await action(); }
    catch (failure) {
      if (current()) { setError(aliasErrorMessage(failure)); if (failure.needsReload) setReloadRequired(true); }
    } finally {
      pending.current = false;
      if (current()) setBusy(false);
    }
  }
  function adopt(value, keepDraft = false) {
    setBase(value); if (!keepDraft) { setAliases([...value.aliases]); setInput(''); }
    setPlan(null); setReloadRequired(false);
  }
  function addAlias(event) {
    event.preventDefault(); if (!base || busy || !canManage) return;
    try { setAliases(aliasList([...aliases, input], base.primaryDomain)); setInput(''); setPlan(null); setError(null); setNotice(null); }
    catch (failure) { setError(aliasErrorMessage(failure)); }
  }
  function reload() {
    perform(async () => {
      const value = aliasDomainSnapshot(await panelRequest(`/domains/${encodeURIComponent(domain.id)}`, { signal: runtime.current?.controller.signal }));
      if (!current()) return;
      if (value.id !== domain.id || value.serverId !== domain.serverId) throw new Error('target mismatch');
      adopt(value, dirty); setNotice(dirty ? 'Güncel kayıt yüklendi; kaydedilmemiş taslağınız korundu.' : 'Güncel kayıt yüklendi.');
      refreshAll();
    });
  }
  async function save() {
    if (!plan) return;
    if (locked) { setPlan(null); setError('Kayıt veya işlem durumu değişti. Güncel kaydı kontrol edip yeniden inceleyin.'); return; }
    const approved = plan;
    await perform(async () => {
      try {
        const result = await client.save(approved);
        if (!current()) return;
        adopt(result.domain); setNotice(result.certificateDetached
          ? 'Ek alan adları kaydedildi; henüz yayına uygulanmadı. SSL bağlantısı ayrıldı: yeni kapsamı SSL/TLS ekranında yapılandırın.'
          : 'Ek alan adları kaydedildi; henüz yayına uygulanmadı.');
        refreshAll();
      } finally { if (current()) setPlan(null); }
    });
  }
  async function apply() {
    if (locked || dirty) { setApplyConfirm(false); setError('Yayınlamadan önce güncel kayıt ve kaydedilmemiş değişiklikleri kontrol edin.'); return; }
    await perform(async () => {
      try {
        const result = await client.apply(base);
        if (!current()) return;
        adopt(result.domain); setNotice(result.alreadyApplied ? 'Bu kayıt zaten yayına uygulanmış.'
          : 'Yayın yapılandırması uygulandı. DNS ve SSL erişimi ayrıca doğrulanmalıdır.');
        refreshAll();
      } finally { if (current()) setApplyConfirm(false); }
    });
  }
  if (!canManage) return <EmptyState icon="shield" title="Alan adı yönetimine erişilemiyor" detail="Hesabınızın site yönetimi yetkisini kontrol edin." />;
  return <>
    <Section title="Ek alan adları (alias)" description="Bu adlar aynı web sitesi içeriğini kullanır; ayrı site veya posta hesabı oluşturulmaz."
      actions={<Button disabled={busy} icon="refresh" onClick={reload}>Güncel kaydı yükle</Button>}>
      <div className="ws-section-body">
        <p><strong>Ana alan adı:</strong> {base?.primaryDomain ?? domain.primaryDomain}</p>
        <ErrorNotice error={error} />
        {notice && <div className="ws-notice" role="status">{notice}</div>}
        {(stale || reloadRequired) && <div className="ws-notice ws-notice-warn" role="alert">Kaydetmeden veya yayınlamadan önce güncel kaydı yükleyin. Taslağınız otomatik silinmez.</div>}
        {base && <>
          {aliases.length ? <ul>{aliases.map((name) => <li key={name}><div className="ws-actions"><span>{name}</span><Button disabled={busy} icon="trash" aria-label={`${name} ek alan adını taslaktan çıkar`} onClick={() => { setAliases((values) => values.filter((value) => value !== name)); setPlan(null); setNotice(null); }}>Çıkar</Button></div></li>)}</ul>
            : <p>Bu siteye ek alan adı tanımlanmamış.</p>}
          <form className="ws-form" onSubmit={addAlias}>
            <label>Yeni ek alan adı<input value={input} onChange={(event) => setInput(event.target.value)} disabled={busy || aliases.length >= MAX_DOMAIN_ALIASES} maxLength={253} autoComplete="off" spellCheck={false} placeholder="www.ornek.com" aria-describedby={hintId} /></label>
            <p id={hintId} className="ws-muted">{aliases.length} / {MAX_DOMAIN_ALIASES} ek alan adı. Protokol veya yol yazmayın. Ekle ve Çıkar düğmeleri yalnız taslağı değiştirir.</p>
            <div className="ws-actions"><Button type="submit" disabled={busy || !input.trim() || aliases.length >= MAX_DOMAIN_ALIASES} icon="plus">Taslağa ekle</Button></div>
          </form>
          <div className="ws-actions"><Button variant="primary" disabled={locked || !changed || Boolean(input.trim())} onClick={() => perform(async () => { const value = await client.preview(base, aliases); if (current()) setPlan(value); })}>Değişiklikleri incele</Button>
            <Button disabled={busy || !dirty} onClick={() => { setAliases([...base.aliases]); setInput(''); setPlan(null); setError(null); }}>Değişiklikleri iptal et</Button></div>
          {input.trim() && <p className="ws-muted">Önizlemeden önce yazdığınız adı taslağa ekleyin veya alanı temizleyin.</p>}
        </>}
        <p className="ws-muted">DNS A/AAAA/CNAME kayıtları ve SSL kapsamı bu formdan otomatik düzenlenmez. Mevcut yönlendirme tercihi: {base?.canonicalRedirect ? 'Ek adları ana alan adına yönlendir.' : 'Aynı içeriği ek adlarla sun.'}</p>
        <div className="ws-actions"><LinkButton to={siteHref(domain.id, 'dns')}>DNS</LinkButton><LinkButton to={siteHref(domain.id, 'ssl')}>SSL/TLS Sertifikaları</LinkButton></div>
      </div>
    </Section>
    <Section title="Yayın durumu" description="Kaydedilmiş yönlendirmeyi mevcut sunucu işleriyle hazırlayıp uygular.">
      <div className="ws-section-body">
        <p>{!base ? 'Yayın bilgisi doğrulanamadı.' : pendingPublication ? 'Kaydedilmiş yapılandırmanın yayına uygulanması gerekiyor.' : 'Kayıt, son uygulanan yapılandırmayla eşleşiyor.'}</p>
        {base?.httpsMode === 'managed' && !base.certificateId && <p className="ws-notice ws-notice-warn">SSL bağlantısı yok. Yayın işinin tamamlanması HTTPS erişiminin hazır olduğunu göstermez.</p>}
        <p className="ws-muted">Sayfadan ayrılırsanız yeni uygulama adımı başlatılmaz. Başlamış işleri site işlem kayıtlarından kontrol edin.</p>
        <Button variant="primary" disabled={locked || dirty || !pendingPublication} onClick={() => setApplyConfirm(true)}>Yayına uygula</Button>
        {dirty && <p className="ws-muted">Yayınlamadan önce taslağı kaydedin veya değişiklikleri iptal edin.</p>}
        {busy && <p role="status">{progress?.phase === 'stage' ? 'Yayın yapılandırması hazırlanıyor…' : progress?.phase === 'activate' ? 'Yapılandırma yayına uygulanıyor…' : 'İşlem sürüyor…'}</p>}
        {progress?.jobId && <p><LinkButton to={siteHref(domain.id, 'logs')} icon="jobs">Site işlem kayıtları</LinkButton></p>}
      </div>
    </Section>
    <Section title="Alt alan adları" actions={isOwner && <LinkButton to={`/websites/new?parent=${encodeURIComponent(domain.id)}`} icon="plus">Alt alan adı ekle</LinkButton>}>
      <div className="ws-section-body">{children.length ? <div className="ws-actions">{children.map((child) => <LinkButton key={child.id} to={siteHref(child.id)}>{child.primaryDomain}</LinkButton>)}</div> : <p>Bu kayda bağlı alt alan adı bulunmuyor.</p>}</div>
    </Section>
    <details className="ws-section ws-disclosure"><summary>Teknik yayın bilgileri</summary><KeyValues items={[
      ['Alan adı kimliği', domain.id], ['Kaydedilen / uygulanan revizyon', `${base?.desiredRevision ?? '—'} / ${base?.appliedRevision ?? '—'}`],
      ['Son uygulama', formatDate(base?.lastAppliedAt)], ['Son işlem kimliği', progress?.jobId ?? '—'],
    ]} /></details>
    {plan && <AliasReview plan={plan} busy={busy} onCancel={() => setPlan(null)} onSave={save} />}
    {applyConfirm && <ConfirmDialog title="Kaydedilmiş yapılandırmayı yayına uygula" message={`${base.primaryDomain} ve kayıtlı ek alan adlarının yönlendirmesi hazırlanıp uygulanacak. DNS ve SSL kurulumu bu işlemin parçası değildir.`}
      confirmation={base.primaryDomain} busy={busy} error={error} onCancel={() => setApplyConfirm(false)} onConfirm={apply} confirmLabel="Yayına uygula" />}
  </>;
}
function AliasReview({ plan, busy, onCancel, onSave }) {
  const [confirmation, setConfirmation] = useState('');
  const requiresTyping = plan.certificateDetached || plan.removed.length > 0;
  return <Modal title="Ek alan adı değişiklikleri" onClose={onCancel} busy={busy}>
    <p><strong>{plan.base.primaryDomain}</strong> için yalnız aşağıdaki ek adlar değiştirilecek.</p>
    <KeyValues items={[
      ['Eklenecek', plan.added.join(', ') || 'Yok'], ['Çıkarılacak', plan.removed.join(', ') || 'Yok'],
      ['Korunan ana alan adı', plan.base.primaryDomain],
    ]} />
    {plan.certificateDetached && <div className="ws-notice ws-notice-warn" role="alert">Bu değişiklik mevcut SSL sertifikasının alan adıyla bağlantısını kaldırır. Yeni kapsam için SSL/TLS işlemi gerekir; sertifika dosyasının silinmesi anlamına gelmez.</div>}
    <p>Kaydet, kaydı günceller; canlı yönlendirmeyi değiştirmez. Sonrasında Yayına uygula ile devam edilir. DNS ve posta kaydı oluşturulmaz.</p>
    <form onSubmit={(event) => { event.preventDefault(); if (!busy && (!requiresTyping || confirmation === plan.base.primaryDomain)) onSave(); }}>
      {requiresTyping && <label>Etkiyi onaylamak için <strong>{plan.base.primaryDomain}</strong> yazın<input value={confirmation} onChange={(event) => setConfirmation(event.target.value)} required autoComplete="off" spellCheck={false} disabled={busy} /></label>}
      <footer className="ws-modal-footer"><Button onClick={onCancel} disabled={busy}>Vazgeç</Button><Button variant="primary" type="submit" disabled={busy || (requiresTyping && confirmation !== plan.base.primaryDomain)}>Kaydet</Button></footer>
    </form>
  </Modal>;
}
