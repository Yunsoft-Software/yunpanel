import { Children, cloneElement, createContext, useContext, useEffect, useId, useRef, useState } from 'react';
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
  folder: 'M4 4h6l2 2h8a2 2 0 0 1 2 2v10a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V6a2 2 0 0 1 2-2Z',
  trash: 'M3 6h18m-2 0v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2',
  upload: 'M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4m14-7-5-5-5 5m5-5v12',
  download: 'M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4m4-5 5 5 5-5m-5 5V3',
  terminal: 'm4 6 6 6-6 6m9 0h7',
  clock: 'M21 12a9 9 0 1 1-18 0 9 9 0 0 1 18 0ZM12 7v5l3 2',
  user: 'M16 7a4 4 0 1 1-8 0 4 4 0 0 1 8 0ZM4 21v-2a8 8 0 0 1 16 0v2',
  git: 'M6 3v12a5 5 0 0 0 10 0V9M3 3h6M13 7h6',
  bell: 'M18 8A6 6 0 0 0 6 8c0 7-3 9-3 9h18s-3-2-3-9M13.73 21a2 2 0 0 1-3.46 0',
  sun: 'M12 7a5 5 0 1 0 0 10 5 5 0 0 0 0-10ZM12 1v2m0 18v2M4.22 4.22l1.42 1.42m12.72 12.72 1.42 1.42M1 12h2m18 0h2M4.22 19.78l1.42-1.42M18.36 5.64l1.42-1.42',
  moon: 'M21 12.79A9 9 0 1 1 11.21 3 7 7 0 0 0 21 12.79Z',
  sidebar: 'M3 4h18v16H3zM9 4v16',
  logout: 'M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4m7 14 5-5-5-5m5 5H9',
  sparkles: 'M12 3l1.7 4.7L18.5 9.5l-4.8 1.8L12 16l-1.7-4.7L5.5 9.5l4.8-1.8L12 3zM19 15l.8 2.2L22 18l-2.2.8L19 21l-.8-2.2L16 18l2.2-.8L19 15z',
  chevronsUpDown: 'm7 15 5 5 5-5M7 9l5-5 5 5',
};
export function Icon({ name, size = 18 }) {
  return <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d={glyphs[name] ?? glyphs.box} /></svg>;
}
export function Button({ children, icon, variant = 'secondary', className = '', type = 'button', ...props }) {
  return <button type={type} className={`ws-button ws-button-${variant} ${className}`.trim()} {...props}>{icon && <Icon name={icon} />}{children}</button>;
}
export function LinkButton({ to, children, icon, variant = 'secondary', className = '', ...props }) {
  return <Link to={to} className={`ws-button ws-button-${variant} ${className}`.trim()} {...props}>{icon && <Icon name={icon} />}{children}</Link>;
}
const statusLabels = { active: 'Aktif', online: 'Çevrimiçi', succeeded: 'Tamamlandı', running: 'Çalışıyor', queued: 'Sırada', pending: 'Bekliyor', draft: 'Taslak', staged: 'Hazırlandı', saving: 'Kaydediliyor', saved: 'Kaydedildi', applying: 'Uygulanıyor', applied: 'Uygulandı', verifying: 'Doğrulanıyor', verified: 'Doğrulandı', partial: 'Kısmi başarılı', partial_success: 'Kısmi başarılı', error: 'Hata', failed: 'Başarısız', cancelled: 'İptal', expired: 'Süresi doldu', suspended: 'Askıda', warning: 'Kontrol gerekli', offline: 'Çevrimdışı', off: 'Kapalı', staging: 'Test', unknown: 'Bilinmiyor', deploying: 'Dağıtılıyor', healthy: 'Sağlıklı', stale: 'Eski / Gecikmiş', synchronized: 'Uyumlu / Eşit', version_mismatch: 'Sürüm Uyuşmazlığı', stale_cache: 'Eski Önbellek', schema_mismatch: 'Şema Uyuşmazlığı', diverged: 'Farklılaşmış' };
export function Badge({ state = 'unknown', children }) {
  const tone = ['active', 'online', 'succeeded', 'verified', 'applied', 'saved', 'healthy', 'synchronized'].includes(state) ? 'good' : ['error', 'failed', 'expired', 'offline', 'version_mismatch', 'schema_mismatch'].includes(state) ? 'bad' : ['warning', 'pending', 'staging', 'suspended', 'partial', 'partial_success', 'stale', 'stale_cache', 'diverged'].includes(state) ? 'warn' : ['running', 'deploying', 'queued', 'staged', 'saving', 'applying', 'verifying'].includes(state) ? 'info' : 'neutral';
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
  if (resource.status === 'ready' || resource.status === 'disabled') return null;
  if (resource.status === 'loading') return <div className="ws-loading" role="status"><span className="ws-spinner" />{label} yükleniyor…</div>;
  return <div className="ws-notice ws-notice-warn" role="alert"><div><strong>{label}</strong><p>{resource.error?.message ?? 'Veriler alınamadı.'}{resource.status === 'stale' && ` Son başarılı güncelleme: ${formatDate(resource.updatedAt)}.`}</p></div><Button onClick={resource.refresh} icon="refresh">Yeniden dene</Button></div>;
}
export function ErrorNotice({ error }) {
  if (!error) return null;
  const message = typeof error === 'string' ? error : (error?.message ?? (typeof error === 'object' ? JSON.stringify(error) : String(error)));
  return <div role="alert" className="ws-notice ws-notice-error"><Icon name="alert" /><span>{message}</span></div>;
}
export function KeyValues({ items }) {
  return <dl className="ws-keyvalues">{items.map(([label, value]) => {
    let display = value;
    if (value != null && typeof value === 'object' && !value.$$typeof) {
      display = value.message ?? value.label ?? value.name ?? JSON.stringify(value);
    }
    return <div key={label}><dt>{label}</dt><dd>{display ?? '—'}</dd></div>;
  })}</dl>;
}
// Data table with the shared `ws-table` markup. `columns` items are strings or
// `{ label, className, hidden }`; hidden labels stay readable for screen readers.
// When `empty` is given and there are no rows, it is rendered instead.
export function Table({ label, columns, className = 'ws-table', empty = null, children }) {
  if (empty && Children.count(children) === 0) return empty;
  return <div className="ws-table-scroll"><table className={className} role="table" aria-label={label}>
    <thead role="rowgroup"><tr role="row">{columns.map((column) => {
      const { label: text, className: columnClass, hidden = false } = typeof column === 'string' ? { label: column } : column;
      return <th key={text} scope="col" role="columnheader" className={columnClass}>{hidden ? <span className="ws-sr-only">{text}</span> : text}</th>;
    })}</tr></thead>
    <tbody role="rowgroup">{children}</tbody>
  </table></div>;
}
// Label + one form control + optional hint and error, linked with htmlFor and
// aria-describedby. The label wraps the control, as in the existing forms.
export function Field({ label, hint, error, className, children }) {
  const id = useId();
  const control = Children.only(children);
  const controlId = control.props.id ?? `${id}control`;
  const hintId = hint ? `${id}hint` : null;
  const errorId = error ? `${id}error` : null;
  const describedBy = [control.props['aria-describedby'], hintId, errorId].filter(Boolean).join(' ') || undefined;
  return <label className={className} htmlFor={controlId}>{label}
    {cloneElement(control, { id: controlId, 'aria-describedby': describedBy, ...(error ? { 'aria-invalid': true } : {}) })}
    {hint && <span id={hintId} className="ws-field-hint">{hint}</span>}
    {error && <span id={errorId} className="ws-field-hint" role="alert">{error}</span>}
  </label>;
}
// Native select from `{ value, label, disabled }` options.
export function Select({ options, ...props }) {
  return <select {...props}>{options.map((option) => <option key={option.value} value={option.value} disabled={option.disabled}>{option.label}</option>)}</select>;
}
const TAB_KEYS = new Set(['ArrowLeft', 'ArrowRight', 'Home', 'End']);
export function nextTabIndex(key, index, count) {
  if (!TAB_KEYS.has(key) || count < 1) return null;
  if (key === 'Home') return 0;
  if (key === 'End') return count - 1;
  const current = index < 0 ? 0 : index;
  return key === 'ArrowLeft' ? (current - 1 + count) % count : (current + 1) % count;
}
// Accessible tablist: one tab stop, arrow keys/Home/End move and select.
export function Tabs({ label, items, value, onChange, className = '' }) {
  function keyboard(event) {
    if (event.altKey || event.ctrlKey || event.metaKey || event.shiftKey) return;
    const next = nextTabIndex(event.key, items.findIndex((item) => item.id === value), items.length);
    if (next === null) return;
    event.preventDefault();
    onChange(items[next].id);
    event.currentTarget.querySelectorAll('[role="tab"]')[next]?.focus();
  }
  return <div className={`ws-tabs ${className}`.trim()} role="tablist" aria-label={label} onKeyDown={keyboard}>
    {items.map((item) => {
      const selected = item.id === value;
      return <button key={item.id} type="button" role="tab" aria-selected={selected} tabIndex={selected ? 0 : -1}
        className={selected ? 'ws-tab is-active' : 'ws-tab'} onClick={() => onChange(item.id)}>{item.label}</button>;
    })}
  </div>;
}
const ModalVisibilityContext = createContext(true);
const ModalCloseContext = createContext(null);
export function ModalScope({ active, children }) { return <ModalVisibilityContext.Provider value={active === true}>{children}</ModalVisibilityContext.Provider>; }
export function useModalClose() { return useContext(ModalCloseContext); }
export function ModalCloseButton({ children = 'Vazgeç', disabled = false, onClick, ...props }) {
  const requestClose = useModalClose();
  return <Button disabled={disabled} onClick={requestClose ?? onClick} {...props}>{children}</Button>;
}

const modalLayerStack = [];
export function registerModalLayer(id) {
  const existing = modalLayerStack.indexOf(id);
  if (existing !== -1) modalLayerStack.splice(existing, 1);
  modalLayerStack.push(id);
  return () => {
    const idx = modalLayerStack.indexOf(id);
    if (idx !== -1) modalLayerStack.splice(idx, 1);
  };
}
export function isTopModalLayer(id, dialog = null) {
  if (modalLayerStack.length > 0) {
    if (modalLayerStack[modalLayerStack.length - 1] !== id) return false;
  }
  if (dialog && typeof document !== 'undefined') {
    const openDialogs = Array.from(document.querySelectorAll('dialog[open]')).filter((el) => !el.hidden);
    if (openDialogs.length > 1 && openDialogs[openDialogs.length - 1] !== dialog && modalLayerStack.length === 0) {
      return false;
    }
  }
  return true;
}
export function hasOpenModalLayer() {
  return modalLayerStack.length > 0;
}
export function isPointOutsideRect(el, clientX, clientY) {
  if (!el || typeof el.getBoundingClientRect !== 'function') return false;
  const rect = el.getBoundingClientRect();
  if (rect.width === 0 && rect.height === 0) return false;
  return clientX < rect.left || clientX > rect.right || clientY < rect.top || clientY > rect.bottom;
}

const EDITABLE_CONTROL_SELECTOR = 'form input:not([type="hidden"]):not([type="submit"]):not([type="button"]):not([type="reset"]):not([readonly]):not([disabled]), form textarea:not([readonly]):not([disabled]), form select:not([disabled]), [data-modal-track-dirty="true"]';

function readControlValue(control) {
  if (!control) return '';
  if (control.type === 'checkbox' || control.type === 'radio') return Boolean(control.checked);
  if (control.tagName === 'SELECT' && control.multiple) {
    return Array.from(control.selectedOptions ?? [], (opt) => opt.value).join('\u0000');
  }
  if (control.type === 'file') {
    return Array.from(control.files ?? [], (file) => `${file.name}:${file.size}:${file.lastModified}`).join('\u0000');
  }
  return String(control.value ?? '');
}

export function useFormDirtyTracker(containerRef, active, resetKey = 0) {
  const baselineRef = useRef(new Map());
  const touchedRef = useRef(new Set());

  useEffect(() => {
    baselineRef.current = new Map();
    touchedRef.current = new Set();
    const root = containerRef.current;
    if (!active || !root) return undefined;

    const snapshotAll = () => {
      const controls = root.querySelectorAll(EDITABLE_CONTROL_SELECTOR);
      for (const control of controls) {
        if (!baselineRef.current.has(control)) {
          baselineRef.current.set(control, readControlValue(control));
        }
      }
    };
    snapshotAll();

    const handleBeforeInteraction = (event) => {
      const target = event.target;
      if (!target || typeof target.matches !== 'function' || !target.matches(EDITABLE_CONTROL_SELECTOR)) return;
      if (target.type === 'radio') {
        if (!baselineRef.current.has(target)) {
          baselineRef.current.set(target, readControlValue(target));
        }
        return;
      }
      if (!touchedRef.current.has(target)) {
        baselineRef.current.set(target, readControlValue(target));
      }
    };
    const handleMutation = (event) => {
      const target = event.target;
      if (!target || typeof target.matches !== 'function' || !target.matches(EDITABLE_CONTROL_SELECTOR)) return;
      if (!baselineRef.current.has(target)) {
        baselineRef.current.set(target, readControlValue(target));
      }
      touchedRef.current.add(target);
      if (target.type === 'radio' && target.name) {
        const siblings = root.querySelectorAll('input[type="radio"]');
        for (const sibling of siblings) {
          if (sibling.name === target.name) {
            if (!baselineRef.current.has(sibling)) {
              baselineRef.current.set(sibling, readControlValue(sibling));
            }
            touchedRef.current.add(sibling);
          }
        }
      }
    };

    root.addEventListener('focusin', handleBeforeInteraction, true);
    root.addEventListener('pointerdown', handleBeforeInteraction, true);
    root.addEventListener('keydown', handleBeforeInteraction, true);
    root.addEventListener('beforeinput', handleBeforeInteraction, true);
    root.addEventListener('input', handleMutation, true);
    root.addEventListener('change', handleMutation, true);

    const observer = typeof MutationObserver === 'function'
      ? new MutationObserver(() => snapshotAll())
      : null;
    observer?.observe(root, { childList: true, subtree: true, attributes: true, attributeFilter: ['disabled'] });

    return () => {
      observer?.disconnect();
      root.removeEventListener('focusin', handleBeforeInteraction, true);
      root.removeEventListener('pointerdown', handleBeforeInteraction, true);
      root.removeEventListener('keydown', handleBeforeInteraction, true);
      root.removeEventListener('beforeinput', handleBeforeInteraction, true);
      root.removeEventListener('input', handleMutation, true);
      root.removeEventListener('change', handleMutation, true);
    };
  }, [containerRef, active, resetKey]);

  const isDirty = () => {
    const root = containerRef.current;
    if (!root) return false;
    for (const control of touchedRef.current) {
      if (!root.contains(control) || control.disabled) continue;
      if (!baselineRef.current.has(control)) continue;
      if (readControlValue(control) !== baselineRef.current.get(control)) {
        return true;
      }
    }
    return false;
  };

  return { isDirty };
}

export function Modal({
  title,
  children,
  onClose,
  busy = false,
  wide = false,
  dirty = undefined,
  unsavedGuard = 'auto',
  dirtyResetKey = 0,
}) {
  const visible = useContext(ModalVisibilityContext);
  const ref = useRef(null); const titleId = useId(); const modalId = useId();
  const onCloseRef = useRef(onClose); onCloseRef.current = onClose;
  const pointerDownOutsideRef = useRef(false);
  const lastFocusedInsideRef = useRef(null);
  const wasDiscardPromptOpenRef = useRef(false);
  const [discardPromptOpen, setDiscardPromptOpen] = useState(false);
  const tracker = useFormDirtyTracker(ref, visible && unsavedGuard !== false && typeof dirty !== 'boolean', dirtyResetKey);

  useEffect(() => {
    if (!visible) setDiscardPromptOpen(false);
  }, [visible]);

  useEffect(() => {
    const dialog = ref.current;
    if (wasDiscardPromptOpenRef.current && !discardPromptOpen && visible && dialog) {
      const target = (lastFocusedInsideRef.current && dialog.contains(lastFocusedInsideRef.current) && !lastFocusedInsideRef.current.disabled)
        ? lastFocusedInsideRef.current
        : dialog.querySelector('input:not(:disabled), select:not(:disabled), textarea:not(:disabled), button:not(:disabled)');
      if (target && typeof target.focus === 'function') {
        try { target.focus({ preventScroll: true }); } catch {}
      }
    }
    wasDiscardPromptOpenRef.current = discardPromptOpen;
  }, [discardPromptOpen, visible]);

  useEffect(() => {
    const dialog = ref.current; const previous = document.activeElement;
    if (!visible) return;
    const unregister = registerModalLayer(modalId);
    if (dialog && !dialog.open) {
      if (typeof dialog.showModal === 'function') {
        try { dialog.showModal(); } catch {}
      } else {
        dialog.setAttribute('open', '');
      }
    }
    const focusable = dialog ? Array.from(dialog.querySelectorAll('button:not(:disabled), [href], input:not(:disabled), select:not(:disabled), textarea:not(:disabled), [tabindex]:not([tabindex="-1"])')) : [];
    const initial = dialog?.querySelector('[autofocus]')
      || focusable.find(element => ['INPUT', 'SELECT', 'TEXTAREA'].includes(element.tagName)) || focusable[0];
    if (initial && typeof initial.focus === 'function') {
      try { initial.focus(); } catch {}
    }
    return () => {
      unregister();
      if (dialog && dialog.open) {
        if (typeof dialog.close === 'function') {
          try { dialog.close(); } catch {}
        } else {
          dialog.removeAttribute('open');
        }
      }
      if (previous && typeof previous.focus === 'function') {
        if (previous.isConnected !== false) {
          try { previous.focus({ preventScroll: true }); } catch {}
        }
      }
    };
  }, [visible, modalId]);

  const requestClose = () => {
    if (busy || !visible) return;
    if (!isTopModalLayer(modalId, ref.current)) return;
    const hasUnsaved = unsavedGuard !== false && (typeof dirty === 'boolean' ? dirty : tracker.isDirty());
    if (hasUnsaved) {
      setDiscardPromptOpen(true);
      return;
    }
    if (!busy) onCloseRef.current?.();
  };

  const handlePointerDown = (event) => {
    const dialog = ref.current;
    if (event.button !== 0 || event.target !== dialog) {
      pointerDownOutsideRef.current = false;
      return;
    }
    pointerDownOutsideRef.current = isPointOutsideRect(dialog, event.clientX, event.clientY);
  };

  const handleClick = (event) => {
    const startedOutside = pointerDownOutsideRef.current;
    pointerDownOutsideRef.current = false;
    const dialog = ref.current;
    if (!startedOutside || event.target !== dialog) return;
    if (!isPointOutsideRect(dialog, event.clientX, event.clientY)) return;
    event.stopPropagation();
    requestClose();
  };

  const handleKeyDown = (event) => {
    if (!isTopModalLayer(modalId, ref.current)) return;
    if (event.key === 'Escape') {
      event.preventDefault();
      event.stopPropagation();
      if (!busy) requestClose();
      return;
    }
    if (event.key === 'Tab') {
      const dialog = ref.current;
      if (!dialog) return;
      const focusable = Array.from(dialog.querySelectorAll('button:not(:disabled), [href], input:not(:disabled), select:not(:disabled), textarea:not(:disabled), [tabindex]:not([tabindex="-1"])'));
      if (focusable.length === 0) {
        event.preventDefault();
        return;
      }
      if (focusable.length === 1) {
        event.preventDefault();
        focusable[0].focus();
        return;
      }
      const first = focusable[0];
      const last = focusable[focusable.length - 1];
      if (event.shiftKey && document.activeElement === first) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault();
        first.focus();
      } else if (!dialog.contains(document.activeElement)) {
        event.preventDefault();
        (event.shiftKey ? last : first).focus();
      }
    }
  };
  return <>
    <dialog
      ref={ref}
      hidden={!visible}
      className={`ws-modal ${wide ? 'ws-modal-wide' : ''}`}
      aria-modal="true"
      aria-labelledby={titleId}
      onFocus={(event) => {
        if (event.target !== ref.current && ref.current?.contains(event.target)) {
          lastFocusedInsideRef.current = event.target;
        }
      }}
      onPointerDown={handlePointerDown}
      onPointerCancel={() => { pointerDownOutsideRef.current = false; }}
      onClick={handleClick}
      onKeyDown={handleKeyDown}
      onCancel={(event) => { event.preventDefault(); if (!busy) requestClose(); }}
    >
      <header><h2 id={titleId}>{title}</h2><Button aria-label="Pencereyi kapat" disabled={busy} onClick={requestClose} icon="close" /></header>
      <div className="ws-modal-body"><ModalCloseContext.Provider value={requestClose}>{children}</ModalCloseContext.Provider></div>
    </dialog>
    {discardPromptOpen && (
      <ConfirmDialog
        title="Kaydedilmemiş değişiklikler var"
        message="Pencereyi kapatırsanız henüz kaydetmediğiniz değişiklikler kaybolur."
        cancelLabel="Düzenlemeye dön"
        confirmLabel="Değişiklikleri bırak"
        onCancel={() => setDiscardPromptOpen(false)}
        onConfirm={() => { setDiscardPromptOpen(false); onCloseRef.current?.(); }}
      />
    )}
  </>;
}
export function ConfirmDialog({ title, message, onCancel, onConfirm, busy = false, disabled = false, confirmation, error, confirmLabel = 'Onayla', cancelLabel = 'Vazgeç' }) {
  return <Modal title={title} onClose={onCancel} busy={busy} unsavedGuard={false}><ConfirmationForm message={message} onCancel={onCancel} onConfirm={onConfirm}
    busy={busy} disabled={disabled} confirmation={confirmation} error={error} confirmLabel={confirmLabel} cancelLabel={cancelLabel} /></Modal>;
}
export function ConfirmationForm({ message, onCancel, onConfirm, busy = false, disabled = false, confirmation, error, confirmLabel = 'Onayla', cancelLabel = 'Vazgeç', variant = 'danger' }) {
  const [value, setValue] = useState('');
  return <><p className="ws-muted">{message}</p><ErrorNotice error={error} /><form onSubmit={(event) => { event.preventDefault(); if (!busy && !disabled && (!confirmation || value === confirmation)) onConfirm(); }}>
    {confirmation && <label>Onaylamak için <strong>{confirmation}</strong> yazın<input autoFocus value={value} onChange={(event) => setValue(event.target.value)} autoComplete="off" spellCheck={false} required /></label>}
    <footer className="ws-modal-footer"><Button disabled={busy} onClick={onCancel}>{cancelLabel}</Button><Button variant={variant} type="submit" disabled={busy || disabled || (confirmation && value !== confirmation)}>{busy ? 'İşleniyor…' : confirmLabel}</Button></footer>
  </form></>;
}
export {
  DesignSystemConfig,
  DEFAULT_DOCKER_STACK_TEMPLATES,
  ThemeRoot,
  HierarchyTree,
  SubdomainBranchRow,
  FileRootBadge,
  PortMappingTable,
  DockerHubCatalogPicker,
} from './design-system/primitives.jsx';
