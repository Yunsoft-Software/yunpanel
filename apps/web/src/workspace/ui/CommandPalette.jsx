import { useId, useMemo, useState } from 'react';
import { Link, useNavigate } from 'react-router';
import { Icon, Modal } from '../PanelKit.jsx';
import { commandEntries } from './ux-model.js';

export default function CommandPalette({ domains, canManage, isOwner = false, onClose }) {
  const [query, setQuery] = useState('');
  const [index, setIndex] = useState(0);
  const id = useId();
  const navigate = useNavigate();
  const entries = useMemo(() => commandEntries({ query, canManage, isOwner, domains }), [query, canManage, isOwner, domains]);
  const selected = Math.min(index, Math.max(entries.length - 1, 0));
  function open(entry) { if (entry) { onClose(); navigate(entry.to); } }
  function keydown(event) {
    if (event.nativeEvent.isComposing) return;
    if (['ArrowDown', 'ArrowUp'].includes(event.key)) {
      event.preventDefault();
      const next = entries.length ? (selected + (event.key === 'ArrowDown' ? 1 : -1) + entries.length) % entries.length : 0;
      setIndex(next);
      document.getElementById(`${id}-option-${next}`)?.scrollIntoView({ block: 'nearest' });
    }
    if (event.key === 'Enter') { event.preventDefault(); open(entries[selected]); }
  }
  return <Modal title="Hızlı erişim" onClose={onClose}>
    <div className="ws-command-search"><Icon name="search" /><label className="ws-sr-only" htmlFor={`${id}-input`}>Site veya panel bölümü ara</label>
      <input id={`${id}-input`} autoFocus role="combobox" aria-autocomplete="list" aria-expanded="true" aria-controls={`${id}-results`} aria-describedby={`${id}-hint`} aria-activedescendant={entries.length ? `${id}-option-${selected}` : undefined} type="text" autoComplete="off" spellCheck={false} maxLength={253} placeholder="Alan adı, SSL için site, panel bölümü…" value={query} onChange={(event) => { setQuery(event.target.value); setIndex(0); }} onKeyDown={keydown} />
    </div>
    <p id={`${id}-hint`} className="ws-muted">↑ ↓ ile seçin, Enter ile açın. Buradan hiçbir sunucu işlemi başlatılmaz.</p>
    <div id={`${id}-results`} role="listbox" aria-label="Hızlı erişim sonuçları" className="ws-command-results">
      {entries.map((entry, offset) => <Link key={entry.id} id={`${id}-option-${offset}`} to={entry.to} role="option" aria-selected={offset === selected} tabIndex={-1} className="ws-command-result" onMouseDown={(event) => event.preventDefault()} onMouseMove={() => setIndex(offset)} onClick={onClose}><Icon name={entry.icon} /><span><strong>{entry.label}</strong><small>{entry.detail}</small></span><Icon name="arrow" /></Link>)}
    </div>
    <p className="ws-muted ws-command-footer">Site önerileri bu ekranda yüklenen izinli envanterle sınırlıdır. Tüm kayıtlar için arama sonucundan Web siteleri listesini açın.</p>
  </Modal>;
}
