import { useCallback, useEffect, useState } from 'react';
import { panelRequest } from '../api.js';
import {
  bindMailWebmail,
  continueMailWebmail,
  deleteMailWebmail,
  inspectMailWebmail,
  previewBindMailWebmail,
  previewDeleteMailWebmail,
} from './mail-client.js';
import { Badge, Button, ConfirmDialog, EmptyState, ErrorNotice, KeyValues, Section } from './PanelKit.jsx';
import { formatDate } from './site-model.js';
import { useWorkspace } from './WorkspaceContext.jsx';

function mappingBadgeState(state) {
  if (state === 'active') return 'active';
  if (state === 'pending') return 'warning';
  if (state === 'removing') return 'danger';
  return 'offline';
}

function mappingBadgeLabel(state) {
  if (state === 'active') return 'Aktif (Roundcube bağlı)';
  if (state === 'pending') return 'Yapılandırılıyor (Job bekleniyor)';
  if (state === 'removing') return 'Kaldırılıyor';
  return state ?? 'Bağlı değil';
}

export default function MailWebmailPanel({ domain, onChanged }) {
  const { observe } = useWorkspace();
  const [data, setData] = useState(undefined);
  const [certificates, setCertificates] = useState([]);
  const [selectedCertId, setSelectedCertId] = useState('');
  const [bindPreview, setBindPreview] = useState(null);
  const [deletePreview, setDeletePreview] = useState(null);
  const [confirmingBind, setConfirmingBind] = useState(false);
  const [confirmingDelete, setConfirmingDelete] = useState(false);
  const [confirmingContinue, setConfirmingContinue] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);
  const [notice, setNotice] = useState(null);

  const load = useCallback(async () => {
    if (!domain?.id) return;
    setError(null);
    try {
      const [webmailData, certsResponse] = await Promise.all([
        inspectMailWebmail(domain.id),
        panelRequest('/certificates').catch(() => ({ data: [] })),
      ]);
      setData(webmailData);
      const certList = Array.isArray(certsResponse?.data) ? certsResponse.data : [];
      setCertificates(certList);
      const targetHost = `webmail.${domain.domainName}`;
      const matchingCert = certList.find((c) =>
        c.primaryDomain === targetHost
        || (Array.isArray(c.domains) && c.domains.includes(targetHost))
        || (Array.isArray(c.subjectAlternativeNames) && c.subjectAlternativeNames.includes(targetHost)),
      );
      if (matchingCert) {
        setSelectedCertId(matchingCert.id);
      } else if (certList.length > 0 && !selectedCertId) {
        setSelectedCertId(certList[0].id);
      }
    } catch (failure) {
      if (failure.name !== 'AbortError') setError(failure.message);
    }
  }, [domain?.id, domain?.domainName, selectedCertId]);

  useEffect(() => {
    load();
  }, [load]);

  const mapping = data?.mapping ?? null;
  const job = data?.job ?? null;
  const actions = data?.actions ?? {};
  const webmailUrl = `https://webmail.${domain.domainName}`;

  async function handleBindPreview() {
    if (!selectedCertId) return;
    setBusy(true);
    setError(null);
    setNotice(null);
    try {
      const preview = await previewBindMailWebmail(domain.id, { certificateId: selectedCertId });
      setBindPreview(preview);
    } catch (failure) {
      if (failure.name !== 'AbortError') setError(failure.message);
    } finally {
      setBusy(false);
    }
  }

  async function handleBindConfirm() {
    if (!bindPreview) return;
    setBusy(true);
    setError(null);
    setNotice(null);
    try {
      const result = await bindMailWebmail(domain.id, {
        certificateId: selectedCertId,
        previewDigest: bindPreview.previewDigest,
        confirmation: bindPreview.confirmation,
      });
      if (result?.job) observe(result.job);
      setConfirmingBind(false);
      setBindPreview(null);
      setNotice('Webmail Roundcube bağlantı işi başlatıldı.');
      await load();
      onChanged?.();
    } catch (failure) {
      if (failure.name !== 'AbortError') setError(failure.message);
    } finally {
      setBusy(false);
    }
  }

  async function handleDeletePreview() {
    setBusy(true);
    setError(null);
    setNotice(null);
    try {
      const preview = await previewDeleteMailWebmail(domain.id);
      setDeletePreview(preview);
      setConfirmingDelete(true);
    } catch (failure) {
      if (failure.name !== 'AbortError') setError(failure.message);
    } finally {
      setBusy(false);
    }
  }

  async function handleDeleteConfirm() {
    if (!deletePreview || !mapping) return;
    setBusy(true);
    setError(null);
    setNotice(null);
    try {
      const result = await deleteMailWebmail(domain.id, {
        expectedRevision: mapping.revision,
        previewDigest: deletePreview.previewDigest,
        confirmation: deletePreview.confirmation,
      });
      if (result?.job) observe(result.job);
      setConfirmingDelete(false);
      setDeletePreview(null);
      setNotice('Webmail Roundcube bağlantı kaldırma işi başlatıldı.');
      await load();
      onChanged?.();
    } catch (failure) {
      if (failure.name !== 'AbortError') setError(failure.message);
    } finally {
      setBusy(false);
    }
  }

  async function handleContinue() {
    if (!mapping || !actions?.continuation) return;
    setBusy(true);
    setError(null);
    setNotice(null);
    try {
      const result = await continueMailWebmail(domain.id, {
        operationId: mapping.operationId,
        expectedUpdatedAt: mapping.updatedAt,
        confirmation: actions.continuation,
      });
      if (result?.job) observe(result.job);
      setConfirmingContinue(false);
      setNotice('İşlem devam ettiriliyor.');
      await load();
      onChanged?.();
    } catch (failure) {
      if (failure.name !== 'AbortError') setError(failure.message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <Section
      title="Webmail (Roundcube)"
      description="Bu mail domain için paylaşımlı Roundcube webmail eşlemesi ve SSL erişimi."
      actions={<Button icon="refresh" disabled={busy} onClick={load}>Yenile</Button>}
    >
      <div className="ws-section-body">
        <ErrorNotice error={error} />
        {notice && <p role="status" className="ws-notice">{notice}</p>}

        {data === undefined ? (
          <div className="ws-loading"><span className="ws-spinner" />Webmail durumu yükleniyor…</div>
        ) : mapping ? (
          <>
            <KeyValues items={[
              ['Webmail Adresi', (
                <a key="url" href={webmailUrl} target="_blank" rel="noreferrer" style={{ fontWeight: 600 }}>
                  {webmailUrl} ↗
                </a>
              )],
              ['Durum', <Badge key="status" state={mappingBadgeState(mapping.state)}>{mappingBadgeLabel(mapping.state)}</Badge>],
              ['Hostname', mapping.hostname],
              ['Sertifika ID', <code>{mapping.certificateId}</code>],
              ['Revizyon', mapping.revision],
              ['Son Güncelleme', formatDate(mapping.updatedAt)],
              ...(job ? [['İlgili Job', `${job.status} (${job.id.slice(0, 8)})`]] : []),
            ]} />

            <div className="ws-actions" style={{ marginTop: 16 }}>
              {mapping.state === 'active' && (
                <a className="ws-button ws-button-primary" href={webmailUrl} target="_blank" rel="noreferrer">
                  Webmail’e Git ↗
                </a>
              )}
              {actions?.continuation && (
                <Button variant="primary" disabled={busy} onClick={() => setConfirmingContinue(true)}>
                  Askıda Kalan İşlemi Devam Ettir
                </Button>
              )}
              <Button
                variant="danger"
                disabled={busy || mapping.state === 'removing'}
                onClick={handleDeletePreview}
              >
                Webmail Bağlantısını Kaldır
              </Button>
            </div>
          </>
        ) : (
          <>
            <EmptyState
              icon="mail"
              title="Webmail henüz bağlı değil"
              detail={`webmail.${domain.domainName} için Roundcube eşlemesi bulunamadı. Aşağıdan SSL sertifikası seçerek tek tıkla bağlayabilirsiniz.`}
            />
            <div className="ws-form-grid" style={{ marginTop: 16 }}>
              <label>
                Kullanılacak SSL Sertifikası
                <select
                  value={selectedCertId}
                  onChange={(event) => {
                    setSelectedCertId(event.target.value);
                    setBindPreview(null);
                  }}
                  disabled={busy || certificates.length === 0}
                >
                  {certificates.length === 0 && <option value="">Sertifika bulunamadı</option>}
                  {certificates.map((cert) => {
                    const host = `webmail.${domain.domainName}`;
                    const matches = cert.primaryDomain === host
                      || (Array.isArray(cert.domains) && cert.domains.includes(host))
                      || (Array.isArray(cert.subjectAlternativeNames) && cert.subjectAlternativeNames.includes(host));
                    return (
                      <option key={cert.id} value={cert.id}>
                        {cert.primaryDomain} ({cert.id.slice(0, 8)}) {matches ? '✓ (uygun)' : ''}
                      </option>
                    );
                  })}
                </select>
              </label>
              <div className="ws-actions">
                <Button
                  disabled={busy || !selectedCertId}
                  onClick={handleBindPreview}
                >
                  {busy ? 'Hesaplanıyor…' : 'Önizleme Oluştur'}
                </Button>
              </div>
            </div>

            {bindPreview && (
              <div style={{ marginTop: 16 }}>
                <KeyValues items={[
                  ['Hedef Hostname', bindPreview.hostname],
                  ['Hazır', <Badge key="ready" state={bindPreview.readyToApply ? 'active' : 'warning'}>{bindPreview.readyToApply ? 'Hazır' : 'Blocker var'}</Badge>],
                  ['Preview Digest', <code>{bindPreview.previewDigest}</code>],
                ]} />
                <div className="ws-actions" style={{ marginTop: 16 }}>
                  <Button
                    variant="primary"
                    disabled={busy || !bindPreview.readyToApply}
                    onClick={() => setConfirmingBind(true)}
                  >
                    Webmail (Roundcube) Bağla
                  </Button>
                </div>
              </div>
            )}
          </>
        )}
      </div>

      {confirmingBind && bindPreview && (
        <ConfirmDialog
          title="Roundcube Webmail Bağla"
          message={`webmail.${domain.domainName} adresi Roundcube webmail arayüzüne yönlendirilecek ve Nginx konfigürasyonu güncellenecek.`}
          confirmation={bindPreview.confirmation}
          busy={busy}
          error={error}
          onCancel={() => setConfirmingBind(false)}
          onConfirm={handleBindConfirm}
          confirmLabel="Webmail Bağla"
        />
      )}

      {confirmingDelete && deletePreview && (
        <ConfirmDialog
          title="Roundcube Webmail Bağlantısını Kaldır"
          message={`webmail.${domain.domainName} için Roundcube Nginx yönlendirmesi ve domain eşlemesi kaldırılacak.`}
          confirmation={deletePreview.confirmation}
          busy={busy}
          error={error}
          onCancel={() => setConfirmingDelete(false)}
          onConfirm={handleDeleteConfirm}
          confirmLabel="Bağlantıyı Kaldır"
        />
      )}

      {confirmingContinue && actions?.continuation && (
        <ConfirmDialog
          title="Webmail İşlemini Devam Ettir"
          message="Yarıda veya askıda kalan Roundcube webmail uygulama işlemi yeniden başlatılacak."
          confirmation={actions.continuation}
          busy={busy}
          error={error}
          onCancel={() => setConfirmingContinue(false)}
          onConfirm={handleContinue}
          confirmLabel="Devam Ettir"
        />
      )}
    </Section>
  );
}

export const mailWebmailPanelInternals = Object.freeze({
  mappingBadgeState,
  mappingBadgeLabel,
});
