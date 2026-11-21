import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  applyDnsReapply,
  applyDnssec,
  deleteManualDnsRecord,
  getDnsSecondaryStatus,
  getDnsZone,
  getDnssecStatus,
  listDnsReapplyOperations,
  listDnssecOperations,
  previewDnsReapply,
  previewDnssec,
  provisionDnsZone,
  saveManualDnsRecord,
  waitForDnsOperation,
} from './dns-client.js';
import {
  DNS_RECORD_TYPES,
  dnsRecordDeletePayload,
  dnsRecordDraft,
  dnsRecordEditable,
  dnsRecordPayload,
  dnsRrsetValues,
  dnsSourceLabel,
  dnssecPresentation,
  operationPresentation,
  relativeDnsOwner,
  resolveDnsZoneScope,
  dnsZoneContextKey,
} from './dns-model.js';
import { Badge, Button, ConfirmDialog, EmptyState, ErrorNotice, KeyValues, LinkButton, Modal, Section } from './PanelKit.jsx';
import SecondaryDnsStatusPanel from './SecondaryDnsStatusPanel.jsx';
import { formatDate, siteHref } from './site-model.js';
import './dns-panel.css';

const ZONE_KIND_LABELS = Object.freeze({
  Master: 'Birincil',
  Primary: 'Birincil',
  Native: 'Yerel',
  Slave: 'İkincil',
  Secondary: 'İkincil',
});

const RECORD_SOURCE_LABELS = Object.freeze({
  template: 'Bölge Şablonu',
  runtime: 'Uygulama',
  mail: 'E-Posta',
  manual: 'Özel',
});

const DIFF_ACTION_LABELS = Object.freeze({
  add: 'Ekle',
  create: 'Ekle',
  replace: 'Güncelle',
  update: 'Güncelle',
  delete: 'Sil',
});

const DNSSEC_STATUS_LABELS = Object.freeze({
  secure_ready: 'Güvenli delege hazır',
  pending_parent_ds: 'Kayıt firması DS kaydı bekleniyor',
  parent_ds_mismatch: 'DS kaydı uyuşmuyor',
  parent_ds_without_dnssec: 'İmzalama kapalı, DS kaydı aktif',
  parent_ds_unverifiable: 'DS kaydı doğrulanamıyor',
  signing_material_incomplete: 'İmzalama anahtarı eksik',
  insecure_parent_unverifiable: 'DNSSEC kapalı · üst kayıt belirsiz',
  insecure: 'DNSSEC kapalı',
});

const PARENT_DS_STATUS_LABELS = Object.freeze({
  matched: 'Eşleşiyor',
  missing: 'Eksik',
  mismatch: 'Uyuşmuyor',
  unverifiable: 'Doğrulanamıyor',
  present: 'Mevcut',
});

const PENDING_DNSSEC_STATUSES = new Set([
  'pending_parent_ds',
  'parent_ds_mismatch',
  'parent_ds_without_dnssec',
  'parent_ds_unverifiable',
  'insecure_parent_unverifiable',
]);

function formatZoneKind(kind) {
  return ZONE_KIND_LABELS[kind] ?? kind ?? '—';
}

function formatRecordSource(source) {
  return RECORD_SOURCE_LABELS[source] ?? dnsSourceLabel(source);
}

function formatDnssecBadge(status) {
  const base = dnssecPresentation(status);
  return { state: base.state, label: DNSSEC_STATUS_LABELS[status] ?? base.label };
}

function formatParentDsStatus(status) {
  if (!status) return '—';
  return PARENT_DS_STATUS_LABELS[status] ?? status;
}

function operationHistory(reapply, dnssec) {
  return [
    ...(Array.isArray(reapply) ? reapply.map((entry) => ({ ...entry, kind: 'reapply' })) : []),
    ...(Array.isArray(dnssec) ? dnssec.map((entry) => ({ ...entry, kind: 'dnssec' })) : []),
  ].sort((left, right) => Date.parse(right.updatedAt ?? right.createdAt ?? 0) - Date.parse(left.updatedAt ?? left.createdAt ?? 0));
}

function valueHint(type) {
  return ({
    A: 'Her satıra bir IPv4 adresi.', AAAA: 'Her satıra bir IPv6 adresi.',
    CNAME: 'Tek hedef alan adı. Örnek: app.example.com', MX: 'Her satır: öncelik hedef. Örnek: 10 mail.example.com',
    TXT: 'Her satır ayrı TXT değeri.', CAA: 'Her satır: bayrak etiket değer. Örnek: 0 issue letsencrypt.org',
    SRV: 'Her satır: öncelik ağırlık port hedef. Örnek: 0 1 443 service.example.com',
    NS: 'Her satıra bir ad sunucusu adı.', SOA: 'Tek değer: birincil-ns yetkili-adres seri yenileme deneme süre-sonu en-az.',
  })[type] ?? '';
}

function DnsRecordDialog({ zone, rrset, defaultOwner = '', onClose, onSaved }) {
  const [draft, setDraft] = useState(() => {
    const initial = dnsRecordDraft(rrset, zone.zoneName);
    if (!rrset && defaultOwner) initial.owner = defaultOwner;
    return initial;
  });
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);
  const editing = Boolean(rrset);
  function update(field, value) { setDraft((current) => ({ ...current, [field]: value })); }
  async function submit(event) {
    event.preventDefault();
    if (busy) return;
    setBusy(true); setError(null);
    try {
      const payload = dnsRecordPayload(draft, zone.serial);
      await saveManualDnsRecord(zone.domainId, payload);
      await onSaved(editing ? 'Özel DNS kaydı güncellendi.' : 'Özel DNS kaydı eklendi.');
    } catch (failure) {
      if (failure.name !== 'AbortError') setError(failure.message);
    } finally { setBusy(false); }
  }
  return <Modal title={editing ? 'Özel DNS kaydını düzenle' : 'Özel DNS kaydı ekle'} onClose={onClose} busy={busy} wide>
    <form className="ws-form dns-record-form" onSubmit={submit}>
      <ErrorNotice error={error} />
      <fieldset disabled={busy}>
        <div className="ws-form-grid">
          <label>Kayıt adı<input value={draft.owner} readOnly={editing} onChange={(event) => update('owner', event.target.value)} placeholder="@ veya api" required autoComplete="off" spellCheck={false} /><span className="dns-field-hint">Kök kayıt için @ yazın; alt adlar bu bölgeye göre kaydedilir.</span></label>
          <label>TTL (saniye)<input type="number" min="60" max="86400" step="1" value={draft.ttl} onChange={(event) => update('ttl', event.target.value)} required /></label>
        </div>
        <div className="dns-type-field"><span>Kayıt türü</span><div className="dns-type-grid" role="group" aria-label="DNS kayıt türü">{DNS_RECORD_TYPES.map((type) => <button key={type} type="button" disabled={editing || busy} aria-pressed={draft.type === type} className={draft.type === type ? 'active' : ''} onClick={() => update('type', type)}>{type}</button>)}</div></div>
        <label>Değerler<textarea rows={draft.type === 'TXT' ? 7 : 5} value={draft.values} onChange={(event) => update('values', event.target.value)} required spellCheck={false} /><span className="dns-field-hint">{valueHint(draft.type)}</span></label>
        <footer className="ws-modal-footer"><Button disabled={busy} onClick={onClose}>Vazgeç</Button><Button variant="primary" type="submit" disabled={busy}>{busy ? 'Kaydediliyor…' : editing ? 'Kaydı güncelle' : 'Kaydı ekle'}</Button></footer>
      </fieldset>
    </form>
  </Modal>;
}

function ZoneRecords({ zone, canManage, busy, onAdd, onEdit, onDelete }) {
  if (!zone?.rrsets?.length) return <EmptyState title="Bölge kaydı yok" detail="Yetkili DNS bölgesi mevcut ancak henüz kayıt bulunamadı." icon="globe" />;
  return <div className="dns-table-wrap"><table className="dns-table"><thead><tr><th>Ad</th><th>Tür</th><th>TTL</th><th>Kaynak</th><th>Değer</th><th aria-label="İşlemler" /></tr></thead><tbody>{zone.rrsets.map((rrset) => {
    const editable = dnsRecordEditable(rrset);
    const values = dnsRrsetValues(rrset);
    return <tr key={`${rrset.owner}:${rrset.type}`}><td><strong>{relativeDnsOwner(rrset.owner, zone.zoneName)}</strong><small>{rrset.owner}</small></td><td><code>{rrset.type}</code></td><td>{rrset.ttl ?? '—'}</td><td><Badge state={editable ? 'unknown' : 'staged'}>{formatRecordSource(rrset.source)}</Badge>{rrset.templateVersion && <small>v{rrset.templateVersion}</small>}</td><td className="dns-values">{values.length ? values.map((value, index) => <code key={`${value}:${index}`}>{value}</code>) : <span>—</span>}</td><td>{editable && canManage && <div className="ws-actions"><Button disabled={busy} onClick={() => onEdit(rrset)}>Düzenle</Button><Button variant="danger" disabled={busy} onClick={() => onDelete(rrset)}>Sil</Button></div>}</td></tr>;
  })}</tbody></table>{canManage && <div className="dns-table-footer"><Button variant="primary" icon="plus" disabled={busy} onClick={onAdd}>Özel kayıt ekle</Button></div>}</div>;
}

function ReapplyPanel({ preview, loading, canManage, busy, onRefresh, onApply }) {
  const hasPendingChanges = Boolean(preview && !preview.noChanges && (preview.changes?.length > 0 || preview.conflicts?.length > 0 || preview.blockers?.length > 0));
  return <Section
    title="Bölge şablonu eşitlemesi"
    description="Sunucu genelindeki bölge şablonu değişiklikleri mevcut bölgelere otomatik yazılmaz; önce değişiklik özeti hazırlanır."
    actions={hasPendingChanges ? <div className="ws-actions"><Badge state="pending">Eşitleme bekliyor</Badge><Button icon="refresh" disabled={busy || loading} onClick={onRefresh}>Kayıtları kontrol et / Yenile</Button></div> : null}
  >
    <div className="ws-section-body">
      {loading && !preview ? <div className="ws-loading" role="status"><span className="ws-spinner" />Bölge değişiklik özeti okunuyor…</div> : preview ? <>
        <KeyValues items={[
          ['Şablon sürümü', preview.templateVersion], ['DNS kimlik sürümü', preview.dnsIdentityRevision],
          ['Mevcut SOA seri numarası', preview.observedSerial], ['Hedef SOA seri numarası', preview.nextSerial],
          ['Korunan özel kayıtlar', preview.preservedManualRrsetCount], ['Değişiklik', preview.changes?.length ?? 0],
        ]} />
        {preview.conflicts?.length > 0 && <div className="ws-notice ws-notice-error" role="alert"><div><strong>Özel kayıt çakışması</strong><p>{preview.conflicts.map((item) => `${relativeDnsOwner(item.owner, preview.zoneName)} ${item.type}`).join(', ')} sistemin yöneteceği kayıtla çakışıyor. Özel kaydınız otomatik olarak ezilmeyecek.</p></div></div>}
        {preview.blockers?.length > 0 && <div className="ws-notice ws-notice-warn" role="alert"><div><strong>Şablon eşitlemesi engellendi</strong><p>{preview.blockers.map((item) => `${relativeDnsOwner(item.owner, preview.zoneName)} ${item.type}`).join(', ')}</p><details className="ws-support-code"><summary>Destek kodu</summary><code>{preview.blockers.map((item) => item.code).join(', ')}</code></details></div></div>}
        {preview.changes?.length > 0 && <div className="dns-diff"><strong>Gereken kayıt değişiklikleri</strong>{preview.changes.map((item, index) => <div key={`${item.action}:${item.owner}:${item.type}:${index}`}><Badge state={item.action === 'delete' ? 'warning' : item.action === 'replace' ? 'running' : 'staged'}>{DIFF_ACTION_LABELS[item.action] ?? item.action}</Badge><code>{relativeDnsOwner(item.owner, preview.zoneName)} {item.type}</code><span>{formatRecordSource(item.source)}</span></div>)}</div>}
        {preview.noChanges && <div className="ws-notice"><div><strong>Bölge güncel</strong><p>Yönetilen DNS kayıtları mevcut bölge şablonu ve DNS kimliği ile uyumlu.</p></div></div>}
      </> : <div className="ws-muted">Bölge değişiklik özeti henüz alınmadı.</div>}
      <div className="ws-actions"><Button icon="refresh" disabled={busy || loading} onClick={onRefresh}>Kayıtları kontrol et / Yenile</Button>{canManage && preview?.applyAllowed && <Button variant="primary" disabled={busy} onClick={onApply}>Şablonu bölgeye uygula</Button>}</div>
    </div>
  </Section>;
}

function DnssecPanel({ state, preview, canManage, busy, onPreview, onRefresh }) {
  const presentation = formatDnssecBadge(state?.status);
  const needsVerification = PENDING_DNSSEC_STATUSES.has(state?.status);
  return <Section
    title="DNSSEC"
    description="Yerel imzalama durumu ile alan adı kayıt firmasındaki DS kaydı ayrı ayrı doğrulanır."
    actions={state && <div className="ws-actions"><Badge state={presentation.state}>{presentation.label}</Badge>{needsVerification && <Button icon="refresh" disabled={busy} onClick={onRefresh}>Kayıtları kontrol et / Yenile</Button>}</div>}
  >
    <div className="ws-section-body">
      {state ? <>
        <KeyValues items={[
          ['Yerel imzalama', state.dnssec ? 'Açık' : 'Kapalı'], ['Kayıt firması DS durumu', formatParentDsStatus(state.parent?.status)],
          ['SOA seri numarası', state.serial], ['İmzalama anahtarı', state.keys?.length ?? 0],
        ]} />
        {state.ds?.length > 0 && <div className="dns-ds-box"><strong>Alan adı kayıt firmasına eklenecek DS kayıtları</strong>{state.ds.map((record) => <code key={record}>{record}</code>)}</div>}
        {state.parent?.records?.length > 0 && <div className="dns-ds-box"><strong>Kayıt firmasında görülen DS kayıtları</strong>{state.parent.records.map((record) => <code key={record}>{record}</code>)}</div>}
        {state.status === 'pending_parent_ds' && <div className="ws-notice ws-notice-warn"><div><strong>DS kaydı doğrulanmayı bekliyor</strong><p>Yukarıdaki DS kaydını alan adı kayıt firmanızın DNS paneline ekleyin, ardından üstteki düğmeyle kayıtları yeniden kontrol edin.</p></div></div>}
        {['parent_ds_mismatch', 'parent_ds_without_dnssec', 'signing_material_incomplete'].includes(state.status) && <div className="ws-notice ws-notice-error" role="alert"><div><strong>DNSSEC müdahale istiyor</strong><p>{presentation.label}. Kayıt firması DS kaydı eşleşmeden DNSSEC güvenli sayılmaz.</p></div></div>}
      </> : <div className="ws-loading" role="status"><span className="ws-spinner" />DNSSEC durumu okunuyor…</div>}
      {preview?.blockers?.length > 0 && <div className="ws-notice ws-notice-warn" role="alert"><div><strong>DNSSEC değişikliği engellendi</strong><p>{preview.blockers.map((item) => item.message).join(' ')}</p></div></div>}
      <div className="ws-actions"><Button icon="refresh" disabled={busy} onClick={onRefresh}>Kayıtları kontrol et / Yenile</Button>{canManage && state && <Button variant={state.dnssec ? 'danger' : 'primary'} disabled={busy || state.status === 'signing_material_incomplete'} onClick={() => onPreview(!state.dnssec)}>{state.dnssec ? 'DNSSEC’i kapat' : 'DNSSEC’i aç'}</Button>}</div>
    </div>
  </Section>;
}

function OperationsPanel({ reapply, dnssec }) {
  const operations = useMemo(() => operationHistory(reapply, dnssec).slice(0, 10), [reapply, dnssec]);
  return <Section title="DNS işlemleri" description="Bölge şablonu eşitleme ve DNSSEC değişiklik kayıtları burada listelenir.">
    {operations.length === 0 ? <EmptyState title="Henüz DNS işlemi yok" detail="Bölge şablonu eşitlemesi veya DNSSEC değişikliği yapıldığında burada görünür." icon="jobs" /> : <div className="dns-operation-list">{operations.map((operation) => {
      const presentation = operationPresentation(operation);
      return <article key={`${operation.kind}:${operation.id}`}><div><strong>{operation.kind === 'dnssec' ? (operation.targetEnabled ? 'DNSSEC etkinleştirme' : 'DNSSEC kapatma') : 'Bölge şablonu eşitlemesi'}</strong><span>{formatDate(operation.updatedAt ?? operation.createdAt)}</span></div><Badge state={presentation.state}>{presentation.label}</Badge>{operation.error && <small>{operation.error.message}{operation.error.code ? <details className="ws-support-code"><summary>Destek kodu</summary><code>{operation.error.code}</code></details> : null}</small>}</article>;
    })}</div>}
  </Section>;
}

export default function DnsPanel({ domain, domains, canManage }) {
  const contextKey = dnsZoneContextKey(domain, domains);
  const context = useRef({ domain, domains });
  context.current = { domain, domains };
  const [scope, setScope] = useState(null);
  const scopeRef = useRef(null);
  const refreshGeneration = useRef(0);
  const root = scope?.domainId === domain.id ? scope.root : null;
  const ownChild = scope?.domainId === domain.id && scope.ownChild;
  const [zone, setZone] = useState(null);
  const [secondary, setSecondary] = useState(null);
  const [reapply, setReapply] = useState(null);
  const [dnssec, setDnssec] = useState(null);
  const [reapplyOperations, setReapplyOperations] = useState([]);
  const [dnssecOperations, setDnssecOperations] = useState([]);
  const [dnssecPreview, setDnssecPreview] = useState(null);
  const [recordDialog, setRecordDialog] = useState(null);
  const [deleteTarget, setDeleteTarget] = useState(null);
  const [confirmation, setConfirmation] = useState(null);
  const [loading, setLoading] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);
  const [message, setMessage] = useState(null);

  const isZoneMissing = (reason) =>
    reason?.status === 404
    || reason?.code === 'dns_zone_not_found'
    || reason?.code === 'dns_secondary_zone_not_found'
    || reason?.message?.toLowerCase().includes('not found')
    || reason?.message?.toLowerCase().includes('bulunamadı');

  const refresh = useCallback(async () => {
    const generation = ++refreshGeneration.current;
    const current = () => refreshGeneration.current === generation;
    setLoading(true); setError(null);
    try {
      const selectedContext = context.current;
      const resolved = await resolveDnsZoneScope(selectedContext.domain, selectedContext.domains, getDnsZone);
      if (!current()) return;
      if (!resolved) { setScope(null); setZone(null); scopeRef.current = null; return; }
      const selected = resolved.root;
      if (scopeRef.current && (scopeRef.current.root.id !== selected.id || scopeRef.current.ownChild !== resolved.ownChild)) {
        setZone(null); setRecordDialog(null); setDeleteTarget(null); setConfirmation(null); setDnssecPreview(null);
      }
      scopeRef.current = { ...resolved, domainId: selectedContext.domain.id };
      setScope(scopeRef.current);
      if (selected.id !== selectedContext.domain.id) {
        const inheritedZone = await getDnsZone(selected.id);
        if (inheritedZone?.domainId !== selected.id || inheritedZone.zoneName !== selected.primaryDomain) {
          throw new Error('DNS bölgesi üst alan adıyla eşleşmiyor.');
        }
        if (current()) setZone(inheritedZone);
        return;
      }
      const results = await Promise.allSettled([
        resolved.ownChild ? Promise.resolve(resolved.zone) : getDnsZone(selected.id),
        resolved.ownChild ? Promise.resolve(null) : getDnsSecondaryStatus(selected.id),
        previewDnsReapply(selected.id),
        resolved.ownChild ? Promise.resolve(null) : getDnssecStatus(selected.id),
        listDnsReapplyOperations(selected.id),
        resolved.ownChild ? Promise.resolve([]) : listDnssecOperations(selected.id),
      ]);
      if (!current()) return;
      const setters = [setZone, setSecondary, setReapply, setDnssec, setReapplyOperations, setDnssecOperations];
      results.forEach((result, index) => setters[index](result.status === 'fulfilled' ? result.value : null));
      const zoneNotFound = results[0].status === 'rejected' && isZoneMissing(results[0].reason);
      if (!zoneNotFound) {
        const critical = results.slice(0, 4).find(result => result.status === 'rejected' && !isZoneMissing(result.reason));
        if (critical?.reason?.name !== 'AbortError') setError(critical?.reason?.message ?? null);
      }
    } catch (failure) {
      if (current()) {
        scopeRef.current = null; setScope(null); setZone(null);
        setRecordDialog(null); setDeleteTarget(null); setConfirmation(null); setDnssecPreview(null);
        if (failure.name !== 'AbortError' && !isZoneMissing(failure)) setError(failure.message);
      }
    } finally {
      if (current()) setLoading(false);
    }
  }, [contextKey]);

  useEffect(() => {
    scopeRef.current = null; setScope(null); setZone(null);
    setSecondary(null); setReapply(null); setDnssec(null);
    setReapplyOperations([]); setDnssecOperations([]);
    setRecordDialog(null); setDeleteTarget(null); setConfirmation(null); setDnssecPreview(null);
    void refresh();
    return () => { refreshGeneration.current += 1; };
  }, [refresh]);

  if (!root) return <Section title="DNS" actions={<div className="ws-actions"><Badge state="pending">Doğrulanmadı</Badge><Button icon="refresh" disabled={loading} onClick={refresh}>Kayıtları kontrol et / Yenile</Button></div>}><ErrorNotice error={error} />{loading ? <div className="ws-loading" role="status">DNS bölgesi doğrulanıyor…</div> : <EmptyState title="Yetkili DNS bölgesi bulunamadı" detail="Alan adının DNS bölgesi doğrulanamadı. Kayıtları kontrol ederek tekrar deneyin." icon="alert" action={<Button icon="refresh" onClick={refresh}>Kayıtları kontrol et / Yenile</Button>} />}</Section>;

  async function refreshed(messageText = null) {
    setRecordDialog(null); setDeleteTarget(null); setConfirmation(null); setDnssecPreview(null);
    if (messageText) setMessage(messageText);
    await refresh();
  }

  async function provisionZone() {
    if (!root || busy) return;
    setBusy(true); setError(null); setMessage(null);
    try {
      await provisionDnsZone(root.id);
      await refreshed('Yerel yetkili DNS bölgesi başarıyla oluşturuldu.');
    } catch (failure) {
      if (failure.name !== 'AbortError') setError(failure.message);
    } finally {
      setBusy(false);
    }
  }

  async function deleteRecord() {
    if (!deleteTarget || !zone || busy) return;
    setBusy(true); setError(null); setMessage(null);
    try {
      await deleteManualDnsRecord(root.id, dnsRecordDeletePayload(deleteTarget, zone.zoneName, zone.serial));
      await refreshed('Özel DNS kaydı silindi.');
    } catch (failure) { if (failure.name !== 'AbortError') setError(failure.message); }
    finally { setBusy(false); }
  }

  async function runReapply() {
    if (confirmation?.kind !== 'reapply' || busy) return;
    setBusy(true); setError(null); setMessage(null);
    try {
      const started = await applyDnsReapply(root.id, confirmation.preview);
      const operation = await waitForDnsOperation({ domainId: root.id, kind: 'reapply', operation: started });
      if (operation.status === 'failed') throw new Error(operation.error?.message ?? 'Bölge şablonu eşitlemesi başarısız oldu.');
      await refreshed('Bölge şablonu yetkili DNS bölgesine uygulandı.');
    } catch (failure) { if (failure.name !== 'AbortError') setError(failure.message); }
    finally { setBusy(false); }
  }

  async function prepareDnssec(enabled) {
    if (busy) return;
    setBusy(true); setError(null); setMessage(null); setDnssecPreview(null);
    try {
      const preview = await previewDnssec(root.id, enabled);
      setDnssecPreview(preview);
      if (preview.applyAllowed) setConfirmation({ kind: 'dnssec', preview });
      else if (preview.noChanges) setMessage('DNSSEC zaten istenen durumda.');
    } catch (failure) { if (failure.name !== 'AbortError') setError(failure.message); }
    finally { setBusy(false); }
  }

  async function runDnssec() {
    if (confirmation?.kind !== 'dnssec' || busy) return;
    setBusy(true); setError(null); setMessage(null);
    try {
      const started = await applyDnssec(root.id, confirmation.preview);
      const operation = await waitForDnsOperation({ domainId: root.id, kind: 'dnssec', operation: started });
      if (operation.status === 'failed') throw new Error(operation.error?.message ?? 'DNSSEC işlemi başarısız.');
      await refreshed(confirmation.preview.targetEnabled ? 'DNSSEC imzalama açıldı. Alan adı kayıt firmasındaki DS kaydını doğrulayın.' : 'DNSSEC imzalama güvenli sırayla kapatıldı.');
    } catch (failure) { if (failure.name !== 'AbortError') setError(failure.message); }
    finally { setBusy(false); }
  }

  if (root.id !== domain.id) {
    const subdomainSuffix = `.${domain.primaryDomain}`;
    const subdomainRrsets = zone ? zone.rrsets.filter((r) => r.owner === domain.primaryDomain || r.owner.endsWith(subdomainSuffix)) : [];
    const subdomainZone = zone ? { ...zone, rrsets: subdomainRrsets } : null;

    return <>
      {message && <div className="ws-notice"><div><strong>DNS</strong><p>{message}</p></div></div>}
      <ErrorNotice error={error} />
      <Section
        title={`Alt alan adı DNS kayıtları: ${domain.primaryDomain}`}
        description={`${root.primaryDomain} yetkili DNS bölgesini yönetir. ${domain.primaryDomain} ayrı bir bölge sahibi değildir; alt alan adı kayıtları üst bölge içinde yönetilir.`}
        actions={<div className="ws-actions">{!subdomainZone && !loading && <Badge state="pending">Üst bölge doğrulanmadı</Badge>}<LinkButton to={siteHref(root.id, 'dns')} icon="arrow">{root.primaryDomain} DNS ayarlarına git</LinkButton><Button icon="refresh" disabled={busy || loading} onClick={refresh}>{loading ? 'Yenileniyor…' : 'Kayıtları kontrol et / Yenile'}</Button></div>}
      >
        {subdomainZone ? (
          <>
            <div className="ws-section-body">
              <KeyValues items={[
                ['Üst bölge', zone.zoneName],
                ['Alt alan adı', domain.primaryDomain],
                ['Tanımlı kayıt sayısı', subdomainRrsets.length],
                ['Bölge türü', formatZoneKind(zone.kind)],
              ]} />
            </div>
            <ZoneRecords
              zone={subdomainZone}
              canManage={false}
              busy={busy}
            />
          </>
        ) : loading ? (
          <div className="ws-loading" role="status"><span className="ws-spinner" />Üst bölge okunuyor…</div>
        ) : (
          <EmptyState
            title="Üst Yetkili DNS Bölgesi Bulunamadı"
            detail={`${root.primaryDomain} için bu sunucuda yerel PowerDNS bölgesi bulunmuyor.`}
            icon="globe"
            action={<LinkButton to={siteHref(root.id, 'dns')} icon="arrow">{root.primaryDomain} DNS ayarlarına git</LinkButton>}
          />
        )}
      </Section>
    </>;
  }

  const zonePendingCheck = !zone || Boolean(reapply && !reapply.noChanges && (reapply.changes?.length > 0 || reapply.conflicts?.length > 0));
  const zoneStatusBadge = !zone && !loading
    ? <Badge state="pending">Yerel bölge doğrulanmadı</Badge>
    : zone && reapply && !reapply.noChanges && (reapply.changes?.length > 0 || reapply.conflicts?.length > 0)
      ? <Badge state="pending">Güncelleme bekliyor</Badge>
      : zone
        ? <Badge state="active">Bölge etkin</Badge>
        : null;

  return <>
    {message && <div className="ws-notice"><div><strong>DNS</strong><p>{message}</p></div></div>}
    <ErrorNotice error={error} />
    <Section
      title="Yetkili DNS Bölgesi"
      description={`${root.primaryDomain} · PowerDNS yetkili DNS`}
      actions={<div className="ws-actions">{zoneStatusBadge}<Button icon="refresh" disabled={busy || loading} onClick={refresh}>{loading ? 'Yenileniyor…' : zonePendingCheck ? 'Kayıtları kontrol et / Yenile' : 'Yenile'}</Button></div>}
    >
      {zone ? <><div className="ws-section-body"><KeyValues items={[
        ['Bölge', zone.zoneName], ['SOA seri numarası', zone.serial], ['Bölge türü', formatZoneKind(zone.kind)], ['DNSSEC', zone.dnssec ? 'Etkin' : 'Kapalı'],
      ]} /><p className="ws-muted">Bölge şablonu, e-posta ve uygulama kayıtları sistem tarafından yönetilir ve burada salt okunur gösterilir. Özel kayıtları aşağıdan ekleyebilir veya düzenleyebilirsiniz.</p></div><ZoneRecords zone={zone} canManage={canManage} busy={busy} onAdd={() => setRecordDialog({ rrset: null })} onEdit={(rrset) => setRecordDialog({ rrset })} onDelete={setDeleteTarget} /></> : loading ? <div className="ws-loading" role="status"><span className="ws-spinner" />Yetkili DNS bölgesi okunuyor…</div> : <EmptyState title="Yerel Yetkili DNS Bölgesi Bulunmuyor" detail={`${root.primaryDomain} için bu sunucuda yerel PowerDNS bölgesi bulunmuyor. Alan adınızın DNS kayıtları alan adı firmanızda veya harici DNS sağlayıcınızda (Cloudflare vb.) barındırılıyor olabilir.`} icon="globe" action={canManage && !ownChild ? <Button variant="primary" icon="plus" disabled={busy} onClick={provisionZone}>{busy ? 'Bölge oluşturuluyor…' : 'Yerel DNS Bölgesi Oluştur'}</Button> : null} />}
    </Section>
    {zone && <>
      {!ownChild && <SecondaryDnsStatusPanel state={secondary} loading={loading} busy={busy} onRefresh={refresh} />}
      <div className="ws-equal-columns"><ReapplyPanel preview={reapply} loading={loading} canManage={canManage} busy={busy} onRefresh={refresh} onApply={() => setConfirmation({ kind: 'reapply', preview: reapply })} />{!ownChild && <DnssecPanel state={dnssec} preview={dnssecPreview} canManage={canManage} busy={busy} onPreview={prepareDnssec} onRefresh={refresh} />}</div>
      <OperationsPanel reapply={reapplyOperations} dnssec={dnssecOperations} />
    </>}
    {recordDialog && zone && <DnsRecordDialog zone={zone} rrset={recordDialog.rrset} onClose={() => setRecordDialog(null)} onSaved={refreshed} />}
    {deleteTarget && zone && <ConfirmDialog title="Özel DNS kaydını sil" message={`${relativeDnsOwner(deleteTarget.owner, zone.zoneName)} ${deleteTarget.type} kaydı silinecek. Sistem tarafından yönetilen kayıtlar bu yoldan silinemez.`} confirmation={`delete-dns:${relativeDnsOwner(deleteTarget.owner, zone.zoneName)}:${deleteTarget.type}`} confirmLabel="Kaydı sil" busy={busy} error={null} onCancel={() => setDeleteTarget(null)} onConfirm={deleteRecord} />}
    {confirmation?.kind === 'reapply' && <ConfirmDialog title="Bölge şablonunu yeniden uygula" message={`${confirmation.preview.changes?.length ?? 0} kayıt değişikliği uygulanacak; özel kayıtlarınız korunacak ve SOA seri numarası ${confirmation.preview.observedSerial} → ${confirmation.preview.nextSerial} olarak güncellenecek.`} confirmation={confirmation.preview.confirmation} confirmLabel="Bölgeyi güncelle" busy={busy} error={null} onCancel={() => setConfirmation(null)} onConfirm={runReapply} />}
    {confirmation?.kind === 'dnssec' && <ConfirmDialog title={confirmation.preview.targetEnabled ? 'DNSSEC imzalamayı aç' : 'DNSSEC imzalamayı kapat'} message={confirmation.preview.targetEnabled ? 'PowerDNS bölge imzalama açılacak. İşlemden sonra üretilen DS kaydı alan adı kayıt firmanıza eklenmeden güvenli delege tamamlanmış sayılmaz.' : 'DNSSEC yalnızca alan adı kayıt firmasında DS kaydının kaldırıldığı doğrulandığında kapatılır.'} confirmation={confirmation.preview.confirmation} confirmLabel={confirmation.preview.targetEnabled ? 'DNSSEC’i aç' : 'DNSSEC’i kapat'} busy={busy} error={null} onCancel={() => setConfirmation(null)} onConfirm={runDnssec} />}
  </>;
}
