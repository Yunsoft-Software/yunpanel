import { useRef, useState } from 'react';
import { getMailDomain, previewMailConfiguration, applyMailConfiguration } from './mail-client.js';
import { waitForJob } from '../api.js';
import { useWorkspace } from './WorkspaceContext.jsx';
import { Button, ConfirmDialog, ErrorNotice, Section } from './PanelKit.jsx';

// Site-level configuration activation: no global config inventory or server logs.
export default function SiteMailApplyPanel({ domain, onChanged }) {
  const { observe, updateJob, canManage } = useWorkspace();
  const pending = useRef(false);
  const [target, setTarget] = useState(null), [busy, setBusy] = useState(false);
  const [error, setError] = useState(null), [notice, setNotice] = useState(null);
  async function prepare() {
    if (pending.current || !canManage) return;
    pending.current = true; setBusy(true); setError(null); setNotice(null);
    try {
      const current = await getMailDomain(domain.id);
      if (current?.id !== domain.id || current.managementMode !== 'local') throw new Error('Posta alan adı doğrulanamadı.');
      const status = current.status === 'disabled' ? 'disabled' : 'enabled';
      const preview = await previewMailConfiguration(domain.id, { expectedRevision: current.revision, status });
      if (!preview?.readyToApply || !preview.configuration?.sha256 || !preview.confirmation || !preview.previewDigest) {
        throw new Error('Posta değişiklikleri uygulanmaya hazır değil. Sunucu yöneticisiyle hizmet durumunu kontrol edin.');
      }
      setTarget({ revision: current.revision, status, preview, job: null });
    } catch (failure) { if (failure.name !== 'AbortError') setError(failure.message); }
    finally { pending.current = false; setBusy(false); }
  }
  async function apply() {
    if (!target || pending.current || !canManage) return;
    pending.current = true; setBusy(true); setError(null);
    try {
      let job = target.job;
      if (!job) {
        job = await applyMailConfiguration(domain.id, { expectedRevision: target.revision, status: target.status, preview: target.preview });
        if (!job?.id) throw new Error('Posta uygulama işi alınamadı.');
        setTarget((value) => value ? { ...value, job } : value); observe(job);
      }
      if (['failed', 'cancelled'].includes(job.status)) throw new Error('İşlem başarısız veya iptal edilmiş. Kör tekrar yapılmadı; sunucu yöneticisi işlem kaydını incelemeli.');
      const terminal = job.status === 'succeeded' ? job : await waitForJob(job.id);
      updateJob(terminal); setTarget((value) => value ? { ...value, job: terminal } : value);
      if (terminal.status !== 'succeeded') throw new Error('Posta değişiklikleri tamamlanmadı. İşlem kaydını kontrol edin.');
      setTarget(null); setNotice('Bu sitenin posta değişiklikleri uygulandı.'); onChanged?.();
    } catch (failure) { if (failure.name !== 'AbortError') setError(failure.message); }
    finally { pending.current = false; setBusy(false); }
  }
  return <Section title="Posta değişikliklerini uygula"><div className="ws-section-body"><p className="ws-muted">Posta kutusu ve yönlendirme değişikliklerini sunucuya uygulayın. Posta hizmetinin mevcut etkin/devre dışı durumu korunur.</p>{!target && <ErrorNotice error={error} />}{notice && <p className="ws-notice" role="status">{notice}</p>}<Button variant="primary" disabled={busy || !canManage} onClick={prepare}>{busy ? 'Kontrol ediliyor…' : 'Değişiklikleri gözden geçir'}</Button></div>{target && <ConfirmDialog title="Site posta değişikliklerini uygula" message={`${domain.domainName} için mevcut posta ayarları ve hesap değişiklikleri uygulanacak. Hizmet ${target.status === 'enabled' ? 'etkin' : 'devre dışı'} kalacak. İşlem başarıyla tamamlanmadan uygulandı sayılmaz.`} confirmation={domain.domainName} confirmLabel="Değişiklikleri uygula" busy={busy} error={error} onCancel={() => setTarget(null)} onConfirm={apply} />}</Section>;
}
