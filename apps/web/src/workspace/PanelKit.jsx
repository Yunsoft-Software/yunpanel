import { useEffect, useId, useRef, useState } from 'react';
import { Link } from 'react-router';
import { formatDate } from './site-model.js';

const glyphs = {
  dashboard: 'M3 3h7v7H3zM14 3h7v7h-7zM3 14h7v7H3zM14 14h7v7h-7z',
  globe: 'M21 12a9 9 0 1 1-18 0 9 9 0 0 1 18 0ZM3 12h18M12 3c4 5 4 13 0 18-4-5-4-13 0-18Z',
  server: 'M4 3h16v7H4zM4 14h16v7H4zM7 6h.01M7 17h.01M11 6h6M11 17h6',
  code: 'm8 6-6 6 6 6m8-12 6 6-6 6m-3-15-2 18',
  database: 'M20 6c0 2-4 3-8 3S4 8 4 6s4-3 8-3 8 1 8 3ZM4 6v12c0 2 4 3 8 3s8-1 8-3V6M4 12c0 2 4 3 8 3s8-1 8-3',
  box: 'm12 3 9 5-9 5-9-5 9-5ZM3 8v9l9 5 9-5V8M12 13v9m-5-16 9 5',
  mail: 'M3 5h18v14H3zM3 5l9 8 9-8',
  archive: 'M3 3h18v5H3zM5 8v13h14V8M9 12h6',
  jobs: 'M9 5h12M9 12h12M9 19h12M3 5h.01M3 12h.01M3 19h.01',
  shield: 'm12 2 8 3v7c0 5-8 10-8 10S4 17 4 12V5l8-3Zm-4 10 3 3 5-6',
  settings: 'M12 8a4 4 0 1 1 0 8 4 4 0 0 1 0-8ZM12 2v3m0 14v3M2 12h3m14 0h3M5 5l2 2m10 10 2 2M5 19l2-2M17 7l2-2',
  search: 'M17 10a7 7 0 1 1-14 0 7 7 0 0 1 14 0Zm-2 5 6 6',
  plus: 'M12 4v16M4 12h16',
  arrow: 'M4 12h16m-6-6 6 6-6 6',
  external: 'M14 3h7v7m0-7L10 14M10 3H3v18h18v-7',
  chevron: 'm6 9 6 6 6-6',
  check: 'm5 12 4 4L19 6',
  alert: 'm12 3 10 18H2L12 3Zm0 6v5m0 3h.01',
  menu: 'M3 5h18M3 12h18M3 19h18',
  close: 'm5 5 14 14M5 19 19 5',
  refresh: 'M20 7v5h-5M4 17v-5h5M5 7a8 8 0 0 1 13-3l2 3M4 17l2 3a8 8 0 0 0 13-3',
  file: 'M4 2h10l6 6v14H4zM14 2v6h6M8 13h8M8 17h6',
  terminal: 'm4 6 6 6-6 6m9 0h7',
  clock: 'M21 12a9 9 0 1 1-18 0 9 9 0 0 1 18 0ZM12 7v5l3 2',
  user: 'M16 7a4 4 0 1 1-8 0 4 4 0 0 1 8 0ZM4 21v-2a8 8 0 0 1 16 0v2',
  git: 'M6 3v12a5 5 0 0 0 10 0V9M3 3h6M13 7h6',
};
export function Icon({ name, size = 18 }) {
  return <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d={glyphs[name] ?? glyphs.box} /></svg>;
}
export function Button({ children, icon, variant = 'secondary', className = '', type = 'button', ...props }) {
  return <button type={type} className={`ws-button ws-button-${variant} ${className}`} {...props}>{icon && <Icon name={icon} />}{children}</button>;
}
export function LinkButton({ to, children, icon, variant = 'secondary', ...props }) {
  return <Link to={to} className={`ws-button ws-button-${variant}`} {...props}>{icon && <Icon name={icon} />}{children}</Link>;
}
const statusLabels = { active: 'Aktif', online: 'Çevrimiçi', succeeded: 'Tamamlandı', running: 'Çalışıyor', queued: 'Sırada', pending: 'Bekliyor', draft: 'Taslak', staged: 'Hazırlandı', error: 'Hata', failed: 'Başarısız', cancelled: 'İptal', expired: 'Süresi doldu', warning: 'Kontrol gerekli', offline: 'Çevrimdışı', off: 'Kapalı', staging: 'Test', unknown: 'Bilinmiyor', deploying: 'Dağıtılıyor' };
export function Badge({ state = 'unknown', children }) {
  const tone = ['active', 'online', 'succeeded'].includes(state) ? 'good' : ['error', 'failed', 'expired', 'offline'].includes(state) ? 'bad' : ['warning', 'pending', 'staging'].includes(state) ? 'warn' : ['running', 'deploying', 'queued', 'staged'].includes(state) ? 'info' : 'neutral';
  return <span className={`ws-badge ws-badge-${tone}`}><span aria-hidden="true" />{children ?? statusLabels[state] ?? state}</span>;
}
export function PageHeading({ title, description, actions, eyebrow }) {
  return <header className="ws-page-heading"><div>{eyebrow && <p className="ws-eyebrow">{eyebrow}</p>}<h1>{title}</h1>{description && <p>{description}</p>}</div>{actions && <div className="ws-actions">{actions}</div>}</header>;
}
export function Section({ title, description, actions, children, className = '' }) {
  return <section className={`ws-section ${className}`}><header className="ws-section-heading"><div><h2>{title}</h2>{description && <p>{description}</p>}</div>{actions}</header>{children}</section>;
}
export function EmptyState({ title, detail, action, icon = 'box' }) {
  return <div className="ws-empty"><span className="ws-empty-icon"><Icon name={icon} size={26} /></span><h3>{title}</h3><p>{detail}</p>{action}</div>;
}
export function CollectionNotice({ resource, label }) {
  if (resource.status === 'ready') return null;
  if (resource.status === 'loading') return <div className="ws-loading" role="status"><span className="ws-spinner" />{label} yükleniyor…</div>;
  return <div className="ws-notice ws-notice-warn" role="alert"><div><strong>{label}</strong><p>{resource.error?.message ?? 'Veriler alınamadı.'}{resource.status === 'stale' && ` Son başarılı güncelleme: ${formatDate(resource.updatedAt)}.`}</p></div><Button onClick={resource.refresh} icon="refresh">Yeniden dene</Button></div>;
}
export function ErrorNotice({ error }) {
  return error ? <div role="alert" className="ws-notice ws-notice-error"><Icon name="alert" /><span>{error}</span></div> : null;
}
export function KeyValues({ items }) {
  return <dl className="ws-keyvalues">{items.map(([label, value]) => <div key={label}><dt>{label}</dt><dd>{value ?? '—'}</dd></div>)}</dl>;
}
export function Modal({ title, children, onClose, busy = false, wide = false }) {
  const ref = useRef(null); const titleId = useId();
  const onCloseRef = useRef(onClose); onCloseRef.current = onClose;
  useEffect(() => {
    const dialog = ref.current; const previous = document.activeElement;
    if (!dialog.open) dialog.showModal();
    return () => { dialog.close(); if (previous?.isConnected) previous.focus(); };
  }, []);
  return <dialog ref={ref} className={`ws-modal ${wide ? 'ws-modal-wide' : ''}`} aria-labelledby={titleId} onCancel={(event) => { event.preventDefault(); if (!busy) onCloseRef.current(); }}><header><h2 id={titleId}>{title}</h2><Button aria-label="Pencereyi kapat" disabled={busy} onClick={onClose} icon="close" /></header><div className="ws-modal-body">{children}</div></dialog>;
}
export function ConfirmDialog({ title, message, onCancel, onConfirm, busy = false, confirmation, error, confirmLabel = 'Onayla' }) {
  const [value, setValue] = useState('');
  return <Modal title={title} onClose={onCancel} busy={busy}><p className="ws-muted">{message}</p><ErrorNotice error={error} /><form onSubmit={(event) => { event.preventDefault(); if (!busy && (!confirmation || value === confirmation)) onConfirm(); }}>
    {confirmation && <label>Onaylamak için <strong>{confirmation}</strong> yazın<input value={value} onChange={(event) => setValue(event.target.value)} autoComplete="off" spellCheck={false} required /></label>}
    <footer className="ws-modal-footer"><Button disabled={busy} onClick={onCancel}>Vazgeç</Button><Button variant="danger" type="submit" disabled={busy || (confirmation && value !== confirmation)}>{busy ? 'İşleniyor…' : confirmLabel}</Button></footer>
  </form></Modal>;
}
