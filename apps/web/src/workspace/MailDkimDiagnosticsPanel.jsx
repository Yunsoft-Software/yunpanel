import { useCallback, useEffect, useState } from 'react';
import {
  applyMailDkim,
  createMailDkim,
  getMailDiagnostics,
  getMailDkim,
  previewMailDkimApply,
  rotateMailDkim,
} from './mail-client.js';
import { useWorkspace } from './WorkspaceContext.jsx';
import { Badge, Button, ConfirmDialog, EmptyState, ErrorNotice, KeyValues, Modal, Section } from './PanelKit.jsx';

function diagnosticState(value) {
  if (value === 'ready' || value === 'pass' || value === 'srs_ready') return 'active';
  if (value === 'not_applicable') return 'unknown';
  if (value === 'action_required') return 'warning';
  return 'error';
}

function DkimKeyModal({ keyState, domain, onClose, onChanged }) {
  const [selector, setSelector] = useState(keyState ? '' : 'mail');
  const [busy, setBusy] = useState(false); const [error, setError] = useState(null);
  async function submit(event) {
    event.preventDefault(); setBusy(true); setError(null);
    try {
      if (keyState) await rotateMailDkim(domain.id, { expectedRevision: keyState.revision, selector });
      else await createMailDkim(domain.id, { expectedRevision: 0, selector });
      onChanged?.(); onClose();
    } catch (failure) { if (failure.name !== 'AbortError') setError(failure.message); }
    finally { setBusy(false); }
  }
  return <Modal title={keyState ? 'DKIM key rotate et' : 'DKIM key oluştur'} onClose={onClose} busy={busy}><form className="ws-form" onSubmit={submit}><ErrorNotice error={error} /><label>Selector<input value={selector} required pattern="[a-z0-9](?:[a-z0-9-]*[a-z0-9])?" autoCapitalize="none" spellCheck={false} onChange={(event) => setSelector(event.target.value)} placeholder={keyState ? 'mail-2026' : 'mail'} /></label>{keyState && <p className="ws-muted">Mevcut selector <strong>{keyState.selector}</strong>. Rotation için farklı selector gerekir; eski DNS kaydı retirement tamamlanana kadar korunur.</p>}<p className="ws-muted">Private key protected server state’inde kalır. Panel yalnız public DNS metadata gösterir.</p><footer className="ws-modal-footer"><Button disabled={busy} onClick={onClose}>Vazgeç</Button><Button type="submit" variant="primary" disabled={busy || !selector}>{busy ? 'Hazırlanıyor…' : keyState ? 'Rotate et' : 'DKIM oluştur'}</Button></footer></form></Modal>;
}

export default function MailDkimDiagnosticsPanel({ domain, onChanged }) {
  const { observe } = useWorkspace();
  const [keyState, setKeyState] = useState(undefined);
  const [diagnostics, setDiagnostics] = useState(undefined);
  const [preview, setPreview] = useState(null);
  const [editing, setEditing] = useState(false);
  const [confirming, setConfirming] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);
  const [notice, setNotice] = useState(null);

  const refresh = useCallback(async () => {
    setError(null);
    try {
      const [nextKey, nextDiagnostics] = await Promise.all([
        getMailDkim(domain.id),
        getMailDiagnostics(domain.id),
      ]);
      setKeyState(nextKey); setDiagnostics(nextDiagnostics); setPreview(null);
    } catch (failure) { if (failure.name !== 'AbortError') setError(failure.message); }
  }, [domain.id]);
  useEffect(() => { refresh(); }, [refresh]);

  async function buildPreview() {
    if (!keyState) return; setBusy(true); setError(null); setNotice(null);
    try { setPreview(await previewMailDkimApply(domain.id, { expectedKeyRevision: keyState.revision })); }
    catch (failure) { if (failure.name !== 'AbortError') setError(failure.message); }
    finally { setBusy(false); }
  }
  async function applyPreview() {
    if (!keyState || !preview) return; setBusy(true); setError(null);
    try {
      const job = await applyMailDkim(domain.id, { expectedKeyRevision: keyState.revision, preview });
      observe(job); setConfirming(false); setPreview(null);
      setNotice('DKIM configuration işi kuyruğa alındı. Signing state job başarıyla tamamlanmadan uygulanmış sayılmaz.');
      onChanged?.();
    } catch (failure) { if (failure.name !== 'AbortError') setError(failure.message); }
    finally { setBusy(false); }
  }

  const dkimDiagnostic = diagnostics?.diagnostics?.dkim ?? null;
  const forwarding = diagnostics?.diagnostics?.forwardingDeliverability ?? null;
  return <><Section title="DKIM" description="Public DNS key metadata ve guarded Rspamd signing apply akışı."><div className="ws-section-body"><ErrorNotice error={error} />{notice && <p className="ws-notice" role="status">{notice}</p>}{keyState ? <><KeyValues items={[
    ['Selector', keyState.selector], ['Algoritma', keyState.algorithm], ['Revizyon', keyState.revision], ['Public key', keyState.publicKey], ['DNS tipi', keyState.dnsRecord?.type ?? 'TXT'], ['DNS adı', keyState.dnsRecord?.name ?? `${keyState.selector}._domainkey.${domain.domainName}`], ['DNS değer', keyState.dnsRecord?.content ?? keyState.dnsRecord?.value ?? '—'],
  ]} /><div className="ws-actions"><Button onClick={() => setEditing(true)}>Key rotate</Button><Button disabled={busy} onClick={buildPreview}>{busy ? 'Hazırlanıyor…' : 'Signing preview'}</Button></div></> : keyState === null ? <EmptyState icon="shield" title="DKIM key yok" detail="Local mail domain için protected private key ve public DNS metadata oluşturun." action={<Button variant="primary" onClick={() => setEditing(true)}>DKIM oluştur</Button>} /> : <div className="ws-loading"><span className="ws-spinner" />DKIM yükleniyor…</div>}{preview && <><KeyValues items={[
    ['Hazır', <Badge key="ready" state={preview.readyToApply ? 'active' : 'warning'}>{preview.readyToApply ? 'apply edilebilir' : 'DNS hazır değil'}</Badge>], ['Selector', preview.selector], ['Preview digest', preview.previewDigest], ['Config SHA-256', preview.configuration?.sha256 ?? '—'], ['Signing domain', preview.configuration?.domains ?? '—'],
  ]} />{preview.blockers?.length > 0 && <div className="ws-notice ws-notice-warn"><div><strong>DKIM blocker</strong><p>{preview.blockers.join(', ')}</p></div></div>}<Button variant="primary" disabled={busy || !preview.readyToApply || !preview.configuration} onClick={() => setConfirming(true)}>DKIM signing apply</Button></>}</div></Section><Section title="Mail diagnostics" description="DNS ve forwarding readiness sonuçları; secret veya private config içermez."><div className="ws-section-body"><div className="ws-actions"><Button icon="refresh" disabled={busy} onClick={refresh}>Yenile</Button></div>{diagnostics ? <><KeyValues items={[
    ['Attention required', <Badge key="attention" state={diagnostics.attentionRequired ? 'warning' : 'active'}>{diagnostics.attentionRequired ? 'Evet' : 'Hayır'}</Badge>], ['DKIM', dkimDiagnostic ? <Badge key="dkim" state={diagnosticState(dkimDiagnostic.state)}>{dkimDiagnostic.state}</Badge> : '—'], ['Forwarding', forwarding ? <Badge key="fwd" state={diagnosticState(forwarding.state)}>{forwarding.state}</Badge> : '—'], ['External forwarding', forwarding?.externalDestinationCount ?? 0], ['SRS ready', forwarding?.srsReady === null || forwarding?.srsReady === undefined ? '—' : forwarding.srsReady ? 'Evet' : 'Hayır'],
  ]} />{diagnostics.issues?.length > 0 && <div className="ws-table-scroll"><table className="ws-table"><thead><tr><th>Tür</th><th>Sebep</th><th>Aksiyon</th></tr></thead><tbody>{diagnostics.issues.map((issue, index) => <tr key={`${issue.kind ?? 'issue'}:${issue.reasonCode ?? index}`}><td>{issue.kind ?? 'diagnostic'}</td><td><code>{issue.reasonCode ?? issue.code ?? 'attention_required'}</code></td><td>{issue.action ?? '—'}</td></tr>)}</tbody></table></div>}</> : diagnostics === null ? <EmptyState icon="shield" title="Diagnostic sonucu yok" detail="Mail diagnostics henüz sonuç üretmedi." /> : <div className="ws-loading"><span className="ws-spinner" />Diagnostics yükleniyor…</div>}</div></Section>{editing && <DkimKeyModal keyState={keyState || null} domain={domain} onClose={() => setEditing(false)} onChanged={() => { refresh(); onChanged?.(); }} />}{confirming && preview && <ConfirmDialog title="DKIM signing configuration uygula" message={`${domain.domainName} DKIM signing state durable job ile uygulanacak. Public DNS readiness tekrar doğrulanır.`} confirmation={preview.confirmation} busy={busy} error={error} onCancel={() => setConfirming(false)} onConfirm={applyPreview} confirmLabel="DKIM apply" />}</>;
}

export const mailDkimDiagnosticsPanelInternals = Object.freeze({ diagnosticState });
