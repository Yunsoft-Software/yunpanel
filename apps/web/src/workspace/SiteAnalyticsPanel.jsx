import {useEffect,useRef,useState} from 'react';
import {panelRequest} from '../api.js';
import {usePanelSession} from '../panel-session.jsx';
import {sessionTransitionPending,sessionVersion} from '../session-client.js';
import {useWorkspace} from './WorkspaceContext.jsx';
import {Badge,Button,EmptyState,ErrorNotice,KeyValues,Section} from './PanelKit.jsx';
import {formatDate} from './site-model.js';
import {createSiteAnalyticsClient} from './site-analytics-client.js';
import {resolveSiteAnalyticsAccess} from './site-analytics-model.js';

const ACCESS={forbidden:'Bu sitenin istatistiklerine erişim izniniz yok.',unavailable:'Güncel site bilgileri bekleniyor.',
 not_found:'Bu alan adına bağlı tek bir Website kaydı bulunamadı.',unbound:'Alan adı henüz bir Website kaydına bağlı değil.',
 inconsistent:'Site ve sunucu bağlantısı doğrulanamadı.'};

export default function SiteAnalyticsPanel({domainId}){
 const {session}=usePanelSession();const {domains,websites,canManage,refreshAll,isOwner}=useWorkspace();
 const access=resolveSiteAnalyticsAccess({domainId,domains,websites,canManage});
 if(access.state!=='ready')return <Section title="İstatistikler"><EmptyState icon="dashboard" title="İstatistikler açılamadı"
  detail={ACCESS[access.state]} action={access.state!=='forbidden'&&<Button icon="refresh" onClick={refreshAll}>Site bilgilerini yenile</Button>}/></Section>;
 const generation=sessionVersion();
 return <AnalyticsWorkspace key={JSON.stringify([domainId,access.scope,session?.user?.id,session?.user?.role,generation])}
  scope={access.scope} generation={generation} isOwner={isOwner}/>;
}
function AnalyticsWorkspace({scope,generation,isOwner}){
 const ref=useRef(null),live=useRef(true);const [state,setState]=useState(null);
 useEffect(()=>{live.current=true;const client=createSiteAnalyticsClient({scope,request:panelRequest,isOwner,
  isCurrent:()=>live.current&&generation===sessionVersion()&&!sessionTransitionPending()});
  ref.current=client;const unsub=client.subscribe(setState);setState(client.getSnapshot());void client.load();
  return()=>{live.current=false;unsub();client.dispose();ref.current=null;};},[scope.websiteId,scope.serverId,generation,isOwner]);
 const status=state?.status,htmlUrl='/api/websites/'+encodeURIComponent(scope.websiteId)+'/analytics/report?format=html';
 return <>
  <Section title="İstatistikler" description="Bu siteye ait Nginx erişim günlüğünden GoAccess raporu oluşturun."
   actions={<Button icon="refresh" disabled={state?.loading||state?.busy||state?.denied} onClick={()=>void ref.current?.load()}>Durumu yenile</Button>}>
   <div className="ws-section-body"><ErrorNotice error={state?.error}/>
    {state?.loading&&!status&&<p role="status">İstatistik servisi kontrol ediliyor…</p>}
    {status&&<KeyValues items={[
     ['GoAccess',status.available?'Kullanılabilir':'Bulunamadı'],
     ['Sürüm',status.version??'Doğrulanamadı'],
     ['Gerçek zamanlı servis',status.running?'Çalışıyor':'Durduruldu'],
     ['Canlı bağlantı',status.socketReady?'Hazır':'Hazır değil'],
     ['Son statik rapor',state.report?formatDate(state.report.generatedAt):'Bu oturumda oluşturulmadı'],
    ]}/>}
    <p className="ws-muted">Rapor yalnız bu Website'in erişim günlüğünden üretilir. PID, Unix socket yolu ve sunucu dosya yolları panelde gösterilmez.</p>
    {status?.available&&<div className="ws-actions">
     <Button disabled={state?.busy} onClick={()=>void ref.current?.generateReport()}>Statik raporu yenile</Button>
     <a className="ws-button" href={htmlUrl} target="_blank" rel="noopener noreferrer">Statik raporu aç</a>
     {isOwner&&status.running&&<a className="ws-button" href={'/tools/goaccess/'+encodeURIComponent(scope.websiteId)+'/'} target="_blank" rel="noopener noreferrer">Gerçek zamanlı görünümü aç</a>}
    </div>}
    {!isOwner&&<p className="ws-muted">Gerçek zamanlı GoAccess servisinin başlatma/durdurma yönetimi Owner aracıdır; site hesabı statik raporu kullanabilir.</p>}
   </div>
  </Section>
  {isOwner&&status?.available&&<Section title="Gerçek zamanlı istatistik servisi"><div className="ws-section-body">
   <p><Badge state={status.running?'active':'off'}>{status.running?'Çalışıyor':'Durduruldu'}</Badge></p>
   <div className="ws-actions">
    {!status.running&&<Button variant="primary" disabled={state?.busy} onClick={()=>void ref.current?.realtime('start')}>Başlat</Button>}
    {status.running&&<><Button disabled={state?.busy} onClick={()=>void ref.current?.realtime('restart')}>Yeniden başlat</Button>
     <Button variant="danger" disabled={state?.busy} onClick={()=>void ref.current?.realtime('stop')}>Durdur</Button></>}
   </div>
   {state?.unknownMutation&&<p className="ws-muted">Önceki isteğin sonucu bilinmediği için komut tekrar gönderilmedi; yukarıdaki durum sunucudan yeniden okundu.</p>}
  </div></Section>}
 </>;
}
