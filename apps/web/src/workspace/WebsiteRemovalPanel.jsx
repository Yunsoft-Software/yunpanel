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
export default function WebsiteRemovalPanel({domainId,onChanged}){
 const {session}=usePanelSession();const {domains,websites,isOwner,refreshAll}=useWorkspace();
 const access=resolveRemovalAccess({domainId,domains,websites,isOwner});
 if(access.state!=='ready')return isOwner?<Section title="Siteyi sil"><EmptyState icon="trash" title="Silme önizlemesi açılamadı" detail={ACCESS[access.state]}
  action={access.state!=='forbidden'&&<Button icon="refresh" onClick={refreshAll}>Site bilgilerini yenile</Button>}/></Section>:null;
 const generation=sessionVersion();
 return <RemovalWorkspace key={JSON.stringify([domainId,access.scope,session?.user?.id,generation])} scope={access.scope} generation={generation} onChanged={onChanged??refreshAll}/>;
}
function RemovalWorkspace({scope,generation,onChanged}){
 const navigate=useNavigate(),ref=useRef(null),live=useRef(true);const [state,setState]=useState(null),[confirm,setConfirm]=useState(false);
 useEffect(()=>{live.current=true;const client=createWebsiteRemovalClient({scope,request:panelRequest,
  isCurrent:()=>live.current&&generation===sessionVersion()&&!sessionTransitionPending(),
  onRemoved:()=>{onChanged?.();}});
  ref.current=client;const unsub=client.subscribe(setState);setState(client.getSnapshot());void client.load();
  return()=>{live.current=false;unsub();client.dispose();ref.current=null;};},[scope.websiteId,scope.serverId,generation]);
 const preview=state?.data?.preview,operation=state?.operation,next=nextRemovalStep(operation);
 const subdomains=preview?.plan?.domains?.filter((d)=>Boolean(d.parentDomainId))??[];
 const rootDomains=preview?.plan?.domains?.filter((d)=>!d.parentDomainId)??[];
 const counts=preview?{domains:preview.plan.domains.length,subdomains:subdomains.length,rootDomains:rootDomains.length,databases:preview.plan.additional.databases.ids.length,sftp:preview.plan.additional.sftpKeys.ids.length,
  cron:preview.plan.additional.crons.ids.length,backups:preview.plan.additional.backups.ids.length,runtime:preview.plan.applicationRuntime?.type??(preview.website.applicationId?'Uygulama runtime':'Statik site')}:null;
 async function start(){setConfirm(false);await ref.current?.start();}
 return <Section title="Siteyi sil" description="Web sitesini ve bağlı yönetilen kaynakları kalıcı olarak, güvenli işlem adımlarıyla kaldırır."
  actions={<Button icon="refresh" disabled={state?.loading||state?.busy||state?.denied} onClick={()=>void (operation?ref.current?.refreshOperation(operation.id):ref.current?.load())}>Durumu yenile</Button>}>
  <div className="ws-section-body"><ErrorNotice error={state?.error}/>
   {state?.loading&&!preview&&<p role="status">Silme etkisi hesaplanıyor…</p>}
   {preview&&<><KeyValues items={[
    ['Bağlı alan adı',counts.rootDomains],
    ['Alt alan adı (subdomain)',counts.subdomains>0?counts.subdomains:'Yok'],
    ['Site dosyaları',preview.website.systemUser?`${preview.website.systemUser} kullanıcısına ait dosya kökü temizlenir`:'Site dosya kökleri temizlenir'],
    ['Veritabanı bağlantısı',counts.databases],
    ['E-posta etkisi','Bağlı alan adlarına ait posta kutuları ve yönlendirmeleri kaldırılır'],
    ['Uygulama çalışma zamanı (runtime)',counts.runtime],
    ['DNS bölgesi ve kayıtları','Alan adına ait DNS kayıtları ve yönlendirmeleri temizlenir'],
    ['SSL/TLS sertifikası','Bağlı sertifikalar emekliye ayrılır (retire)'],
    ['Zamanlanmış görev',counts.cron],
    ['SFTP anahtarı',counts.sftp],
    ['Korunacak yedek kaydı',`${counts.backups} (yedek kayıtları silinmez, korunur)`],
    ['Silme durumu',preview.readyToStart?'Hazır':'Güvenlik engeli var'],
   ]}/>
    {!preview.readyToStart&&<Blockers blockers={preview.hardBlockers}/>}
   </>}
   {!operation&&preview?.readyToStart&&<><div className="ws-notice ws-notice-warn"><div><strong>Kalıcı silme ve veri saklama (retention)</strong>
    <p>Bağlı web alan adları, alt alan adları, zamanlanmış görevler, SFTP anahtarları, veritabanı bağları, runtime, site Unix kullanıcısı, canonical dosya kökleri, Website ve Application metadata kaldırılır. Korunan yedek kayıtları (backup evidence) ve loglar silinmez, güvenle saklanır. Retained backup/log kayıtları korunur.</p></div></div>
    <Button variant="danger" disabled={state?.busy} onClick={()=>setConfirm(true)}>Siteyi sil…</Button></>}
   {operation&&<Operation operation={operation} next={next} busy={state?.busy} onContinue={()=>void ref.current?.continueStep()} onDone={()=>{onChanged?.();navigate('/websites');}}/>}
   {state?.unknownMutation&&<p className="ws-muted">Belirsiz işlem sonucu nedeniyle aynı istek tekrar edilmedi; güncel sunucu durumu güvenle yeniden okundu.</p>}
   <p className="ws-muted">Her çağrı yalnız journal'daki mevcut adımı ilerletir. Güvenlik gereği sonraki adım için onayınız alınır.</p>
  </div>
  {confirm&&<ConfirmDialog title="Siteyi kalıcı olarak sil" confirmation={scope.label} busy={state?.busy} error={state?.error}
   message={scope.label+' ve bu Website’e bağlı yönetilen web kaynakları kalıcı olarak kaldırılacak. Yedek kayıtları silinmeyecek. Veri saklama (retention) ve yedekleme kanıtları (backup evidence) korunur. Bu işlem adım adım güvenli görev akışı üzerinden yürütülür.'}
   onCancel={()=>setConfirm(false)} onConfirm={()=>void start()} confirmLabel="Silme işlemini başlat"/>}
 </Section>;
}
function Operation({operation,next,busy,onContinue,onDone}){
 const done=operation.status==='removed';
 const failed=['failed','blocked'].includes(operation.status);
 const completed=operation.steps.filter((step)=>step.status==='succeeded').length;
 const failedStep=operation.steps.find((step)=>step.status==='failed'||step.status==='blocked');
 return <div><h3>Silme adımları</h3><KeyValues items={[
  ['Durum',done?'Silindi':failed?'Müdahale gerekli':'Devam ediyor'],['Tamamlanan adım',completed+' / '+operation.steps.length],
  ['Sıradaki adım',next?(STEP_LABELS[next.kind]??next.kind):done?'Tamamlandı':'Kontrol gerekli'],
 ]}/>
 <p><Badge state={done?'succeeded':failed?'warning':'running'}>{done?'Silindi':failed?'Müdahale gerekli':'Devam ediyor'}</Badge></p>
 {failedStep?.error?.code&&<div className="ws-notice ws-notice-warn"><div><strong>Silme engeli</strong><p>{removalBlockerLabel(failedStep.error.code)}</p></div></div>}
 <ul className="ws-step-list" style={{listStyle:'none',padding:0,margin:'1rem 0'}}>
  {operation.steps.map((step)=>(
   <li key={step.id} style={{display:'flex',justifyContent:'space-between',alignItems:'center',padding:'0.35rem 0',borderBottom:'1px solid var(--ws-border)'}}>
    <span>{STEP_LABELS[step.kind]??step.kind}</span>
    <Badge state={step.status==='succeeded'?'succeeded':step.status==='running'?'running':['failed','blocked'].includes(step.status)?'warning':'muted'}>
     {step.status==='succeeded'?'Tamamlandı':step.status==='running'?'Yürütülüyor':step.status==='blocked'?'Engellendi':step.status==='failed'?'Başarısız':'Bekliyor'}
    </Badge>
   </li>
  ))}
 </ul>
 {done?<Button variant="primary" onClick={onDone}>Web sitelerine dön</Button>
  :next?<Button variant={failed?'danger':'primary'} disabled={busy} onClick={onContinue}>{failed?'Bu adımı açıkça yeniden dene':'Sonraki silme adımını çalıştır'}</Button>
  :<p className="ws-muted">İlerletilebilir bir adım bulunmuyor. Durumu yenileyin ve tanılama ayrıntılarını kontrol edin.</p>}
 <details className="ws-disclosure" style={{marginTop:'0.75rem'}}><summary>Tanılama ve teknik işlem ayrıntıları</summary><KeyValues items={[
  ['İşlem kimliği (operationId)',operation.id],['Ham durum (raw status)',operation.status],
 ]}/></details>
 </div>;
}
function Blockers({blockers}){
 if(!blockers.length)return <div className="ws-notice ws-notice-warn"><div><strong>Silme henüz hazır değil</strong><p>Sunucu güvenlik ve tamamlama önkoşulları henüz karşılanmadı.</p></div></div>;
 return <div className="ws-notice ws-notice-warn"><div><strong>Silme engelleri</strong><ul>{blockers.map((code)=><li key={code}>{removalBlockerLabel(code)}</li>)}</ul></div></div>;
}
