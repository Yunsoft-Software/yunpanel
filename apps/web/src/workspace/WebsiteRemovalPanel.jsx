import {useEffect,useRef,useState} from 'react';
import {panelRequest} from '../api.js';
import {sessionTransitionPending,sessionVersion} from '../session-client.js';
import {usePanelSession} from '../panel-session.jsx';
import {useWorkspace} from './WorkspaceContext.jsx';
import {Badge,Button,EmptyState,ErrorNotice,KeyValues,Section} from './PanelKit.jsx';
import {createWebsiteRemovalClient} from './website-removal-client.js';
import {removalBlockerLabel,resolveRemovalAccess} from './website-removal-model.js';

const ACCESS={forbidden:'Site silme yalnız Owner tarafından yönetilir.',unavailable:'Güncel Website bilgileri bekleniyor.',
 not_found:'Bu alan adına bağlı tek Website kaydı bulunamadı.',unbound:'Alan adı henüz Website kaydına bağlı değil.',
 inconsistent:'Site ve sunucu bağlantısı doğrulanamadı.'};
export default function WebsiteRemovalPanel({domainId}){
 const {session}=usePanelSession();const {domains,websites,isOwner,refreshAll}=useWorkspace();
 const access=resolveRemovalAccess({domainId,domains,websites,isOwner});
 if(access.state!=='ready')return isOwner?<Section title="Siteyi sil"><EmptyState icon="trash" title="Silme önizlemesi açılamadı" detail={ACCESS[access.state]}
  action={access.state!=='forbidden'&&<Button icon="refresh" onClick={refreshAll}>Site bilgilerini yenile</Button>}/></Section>:null;
 const generation=sessionVersion();
 return <RemovalWorkspace key={JSON.stringify([domainId,access.scope,session?.user?.id,generation])} scope={access.scope} generation={generation}/>;
}
function RemovalWorkspace({scope,generation}){
 const ref=useRef(null),live=useRef(true);const [state,setState]=useState(null);
 useEffect(()=>{live.current=true;const client=createWebsiteRemovalClient({scope,request:panelRequest,
  isCurrent:()=>live.current&&generation===sessionVersion()&&!sessionTransitionPending()});
  ref.current=client;const unsub=client.subscribe(setState);setState(client.getSnapshot());void client.load();
  return()=>{live.current=false;unsub();client.dispose();ref.current=null;};},[scope.websiteId,scope.serverId,generation]);
 const preview=state?.data?.preview,latest=state?.data?.operations?.[0]??null;
 const counts=preview?{domains:preview.plan.domains.length,databases:preview.plan.additional.databases.ids.length,sftp:preview.plan.additional.sftpKeys.ids.length,
  cron:preview.plan.additional.crons.ids.length,backups:preview.plan.additional.backups.ids.length}:null;
 return <Section title="Siteyi sil" description="Website'i kalıcı olarak kaldırmadan önce tüm bağlı kaynakların güvenli biçimde temizlenebilir olduğunu doğrular."
  actions={<Button icon="refresh" disabled={state?.loading||state?.denied} onClick={()=>void ref.current?.load()}>Silme etkisini yenile</Button>}>
  <div className="ws-section-body"><ErrorNotice error={state?.error}/>
   {state?.loading&&!preview&&<p role="status">Silme etkisi hesaplanıyor…</p>}
   {preview&&<><KeyValues items={[
    ['Bağlı alan adı',counts.domains],['Veritabanı bağlantısı',counts.databases],['SFTP anahtarı',counts.sftp],
    ['Zamanlanmış görev',counts.cron],['Korunacak yedek kaydı',counts.backups],
    ['Silme durumu',preview.readyToStart?'Hazır':'Güvenlik blocker’ı var'],
   ]}/>
    {preview.readyToStart
      ? <div className="ws-notice ws-notice-warn"><div><strong>Backend silmeye hazır</strong><p>Destructive UI bu kaynak diliminde henüz açılmadı; önce tam host/browser kabulü tamamlanacak.</p></div></div>
      : <Blockers blockers={preview.hardBlockers}/>}
   </>}
   {latest&&<p className="ws-muted">Önceki removal journal durumu: <Badge state={latest.status==='removed'?'succeeded':latest.status==='failed'?'failed':'warning'}>{latest.status}</Badge>. Yarım kalmış işlem varsa yeni removal başlatılmadan aynı journal devam ettirilmelidir.</p>}
   <p className="ws-muted">Bu kart yalnız önizleme yapar. Backend Application, dosya ve Unix identity cleanup zincirini eksiksiz doğrulamadan Sil butonu gösterilmez.</p>
  </div>
 </Section>;
}
function Blockers({blockers}){
 if(!blockers.length)return <div className="ws-notice ws-notice-warn"><div><strong>Silme henüz hazır değil</strong><p>Backend güvenli tamamlama kanıtı üretmedi.</p></div></div>;
 return <div className="ws-notice ws-notice-warn"><div><strong>Silme kapalı</strong><ul>{blockers.map((code)=><li key={code}>{removalBlockerLabel(code)}</li>)}</ul></div></div>;
}
