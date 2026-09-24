import {useEffect,useRef,useState} from 'react';
import {panelRequest} from '../api.js';
import {sessionTransitionPending,sessionVersion} from '../session-client.js';
import {usePanelSession} from '../panel-session.jsx';
import {useWorkspace} from './WorkspaceContext.jsx';
import {Badge,Button,ConfirmDialog,EmptyState,ErrorNotice,KeyValues,Section} from './PanelKit.jsx';
import {formatDate} from './site-model.js';
import {createWebsiteSuspensionClient} from './website-suspension-client.js';
import {resolveWebsiteSuspensionAccess,suspensionAction} from './website-suspension-model.js';

const ACCESS={forbidden:'Bu siteyi yönetme izniniz yok.',unavailable:'Güncel site bilgileri bekleniyor.',
 not_found:'Bu alan adına bağlı tek bir Website kaydı bulunamadı.',unbound:'Alan adı henüz bir Website kaydına bağlı değil.',
 inconsistent:'Site ve sunucu bağlantısı doğrulanamadı.'};
const labels={pending:'Hazırlanıyor',suspending:'Askıya alınıyor',suspended:'Askıda',partial:'Kısmi',failed:'Başarısız',
 resuming:'Yeniden açılıyor',resumed:'Aktif',resume_partial:'Kısmi açıldı',resume_failed:'Yeniden açma başarısız'};
const actionLabels={'start':'Siteyi askıya al','retry-suspend':'Askıya almayı yeniden dene','resume':'Siteyi yeniden aç','retry-resume':'Yeniden açmayı tekrar dene'};

export default function WebsiteSuspensionPanel({domainId,onChanged}){
 const {session}=usePanelSession();const {domains,websites,canManage,refreshAll}=useWorkspace();
 const access=resolveWebsiteSuspensionAccess({domainId,domains,websites,canManage});
 if(access.state!=='ready')return <Section title="Site erişimi"><EmptyState icon="shield" title="Site erişimi yönetilemiyor"
  detail={ACCESS[access.state]} action={access.state!=='forbidden'&&<Button icon="refresh" onClick={refreshAll}>Site bilgilerini yenile</Button>}/></Section>;
 const generation=sessionVersion();
 return <SuspensionWorkspace key={JSON.stringify([domainId,access.scope,session?.user?.id,session?.user?.role,generation])}
  scope={access.scope} generation={generation} onChanged={onChanged}/>;
}
function SuspensionWorkspace({scope,generation,onChanged}){
 const ref=useRef(null),live=useRef(true);const [state,setState]=useState(null),[confirm,setConfirm]=useState(null);
 useEffect(()=>{live.current=true;const client=createWebsiteSuspensionClient({scope,request:panelRequest,
  isCurrent:()=>live.current&&generation===sessionVersion()&&!sessionTransitionPending()});
  ref.current=client;const unsub=client.subscribe(setState);setState(client.getSnapshot());void client.load();
  return()=>{live.current=false;unsub();client.dispose();ref.current=null;};},[scope.websiteId,scope.serverId,generation]);
 const data=state?.data,action=suspensionAction(data),latest=data?.operations?.[0]??null;
 async function execute(){const selected=confirm;setConfirm(null);const result=await ref.current?.mutate(selected);if(result)onChanged?.();}
 const failedDomains=latest?.domainOperations?.filter((item)=>['failed','resume_failed'].includes(item.status)).length??0;
 return <>
  <Section title="Site erişimi" description="Bu Website'e bağlı web yayınlarını birlikte askıya alın veya yeniden açın."
   actions={<Button icon="refresh" disabled={state?.loading||state?.busy||state?.denied} onClick={()=>void ref.current?.load()}>Durumu yenile</Button>}>
   <div className="ws-section-body"><ErrorNotice error={state?.error}/>
    {state?.loading&&!data&&<p role="status">Site erişim durumu kontrol ediliyor…</p>}
    {data&&<KeyValues items={[
     ['Bağlı alan adı',data.preview.domains.length],
     ['Askıya alma hazırlığı',data.preview.readyToSuspend?'Hazır':data.preview.readyToResume?'Site askıda':'Kontrol gerekli'],
     ['Son işlem',latest?labels[latest.status]??latest.status:'Yok'],
     ['Son güncelleme',latest?formatDate(latest.updatedAt):'—'],
     ['Sorunlu alan adı',failedDomains||'Yok'],
    ]}/>}
    <p className="ws-muted">Askıya alma bağlı alan adlarının web yayınını durdurur; posta kutularını, veritabanlarını veya site dosyalarını silmez. Her değişiklik mevcut kalıcı suspension journal üzerinden izlenir.</p>
    {data&&!data.preview.readyToSuspend&&!data.preview.readyToResume&&!action&&<Blockers domains={data.preview.domains}/>}
    {action&&<Button variant={action.kind==='resume'||action.kind==='retry-resume'?'primary':'danger'} disabled={state?.busy} onClick={()=>setConfirm(action.kind)}>{actionLabels[action.kind]}…</Button>}
    {state?.unknownMutation&&<p className="ws-muted">Önceki isteğin sonucu bilinmediği için işlem tekrar gönderilmedi; yukarıdaki durum sunucudan yeniden okundu.</p>}
   </div>
  </Section>
  {latest&&<Section title="Son site erişim işlemi"><div className="ws-section-body">
   <p><Badge state={['suspended','resumed'].includes(latest.status)?'active':['partial','failed','resume_partial','resume_failed'].includes(latest.status)?'warning':'pending'}>{labels[latest.status]??latest.status}</Badge></p>
   <p className="ws-muted">{latest.domainOperations.length} alan adı bu işlem kapsamına bağlıdır. Teknik çocuk operation kimlikleri normal kullanımda gösterilmez.</p>
  </div></Section>}
  {confirm&&<ConfirmDialog title={actionLabels[confirm]} confirmation={scope.label} busy={state?.busy} error={state?.error}
   message={confirm==='start'||confirm==='retry-suspend'
    ? scope.label+' ve bu Website’e bağlı web alan adlarının yayını durdurulacak. Posta, veritabanı ve dosyalar silinmeyecek.'
    : scope.label+' ve bu Website’e bağlı web alan adlarının yayını yeniden etkinleştirilecek.'}
   onCancel={()=>setConfirm(null)} onConfirm={()=>void execute()} confirmLabel={actionLabels[confirm]}/>}
 </>;
}
function Blockers({domains}){
 const blocked=domains.filter((item)=>!item.readyToSuspend&&item.state!=='suspended');
 if(blocked.length===0)return null;
 return <div className="ws-notice ws-notice-warn"><div><strong>Askıya alma hazır değil</strong>
  <p>{blocked.map((item)=>item.primaryDomain).join(', ')} için güncel yayın durumu veya bağımlılık kontrolü tamamlanmadı. Durumu yenileyip tekrar kontrol edin.</p></div></div>;
}
