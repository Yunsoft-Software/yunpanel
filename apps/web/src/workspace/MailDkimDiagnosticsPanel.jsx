import { useCallback, useEffect, useState } from 'react';
import {
  applyMailDkim,
  createMailDkim,
  getMailDeliveryDiagnostics,
  getMailDiagnostics,
  getMailDkim,
  previewMailDkimApply,
  rotateMailDkim,
  sendMailDomainTestDelivery,
} from './mail-client.js';
import { useWorkspace } from './WorkspaceContext.jsx';
import { Badge, Button, ConfirmDialog, EmptyState, ErrorNotice, KeyValues, Modal, ModalCloseButton, Section } from './PanelKit.jsx';
import { dmarcPolicy, mailDnsRequirementStatus } from './mail-dns-requirements.js';

function diagnosticState(value) {
  if (value === 'ready' || value === 'pass' || value === 'srs_ready') return 'active';
  if (value === 'not_applicable') return 'unknown';
  if (value === 'action_required') return 'warning';
  return 'error';
}

function DkimKeyModal({ keyState, domain, onClose, onChanged }) {
  const [selector, setSelector] = useState(keyState ? '' : 'mail');
  const [busy, setBusy] = useState(false); const [error, setError] = useState(null);
  async function submit(event) {
    event.preventDefault(); setBusy(true); setError(null);
    try {
      if (keyState) await rotateMailDkim(domain.id, { expectedRevision: keyState.revision, selector });
      else await createMailDkim(domain.id, { expectedRevision: 0, selector });
      onChanged?.(); onClose();
    } catch (failure) { if (failure.name !== 'AbortError') setError(failure.message); }
    finally { setBusy(false); }
  }
  return <Modal title={keyState ? 'DKIM anahtarını yenile' : 'DKIM anahtarı oluştur'} onClose={onClose} busy={busy}><form className="ws-form" onSubmit={submit}><ErrorNotice error={error} /><label>Seçici adı<input value={selector} required pattern="[a-z0-9](?:[a-z0-9-]*[a-z0-9])?" autoCapitalize="none" spellCheck={false} onChange={(event) => setSelector(event.target.value)} placeholder={keyState ? 'mail-2026' : 'mail'} /></label>{keyState && <p className="ws-muted">Mevcut seçici <strong>{keyState.selector}</strong>. Yenileme için farklı bir seçici gerekir; eski DNS kaydı geçiş tamamlanana kadar korunur.</p>}<p className="ws-muted">Özel anahtar sunucuda korunur; panel yalnız DNS kaydı bilgisini gösterir.</p><footer className="ws-modal-footer"><ModalCloseButton disabled={busy}>Vazgeç</ModalCloseButton><Button type="submit" variant="primary" disabled={busy || !selector}>{busy ? 'Hazırlanıyor…' : keyState ? 'Anahtarı yenile' : 'DKIM oluştur'}</Button></footer></form></Modal>;
}

export default function MailDkimDiagnosticsPanel({ domain, onChanged }) {
  const { observe } = useWorkspace();
  const [keyState, setKeyState] = useState(undefined);
  const [diagnostics, setDiagnostics] = useState(undefined);
  const [preview, setPreview] = useState(null);
  const [editing, setEditing] = useState(false);
  const [confirming, setConfirming] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);
  const [notice, setNotice] = useState(null);
  const [deliveryDiagnostics, setDeliveryDiagnostics] = useState(undefined);
  const [testRecipient, setTestRecipient] = useState('');
  const [testSending, setTestSending] = useState(false);
  const [testResult, setTestResult] = useState(null);
  const [testError, setTestError] = useState(null);

  const refresh = useCallback(async () => {
    setError(null);
    try {
      const [nextKey, nextDiagnostics, nextDelivery] = await Promise.all([
        getMailDkim(domain.id),
        getMailDiagnostics(domain.id),
        getMailDeliveryDiagnostics(domain.id).catch(() => null),
      ]);
      setKeyState(nextKey); setDiagnostics(nextDiagnostics); setDeliveryDiagnostics(nextDelivery); setPreview(null);
    } catch (failure) { if (failure.name !== 'AbortError') setError(failure.message); }
  }, [domain.id]);
  useEffect(() => { refresh(); }, [refresh]);

  async function handleSendTest(e) {
    e.preventDefault();
    if (!testRecipient) return;
    setTestSending(true); setTestResult(null); setTestError(null);
    try {
      const res = await sendMailDomainTestDelivery(domain.id, {
        recipient: testRecipient,
        subject: `YunPanel Domain Test Mail - ${domain.domainName}`,
      });
      setTestResult(res);
    } catch (failure) {
      if (failure.name !== 'AbortError') setTestError(failure.message);
    } finally {
      setTestSending(false);
    }
  }

  async function buildPreview() {
    if (!keyState) return; setBusy(true); setError(null); setNotice(null);
    try { setPreview(await previewMailDkimApply(domain.id, { expectedKeyRevision: keyState.revision })); }
    catch (failure) { if (failure.name !== 'AbortError') setError(failure.message); }
    finally { setBusy(false); }
  }
  async function applyPreview() {
    if (!keyState || !preview) return; setBusy(true); setError(null);
    try {
      const job = await applyMailDkim(domain.id, { expectedKeyRevision: keyState.revision, preview });
      observe(job); setConfirming(false); setPreview(null);
      setNotice('DKIM ayarı işlem kuyruğuna alındı. İşlem başarıyla bitmeden imzalama etkin sayılmaz.');
      onChanged?.();
    } catch (failure) { if (failure.name !== 'AbortError') setError(failure.message); }
    finally { setBusy(false); }
  }

  const dkimDiagnostic = diagnostics?.diagnostics?.dkim ?? null;
  const forwarding = diagnostics?.diagnostics?.forwardingDeliverability ?? null;
  return (
    <>
      <Section title="DKIM" description="DKIM DNS kaydı ve Rspamd imzalama ayarı.">
        <div className="ws-section-body">
          <ErrorNotice error={error} />
          {notice && (
            <p className="ws-notice" role="status">
              {notice}
            </p>
          )}
          {keyState ? (
            <>
              <KeyValues
                items={[
                  ['Seçici', keyState.selector],
                  ['Algoritma', keyState.algorithm],
                  ['Revizyon', keyState.revision],
                  ['Açık anahtar', keyState.publicKey],
                  ['DNS tipi', keyState.dnsRecord?.type ?? 'TXT'],
                  ['DNS adı', keyState.dnsRecord?.name ?? `${keyState.selector}._domainkey.${domain.domainName}`],
                  ['DNS değeri', keyState.dnsRecord?.content ?? keyState.dnsRecord?.value ?? '—'],
                ]}
              />
              <div className="ws-actions">
                <Button onClick={() => setEditing(true)}>Anahtarı yenile</Button>
                <Button disabled={busy} onClick={buildPreview}>
                  {busy ? 'Hazırlanıyor…' : 'İmzalama önizlemesi'}
                </Button>
              </div>
            </>
          ) : keyState === null ? (
            <EmptyState
              icon="shield"
              title="DKIM anahtarı yok"
              detail="Bu posta alan adı için sunucuda saklanan özel anahtarı ve DNS kaydını oluşturun."
              action={
                <Button variant="primary" onClick={() => setEditing(true)}>
                  DKIM oluştur
                </Button>
              }
            />
          ) : (
            <div className="ws-loading">
              <span className="ws-spinner" />
              DKIM yükleniyor…
            </div>
          )}
          {preview && (
            <>
              <KeyValues
                items={[
                  [
                    'Hazır',
                    <Badge key="ready" state={preview.readyToApply ? 'active' : 'warning'}>
                      {preview.readyToApply ? 'uygulanabilir' : 'DNS hazır değil'}
                    </Badge>,
                  ],
                  ['Seçici', preview.selector],
                  ['Önizleme özeti', preview.previewDigest],
                  ['Yapılandırma SHA-256', preview.configuration?.sha256 ?? '—'],
                  ['İmzalayan alan adı', preview.configuration?.domains ?? '—'],
                ]}
              />
              {preview.blockers?.length > 0 && (
                <div className="ws-notice ws-notice-warn">
                  <div>
                    <strong>DKIM engeli</strong>
                    <p>{preview.blockers.join(', ')}</p>
                  </div>
                </div>
              )}
              <Button
                variant="primary"
                disabled={busy || !preview.readyToApply || !preview.configuration}
                onClick={() => setConfirming(true)}
              >
                DKIM imzalamayı uygula
              </Button>
            </>
          )}
        </div>
      </Section>
      <Section title="Posta tanılama" description="DNS ve yönlendirme hazırlık sonuçları.">
        <div className="ws-section-body">
          <div className="ws-actions">
            <Button icon="refresh" disabled={busy} onClick={refresh}>
              Yenile
            </Button>
          </div>
          {diagnostics ? (
            <>
              <KeyValues
                items={[
                  [
                    'İnceleme gerekli',
                    <Badge key="attention" state={diagnostics.attentionRequired ? 'warning' : 'active'}>
                      {diagnostics.attentionRequired ? 'Evet' : 'Hayır'}
                    </Badge>,
                  ],
                  [
                    'DKIM',
                    dkimDiagnostic ? (
                      <Badge key="dkim" state={diagnosticState(dkimDiagnostic.state)}>
                        {dkimDiagnostic.state}
                      </Badge>
                    ) : (
                      '—'
                    ),
                  ],
                  [
                    'Yönlendirme',
                    forwarding ? (
                      <Badge key="fwd" state={diagnosticState(forwarding.state)}>
                        {forwarding.state}
                      </Badge>
                    ) : (
                      '—'
                    ),
                  ],
                  ['Dış adrese yönlendirme', forwarding?.externalDestinationCount ?? 0],
                  [
                    'SRS hazır',
                    forwarding?.srsReady === null || forwarding?.srsReady === undefined ? '—' : forwarding.srsReady ? 'Evet' : 'Hayır',
                  ],
                ]}
              />
              {diagnostics.issues?.length > 0 && (
                <div className="ws-table-scroll">
                  <table className="ws-table" role="table" aria-label="DKIM tanılamaları">
                    <thead>
                      <tr role="row">
                        <th scope="col">Tür</th>
                        <th scope="col">Sebep</th>
                        <th scope="col">Önerilen işlem</th>
                      </tr>
                    </thead>
                    <tbody>
                      {diagnostics.issues.map((issue, index) => (
                        <tr key={`${issue.kind ?? 'issue'}:${issue.reasonCode ?? index}`} role="row">
                          <td role="cell">{issue.kind ?? 'diagnostic'}</td>
                          <td role="cell">
                            <code>{issue.reasonCode ?? issue.code ?? 'attention_required'}</code>
                          </td>
                          <td role="cell">{issue.action ?? '—'}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}
            </>
          ) : diagnostics === null ? (
            <EmptyState icon="shield" title="Tanılama sonucu yok" detail="Posta tanılaması henüz sonuç üretmedi." />
          ) : (
            <div className="ws-loading">
              <span className="ws-spinner" />
              Tanılama yükleniyor…
            </div>
          )}
        </div>
      </Section>
      {deliveryDiagnostics?.connectionSettings && (
        <Section
          title="İstemci Bağlantı Bilgileri"
          description="E-posta istemcileri için alan adı bağlantı ayarları, portlar ve TLS gereksinimleri."
        >
          <div className="ws-section-body">
            <KeyValues
              items={[
                ['Posta Sunucusu', deliveryDiagnostics.connectionSettings.hostname],
                [
                  'IMAP Portları & TLS',
                  `${deliveryDiagnostics.connectionSettings.imap.ports.join(', ')} · ${deliveryDiagnostics.connectionSettings.imap.tls}`,
                ],
                [
                  'SMTP Portları & TLS',
                  `${deliveryDiagnostics.connectionSettings.smtp.ports.join(', ')} · ${deliveryDiagnostics.connectionSettings.smtp.tls}`,
                ],
                ['Kimlik Doğrulama', deliveryDiagnostics.connectionSettings.authentication],
              ]}
            />
          </div>
        </Section>
      )}
      {deliveryDiagnostics?.dnsRequirements && (
        <Section
          title="DNS Teslimat Gereksinimleri"
          description="SPF, DKIM, DMARC ve MX kayıtlarının canlı durumları ve yönlendirme doğrulaması."
        >
          <div className="ws-section-body">
            <KeyValues
              items={[
                [
                  'MX Kayıtları',
                  <Badge key="mx" state={mailDnsRequirementStatus(deliveryDiagnostics.dnsRequirements.mx) === 'valid' ? 'active' : 'error'}>
                    {mailDnsRequirementStatus(deliveryDiagnostics.dnsRequirements.mx) === 'valid' ? 'Doğrulandı' : 'Uyumsuz / Eksik'}
                  </Badge>,
                ],
                [
                  'SPF Kaydı',
                  <Badge
                    key="spf"
                    state={mailDnsRequirementStatus(deliveryDiagnostics.dnsRequirements.spf) === 'valid' ? 'active' : 'error'}
                  >
                    {mailDnsRequirementStatus(deliveryDiagnostics.dnsRequirements.spf) === 'valid' ? 'Geçerli' : 'Hatalı / Eksik'}
                  </Badge>,
                ],
                [
                  'DKIM Kaydı',
                  <Badge
                    key="dkim"
                    state={
                      mailDnsRequirementStatus(deliveryDiagnostics.dnsRequirements.dkim) === 'valid'
                        ? 'active'
                        : mailDnsRequirementStatus(deliveryDiagnostics.dnsRequirements.dkim) === 'unconfigured'
                          ? 'unknown'
                          : 'error'
                    }
                  >
                    {mailDnsRequirementStatus(deliveryDiagnostics.dnsRequirements.dkim) === 'valid'
                      ? 'Geçerli'
                      : mailDnsRequirementStatus(deliveryDiagnostics.dnsRequirements.dkim) === 'unconfigured'
                        ? 'Yapılandırılmadı'
                        : 'Hatalı'}
                  </Badge>,
                ],
                [
                  'DMARC Kaydı',
                  <Badge
                    key="dmarc"
                    state={mailDnsRequirementStatus(deliveryDiagnostics.dnsRequirements.dmarc) === 'valid' ? 'active' : 'warning'}
                  >
                    {mailDnsRequirementStatus(deliveryDiagnostics.dnsRequirements.dmarc) === 'valid'
                      ? `Geçerli (${dmarcPolicy(deliveryDiagnostics.dnsRequirements.dmarc) ?? 'none'})`
                      : 'Eksik / Yapılandırılmadı'}
                  </Badge>,
                ],
                [
                  'Reverse DNS (PTR)',
                  <Badge
                    key="ptr"
                    state={mailDnsRequirementStatus(deliveryDiagnostics.dnsRequirements.ptr) === 'valid' ? 'active' : 'warning'}
                  >
                    {mailDnsRequirementStatus(deliveryDiagnostics.dnsRequirements.ptr) === 'valid' ? 'Geçerli' : 'Bilinmiyor / Uyumsuz'}
                  </Badge>,
                ],
              ]}
            />
          </div>
        </Section>
      )}
      <Section title="Teslimat Testi" description="Gerçek SMTP teslimatı ile test e-postası gönderimi ve canlı teslim sonucu.">
        <div className="ws-section-body">
          <ErrorNotice error={testError} />
          {testResult && (
            <div className={`ws-notice ${testResult.delivered ? 'ws-notice-success' : 'ws-notice-warn'}`} role="status">
              <strong>{testResult.delivered ? 'Test E-postası Başarıyla Gönderildi' : 'Gönderim Başarısız'}</strong>
              <p>
                Alıcı: {testResult.recipient} ({testResult.routing === 'local' ? 'Yerel Teslim' : 'Dış Teslim'})
              </p>
              {testResult.messageId && (
                <p>
                  Mesaj ID: <code>{testResult.messageId}</code>
                </p>
              )}
              {testResult.error && <p>Hata Nedeni: {testResult.error}</p>}
            </div>
          )}
          <form className="ws-form" onSubmit={handleSendTest}>
            <fieldset disabled={testSending}>
              <label>
                Test Alıcı Adresi
                <input
                  type="email"
                  value={testRecipient}
                  required
                  onChange={(e) => setTestRecipient(e.target.value)}
                  placeholder="test@example.com"
                />
              </label>
              <div className="ws-actions">
                <Button type="submit" variant="primary" disabled={testSending || !testRecipient}>
                  {testSending ? 'Gönderiliyor…' : 'Test E-postası Gönder'}
                </Button>
              </div>
            </fieldset>
          </form>
        </div>
      </Section>
      {editing && (
        <DkimKeyModal
          keyState={keyState || null}
          domain={domain}
          onClose={() => setEditing(false)}
          onChanged={() => {
            refresh();
            onChanged?.();
          }}
        />
      )}
      {confirming && preview && (
        <ConfirmDialog
          title="DKIM imzalama ayarını uygula"
          message={`${domain.domainName} için DKIM imzalama ayarı bir işlem olarak uygulanacak. DNS kaydı yeniden doğrulanır.`}
          confirmation={preview.confirmation}
          busy={busy}
          error={error}
          onCancel={() => setConfirming(false)}
          onConfirm={applyPreview}
          confirmLabel="DKIM ayarını uygula"
        />
      )}
    </>
  );
}

export const mailDkimDiagnosticsPanelInternals = Object.freeze({ diagnosticState });
