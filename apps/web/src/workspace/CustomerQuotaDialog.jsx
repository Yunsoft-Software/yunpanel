import { useEffect, useRef, useState } from 'react';
import { Button, ErrorNotice, Modal } from './PanelKit.jsx';
import { useUnsavedChanges } from './UnsavedChanges.jsx';
import { hostingAccountMessage } from './hosting-account-client.js';

function toQuotaInput(value) {
  return value !== null && value !== undefined ? String(value) : '';
}

export function CustomerQuotaDialog({ account, reseller = null, client, onClose, onSaved }) {
  const initialWebsites = toQuotaInput(account?.quotas?.maxWebsites);
  const initialDatabases = toQuotaInput(account?.quotas?.maxDatabases);
  const initialDisk = toQuotaInput(account?.quotas?.maxDiskMb);
  const initialTraffic = toQuotaInput(account?.quotas?.maxTrafficMb);
  const initialEnforceDisk = account?.quotaEnforcement?.disk === true && initialDisk !== '';
  const initialEnforceTraffic = account?.quotaEnforcement?.traffic === true && initialTraffic !== '';

  const [form, setForm] = useState(() => ({
    maxWebsites: initialWebsites,
    maxDatabases: initialDatabases,
    maxDiskMb: initialDisk,
    maxTrafficMb: initialTraffic,
    enforceDisk: initialEnforceDisk,
    enforceTraffic: initialEnforceTraffic,
  }));
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);
  const [discard, setDiscard] = useState(false);
  const pending = useRef(false);
  const mounted = useRef(true);

  useEffect(() => {
    mounted.current = true;
    return () => { mounted.current = false; };
  }, []);

  const hasDiskLimit = form.maxDiskMb.trim() !== '';
  const hasTrafficLimit = form.maxTrafficMb.trim() !== '';
  const effectiveEnforceDisk = hasDiskLimit && form.enforceDisk;
  const effectiveEnforceTraffic = hasTrafficLimit && form.enforceTraffic;

  const dirty = form.maxWebsites !== initialWebsites
    || form.maxDatabases !== initialDatabases
    || form.maxDiskMb !== initialDisk
    || form.maxTrafficMb !== initialTraffic
    || effectiveEnforceDisk !== initialEnforceDisk
    || effectiveEnforceTraffic !== initialEnforceTraffic;
  const reconcile = Boolean(error?.reconcile);
  useUnsavedChanges(dirty || busy);

  function close() {
    if (pending.current) return;
    if (dirty && !reconcile && !discard) setDiscard(true);
    else onClose();
  }

  function update(key, value) {
    setForm((current) => {
      const next = { ...current, [key]: value };
      if (key === 'maxDiskMb' && String(value).trim() === '') {
        next.enforceDisk = false;
      }
      if (key === 'maxTrafficMb' && String(value).trim() === '') {
        next.enforceTraffic = false;
      }
      return next;
    });
    if (!reconcile) setError(null);
  }

  async function submit(event) {
    event.preventDefault();
    if (pending.current || reconcile) return;
    pending.current = true;
    setBusy(true);
    setError(null);
    try {
      const payload = {
        maxWebsites: form.maxWebsites,
        maxDatabases: form.maxDatabases,
        maxDiskMb: form.maxDiskMb,
        maxTrafficMb: form.maxTrafficMb,
        enforceDisk: effectiveEnforceDisk,
        enforceTraffic: effectiveEnforceTraffic,
      };
      const result = await client.current.mutate({ action: 'quotas', account, form: payload });
      if (mounted.current) onSaved(`${result.account.username} müşterisinin kaynak kotaları güncellendi.`);
    } catch (failure) {
      if (mounted.current && failure.name !== 'AbortError') setError(failure);
    } finally {
      pending.current = false;
      if (mounted.current) setBusy(false);
    }
  }

  return (
    <Modal title={`${account.username} · Kaynak Kotalarını Yönet`} onClose={close} busy={busy}>
      {discard ? (
        <>
          <p>Kaydedilmemiş kota bilgileri bırakılacak. Pencereyi kapatmak istiyor musunuz?</p>
          <footer className="ws-modal-footer">
            <Button onClick={() => setDiscard(false)}>Düzenlemeye dön</Button>
            <Button variant="danger" onClick={onClose}>Değişiklikleri bırak</Button>
          </footer>
        </>
      ) : (
        <form className="ws-form" onSubmit={submit}>
          <ErrorNotice error={error ? (hostingAccountMessage(error) || error.message) : null} />
          {reconcile && (
            <p role="alert">Sonuç kesin doğrulanamadı. İşlemi tekrar göndermeyin; pencereyi kapatıp güncel hesap listesini yeniden okuyun.</p>
          )}
          <fieldset disabled={busy || reconcile}>
            <p>
              <strong>{account.username}</strong> müşterisine ayrılacak barındırma kaynak kotalarını belirleyin. Sınırsız yapmak için ilgili alanı boş bırakın.
            </p>
            <p className="ws-muted">
              Web Sitesi Kotası yeni site tahsisinde (bekleyen tahsisler dahil), Veritabanı Kotası ise yeni veritabanı oluşturma, bağlama ve WordPress kurulumlarında uygulanır. Disk yazma kotası ve aylık trafik sınırı isteğe bağlıdır; aşağıdaki seçeneklerle açılıp kapatılabilir.
            </p>
            {reseller?.limits?.maxWebsites !== null && reseller?.limits?.maxWebsites !== undefined && (
              <p className="ws-muted">Maksimum bayi site limitiniz: {reseller.limits.maxWebsites} web sitesi.</p>
            )}
            <label>
              Web Sitesi Kotası
              <input
                type="number"
                min="0"
                value={form.maxWebsites}
                onChange={(event) => update('maxWebsites', event.target.value)}
                placeholder="Sınırsız için boş bırakın"
              />
            </label>
            <label>
              Veritabanı Kotası
              <input
                type="number"
                min="0"
                value={form.maxDatabases}
                onChange={(event) => update('maxDatabases', event.target.value)}
                placeholder="Örn: 2"
              />
            </label>
            <label>
              Disk Kotası (MB)
              <input
                type="number"
                min="0"
                value={form.maxDiskMb}
                onChange={(event) => update('maxDiskMb', event.target.value)}
                placeholder="Örn: 1024"
              />
            </label>
            <label className="ws-check">
              <input
                type="checkbox"
                checked={effectiveEnforceDisk}
                disabled={!hasDiskLimit}
                onChange={(event) => update('enforceDisk', event.target.checked)}
              />
              <span>
                <strong>Disk yazma kotasını uygula</strong>
                <span className="ws-field-hint" style={{ display: 'block', marginTop: '0.2rem' }}>
                  Yalnızca panelin ölçülebilen ve tekil kökleri ayrışan dosya yazma yollarında uygulanır; iç içe/paylaşımlı köklerde yazma güvenli hata ile durdurulur. Terminal, PHP ve harici yazmalar işletim sistemi sert kotası değildir; silme işlemleri her zaman açıktır.
                </span>
              </span>
            </label>
            <label>
              Aylık Trafik Kotası (MB)
              <input
                type="number"
                min="0"
                value={form.maxTrafficMb}
                onChange={(event) => update('maxTrafficMb', event.target.value)}
                placeholder="Örn: 10240"
              />
            </label>
            <label className="ws-check">
              <input
                type="checkbox"
                checked={effectiveEnforceTraffic}
                disabled={!hasTrafficLimit}
                onChange={(event) => update('enforceTraffic', event.target.checked)}
              />
              <span>
                <strong>Aylık trafik sınırını uygula</strong>
                <span className="ws-field-hint" style={{ display: 'block', marginTop: '0.2rem' }}>
                  Aylık eşikte yalnızca ilgili yönetilen sitenin yeni HTTP isteklerini sınırlar; ay başında otomatik açılır veya bu seçenek kapatılarak hemen geri alınır.
                </span>
              </span>
            </label>
          </fieldset>
          <footer className="ws-modal-footer">
            <Button disabled={busy} onClick={close}>{reconcile ? 'Kapat ve listeyi yenile' : 'Vazgeç'}</Button>
            <Button type="submit" variant="primary" disabled={busy || reconcile || !dirty}>
              {busy ? 'Kaydediliyor…' : 'Kotaları Kaydet'}
            </Button>
          </footer>
        </form>
      )}
    </Modal>
  );
}

export default CustomerQuotaDialog;
