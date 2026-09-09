import MfaSettings from './MfaSettings.jsx';

const noop = () => {};

// Preserve the merged branch's component contract without a second factor UI.
export default function MfaPanel({ onSessionChanged = noop, onSignedOut = noop, onBusyChange = noop, onRecoveryVisibilityChange = noop, disabled = false }) {
  return <fieldset className="mfa-container" disabled={disabled}>
    <MfaSettings onSession={onSessionChanged} onSignedOut={onSignedOut} onBusy={onBusyChange} onSensitive={onRecoveryVisibilityChange} />
  </fieldset>;
}
