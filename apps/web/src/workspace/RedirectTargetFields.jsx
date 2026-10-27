// Target of a forwarding-only Domain; validated again by the hosting model and the server.
export default function RedirectTargetFields({ target, disabled, onChange }) {
  const change = (key, value) => onChange({ ...target, [key]: value });
  return <fieldset disabled={disabled} className="ws-form">
    <legend>Yönlendirme</legend>
    <div className="ws-form-grid">
      <label>Hedef adres<input type="url" value={target.url} required maxLength="512" placeholder="https://yeni-alan.com" spellCheck={false}
        onChange={event => change('url', event.target.value)} /></label>
      <label>Tür<select value={target.status} onChange={event => change('status', Number(event.target.value))}>
        <option value={301}>Kalıcı (301)</option><option value={302}>Geçici (302)</option></select></label>
    </div>
    <label className="ws-check"><input type="checkbox" checked={target.preservePath}
      onChange={event => change('preservePath', event.target.checked)} />Yolu koru (/sayfa → hedef/sayfa)</label>
  </fieldset>;
}
