import { useCallback, useEffect, useMemo, useState } from 'react';
import {
  applyPowerDnsAuthoritative,
  applyServerDnsIdentity,
  getPowerDnsAuthoritative,
  getServerDnsIdentity,
  inspectDnsDelegation,
  previewPowerDnsAuthoritative,
  previewServerDnsIdentity,
} from './network-dns-client.js';
import {
  authoritativePresentation,
  delegationPresentation,
  dnsIdentityDraft,
  dnsIdentitySettings,
  publicReachabilityPresentation,
} from './network-dns-model.js';
import { Badge, Button, ConfirmDialog, EmptyState, ErrorNotice, KeyValues, Modal, Section } from './PanelKit.jsx';
import './network-dns.css';

function ChoiceButtons({ label, value, onChange, options, disabled = false }) {
  return <div className="network-dns-choice"><span>{label}</span><div role="group" aria-label={label}>{options.map((option) => <button key={String(option.value)} type="button" className={value === option.value ? 'active' : ''} aria-pressed={value === option.value} disabled={disabled} onClick={() => onChange(option.value)}>{option.label}</button>)}</div></div>;
}

function WarningList({ warnings }) {
  if (!warnings?.length) return null;
  return <div className="network-dns-warning-list">{warnings.map((warning) => <div key={warning.code} className="ws-notice ws-notice-warn" role="status"><div><strong>{warning.code}</strong><p>{warning.message}</p></div></div>)}</div>;
}

function IdentityDialog({ current, onClose, onApplied }) {
  const [draft, setDraft] = useState(() => dnsIdentityDraft(current));
  const [preview, setPreview] = useState(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);
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
      `revision ${preview.currentRevision} → ${preview.nextRevision}`,
      preview.impact?.authoritativeDnsRestartRequired ? 'PowerDNS restart gerekli' : null,
      preview.impact?.delegationMayChange ? 'delegation değişebilir' : null,
      'mevcut zonelar otomatik sync edilmez',
    ].filter(Boolean).join(' · ');
    return <ConfirmDialog title="DNS kimliğini güncelle" message={`NS/SOA kimliği değişecek: ${impact}.`} confirmation={preview.confirmation} busy={busy} error={error} onCancel={() => { setPreview(null); setError(null); }} onConfirm={apply} confirmLabel="DNS kimliğini güncelle" />;
  }
  return <Modal title="Authoritative DNS kimliği" onClose={onClose} busy={busy} wide>
    <form className="ws-form" onSubmit={createPreview}>
      <ErrorNotice error={error} />
      <fieldset disabled={busy}>
        <p className="ws-muted">Bu ekran sunucunun işletim sistemi hostname’ini değiştirmez. Yalnız PowerDNS’in authoritative DNS kimliğini ve Zone Template’in kullanacağı NS/SOA varsayımlarını yönetir.</p>
        <div className="ws-form-grid">
          <label>Public IPv4<input value={draft.publicIpv4} onChange={(event) => update('publicIpv4', event.target.value)} required placeholder="203.0.113.10" autoComplete="off" spellCheck={false} /></label>
          <label>Public IPv6<input value={draft.publicIpv6} onChange={(event) => update('publicIpv6', event.target.value)} placeholder="2001:db8::10" autoComplete="off" spellCheck={false} /></label>
          <label>ns1 hostname<input value={draft.ns1.hostname} onChange={(event) => updateNs('ns1', 'hostname', event.target.value)} required placeholder="ns1.example.com" autoComplete="off" spellCheck={false} /></label>
          <label>ns1 IPv4<input value={draft.ns1.ipv4} onChange={(event) => updateNs('ns1', 'ipv4', event.target.value)} required placeholder="203.0.113.10" autoComplete="off" spellCheck={false} /></label>
          <label>ns1 IPv6<input value={draft.ns1.ipv6} onChange={(event) => updateNs('ns1', 'ipv6', event.target.value)} placeholder="2001:db8::10" autoComplete="off" spellCheck={false} /></label>
          <div><ChoiceButtons label="ns1 servis konumu" value={draft.ns1.local} disabled options={[{ value: true, label: 'Bu sunucu' }]} onChange={() => {}} /></div>
          <label>ns2 hostname<input value={draft.ns2.hostname} onChange={(event) => updateNs('ns2', 'hostname', event.target.value)} required placeholder="ns2.example.com" autoComplete="off" spellCheck={false} /></label>
          <label>ns2 IPv4<input value={draft.ns2.ipv4} onChange={(event) => updateNs('ns2', 'ipv4', event.target.value)} required placeholder="203.0.113.11" autoComplete="off" spellCheck={false} /></label>
          <label>ns2 IPv6<input value={draft.ns2.ipv6} onChange={(event) => updateNs('ns2', 'ipv6', event.target.value)} placeholder="2001:db8::11" autoComplete="off" spellCheck={false} /></label>
          <div><ChoiceButtons label="ns2 servis konumu" value={draft.ns2.local} options={[{ value: true, label: 'Bu sunucu' }, { value: false, label: 'Harici secondary' }]} onChange={(value) => updateNs('ns2', 'local', value)} /></div>
        </div>
        <h3 className="network-dns-subheading">SOA politikası</h3>
        <div className="ws-form-grid">
          <label>Responsible name<input value={draft.soa.rname} onChange={(event) => updateSoa('rname', event.target.value)} required placeholder="hostmaster.example.com" autoComplete="off" spellCheck={false} /></label>
          <label>TTL<input type="number" value={draft.soa.ttl} min="60" max="86400" onChange={(event) => updateSoa('ttl', event.target.value)} required /></label>
          <label>Refresh<input type="number" value={draft.soa.refresh} min="300" max="86400" onChange={(event) => updateSoa('refresh', event.target.value)} required /></label>
          <label>Retry<input type="number" value={draft.soa.retry} min="60" max="86400" onChange={(event) => updateSoa('retry', event.target.value)} required /></label>
          <label>Expire<input type="number" value={draft.soa.expire} min="86400" max="2419200" onChange={(event) => updateSoa('expire', event.target.value)} required /></label>
          <label>Negative minimum<input type="number" value={draft.soa.minimum} min="60" max="86400" onChange={(event) => updateSoa('minimum', event.target.value)} required /></label>
        </div>
        <h3 className="network-dns-subheading">Zone varsayımları</h3>
        <ChoiceButtons label="Yeni zonelarda DNSSEC varsayılanı" value={draft.dnssecDefault} options={[{ value: false, label: 'Kapalı' }, { value: true, label: 'Açık' }]} onChange={(value) => update('dnssecDefault', value)} />
        <label>Secondary DNS transfer hedefleri<textarea rows={4} value={draft.secondaryDns} onChange={(event) => update('secondaryDns', event.target.value)} placeholder="Her satıra bir IPv4/IPv6 adresi" spellCheck={false} /></label>
        <footer className="ws-modal-footer"><Button disabled={busy} onClick={onClose}>Vazgeç</Button><Button variant="primary" disabled={busy} type="submit">{busy ? 'Kontrol ediliyor…' : 'Değişikliği önizle'}</Button></footer>
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
    event.preventDefault();
    if (busy || !identity) return;
    setBusy(true); setError(null); setInspection(null);
    try { setInspection(await inspectDnsDelegation(server.id, domain)); }
    catch (failure) { if (failure.name !== 'AbortError') setError(failure.message); }
    finally { setBusy(false); }
  }
  const presentation = delegationPresentation(inspection?.status);
  return <Section title="Registrar / delegation" description="Parent NS delegation ve nameserver adresleri public DNS üzerinden gözlenir; YunPanel registrar hesabınızda otomatik değişiklik yapmaz." actions={inspection && <Badge state={presentation.state}>{presentation.label}</Badge>}>
    <div className="ws-section-body"><ErrorNotice error={error} />{identity ? <form className="network-dns-inline" onSubmit={inspect}><label>Kontrol edilecek root domain<input value={domain} onChange={(event) => setDomain(event.target.value)} placeholder="example.com" required spellCheck={false} /></label><Button type="submit" icon="refresh" disabled={busy}>{busy ? 'Kontrol ediliyor…' : 'Delegation kontrol et'}</Button></form> : <p className="ws-muted">Delegation kontrolü için önce DNS identity yapılandırın.</p>}
      {inspection && <><KeyValues items={[
        ['Beklenen NS', inspection.delegation?.expected?.join(', ')], ['Gözlenen NS', inspection.delegation?.observed?.join(', ') || 'Yok'],
        ['Eksik NS', inspection.delegation?.missing?.join(', ') || 'Yok'], ['Ek NS', inspection.delegation?.extra?.join(', ') || 'Yok'],
        ['Son kontrol', inspection.checkedAt],
      ]} /><div className="network-dns-ns-list">{inspection.nameservers?.map((ns) => <article key={ns.role}><div><strong>{ns.role.toUpperCase()} · {ns.hostname}</strong><span>{ns.inBailiwick ? 'Glue gerekebilir' : 'Harici nameserver'}</span></div><Badge state={ns.ready ? 'active' : ns.transientFailure ? 'warning' : 'pending'}>{ns.ready ? 'Adres hazır' : 'Kontrol gerekli'}</Badge><small>Beklenen IPv4: {ns.configuredIpv4} · Gözlenen: {ns.observedIpv4?.join(', ') || 'yok'}</small>{ns.configuredIpv6 && <small>Beklenen IPv6: {ns.configuredIpv6} · Gözlenen: {ns.observedIpv6?.join(', ') || 'yok'}</small>}</article>)}</div><div className="network-dns-registrar"><strong>Registrar talimatı</strong>{inspection.registrarInstructions?.nameservers?.map((ns) => <div key={ns.role}><code>{ns.hostname}</code><span>IPv4 {ns.ipv4}{ns.ipv6 ? ` · IPv6 ${ns.ipv6}` : ''}{ns.glueRequiredForThisDomain ? ' · glue/host record gerekli' : ''}</span></div>)}</div></>}
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
  const authoritativeState = authoritativePresentation(authoritative);
  const publicState = publicReachabilityPresentation(authoritative);
  const identityForDialog = identity ?? { serverId: server.id };

  return <>
    <Section title="Network / Authoritative DNS" description="PowerDNS, ns1/ns2 ve SOA kimliği. Sunucu hostname authority değişmez." actions={<div className="ws-actions"><Button icon="refresh" disabled={loading || busy} onClick={refresh}>Yenile</Button>{canManage && <Button variant="primary" disabled={busy} onClick={() => setIdentityDialog(true)}>{identity ? 'DNS kimliğini düzenle' : 'DNS kimliğini yapılandır'}</Button>}</div>}>
      <div className="ws-section-body"><ErrorNotice error={error} />{loading && !identity ? <div className="ws-loading" role="status"><span className="ws-spinner" />DNS durumu yükleniyor…</div> : identity ? <><KeyValues items={[
        ['Sunucu hostname', server.hostname ?? server.name ?? '—'], ['DNS identity revision', identity.revision],
        ['Public IPv4', identity.settings.publicIpv4], ['Public IPv6', identity.settings.publicIpv6 ?? 'Yok'],
        ['ns1', `${identity.settings.ns1.hostname} · ${identity.settings.ns1.ipv4}`], ['ns2', `${identity.settings.ns2.hostname} · ${identity.settings.ns2.ipv4}`],
        ['SOA responsible name', identity.settings.soa.rname], ['Yeni zone DNSSEC default', identity.settings.dnssecDefault ? 'Açık' : 'Kapalı'],
        ['Secondary transfer targets', identity.settings.secondaryDns?.join(', ') || 'Yok'],
      ]} /><WarningList warnings={identity.warnings} /></> : <EmptyState title="Authoritative DNS kimliği yapılandırılmamış" detail="ns1/ns2, public IP ve SOA bilgileri kaydedilmeden PowerDNS uygulanmaz." icon="globe" />}</div>
    </Section>
    <div className="ws-equal-columns"><Section title="PowerDNS local / public health" description="Local API/socket health ile internetten UDP/TCP 53 erişilebilirliği ayrı evidence kaynaklarıdır." actions={authoritative && <div className="ws-actions"><Badge state={authoritativeState.state}>{authoritativeState.label}</Badge><Badge state={publicState.state}>{publicState.label}</Badge></div>}><div className="ws-section-body">{identity ? <><KeyValues items={[
      ['Configured', authoritative?.configured ? 'Evet' : 'Hayır'], ['Secret', authoritative?.secretConfigured ? 'Hazır' : 'Eksik'],
      ['Local UDP/53', authoritative?.host?.sockets?.udp53 === true ? 'Hazır' : 'Doğrulanmadı'], ['Local TCP/53', authoritative?.host?.sockets?.tcp53 === true ? 'Hazır' : 'Doğrulanmadı'],
      ['Recursive resolver', authoritative?.host?.sockets?.recursive === false ? 'Kapalı' : 'Doğrulanmadı'],
      ['Public UDP/53', reachabilityValue(authoritative?.publicReachability?.udp53)], ['Public TCP/53', reachabilityValue(authoritative?.publicReachability?.tcp53)],
      ['Public probe vantage', authoritative?.publicReachability?.vantage ?? 'Yapılandırılmadı'], ['Overall authoritative ready', authoritative?.overallReady ? 'Evet' : 'Hayır'],
    ]} /><div className="ws-notice ws-notice-warn"><div><strong>Public reachability ayrı kapı</strong><p>{authoritative?.publicReachability?.status === 'unverified' ? 'Harici vantage-point probe yapılandırılmadığı için internetten UDP/TCP 53 erişimi doğrulanmadı. Local health bu alanı yeşile çeviremez.' : authoritative?.publicReachability?.status === 'unverifiable' ? `Harici DNS erişimi doğrulanamadı: ${authoritative.publicReachability.reason ?? 'probe hatası'}.` : authoritative?.publicReachability?.status === 'unreachable' ? 'Harici vantage point en az bir DNS protokolünde 53 portuna erişemedi.' : 'Local ve public readiness ayrı izlenir.'}</p></div></div>{canManage && <Button variant="primary" disabled={busy} onClick={preparePowerDns}>{authoritative?.localReady ? 'PowerDNS’i yeniden önizle' : 'PowerDNS kurulumunu önizle'}</Button>}</> : <p className="ws-muted">Önce authoritative DNS identity yapılandırılmalı.</p>}</div></Section><DelegationPanel server={server} identity={identity} defaultDomain={defaultDomain} /></div>
    {identityDialog && <IdentityDialog current={identityForDialog} onClose={() => setIdentityDialog(false)} onApplied={async () => { setIdentityDialog(false); await refresh(); }} />}
    {authoritativePreview && <ConfirmDialog title="PowerDNS authoritative uygula" message={`Paket/config/backend işlemleri uygulanacak. API ${authoritativePreview.api?.address ?? '127.0.0.1'}:${authoritativePreview.api?.port ?? 8081} üzerinde loopback-only kalır; mevcut zone'lar otomatik template sync edilmez.`} confirmation={authoritativePreview.confirmation} busy={busy} error={error} onCancel={() => setAuthoritativePreview(null)} onConfirm={applyPowerDns} confirmLabel="PowerDNS’i uygula" />}
  </>;
}
