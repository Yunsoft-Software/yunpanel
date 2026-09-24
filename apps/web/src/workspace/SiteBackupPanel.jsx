import { useEffect, useRef, useState } from 'react';
import { panelRequest } from '../api.js';
import { usePanelSession } from '../panel-session.jsx';
import { sessionTransitionPending, sessionVersion } from '../session-client.js';
import { useWorkspace } from './WorkspaceContext.jsx';
import { Badge, Button, EmptyState, ErrorNotice, KeyValues, Section } from './PanelKit.jsx';
import { formatDate } from './site-model.js';
import { resolveSiteBackupAccess } from './site-backup-model.js';
import { createSiteBackupClient } from './site-backup-client.js';

const ACCESS = {
  forbidden: 'Bu sitenin yedeklerine erişim izniniz yok.',
  unavailable: 'Güncel site bilgileri bekleniyor.',
  not_found: 'Bu alan adına bağlı tek bir Website kaydı bulunamadı.',
  unbound: 'Alan adı henüz bir Website kaydına bağlı değil.',
  inconsistent: 'Site ve sunucu bağlantısı doğrulanamadı.',
};
const repoState = (value) => value === 'ready' ? 'Hazır' : value === 'error' ? 'Kontrol gerekli' : 'Hazırlanmadı';
const snapshotState = (value) => ({ ready: 'Güncel', partial: 'Kısmi liste', error: 'Okunamadı', unavailable: 'Depo hazır değil' })[value] ?? 'Bilinmiyor';

export default function SiteBackupPanel({ domainId }) {
  const { session } = usePanelSession();
  const { domains, websites, canManage, refreshAll, isOwner } = useWorkspace();
  const access = resolveSiteBackupAccess({ domainId, domains, websites, canManage });
  if (access.state !== 'ready') {
    return <Section title="Yedekleme ve Geri Yükleme"><EmptyState icon="archive" title="Yedekler açılamadı"
      detail={ACCESS[access.state]} action={access.state !== 'forbidden' && <Button icon="refresh" onClick={refreshAll}>Site bilgilerini yenile</Button>} /></Section>;
  }
  const generation = sessionVersion();
  const identity = JSON.stringify([domainId, access.scope, session?.user?.id, session?.user?.role, generation, canManage]);
  return <BackupWorkspace key={identity} scope={access.scope} generation={generation} isOwner={isOwner} />;
}

function BackupWorkspace({ scope, generation, isOwner }) {
  const ref = useRef(null);
  const live = useRef(true);
  const [state, setState] = useState(null);
  useEffect(() => {
    live.current = true;
    const client = createSiteBackupClient({
      scope,
      request: panelRequest,
      isCurrent: () => live.current && generation === sessionVersion() && !sessionTransitionPending(),
    });
    ref.current = client;
    const unsubscribe = client.subscribe(setState);
    setState(client.getSnapshot());
    void client.load();
    return () => { live.current = false; unsubscribe(); client.dispose(); ref.current = null; };
  }, [scope.websiteId, scope.serverId, generation]);
  const data = state?.data;
  return <>
    <Section title="Yedekleme ve Geri Yükleme" description="Bu siteye ait yedek kapsamını ve geri yüklenebilir snapshotları görüntüleyin."
      actions={<Button icon="refresh" disabled={state?.loading || state?.denied} onClick={() => void ref.current?.load()}>Yedekleri yenile</Button>}>
      <div className="ws-section-body"><ErrorNotice error={state?.error} />
        {state?.loading && !data && <p role="status">Yedekleme bilgileri okunuyor…</p>}
        {data && <><p className="ws-muted">{state.fresh ? 'Son kontrol' : 'Önceki kontrol'}: {formatDate(data.inspectedAt)}</p>
          <KeyValues items={[
            ['Dosya/veri hedef grubu', data.backupSet.pathCount],
            ['Veritabanı', data.backupSet.databaseCount],
            ['Posta kapsamı', data.backupSet.mailCount],
            ['DNS kapsamı', data.backupSet.dnsCount],
            ['Docker quiesce', data.backupSet.composeHooksEnabled ? 'Kullanılıyor' : 'Gerekli değil'],
          ]} /></>}
        <p className="ws-muted">{isOwner
          ? 'Bu ekranda mevcut yedekler güvenli şekilde listelenir. Yeni yedek/geri yükleme motoru senkron olduğu için bağlantı kopmasında sonucu belirsiz bırakabilir; durable işlem hattına taşınmadan buradan çalıştırılmaz.'
          : 'Site hesabı yalnız kendi yedeklerini görür. Depo hedefi, sunucu yolu ve diğer sitelerin snapshotları gösterilmez; yeni yedek ve geri yükleme Owner işlemi olarak kalır.'}</p>
      </div>
    </Section>
    {data && data.repositories.length === 0 && <EmptyState icon="archive" title="Yedek deposu yok" detail="Bu sunucu için henüz yapılandırılmış bir Restic deposu bulunmuyor." />}
    {data?.repositories.map((repository) => <Repository key={repository.id} repository={repository} />)}
  </>;
}

function Repository({ repository }) {
  const description = (repository.backend === 'rclone' ? 'Uzak depo' : 'Yerel depo') + ' · ' + repoState(repository.status);
  return <Section title={repository.name} description={description}>
    <div className="ws-section-body"><KeyValues items={[
      ['Depo durumu', repoState(repository.status)],
      ['Snapshot görünümü', snapshotState(repository.snapshotStatus)],
      ['Son depo kontrolü', formatDate(repository.lastCheckedAt)],
      ['Son kayıtlı snapshot', formatDate(repository.lastSnapshotAt)],
      ['Saklama politikası', retentionLabel(repository.retentionPolicy)],
    ]} /></div>
    {repository.snapshots.length === 0
      ? <EmptyState icon="archive" title="Bu site için snapshot yok"
        detail={repository.snapshotStatus === 'error'
          ? 'Snapshot listesi okunamadı; depo yolunu veya ham hatayı site hesabına göstermeden Owner kontrolü gerekir.'
          : 'Bu depoda bu Website etiketiyle eşleşen snapshot bulunamadı.'} />
      : <div className="ws-table-wrap"><table className="ws-table"><thead><tr><th>Snapshot</th><th>Tür</th><th>Tarih</th></tr></thead><tbody>
        {repository.snapshots.map((snapshot) => <tr key={snapshot.id}><td><code>{snapshot.shortId}</code></td>
          <td><Badge state={snapshot.kind === 'pre_restore' ? 'warning' : 'active'}>{snapshot.kind === 'pre_restore' ? 'Geri yükleme öncesi' : 'Site yedeği'}</Badge></td>
          <td>{formatDate(snapshot.time)}</td></tr>)}
      </tbody></table></div>}
  </Section>;
}

function retentionLabel(value) {
  if (!value) return 'Tanımlı değil';
  const labels = [];
  for (const [key, label] of [['keepLast', 'son'], ['keepDaily', 'günlük'], ['keepWeekly', 'haftalık'], ['keepMonthly', 'aylık'], ['keepYearly', 'yıllık']]) {
    if (value[key]) labels.push(String(value[key]) + ' ' + label);
  }
  return labels.join(' · ') || 'Özel politika';
}
