import { useState } from 'react';
import { applyMailConfiguration, previewMailConfiguration } from './mail-client.js';
import { useWorkspace } from './WorkspaceContext.jsx';
import { Badge, Button, ConfirmDialog, ErrorNotice, KeyValues, Section } from './PanelKit.jsx';

function blockerLabel(code) {
  const labels = {
    mail_postmaster_mailbox_required: 'Etkin mail konfigürasyonu için en az bir enabled mailbox gerekli.',
    mail_service_domain_required: 'Mail servisi için local Web Domain/TLS identity gerekli.',
    mail_srs_configuration_unavailable: 'External forwarding için SRS konfigürasyonu hazır değil.',
    mail_srs_configuration_not_ready: 'External forwarding için SRS state hazır değil.',
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
      setNotice('Mail configuration işi kuyruğa alındı. Host değişikliği ancak job başarıyla tamamlandığında geçerli olur.');
      onChanged?.();
    } catch (failure) { if (failure.name !== 'AbortError') setError(failure.message); }
    finally { setBusy(false); }
  }

  const configuration = preview?.configuration ?? null;
  return <Section title="Host mail configuration" description="Postfix, Dovecot, Rspamd ve ilgili managed artefactlar exact preview üzerinden uygulanır."><div className="ws-section-body"><ErrorNotice error={error} />{notice && <p role="status" className="ws-notice">{notice}</p>}<div className="ws-form-grid"><label>Hedef durum<select value={status} onChange={(event) => { setStatus(event.target.value); setPreview(null); }}><option value="enabled">Enabled</option><option value="disabled">Disabled</option></select></label><div className="ws-actions"><Button disabled={busy} onClick={buildPreview}>{busy ? 'Hazırlanıyor…' : 'Preview oluştur'}</Button></div></div>{preview && <><KeyValues items={[
    ['Mevcut durum', preview.currentStatus],
    ['Hedef durum', preview.desiredStatus],
    ['Managed domain', preview.domains?.length ?? 0],
    ['Hazır', <Badge key="ready" state={preview.readyToApply ? 'active' : 'warning'}>{preview.readyToApply ? 'apply edilebilir' : 'blocker var'}</Badge>],
    ['Preview digest', preview.previewDigest],
    ['Configuration SHA-256', configuration?.sha256 ?? '—'],
    ['Artefact', configuration?.artifactDigests?.length ?? 0],
    ['Mailbox', configuration?.counts?.mailboxes ?? configuration?.counts?.accounts ?? '—'],
    ['Alias', configuration?.counts?.aliases ?? '—'],
  ]} />{preview.blockers?.length > 0 && <div className="ws-notice ws-notice-warn" role="alert"><div><strong>Apply blocker</strong><ul>{preview.blockers.map((code) => <li key={code}>{blockerLabel(code)}</li>)}</ul></div></div>}{configuration?.artifactDigests?.length > 0 && <div className="ws-table-scroll"><table className="ws-table"><thead><tr><th>Artefact</th><th>Digest</th><th>Hassas</th></tr></thead><tbody>{configuration.artifactDigests.map((item) => <tr key={item.path}><td><code>{item.path}</code></td><td><code>{item.sha256}</code></td><td>{item.sensitive ? 'Evet' : 'Hayır'}</td></tr>)}</tbody></table></div>}<p className="ws-muted">Protected configuration değerleri public response’da gösterilmez; yalnız hash/digest metadata kullanılır.</p><Button variant="primary" disabled={busy || !preview.readyToApply || !configuration} onClick={() => setConfirming(true)}>Bu preview’ı apply et</Button></>}</div>{confirming && preview && <ConfirmDialog title="Mail host konfigürasyonunu uygula" message={`${domain.domainName} için ${preview.currentStatus} → ${preview.desiredStatus} geçişi durable job olarak uygulanacak. Validator, reload ve health gate başarısız olursa job başarılı sayılmaz.`} confirmation={preview.confirmation} busy={busy} error={error} onCancel={() => setConfirming(false)} onConfirm={applyPreview} confirmLabel="Mail config apply" />}</Section>;
}

export const mailConfigurationPanelInternals = Object.freeze({ blockerLabel });
