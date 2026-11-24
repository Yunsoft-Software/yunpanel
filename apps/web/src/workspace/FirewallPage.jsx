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
      <div style={{ display: 'flex', alignItems: 'center', gap: '0.6rem' }}>
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
          <Button icon="refresh" onClick={loadAll} disabled={anyLoading || actionBusy}>
            Yenile
          </Button>
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

        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(220px, 1fr))', gap: '1rem', marginBottom: '1rem' }}>
          <div data-testid="firewall-card-status" style={{ padding: '1rem', background: 'var(--ws-surface-subtle)', border: '1px solid var(--ws-border)', borderRadius: '6px' }}>
            <div style={{ fontSize: '0.8rem', color: 'var(--ws-muted)', textTransform: 'uppercase', fontWeight: 600 }}>Firewall Durumu</div>
            <div style={{ marginTop: '0.4rem', display: 'flex', alignItems: 'center', gap: '0.5rem' }}>
              {statusRes.state === 'loading' ? (
                <Badge state="running">Yükleniyor…</Badge>
              ) : statusRes.state === 'error' ? (
                <Badge state="error">Durum alınamadı</Badge>
              ) : (
                <Badge state={overallStatus.badgeState}>{overallStatus.label}</Badge>
              )}
            </div>
            <div style={{ fontSize: '0.8rem', color: 'var(--ws-muted)', marginTop: '0.4rem' }}>
              {statusRes.state === 'loading'
                ? 'Tablo durumu doğrulanıyor…'
                : !statusVerified
                  ? 'Tablo: Bilinmiyor'
                  : `Tablo: ${statusRes.data.kernelRules?.hasYunpanelTable ? 'inet yunpanel yüklü' : 'Standart'}`}
            </div>
          </div>

          <div data-testid="firewall-card-boot" style={{ padding: '1rem', background: 'var(--ws-surface-subtle)', border: '1px solid var(--ws-border)', borderRadius: '6px' }}>
            <div style={{ fontSize: '0.8rem', color: 'var(--ws-muted)', textTransform: 'uppercase', fontWeight: 600 }}>Açılış Kalıcılığı</div>
            <div style={{ marginTop: '0.4rem' }}>
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
            <div style={{ fontSize: '0.8rem', color: 'var(--ws-muted)', marginTop: '0.4rem' }}>
              {statusRes.state === 'loading'
                ? 'Servis durumu doğrulanıyor…'
                : !statusVerified || statusRes.data.bootPersistence?.verified === false
                  ? 'Servis durumu: Bilinmiyor'
                  : `Servis durumu: ${statusRes.data.bootPersistence?.enabled ? 'Etkinleştirildi' : 'Devre dışı'}`}
            </div>
          </div>

          <div data-testid="firewall-card-docker" style={{ padding: '1rem', background: 'var(--ws-surface-subtle)', border: '1px solid var(--ws-border)', borderRadius: '6px' }}>
            <div style={{ fontSize: '0.8rem', color: 'var(--ws-muted)', textTransform: 'uppercase', fontWeight: 600 }}>Docker Ağ Uyumluluğu</div>
            <div style={{ marginTop: '0.4rem' }}>
              {statusRes.state === 'loading' ? (
                <Badge state="running">Yükleniyor…</Badge>
              ) : !statusVerified ? (
                <Badge state="error">Bilinmiyor</Badge>
              ) : (
                <Badge state={dockerStatus.badgeState}>{dockerStatus.label}</Badge>
              )}
            </div>
            <div style={{ fontSize: '0.8rem', color: 'var(--ws-muted)', marginTop: '0.4rem' }}>
              {statusRes.state === 'loading'
                ? 'Docker ağ kuralları doğrulanıyor…'
                : !statusVerified
                  ? 'Docker ağ kuralları doğrulanamadı'
                  : dockerStatus.detail}
            </div>
          </div>

          <div data-testid="firewall-card-crowdsec" style={{ padding: '1rem', background: 'var(--ws-surface-subtle)', border: '1px solid var(--ws-border)', borderRadius: '6px' }}>
            <div style={{ fontSize: '0.8rem', color: 'var(--ws-muted)', textTransform: 'uppercase', fontWeight: 600 }}>CrowdSec Bouncer</div>
            <div style={{ marginTop: '0.4rem' }}>
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
            <div style={{ fontSize: '0.8rem', color: 'var(--ws-muted)', marginTop: '0.4rem' }}>
              {bansRes.state === 'loading'
                ? 'Aktif Engellemeler: Yükleniyor…'
                : bansRes.state === 'error'
                  ? 'Aktif Engellemeler: Erişilemedi'
                  : `Aktif Engellemeler: ${bansRes.data.length} IP`}
            </div>
          </div>
        </div>

        {portsRes.state === 'ready' && portsRes.data?.summary && (
          <div style={{ display: 'flex', gap: '1.5rem', flexWrap: 'wrap', padding: '0.75rem 1rem', background: 'var(--ws-surface-subtle)', borderRadius: '6px', fontSize: '0.875rem' }}>
            <span><strong>Dinleyen Portlar:</strong> {portsRes.data.summary.totalListeningPorts}</span>
            <span><strong>Firewall İzinlileri:</strong> {portsRes.data.summary.totalFirewallAllowedPorts}</span>
            <span><strong>Dışarıdan Erişilebilir:</strong> {portsRes.data.summary.totalExternallyReachablePorts}</span>
            <span style={{ marginLeft: 'auto', color: 'var(--ws-muted)' }}>
              Son Doğrulama: {new Date(portsRes.data.summary.lastVerifiedAt).toLocaleTimeString('tr-TR')}
            </span>
          </div>
        )}
      </Section>

      {/* Servis Profilleri */}
      <Section
        title="Sunucu Servis Profilleri"
        description="Yerel e-posta ve yetkili DNS servis profilleri etkin olmadığında ilgili portların açılması engellenir."
      >
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
            <p style={{ margin: '0 0 0.75rem 0', fontSize: '0.85rem', color: 'var(--ws-muted)' }}>
              Güvenlik duvarı durumu doğrulanmadan servis profilleri değiştirilemez.
            </p>
          )}
          <div className="ws-firewall-profiles-grid" style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(320px, 1fr))', gap: '1rem' }}>
            {/* Sistem / SSH */}
            <div style={{ padding: '1rem', border: '1px solid var(--ws-border)', borderRadius: '6px', background: 'var(--ws-surface)' }}>
              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                <strong>Sistem / SSH</strong>
                <Badge state="active">Zorunlu / Korumalı</Badge>
              </div>
              <p style={{ fontSize: '0.85rem', color: 'var(--ws-muted)', margin: '0.5rem 0' }}>
                SSH bağlantı portu (22). Kilitlenmeye karşı korumalıdır, kaldırılamaz.
              </p>
            </div>

            {/* Web */}
            <div style={{ padding: '1rem', border: '1px solid var(--ws-border)', borderRadius: '6px', background: 'var(--ws-surface)' }}>
              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                <strong>Web Hizmetleri</strong>
                <Badge state={profilesRes.data.web ? 'active' : 'stale'}>
                  {profilesRes.data.web ? 'Aktif' : 'Devre Dışı'}
                </Badge>
              </div>
              <p style={{ fontSize: '0.85rem', color: 'var(--ws-muted)', margin: '0.5rem 0' }}>
                HTTP (80) ve HTTPS (443) web trafiği.
              </p>
            </div>

            {/* Yerel E-Posta */}
            <div style={{ padding: '1rem', border: '1px solid var(--ws-border)', borderRadius: '6px', background: 'var(--ws-surface)' }}>
              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                <strong>Yerel E-Posta</strong>
                <Badge state={profilesRes.data.localMail ? 'active' : 'stale'}>
                  {profilesRes.data.localMail ? 'Etkin' : 'Devre Dışı'}
                </Badge>
              </div>
              <p style={{ fontSize: '0.85rem', color: 'var(--ws-muted)', margin: '0.5rem 0' }}>
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
            <div style={{ padding: '1rem', border: '1px solid var(--ws-border)', borderRadius: '6px', background: 'var(--ws-surface)' }}>
              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                <strong>Yetkili DNS</strong>
                <Badge state={profilesRes.data.authoritativeDns ? 'active' : 'stale'}>
                  {profilesRes.data.authoritativeDns ? 'Etkin' : 'Devre Dışı'}
                </Badge>
              </div>
              <p style={{ fontSize: '0.85rem', color: 'var(--ws-muted)', margin: '0.5rem 0' }}>
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
          <div className="ws-loading" role="status">
            <span className="ws-spinner" />
            Port ve güvenlik duvarı kuralları yükleniyor…
          </div>
        ) : portsRes.state === 'error' ? (
          <SectionLoadError
            title="Port ve güvenlik duvarı kuralları alınamadı"
            message={portsRes.error}
            onRetry={loadPorts}
            disabled={actionBusy}
          />
        ) : (
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
                          {p.isListening ? <Badge state="active">Evet</Badge> : <Badge state="stale">Hayır</Badge>}
                        </td>
                        <td style={{ padding: '0.75rem' }}>
                          {p.isFirewallAllowed ? <Badge state="active">Evet</Badge> : <Badge state="error">Hayır</Badge>}
                        </td>
                        <td style={{ padding: '0.75rem' }}>
                          <Badge state={reach.badgeState === 'ready' ? 'active' : reach.badgeState}>{reach.label}</Badge>
                        </td>
                        <td style={{ padding: '0.75rem' }}>
                          {isLocked ? (
                            <span style={{ fontSize: '0.8rem', color: 'var(--ws-muted)' }}>Kilitli</span>
                          ) : p.isFirewallAllowed ? (
                            <Button
                              variant="secondary"
                              onClick={() => setDeleteCandidate(p)}
                              disabled={!canMutatePorts}
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
        )}

        {/* Yeni Port Kuralı Ekle Formu */}
        <div style={{ marginTop: '1.5rem', padding: '1rem', background: 'var(--ws-surface-subtle)', border: '1px solid var(--ws-border)', borderRadius: '6px' }}>
          <h4 style={{ margin: '0 0 1rem 0' }}>Yeni Özel Port Kuralı Ekle</h4>
          {portError && (
            <div style={{ color: 'var(--ws-danger)', marginBottom: '0.75rem', fontSize: '0.875rem' }}>
              <strong>Uyarı:</strong> {portError}
            </div>
          )}
          {(!statusVerified || portsRes.state !== 'ready' || profilesRes.state !== 'ready') && (
            <p style={{ margin: '0 0 0.75rem 0', fontSize: '0.85rem', color: 'var(--ws-muted)' }}>
              Port kuralı ekleyebilmek için güvenlik duvarı durumu, port listesi ve servis profilleri doğrulanmış olmalıdır.
            </p>
          )}
          <form onSubmit={handleAddPort} style={{ display: 'flex', gap: '0.75rem', flexWrap: 'wrap', alignItems: 'flex-end' }}>
            <div>
              <label htmlFor="firewall-new-port" style={{ display: 'block', fontSize: '0.8rem', color: 'var(--ws-muted)', marginBottom: '0.25rem' }}>Port Numarası</label>
              <input id="firewall-new-port"
                type="number"
                min="1"
                max="65535"
                placeholder="Örn. 8080"
                value={newPort}
                onChange={(e) => setNewPort(e.target.value)}
                disabled={!canMutatePorts}
                required
                style={{ padding: '0.4rem 0.6rem', border: '1px solid var(--ws-control-border)', borderRadius: '4px', width: '120px' }}
              />
            </div>

            <div>
              <label htmlFor="firewall-new-protocol" style={{ display: 'block', fontSize: '0.8rem', color: 'var(--ws-muted)', marginBottom: '0.25rem' }}>Protokol</label>
              <select id="firewall-new-protocol"
                value={newProto}
                onChange={(e) => setNewProto(e.target.value)}
                disabled={!canMutatePorts}
                style={{ padding: '0.4rem 0.6rem', border: '1px solid var(--ws-control-border)', borderRadius: '4px' }}
              >
                <option value="tcp">TCP</option>
                <option value="udp">UDP</option>
                <option value="both">TCP & UDP</option>
              </select>
            </div>

            <div>
              <label htmlFor="firewall-new-source" style={{ display: 'block', fontSize: '0.8rem', color: 'var(--ws-muted)', marginBottom: '0.25rem' }}>Kaynak IP / CIDR</label>
              <input id="firewall-new-source"
                type="text"
                placeholder="0.0.0.0/0"
                value={newSource}
                onChange={(e) => setNewSource(e.target.value)}
                disabled={!canMutatePorts}
                style={{ padding: '0.4rem 0.6rem', border: '1px solid var(--ws-control-border)', borderRadius: '4px', width: '160px' }}
              />
            </div>

            <div>
              <label htmlFor="firewall-new-comment" style={{ display: 'block', fontSize: '0.8rem', color: 'var(--ws-muted)', marginBottom: '0.25rem' }}>Açıklama</label>
              <input id="firewall-new-comment"
                type="text"
                placeholder="Özel servis açıklaması"
                value={newComment}
                onChange={(e) => setNewComment(e.target.value)}
                disabled={!canMutatePorts}
                style={{ padding: '0.4rem 0.6rem', border: '1px solid var(--ws-control-border)', borderRadius: '4px', width: '200px' }}
              />
            </div>

            <Button type="submit" variant="primary" disabled={!canMutatePorts}>
              Port Kuralını Ekle
            </Button>
          </form>
        </div>
      </Section>

      {/* Hedef Port Taraması & Doğrulama */}
      <Section
        title="Hedef Port Taraması ve Doğrulama"
        description="Port erişilebilirlik testi yalnızca izinli sunucu hedeflerinde çalıştırılabilir."
      >
        {!statusVerified && (
          <p style={{ margin: '0 0 0.75rem 0', fontSize: '0.85rem', color: 'var(--ws-muted)' }}>
            Güvenlik duvarı durumu doğrulanmadan port erişilebilirlik testi çalıştırılamaz.
          </p>
        )}
        <form onSubmit={handleRunScan} style={{ display: 'flex', gap: '0.75rem', flexWrap: 'wrap', alignItems: 'flex-end', marginBottom: '1rem' }}>
          <div>
            <label htmlFor="firewall-scan-host" style={{ display: 'block', fontSize: '0.8rem', color: 'var(--ws-muted)', marginBottom: '0.25rem' }}>Hedef Host / IP</label>
            <input id="firewall-scan-host"
              type="text"
              value={scanHost}
              onChange={(e) => setScanHost(e.target.value)}
              placeholder="127.0.0.1"
              disabled={!canRunScan}
              required
              style={{ padding: '0.4rem 0.6rem', border: '1px solid var(--ws-control-border)', borderRadius: '4px', width: '180px' }}
            />
          </div>

          <div>
            <label htmlFor="firewall-scan-port" style={{ display: 'block', fontSize: '0.8rem', color: 'var(--ws-muted)', marginBottom: '0.25rem' }}>Port</label>
            <input id="firewall-scan-port"
              type="number"
              min="1"
              max="65535"
              value={scanPort}
              onChange={(e) => setScanPort(e.target.value)}
              disabled={!canRunScan}
              required
              style={{ padding: '0.4rem 0.6rem', border: '1px solid var(--ws-control-border)', borderRadius: '4px', width: '100px' }}
            />
          </div>

          <Button type="submit" variant="secondary" disabled={!canRunScan}>
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
            <strong>Gecikme:</strong> {scanResult.rttMs} ms
          </div>
        )}
      </Section>

      {/* CrowdSec Tehdit ve Engelleme Yönetimi */}
      <Section
        title="CrowdSec Tehdit ve Engelleme Yönetimi"
        description="CrowdSec bouncer ve aktif IP engellemeleri aynı güvenlik bağlamında yönetilir."
      >
        {bansRes.state === 'loading' ? (
          <div className="ws-loading" role="status" style={{ marginBottom: '1rem' }}>
            <span className="ws-spinner" />
            CrowdSec engelleme listesi yükleniyor…
          </div>
        ) : bansRes.state === 'error' ? (
          <SectionLoadError
            title="CrowdSec engelleme listesi alınamadı"
            message={bansRes.error}
            onRetry={loadBans}
            disabled={actionBusy}
          />
        ) : (
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
                {bansRes.data.length === 0 ? (
                  <tr>
                    <td colSpan={6} style={{ padding: '1rem', textAlign: 'center', color: 'var(--ws-muted)' }}>
                      Şu anda aktif CrowdSec engellemesi bulunmuyor.
                    </td>
                  </tr>
                ) : (
                  bansRes.data.map((item) => {
                    const banAddress = item.ip ?? item.value ?? '-';
                    const banOrigin = item.origin ?? item.source ?? 'crowdsec';
                    return (
                      <tr key={item.id ?? banAddress} style={{ borderBottom: '1px solid var(--ws-border)' }}>
                        <td style={{ padding: '0.75rem', fontWeight: 600 }}>{banAddress}</td>
                        <td style={{ padding: '0.75rem', fontSize: '0.85rem' }}>{item.duration || 'Belirsiz'}</td>
                        <td style={{ padding: '0.75rem', fontSize: '0.85rem' }}>{item.reason || '-'}</td>
                        <td style={{ padding: '0.75rem', fontSize: '0.85rem' }}>{banOrigin}</td>
                        <td style={{ padding: '0.75rem', fontSize: '0.85rem' }}>
                          {item.expiresAt ? new Date(item.expiresAt).toLocaleString('tr-TR') : '-'}
                        </td>
                        <td style={{ padding: '0.75rem' }}>
                          <Button
                            variant="secondary"
                            onClick={() => handleRemoveBan(item)}
                            disabled={!canMutateBans}
                            style={{ fontSize: '0.8rem', padding: '0.2rem 0.5rem' }}
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
        <div style={{ padding: '1rem', background: 'var(--ws-surface-subtle)', border: '1px solid var(--ws-border)', borderRadius: '6px' }}>
          <h4 style={{ margin: '0 0 1rem 0' }}>Manuel IP Engelleme Ekle</h4>
          {banError && (
            <div style={{ color: 'var(--ws-danger)', marginBottom: '0.75rem', fontSize: '0.875rem' }}>
              <strong>Hata:</strong> {banError}
            </div>
          )}
          {(!statusVerified || bansRes.state !== 'ready') && (
            <p style={{ margin: '0 0 0.75rem 0', fontSize: '0.85rem', color: 'var(--ws-muted)' }}>
              {bansRes.state !== 'ready'
                ? 'CrowdSec engelleme listesi doğrulanmadan manuel IP engelleme yapılamaz.'
                : 'Güvenlik duvarı durumu doğrulanmadan manuel IP engelleme yapılamaz.'}
            </p>
          )}
          <form onSubmit={handleAddBan} style={{ display: 'flex', gap: '0.75rem', flexWrap: 'wrap', alignItems: 'flex-end' }}>
            <div>
              <label htmlFor="firewall-ban-ip" style={{ display: 'block', fontSize: '0.8rem', color: 'var(--ws-muted)', marginBottom: '0.25rem' }}>IP Adresi</label>
              <input id="firewall-ban-ip"
                type="text"
                placeholder="Örn. 198.51.100.25"
                value={banIp}
                onChange={(e) => setBanIp(e.target.value)}
                disabled={!canMutateBans}
                required
                style={{ padding: '0.4rem 0.6rem', border: '1px solid var(--ws-control-border)', borderRadius: '4px', width: '160px' }}
              />
            </div>

            <div>
              <label htmlFor="firewall-ban-duration" style={{ display: 'block', fontSize: '0.8rem', color: 'var(--ws-muted)', marginBottom: '0.25rem' }}>Engelleme Süresi</label>
              <select id="firewall-ban-duration"
                value={banDuration}
                onChange={(e) => setBanDuration(e.target.value)}
                disabled={!canMutateBans}
                style={{ padding: '0.4rem 0.6rem', border: '1px solid var(--ws-control-border)', borderRadius: '4px' }}
              >
                <option value="1h">1 Saat</option>
                <option value="4h">4 Saat</option>
                <option value="24h">24 Saat</option>
                <option value="7d">7 Gün</option>
              </select>
            </div>

            <div>
              <label htmlFor="firewall-ban-reason" style={{ display: 'block', fontSize: '0.8rem', color: 'var(--ws-muted)', marginBottom: '0.25rem' }}>Sebep</label>
              <input id="firewall-ban-reason"
                type="text"
                placeholder="Kötü niyetli trafik veya yetkisiz erişim denemesi"
                value={banReason}
                onChange={(e) => setBanReason(e.target.value)}
                disabled={!canMutateBans}
                style={{ padding: '0.4rem 0.6rem', border: '1px solid var(--ws-control-border)', borderRadius: '4px', width: '240px' }}
              />
            </div>

            <Button type="submit" variant="secondary" disabled={!canMutateBans}>
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
          disabled={!canMutatePorts}
          onCancel={() => setDeleteCandidate(null)}
          onConfirm={handleConfirmDeletePort}
          confirmLabel="Kuralı Sil"
        />
      )}
    </div>
  );
}
