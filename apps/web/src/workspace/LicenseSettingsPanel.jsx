import { useContext, useEffect, useState } from 'react';
import { formatDate } from './site-model.js';
import {
  Badge,
  Button,
  ConfirmDialog,
  ErrorNotice,
  KeyValues,
  Section,
} from './PanelKit.jsx';
import { WorkspaceContext } from './WorkspaceContext.jsx';
import {
  activateLicense,
  deactivateLicense,
  formatBillingPeriodLabel,
  formatLicenseError,
  formatLicenseStatusLabel,
  getLicenseStatus,
  refreshLicense,
  resolveLicenseBadgeState,
} from './license-client.js';

const CAPABILITY_ROWS = Object.freeze([
  ['singlePanelUserUnlimitedSites', 'Tek yönetici ile sınırsız site, site terminali ve SFTP'],
  ['webStackManagement', 'Web sunucusu, SSL, DNS, posta ve yedekleme'],
  ['aiOperations', 'AI yönetim asistanı ve otomasyon araçları'],
  ['resellerAccounts', 'Bayi ve bayi müşterisi yönetimi'],
  ['perSiteIsolatedUsers', 'Ayrı müşteri ve site yöneticisi panel hesapları'],
]);

export function LicenseSummaryView({
  license,
  isOwner = false,
  busy = false,
  onRefresh,
  onRequestDeactivate,
}) {
  if (!license) return null;

  const badgeState = resolveLicenseBadgeState(license);
  const statusLabel = formatLicenseStatusLabel(license);
  const periodLabel = formatBillingPeriodLabel(license);
  const capabilities = license.capabilities ?? {};
  const isLoopbackPanel = license.panelHost === 'localhost' || license.panelHost === '127.0.0.1';

  const summaryItems = [
    ['Paket', license.valid && license.tier === 'premium' ? 'Premium' : 'Ücretsiz'],
    ['Durum', <Badge key="status-badge" state={badgeState}>{statusLabel}</Badge>],
    ['Dönem', periodLabel],
    ['Lisanslı alan adı', license.domain ?? (isLoopbackPanel ? 'Yerel geliştirme ortamı' : (license.panelDomain ?? '—'))],
    [
      'Geçerlilik sonu',
      license.expiresAt
        ? `${formatDate(license.expiresAt)}${license.valid && license.daysRemaining > 0 ? ` · ${license.daysRemaining} gün kaldı` : ''}`
        : '—',
    ],
  ];

  if (isOwner) {
    if (license.maskedLicenseKey) {
      summaryItems.push(['Kayıtlı anahtar', license.maskedLicenseKey]);
    }
    if (license.instanceId) {
      summaryItems.push(['Kurulum kimliği', license.instanceId]);
    }
  }

  return (
    <>
      {isOwner && license.verificationKeyConfigured === false && (
        <div className="ws-notice ws-notice-warn" role="status">
          <div>
            <strong>Doğrulama anahtarı tanımlı değil</strong>
            <p>Lisans doğrulaması için sunucuda Ed25519 açık anahtar dosyası bulunmalıdır.</p>
          </div>
        </div>
      )}
      {isOwner && license.panelDomainValid === false && (
        <div className="ws-notice ws-notice-warn" role="status">
          <div>
            <strong>Panel alan adı yapılandırılmamış</strong>
            <p>Lisans etkinleştirmeden önce sunucu genel adresini geçerli bir alan adına ayarlayın.</p>
          </div>
        </div>
      )}
      {['expired', 'revoked', 'refunded', 'suspended'].includes(license.status) && (
        <div className="ws-notice ws-notice-warn" role="status">
          <div>
            <strong>Premium yetkileri duraklatıldı</strong>
            <p>Mevcut siteleriniz, verileriniz ve sertifikalarınız çalışmaya devam eder. Yeni Premium işlemleri için güncel lisansınızı girin.</p>
          </div>
        </div>
      )}
      <KeyValues items={summaryItems} />
      <div className="ws-table-scroll">
        <table className="ws-table">
          <thead>
            <tr>
              <th>Yetenek</th>
              <th>Durum</th>
            </tr>
          </thead>
          <tbody>
            {CAPABILITY_ROWS.map(([key, label]) => {
              const enabled = capabilities[key] === true;
              return (
                <tr key={key}>
                  <td>{label}</td>
                  <td>
                    <Badge state={enabled ? 'active' : 'unknown'}>
                      {enabled ? 'Açık' : 'Premium'}
                    </Badge>
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
      {isOwner && (onRefresh || onRequestDeactivate) && (
        <div className="ws-actions">
          {license.hasStoredLicenseKey && onRefresh && (
            <Button icon="refresh" disabled={busy} onClick={onRefresh}>
              Lisansı doğrula ve yenile
            </Button>
          )}
          {(license.valid || license.hasStoredLicenseKey || license.domain) && onRequestDeactivate && (
            <Button variant="danger" disabled={busy} onClick={onRequestDeactivate}>
              Lisansı kaldır
            </Button>
          )}
        </div>
      )}
    </>
  );
}

export default function LicenseSettingsPanel({
  initialLicense = null,
  client = null,
}) {
  const workspace = useContext(WorkspaceContext);
  const isOwner = workspace ? Boolean(workspace.isOwner && workspace.canManage) : true;
  const api = client ?? {
    getLicenseStatus,
    activateLicense,
    refreshLicense,
    deactivateLicense,
  };

  const [license, setLicense] = useState(initialLicense ?? workspace?.license?.data ?? null);
  const [loading, setLoading] = useState(!initialLicense && !workspace?.license?.data);
  const [mode, setMode] = useState('key');
  const [licenseKey, setLicenseKey] = useState('');
  const [token, setToken] = useState('');
  const [domain, setDomain] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);
  const [successMessage, setSuccessMessage] = useState(null);
  const [confirmDeactivate, setConfirmDeactivate] = useState(false);

  async function load(signal) {
    setLoading(true);
    try {
      const fresh = await api.getLicenseStatus({ signal });
      setLicense(fresh);
      setError(null);
    } catch (failure) {
      if (failure?.name !== 'AbortError') {
        setError(formatLicenseError(failure));
      }
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    if (initialLicense) return undefined;
    const controller = new AbortController();
    void load(controller.signal);
    return () => controller.abort();
  }, [initialLicense]);

  const isLoopbackPanel = license?.panelHost === 'localhost' || license?.panelHost === '127.0.0.1';

  async function handleActivate(event) {
    event.preventDefault();
    if (busy) return;
    setBusy(true);
    setError(null);
    setSuccessMessage(null);
    try {
      const updated = await api.activateLicense({
        licenseKey: mode === 'key' ? licenseKey : '',
        token: mode === 'token' ? token : '',
        domain: isLoopbackPanel ? domain : '',
      });
      setLicense(updated);
      setLicenseKey('');
      setToken('');
      setSuccessMessage('YunPanel Premium lisansı doğrulandı ve etkinleştirildi.');
      workspace?.license?.refresh?.();
    } catch (failure) {
      setError(formatLicenseError(failure));
    } finally {
      setBusy(false);
    }
  }

  async function handleRefresh() {
    if (busy) return;
    setBusy(true);
    setError(null);
    setSuccessMessage(null);
    try {
      const updated = await api.refreshLicense({
        domain: isLoopbackPanel ? (domain || license?.domain || '') : '',
      });
      setLicense(updated);
      setSuccessMessage(
        updated.valid
          ? 'Lisans durumu doğrulandı ve güncellendi.'
          : 'Lisans durumu güncellendi.',
      );
      workspace?.license?.refresh?.();
    } catch (failure) {
      setError(formatLicenseError(failure));
    } finally {
      setBusy(false);
    }
  }

  async function handleDeactivate() {
    if (busy) return;
    setBusy(true);
    setError(null);
    setSuccessMessage(null);
    try {
      const updated = await api.deactivateLicense({ notifyRemote: true });
      setLicense(updated);
      setConfirmDeactivate(false);
      setSuccessMessage('Lisans bu kurulumdan kaldırıldı. Panel ücretsiz sürümde çalışmaya devam ediyor.');
      workspace?.license?.refresh?.();
    } catch (failure) {
      setError(formatLicenseError(failure));
    } finally {
      setBusy(false);
    }
  }

  return (
    <>
      <Section
        title="Lisans durumu"
        description="Aylık ve yıllık YunPanel lisans doğrulaması yerel imza kontrolüyle çevrimdışı çalışır."
        actions={
          <Button icon="refresh" disabled={loading || busy} onClick={() => void load()}>
            Yenile
          </Button>
        }
      >
        <ErrorNotice error={error} />
        {successMessage && (
          <div className="ws-notice" role="status">
            <span>{successMessage}</span>
          </div>
        )}
        {loading && !license && (
          <div className="ws-loading" role="status">
            <span className="ws-spinner" />
            Lisans durumu yükleniyor…
          </div>
        )}
        {license && (
          <LicenseSummaryView
            license={license}
            isOwner={isOwner}
            busy={busy}
            onRefresh={handleRefresh}
            onRequestDeactivate={() => {
              setError(null);
              setConfirmDeactivate(true);
            }}
          />
        )}
      </Section>

      {isOwner && (
        <Section
          title="Lisans etkinleştirme ve yenileme"
          description="Yunsoft hesabınızdan aldığınız lisans anahtarını veya imzalı lisans jetonunu girin."
        >
          <div className="ws-actions">
            <Button
              variant={mode === 'key' ? 'primary' : 'secondary'}
              aria-pressed={mode === 'key'}
              disabled={busy}
              onClick={() => {
                setMode('key');
                setError(null);
              }}
            >
              Lisans anahtarı
            </Button>
            <Button
              variant={mode === 'token' ? 'primary' : 'secondary'}
              aria-pressed={mode === 'token'}
              disabled={busy}
              onClick={() => {
                setMode('token');
                setError(null);
              }}
            >
              İmzalı jeton
            </Button>
          </div>

          <form className="ws-form" onSubmit={handleActivate}>
            <div className="ws-form-grid">
              {mode === 'key' ? (
                <label>
                  Lisans anahtarı
                  <input
                    value={licenseKey}
                    onChange={(event) => setLicenseKey(event.target.value)}
                    placeholder="YUN-XXXX-XXXX-XXXX-XXXX"
                    autoComplete="off"
                    spellCheck={false}
                    required
                  />
                </label>
              ) : (
                <label>
                  İmzalı lisans jetonu
                  <textarea
                    rows={4}
                    value={token}
                    onChange={(event) => setToken(event.target.value)}
                    placeholder="eyJhbGciOiJFZERTQSIs..."
                    spellCheck={false}
                    required
                  />
                </label>
              )}

              {isLoopbackPanel && mode === 'key' && (
                <label>
                  Lisanslı alan adı
                  <input
                    value={domain}
                    onChange={(event) => setDomain(event.target.value)}
                    placeholder="panel.alanadiniz.com"
                    autoComplete="off"
                    spellCheck={false}
                    required
                  />
                </label>
              )}
            </div>

            <div className="ws-actions">
              <Button type="submit" variant="primary" disabled={busy}>
                {busy ? 'Doğrulanıyor…' : 'Lisansı etkinleştir'}
              </Button>
            </div>
          </form>
        </Section>
      )}

      {confirmDeactivate && (
        <ConfirmDialog
          title="Lisansı bu sunucudan kaldır"
          message="Premium lisans kaldırıldığında mevcut web siteleriniz, verileriniz ve sertifikalarınız silinmez; panel ücretsiz sürüm yetkilerine döner."
          confirmation="deactivate-license"
          confirmLabel="Lisansı kaldır"
          busy={busy}
          error={error}
          onCancel={() => setConfirmDeactivate(false)}
          onConfirm={handleDeactivate}
        />
      )}
    </>
  );
}
