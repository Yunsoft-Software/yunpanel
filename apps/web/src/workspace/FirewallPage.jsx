import { useCallback, useEffect, useRef, useState } from 'react';
import {
  Badge,
  Button,
  ConfirmDialog,
  ErrorNotice,
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
  createResourceState,
  formatDockerCoexistenceStatus,
  formatFirewallError,
  formatFirewallOverallStatus,
  formatPortReachability,
  formatServiceProfileLabel,
  formatProviderFirewallNotice,
  isFirewallStatusVerified,
  isSpecialPortLocked,
  checkPortProfileAllowed,
  normalizeBansPayload,
  normalizeServiceProfilesPayload,
} from './firewall-model.js';

function SectionLoadError({ title, message, onRetry, disabled = false }) {
  const normalizedTitle = String(title ?? '').trim().replace(/\.$/, '').toLowerCase();
  const normalizedMessage = String(message ?? '').trim().replace(/\.$/, '').toLowerCase();
  const showDetail = Boolean(message) && normalizedMessage !== normalizedTitle;
  return (
    <div
      role="alert"
      className="ws-notice ws-notice-error"
      style={{
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'space-between',
        gap: '1rem',
        flexWrap: 'wrap',
        marginBottom: '1rem',
      }}
    >
      <div style={{ display: 'flex', alignItems: 'center', gap: '0.6rem', flex: '1 1 220px', minWidth: 0 }}>
        <Icon name="alert" size={18} />
        <div>
          <strong>{title}</strong>
          {showDetail && <div style={{ fontSize: '0.875rem', marginTop: '0.2rem' }}>{message}</div>}
        </div>
      </div>
      <Button icon="refresh" onClick={onRetry} disabled={disabled}>
        Yeniden dene
      </Button>
    </div>
  );
}

export default function FirewallPage() {
  const [statusRes, setStatusRes] = useState(() => createResourceState('loading'));
  const [profilesRes, setProfilesRes] = useState(() => createResourceState('loading'));
  const [portsRes, setPortsRes] = useState(() => createResourceState('loading'));
  const [bansRes, setBansRes] = useState(() => createResourceState('loading'));
  const [actionError, setActionError] = useState(null);
  const [actionBusy, setActionBusy] = useState(false);

  // Filter state
  const [filterMode, setFilterMode] = useState('all');

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

  const mountedRef = useRef(true);
  const controllersRef = useRef({
    status: null,
    profiles: null,
    ports: null,
    bans: null,
  });

  useEffect(() => {
    mountedRef.current = true;
    const controllers = controllersRef.current;
    return () => {
      mountedRef.current = false;
      for (const key of Object.keys(controllers)) {
        controllers[key]?.abort();
        controllers[key] = null;
      }
    };
  }, []);

  const startController = useCallback((key) => {
    controllersRef.current[key]?.abort();
    const controller = new AbortController();
    controllersRef.current[key] = controller;
    return controller;
  }, []);

  const loadStatus = useCallback(async () => {
    const controller = startController('status');
    setStatusRes(createResourceState('loading'));
    try {
      const data = await fetchFirewallStatus({ signal: controller.signal });
      if (!mountedRef.current || controller.signal.aborted) return;
      if (!data || typeof data !== 'object' || Array.isArray(data)) {
        setStatusRes(createResourceState('error', null, 'Güvenlik duvarı durumu doğrulanamadı.'));
        return;
      }
      setStatusRes(createResourceState('ready', data, null));
    } catch (err) {
      if (!mountedRef.current || controller.signal.aborted || err?.name === 'AbortError') return;
      setStatusRes(createResourceState('error', null, formatFirewallError(err, 'Güvenlik duvarı durumu alınamadı.')));
    }
  }, [startController]);

  const loadServiceProfiles = useCallback(async () => {
    const controller = startController('profiles');
    setProfilesRes(createResourceState('loading'));
    try {
      const raw = await fetchServiceProfiles({ signal: controller.signal });
      if (!mountedRef.current || controller.signal.aborted) return;
      const normalized = normalizeServiceProfilesPayload(raw);
      if (!normalized) {
        setProfilesRes(createResourceState('error', null, 'Servis profilleri doğrulanamadı.'));
        return;
      }
      setProfilesRes(createResourceState('ready', normalized, null));
    } catch (err) {
      if (!mountedRef.current || controller.signal.aborted || err?.name === 'AbortError') return;
      setProfilesRes(createResourceState('error', null, formatFirewallError(err, 'Servis profilleri alınamadı.')));
    }
  }, [startController]);

  const loadPorts = useCallback(async () => {
    const controller = startController('ports');
    setPortsRes(createResourceState('loading'));
    try {
      const data = await fetchFirewallPorts({ signal: controller.signal });
      if (!mountedRef.current || controller.signal.aborted) return;
      if (!data || typeof data !== 'object' || !Array.isArray(data.ports)) {
        setPortsRes(createResourceState('error', null, 'Port ve güvenlik duvarı kuralları doğrulanamadı.'));
        return;
      }
      setPortsRes(createResourceState('ready', data, null));
    } catch (err) {
      if (!mountedRef.current || controller.signal.aborted || err?.name === 'AbortError') return;
      setPortsRes(createResourceState('error', null, formatFirewallError(err, 'Port ve güvenlik duvarı kuralları alınamadı.')));
    }
  }, [startController]);

  const loadBans = useCallback(async () => {
    const controller = startController('bans');
    setBansRes(createResourceState('loading'));
    try {
      const raw = await fetchCrowdsecBans({ signal: controller.signal });
      if (!mountedRef.current || controller.signal.aborted) return;
      const normalized = normalizeBansPayload(raw);
      if (!normalized) {
        setBansRes(createResourceState('error', null, 'CrowdSec engelleme listesi doğrulanamadı.'));
        return;
      }
      setBansRes(createResourceState('ready', normalized, null));
    } catch (err) {
      if (!mountedRef.current || controller.signal.aborted || err?.name === 'AbortError') return;
      setBansRes(createResourceState('error', null, formatFirewallError(err, 'CrowdSec engelleme listesi alınamadı.')));
    }
  }, [startController]);

  const loadAll = useCallback(async () => {
    setActionError(null);
    await Promise.allSettled([
      loadStatus(),
      loadServiceProfiles(),
      loadPorts(),
      loadBans(),
    ]);
  }, [loadStatus, loadServiceProfiles, loadPorts, loadBans]);

  useEffect(() => {
    void loadAll();
  }, [loadAll]);

  const anyLoading = statusRes.state === 'loading'
    || profilesRes.state === 'loading'
    || portsRes.state === 'loading'
    || bansRes.state === 'loading';
  const allErrored = statusRes.state === 'error'
    && profilesRes.state === 'error'
    && portsRes.state === 'error'
    && bansRes.state === 'error';

  const statusVerified = statusRes.state === 'ready' && isFirewallStatusVerified(statusRes.data);
  const statusUnverified = statusRes.state === 'ready' && !statusVerified;
  const canMutateProfiles = statusVerified && profilesRes.state === 'ready' && !actionBusy;
  const canMutatePorts = statusVerified && portsRes.state === 'ready' && profilesRes.state === 'ready' && !actionBusy;
  const canMutateBans = statusVerified && bansRes.state === 'ready' && !actionBusy;
  const canRunScan = statusVerified && !scanBusy;

  async function handleToggleProfile(profileKey) {
    if (!canMutateProfiles || !profilesRes.data) return;
    const current = Boolean(profilesRes.data[profileKey]);
    const nextVal = !current;
    setActionBusy(true);
    setActionError(null);
    try {
      await updateServiceProfiles({
        profiles: { [profileKey]: nextVal },
      });
      await Promise.allSettled([loadStatus(), loadServiceProfiles(), loadPorts()]);
    } catch (err) {
      setActionError(formatFirewallError(err, 'Servis profili güncellenemedi.'));
    } finally {
      setActionBusy(false);
    }
  }

  async function handleAddPort(e) {
    e.preventDefault();
    if (!canMutatePorts || !profilesRes.data) return;
    setPortError(null);
    const p = Number(newPort);
    if (!Number.isInteger(p) || p < 1 || p > 65535) {
      setPortError('Geçerli bir port numarası giriniz (1-65535).');
      return;
    }

    const check = checkPortProfileAllowed(p, profilesRes.data);
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
      await Promise.allSettled([loadStatus(), loadPorts()]);
    } catch (err) {
      setPortError(formatFirewallError(err, 'Port kuralı eklenemedi.'));
    } finally {
      setActionBusy(false);
    }
  }

  async function handleConfirmDeletePort() {
    if (!deleteCandidate || !canMutatePorts) return;
    setActionBusy(true);
    setActionError(null);
    try {
      await removeFirewallPortRule({
        port: deleteCandidate.port,
        protocol: deleteCandidate.protocol,
      });
      setDeleteCandidate(null);
      await Promise.allSettled([loadStatus(), loadPorts()]);
    } catch (err) {
      setActionError(formatFirewallError(err, 'Port kuralı silinemedi.'));
    } finally {
      setActionBusy(false);
    }
  }

  async function handleRunScan(e) {
    e.preventDefault();
    if (!canRunScan) return;
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
      setScanError(formatFirewallError(err, 'Port taraması başarısız oldu.'));
    } finally {
      setScanBusy(false);
    }
  }

  async function handleAddBan(e) {
    e.preventDefault();
    if (!canMutateBans) return;
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
      await Promise.allSettled([loadStatus(), loadBans()]);
    } catch (err) {
      setBanError(formatFirewallError(err, 'IP engelleme eklenemedi.'));
    } finally {
      setActionBusy(false);
    }
  }

  async function handleRemoveBan(item) {
    if (!canMutateBans) return;
    setActionBusy(true);
    setActionError(null);
    try {
      await removeCrowdsecBan({ id: item.id, ip: item.ip ?? item.value });
      await Promise.allSettled([loadStatus(), loadBans()]);
    } catch (err) {
      setActionError(formatFirewallError(err, 'IP engellemesi kaldırılamadı.'));
    } finally {
      setActionBusy(false);
    }
  }

  const allPorts = portsRes.state === 'ready' ? portsRes.data.ports : [];
  const filteredPorts = allPorts.filter((p) => {
    if (filterMode === 'listening') return p.isListening;
    if (filterMode === 'allowed') return p.isFirewallAllowed;
    if (filterMode === 'reachable') return p.isExternallyReachable;
    return true;
  });

  const providerNotice = formatProviderFirewallNotice(
    portsRes.data?.providerFirewall || statusRes.data?.providerFirewall,
  );
  const overallStatus = statusRes.state === 'ready'
    ? formatFirewallOverallStatus(statusRes.data)
    : null;
  const dockerStatus = statusRes.state === 'ready'
    ? formatDockerCoexistenceStatus(statusRes.data)
    : null;

  return (
    <div className="ws-firewall-page">
      <PageHeading
        title="Güvenlik Duvarı ve Port Yönetimi"
        description="Güvenlik duvarı kuralları, servis profilleri, dinleyen portlar ve IP engellemeleri."
        actions={
          <Button className="ws-icon-btn" icon="refresh" aria-label="Yenile" title="Yenile" onClick={loadAll} disabled={anyLoading || actionBusy} />
        }
      />

      {actionError && (
        <div style={{ marginBottom: '1rem' }}>
          <ErrorNotice error={actionError} />
        </div>
      )}

      {allErrored && (
        <SectionLoadError
          title="Güvenlik duvarı verileri alınamadı"
          message="Sunucu güvenlik duvarı, servis profilleri, port kuralları ve CrowdSec engelleme verilerine ulaşılamadı. Gerçek durum doğrulanmadan değişiklik yapılamaz."
          onRetry={loadAll}
          disabled={actionBusy}
        />
      )}

      {/* Cloud / Provider Firewall Advisory Box */}
      <div className="ws-notice ws-notice-warning ws-firewall-advisory" style={{ marginBottom: '1.25rem', padding: '0.9rem 1rem', borderLeft: '4px solid var(--ws-warning)', backgroundColor: 'var(--ws-warning-soft)', color: 'var(--ws-warning)', borderRadius: '6px', display: 'flex', flexDirection: 'column', alignItems: 'flex-start', gap: '0.35rem' }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: '0.5rem', fontWeight: 600 }}>
          <Icon name="shield" size={18} />
          <span>Cloud / Sağlayıcı Güvenlik Duvarı Durumu: Bilinmiyor</span>
        </div>
        <p style={{ margin: 0, fontSize: '0.875rem', lineHeight: '1.45' }}>
          {providerNotice.advisory}
        </p>
      </div>

      {/* Genel Durum & Nftables / CrowdSec Özeti */}
      <Section title="Genel Güvenlik ve Firewall Durumu">
        <div className="ws-section-body">
          {statusRes.state === 'error' && (
            <SectionLoadError
              title="Güvenlik duvarı durumu alınamadı"
              message={statusRes.error}
              onRetry={loadStatus}
              disabled={actionBusy}
            />
          )}

          {statusUnverified && (
            <SectionLoadError
              title="Güvenlik duvarı durumu doğrulanamadı"
              message="Sunucu güvenlik duvarı durumu doğrulanamadığı için değişiklik kontrolleri güvenlik amacıyla devre dışı bırakıldı."
              onRetry={loadStatus}
              disabled={actionBusy}
            />
          )}

          <div className="ws-firewall-status-grid">
            <div data-testid="firewall-card-status" className="ws-firewall-stat-card">
              <div className="ws-firewall-stat-label">Firewall Durumu</div>
              <div className="ws-firewall-stat-value">
                {statusRes.state === 'loading' ? (
                  <Badge state="running">Yükleniyor…</Badge>
                ) : statusRes.state === 'error' ? (
                  <Badge state="error">Durum alınamadı</Badge>
                ) : (
                  <Badge state={overallStatus.badgeState}>{overallStatus.label}</Badge>
                )}
              </div>
              <div className="ws-firewall-stat-detail">
                {statusRes.state === 'loading'
                  ? 'Tablo durumu doğrulanıyor…'
                  : !statusVerified
                    ? 'Tablo: Bilinmiyor'
                    : `Tablo: ${statusRes.data.kernelRules?.hasYunpanelTable ? 'inet yunpanel yüklü' : 'Standart'}`}
              </div>
            </div>

            <div data-testid="firewall-card-boot" className="ws-firewall-stat-card">
              <div className="ws-firewall-stat-label">Açılış Kalıcılığı</div>
              <div className="ws-firewall-stat-value">
                {statusRes.state === 'loading' ? (
                  <Badge state="running">Yükleniyor…</Badge>
                ) : !statusVerified || statusRes.data.bootPersistence?.verified === false ? (
                  <Badge state="error">Bilinmiyor</Badge>
                ) : (
                  <Badge state={statusRes.data.bootPersistence?.active ? 'active' : 'stale'}>
                    {statusRes.data.bootPersistence?.active ? 'nftables.service aktif' : 'Pasif'}
                  </Badge>
                )}
              </div>
              <div className="ws-firewall-stat-detail">
                {statusRes.state === 'loading'
                  ? 'Servis durumu doğrulanıyor…'
                  : !statusVerified || statusRes.data.bootPersistence?.verified === false
                    ? 'Servis durumu: Bilinmiyor'
                    : `Servis durumu: ${statusRes.data.bootPersistence?.enabled ? 'Etkinleştirildi' : 'Devre dışı'}`}
              </div>
            </div>

            <div data-testid="firewall-card-docker" className="ws-firewall-stat-card">
              <div className="ws-firewall-stat-label">Docker Ağ Uyumluluğu</div>
              <div className="ws-firewall-stat-value">
                {statusRes.state === 'loading' ? (
                  <Badge state="running">Yükleniyor…</Badge>
                ) : !statusVerified ? (
                  <Badge state="error">Bilinmiyor</Badge>
                ) : (
                  <Badge state={dockerStatus.badgeState}>{dockerStatus.label}</Badge>
                )}
              </div>
              <div className="ws-firewall-stat-detail">
                {statusRes.state === 'loading'
                  ? 'Docker ağ kuralları doğrulanıyor…'
                  : !statusVerified
                    ? 'Docker ağ kuralları doğrulanamadı'
                    : dockerStatus.detail}
              </div>
            </div>

            <div data-testid="firewall-card-crowdsec" className="ws-firewall-stat-card">
              <div className="ws-firewall-stat-label">CrowdSec Bouncer</div>
              <div className="ws-firewall-stat-value">
                {statusRes.state === 'loading' ? (
                  <Badge state="running">Yükleniyor…</Badge>
                ) : !statusVerified ? (
                  <Badge state="error">Bilinmiyor</Badge>
                ) : (
                  <Badge state={statusRes.data.crowdsec?.bouncerActive ? 'active' : 'stale'}>
                    {statusRes.data.crowdsec?.bouncerActive ? 'Bouncer Aktif' : 'Bouncer Pasif'}
                  </Badge>
                )}
              </div>
              <div className="ws-firewall-stat-detail">
                {bansRes.state === 'loading'
                  ? 'Aktif Engellemeler: Yükleniyor…'
                  : bansRes.state === 'error'
                    ? 'Aktif Engellemeler: Erişilemedi'
                    : `Aktif Engellemeler: ${bansRes.data.length} IP`}
              </div>
            </div>
          </div>

          {portsRes.state === 'ready' && portsRes.data?.summary && (
            <div className="ws-firewall-summary-bar">
              <span><strong>Dinleyen Portlar:</strong> {portsRes.data.summary.totalListeningPorts}</span>
              <span><strong>Firewall İzinlileri:</strong> {portsRes.data.summary.totalFirewallAllowedPorts}</span>
              <span><strong>Dışarıdan Erişilebilir:</strong> {portsRes.data.summary.totalExternallyReachablePorts}</span>
              <span className="ws-firewall-summary-time">
                Son Doğrulama: {new Date(portsRes.data.summary.lastVerifiedAt).toLocaleTimeString('tr-TR')}
              </span>
            </div>
          )}
        </div>
      </Section>

      {/* Servis Profilleri */}
      <Section
        title="Sunucu Servis Profilleri"
        description="Yerel e-posta ve yetkili DNS servis profilleri etkin olmadığında ilgili portların açılması engellenir."
      >
        <div className="ws-section-body">
          {profilesRes.state === 'loading' ? (
            <div className="ws-loading" role="status">
              <span className="ws-spinner" />
              Servis profilleri yükleniyor…
            </div>
          ) : profilesRes.state === 'error' ? (
            <SectionLoadError
              title="Servis profilleri alınamadı"
              message={profilesRes.error}
              onRetry={loadServiceProfiles}
              disabled={actionBusy}
            />
          ) : (
            <>
              {!statusVerified && (
                <p className="ws-muted">
                  Güvenlik duvarı durumu doğrulanmadan servis profilleri değiştirilemez.
                </p>
              )}
              <div className="ws-firewall-profiles-grid">
                {/* Sistem / SSH */}
                <div className="ws-firewall-profile-card">
                  <div className="ws-firewall-profile-head">
                    <strong>Sistem / SSH</strong>
                    <Badge state="active">Zorunlu / Korumalı</Badge>
                  </div>
                  <p className="ws-muted">
                    SSH bağlantı portu (22). Kilitlenmeye karşı korumalıdır, kaldırılamaz.
                  </p>
                </div>

                {/* Web */}
                <div className="ws-firewall-profile-card">
                  <div className="ws-firewall-profile-head">
                    <strong>Web Hizmetleri</strong>
                    <Badge state={profilesRes.data.web ? 'active' : 'stale'}>
                      {profilesRes.data.web ? 'Aktif' : 'Devre Dışı'}
                    </Badge>
                  </div>
                  <p className="ws-muted">
                    HTTP (80) ve HTTPS (443) web trafiği.
                  </p>
                </div>

                {/* Yerel E-Posta */}
                <div className="ws-firewall-profile-card">
                  <div className="ws-firewall-profile-head">
                    <strong>Yerel E-Posta</strong>
                    <Badge state={profilesRes.data.localMail ? 'active' : 'stale'}>
                      {profilesRes.data.localMail ? 'Etkin' : 'Devre Dışı'}
                    </Badge>
                  </div>
                  <p className="ws-muted">
                    SMTP, IMAP ve POP3 portları (25, 143, 465, 587, 993). Pasifken bu portlar açılamaz.
                  </p>
                  <Button
                    variant={profilesRes.data.localMail ? 'secondary' : 'primary'}
                    disabled={!canMutateProfiles}
                    onClick={() => handleToggleProfile('localMail')}
                  >
                    {profilesRes.data.localMail ? 'Profili Devre Dışı Bırak' : 'Profili Etkinleştir'}
                  </Button>
                </div>

                {/* Yetkili DNS */}
                <div className="ws-firewall-profile-card">
                  <div className="ws-firewall-profile-head">
                    <strong>Yetkili DNS</strong>
                    <Badge state={profilesRes.data.authoritativeDns ? 'active' : 'stale'}>
                      {profilesRes.data.authoritativeDns ? 'Etkin' : 'Devre Dışı'}
                    </Badge>
                  </div>
                  <p className="ws-muted">
                    DNS portu (53 TCP/UDP). Pasifken DNS portu açılamaz.
                  </p>
                  <Button
                    variant={profilesRes.data.authoritativeDns ? 'secondary' : 'primary'}
                    disabled={!canMutateProfiles}
                    onClick={() => handleToggleProfile('authoritativeDns')}
                  >
                    {profilesRes.data.authoritativeDns ? 'Profili Devre Dışı Bırak' : 'Profili Etkinleştir'}
                  </Button>
                </div>
              </div>
            </>
          )}
        </div>
      </Section>

      {/* Port ve Kural Listesi */}
      <Section
        title="Port ve Güvenlik Duvarı Kuralları"
        description="Dinleyen soketler, firewall izinleri ve dış erişilebilirlik ayrımı."
        actions={
          <div className="ws-actions" style={{ display: 'flex', flexWrap: 'wrap', gap: '0.5rem' }}>
            <Button
              variant={filterMode === 'all' ? 'primary' : 'secondary'}
              disabled={portsRes.state !== 'ready'}
              onClick={() => setFilterMode('all')}
            >
              {portsRes.state === 'ready' ? `Tümü (${allPorts.length})` : 'Tümü'}
            </Button>
            <Button
              variant={filterMode === 'listening' ? 'primary' : 'secondary'}
              disabled={portsRes.state !== 'ready'}
              onClick={() => setFilterMode('listening')}
            >
              Dinleyenler
            </Button>
            <Button
              variant={filterMode === 'allowed' ? 'primary' : 'secondary'}
              disabled={portsRes.state !== 'ready'}
              onClick={() => setFilterMode('allowed')}
            >
              Firewall İzinlileri
            </Button>
            <Button
              variant={filterMode === 'reachable' ? 'primary' : 'secondary'}
              disabled={portsRes.state !== 'ready'}
              onClick={() => setFilterMode('reachable')}
            >
              Dış Erişilebilir
            </Button>
          </div>
        }
      >
        {portsRes.state === 'loading' ? (
          <div className="ws-section-body">
            <div className="ws-loading" role="status">
              <span className="ws-spinner" />
              Port ve güvenlik duvarı kuralları yükleniyor…
            </div>
          </div>
        ) : portsRes.state === 'error' ? (
          <div className="ws-section-body">
            <SectionLoadError
              title="Port ve güvenlik duvarı kuralları alınamadı"
              message={portsRes.error}
              onRetry={loadPorts}
              disabled={actionBusy}
            />
          </div>
        ) : (
          <div className="ws-table-scroll">
            <table className="ws-table ws-firewall-table">
              <thead>
                <tr>
                  <th>Port / Protokol</th>
                  <th>Dinleyen Adres / Proses</th>
                  <th>İzin Politikası</th>
                  <th>Kaynak IP/CIDR</th>
                  <th>Servis Profili</th>
                  <th>Dinliyor?</th>
                  <th>Firewall İzinli?</th>
                  <th>Dış Erişilebilir?</th>
                  <th className="ws-row-end">İşlem</th>
                </tr>
              </thead>
              <tbody>
                {filteredPorts.length === 0 ? (
                  <tr>
                    <td colSpan={9} style={{ textAlign: 'center', color: 'var(--ws-muted)' }}>
                      Bu filtreye uygun port kuralı bulunamadı.
                    </td>
                  </tr>
                ) : (
                  filteredPorts.map((p) => {
                    const reach = formatPortReachability(p);
                    const isLocked = isSpecialPortLocked(p.port, p.serviceProfile);

                    return (
                      <tr key={`${p.protocol}:${p.port}`}>
                        <td className="ws-col-nowrap">
                          <strong>{p.port} / {String(p.protocol).toUpperCase()}</strong>
                        </td>
                        <td>
                          {p.isListening ? (
                            <span>
                              {p.listenAddress} {p.process ? `(${p.process})` : ''}
                            </span>
                          ) : (
                            <span className="ws-muted">Dinlemiyor</span>
                          )}
                        </td>
                        <td className="ws-col-nowrap">
                          <span style={{ fontWeight: 600, color: p.isFirewallAllowed ? 'var(--ws-success)' : 'var(--ws-danger)' }}>
                            {String(p.policy || 'ALLOW').toUpperCase()}
                          </span>
                        </td>
                        <td className="ws-col-nowrap">
                          <code>{p.sourceCidr || p.source || '0.0.0.0/0'}</code>
                        </td>
                        <td className="ws-col-nowrap">
                          {formatServiceProfileLabel(p.serviceProfile)}
                        </td>
                        <td className="ws-col-nowrap">
                          {p.isListening ? <Badge state="active">Evet</Badge> : <Badge state="stale">Hayır</Badge>}
                        </td>
                        <td className="ws-col-nowrap">
                          {p.isFirewallAllowed ? <Badge state="active">Evet</Badge> : <Badge state="error">Hayır</Badge>}
                        </td>
                        <td className="ws-col-nowrap">
                          <Badge state={reach.badgeState === 'ready' ? 'active' : reach.badgeState}>{reach.label}</Badge>
                        </td>
                        <td className="ws-row-end ws-col-nowrap">
                          {isLocked ? (
                            <span className="ws-muted">Kilitli</span>
                          ) : p.isFirewallAllowed ? (
                            <Button
                              variant="secondary"
                              onClick={() => setDeleteCandidate(p)}
                              disabled={!canMutatePorts}
                            >
                              Kuralı Sil
                            </Button>
                          ) : (
                            <span className="ws-muted">—</span>
                          )}
                        </td>
                      </tr>
                    );
                  })
                )}
              </tbody>
            </table>
          </div>
        )}

        {/* Yeni Port Kuralı Ekle Formu */}
        <div className="ws-section-body">
          <div className="ws-firewall-subcard">
            <h4>Yeni Özel Port Kuralı Ekle</h4>
            {portError && (
              <div style={{ color: 'var(--ws-danger)', fontSize: '0.875rem' }}>
                <strong>Uyarı:</strong> {portError}
              </div>
            )}
            {(!statusVerified || portsRes.state !== 'ready' || profilesRes.state !== 'ready') && (
              <p className="ws-muted">
                Port kuralı ekleyebilmek için güvenlik duvarı durumu, port listesi ve servis profilleri doğrulanmış olmalıdır.
              </p>
            )}
            <form onSubmit={handleAddPort} className="ws-firewall-form-row">
              <label htmlFor="firewall-new-port" className="ws-firewall-field ws-firewall-field-sm">
                Port Numarası
                <input
                  id="firewall-new-port"
                  type="number"
                  min="1"
                  max="65535"
                  placeholder="Örn. 8080"
                  value={newPort}
                  onChange={(e) => setNewPort(e.target.value)}
                  disabled={!canMutatePorts}
                  required
                />
              </label>

              <label htmlFor="firewall-new-protocol" className="ws-firewall-field ws-firewall-field-sm">
                Protokol
                <select
                  id="firewall-new-protocol"
                  value={newProto}
                  onChange={(e) => setNewProto(e.target.value)}
                  disabled={!canMutatePorts}
                >
                  <option value="tcp">TCP</option>
                  <option value="udp">UDP</option>
                  <option value="both">TCP & UDP</option>
                </select>
              </label>

              <label htmlFor="firewall-new-source" className="ws-firewall-field">
                Kaynak IP / CIDR
                <input
                  id="firewall-new-source"
                  type="text"
                  placeholder="0.0.0.0/0"
                  value={newSource}
                  onChange={(e) => setNewSource(e.target.value)}
                  disabled={!canMutatePorts}
                />
              </label>

              <label htmlFor="firewall-new-comment" className="ws-firewall-field ws-firewall-field-lg">
                Açıklama
                <input
                  id="firewall-new-comment"
                  type="text"
                  placeholder="Özel servis açıklaması"
                  value={newComment}
                  onChange={(e) => setNewComment(e.target.value)}
                  disabled={!canMutatePorts}
                />
              </label>

              <Button type="submit" variant="primary" disabled={!canMutatePorts}>
                Port Kuralını Ekle
              </Button>
            </form>
          </div>
        </div>
      </Section>

      {/* Hedef Port Taraması & Doğrulama */}
      <Section
        title="Hedef Port Taraması ve Doğrulama"
        description="Port erişilebilirlik testi yalnızca izinli sunucu hedeflerinde çalıştırılabilir."
      >
        <div className="ws-section-body">
          {!statusVerified && (
            <p className="ws-muted">
              Güvenlik duvarı durumu doğrulanmadan port erişilebilirlik testi çalıştırılamaz.
            </p>
          )}
          <form onSubmit={handleRunScan} className="ws-firewall-form-row">
            <label htmlFor="firewall-scan-host" className="ws-firewall-field">
              Hedef Host / IP
              <input
                id="firewall-scan-host"
                type="text"
                value={scanHost}
                onChange={(e) => setScanHost(e.target.value)}
                placeholder="127.0.0.1"
                disabled={!canRunScan}
                required
              />
            </label>

            <label htmlFor="firewall-scan-port" className="ws-firewall-field ws-firewall-field-sm">
              Port
              <input
                id="firewall-scan-port"
                type="number"
                min="1"
                max="65535"
                value={scanPort}
                onChange={(e) => setScanPort(e.target.value)}
                disabled={!canRunScan}
                required
              />
            </label>

            <Button type="submit" variant="secondary" disabled={!canRunScan}>
              {scanBusy ? 'Taranıyor...' : 'Portu Test Et'}
            </Button>
          </form>

          {scanError && (
            <div style={{ color: 'var(--ws-danger)', fontSize: '0.875rem' }}>
              <strong>Tarama Hatası:</strong> {scanError}
            </div>
          )}

          {scanResult && (
            <div style={{ padding: '0.75rem 1rem', background: scanResult.reachable ? 'var(--ws-success-soft)' : 'var(--ws-danger-soft)', border: `1px solid ${scanResult.reachable ? 'var(--ws-success)' : 'var(--ws-danger)'}`, borderRadius: '6px', fontSize: '0.875rem' }}>
              <strong>Hedef:</strong> {scanResult.host}:{scanResult.port} |{' '}
              <strong>Durum:</strong> {scanResult.reachable ? 'Bağlantı Başarılı (Erişilebilir)' : 'Erişilemedi (Bağlantı Reddedildi / Zaman Aşımı)'} |{' '}
              <strong>Gecikme:</strong> {scanResult.rttMs} ms
            </div>
          )}
        </div>
      </Section>

      {/* CrowdSec Tehdit ve Engelleme Yönetimi */}
      <Section
        title="CrowdSec Tehdit ve Engelleme Yönetimi"
        description="CrowdSec bouncer ve aktif IP engellemeleri aynı güvenlik bağlamında yönetilir."
      >
        {bansRes.state === 'loading' ? (
          <div className="ws-section-body">
            <div className="ws-loading" role="status">
              <span className="ws-spinner" />
              CrowdSec engelleme listesi yükleniyor…
            </div>
          </div>
        ) : bansRes.state === 'error' ? (
          <div className="ws-section-body">
            <SectionLoadError
              title="CrowdSec engelleme listesi alınamadı"
              message={bansRes.error}
              onRetry={loadBans}
              disabled={actionBusy}
            />
          </div>
        ) : (
          <div className="ws-table-scroll">
            <table className="ws-table ws-firewall-bans-table">
              <thead>
                <tr>
                  <th>Engellenen IP</th>
                  <th>Süre</th>
                  <th>Sebep</th>
                  <th>Kaynak</th>
                  <th>Bitiş Zamanı</th>
                  <th className="ws-row-end">İşlem</th>
                </tr>
              </thead>
              <tbody>
                {bansRes.data.length === 0 ? (
                  <tr>
                    <td colSpan={6} style={{ textAlign: 'center', color: 'var(--ws-muted)' }}>
                      Şu anda aktif CrowdSec engellemesi bulunmuyor.
                    </td>
                  </tr>
                ) : (
                  bansRes.data.map((item) => {
                    const banAddress = item.ip ?? item.value ?? '-';
                    const banOrigin = item.origin ?? item.source ?? 'crowdsec';
                    return (
                      <tr key={item.id ?? banAddress}>
                        <td className="ws-col-nowrap"><strong>{banAddress}</strong></td>
                        <td className="ws-col-nowrap">{item.duration || 'Belirsiz'}</td>
                        <td>{item.reason || '-'}</td>
                        <td className="ws-col-nowrap">{banOrigin}</td>
                        <td className="ws-col-nowrap">
                          {item.expiresAt ? new Date(item.expiresAt).toLocaleString('tr-TR') : '-'}
                        </td>
                        <td className="ws-row-end ws-col-nowrap">
                          <Button
                            variant="secondary"
                            onClick={() => handleRemoveBan(item)}
                            disabled={!canMutateBans}
                          >
                            Engeli Kaldır
                          </Button>
                        </td>
                      </tr>
                    );
                  })
                )}
              </tbody>
            </table>
          </div>
        )}

        {/* Manuel IP Engelleme Ekle */}
        <div className="ws-section-body">
          <div className="ws-firewall-subcard">
            <h4>Manuel IP Engelleme Ekle</h4>
            {banError && (
              <div style={{ color: 'var(--ws-danger)', fontSize: '0.875rem' }}>
                <strong>Hata:</strong> {banError}
              </div>
            )}
            {(!statusVerified || bansRes.state !== 'ready') && (
              <p className="ws-muted">
                {bansRes.state !== 'ready'
                  ? 'CrowdSec engelleme listesi doğrulanmadan manuel IP engelleme yapılamaz.'
                  : 'Güvenlik duvarı durumu doğrulanmadan manuel IP engelleme yapılamaz.'}
              </p>
            )}
            <form onSubmit={handleAddBan} className="ws-firewall-form-row">
              <label htmlFor="firewall-ban-ip" className="ws-firewall-field">
                IP Adresi
                <input
                  id="firewall-ban-ip"
                  type="text"
                  placeholder="Örn. 198.51.100.25"
                  value={banIp}
                  onChange={(e) => setBanIp(e.target.value)}
                  disabled={!canMutateBans}
                  required
                />
              </label>

              <label htmlFor="firewall-ban-duration" className="ws-firewall-field ws-firewall-field-sm">
                Engelleme Süresi
                <select
                  id="firewall-ban-duration"
                  value={banDuration}
                  onChange={(e) => setBanDuration(e.target.value)}
                  disabled={!canMutateBans}
                >
                  <option value="1h">1 Saat</option>
                  <option value="4h">4 Saat</option>
                  <option value="24h">24 Saat</option>
                  <option value="7d">7 Gün</option>
                </select>
              </label>

              <label htmlFor="firewall-ban-reason" className="ws-firewall-field ws-firewall-field-lg">
                Sebep
                <input
                  id="firewall-ban-reason"
                  type="text"
                  placeholder="Kötü niyetli trafik veya yetkisiz erişim denemesi"
                  value={banReason}
                  onChange={(e) => setBanReason(e.target.value)}
                  disabled={!canMutateBans}
                />
              </label>

              <Button type="submit" variant="secondary" disabled={!canMutateBans}>
                IP Engelle
              </Button>
            </form>
          </div>
        </div>
      </Section>

      {/* Delete Port Modal */}
      {deleteCandidate && (
        <ConfirmDialog
          title="Port Kuralını Sil"
          message={`${deleteCandidate.port} / ${String(deleteCandidate.protocol).toUpperCase()} kuralı silinecek ve firewall kapatılacak. Onaylıyor musunuz?`}
          busy={actionBusy}
          disabled={!canMutatePorts}
          onCancel={() => setDeleteCandidate(null)}
          onConfirm={handleConfirmDeletePort}
          confirmLabel="Kuralı Sil"
        />
      )}
    </div>
  );
}
