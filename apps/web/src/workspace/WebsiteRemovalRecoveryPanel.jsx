import {useEffect,useRef,useState} from 'react';
import {panelRequest} from '../api.js';
import {usePanelSession} from '../panel-session.jsx';
import {sessionTransitionPending,sessionVersion} from '../session-client.js';
import {Button,ConfirmDialog,ErrorNotice,Section} from './PanelKit.jsx';
import {globalRemovalOperation,removalErrorMessage} from './website-removal-model.js';
import WebsiteRemovalProgress from './WebsiteRemovalProgress.jsx';

export default function WebsiteRemovalRecoveryPanel({onChanged}){
 const {session}=usePanelSession(),generation=sessionVersion();
 const [state,setState]=useState({operations:[],loading:true,busy:null,error:null,unknown:false});
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
 if(!state.loading&&active.length===0&&!state.error)return null;
 return <Section title="Site silme işlemleri" description="Devam eden ve yarım kalan silme işlemlerinin sonuçlarını burada takip edin."
  actions={<Button icon="refresh" disabled={state.loading||Boolean(state.busy)} onClick={()=>void load()}>Yenile</Button>}>
  <div className="ws-section-body"><ErrorNotice error={state.error}/>
   {state.loading&&state.operations.length===0&&<p role="status">Silme işlemleri okunuyor…</p>}
   {active.map(operation=><div key={operation.id} className="ws-notice ws-notice-warn"><div>
    <strong>{operation.label??'Yarım kalan site'}</strong>
    <WebsiteRemovalProgress operation={operation} busy={Boolean(state.busy)} onResume={()=>setConfirm(operation)}/>
   </div></div>)}
   {state.unknown&&<p className="ws-muted">Güncel işlem kaydı okundu; yeni bir silme işlemi başlatılmadı.</p>}
  </div>
  {confirm&&<ConfirmDialog title="Silme işlemine devam et" confirmation={confirm.label??confirm.websiteId} busy={Boolean(state.busy)}
   message="Bu site için tamamlanan adımlar korunacak ve kalan silme işlemleri sunucuda yürütülecek. Korunan yedekler saklanacak."
   onCancel={()=>setConfirm(null)} onConfirm={()=>void advance(confirm)} confirmLabel="Silme işlemine devam et"/>}
 </Section>;
}
