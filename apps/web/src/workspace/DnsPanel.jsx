import { useCallback, useEffect, useMemo, useState } from 'react';
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
  rootDnsDomain,
} from './dns-model.js';
import { Badge, Button, ConfirmDialog, EmptyState, ErrorNotice, KeyValues, LinkButton, Modal, Section } from './PanelKit.jsx';
import SecondaryDnsStatusPanel from './SecondaryDnsStatusPanel.jsx';
import { formatDate, siteHref } from './site-model.js';
import './dns-panel.css';

function operationHistory(reapply, dnssec) {
  return [
    ...(Array.isArray(reapply) ? reapply.map((entry) => ({ ...entry, kind: 'reapply' })) : []),
    ...(Array.isArray(dnssec) ? dnssec.map((entry) => ({ ...entry, kind: 'dnssec' })) : []),
  ].sort((left, right) => Date.parse(right.updatedAt ?? right.createdAt ?? 0) - Date.parse(left.updatedAt ?? left.createdAt ?? 0));
}

function valueHint(type) {
  return ({
    A: 'Her satıra bir IPv4 adresi.', AAAA: 'Her satıra bir IPv6 adresi.',
    CNAME: 'Tek hedef hostname. Örnek: app.example.com', MX: 'Her satır: öncelik hedef. Örnek: 10 mail.example.com',
    TXT: 'Her satır ayrı TXT değeri.', CAA: 'Her satır: flags tag value. Örnek: 0 issue letsencrypt.org',
    SRV: 'Her satır: priority weight port target. Örnek: 0 1 443 service.example.com',
    NS: 'Her satıra bir nameserver hostname.', SOA: 'Tek değer: primary-ns rname serial refresh retry expire minimum.',
  })[type] ?? '';
}

function DnsRecordDialog({ zone, rrset, onClose, onSaved }) {
  const [draft, setDraft] = useState(() => dnsRecordDraft(rrset, zone.zoneName));
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
      await onSaved(editing ? 'Manual DNS kaydı güncellendi.' : 'Manual DNS kaydı eklendi.');
    } catch (failure) {
      if (failure.name !== 'AbortError') setError(failure.message);
    } finally { setBusy(false); }
  }
  return <Modal title={editing ? 'Manual DNS kaydını düzenle' : 'Manual DNS kaydı ekle'} onClose={onClose} busy={busy} wide>
    <form className="ws-form dns-record-form" onSubmit={submit}>
      <ErrorNotice error={error} />
      <fieldset disabled={busy}>
        <div className="ws-form-grid">
          <label>Kayıt adı<input value={draft.owner} readOnly={editing} onChange={(event) => update('owner', event.target.value)} placeholder="@ veya api" required autoComplete="off" spellCheck={false} /><span className="dns-field-hint">Kök kayıt için @; relative adlar zone içine yazılır.</span></label>
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
  if (!zone?.rrsets?.length) return <EmptyState title="Zone boş" detail="Authoritative zone var ancak RRset bulunamadı." icon="globe" />;
  return <div className="dns-table-wrap"><table className="dns-table"><thead><tr><th>Ad</th><th>Tür</th><th>TTL</th><th>Kaynak</th><th>Değer</th><th aria-label="İşlemler" /></tr></thead><tbody>{zone.rrsets.map((rrset) => {
    const editable = dnsRecordEditable(rrset);
    const values = dnsRrsetValues(rrset);
    return <tr key={`${rrset.owner}:${rrset.type}`}><td><strong>{relativeDnsOwner(rrset.owner, zone.zoneName)}</strong><small>{rrset.owner}</small></td><td><code>{rrset.type}</code></td><td>{rrset.ttl ?? '—'}</td><td><Badge state={editable ? 'unknown' : 'staged'}>{dnsSourceLabel(rrset.source)}</Badge>{rrset.templateVersion && <small>v{rrset.templateVersion}</small>}</td><td className="dns-values">{values.length ? values.map((value, index) => <code key={`${value}:${index}`}>{value}</code>) : <span>—</span>}</td><td>{editable && canManage && <div className="ws-actions"><Button disabled={busy} onClick={() => onEdit(rrset)}>Düzenle</Button><Button variant="danger" disabled={busy} onClick={() => onDelete(rrset)}>Sil</Button></div>}</td></tr>;
  })}</tbody></table>{canManage && <div className="dns-table-footer"><Button variant="primary" icon="plus" disabled={busy} onClick={onAdd}>Manual kayıt ekle</Button></div>}</div>;
}

function ReapplyPanel({ preview, loading, canManage, busy, onRefresh, onApply }) {
  return <Section title="Zone Template senkronizasyonu" description="Server-wide Zone Template değişiklikleri mevcut zone’a otomatik yazılmaz; önce diff üretilir.">
    <div className="ws-section-body">
      {loading && !preview ? <div className="ws-loading" role="status"><span className="ws-spinner" />Zone diff okunuyor…</div> : preview ? <>
        <KeyValues items={[
          ['Template sürümü', preview.templateVersion], ['DNS identity revision', preview.dnsIdentityRevision],
          ['Mevcut SOA serial', preview.observedSerial], ['Hedef SOA serial', preview.nextSerial],
          ['Korunan manual RRset', preview.preservedManualRrsetCount], ['Değişiklik', preview.changes?.length ?? 0],
        ]} />
        {preview.conflicts?.length > 0 && <div className="ws-notice ws-notice-error" role="alert"><div><strong>Manual kayıt çakışması</strong><p>{preview.conflicts.map((item) => `${relativeDnsOwner(item.owner, preview.zoneName)} ${item.type}`).join(', ')} managed desired state ile aynı RRset’i kullanıyor. Manual kayıt sessizce ezilmeyecek.</p></div></div>}
        {preview.blockers?.length > 0 && <div className="ws-notice ws-notice-warn" role="alert"><div><strong>Re-apply bloklandı</strong><p>{preview.blockers.map((item) => `${relativeDnsOwner(item.owner, preview.zoneName)} ${item.type} · ${item.code}`).join(', ')}</p></div></div>}
        {preview.changes?.length > 0 && <div className="dns-diff"><strong>Planlanan RRset değişiklikleri</strong>{preview.changes.map((item, index) => <div key={`${item.action}:${item.owner}:${item.type}:${index}`}><Badge state={item.action === 'delete' ? 'warning' : item.action === 'replace' ? 'running' : 'staged'}>{item.action}</Badge><code>{relativeDnsOwner(item.owner, preview.zoneName)} {item.type}</code><span>{dnsSourceLabel(item.source)}</span></div>)}</div>}
        {preview.noChanges && <div className="ws-notice"><div><strong>Zone güncel</strong><p>Authoritative managed kayıtlar mevcut Zone Template ve DNS identity ile eşleşiyor.</p></div></div>}
      </> : <div className="ws-muted">Zone diff henüz okunmadı.</div>}
      <div className="ws-actions"><Button icon="refresh" disabled={busy || loading} onClick={onRefresh}>Diff’i yenile</Button>{canManage && preview?.applyAllowed && <Button variant="primary" disabled={busy} onClick={onApply}>Template’i zone’a uygula</Button>}</div>
    </div>
  </Section>;
}

function DnssecPanel({ state, preview, canManage, busy, onPreview, onRefresh }) {
  const presentation = dnssecPresentation(state?.status);
  return <Section title="DNSSEC" description="Signing state ile parent/registrar DS yayını ayrı ayrı doğrulanır." actions={state && <Badge state={presentation.state}>{presentation.label}</Badge>}>
    <div className="ws-section-body">
      {state ? <>
        <KeyValues items={[
          ['Local signing', state.dnssec ? 'Açık' : 'Kapalı'], ['Parent DS', state.parent?.status ?? '—'],
          ['SOA serial', state.serial], ['Signing key', state.keys?.length ?? 0],
        ]} />
        {state.ds?.length > 0 && <div className="dns-ds-box"><strong>Registrar’a girilecek DS</strong>{state.ds.map((record) => <code key={record}>{record}</code>)}</div>}
        {state.parent?.records?.length > 0 && <div className="dns-ds-box"><strong>Parent’ta görülen DS</strong>{state.parent.records.map((record) => <code key={record}>{record}</code>)}</div>}
        {state.status === 'pending_parent_ds' && <div className="ws-notice ws-notice-warn"><div><strong>DNSSEC henüz secure değil</strong><p>Yukarıdaki DS değerini registrar/parent zone’a ekleyin. Parent authoritative nameserver’larda aynı DS görülmeden secure-ready gösterilmez.</p></div></div>}
        {['parent_ds_mismatch', 'parent_ds_without_dnssec', 'signing_material_incomplete'].includes(state.status) && <div className="ws-notice ws-notice-error" role="alert"><div><strong>DNSSEC müdahale istiyor</strong><p>{presentation.label}. Delegasyon bu durumda güvenli kabul edilmez.</p></div></div>}
      </> : <div className="ws-loading" role="status"><span className="ws-spinner" />DNSSEC durumu okunuyor…</div>}
      {preview?.blockers?.length > 0 && <div className="ws-notice ws-notice-warn" role="alert"><div><strong>DNSSEC değişikliği bloklandı</strong><p>{preview.blockers.map((item) => item.message).join(' ')}</p></div></div>}
      <div className="ws-actions"><Button icon="refresh" disabled={busy} onClick={onRefresh}>Durumu yenile</Button>{canManage && state && <Button variant={state.dnssec ? 'danger' : 'primary'} disabled={busy || state.status === 'signing_material_incomplete'} onClick={() => onPreview(!state.dnssec)}>{state.dnssec ? 'DNSSEC’i kapat' : 'DNSSEC’i aç'}</Button>}</div>
    </div>
  </Section>;
}

function OperationsPanel({ reapply, dnssec }) {
  const operations = useMemo(() => operationHistory(reapply, dnssec).slice(0, 10), [reapply, dnssec]);
  return <Section title="DNS işlemleri" description="Template re-apply ve DNSSEC mutation journal’ları restart sonrası inspect-first recovery için tutulur.">
    {operations.length === 0 ? <EmptyState title="Henüz DNS operation yok" detail="Zone re-apply veya DNSSEC değişikliği yapıldığında burada görünür." icon="jobs" /> : <div className="dns-operation-list">{operations.map((operation) => {
      const presentation = operationPresentation(operation);
      return <article key={`${operation.kind}:${operation.id}`}><div><strong>{operation.kind === 'dnssec' ? `DNSSEC ${operation.targetEnabled ? 'enable' : 'disable'}` : 'Zone Template re-apply'}</strong><span>{formatDate(operation.updatedAt ?? operation.createdAt)}</span></div><Badge state={presentation.state}>{presentation.label}</Badge>{operation.error && <small>{operation.error.code} · {operation.error.message}</small>}</article>;
    })}</div>}
  </Section>;
}

export default function DnsPanel({ domain, domains, canManage }) {
  const root = rootDnsDomain(domain, domains);
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

  const refresh = useCallback(async () => {
    if (!root || root.id !== domain.id) return;
    setLoading(true); setError(null);
    const results = await Promise.allSettled([
      getDnsZone(root.id), getDnsSecondaryStatus(root.id), previewDnsReapply(root.id), getDnssecStatus(root.id),
      listDnsReapplyOperations(root.id), listDnssecOperations(root.id),
    ]);
    const setters = [setZone, setSecondary, setReapply, setDnssec, setReapplyOperations, setDnssecOperations];
    results.forEach((result, index) => {
      if (result.status === 'fulfilled') setters[index](result.value);
      else setters[index](null);
    });
    const zoneNotFound = results[0].status === 'rejected'
      && (results[0].reason?.message?.includes('not found') || results[0].reason?.message?.includes('bulunamadı') || results[0].reason?.status === 404);
    if (!zoneNotFound) {
      const critical = results.slice(0, 4).find((result) => result.status === 'rejected');
      if (critical?.reason?.name !== 'AbortError') setError(critical?.reason?.message ?? null);
    }
    setLoading(false);
  }, [domain.id, root?.id]);

  useEffect(() => { void refresh(); }, [refresh]);

  if (!root) return <Section title="DNS"><EmptyState title="Authoritative zone bulunamadı" detail="Domain hierarchy eksik veya döngülü. DNS mutation yapılmadı." icon="alert" /></Section>;
  if (root.id !== domain.id) return <Section title="DNS"><EmptyState title={`${root.primaryDomain} authoritative zone’u yönetiyor`} detail={`${domain.primaryDomain} ayrı bir zone sahibi değil. Subdomain kayıtları parent/root zone içinde yönetilir.`} icon="globe" action={<LinkButton to={siteHref(root.id, 'dns')} icon="arrow">{root.primaryDomain} DNS ayarlarına git</LinkButton>} /></Section>;

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
      await refreshed('Yerel PowerDNS authoritative zone başarıyla oluşturuldu.');
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
      await refreshed('Manual DNS kaydı silindi.');
    } catch (failure) { if (failure.name !== 'AbortError') setError(failure.message); }
    finally { setBusy(false); }
  }

  async function runReapply() {
    if (confirmation?.kind !== 'reapply' || busy) return;
    setBusy(true); setError(null); setMessage(null);
    try {
      const started = await applyDnsReapply(root.id, confirmation.preview);
      const operation = await waitForDnsOperation({ domainId: root.id, kind: 'reapply', operation: started });
      if (operation.status === 'failed') throw new Error(operation.error?.message ?? 'Zone Template re-apply başarısız.');
      await refreshed('Zone Template authoritative zone’a uygulandı.');
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
      await refreshed(confirmation.preview.targetEnabled ? 'DNSSEC signing açıldı. Parent DS durumunu doğrulayın.' : 'DNSSEC signing güvenli sırayla kapatıldı.');
    } catch (failure) { if (failure.name !== 'AbortError') setError(failure.message); }
    finally { setBusy(false); }
  }

  return <>
    {message && <div className="ws-notice"><div><strong>DNS</strong><p>{message}</p></div></div>}
    <ErrorNotice error={error} />
    <Section title="Authoritative DNS zone" description={`${root.primaryDomain} · PowerDNS authoritative`} actions={<Button icon="refresh" disabled={busy || loading} onClick={refresh}>{loading ? 'Yenileniyor…' : 'Yenile'}</Button>}>
      {zone ? <><div className="ws-section-body"><KeyValues items={[
        ['Zone', zone.zoneName], ['SOA serial', zone.serial], ['Zone türü', zone.kind], ['DNSSEC', zone.dnssec ? 'Signing açık' : 'Kapalı'],
      ]} /><p className="ws-muted">Zone Template, mail ve runtime kayıtları YunPanel ownership marker’ı taşır ve burada read-only görünür. Manual kayıtlar ayrı sahiplikte düzenlenebilir.</p></div><ZoneRecords zone={zone} canManage={canManage} busy={busy} onAdd={() => setRecordDialog({ rrset: null })} onEdit={(rrset) => setRecordDialog({ rrset })} onDelete={setDeleteTarget} /></> : loading ? <div className="ws-loading" role="status"><span className="ws-spinner" />Authoritative zone okunuyor…</div> : <EmptyState title="Yerel Authoritative DNS Zone Bulunmuyor" detail={`${root.primaryDomain} için bu sunucuda yerel PowerDNS authoritative zone bulunmuyor. Alan adınızın DNS kayıtları alan adı firmanızda veya harici DNS sağlayıcınızda (Cloudflare vb.) barındırılıyor olabilir.`} icon="globe" action={canManage ? <Button variant="primary" icon="plus" disabled={busy} onClick={provisionZone}>{busy ? 'Zone oluşturuluyor…' : 'Yerel DNS Zone Oluştur'}</Button> : null} />}
    </Section>
    {zone && <>
      <SecondaryDnsStatusPanel state={secondary} loading={loading} busy={busy} onRefresh={refresh} />
      <div className="ws-equal-columns"><ReapplyPanel preview={reapply} loading={loading} canManage={canManage} busy={busy} onRefresh={refresh} onApply={() => setConfirmation({ kind: 'reapply', preview: reapply })} /><DnssecPanel state={dnssec} preview={dnssecPreview} canManage={canManage} busy={busy} onPreview={prepareDnssec} onRefresh={refresh} /></div>
      <OperationsPanel reapply={reapplyOperations} dnssec={dnssecOperations} />
    </>}
    {recordDialog && zone && <DnsRecordDialog zone={zone} rrset={recordDialog.rrset} onClose={() => setRecordDialog(null)} onSaved={refreshed} />}
    {deleteTarget && zone && <ConfirmDialog title="Manual DNS kaydını sil" message={`${relativeDnsOwner(deleteTarget.owner, zone.zoneName)} ${deleteTarget.type} RRset’i silinecek. Managed kayıtlar bu yoldan silinemez.`} confirmation={`delete-dns:${relativeDnsOwner(deleteTarget.owner, zone.zoneName)}:${deleteTarget.type}`} confirmLabel="Kaydı sil" busy={busy} error={null} onCancel={() => setDeleteTarget(null)} onConfirm={deleteRecord} />}
    {confirmation?.kind === 'reapply' && <ConfirmDialog title="Zone Template’i yeniden uygula" message={`${confirmation.preview.changes?.length ?? 0} managed RRset değişikliği uygulanacak; manual kayıtlar korunacak ve SOA serial ${confirmation.preview.observedSerial} → ${confirmation.preview.nextSerial} ilerleyecek.`} confirmation={confirmation.preview.confirmation} confirmLabel="Zone’u güncelle" busy={busy} error={null} onCancel={() => setConfirmation(null)} onConfirm={runReapply} />}
    {confirmation?.kind === 'dnssec' && <ConfirmDialog title={confirmation.preview.targetEnabled ? 'DNSSEC signing aç' : 'DNSSEC signing kapat'} message={confirmation.preview.targetEnabled ? 'PowerDNS zone signing açılacak. İşlemden sonra üretilen DS registrar/parent zone’a eklenmeden secure delegation tamamlanmış sayılmaz.' : 'DNSSEC yalnız parent authoritative nameserver’larda DS kaydı verifiably absent ise kapatılır.'} confirmation={confirmation.preview.confirmation} confirmLabel={confirmation.preview.targetEnabled ? 'DNSSEC’i aç' : 'DNSSEC’i kapat'} busy={busy} error={null} onCancel={() => setConfirmation(null)} onConfirm={runDnssec} />}
  </>;
}
