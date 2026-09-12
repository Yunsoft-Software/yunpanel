import { useEffect, useRef, useState } from 'react';
import { panelRequest } from '../api.js';
import { sessionGeneration, setSession } from '../session-client.js';
import { Badge, Button, EmptyState, ErrorNotice, PageHeading, Section } from './PanelKit.jsx';
import { auditFilterInput, auditMessage, createAuditClient, emptyAuditPage } from './audit-client.js';
import { formatDate } from './site-model.js';

const LIMIT = 50;
const blankFilters = () => ({ actorId: '', action: '', outcome: 'all', resourceType: '', resourceId: '', from: '', to: '' });
const outcomeLabels = { accepted: 'Kabul edildi', succeeded: 'Başarılı', failed: 'Başarısız', denied: 'Reddedildi', cancelled: 'İptal edildi' };

function localTimestamp(value) {
  if (!value) return null;
  const timestamp = new Date(value).getTime();
  if (!Number.isSafeInteger(timestamp) || timestamp < 0) {
    const error = new Error('invalid_audit_time_range'); error.code = 'invalid_audit_time_range'; throw error;
  }
  return timestamp;
}

function normalizedDraft(draft) {
  return auditFilterInput({
    actorId: draft.actorId.trim(), action: draft.action.trim(), outcome: draft.outcome,
    resourceType: draft.resourceType.trim(), resourceId: draft.resourceId.trim(),
    from: localTimestamp(draft.from), to: localTimestamp(draft.to),
  });
}

export default function AuditPage() {
  const [page, setPage] = useState(emptyAuditPage);
  const [number, setNumber] = useState(1);
  const [draft, setDraft] = useState(blankFilters);
  const [filters, setFilters] = useState(() => auditFilterInput());
  const [filterError, setFilterError] = useState(null);
  const client = useRef(null);
  useEffect(() => {
    const instance = createAuditClient({
      request: panelRequest,
      generation: sessionGeneration,
      onPage: setPage,
      onAccessLost() {
        setSession(null);
        window.dispatchEvent(new Event('yunpanel:session-expired'));
      },
    });
    client.current = instance;
    return () => { instance.dispose(); if (client.current === instance) client.current = null; };
  }, []);
  useEffect(() => { client.current?.load({ filters, offset: (number - 1) * LIMIT, limit: LIMIT }); }, [filters, number]);
  const totalPages = page.data ? Math.max(1, Math.ceil(page.data.total / LIMIT)) : number;
  useEffect(() => { if (page.status === 'ready' && number > totalPages) setNumber(totalPages); }, [number, page.status, totalPages]);
  const ready = page.status === 'ready' && page.data?.offset === (number - 1) * LIMIT;
  const visible = ready ? page.data : null;
  const loading = page.status === 'loading' || page.status === 'ready' && !ready;
  function update(key, value) { setDraft((current) => ({ ...current, [key]: value })); setFilterError(null); }
  function apply(event) {
    event.preventDefault();
    try { setFilters(normalizedDraft(draft)); setNumber(1); setFilterError(null); }
    catch (error) { setFilterError(auditMessage(error)); }
  }
  function reset() { const next = blankFilters(); setDraft(next); setFilters(auditFilterInput()); setNumber(1); setFilterError(null); }
  function refresh() { client.current?.load({ filters, offset: (number - 1) * LIMIT, limit: LIMIT }); }
  return <>
    <PageHeading title="Denetim kayıtları" description="Owner işlemleri, erişim kararları ve kalıcı iş sonuçları; gizli değerler ve terminal içeriği kaydedilmez." actions={<Button icon="refresh" onClick={refresh} disabled={loading}>Yenile</Button>} />
    <Section title="Filtreler" description="Kaynak filtresinde tür ve kimlik birlikte kullanılmalıdır.">
      <form className="ws-form ws-section-body" onSubmit={apply}>
        <ErrorNotice error={filterError} />
        <div className="ws-form-grid">
          <label>Actor kimliği<input value={draft.actorId} onChange={(event) => update('actorId', event.target.value)} maxLength={128} autoComplete="off" spellCheck={false} /></label>
          <label>İşlem adı<input value={draft.action} onChange={(event) => update('action', event.target.value)} maxLength={120} placeholder="site.create" autoComplete="off" spellCheck={false} /></label>
          <label>Sonuç<select value={draft.outcome} onChange={(event) => update('outcome', event.target.value)}><option value="all">Tümü</option><option value="accepted">Kabul edildi</option><option value="succeeded">Başarılı</option><option value="failed">Başarısız</option><option value="denied">Reddedildi</option><option value="cancelled">İptal edildi</option></select></label>
          <label>Kaynak türü<input value={draft.resourceType} onChange={(event) => update('resourceType', event.target.value)} maxLength={64} placeholder="website" autoComplete="off" spellCheck={false} /></label>
          <label>Kaynak kimliği<input value={draft.resourceId} onChange={(event) => update('resourceId', event.target.value)} maxLength={128} autoComplete="off" spellCheck={false} /></label>
          <label>Başlangıç<input type="datetime-local" value={draft.from} onChange={(event) => update('from', event.target.value)} /></label>
          <label>Bitiş<input type="datetime-local" value={draft.to} onChange={(event) => update('to', event.target.value)} /></label>
        </div>
        <div className="ws-actions"><Button type="submit" variant="primary">Filtrele</Button><Button onClick={reset}>Temizle</Button></div>
      </form>
    </Section>
    <Section title="Kayıtlar">
      {loading && <div className="ws-loading" role="status"><span className="ws-spinner" />Denetim kayıtları doğrulanıyor…</div>}
      {page.status === 'error' && <div className="ws-section-body"><ErrorNotice error={auditMessage(page.error)} /><Button onClick={refresh}>Listeyi yeniden yükle</Button></div>}
      {ready && (visible.events.length ? <div className="ws-table-scroll"><table className="ws-table">
        <caption className="ws-muted">En yeni kayıtlar önce gösterilir; her sayfada en fazla {LIMIT} kayıt.</caption>
        <thead><tr><th scope="col">Zaman</th><th scope="col">İşlem</th><th scope="col">Actor</th><th scope="col">Kaynak</th><th scope="col">Sonuç</th></tr></thead>
        <tbody>{visible.events.map((event) => <tr key={event.id}>
          <td>{formatDate(event.createdAt)}</td>
          <td><strong>{event.action}</strong>{event.code && <small>{event.code}</small>}</td>
          <td style={{ overflowWrap: 'anywhere' }}>{event.actorId ?? 'system'}</td>
          <td>{event.resourceType ?? '—'}{event.resourceId && <small style={{ overflowWrap: 'anywhere' }}>{event.resourceId}</small>}</td>
          <td><Badge state={event.outcome === 'accepted' ? 'queued' : event.outcome === 'denied' ? 'failed' : event.outcome}>{outcomeLabels[event.outcome]}</Badge></td>
        </tr>)}</tbody>
      </table></div> : <EmptyState title="Filtreye uyan kayıt yok" detail="Filtreleri temizleyin veya yeni yönetim işlemlerinden sonra listeyi yenileyin." icon="shield" />)}
      <footer className="ws-pagination"><span>{visible ? `${visible.total} kayıt` : 'Kayıt sayısı doğrulanıyor'}</span><div className="ws-actions">
        <Button disabled={!ready || number <= 1} onClick={() => setNumber((value) => value - 1)}>Önceki</Button><span aria-live="polite">Sayfa {number}{visible ? ` / ${totalPages}` : ''}</span>
        <Button disabled={!ready || number >= totalPages} onClick={() => setNumber((value) => value + 1)}>Sonraki</Button>
      </div></footer>
    </Section>
  </>;
}

export const auditPageInternals = Object.freeze({ localTimestamp, normalizedDraft });
