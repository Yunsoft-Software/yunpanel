import { useCallback, useEffect, useState } from 'react';
import { panelRequest } from '../api.js';
import { Button, EmptyState, ErrorNotice, Section } from './PanelKit.jsx';
import { formatDate } from './site-model.js';

function logPath({ application, serverId, source }) {
  if (source === 'node') return `/applications/${encodeURIComponent(application.id)}/logs/node`;
  return `/servers/${encodeURIComponent(serverId)}/logs/${source}`;
}

export default function LogsPanel({ application, domain, server }) {
  const [source, setSource] = useState(application?.type === 'node' ? 'node' : 'nginx-error');
  const [search, setSearch] = useState('');
  const [result, setResult] = useState(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);
  const load = useCallback(async () => {
    if (!server || (source === 'node' && !application)) return;
    setBusy(true); setError(null);
    try {
      const query = new URLSearchParams({ limit: '100' });
      if (search.trim()) query.set('q', search.trim());
      setResult(await panelRequest(`${logPath({ application, serverId: server.id, source })}?${query}`));
    } catch (failure) { if (failure.name !== 'AbortError') setError(failure.message); }
    finally { setBusy(false); }
  }, [application?.id, search, server?.id, source]);
  useEffect(() => { void load(); }, [source, application?.id, server?.id]);
  const download = server && (source !== 'node' || application)
    ? `/api/panel${logPath({ application, serverId: server.id, source })}/download?limit=1000`
    : null;
  return <Section title="Canlı site logları" description={`${domain.primaryDomain} için yerel journal ve Nginx kayıtlarını okuyun.`} actions={<Button icon="refresh" disabled={busy || !server} onClick={load}>Yenile</Button>}>
    <ErrorNotice error={error} />
    <div className="ws-section-body ws-filters"><label>Kaynak<select value={source} onChange={(event) => setSource(event.target.value)}>{application?.type === 'node' && <option value="node">Node.js uygulaması</option>}<option value="nginx-access">Nginx erişim</option><option value="nginx-error">Nginx hata</option></select></label><label className="ws-filter-search">Ara<input value={search} maxLength={100} onChange={(event) => setSearch(event.target.value)} /></label><Button disabled={busy || !server} onClick={load}>Uygula</Button>{download && <a className="ws-button ws-button-secondary" href={download}>İndir</a>}</div>
    {busy && !result && <div className="ws-loading" role="status"><span className="ws-spinner" />Loglar yükleniyor…</div>}
    {result?.entries?.length ? <div className="ws-table-scroll"><table className="ws-table"><thead><tr><th>Zaman</th><th>Seviye</th><th>Kaynak</th><th>Mesaj</th></tr></thead><tbody>{result.entries.map((entry, index) => <tr key={entry.cursor ?? `${entry.timestamp}:${index}`}><td>{formatDate(entry.timestamp)}</td><td>{entry.level}</td><td>{entry.unit ?? entry.source}</td><td><code>{entry.message}</code></td></tr>)}</tbody></table></div> : result && <EmptyState title="Log kaydı bulunamadı" detail="Seçili kaynak, zaman aralığı ve arama için kayıt yok." icon="file" />}
  </Section>;
}
