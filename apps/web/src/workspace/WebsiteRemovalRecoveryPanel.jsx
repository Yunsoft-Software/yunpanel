import {useEffect,useRef,useState} from 'react';
import {panelRequest} from '../api.js';
import {usePanelSession} from '../panel-session.jsx';
import {sessionTransitionPending,sessionVersion} from '../session-client.js';
import {Badge,Button,ConfirmDialog,ErrorNotice,Icon} from './PanelKit.jsx';
import {globalRemovalOperation,removalErrorMessage} from './website-removal-model.js';
import WebsiteRemovalProgress from './WebsiteRemovalProgress.jsx';

export default function WebsiteRemovalRecoveryPanel({onChanged}){
 const {session}=usePanelSession(),generation=sessionVersion();
 const [state,setState]=useState({operations:[],loading:true,busy:null,error:null,unknown:false});
 const [drawerOpen,setDrawerOpen]=useState(false);
 const [confirm,setConfirm]=useState(null);const live=useRef(true),seq=useRef(0),knownActive=useRef(new Set());
 const current=()=>live.current&&generation===sessionVersion()&&!sessionTransitionPending();
 async function load(){
  if(!current())return;const requestSeq=++seq.current;setState(value=>({...value,loading:true}));
  try{
   const values=await panelRequest('/website-removal-operations');if(!current()||requestSeq!==seq.current)return;
   if(!Array.isArray(values))throw new Error('Invalid removal operation list');
   const operations=values.map(globalRemovalOperation);
   const completed=operations.some(operation=>operation.status==='removed'&&knownActive.current.has(operation.id));
   knownActive.current=new Set(operations.filter(operation=>operation.status!=='removed').map(operation=>operation.id));
   setState(value=>({...value,operations,loading:false,error:null,unknown:false}));
   if(completed)onChanged?.();
  }catch(error){if(current()&&requestSeq===seq.current)setState(value=>({...value,loading:false,
    ...([401,403].includes(error?.status)?{operations:[]}:{}),error:removalErrorMessage(error)}));}
 }
 useEffect(()=>{live.current=true;knownActive.current=new Set();void load();return()=>{live.current=false;++seq.current;};},[session?.user?.id,generation]);
 useEffect(()=>{
  if(state.loading||!state.operations.some(operation=>operation.execution?.mode==='automatic'&&['pending','running'].includes(operation.status)))return;
  const timer=setTimeout(()=>void load(),2000);return()=>clearTimeout(timer);
 },[state.operations,state.loading,generation]);
 const active=state.operations.filter(operation=>operation.status!=='removed');
 const runningCount=active.filter(operation=>['pending','running'].includes(operation.status)).length;
 const pausedCount=active.length-runningCount;
 function verified(value,original){
  const result=globalRemovalOperation(value);
  if(result.id!==original.id||result.websiteId!==original.websiteId||result.serverId!==original.serverId)throw new Error('Removal operation scope changed');
  return result;
 }
 async function advance(operation){
  setConfirm(null);if(!current()||state.busy||!operation.actions.runConfirmation)return;
  setState(value=>({...value,busy:operation.id,error:null,unknown:false}));let sent=false;
  try{
   sent=true;const updated=verified(await panelRequest('/website-removal-operations/'+encodeURIComponent(operation.id)+'/run',{
    method:'POST',body:{expectedUpdatedAt:operation.updatedAt,confirmation:operation.actions.runConfirmation},
   }),operation);
   if(current())setState(value=>({...value,operations:value.operations.map(item=>item.id===updated.id?updated:item)}));
   if(updated.status==='removed')onChanged?.();
  }catch(error){
   if(current()&&sent&&![400,401,403].includes(error?.status)){
    try{
     const updated=verified(await panelRequest('/website-removal-operations/'+encodeURIComponent(operation.id)),operation);
     if(current())setState(value=>({...value,operations:value.operations.map(item=>item.id===updated.id?updated:item),unknown:true,
      error:'Devam isteğinin cevabı doğrulanamadı; POST tekrar edilmedi ve işlem kaydı yeniden okundu.'}));
     if(updated.status==='removed')onChanged?.();return;
    }catch{}
   }
   if(current())setState(value=>({...value,error:removalErrorMessage(error)}));
  }finally{if(current())setState(value=>({...value,busy:null}));}
 }
 if(active.length===0&&!state.error)return null;
 return <>
  <div className="ws-notice ws-notice-warn yp-removal-recovery-bar" role="region" aria-label="Site silme işlemleri"
   style={{display:'flex',alignItems:'center',justifyContent:'space-between',gap:'0.75rem',flexWrap:'wrap',padding:'0.65rem 0.9rem'}}>
   <div style={{display:'flex',alignItems:'center',gap:'0.6rem',flexWrap:'wrap'}}>
    <Icon name="alert"/>
    <strong>Site silme işlemleri</strong>
    {active.length>0&&<Badge state={pausedCount>0?'warning':'running'}>{active.length} işlem</Badge>}
    <span className="ws-muted">
     {runningCount>0&&pausedCount>0
      ?`${runningCount} silme işlemi çalışıyor, ${pausedCount} işlem devam onayı veya inceleme bekliyor.`
      :runningCount>0
       ?`${runningCount} site silme işlemi arka planda yürütülüyor.`
       :pausedCount>0
        ?`${pausedCount} yarım kalan silme işlemi bildirim panelinde bekliyor.`
        :'Silme işlemleri durumu güncellenemedi.'}
    </span>
   </div>
   <div className="ws-actions" style={{alignItems:'center',gap:'0.45rem'}}>
    {active.length>0&&<Button variant="primary" onClick={()=>setDrawerOpen(true)}>
     Silme bildirimlerini aç ({active.length})
    </Button>}
    <Button icon="refresh" disabled={state.loading||Boolean(state.busy)} onClick={()=>void load()}>Yenile</Button>
   </div>
  </div>
  {!drawerOpen&&state.error&&<ErrorNotice error={state.error}/>}
  {drawerOpen&&<div className="ws-drawer-backdrop yp-notification-backdrop" onClick={event=>{if(event.target===event.currentTarget)setDrawerOpen(false);}}>
   <aside className="ws-drawer ws-notification-drawer yp-notification-drawer" role="complementary" aria-label="Site silme bildirim paneli">
    <header className="ws-drawer-header yp-notification-header">
     <div>
      <h2 style={{margin:0,fontSize:'1.05rem'}}>Site silme işlemleri</h2>
      <small className="ws-muted">Devam eden ve yarım kalan silme işlemlerinin sonuçlarını burada takip edin ({active.length} kayıt)</small>
     </div>
     <div className="ws-actions" style={{alignItems:'center',gap:'0.4rem'}}>
      <Button icon="refresh" disabled={state.loading||Boolean(state.busy)} onClick={()=>void load()}>Yenile</Button>
      <Button icon="close" aria-label="Silme bildirim panelini kapat" onClick={()=>setDrawerOpen(false)}/>
     </div>
    </header>
    <div className="ws-drawer-body yp-notification-body" style={{display:'flex',flexDirection:'column',gap:'0.75rem'}}>
     <ErrorNotice error={state.error}/>
     {active.map(operation=><div key={operation.id} className="ws-notice ws-notice-warn"><div>
      <strong>{operation.label??'Yarım kalan site'}</strong>
      <WebsiteRemovalProgress operation={operation} busy={Boolean(state.busy)} onResume={()=>setConfirm(operation)}/>
     </div></div>)}
     {state.unknown&&<p className="ws-muted">Güncel işlem kaydı okundu; yeni bir silme işlemi başlatılmadı.</p>}
    </div>
   </aside>
  </div>}
  {confirm&&<ConfirmDialog title="Silme işlemine devam et" confirmation={confirm.label??confirm.websiteId} busy={Boolean(state.busy)}
   message="Bu site için tamamlanan adımlar korunacak ve kalan silme işlemleri sunucuda yürütülecek. Korunan yedekler saklanacak."
   onCancel={()=>setConfirm(null)} onConfirm={()=>void advance(confirm)} confirmLabel="Silme işlemine devam et"/>}
 </>;
}
