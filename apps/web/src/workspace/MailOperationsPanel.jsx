import { useCallback, useEffect, useState } from 'react';
import { applyRoundcube, getMailQueue, getMailServiceLogs, getRoundcubePreview, prepareRoundcube } from './mail-operations-client.js';
import { getServerMailDeliveryDiagnostics, sendServerMailTestDelivery } from './mail-client.js';
import { useWorkspace } from './WorkspaceContext.jsx';
import { Badge, Button, ConfirmDialog, EmptyState, ErrorNotice, KeyValues, Section } from './PanelKit.jsx';
import { formatDate } from './site-model.js';

function bytesLabel(value) {
  if (!Number.isFinite(value)) return '—';
  if (value >= 1024 ** 2) return `${(value / (1024 ** 2)).toFixed(1)} MiB`;
  if (value >= 1024) return `${(value / 1024).toFixed(1)} KiB`;
  return `${value} B`;
}

function RoundcubePanel() {
  const { observe } = useWorkspace();
  const [preview, setPreview] = useState(undefined);
  const [busy, setBusy] = useState(false); const [error, setError] = useState(null); const [confirming, setConfirming] = useState(false); const [notice, setNotice] = useState(null);
  const refresh = useCallback(async () => {
    setError(null);
    try { setPreview(await getRoundcubePreview()); }
    catch (failure) { if (failure.name !== 'AbortError') setError(failure.message); }
  }, []);
  useEffect(() => { refresh(); }, [refresh]);
  async function prepare() {
    setBusy(true); setError(null); setNotice(null);
    try { setPreview(await prepareRoundcube()); setNotice('Roundcube protected secret state hazırlandı; host config henüz uygulanmadı.'); }
    catch (failure) { if (failure.name !== 'AbortError') setError(failure.message); }
    finally { setBusy(false); }
  }
  async function apply() {
    setBusy(true); setError(null); setNotice(null);
    try {
      const job = await applyRoundcube(preview); observe(job); setConfirming(false);
      setNotice('Roundcube configuration işi kuyruğa alındı. Job başarıyla tamamlanmadan webmail aktif sayılmaz.');
    } catch (failure) { if (failure.name !== 'AbortError') setError(failure.message); }
    finally { setBusy(false); }
  }
  return <Section title="Roundcube webmail" description="Mail TLS identity ve protected secret üzerinden generated Roundcube/FPM/Nginx config."><div className="ws-section-body"><ErrorNotice error={error} />{notice && <p className="ws-notice" role="status">{notice}</p>}{preview === undefined ? <div className="ws-loading"><span className="ws-spinner" />Roundcube durumu yükleniyor…</div> : <><KeyValues items={[
    ['Hazır', <Badge key="ready" state={preview.readyToApply ? 'active' : 'warning'}>{preview.readyToApply ? 'apply edilebilir' : 'hazırlık gerekli'}</Badge>],
    ['Web endpoint', preview.webEndpoint ?? '—'],
    ['Mail hostname', preview.mailHostname ?? '—'],
    ['Preview SHA-256', preview.sha256 ?? '—'],
    ['Config SHA-256', preview.configuration?.sha256 ?? '—'],
    ['FPM SHA-256', preview.fpm?.sha256 ?? '—'],
    ['Nginx SHA-256', preview.nginx?.sha256 ?? '—'],
  ]} />{preview.blockers?.length > 0 && <div className="ws-notice ws-notice-warn"><div><strong>Roundcube blocker</strong><p>{preview.blockers.join(', ')}</p></div></div>}<div className="ws-actions">{!preview.readyToApply && <Button disabled={busy} onClick={prepare}>{busy ? 'Hazırlanıyor…' : 'Roundcube hazırla'}</Button>}<Button icon="refresh" disabled={busy} onClick={refresh}>Yenile</Button>{preview.readyToApply && <Button variant="primary" disabled={busy} onClick={() => setConfirming(true)}>Config apply</Button>}</div></>}</div>{confirming && preview?.readyToApply && <ConfirmDialog title="Roundcube configuration uygula" message="Roundcube config, PHP-FPM pool ve Nginx endpoint durable job ile uygulanacak. Host health doğrulanmadan tamamlandı sayılmaz." busy={busy} error={error} onCancel={() => setConfirming(false)} onConfirm={apply} confirmLabel="Roundcube apply" />}</Section>;
}

function ServiceConnectionDiagnosticsPanel({ serverId }) {
  const [diagnostics, setDiagnostics] = useState(undefined);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);

  const load = useCallback(async () => {
    if (!serverId) return;
    setBusy(true);
    setError(null);
    try {
      setDiagnostics(await getServerMailDeliveryDiagnostics(serverId));
    } catch (failure) {
      if (failure.name !== 'AbortError') setError(failure.message);
    } finally {
      setBusy(false);
    }
  }, [serverId]);

  useEffect(() => {
    void load();
  }, [load]);

  const conn = diagnostics?.connectionSettings;
  const protocols = diagnostics?.protocols?.protocols ?? [];

  return (
    <Section title="Mail servis bağlantı ve port durumu" description="Sistem genelinde SMTP, IMAP ve Submission port dinleme durumları, TLS protokol gereksinimleri.">
      <div className="ws-section-body">
        <ErrorNotice error={error} />
        <div className="ws-actions">
          <Button icon="refresh" disabled={busy} onClick={load}>{busy ? 'Kontrol ediliyor…' : 'Yenile'}</Button>
        </div>
        {conn && (
          <KeyValues items={[
            ['Gelen IMAP Portları & TLS', `${conn.imap?.ports?.join(', ') ?? '993, 143'} · ${conn.imap?.tls ?? 'SSL/TLS / STARTTLS'}`],
            ['Giden SMTP Portları & TLS', `${conn.smtp?.ports?.join(', ') ?? '465, 587, 25'} · ${conn.smtp?.tls ?? 'SSL/TLS / STARTTLS'}`],
            ['Kimlik Doğrulama', conn.authentication ?? 'Parola (PLAIN / LOGIN)'],
          ]} />
        )}
        {protocols.length > 0 && (
          <div className="ws-table-scroll">
            <table className="ws-table" role="table" aria-label="Mail protokolleri">
              <thead>
                <tr role="row">
                  <th scope="col">Protokol</th>
                  <th scope="col">Port</th>
                  <th scope="col">Durum</th>
                  <th scope="col">TLS Modu</th>
                </tr>
              </thead>
              <tbody>
                {protocols.map((p) => (
                  <tr key={p.id} role="row">
                    <td role="cell"><strong>{p.id.toUpperCase()}</strong></td>
                    <td role="cell"><code>{p.port}</code></td>
                    <td role="cell">
                      <Badge state={p.satisfied ? 'active' : 'error'}>
                        {p.satisfied ? 'Dinliyor (Aktif)' : 'Dinlemiyor'}
                      </Badge>
                    </td>
                    <td role="cell">{p.port === 465 || p.port === 993 ? 'Doğrudan SSL/TLS' : 'STARTTLS'}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </Section>
  );
}

function ServiceTestDeliveryPanel({ serverId }) {
  const [recipient, setRecipient] = useState('');
  const [sender, setSender] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);
  const [result, setResult] = useState(null);

  async function submit(e) {
    e.preventDefault();
    if (!recipient) return;
    setBusy(true);
    setError(null);
    setResult(null);
    try {
      const res = await sendServerMailTestDelivery(serverId, {
        sender: sender || undefined,
        recipient,
        subject: 'YunPanel Servis Teslimat Testi',
      });
      setResult(res);
    } catch (failure) {
      if (failure.name !== 'AbortError') setError(failure.message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <Section title="Servis teslimat doğrulama testi" description="Sistem genelinde giden e-posta teslimat testi; gerçek teslimat sonucu dönülür, hata gizlenmez.">
      <div className="ws-section-body">
        <ErrorNotice error={error} />
        {result && (
          <div className={`ws-notice ${result.delivered ? 'ws-notice-success' : 'ws-notice-warn'}`} role="status">
            <strong>{result.delivered ? 'Teslimat Başarılı' : 'Teslimat Başarısız'}</strong>
            <p>Alıcı: {result.recipient} ({result.routing === 'local' ? 'Yerel Teslim' : 'Dış Teslim'})</p>
            {result.messageId && <p>Mesaj ID: <code>{result.messageId}</code></p>}
            {result.error && <p>Hata Nedeni: {result.error}</p>}
          </div>
        )}
        <form className="ws-form" onSubmit={submit}>
          <fieldset disabled={busy}>
            <label>Gönderen adresi (Opsiyonel)
              <input type="email" value={sender} onChange={(e) => setSender(e.target.value)} placeholder="postmaster@domain.com" />
            </label>
            <label>Alıcı adresi
              <input type="email" value={recipient} required onChange={(e) => setRecipient(e.target.value)} placeholder="test@example.com" />
            </label>
            <div className="ws-actions">
              <Button type="submit" variant="primary" disabled={busy || !recipient}>
                {busy ? 'Gönderiliyor…' : 'Test Gönder'}
              </Button>
            </div>
          </fieldset>
        </form>
      </div>
    </Section>
  );
}

function QueuePanel({ serverId }) {
  const [queue, setQueue] = useState(undefined); const [search, setSearch] = useState(''); const [busy, setBusy] = useState(false); const [error, setError] = useState(null);
  const load = useCallback(async () => {
    if (!serverId) return; setBusy(true); setError(null);
    try { setQueue(await getMailQueue(serverId, { limit: 100, search })); }
    catch (failure) { if (failure.name !== 'AbortError') setError(failure.message); }
    finally { setBusy(false); }
  }, [serverId, search]);
  useEffect(() => { load(); }, [serverId]);
  const items = queue?.entries ?? [];
  return <Section title="Postfix mail queue" description="Bounded postqueue envanteri; yerel ve dış posta yönlendirmesi ayrılır, parolalar ve secret'lar masked tutulur."><div className="ws-section-body"><ErrorNotice error={error} /><form className="ws-filters" onSubmit={(event) => { event.preventDefault(); load(); }}><label className="ws-filter-search">Queue ara<input value={search} onChange={(event) => setSearch(event.target.value)} placeholder="queue ID, sender veya recipient" /></label><Button type="submit" disabled={busy}>{busy ? 'Okunuyor…' : 'Ara'}</Button><Button type="button" icon="refresh" disabled={busy} onClick={load}>Yenile</Button></form></div>{items.length ? <div className="ws-table-scroll"><table className="ws-table" role="table" aria-label="Mail kuyruğu"><thead><tr role="row"><th scope="col">Queue ID</th><th scope="col">Queue</th><th scope="col">Yönlendirme</th><th scope="col">Gönderen</th><th scope="col">Alıcılar</th><th scope="col">Boyut</th><th scope="col">Geliş</th></tr></thead><tbody>{items.map((item) => <tr key={item.queueId} role="row"><td role="cell"><code>{item.queueId}</code></td><td role="cell">{item.queueName}</td><td role="cell"><Badge state={item.routing === 'local' ? 'active' : item.routing === 'external' ? 'warning' : 'neutral'}>{item.routing === 'local' ? 'Yerel' : item.routing === 'external' ? 'Dış' : item.routing ?? '—'}</Badge></td><td role="cell">{item.sender || '<>'}</td><td role="cell">{item.recipients.map((recipient) => <small key={recipient.address}>{recipient.address}{recipient.delayReason ? ` · ${recipient.delayReason}` : ''}</small>)}</td><td role="cell">{bytesLabel(item.messageSize)}</td><td role="cell">{formatDate(item.arrivalTime)}</td></tr>)}</tbody></table></div> : queue && <EmptyState icon="mail" title="Queue boş" detail="Filtreye uyan bekleyen Postfix mesajı yok." />}{queue?.page && <div className="ws-section-body"><p className="ws-muted">{queue.page.count} kayıt · {queue.page.scanned} tarandı{queue.page.hasMore ? ' · daha fazla kayıt var' : ''}{queue.page.malformed ? ` · ${queue.page.malformed} bozuk kayıt atlandı` : ''}</p></div>}</Section>;
}

function LogsPanel({ serverId }) {
  const [service, setService] = useState('postfix'); const [search, setSearch] = useState(''); const [result, setResult] = useState(undefined); const [busy, setBusy] = useState(false); const [error, setError] = useState(null);
  const load = useCallback(async () => {
    if (!serverId) return; setBusy(true); setError(null);
    try { setResult(await getMailServiceLogs(serverId, service, { limit: 100, search })); }
    catch (failure) { if (failure.name !== 'AbortError') setError(failure.message); }
    finally { setBusy(false); }
  }, [serverId, service, search]);
  useEffect(() => { load(); }, [serverId, service]);
  return <Section title="Mail servis logları" description="Allowlist’li systemd journal: Postfix, Dovecot ve Rspamd. API tarafında secret masking ([REDACTED]) ile güvenli okunur."><div className="ws-section-body"><ErrorNotice error={error} /><form className="ws-filters" onSubmit={(event) => { event.preventDefault(); load(); }}><label>Servis<select value={service} onChange={(event) => { setService(event.target.value); setResult(undefined); }}><option value="postfix">Postfix</option><option value="dovecot">Dovecot</option><option value="rspamd">Rspamd</option></select></label><label className="ws-filter-search">Log ara<input value={search} onChange={(event) => setSearch(event.target.value)} placeholder="adres, hata veya event" /></label><Button type="submit" disabled={busy}>{busy ? 'Okunuyor…' : 'Ara'}</Button><Button type="button" icon="refresh" disabled={busy} onClick={load}>Yenile</Button></form>{result?.entries?.length ? <div className="ws-log-block"><pre>{result.entries.map((entry) => `${entry.timestamp} ${String(entry.level ?? 'info').toUpperCase()} ${entry.message}`).join('\n')}</pre></div> : result && <EmptyState icon="file" title="Log kaydı yok" detail="Seçili zaman aralığı ve filtre için kayıt bulunamadı." />}</div></Section>;
}

export default function MailOperationsPanel() {
  const { servers, isOwner } = useWorkspace();
  const server = servers.items.length === 1 ? servers.items[0] : null;
  return <><RoundcubePanel />{server ? <>{isOwner && <ServiceConnectionDiagnosticsPanel serverId={server.id} />}<QueuePanel serverId={server.id} /><LogsPanel serverId={server.id} />{isOwner && <ServiceTestDeliveryPanel serverId={server.id} />}</> : <Section title="Mail runtime"><EmptyState icon="server" title="Yerel sunucu kimliği bulunamadı" detail="Queue ve service logları yalnız panelin explicit local server kimliği üzerinden okunur." /></Section>}</>;
}

export const mailOperationsPanelInternals = Object.freeze({ bytesLabel });
