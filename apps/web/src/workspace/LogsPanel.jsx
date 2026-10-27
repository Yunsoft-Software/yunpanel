import { useCallback, useEffect, useRef, useState } from 'react';
import { panelRequest } from '../api.js';
import { Button, EmptyState, ErrorNotice, Section } from './PanelKit.jsx';
import { formatDate } from './site-model.js';

const LIVE_INTERVAL_MS = 3000;
const LIVE_MAX_ROWS = 500;

// Site logs always go through the site's own endpoint: it reads only this site's
// files, so it is safe for every role that can open the site.
export function siteLogPath({ domain, source, live = false }) {
  const base = `/websites/${encodeURIComponent(domain.websiteId)}/application/logs${live ? '/follow' : ''}`;
  if (source === 'node') return base;
  const query = new URLSearchParams({ kind: source === 'nginx-error' ? 'error' : 'access', domainId: domain.id });
  return `${base}?${query}`;
}

export function mergeLiveEntries(current, incoming, max = LIVE_MAX_ROWS) {
  return [...[...incoming].reverse(), ...current].slice(0, max);
}

export default function LogsPanel({ application, domain }) {
  const [source, setSource] = useState(application?.type === 'node' ? 'node' : 'nginx-access');
  const [search, setSearch] = useState('');
  const [result, setResult] = useState(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);
  const [live, setLive] = useState(false);
  const cursor = useRef(null);
  const canFollow = source !== 'node' && Boolean(domain?.websiteId);
  const withSearch = (path) => search.trim() ? `${path}${path.includes('?') ? '&' : '?'}q=${encodeURIComponent(search.trim())}` : path;

  const load = useCallback(async () => {
    if (!domain?.websiteId) return;
    setBusy(true); setError(null);
    try {
      const path = siteLogPath({ domain, source });
      setResult(await panelRequest(withSearch(`${path}${path.includes('?') ? '&' : '?'}limit=100`)));
    } catch (failure) { if (failure.name !== 'AbortError') setError(failure.message); }
    finally { setBusy(false); }
  }, [domain?.id, domain?.websiteId, search, source]);
  useEffect(() => { setLive(false); void load(); }, [source, domain?.id]);

  useEffect(() => {
    if (!live || !canFollow) return undefined;
    let stopped = false;
    cursor.current = null;
    const tick = async () => {
      try {
        const path = siteLogPath({ domain, source, live: true });
        const page = await panelRequest(withSearch(cursor.current ? `${path}&cursor=${encodeURIComponent(cursor.current)}` : path));
        if (stopped) return;
        cursor.current = page.cursor;
        if (page.entries.length) setResult(previous => ({ ...previous, entries: mergeLiveEntries(previous?.entries ?? [], page.entries) }));
        setError(null);
      } catch (failure) { if (!stopped && failure.name !== 'AbortError') setError(failure.message); }
    };
    void tick();
    const timer = setInterval(tick, LIVE_INTERVAL_MS);
    return () => { stopped = true; clearInterval(timer); };
  }, [live, canFollow, source, domain?.id, search]);

  const download = domain?.websiteId ? `/api/panel${siteLogPath({ domain, source }).replace('/logs', '/logs/download')}` : null;
  return <Section title="Site logları" actions={<>
    {canFollow && <Button onClick={() => setLive(value => !value)} aria-pressed={live}>{live ? 'Durdur' : 'Canlı'}</Button>}
    <Button icon="refresh" disabled={busy || live} onClick={load}>Yenile</Button></>}>
    <ErrorNotice error={error} />
    <div className="ws-section-body ws-filters"><label>Kaynak<select value={source} onChange={(event) => setSource(event.target.value)}>{application?.type === 'node' && <option value="node">Node.js uygulaması</option>}<option value="nginx-access">Erişim</option><option value="nginx-error">Hata</option></select></label><label className="ws-filter-search">Ara<input value={search} maxLength={100} onChange={(event) => setSearch(event.target.value)} /></label><Button disabled={busy || live} onClick={load}>Uygula</Button>{download && <a className="ws-button ws-button-secondary" href={download}>İndir</a>}</div>
    {busy && !result && <div className="ws-loading" role="status"><span className="ws-spinner" />Loglar yükleniyor…</div>}
    {result?.entries?.length ? <div className="ws-table-scroll"><table className="ws-table"><thead><tr><th>Zaman</th><th>Seviye</th><th>Kaynak</th><th>Mesaj</th></tr></thead><tbody>{result.entries.map((entry, index) => <tr key={entry.cursor ?? `${entry.timestamp}:${index}`}><td>{formatDate(entry.timestamp)}</td><td>{entry.level}</td><td>{entry.unit ?? entry.source}</td><td><code>{entry.message}</code></td></tr>)}</tbody></table></div> : result && <EmptyState title="Log kaydı bulunamadı" detail={live ? 'Yeni kayıt bekleniyor.' : 'Seçili kaynak ve arama için kayıt yok.'} icon="file" />}
  </Section>;
}
