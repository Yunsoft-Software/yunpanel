import { useState } from 'react';
import { applyMailConfiguration, previewMailConfiguration } from './mail-client.js';
import { useWorkspace } from './WorkspaceContext.jsx';
import { Badge, Button, ConfirmDialog, ErrorNotice, KeyValues, Section } from './PanelKit.jsx';

function blockerLabel(code) {
  const labels = {
    mail_postmaster_mailbox_required: 'Posta hizmetini açmak için en az bir etkin e-posta hesabı gerekli.',
    mail_service_domain_required: 'Posta hizmeti için bu sunucuda SSL sertifikalı bir alan adı gerekli.',
    mail_srs_configuration_unavailable: 'Dış adreslere yönlendirme için SRS ayarı hazır değil.',
    mail_srs_configuration_not_ready: 'Dış adreslere yönlendirme için SRS durumu hazır değil.',
  };
  return labels[code] ?? code;
}

export default function MailConfigurationPanel({ domain, onChanged }) {
  const { observe } = useWorkspace();
  const [status, setStatus] = useState(domain.status === 'enabled' ? 'disabled' : 'enabled');
  const [preview, setPreview] = useState(null);
  const [confirming, setConfirming] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);
  const [notice, setNotice] = useState(null);

  async function buildPreview() {
    setBusy(true); setError(null); setNotice(null); setPreview(null);
    try { setPreview(await previewMailConfiguration(domain.id, { expectedRevision: domain.revision, status })); }
    catch (failure) { if (failure.name !== 'AbortError') setError(failure.message); }
    finally { setBusy(false); }
  }

  async function applyPreview() {
    if (!preview) return;
    setBusy(true); setError(null); setNotice(null);
    try {
      const job = await applyMailConfiguration(domain.id, { expectedRevision: domain.revision, status, preview });
      observe(job);
      setConfirming(false); setPreview(null);
      setNotice('Posta ayarı işlemi sıraya alındı. Değişiklik, işlem başarıyla tamamlandığında geçerli olur.');
      onChanged?.();
    } catch (failure) { if (failure.name !== 'AbortError') setError(failure.message); }
    finally { setBusy(false); }
  }

  const configuration = preview?.configuration ?? null;
  return (
    <Section
      title="Sunucu posta ayarları"
      description="Postfix, Dovecot ve Rspamd ayarları önizleme onaylandıktan sonra uygulanır."
    >
      <div className="ws-section-body">
        <ErrorNotice error={error} />
        {notice && (
          <p role="status" className="ws-notice">
            {notice}
          </p>
        )}
        <div className="ws-form-grid">
          <label>
            Hedef durum
            <select
              value={status}
              onChange={(event) => {
                setStatus(event.target.value);
                setPreview(null);
              }}
            >
              <option value="enabled">Açık</option>
              <option value="disabled">Kapalı</option>
            </select>
          </label>
          <div className="ws-actions">
            <Button disabled={busy} onClick={buildPreview}>
              {busy ? 'Hazırlanıyor…' : 'Önizleme oluştur'}
            </Button>
          </div>
        </div>
        {preview && (
          <>
            <KeyValues
              items={[
                ['Mevcut durum', preview.currentStatus],
                ['Hedef durum', preview.desiredStatus],
                ['Yönetilen alan adı', preview.domains?.length ?? 0],
                [
                  'Hazır',
                  <Badge key="ready" state={preview.readyToApply ? 'active' : 'warning'}>
                    {preview.readyToApply ? 'uygulanabilir' : 'engel var'}
                  </Badge>,
                ],
                ['Önizleme özeti', preview.previewDigest],
                ['Yapılandırma SHA-256', configuration?.sha256 ?? '—'],
                ['Yapılandırma dosyası', configuration?.artifactDigests?.length ?? 0],
                ['E-posta hesabı', configuration?.counts?.mailboxes ?? configuration?.counts?.accounts ?? '—'],
                ['Alias', configuration?.counts?.aliases ?? '—'],
              ]}
            />
            {preview.blockers?.length > 0 && (
              <div className="ws-notice ws-notice-warn" role="alert">
                <div>
                  <strong>Uygulama engeli</strong>
                  <ul>
                    {preview.blockers.map((code) => (
                      <li key={code}>{blockerLabel(code)}</li>
                    ))}
                  </ul>
                </div>
              </div>
            )}
            {configuration?.artifactDigests?.length > 0 && (
              <div className="ws-table-scroll">
                <table className="ws-table" role="table" aria-label="Yapılandırma dosyaları">
                  <thead>
                    <tr role="row">
                      <th scope="col">Dosya</th>
                      <th scope="col">Özet</th>
                      <th scope="col">Hassas</th>
                    </tr>
                  </thead>
                  <tbody>
                    {configuration.artifactDigests.map((item) => (
                      <tr key={item.path} role="row">
                        <td role="cell">
                          <code>{item.path}</code>
                        </td>
                        <td role="cell">
                          <code>{item.sha256}</code>
                        </td>
                        <td role="cell">{item.sensitive ? 'Evet' : 'Hayır'}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
            <p className="ws-muted">
              Gizli ayar değerleri gösterilmez; yalnız dosya özetleri listelenir.
            </p>
            <Button variant="primary" disabled={busy || !preview.readyToApply || !configuration} onClick={() => setConfirming(true)}>
              Önizlemeyi uygula
            </Button>
          </>
        )}
      </div>
      {confirming && preview && (
        <ConfirmDialog
          title="Sunucu posta ayarlarını uygula"
          message={`${domain.domainName} için ${preview.currentStatus} → ${preview.desiredStatus} geçişi bir işlem olarak uygulanacak. Doğrulama, yeniden yükleme veya sağlık kontrolü başarısız olursa işlem başarılı sayılmaz.`}
          confirmation={preview.confirmation}
          busy={busy}
          error={error}
          onCancel={() => setConfirming(false)}
          onConfirm={applyPreview}
          confirmLabel="Ayarları uygula"
        />
      )}
    </Section>
  );
}

export const mailConfigurationPanelInternals = Object.freeze({ blockerLabel });
