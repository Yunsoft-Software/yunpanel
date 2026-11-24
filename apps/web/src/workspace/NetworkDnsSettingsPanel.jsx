import { useCallback, useEffect, useMemo, useState } from 'react';
import {
  applyPowerDnsAuthoritative,
  applyServerDnsIdentity,
  getPowerDnsAuthoritative,
  getServerDnsIdentity,
  inspectDnsDelegation,
  previewPowerDnsAuthoritative,
  previewServerDnsIdentity,
  resolvePowerDnsRecovery,
  rollbackPowerDnsAuthoritative,
  retryPowerDnsRecovery,
} from './network-dns-client.js';
import {
  authoritativeOperationPresentation,
  authoritativePresentation,
  delegationPresentation,
  dnsIdentityDraft,
  dnsIdentitySettings,
  publicReachabilityPresentation,
} from './network-dns-model.js';
import { Badge, Button, ConfirmDialog, EmptyState, ErrorNotice, KeyValues, Modal, ModalCloseButton, Section } from './PanelKit.jsx';
import './network-dns.css';

const WARNING_PRESENTATIONS = Object.freeze({
  dns_nameserver_redundancy_missing: {
    title: 'Yedekli DNS eksik',
    message: 'Yedekli DNS eksik: ns1 ve ns2 aynı sunucu adresine yönleniyor; kesintisiz yetkili DNS için ayrı ağda ikincil DNS sunucusu tanımlanmalıdır.',
  },
});

function formatAuthoritativeBadge(presentation, authoritative) {
  if (!authoritative) return { state: 'unknown', label: 'Durum alınamadı' };
  if (authoritative.localReady ?? authoritative.ready) return { state: 'active', label: 'Yerel yetkili DNS hazır' };
  if (!authoritative.configured) return { state: 'off', label: 'PowerDNS yapılandırılmamış' };
  return { state: presentation.state, label: 'Yerel servis hazır değil' };
}

function formatPublicBadge(presentation, authoritative) {
  const status = authoritative?.publicReachability?.status;
  const mapped = {
    ready: 'Dış UDP/TCP 53 hazır',
    unreachable: 'Dış DNS portu erişilemiyor',
    unverified: 'Dış erişim doğrulanmadı',
    unverifiable: 'Dış erişim doğrulanamıyor',
    blocked: 'Dış kontrol bekliyor',
  }[status];
  return { state: presentation.state, label: mapped ?? 'Dış erişim durumu yok' };
}

function formatDelegationBadge(presentation, status) {
  const mapped = {
    ready: 'Delege hazır',
    pending_glue: 'Glue kaydı bekleniyor',
    pending_delegation: 'NS delege kaydı bekleniyor',
    pending_nameserver_address: 'Ad sunucusu adresi uyuşmuyor',
    unverifiable: 'Delege doğrulanamıyor',
  }[status];
  return { state: presentation.state, label: mapped ?? 'Bilinmiyor' };
}

function formatOperationBadge(presentation, operation) {
  const mapped = {
    applying: 'Kurtarma incelemesi gerekli',
    succeeded: 'Uygulama tamamlandı',
    failed: 'Uygulama başarısız',
    rolling_back: 'Geri alma incelemesi gerekli',
    rolled_back: 'Geri alma tamamlandı',
    rollback_failed: 'Geri alma başarısız',
  }[operation?.status];
  return { state: presentation.state, label: mapped ?? 'İşlem yok' };
}

function ChoiceButtons({ label, value, onChange, options, disabled = false }) {
  return <div className="network-dns-choice"><span>{label}</span><div role="group" aria-label={label}>{options.map((option) => <button key={String(option.value)} type="button" className={value === option.value ? 'active' : ''} aria-pressed={value === option.value} disabled={disabled} onClick={() => onChange(option.value)}>{option.label}</button>)}</div></div>;
}

function SupportCodeDetails({ code }) {
  if (!code) return null;
  return <details className="ws-support-code"><summary>Destek kodu</summary><code>{code}</code></details>;
}

function WarningList({ warnings }) {
  if (!warnings?.length) return null;
  return <div className="network-dns-warning-list">{warnings.map((warning) => {
    const known = WARNING_PRESENTATIONS[warning.code];
    const title = known?.title ?? 'DNS yapılandırma uyarısı';
    const text = known?.message ?? warning.message ?? 'DNS yapılandırmasını gözden geçirin.';
    return <div key={warning.code} className="ws-notice ws-notice-warn" role="status"><div><strong>{title}</strong><p>{text}</p><SupportCodeDetails code={warning.code} /></div></div>;
  })}</div>;
}

function IdentityDialog({ current, onClose, onApplied }) {
  const [initialDraft] = useState(() => dnsIdentityDraft(current));
  const [draft, setDraft] = useState(initialDraft);
  const [preview, setPreview] = useState(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);
  const dirty = JSON.stringify(draft) !== JSON.stringify(initialDraft);
  function update(field, value) { setDraft((state) => ({ ...state, [field]: value })); }
  function updateNs(role, field, value) { setDraft((state) => ({ ...state, [role]: { ...state[role], [field]: value } })); }
  function updateSoa(field, value) { setDraft((state) => ({ ...state, soa: { ...state.soa, [field]: value } })); }
  async function createPreview(event) {
    event.preventDefault();
    if (busy) return;
    setBusy(true); setError(null); setPreview(null);
    try { setPreview(await previewServerDnsIdentity(current.serverId, dnsIdentitySettings(draft))); }
    catch (failure) { if (failure.name !== 'AbortError') setError(failure.message); }
    finally { setBusy(false); }
  }
  async function apply() {
    if (!preview || busy) return;
    setBusy(true); setError(null);
    try { await applyServerDnsIdentity(preview.serverId, preview); await onApplied(); }
    catch (failure) { if (failure.name !== 'AbortError') setError(failure.message); }
    finally { setBusy(false); }
  }
  if (preview) {
    const impact = [
      `sürüm ${preview.currentRevision} → ${preview.nextRevision}`,
      preview.impact?.authoritativeDnsRestartRequired ? 'PowerDNS yeniden başlatma gerekli' : null,
      preview.impact?.delegationMayChange ? 'delege ayarları değişebilir' : null,
      'mevcut bölgeler otomatik olarak güncellenmez',
    ].filter(Boolean).join(' · ');
    return <ConfirmDialog title="DNS kimliğini güncelle" message={`Ad sunucusu ve SOA kimliği değişecek: ${impact}.`} confirmation={preview.confirmation} busy={busy} error={error} onCancel={() => { setPreview(null); setError(null); }} onConfirm={apply} confirmLabel="DNS kimliğini güncelle" />;
  }
  return <Modal title="Yetkili DNS kimliği" onClose={onClose} busy={busy} dirty={dirty} wide>
    <form className="ws-form" onSubmit={createPreview}>
      <ErrorNotice error={error} />
      <fieldset disabled={busy}>
        <p className="ws-muted">Bu ekran sunucunun işletim sistemi adını değiştirmez. Yalnızca PowerDNS yetkili DNS kimliğini ve bölge şablonunun kullanacağı ad sunucusu/SOA varsayılanlarını yönetir.</p>
        <div className="ws-form-grid">
          <label>Genel IPv4<input value={draft.publicIpv4} onChange={(event) => update('publicIpv4', event.target.value)} required placeholder="203.0.113.10" autoComplete="off" spellCheck={false} /></label>
          <label>Genel IPv6<input value={draft.publicIpv6} onChange={(event) => update('publicIpv6', event.target.value)} placeholder="2001:db8::10" autoComplete="off" spellCheck={false} /></label>
          <label>ns1 alan adı<input value={draft.ns1.hostname} onChange={(event) => updateNs('ns1', 'hostname', event.target.value)} required placeholder="ns1.example.com" autoComplete="off" spellCheck={false} /></label>
          <label>ns1 IPv4<input value={draft.ns1.ipv4} onChange={(event) => updateNs('ns1', 'ipv4', event.target.value)} required placeholder="203.0.113.10" autoComplete="off" spellCheck={false} /></label>
          <label>ns1 IPv6<input value={draft.ns1.ipv6} onChange={(event) => updateNs('ns1', 'ipv6', event.target.value)} placeholder="2001:db8::10" autoComplete="off" spellCheck={false} /></label>
          <div><ChoiceButtons label="ns1 servis konumu" value={draft.ns1.local} disabled options={[{ value: true, label: 'Bu sunucu' }]} onChange={() => {}} /></div>
          <label>ns2 alan adı<input value={draft.ns2.hostname} onChange={(event) => updateNs('ns2', 'hostname', event.target.value)} required placeholder="ns2.example.com" autoComplete="off" spellCheck={false} /></label>
          <label>ns2 IPv4<input value={draft.ns2.ipv4} onChange={(event) => updateNs('ns2', 'ipv4', event.target.value)} required placeholder="203.0.113.11" autoComplete="off" spellCheck={false} /></label>
          <label>ns2 IPv6<input value={draft.ns2.ipv6} onChange={(event) => updateNs('ns2', 'ipv6', event.target.value)} placeholder="2001:db8::11" autoComplete="off" spellCheck={false} /></label>
          <div><ChoiceButtons label="ns2 servis konumu" value={draft.ns2.local} options={[{ value: true, label: 'Bu sunucu' }, { value: false, label: 'Harici ikincil sunucu' }]} onChange={(value) => updateNs('ns2', 'local', value)} /></div>
        </div>
        <h3 className="network-dns-subheading">SOA politikası</h3>
        <div className="ws-form-grid">
          <label>SOA yetkili adresi<input value={draft.soa.rname} onChange={(event) => updateSoa('rname', event.target.value)} required placeholder="hostmaster.example.com" autoComplete="off" spellCheck={false} /></label>
          <label>TTL (saniye)<input type="number" value={draft.soa.ttl} min="60" max="86400" onChange={(event) => updateSoa('ttl', event.target.value)} required /></label>
          <label>Yenileme (saniye)<input type="number" value={draft.soa.refresh} min="300" max="86400" onChange={(event) => updateSoa('refresh', event.target.value)} required /></label>
          <label>Yeniden deneme (saniye)<input type="number" value={draft.soa.retry} min="60" max="86400" onChange={(event) => updateSoa('retry', event.target.value)} required /></label>
          <label>Süre sonu (saniye)<input type="number" value={draft.soa.expire} min="86400" max="2419200" onChange={(event) => updateSoa('expire', event.target.value)} required /></label>
          <label>Negatif önbellek (saniye)<input type="number" value={draft.soa.minimum} min="60" max="86400" onChange={(event) => updateSoa('minimum', event.target.value)} required /></label>
        </div>
        <h3 className="network-dns-subheading">Bölge varsayılanları</h3>
        <ChoiceButtons label="Yeni bölgeler için varsayılan DNSSEC" value={draft.dnssecDefault} options={[{ value: false, label: 'Kapalı' }, { value: true, label: 'Açık' }]} onChange={(value) => update('dnssecDefault', value)} />
        <label>İkincil DNS aktarım hedefleri<textarea rows={4} value={draft.secondaryDns} onChange={(event) => update('secondaryDns', event.target.value)} placeholder="Her satıra bir IPv4/IPv6 adresi" spellCheck={false} /></label>
        <footer className="ws-modal-footer"><ModalCloseButton disabled={busy}>Vazgeç</ModalCloseButton><Button variant="primary" disabled={busy} type="submit">{busy ? 'Kontrol ediliyor…' : 'Değişikliği önizle'}</Button></footer>
      </fieldset>
    </form>
  </Modal>;
}

function DelegationPanel({ server, identity, defaultDomain }) {
  const [domain, setDomain] = useState(defaultDomain ?? '');
  const [inspection, setInspection] = useState(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);
  useEffect(() => { if (!domain && defaultDomain) setDomain(defaultDomain); }, [defaultDomain, domain]);
  async function inspect(event) {
    event?.preventDefault?.();
    if (busy || !identity || !domain.trim()) return;
    setBusy(true); setError(null); setInspection(null);
    try { setInspection(await inspectDnsDelegation(server.id, domain)); }
    catch (failure) { if (failure.name !== 'AbortError') setError(failure.message); }
    finally { setBusy(false); }
  }
  const presentation = formatDelegationBadge(delegationPresentation(inspection?.status), inspection?.status);
  const needsRecheck = Boolean(inspection && inspection.status !== 'ready');
  return <Section title="Alan Adı Kayıt ve Delege Bilgisi" description="Üst alan adı NS yönlendirmeleri ve ad sunucusu adresleri genel DNS üzerinden kontrol edilir; YunPanel alan adı kayıt firmanızdaki ayarları otomatik değiştirmez." actions={inspection && <div className="ws-actions"><Badge state={presentation.state}>{presentation.label}</Badge>{needsRecheck && <Button icon="refresh" disabled={busy} onClick={inspect}>Kayıtları kontrol et / Yenile</Button>}</div>}>
    <div className="ws-section-body"><ErrorNotice error={error} />{identity ? <form className="network-dns-inline" onSubmit={inspect}><label>Kontrol edilecek ana alan adı<input value={domain} onChange={(event) => setDomain(event.target.value)} placeholder="example.com" required spellCheck={false} /></label><Button type="submit" icon="refresh" disabled={busy}>{busy ? 'Kontrol ediliyor…' : 'Kayıtları kontrol et / Yenile'}</Button></form> : <p className="ws-muted">Delege kontrolü için önce yetkili DNS kimliğini yapılandırın.</p>}
      {inspection && <><KeyValues items={[
        ['Beklenen NS', inspection.delegation?.expected?.join(', ')], ['Gözlenen NS', inspection.delegation?.observed?.join(', ') || 'Yok'],
        ['Eksik NS', inspection.delegation?.missing?.join(', ') || 'Yok'], ['Ek NS', inspection.delegation?.extra?.join(', ') || 'Yok'],
        ['Son kontrol', inspection.checkedAt],
      ]} /><div className="network-dns-ns-list">{inspection.nameservers?.map((ns) => <article key={ns.role}><div><strong>{ns.role.toUpperCase()} · {ns.hostname}</strong><span>{ns.inBailiwick ? 'Glue kaydı gerekebilir' : 'Harici ad sunucusu'}</span></div><Badge state={ns.ready ? 'active' : ns.transientFailure ? 'warning' : 'pending'}>{ns.ready ? 'Adres hazır' : 'Kontrol gerekli'}</Badge><small>Beklenen IPv4: {ns.configuredIpv4} · Gözlenen: {ns.observedIpv4?.join(', ') || 'yok'}</small>{ns.configuredIpv6 && <small>Beklenen IPv6: {ns.configuredIpv6} · Gözlenen: {ns.observedIpv6?.join(', ') || 'yok'}</small>}</article>)}</div><div className="network-dns-registrar"><strong>Kayıt firması talimatı</strong>{inspection.registrarInstructions?.nameservers?.map((ns) => <div key={ns.role}><code>{ns.hostname}</code><span>IPv4 {ns.ipv4}{ns.ipv6 ? ` · IPv6 ${ns.ipv6}` : ''}{ns.glueRequiredForThisDomain ? ' · glue / ana bilgisayar kaydı gerekli' : ''}</span></div>)}</div></>}
    </div>
  </Section>;
}

function reachabilityValue(value) {
  if (value === true) return 'Hazır';
  if (value === false) return 'Erişilemiyor';
  return 'Doğrulanmadı';
}

export default function NetworkDnsSettingsPanel({ server, domains = [], canManage = true }) {
  const [identity, setIdentity] = useState(null);
  const [authoritative, setAuthoritative] = useState(null);
  const [identityDialog, setIdentityDialog] = useState(false);
  const [authoritativePreview, setAuthoritativePreview] = useState(null);
  const [recoveryOperation, setRecoveryOperation] = useState(null);
  const [retryOperation, setRetryOperation] = useState(null);
  const [rollbackOperation, setRollbackOperation] = useState(null);
  const [busy, setBusy] = useState(false);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const rootDomains = useMemo(() => domains.filter((item) => item.serverId === server.id && !item.parentDomainId), [domains, server.id]);
  const defaultDomain = rootDomains[0]?.primaryDomain ?? '';

  const refresh = useCallback(async () => {
    setLoading(true); setError(null);
    try {
      const nextIdentity = await getServerDnsIdentity(server.id);
      setIdentity(nextIdentity);
      if (nextIdentity) {
        try { setAuthoritative(await getPowerDnsAuthoritative(server.id)); }
        catch (failure) { setAuthoritative(null); if (failure.name !== 'AbortError') setError(failure.message); }
      } else setAuthoritative(null);
    } catch (failure) { if (failure.name !== 'AbortError') setError(failure.message); }
    finally { setLoading(false); }
  }, [server.id]);
  useEffect(() => { void refresh(); }, [refresh]);

  async function preparePowerDns() {
    if (busy || !identity) return;
    setBusy(true); setError(null); setAuthoritativePreview(null);
    try { setAuthoritativePreview(await previewPowerDnsAuthoritative(server.id)); }
    catch (failure) { if (failure.name !== 'AbortError') setError(failure.message); }
    finally { setBusy(false); }
  }
  async function applyPowerDns() {
    if (busy || !authoritativePreview) return;
    setBusy(true); setError(null);
    try { await applyPowerDnsAuthoritative(server.id, authoritativePreview); setAuthoritativePreview(null); await refresh(); }
    catch (failure) { if (failure.name !== 'AbortError') setError(failure.message); }
    finally { setBusy(false); }
  }
  async function resolvePowerDns() {
    if (busy || !recoveryOperation) return;
    setBusy(true); setError(null);
    try { await resolvePowerDnsRecovery(server.id, recoveryOperation); setRecoveryOperation(null); await refresh(); }
    catch (failure) { if (failure.name !== 'AbortError') setError(failure.message); }
    finally { setBusy(false); }
  }
  async function retryPowerDns() {
    if (busy || !retryOperation) return;
    setBusy(true); setError(null);
    try { await retryPowerDnsRecovery(server.id, retryOperation); setRetryOperation(null); await refresh(); }
    catch (failure) { if (failure.name !== 'AbortError') setError(failure.message); }
    finally { setBusy(false); }
  }
  async function rollbackPowerDns() {
    if (busy || !rollbackOperation) return;
    setBusy(true); setError(null);
    try { await rollbackPowerDnsAuthoritative(server.id, rollbackOperation); setRollbackOperation(null); await refresh(); }
    catch (failure) { if (failure.name !== 'AbortError') setError(failure.message); }
    finally { setBusy(false); }
  }
  const authoritativeState = formatAuthoritativeBadge(authoritativePresentation(authoritative), authoritative);
  const publicState = formatPublicBadge(publicReachabilityPresentation(authoritative), authoritative);
  const operationState = formatOperationBadge(authoritativeOperationPresentation(authoritative?.operation), authoritative?.operation);
  const identityForDialog = identity ?? { serverId: server.id };

  return <>
    <Section title="Ağ ve Yetkili DNS" description="PowerDNS, ad sunucusu (ns1/ns2) ve SOA kimliği ayarları. İşletim sistemi sunucu adı değiştirilmez." actions={<div className="ws-actions"><Button icon="refresh" disabled={loading || busy} onClick={refresh}>Yenile</Button>{canManage && <Button variant="primary" disabled={busy} onClick={() => setIdentityDialog(true)}>{identity ? 'DNS kimliğini düzenle' : 'DNS kimliğini yapılandır'}</Button>}</div>}>
      <div className="ws-section-body"><ErrorNotice error={error} />{loading && !identity ? <div className="ws-loading" role="status"><span className="ws-spinner" />DNS durumu yükleniyor…</div> : identity ? <><KeyValues items={[
        ['Sunucu adı', server.hostname ?? server.name ?? '—'], ['DNS kimlik sürümü', identity.revision],
        ['Genel IPv4', identity.settings.publicIpv4], ['Genel IPv6', identity.settings.publicIpv6 ?? 'Yok'],
        ['ns1', `${identity.settings.ns1.hostname} · ${identity.settings.ns1.ipv4}`], ['ns2', `${identity.settings.ns2.hostname} · ${identity.settings.ns2.ipv4}`],
        ['SOA yetkili adresi', identity.settings.soa.rname], ['Yeni bölgeler için varsayılan DNSSEC', identity.settings.dnssecDefault ? 'Açık' : 'Kapalı'],
        ['İkincil DNS aktarım hedefleri', identity.settings.secondaryDns?.join(', ') || 'Yok'],
      ]} /><WarningList warnings={identity.warnings} /></> : <EmptyState title="Yetkili DNS kimliği yapılandırılmamış" detail="Ad sunucuları (ns1/ns2), genel IP ve SOA bilgileri kaydedilmeden PowerDNS kurulumu uygulanmaz." icon="globe" />}</div>
    </Section>
    <div className="ws-equal-columns"><Section title="PowerDNS Yerel ve Dış Erişim Durumu" description="Yerel servis sağlığı ile internetten UDP/TCP 53 erişimi ayrı ayrı doğrulanır." actions={authoritative && <div className="ws-actions"><Badge state={authoritativeState.state}>{authoritativeState.label}</Badge><Badge state={publicState.state}>{publicState.label}</Badge></div>}><div className="ws-section-body">{identity ? <><KeyValues items={[
      ['Yapılandırıldı', authoritative?.configured ? 'Evet' : 'Hayır'], ['API anahtarı', authoritative?.secretConfigured ? 'Hazır' : 'Eksik'],
      ['Yerel UDP/53', authoritative?.host?.sockets?.udp53 === true ? 'Hazır' : 'Doğrulanmadı'], ['Yerel TCP/53', authoritative?.host?.sockets?.tcp53 === true ? 'Hazır' : 'Doğrulanmadı'],
      ['Özyinelemeli çözümleyici', authoritative?.host?.sockets?.recursive === false ? 'Kapalı' : 'Doğrulanmadı'],
      ['Dış UDP/53', reachabilityValue(authoritative?.publicReachability?.udp53)], ['Dış TCP/53', reachabilityValue(authoritative?.publicReachability?.tcp53)],
      ['Dış doğrulama noktası', authoritative?.publicReachability?.vantage ?? 'Yapılandırılmadı'], ['Yetkili DNS genel durumu', authoritative?.overallReady ? 'Evet' : 'Hayır'],
    ]} />{authoritative?.operation && <div className={`ws-notice ${authoritative.operation.recovery?.required ? 'ws-notice-warn' : ''}`}><div><strong><Badge state={operationState.state}>{operationState.label}</Badge> · Son kurulum işlemi</strong><p>Kimlik bilgisi sürümü: {authoritative.operation.credentialRevision} · Son güncelleme: {authoritative.operation.updatedAt}{authoritative.operation.recovery?.required ? ' · Otomatik yeniden çalıştırma güvenlik nedeniyle durduruldu.' : ''}</p><SupportCodeDetails code={authoritative.operation.recovery?.reason ? `${authoritative.operation.id} · ${authoritative.operation.recovery.reason}` : authoritative.operation.id} />{canManage && (authoritative.operation.recovery?.confirmation || authoritative.operation.recovery?.retryConfirmation || authoritative.operation.rollback?.available) && <div className="ws-actions">{authoritative.operation.recovery?.confirmation && <Button disabled={busy} onClick={() => setRecoveryOperation(authoritative.operation)}>Kurtarma durumunu incele</Button>}{authoritative.operation.recovery?.retryConfirmation && <Button variant="danger" disabled={busy} onClick={() => setRetryOperation(authoritative.operation)}>İncele ve yeniden dene</Button>}{authoritative.operation.rollback?.available && <Button variant="danger" disabled={busy} onClick={() => setRollbackOperation(authoritative.operation)}>Önceki PowerDNS durumuna dön</Button>}</div>}</div></div>}<div className="ws-notice ws-notice-warn"><div><strong>Dış DNS erişimi ayrı doğrulanır</strong><p>{authoritative?.publicReachability?.status === 'unverified' ? 'Dış erişim doğrulama noktası tanımlı olmadığı için internetten UDP/TCP 53 erişimi doğrulanmadı. Yerel servisin hazır olması internetten erişildiği anlamına gelmez.' : authoritative?.publicReachability?.status === 'unverifiable' ? 'İnternetten DNS erişimi şu anda doğrulanamadı.' : authoritative?.publicReachability?.status === 'unreachable' ? 'Dış doğrulama noktası en az bir DNS protokolünde 53 numaralı porta erişemedi.' : 'Yerel servis sağlığı ve internetten DNS erişimi ayrı izlenir.'}</p>{authoritative?.publicReachability?.status === 'unverifiable' && authoritative?.publicReachability?.reason && <SupportCodeDetails code={authoritative.publicReachability.reason} />}{!authoritative?.localReady && authoritative?.configured && authoritative?.reason && <SupportCodeDetails code={authoritative.reason} />}</div></div>{canManage && <Button variant="primary" disabled={busy} onClick={preparePowerDns}>{authoritative?.localReady ? 'PowerDNS’i yeniden önizle' : 'PowerDNS kurulumunu önizle'}</Button>}</> : <p className="ws-muted">Önce yetkili DNS kimliği yapılandırılmalıdır.</p>}</div></Section><DelegationPanel server={server} identity={identity} defaultDomain={defaultDomain} /></div>
    {identityDialog && <IdentityDialog current={identityForDialog} onClose={() => setIdentityDialog(false)} onApplied={async () => { setIdentityDialog(false); await refresh(); }} />}
    {authoritativePreview && <ConfirmDialog title="PowerDNS kurulumunu uygula" message={`Paket, yapılandırma ve servis ayarları uygulanacak. Yönetim arayüzü ${authoritativePreview.api?.address ?? '127.0.0.1'}:${authoritativePreview.api?.port ?? 8081} yerel adresinde kalır; mevcut bölgeler otomatik olarak güncellenmez.`} confirmation={authoritativePreview.confirmation} busy={busy} error={error} onCancel={() => setAuthoritativePreview(null)} onConfirm={applyPowerDns} confirmLabel="PowerDNS’i uygula" />}
    {recoveryOperation && <ConfirmDialog title="PowerDNS kurtarma durumunu incele" message="Paket, yapılandırma veya servis değişikliği yapılmayacak. Mevcut sunucu durumu hedeflenen işlemle yeniden karşılaştırılacak; yalnızca tamamlandığı doğrulanırsa işlem başarılı olarak kapatılacak." confirmation={recoveryOperation.recovery.confirmation} busy={busy} error={error} onCancel={() => setRecoveryOperation(null)} onConfirm={resolvePowerDns} confirmLabel="Durumu incele" />}
    {retryOperation && <ConfirmDialog title="PowerDNS kurulumunu yeniden dene" message="Önce güncel sunucu durumu tekrar incelenecek. İşlem tamamlanmamışsa aynı kayıt altında kurulum yeniden çalıştırılır; sonuç belirsizse otomatik yineleme kapalı kalır." confirmation={retryOperation.recovery.retryConfirmation} busy={busy} error={error} onCancel={() => setRetryOperation(null)} onConfirm={retryPowerDns} confirmLabel="İncele ve yeniden dene" />}
    {rollbackOperation && <ConfirmDialog title="Önceki PowerDNS durumuna dön" message={`Yönetilen yapılandırma ve yetkili DNS durumu işlem öncesi anlık görüntüye döndürülecek; yapılandırma, servis ve bağlantı sağlığı yeniden doğrulanacak. Önceki ikincil DNS hedefleri: ${rollbackOperation.rollback.previousSecondaryDns?.join(', ') || 'yok'}.`} confirmation={rollbackOperation.rollback.confirmation} busy={busy} error={error} onCancel={() => setRollbackOperation(null)} onConfirm={rollbackPowerDns} confirmLabel="Önceki duruma dön" />}
  </>;
}
