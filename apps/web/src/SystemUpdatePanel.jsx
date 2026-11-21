import { useState } from 'react';
import { panelRequest, waitForJob } from './api.js';

export default function SystemUpdatePanel({ server }) {
  const [packageState, setPackageState] = useState(null);
  const [busy, setBusy] = useState(false);
  const [confirming, setConfirming] = useState(false);
  const [message, setMessage] = useState('YunPanel paketi için güncel sürümü APT deposundan denetleyin.');
  const [error, setError] = useState(null);

  async function runOperation(operation) {
    if (!server || busy) return;
    setBusy(true);
    setError(null);
    setConfirming(false);
    setMessage(operation === 'upgrade' ? 'YunPanel güncellemesi kuruluyor…' : 'Paket sürümleri denetleniyor…');
    try {
      const job = await panelRequest(
        `/servers/${server.id}/system/${operation === 'upgrade' ? 'upgrade' : 'packages/inspect'}`,
        operation === 'upgrade'
          ? { method: 'POST', body: { confirmation: 'upgrade-yunpanel' } }
          : { method: 'POST', body: {} },
      );
      const completed = await waitForJob(job.id, { attempts: 180 });
      setPackageState(completed.result);
      setMessage(completed.result?.upgraded
        ? `${completed.result.previousVersion} → ${completed.result.installedVersion} sürümüne güncellendi. Servisler yeniden başlatılıyor.`
        : completed.result?.updateAvailable
          ? `${completed.result.candidateVersion} güncellemesi hazır.`
          : `YunPanel ${completed.result?.installedVersion ?? 'paketi'} güncel.`);
    } catch (operationError) {
      setError(operationError.message);
      setMessage('Paket işlemi tamamlanamadı.');
    } finally {
      setBusy(false);
    }
  }

  return (
    <section className="panel domain-panel" aria-label="YunPanel paket güncellemeleri">
      <div className="panel-heading">
        <div>
          <p className="eyebrow">APT Paketi</p>
          <h2>YunPanel Güncellemeleri</h2>
        </div>
        <span className="panel-meta">{busy ? 'Çalışıyor' : packageState?.updateAvailable ? 'Güncelleme var' : 'Hazır'}</span>
      </div>
      <div className="domain-row">
        <div className="domain-primary">
          <span className={`status-dot ${error ? 'failed' : packageState?.updateAvailable ? 'pending' : 'online'}`} />
          <div>
            <strong>yunpanel</strong>
            <span>{message}</span>
          </div>
        </div>
        <div className="domain-cell">
          <span>Kurulu sürüm</span>
          <strong>{packageState?.installedVersion ?? 'Henüz denetlenmedi'}</strong>
        </div>
        <div className="domain-cell">
          <span>Aday sürüm</span>
          <strong>{packageState?.candidateVersion ?? 'Henüz denetlenmedi'}</strong>
        </div>
        <div className="topbar-actions">
          <button className="secondary-button" type="button" disabled={!server || busy} onClick={() => runOperation('inspect')}>
            {busy ? 'Denetleniyor…' : 'Güncellemeleri denetle'}
          </button>
          {packageState?.updateAvailable && !confirming && (
            <button className="primary-button" type="button" disabled={busy} onClick={() => setConfirming(true)}>
              YunPanel&apos;i güncelle
            </button>
          )}
          {confirming && (
            <>
              <button className="secondary-button" type="button" disabled={busy} onClick={() => setConfirming(false)}>Vazgeç</button>
              <button className="primary-button" type="button" disabled={busy} onClick={() => runOperation('upgrade')}>Güncellemeyi onayla</button>
            </>
          )}
        </div>
      </div>
      {error && <div className="server-last-seen">Hata · {error}</div>}
    </section>
  );
}
