import { useEffect, useState } from 'react';
import { appendUsageSample, usagePath, usageSample } from './usage-history.js';

const series = [['cpu', 'CPU'], ['memory', 'RAM'], ['disk', 'Disk']];
const time = (stamp) => new Date(stamp).toLocaleTimeString('tr-TR', { hour: '2-digit', minute: '2-digit', second: '2-digit' });
export default function UsageHistory({ server }) {
  const sample = usageSample(server);
  const [history, setHistory] = useState(() => ({ serverId: server?.id, samples: sample ? [sample] : [] }));
  useEffect(() => {
    setHistory((previous) => {
      const samples = previous.serverId === server?.id ? previous.samples : [];
      const next = appendUsageSample(samples, sample);
      return previous.serverId === server?.id && next === previous.samples ? previous : { serverId: server?.id, samples: next };
    });
  }, [server?.id, sample?.timestamp, sample?.cpu, sample?.memory, sample?.disk]);
  const samples = history.serverId === server?.id ? history.samples : [];
  const latest = samples.at(-1);
  const drawable = samples.length > 1 && series.some(([key]) => samples.filter((point) => point[key] !== null).length > 1);
  return <div className="ws-history">
    <div className="ws-history-header"><span>Bu oturum <small>· {samples.length} ölçüm</small></span><div className="ws-history-legend">{series.map(([key, label]) => <span key={key} className={`ws-series-${key}`}><i aria-hidden="true" />{label}<strong>{latest?.[key] == null ? '—' : `%${Math.round(latest[key])}`}</strong></span>)}</div></div>
    {drawable ? <>
      <div className="ws-history-plot"><div className="ws-history-axis" aria-hidden="true"><span>100%</span><span>50%</span><span>0%</span></div><svg viewBox="0 0 640 160" preserveAspectRatio="none" role="img" aria-label="Bu sayfa açıkken alınan CPU, RAM ve disk kullanım ölçümleri"><title>Sunucu kaynak kullanımı</title><desc>Yalnız bu oturumda alınan ölçümler. Eksik değerler çizilmez. Sayısal veriler aşağıdaki ölçüm tablosunda.</desc>{[0, 40, 80, 120, 160].map((y) => <line key={y} className="ws-history-grid" x1="0" x2="640" y1={y} y2={y} />)}{series.map(([key]) => <path key={key} className={`ws-series-${key}`} d={usagePath(samples, key)} fill="none" strokeWidth="2" vectorEffect="non-scaling-stroke" />)}</svg></div>
      <div className="ws-history-time"><span>{time(samples[0].timestamp)}</span><span>{time(latest.timestamp)}</span></div>
    </> : <div className="ws-history-wait"><strong>Yeni ölçüm bekleniyor</strong><span>En az iki sunucu ölçümü alındığında grafik oluşur. Geçmiş veri uydurulmaz.</span></div>}
    <details className="ws-history-values"><summary>Ölçümleri tablo olarak göster</summary><div className="ws-table-scroll"><table className="ws-table"><thead><tr><th scope="col">Zaman</th>{series.map(([key, label]) => <th key={key} scope="col">{label}</th>)}</tr></thead><tbody>{samples.map((point) => <tr key={point.timestamp}><td>{time(point.timestamp)}</td>{series.map(([key]) => <td key={key}>{point[key] === null ? 'Bilinmiyor' : `%${Math.round(point[key])}`}</td>)}</tr>)}</tbody></table></div></details>
  </div>;
}
