import { useState } from 'react';
import { panelRequest, waitForJob } from './api.js';

export default function SystemUpdatePanel({ server }) {
  const [packageState, setPackageState] = useState(null);
  const [busy, setBusy] = useState(false);
  const [confirming, setConfirming] = useState(false);
  const [message, setMessage] = useState('Check the APT repository for a YunPanel update.');
  const [error, setError] = useState(null);

  async function runOperation(operation) {
    if (!server || busy) return;
    setBusy(true);
    setError(null);
    setConfirming(false);
    setMessage(operation === 'upgrade' ? 'Installing the YunPanel update…' : 'Checking package versions…');
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
        ? `Upgraded ${completed.result.previousVersion} → ${completed.result.installedVersion}. Services are restarting.`
        : completed.result?.updateAvailable
          ? `Update ${completed.result.candidateVersion} is ready.`
          : `YunPanel ${completed.result?.installedVersion ?? 'package'} is current.`);
    } catch (operationError) {
      setError(operationError.message);
      setMessage('Package operation did not complete.');
    } finally {
      setBusy(false);
    }
  }

  return (
    <section className="panel domain-panel" aria-label="YunPanel package updates">
      <div className="panel-heading">
        <div>
          <p className="eyebrow">APT package</p>
          <h2>YunPanel updates</h2>
        </div>
        <span className="panel-meta">{busy ? 'running' : packageState?.updateAvailable ? 'update available' : 'ready'}</span>
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
          <span>Installed</span>
          <strong>{packageState?.installedVersion ?? 'Not checked'}</strong>
        </div>
        <div className="domain-cell">
          <span>Candidate</span>
          <strong>{packageState?.candidateVersion ?? 'Not checked'}</strong>
        </div>
        <div className="topbar-actions">
          <button className="secondary-button" type="button" disabled={!server || busy} onClick={() => runOperation('inspect')}>
            {busy ? 'Working…' : 'Check updates'}
          </button>
          {packageState?.updateAvailable && !confirming && (
            <button className="primary-button" type="button" disabled={busy} onClick={() => setConfirming(true)}>
              Upgrade YunPanel
            </button>
          )}
          {confirming && (
            <>
              <button className="secondary-button" type="button" disabled={busy} onClick={() => setConfirming(false)}>Cancel</button>
              <button className="primary-button" type="button" disabled={busy} onClick={() => runOperation('upgrade')}>Confirm upgrade</button>
            </>
          )}
        </div>
      </div>
      {error && <div className="server-last-seen">Error · {error}</div>}
    </section>
  );
}
