import { useEffect, useId, useMemo, useRef, useState } from 'react';
import { panelRequest } from '../api.js';
import { usePanelSession } from '../panel-session.jsx';
import { sessionTransitionPending, sessionVersion } from '../session-client.js';
import { useWorkspace } from './WorkspaceContext.jsx';
import { Button, CollectionNotice, ErrorNotice, KeyValues, LinkButton, Modal, Section } from './PanelKit.jsx';
import { siteHref } from './site-model.js';
import { useUnsavedChanges } from './UnsavedChanges.jsx';
import { DomainAliasError, aliasErrorMessage } from './domain-alias-model.js';
import { createDomainHostingClient } from './domain-hosting-client.js';
import { createHostingForm, editHostingForm, hostingFormDirty, hostingReviewMatches, hostingWriteBlock, refreshHostingForm, reloadHostingForm } from './domain-hosting-form.js';

export default function DomainHostingPanel({ domain }) {
  const { session } = usePanelSession();
  const { canManage } = useWorkspace();
  const generation = sessionVersion();
  const identity = JSON.stringify([domain.id, domain.serverId, domain.websiteId, domain.parentDomainId,
    session?.user?.id, session?.user?.role, generation, canManage]);
  return <HostingForm key={identity} domain={domain} generation={generation} />;
}
function initialForm(domain) {
  try { return { form: createHostingForm(domain), error: null }; }
  catch (error) { return { form: null, error: aliasErrorMessage(error) }; }
}
function HostingForm({ domain, generation }) {
  const { domains, jobs, canManage, resourceBusy, refreshAll } = useWorkspace();
  const [initial] = useState(() => initialForm(domain));
  const [form, setForm] = useState(initial.form);
  const [error, setError] = useState(initial.error);
  const [notice, setNotice] = useState(null);
  const [busy, setBusy] = useState(false);
  const [plan, setPlan] = useState(null);
  const [reloadRequired, setReloadRequired] = useState(false);
  const runtime = useRef(null);
  const pending = useRef(false);
  const formRef = useRef(form);
  const reloadRef = useRef(reloadRequired);
  const live = useRef(null);
  live.current = { domain, canManage, domainsStatus: domains.status, jobsStatus: jobs.status,
    resourceBusy: resourceBusy('domain', domain.id) };
  const hintId = useId();
  useEffect(() => {
    const value = { active: true, controller: new AbortController() };
    runtime.current = value;
    return () => { value.active = false; value.controller.abort(); };
  }, []);
  function adopt(value) { formRef.current = value; setForm(value); }
  function requireReload(value) { reloadRef.current = value; setReloadRequired(value); }
  useEffect(() => {
    if (domains.status === 'ready') {
      const next = refreshHostingForm(formRef.current, domain);
      formRef.current = next; setForm(next);
    }
  }, [domain, domains.status]);
  const current = () => runtime.current?.active === true && live.current.canManage
    && sessionVersion() === generation && !sessionTransitionPending();
  const writeBlock = () => hostingWriteBlock({ ...live.current, form: formRef.current, reloadRequired: reloadRef.current });
  const client = useMemo(() => createDomainHostingClient({
    isCurrent: () => runtime.current?.active === true && live.current.canManage
      && sessionVersion() === generation && !sessionTransitionPending(),
    request: (path, options = {}) => {
      // Recheck live collection/job state after the client's verification GET,
      // immediately before each mutation; a disabled button alone is not enough.
      if (options.method && options.method !== 'GET') {
        const reason = hostingWriteBlock({ ...live.current, form: formRef.current, reloadRequired: reloadRef.current });
        if (reason) throw new DomainAliasError('hosting_context_unready', reason, true);
      }
      return panelRequest(path, { ...options, signal: runtime.current?.controller.signal });
    },
  }), [generation]);
  const dirty = hostingFormDirty(form);
  useUnsavedChanges(dirty);
  const blocked = hostingWriteBlock({ ...live.current, form, reloadRequired });
  const pendingPublication = form?.base && (form.base.desiredRevision !== form.base.appliedRevision || form.base.state !== 'active');
  async function perform(action) {
    if (pending.current || !current()) return;
    pending.current = true; setBusy(true); setError(null); setNotice(null);
    try { await action(); }
    catch (failure) {
      if (current()) {
        setError(aliasErrorMessage(failure)); setPlan(null);
        if (failure.needsReload || ['alias_stale', 'domain_update_preview_stale', 'hosting_context_changed'].includes(failure.code)) requireReload(true);
      }
    } finally {
      pending.current = false;
      if (runtime.current?.active) setBusy(false);
    }
  }
  function edit(field, value) {
    if (pending.current || !current() || !formRef.current) return;
    adopt(editHostingForm(formRef.current, field, value));
    setPlan(null); setError(null); setNotice(null);
  }
  function reset() {
    if (pending.current || !current() || !formRef.current) return;
    adopt(createHostingForm(formRef.current.base)); setPlan(null); setError(null); setNotice(null);
  }
  function reload() {
    perform(async () => {
      const value = await panelRequest(`/domains/${encodeURIComponent(domain.id)}`, { signal: runtime.current?.controller.signal });
      if (!current()) return;
      const hadDraft = hostingFormDirty(formRef.current);
      adopt(reloadHostingForm(formRef.current, value, live.current.domain));
      requireReload(false); setPlan(null);
      setNotice(hadDraft ? 'Güncel kayıt yüklendi. Değiştirdiğiniz tercihler korundu; kaydetmeden önce yeniden inceleyin.' : 'Güncel kayıt yüklendi.');
      refreshAll();
    });
  }
  function review(event) {
    event.preventDefault();
    if (pending.current || !current() || writeBlock() || !hostingFormDirty(formRef.current)) return;
    perform(async () => {
      const value = await client.preview(formRef.current.base, formRef.current.values);
      if (!current()) return;
      const reason = writeBlock();
      if (reason || !hostingReviewMatches(formRef.current, value)) throw new DomainAliasError('hosting_review_changed', reason || 'Taslak değişti. Yeniden inceleyin.');
      setPlan(value);
    });
  }
  function save() {
    if (pending.current || !current() || !plan) return;
    const reason = writeBlock();
    if (reason || !hostingReviewMatches(formRef.current, plan)) {
      setPlan(null); setError(reason || 'Önizleme güncel taslakla eşleşmiyor. Değişiklikleri yeniden inceleyin.'); return;
    }
    const approved = plan;
    perform(async () => {
      try {
        const result = await client.save(approved);
        if (!current()) return;
        adopt(createHostingForm(result.domain)); requireReload(false);
        setNotice('Yönlendirme tercihleri kaydedildi; henüz yayına uygulanmadı. Yayın yönetiminde inceleyip Yayına uygula ile devam edin.');
        refreshAll();
      } finally { if (current()) setPlan(null); }
    });
  }
  return <Section title="Yönlendirme ayarları" description="Yalnız bu sitenin HTTP/HTTPS ve ek alan adı yönlendirmelerini düzenler."
    actions={<Button icon="refresh" disabled={busy || !canManage} onClick={reload}>Güncel kaydı yükle</Button>}>
    <div className="ws-section-body">
      <CollectionNotice resource={jobs} label="Site işlemleri" />
      <ErrorNotice error={error} />
      {notice && <div className="ws-notice" role="status">{notice}</div>}
      {blocked && <p className="ws-notice ws-notice-warn" role="status">{blocked}</p>}
      {form && <form className="ws-form" onSubmit={review} aria-describedby={hintId}>
        <label className="ws-check"><input type="checkbox" checked={form.values.httpsRedirect}
          disabled={busy || !canManage || form.base.state === 'suspended' || (form.base.httpsMode !== 'managed' && !form.values.httpsRedirect)}
          onChange={(event) => edit('httpsRedirect', event.target.checked)} />HTTP → HTTPS yönlendirmesi</label>
        <label className="ws-check"><input type="checkbox" checked={form.values.canonicalRedirect}
          disabled={busy || !canManage || form.base.state === 'suspended'}
          onChange={(event) => edit('canonicalRedirect', event.target.checked)} />Ek alan adlarını {form.base.primaryDomain} adresine yönlendir</label>
        <p id={hintId} className="ws-muted">Alan adı, ek adlar, sertifika bağlantısı, yayın hedefi ve Nginx ayarları bu formdan değiştirilmez.</p>
        {form.base.httpsMode !== 'managed' && <p className="ws-notice ws-notice-warn">HTTP → HTTPS yönlendirmesinden önce SSL/TLS ekranında HTTPS yapılandırın.</p>}
        {form.base.httpsMode === 'managed' && form.values.httpsRedirect && !form.base.certificateId
          && <p className="ws-notice ws-notice-warn">SSL sertifikası bağlı değil. Bu tercihin kaydedilmesi HTTPS erişiminin hazır olduğunu göstermez.</p>}
        <div className="ws-actions">
          <Button type="submit" variant="primary" disabled={busy || Boolean(blocked) || !dirty}>Değişiklikleri incele</Button>
          <Button disabled={busy || !canManage || !dirty} onClick={reset}>Değişiklikleri iptal et</Button>
        </div>
      </form>}
      {busy && <p role="status">İşlem sürüyor…</p>}
      <p className="ws-muted">{!form ? 'Yayın durumu doğrulanamadı.' : pendingPublication
        ? 'Kaydedilmiş yapılandırmanın yayına uygulanması gerekiyor.' : 'Kayıt, son uygulanan yapılandırmayla eşleşiyor.'} Kaydetmek tek başına yayın, DNS, posta veya sertifika işi başlatmaz.</p>
      <div className="ws-actions">
        <LinkButton to={siteHref(domain.id, 'domains')}>Yayın yönetimine git</LinkButton>
        <LinkButton to={siteHref(domain.id, 'ssl')}>SSL/TLS Sertifikaları</LinkButton>
      </div>
      {dirty && <p className="ws-muted">Sayfadan ayrılmadan önce taslağı kaydedin veya değişiklikleri iptal edin.</p>}
    </div>
    {plan && <HostingReview plan={plan} busy={busy} blocked={blocked} onCancel={() => setPlan(null)} onSave={save} />}
  </Section>;
}
function HostingReview({ plan, busy, blocked, onCancel, onSave }) {
  return <Modal title="Yönlendirme değişikliklerini incele" busy={busy} onClose={onCancel}>
    <p><strong>{plan.base.primaryDomain}</strong> için aşağıdaki tercihler değiştirilecek.</p>
    <KeyValues items={plan.rows.map((row) => [row.label, `${row.before ? 'Açık' : 'Kapalı'} → ${row.after ? 'Açık' : 'Kapalı'}`])} />
    {plan.warnings.map((warning) => <p key={warning} className="ws-notice ws-notice-warn" role="alert">{warning}</p>)}
    <ErrorNotice error={blocked} />
    <p>Kaydet yalnız kayıtlı tercihleri günceller. Canlı yönlendirme için ardından Yayın yönetimi → Yayına uygula adımı gerekir.</p>
    <form onSubmit={(event) => { event.preventDefault(); if (!busy && !blocked) onSave(); }}>
      <footer className="ws-modal-footer"><Button disabled={busy} onClick={onCancel}>Vazgeç</Button>
        <Button type="submit" variant="primary" disabled={busy || Boolean(blocked)}>{busy ? 'Kaydediliyor…' : 'Değişiklikleri kaydet'}</Button></footer>
    </form>
  </Modal>;
}
