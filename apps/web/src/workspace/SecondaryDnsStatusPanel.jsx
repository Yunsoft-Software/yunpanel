import { dnsSecondaryPresentation, dnsSecondaryTargetPresentation } from './dns-model.js';
import { Badge, Button, KeyValues, Section } from './PanelKit.jsx';
import { formatDate } from './site-model.js';

export default function SecondaryDnsStatusPanel({ state, loading, busy, onRefresh }) {
  const presentation = dnsSecondaryPresentation(state);
  const targets = Array.isArray(state?.sync?.targets) ? state.sync.targets : [];
  const hasAheadTarget = targets.some((target) => target?.status === 'ahead');

  return <Section
    title="Secondary DNS senkronizasyonu"
    description="Primary SOA serial, PowerDNS NOTIFY evidence ve secondary authoritative SOA gözlemi ayrı ayrı gösterilir."
    actions={state && <Badge state={presentation.state}>{presentation.label}</Badge>}
  >
    <div className="ws-section-body">
      {loading && !state ? <div className="ws-loading" role="status"><span className="ws-spinner" />Secondary DNS durumu okunuyor…</div> : state ? <>
        <KeyValues items={[
          ['Zone', state.zoneName],
          ['Primary SOA serial', state.sync?.expectedSerial ?? state.notify?.serial ?? '—'],
          ['PowerDNS notified_serial', state.notify?.notifiedSerial ?? '—'],
          ['Current serial NOTIFY', state.notify?.currentSerialNotified ? 'Gönderilmiş' : 'Doğrulanmadı'],
          ['Zone türü', state.zoneKind ?? '—'],
          ['Son secondary kontrolü', state.sync?.checkedAt ? formatDate(state.sync.checkedAt) : '—'],
        ]} />

        {state.configured === false && <div className="ws-notice"><div><strong>Secondary DNS yapılandırılmamış</strong><p>Bu zone için secondary authoritative hedef yok. Primary-only çalışma bu yüzden degraded sayılmaz.</p></div></div>}

        {targets.length > 0 && <div className="dns-diff"><strong>Secondary authoritative endpoint’ler</strong>{targets.map((target) => {
          const targetPresentation = dnsSecondaryTargetPresentation(target);
          return <div key={target.target}><Badge state={targetPresentation.state}>{targetPresentation.label}</Badge><code>{target.target}</code><span>SOA {target.observedSerial ?? '—'} / beklenen {target.expectedSerial ?? state.sync?.expectedSerial ?? '—'}{target.errorCode ? ` · ${target.errorCode}` : ''}</span></div>;
        })}</div>}

        {state.configured !== false && !presentation.ready && <div className={`ws-notice ${state.status === 'primary_kind_required' || hasAheadTarget ? 'ws-notice-error' : 'ws-notice-warn'}`} role="alert"><div><strong>Secondary DNS health hazır değil</strong><p>{presentation.label}. Bu durum otomatik Zone Template re-apply veya duplicate RRset mutation tetiklemez; secondary topology ve authoritative serial evidence önce gözlemlenmelidir.</p></div></div>}
      </> : <div className="ws-muted">Secondary DNS durumu henüz okunmadı.</div>}

      <div className="ws-actions"><Button icon="refresh" disabled={busy || loading} onClick={onRefresh}>Secondary durumu yenile</Button></div>
    </div>
  </Section>;
}
