import { dnsSecondaryPresentation, dnsSecondaryTargetPresentation } from './dns-model.js';
import { Badge, Button, KeyValues, Section } from './PanelKit.jsx';
import { formatDate } from './site-model.js';

const ZONE_KIND_LABELS = Object.freeze({
  Master: 'Birincil',
  Primary: 'Birincil',
  Native: 'Yerel',
  Slave: 'İkincil',
  Secondary: 'İkincil',
});

export default function SecondaryDnsStatusPanel({ state, loading, busy, onRefresh }) {
  const presentation = dnsSecondaryPresentation(state);
  const targets = Array.isArray(state?.sync?.targets) ? state.sync.targets : [];
  const hasAheadTarget = targets.some((target) => target?.status === 'ahead');
  const needsRecheck = Boolean(state && state.configured !== false && !presentation.ready);

  return <Section
    title="İkincil DNS eşitlemesi"
    description="Birincil SOA seri numarası, PowerDNS bildirim durumu ve ikincil ad sunucularının güncel sürümü ayrı ayrı izlenir."
    actions={state && <div className="ws-actions"><Badge state={presentation.state}>{presentation.label}</Badge>{needsRecheck && <Button icon="refresh" disabled={busy || loading} onClick={onRefresh}>Kayıtları kontrol et / Yenile</Button>}</div>}
  >
    <div className="ws-section-body">
      {loading && !state ? <div className="ws-loading" role="status"><span className="ws-spinner" />İkincil DNS durumu okunuyor…</div> : state ? <>
        <KeyValues items={[
          ['Bölge', state.zoneName],
          ['Birincil SOA seri numarası', state.sync?.expectedSerial ?? state.notify?.serial ?? '—'],
          ['Bildirilen seri numarası', state.notify?.notifiedSerial ?? '—'],
          ['Güncel seri bildirimi', state.notify?.currentSerialNotified ? 'Gönderilmiş' : 'Doğrulanmadı'],
          ['Bölge türü', ZONE_KIND_LABELS[state.zoneKind] ?? state.zoneKind ?? '—'],
          ['Son ikincil kontrolü', state.sync?.checkedAt ? formatDate(state.sync.checkedAt) : '—'],
        ]} />

        {state.configured === false && <div className="ws-notice"><div><strong>İkincil DNS yapılandırılmamış</strong><p>Bu bölge için tanımlı ikincil DNS hedefi yok; tek sunuculu birincil çalışma bu nedenle hatalı sayılmaz.</p></div></div>}

        {targets.length > 0 && <div className="dns-diff"><strong>İkincil DNS hedefleri</strong>{targets.map((target) => {
          const targetPresentation = dnsSecondaryTargetPresentation(target);
          return <div key={target.target}><Badge state={targetPresentation.state}>{targetPresentation.label}</Badge><code>{target.target}</code><span>SOA {target.observedSerial ?? '—'} / beklenen {target.expectedSerial ?? state.sync?.expectedSerial ?? '—'}</span>{target.errorCode && <details className="ws-support-code"><summary>Destek kodu</summary><code>{target.errorCode}</code></details>}</div>;
        })}</div>}

        {state.configured !== false && !presentation.ready && <div className={`ws-notice ${state.status === 'primary_kind_required' || hasAheadTarget ? 'ws-notice-error' : 'ws-notice-warn'}`} role="alert"><div><strong>İkincil DNS eşitlemesi hazır değil</strong><p>{presentation.label}. Bu durum otomatik bölge şablonu değişikliği başlatmaz; ikincil sunucu bağlantısını ve SOA seri numarasını kontrol edin.</p></div></div>}
      </> : <div className="ws-muted">İkincil DNS durumu henüz okunmadı.</div>}

      <div className="ws-actions"><Button icon="refresh" disabled={busy || loading} onClick={onRefresh}>İkincil DNS durumunu yenile</Button></div>
    </div>
  </Section>;
}
