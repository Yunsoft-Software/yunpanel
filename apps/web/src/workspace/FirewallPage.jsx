import { useCallback, useEffect, useState } from 'react';
import {
  Badge,
  Button,
  ConfirmDialog,
  Icon,
  PageHeading,
  Section,
} from './PanelKit.jsx';
import {
  fetchFirewallStatus,
  fetchFirewallPorts,
  addFirewallPortRule,
  removeFirewallPortRule,
  fetchServiceProfiles,
  updateServiceProfiles,
  scanFirewallPort,
  fetchCrowdsecBans,
  addCrowdsecBan,
  removeCrowdsecBan,
} from './firewall-client.js';
import {
  formatPortReachability,
  formatServiceProfileLabel,
  formatProviderFirewallNotice,
  isSpecialPortLocked,
  checkPortProfileAllowed,
  MAIL_PORTS,
  DNS_PORTS,
} from './firewall-model.js';

export default function FirewallPage() {
  const [statusData, setStatusData] = useState(null);
  const [portsData, setPortsData] = useState(null);
  const [profilesData, setProfilesData] = useState(null);
  const [bansData, setBansData] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const [actionBusy, setActionBusy] = useState(false);

  // Filter state
  const [filterMode, setFilterMode] = useState('all'); // all, listening, allowed, reachable

  // Form states: Add Port
  const [newPort, setNewPort] = useState('');
  const [newProto, setNewProto] = useState('tcp');
  const [newSource, setNewSource] = useState('0.0.0.0/0');
  const [newComment, setNewComment] = useState('');
  const [portError, setPortError] = useState(null);

  // Form states: Scan
  const [scanHost, setScanHost] = useState('127.0.0.1');
  const [scanPort, setScanPort] = useState('22');
  const [scanResult, setScanResult] = useState(null);
  const [scanBusy, setScanBusy] = useState(false);
  const [scanError, setScanError] = useState(null);

  // Form states: Ban
  const [banIp, setBanIp] = useState('');
  const [banDuration, setBanDuration] = useState('4h');
  const [banReason, setBanReason] = useState('Manuel engelleme');
  const [banError, setBanError] = useState(null);

  // Delete modal state
  const [deleteCandidate, setDeleteCandidate] = useState(null);

  const loadAll = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const [st, pt, pr, bn] = await Promise.all([
        fetchFirewallStatus().catch(() => null),
        fetchFirewallPorts().catch(() => null),
        fetchServiceProfiles().catch(() => null),
        fetchCrowdsecBans().catch(() => []),
      ]);
      setStatusData(st);
      setPortsData(pt);
      setProfilesData(pr?.serviceProfiles ?? pr);
      setBansData(Array.isArray(bn) ? bn : []);
    } catch (err) {
      setError(err.message || 'Firewall verileri yüklenirken hata oluştu.');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    loadAll();
  }, [loadAll]);

  // Handle service profile toggle
  async function handleToggleProfile(profileKey) {
    if (actionBusy || !profilesData) return;
    const current = Boolean(profilesData[profileKey]);
    const nextVal = !current;
    setActionBusy(true);
    setError(null);
    try {
      await updateServiceProfiles({
        profiles: { [profileKey]: nextVal },
      });
      await loadAll();
    } catch (err) {
      setError(err.message || 'Servis profili güncellenemedi.');
    } finally {
      setActionBusy(false);
    }
  }

  // Handle add port rule
  async function handleAddPort(e) {
    e.preventDefault();
    setPortError(null);
    const p = Number(newPort);
    if (!Number.isInteger(p) || p < 1 || p > 65535) {
      setPortError('Geçerli bir port numarası giriniz (1-65535).');
      return;
    }

    const check = checkPortProfileAllowed(p, profilesData || {});
    if (!check.allowed) {
      setPortError(check.reason);
      return;
    }

    setActionBusy(true);
    try {
      await addFirewallPortRule({
        port: p,
        protocol: newProto,
        source: newSource.trim() || '0.0.0.0/0',
      });
      setNewPort('');
      setNewComment('');
      await loadAll();
    } catch (err) {
      setPortError(err.message || 'Port kuralı eklenemedi.');
    } finally {
      setActionBusy(false);
    }
  }

  // Handle remove port rule
  async function handleConfirmDeletePort() {
    if (!deleteCandidate) return;
    setActionBusy(true);
    try {
      await removeFirewallPortRule({
        port: deleteCandidate.port,
        protocol: deleteCandidate.protocol,
      });
      setDeleteCandidate(null);
      await loadAll();
    } catch (err) {
      setError(err.message || 'Port kuralı silinemedi.');
    } finally {
      setActionBusy(false);
    }
  }

  // Handle scan
  async function handleRunScan(e) {
    e.preventDefault();
    setScanBusy(true);
    setScanError(null);
    setScanResult(null);
    try {
      const res = await scanFirewallPort({
        host: scanHost.trim(),
        port: Number(scanPort),
      });
      setScanResult(res);
    } catch (err) {
      setScanError(err.message || 'Port taraması başarısız oldu.');
    } finally {
      setScanBusy(false);
    }
  }

  // Handle ban
  async function handleAddBan(e) {
    e.preventDefault();
    setBanError(null);
    if (!banIp.trim()) {
      setBanError('IP adresi gereklidir.');
      return;
    }
    setActionBusy(true);
    try {
      await addCrowdsecBan({
        ip: banIp.trim(),
        duration: banDuration,
        reason: banReason.trim(),
      });
      setBanIp('');
      await loadAll();
    } catch (err) {
      setBanError(err.message || 'Ban eklenemedi.');
    } finally {
      setActionBusy(false);
    }
  }

  // Handle unban
  async function handleRemoveBan(item) {
    setActionBusy(true);
    try {
      await removeCrowdsecBan({ id: item.id, ip: item.ip });
      await loadAll();
    } catch (err) {
      setError(err.message || 'Ban kaldırılamadı.');
    } finally {
      setActionBusy(false);
    }
  }

  // Port filtering
  const allPorts = portsData?.ports || [];
  const filteredPorts = allPorts.filter((p) => {
    if (filterMode === 'listening') return p.isListening;
    if (filterMode === 'allowed') return p.isFirewallAllowed;
    if (filterMode === 'reachable') return p.isExternallyReachable;
    return true;
  });

  const providerNotice = formatProviderFirewallNotice(portsData?.providerFirewall || statusData?.providerFirewall);
  const activeProfiles = profilesData || { system: true, web: true, localMail: false, authoritativeDns: false };

  return (
    <div className="ws-firewall-page">
      <PageHeading
        title="Güvenlik Duvarı ve Port Yönetimi"
        description="Plesk yerleşiminde gerçek nftables firewall durumu, servis profilleri, dinleyen portlar ve CrowdSec ban yönetimi."
        actions={
          <Button icon="refresh" onClick={loadAll} disabled={loading || actionBusy}>
            Yenile
          </Button>
        }
      />

      {error && (
        <div className="ws-notice ws-notice-error" style={{ marginBottom: '1.5rem', padding: '1rem', borderLeft: '4px solid var(--ws-danger)', backgroundColor: 'var(--ws-danger-soft)', color: 'var(--ws-danger)', borderRadius: '4px' }}>
          <strong>Hata:</strong> {error}
        </div>
      )}

      {/* Cloud / Provider Firewall Advisory Box */}
      <div className="ws-notice ws-notice-warning" style={{ marginBottom: '1.5rem', padding: '1rem', borderLeft: '4px solid var(--ws-warning)', backgroundColor: 'var(--ws-warning-soft)', color: 'var(--ws-warning)', borderRadius: '4px' }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: '0.5rem', fontWeight: 600 }}>
          <Icon name="shield" size={18} />
          <span>Cloud / Sağlayıcı Güvenlik Duvarı Durumu: Bilinmiyor (Unknown)</span>
        </div>
        <p style={{ marginTop: '0.5rem', marginBottom: 0, fontSize: '0.9rem', lineHeight: '1.4' }}>
          {providerNotice.advisory}
        </p>
      </div>

      {/* Genel Durum & Nftables / CrowdSec Özeti */}
      <Section title="Genel Güvenlik ve Firewall Durumu">
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(220px, 1fr))', gap: '1rem', marginBottom: '1rem' }}>
          <div style={{ padding: '1rem', background: 'var(--ws-surface-subtle)', border: '1px solid var(--ws-border)', borderRadius: '6px' }}>
            <div style={{ fontSize: '0.8rem', color: 'var(--ws-muted)', textTransform: 'uppercase', fontWeight: 600 }}>Firewall Durumu</div>
            <div style={{ marginTop: '0.4rem', display: 'flex', alignItems: 'center', gap: '0.5rem' }}>
              <Badge state={statusData?.status === 'active' ? 'ready' : (statusData?.status === 'error' ? 'error' : 'stale')}>
                {statusData?.status === 'active' ? 'Aktif (nftables)' : (statusData?.status ?? 'Yükleniyor')}
              </Badge>
            </div>
            <div style={{ fontSize: '0.8rem', color: 'var(--ws-muted)', marginTop: '0.4rem' }}>
              Tablo: {statusData?.kernelRules?.hasYunpanelTable ? 'inet yunpanel yüklü' : 'Standart'}
            </div>
          </div>

          <div style={{ padding: '1rem', background: 'var(--ws-surface-subtle)', border: '1px solid var(--ws-border)', borderRadius: '6px' }}>
            <div style={{ fontSize: '0.8rem', color: 'var(--ws-muted)', textTransform: 'uppercase', fontWeight: 600 }}>Açılış Kalıcılığı (Boot)</div>
            <div style={{ marginTop: '0.4rem' }}>
              <Badge state={statusData?.bootPersistence?.active ? 'ready' : 'stale'}>
                {statusData?.bootPersistence?.active ? 'nftables.service aktif' : 'Pasif'}
              </Badge>
            </div>
            <div style={{ fontSize: '0.8rem', color: 'var(--ws-muted)', marginTop: '0.4rem' }}>
              Sistemd durumu: {statusData?.bootPersistence?.enabled ? 'Etkinleştirildi' : 'Devre dışı'}
            </div>
          </div>

          <div style={{ padding: '1rem', background: 'var(--ws-surface-subtle)', border: '1px solid var(--ws-border)', borderRadius: '6px' }}>
            <div style={{ fontSize: '0.8rem', color: 'var(--ws-muted)', textTransform: 'uppercase', fontWeight: 600 }}>Docker Birlikte Yaşama</div>
            <div style={{ marginTop: '0.4rem' }}>
              <Badge state="ready">Korunuyor</Badge>
            </div>
            <div style={{ fontSize: '0.8rem', color: 'var(--ws-muted)', marginTop: '0.4rem' }}>
              Docker bridge ve NAT zincirleri korunur
            </div>
          </div>

          <div style={{ padding: '1rem', background: 'var(--ws-surface-subtle)', border: '1px solid var(--ws-border)', borderRadius: '6px' }}>
            <div style={{ fontSize: '0.8rem', color: 'var(--ws-muted)', textTransform: 'uppercase', fontWeight: 600 }}>CrowdSec Bouncer</div>
            <div style={{ marginTop: '0.4rem' }}>
              <Badge state={statusData?.crowdsec?.bouncerActive ? 'ready' : 'stale'}>
                {statusData?.crowdsec?.bouncerActive ? 'Bouncer Aktif' : 'Bouncer Pasif'}
              </Badge>
            </div>
            <div style={{ fontSize: '0.8rem', color: 'var(--ws-muted)', marginTop: '0.4rem' }}>
              Aktif Engellemeler: {bansData.length} IP
            </div>
          </div>
        </div>

        {portsData?.summary && (
          <div style={{ display: 'flex', gap: '1.5rem', flexWrap: 'wrap', padding: '0.75rem 1rem', background: 'var(--ws-surface-subtle)', borderRadius: '6px', fontSize: '0.875rem' }}>
            <span><strong>Dinleyen Portlar:</strong> {portsData.summary.totalListeningPorts}</span>
            <span><strong>Firewall İzinlileri:</strong> {portsData.summary.totalFirewallAllowedPorts}</span>
            <span><strong>Dışarıdan Erişilebilir:</strong> {portsData.summary.totalExternallyReachablePorts}</span>
            <span style={{ marginLeft: 'auto', color: 'var(--ws-muted)' }}>
              Son Doğrulama: {new Date(portsData.summary.lastVerifiedAt).toLocaleTimeString('tr-TR')}
            </span>
          </div>
        )}
      </Section>

      {/* Servis Profilleri (Service Profiles) */}
      <Section
        title="Sunucu Servis Profilleri"
        description="Local-mail ve authoritative-DNS servis profilleri etkin olmadığında gereksiz portların açılması engellenir."
      >
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(280px, 1fr))', gap: '1rem' }}>
          {/* Sistem / SSH */}
          <div style={{ padding: '1rem', border: '1px solid var(--ws-border)', borderRadius: '6px', background: 'var(--ws-surface)' }}>
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
              <strong>Sistem / SSH</strong>
              <Badge state="ready">Zorunlu / Korumalı</Badge>
            </div>
            <p style={{ fontSize: '0.85rem', color: 'var(--ws-muted)', margin: '0.5rem 0' }}>
              SSH bağlantı portu (22). Kilitlenmeye karşı korumalıdır, kaldırılamaz.
            </p>
          </div>

          {/* Web */}
          <div style={{ padding: '1rem', border: '1px solid var(--ws-border)', borderRadius: '6px', background: 'var(--ws-surface)' }}>
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
              <strong>Web Hizmetleri</strong>
              <Badge state="ready">Aktif</Badge>
            </div>
            <p style={{ fontSize: '0.85rem', color: 'var(--ws-muted)', margin: '0.5rem 0' }}>
              HTTP (80) ve HTTPS (443) web trafiği.
            </p>
          </div>

          {/* Local Mail */}
          <div style={{ padding: '1rem', border: '1px solid var(--ws-border)', borderRadius: '6px', background: 'var(--ws-surface)' }}>
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
              <strong>Yerel E-Posta (Local Mail)</strong>
              <Badge state={activeProfiles.localMail ? 'ready' : 'stale'}>
                {activeProfiles.localMail ? 'Etkin' : 'Devre Dışı'}
              </Badge>
            </div>
            <p style={{ fontSize: '0.85rem', color: 'var(--ws-muted)', margin: '0.5rem 0' }}>
              SMTP, IMAP, POP3 portları (25, 143, 465, 587, 993). Pasifken bu portlar açılamaz.
            </p>
            <Button
              variant={activeProfiles.localMail ? 'secondary' : 'primary'}
              disabled={actionBusy}
              onClick={() => handleToggleProfile('localMail')}
            >
              {activeProfiles.localMail ? 'Profili Devre Dışı Bırak' : 'Profili Etkinleştir'}
            </Button>
          </div>

          {/* Authoritative DNS */}
          <div style={{ padding: '1rem', border: '1px solid var(--ws-border)', borderRadius: '6px', background: 'var(--ws-surface)' }}>
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
              <strong>Yetkili DNS (Authoritative DNS)</strong>
              <Badge state={activeProfiles.authoritativeDns ? 'ready' : 'stale'}>
                {activeProfiles.authoritativeDns ? 'Etkin' : 'Devre Dışı'}
              </Badge>
            </div>
            <p style={{ fontSize: '0.85rem', color: 'var(--ws-muted)', margin: '0.5rem 0' }}>
              DNS portu (53 TCP/UDP). Pasifken DNS portu açılamaz.
            </p>
            <Button
              variant={activeProfiles.authoritativeDns ? 'secondary' : 'primary'}
              disabled={actionBusy}
              onClick={() => handleToggleProfile('authoritativeDns')}
            >
              {activeProfiles.authoritativeDns ? 'Profili Devre Dışı Bırak' : 'Profili Etkinleştir'}
            </Button>
          </div>
        </div>
      </Section>

      {/* Port ve Kural Listesi */}
      <Section
        title="Port ve Güvenlik Duvarı Kuralları"
        description="Dinleyen soketler, firewall izinleri ve dış erişilebilirlik ayrımı."
        actions={
          <div style={{ display: 'flex', gap: '0.5rem' }}>
            <Button
              variant={filterMode === 'all' ? 'primary' : 'secondary'}
              onClick={() => setFilterMode('all')}
            >
              Tümü ({allPorts.length})
            </Button>
            <Button
              variant={filterMode === 'listening' ? 'primary' : 'secondary'}
              onClick={() => setFilterMode('listening')}
            >
              Dinleyenler
            </Button>
            <Button
              variant={filterMode === 'allowed' ? 'primary' : 'secondary'}
              onClick={() => setFilterMode('allowed')}
            >
              Firewall İzinlileri
            </Button>
            <Button
              variant={filterMode === 'reachable' ? 'primary' : 'secondary'}
              onClick={() => setFilterMode('reachable')}
            >
              Dış Erişilebilir
            </Button>
          </div>
        }
      >
        <div className="ws-table-scroll">
          <table className="ws-table" style={{ width: '100%', textAlign: 'left', borderCollapse: 'collapse' }}>
            <thead>
              <tr style={{ borderBottom: '2px solid var(--ws-border)', color: 'var(--ws-muted)', fontSize: '0.85rem' }}>
                <th style={{ padding: '0.75rem' }}>Port / Protokol</th>
                <th style={{ padding: '0.75rem' }}>Dinleyen Adres / Proses</th>
                <th style={{ padding: '0.75rem' }}>İzin Politikası</th>
                <th style={{ padding: '0.75rem' }}>Kaynak IP/CIDR</th>
                <th style={{ padding: '0.75rem' }}>Servis Profili</th>
                <th style={{ padding: '0.75rem' }}>Dinliyor?</th>
                <th style={{ padding: '0.75rem' }}>Firewall İzinli?</th>
                <th style={{ padding: '0.75rem' }}>Dış Erişilebilir?</th>
                <th style={{ padding: '0.75rem' }}>İşlem</th>
              </tr>
            </thead>
            <tbody>
              {filteredPorts.length === 0 ? (
                <tr>
                  <td colSpan={9} style={{ padding: '1.5rem', textAlign: 'center', color: 'var(--ws-muted)' }}>
                    Bu filtreye uygun port kuralı bulunamadı.
                  </td>
                </tr>
              ) : (
                filteredPorts.map((p) => {
                  const reach = formatPortReachability(p);
                  const isLocked = isSpecialPortLocked(p.port, p.serviceProfile);

                  return (
                    <tr key={`${p.protocol}:${p.port}`} style={{ borderBottom: '1px solid var(--ws-border)' }}>
                      <td style={{ padding: '0.75rem', fontWeight: 600 }}>
                        {p.port} / {String(p.protocol).toUpperCase()}
                      </td>
                      <td style={{ padding: '0.75rem', fontSize: '0.875rem' }}>
                        {p.isListening ? (
                          <span>
                            {p.listenAddress} {p.process ? `(${p.process})` : ''}
                          </span>
                        ) : (
                          <span style={{ color: 'var(--ws-muted)' }}>Dinlemiyor</span>
                        )}
                      </td>
                      <td style={{ padding: '0.75rem' }}>
                        <span style={{ fontWeight: 600, color: p.isFirewallAllowed ? 'var(--ws-success)' : 'var(--ws-danger)' }}>
                          {String(p.policy || 'ALLOW').toUpperCase()}
                        </span>
                      </td>
                      <td style={{ padding: '0.75rem', fontSize: '0.85rem' }}>
                        {p.sourceCidr || p.source || '0.0.0.0/0'}
                      </td>
                      <td style={{ padding: '0.75rem', fontSize: '0.85rem' }}>
                        {formatServiceProfileLabel(p.serviceProfile)}
                      </td>
                      <td style={{ padding: '0.75rem' }}>
                        {p.isListening ? <Badge state="ready">Evet</Badge> : <Badge state="stale">Hayır</Badge>}
                      </td>
                      <td style={{ padding: '0.75rem' }}>
                        {p.isFirewallAllowed ? <Badge state="ready">Evet</Badge> : <Badge state="error">Hayır</Badge>}
                      </td>
                      <td style={{ padding: '0.75rem' }}>
                        <Badge state={reach.badgeState}>{reach.label}</Badge>
                      </td>
                      <td style={{ padding: '0.75rem' }}>
                        {isLocked ? (
                          <span style={{ fontSize: '0.8rem', color: 'var(--ws-muted)' }}>Kilitli</span>
                        ) : p.isFirewallAllowed ? (
                          <Button
                            variant="secondary"
                            onClick={() => setDeleteCandidate(p)}
                            disabled={actionBusy}
                            style={{ fontSize: '0.8rem', padding: '0.2rem 0.5rem' }}
                          >
                            Kuralı Sil
                          </Button>
                        ) : (
                          <span style={{ fontSize: '0.8rem', color: 'var(--ws-muted)' }}>-</span>
                        )}
                      </td>
                    </tr>
                  );
                })
              )}
            </tbody>
          </table>
        </div>

        {/* Yeni Port Kuralı Ekle Formu */}
        <div style={{ marginTop: '1.5rem', padding: '1rem', background: 'var(--ws-surface-subtle)', border: '1px solid var(--ws-border)', borderRadius: '6px' }}>
          <h4 style={{ margin: '0 0 1rem 0' }}>Yeni Özel Port Kuralı Ekle</h4>
          {portError && (
            <div style={{ color: 'var(--ws-danger)', marginBottom: '0.75rem', fontSize: '0.875rem' }}>
              <strong>Uyarı:</strong> {portError}
            </div>
          )}
          <form onSubmit={handleAddPort} style={{ display: 'flex', gap: '0.75rem', flexWrap: 'wrap', alignItems: 'flex-end' }}>
            <div>
              <label style={{ display: 'block', fontSize: '0.8rem', color: 'var(--ws-muted)', marginBottom: '0.25rem' }}>
                Port Numarası
              </label>
              <input
                type="number"
                min="1"
                max="65535"
                placeholder="Örn. 8080"
                value={newPort}
                onChange={(e) => setNewPort(e.target.value)}
                required
                style={{ padding: '0.4rem 0.6rem', border: '1px solid var(--ws-control-border)', borderRadius: '4px', width: '120px' }}
              />
            </div>

            <div>
              <label style={{ display: 'block', fontSize: '0.8rem', color: 'var(--ws-muted)', marginBottom: '0.25rem' }}>
                Protokol
              </label>
              <select
                value={newProto}
                onChange={(e) => setNewProto(e.target.value)}
                style={{ padding: '0.4rem 0.6rem', border: '1px solid var(--ws-control-border)', borderRadius: '4px' }}
              >
                <option value="tcp">TCP</option>
                <option value="udp">UDP</option>
                <option value="both">TCP & UDP</option>
              </select>
            </div>

            <div>
              <label style={{ display: 'block', fontSize: '0.8rem', color: 'var(--ws-muted)', marginBottom: '0.25rem' }}>
                Kaynak IP / CIDR
              </label>
              <input
                type="text"
                placeholder="0.0.0.0/0"
                value={newSource}
                onChange={(e) => setNewSource(e.target.value)}
                style={{ padding: '0.4rem 0.6rem', border: '1px solid var(--ws-control-border)', borderRadius: '4px', width: '160px' }}
              />
            </div>

            <div>
              <label style={{ display: 'block', fontSize: '0.8rem', color: 'var(--ws-muted)', marginBottom: '0.25rem' }}>
                Açıklama
              </label>
              <input
                type="text"
                placeholder="Özel servis açıklaması"
                value={newComment}
                onChange={(e) => setNewComment(e.target.value)}
                style={{ padding: '0.4rem 0.6rem', border: '1px solid var(--ws-control-border)', borderRadius: '4px', width: '200px' }}
              />
            </div>

            <Button type="submit" variant="primary" disabled={actionBusy}>
              Port Kuralını Ekle
            </Button>
          </form>
        </div>
      </Section>

      {/* Hedef Port Taraması & Doğrulama */}
      <Section
        title="Hedef Port Taraması ve Doğrulama"
        description="Host/port taraması güvenlik kuralı gereği yalnızca izin verilen test hedeflerinde (127.0.0.1, 157.180.11.28, server.cryptoraichu.website) yapılabilir. .44 ve yetkisiz hedefler reddedilir."
      >
        <form onSubmit={handleRunScan} style={{ display: 'flex', gap: '0.75rem', flexWrap: 'wrap', alignItems: 'flex-end', marginBottom: '1rem' }}>
          <div>
            <label style={{ display: 'block', fontSize: '0.8rem', color: 'var(--ws-muted)', marginBottom: '0.25rem' }}>
              Hedef Host / IP
            </label>
            <input
              type="text"
              value={scanHost}
              onChange={(e) => setScanHost(e.target.value)}
              placeholder="127.0.0.1"
              required
              style={{ padding: '0.4rem 0.6rem', border: '1px solid var(--ws-control-border)', borderRadius: '4px', width: '180px' }}
            />
          </div>

          <div>
            <label style={{ display: 'block', fontSize: '0.8rem', color: 'var(--ws-muted)', marginBottom: '0.25rem' }}>
              Port
            </label>
            <input
              type="number"
              min="1"
              max="65535"
              value={scanPort}
              onChange={(e) => setScanPort(e.target.value)}
              required
              style={{ padding: '0.4rem 0.6rem', border: '1px solid var(--ws-control-border)', borderRadius: '4px', width: '100px' }}
            />
          </div>

          <Button type="submit" variant="secondary" disabled={scanBusy}>
            {scanBusy ? 'Taranıyor...' : 'Portu Test Et'}
          </Button>
        </form>

        {scanError && (
          <div style={{ color: 'var(--ws-danger)', fontSize: '0.875rem', marginBottom: '0.5rem' }}>
            <strong>Tarama Hatası:</strong> {scanError}
          </div>
        )}

        {scanResult && (
          <div style={{ padding: '0.75rem 1rem', background: scanResult.reachable ? 'var(--ws-success-soft)' : 'var(--ws-danger-soft)', border: `1px solid ${scanResult.reachable ? 'var(--ws-success)' : 'var(--ws-danger)'}`, borderRadius: '6px', fontSize: '0.875rem' }}>
            <strong>Hedef:</strong> {scanResult.host}:{scanResult.port} |{' '}
            <strong>Durum:</strong> {scanResult.reachable ? 'Bağlantı Başarılı (Erişilebilir)' : 'Erişilemedi (Bağlantı Reddedildi / Zaman Aşımı)'} |{' '}
            <strong>Gecikme (RTT):</strong> {scanResult.rttMs} ms
          </div>
        )}
      </Section>

      {/* CrowdSec Ban & Tehdit Yönetimi */}
      <Section
        title="CrowdSec Tehdit ve Ban Yönetimi"
        description="CrowdSec bouncer ve aktif IP yasakları aynı güvenlik bağlamında yönetilir."
      >
        <div className="ws-table-scroll" style={{ marginBottom: '1rem' }}>
          <table className="ws-table" style={{ width: '100%', textAlign: 'left', borderCollapse: 'collapse' }}>
            <thead>
              <tr style={{ borderBottom: '2px solid var(--ws-border)', color: 'var(--ws-muted)', fontSize: '0.85rem' }}>
                <th style={{ padding: '0.75rem' }}>Engellenen IP</th>
                <th style={{ padding: '0.75rem' }}>Süre</th>
                <th style={{ padding: '0.75rem' }}>Sebep</th>
                <th style={{ padding: '0.75rem' }}>Kaynak</th>
                <th style={{ padding: '0.75rem' }}>Bitiş Zamanı</th>
                <th style={{ padding: '0.75rem' }}>İşlem</th>
              </tr>
            </thead>
            <tbody>
              {bansData.length === 0 ? (
                <tr>
                  <td colSpan={6} style={{ padding: '1rem', textAlign: 'center', color: 'var(--ws-muted)' }}>
                    Şu anda aktif CrowdSec engellemesi bulunmuyor.
                  </td>
                </tr>
              ) : (
                bansData.map((item) => (
                  <tr key={item.id ?? item.ip} style={{ borderBottom: '1px solid var(--ws-border)' }}>
                    <td style={{ padding: '0.75rem', fontWeight: 600 }}>{item.ip}</td>
                    <td style={{ padding: '0.75rem', fontSize: '0.85rem' }}>{item.duration || 'Belirsiz'}</td>
                    <td style={{ padding: '0.75rem', fontSize: '0.85rem' }}>{item.reason || '-'}</td>
                    <td style={{ padding: '0.75rem', fontSize: '0.85rem' }}>{item.origin || 'crowdsec'}</td>
                    <td style={{ padding: '0.75rem', fontSize: '0.85rem' }}>
                      {item.expiresAt ? new Date(item.expiresAt).toLocaleString('tr-TR') : '-'}
                    </td>
                    <td style={{ padding: '0.75rem' }}>
                      <Button
                        variant="secondary"
                        onClick={() => handleRemoveBan(item)}
                        disabled={actionBusy}
                        style={{ fontSize: '0.8rem', padding: '0.2rem 0.5rem' }}
                      >
                        Engeli Kaldır
                      </Button>
                    </td>
                  </tr>
                ))
              )}
            </tbody>
          </table>
        </div>

        {/* Manuel IP Ban Ekle */}
        <div style={{ padding: '1rem', background: 'var(--ws-surface-subtle)', border: '1px solid var(--ws-border)', borderRadius: '6px' }}>
          <h4 style={{ margin: '0 0 1rem 0' }}>Manuel IP Engelleme Ekle</h4>
          {banError && (
            <div style={{ color: 'var(--ws-danger)', marginBottom: '0.75rem', fontSize: '0.875rem' }}>
              <strong>Hata:</strong> {banError}
            </div>
          )}
          <form onSubmit={handleAddBan} style={{ display: 'flex', gap: '0.75rem', flexWrap: 'wrap', alignItems: 'flex-end' }}>
            <div>
              <label style={{ display: 'block', fontSize: '0.8rem', color: 'var(--ws-muted)', marginBottom: '0.25rem' }}>
                IP Adresi
              </label>
              <input
                type="text"
                placeholder="Örn. 198.51.100.25"
                value={banIp}
                onChange={(e) => setBanIp(e.target.value)}
                required
                style={{ padding: '0.4rem 0.6rem', border: '1px solid var(--ws-control-border)', borderRadius: '4px', width: '160px' }}
              />
            </div>

            <div>
              <label style={{ display: 'block', fontSize: '0.8rem', color: 'var(--ws-muted)', marginBottom: '0.25rem' }}>
                Engelleme Süresi
              </label>
              <select
                value={banDuration}
                onChange={(e) => setBanDuration(e.target.value)}
                style={{ padding: '0.4rem 0.6rem', border: '1px solid var(--ws-control-border)', borderRadius: '4px' }}
              >
                <option value="1h">1 Saat</option>
                <option value="4h">4 Saat</option>
                <option value="24h">24 Saat</option>
                <option value="7d">7 Gün</option>
              </select>
            </div>

            <div>
              <label style={{ display: 'block', fontSize: '0.8rem', color: 'var(--ws-muted)', marginBottom: '0.25rem' }}>
                Sebep
              </label>
              <input
                type="text"
                placeholder="Kötü niyetli trafik / brute force"
                value={banReason}
                onChange={(e) => setBanReason(e.target.value)}
                style={{ padding: '0.4rem 0.6rem', border: '1px solid var(--ws-control-border)', borderRadius: '4px', width: '220px' }}
              />
            </div>

            <Button type="submit" variant="secondary" disabled={actionBusy}>
              IP Engelle
            </Button>
          </form>
        </div>
      </Section>

      {/* Delete Port Modal */}
      {deleteCandidate && (
        <ConfirmDialog
          title="Port Kuralını Sil"
          message={`${deleteCandidate.port} / ${String(deleteCandidate.protocol).toUpperCase()} kuralı silinecek ve firewall kapatılacak. Onaylıyor musunuz?`}
          busy={actionBusy}
          onCancel={() => setDeleteCandidate(null)}
          onConfirm={handleConfirmDeletePort}
          confirmLabel="Kuralı Sil"
        />
      )}
    </div>
  );
}
