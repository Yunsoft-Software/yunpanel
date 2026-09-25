import {useEffect,useRef,useState} from 'react';
import {useNavigate} from 'react-router';
import {panelRequest} from '../api.js';
import {sessionTransitionPending,sessionVersion} from '../session-client.js';
import {usePanelSession} from '../panel-session.jsx';
import {useWorkspace} from './WorkspaceContext.jsx';
import {Badge,Button,ConfirmDialog,EmptyState,ErrorNotice,KeyValues,Section} from './PanelKit.jsx';
import {createWebsiteRemovalClient} from './website-removal-client.js';
import {nextRemovalStep,removalBlockerLabel,resolveRemovalAccess} from './website-removal-model.js';

const ACCESS={forbidden:'Site silme yalnız Owner tarafından yönetilir.',unavailable:'Güncel Website bilgileri bekleniyor.',
 not_found:'Bu alan adına bağlı tek Website kaydı bulunamadı.',unbound:'Alan adı henüz Website kaydına bağlı değil.',
 inconsistent:'Site ve sunucu bağlantısı doğrulanamadı.'};
const STEP_LABELS={domain_removal:'Alan adını kaldır',cron_cleanup:'Zamanlanmış görevleri temizle',sftp_key_cleanup:'SFTP anahtarlarını kaldır',
 database_binding_cleanup:'Veritabanı bağlantılarını kaldır',runtime_cleanup:'Runtime bağlantısını kaldır',
 unix_identity_cleanup:'Site Unix kullanıcısını kaldır',file_cleanup:'Site dosyalarını kaldır',metadata_finalization:'Website kaydını kaldır',
 application_cleanup:'Application ve environment kaydını kaldır'};
export default function WebsiteRemovalPanel({domainId}){
 const {session}=usePanelSession();const {domains,websites,isOwner,refreshAll}=useWorkspace();
 const access=resolveRemovalAccess({domainId,domains,websites,isOwner});
 if(access.state!=='ready')return isOwner?<Section title="Siteyi sil"><EmptyState icon="trash" title="Silme önizlemesi açılamadı" detail={ACCESS[access.state]}
  action={access.state!=='forbidden'&&<Button icon="refresh" onClick={refreshAll}>Site bilgilerini yenile</Button>}/></Section>:null;
 const generation=sessionVersion();
 return <RemovalWorkspace key={JSON.stringify([domainId,access.scope,session?.user?.id,generation])} scope={access.scope} generation={generation}/>;
}
function RemovalWorkspace({scope,generation}){
 const navigate=useNavigate(),ref=useRef(null),live=useRef(true);const [state,setState]=useState(null),[confirm,setConfirm]=useState(false);
 useEffect(()=>{live.current=true;const client=createWebsiteRemovalClient({scope,request:panelRequest,
  isCurrent:()=>live.current&&generation===sessionVersion()&&!sessionTransitionPending(),
  onRemoved:()=>{}});
  ref.current=client;const unsub=client.subscribe(setState);setState(client.getSnapshot());void client.load();
  return()=>{live.current=false;unsub();client.dispose();ref.current=null;};},[scope.websiteId,scope.serverId,generation]);
 const preview=state?.data?.preview,operation=state?.operation,next=nextRemovalStep(operation);
 const counts=preview?{domains:preview.plan.domains.length,databases:preview.plan.additional.databases.ids.length,sftp:preview.plan.additional.sftpKeys.ids.length,
  cron:preview.plan.additional.crons.ids.length,backups:preview.plan.additional.backups.ids.length}:null;
 async function start(){setConfirm(false);await ref.current?.start();}
 return <Section title="Siteyi sil" description="Website'i ve bağlı yönetilen kaynakları kalıcı olarak, journal adımlarıyla kaldırır."
  actions={<Button icon="refresh" disabled={state?.loading||state?.busy||state?.denied} onClick={()=>void (operation?ref.current?.refreshOperation(operation.id):ref.current?.load())}>Durumu yenile</Button>}>
  <div className="ws-section-body"><ErrorNotice error={state?.error}/>
   {state?.loading&&!preview&&<p role="status">Silme etkisi hesaplanıyor…</p>}
   {preview&&<><KeyValues items={[
    ['Bağlı alan adı',counts.domains],['Veritabanı bağlantısı',counts.databases],['SFTP anahtarı',counts.sftp],
    ['Zamanlanmış görev',counts.cron],['Korunacak yedek kaydı',counts.backups],
    ['Silme durumu',preview.readyToStart?'Hazır':'Güvenlik blocker’ı var'],
   ]}/>
    {!preview.readyToStart&&<Blockers blockers={preview.hardBlockers}/>}
   </>}
   {!operation&&preview?.readyToStart&&<><div className="ws-notice ws-notice-warn"><div><strong>Kalıcı silme</strong>
    <p>Bağlı web alan adları, zamanlanmış görevler, SFTP anahtarları, veritabanı bağları, runtime, site Unix kullanıcısı, canonical dosya kökleri, Website ve Application metadata kaldırılır. Retained backup/log kayıtları korunur.</p></div></div>
    <Button variant="danger" disabled={state?.busy} onClick={()=>setConfirm(true)}>Siteyi sil…</Button></>}
   {operation&&<Operation operation={operation} next={next} busy={state?.busy} onContinue={()=>void ref.current?.continueStep()} onDone={()=>navigate('/websites')}/>}
   {state?.unknownMutation&&<p className="ws-muted">Belirsiz yazma sonucu nedeniyle aynı POST tekrar edilmedi; kalıcı removal journal sunucudan yeniden okundu.</p>}
   <p className="ws-muted">Her çağrı yalnız journal'daki mevcut adımı ilerletir. Sonraki adım için yeniden açıkça devam etmeniz gerekir.</p>
  </div>
  {confirm&&<ConfirmDialog title="Siteyi kalıcı olarak sil" confirmation={scope.label} busy={state?.busy} error={state?.error}
   message={scope.label+' ve bu Website’e bağlı yönetilen web kaynakları kalıcı olarak kaldırılacak. Yedek kayıtları silinmeyecek. Bu işlem adım adım journal üzerinden yürütülür.'}
   onCancel={()=>setConfirm(false)} onConfirm={()=>void start()} confirmLabel="Silme işlemini başlat"/>}
 </Section>;
}
function Operation({operation,next,busy,onContinue,onDone}){
 const done=operation.status==='removed';
 const failed=['failed','blocked'].includes(operation.status);
 const completed=operation.steps.filter((step)=>step.status==='succeeded').length;
 return <div><h3>Silme journal’ı</h3><KeyValues items={[
  ['Durum',operation.status],['Tamamlanan adım',completed+' / '+operation.steps.length],
  ['Sıradaki adım',next?(STEP_LABELS[next.kind]??next.kind):done?'Tamamlandı':'Kontrol gerekli'],
 ]}/>
 <p><Badge state={done?'succeeded':failed?'warning':'running'}>{done?'Silindi':failed?'Müdahale gerekli':'Devam ediyor'}</Badge></p>
 {done?<Button variant="primary" onClick={onDone}>Web sitelerine dön</Button>
  :next?<Button variant={failed?'danger':'primary'} disabled={busy} onClick={onContinue}>{failed?'Bu adımı açıkça yeniden dene':'Sonraki silme adımını çalıştır'}</Button>
  :<p className="ws-muted">Journal ilerletilebilir bir adım göstermiyor. Durumu yenileyin ve Silme kurtarma bölümünü kontrol edin.</p>}
 </div>;
}
function Blockers({blockers}){
 if(!blockers.length)return <div className="ws-notice ws-notice-warn"><div><strong>Silme henüz hazır değil</strong><p>Backend güvenli tamamlama kanıtı üretmedi.</p></div></div>;
 return <div className="ws-notice ws-notice-warn"><div><strong>Silme kapalı</strong><ul>{blockers.map((code)=><li key={code}>{removalBlockerLabel(code)}</li>)}</ul></div></div>;
}
