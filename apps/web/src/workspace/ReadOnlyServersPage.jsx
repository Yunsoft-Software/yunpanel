import { useWorkspace } from './WorkspaceContext.jsx';
import { CollectionNotice, EmptyState, Icon, PageHeading, Section } from './PanelKit.jsx';
import { ServerSummary } from './DashboardPage.jsx';

export default function ReadOnlyServersPage() {
  const { servers } = useWorkspace();
  return <>
    <PageHeading title="Sunucular" description="Read Only hesabı: sistem envanteri ve bağlantı durumu görüntülenir; enrollment ve sistem işlemleri kapalıdır." actions={<button type="button" className="ws-button" onClick={servers.refresh}><Icon name="refresh" />Yenile</button>} />
    <CollectionNotice resource={servers} label="Sunucular" />
    {servers.items.length ? <div className="ws-equal-columns">{servers.items.map((server) => <Section key={server.id} title={server.displayName ?? server.name ?? server.hostname}><ServerSummary server={server} /></Section>)}</div> : servers.status === 'ready' && <EmptyState title="Sunucu kaydı yok" detail="Kayıtlı sunucu bulunamadı." icon="server" />}
    <Section title="Salt okunur erişim"><div className="ws-section-body"><p className="ws-muted">Enrollment tokenı oluşturma, servis/paket işlemleri, terminal ve diğer sunucu yönetim araçları bu hesapta yüklenmez.</p></div></Section>
  </>;
}
