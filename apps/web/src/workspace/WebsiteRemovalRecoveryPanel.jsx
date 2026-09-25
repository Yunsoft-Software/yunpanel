import {useEffect,useRef,useState} from 'react';
import {panelRequest} from '../api.js';
import {Button,ErrorNotice,KeyValues,Section} from './PanelKit.jsx';
import {globalRemovalOperation,nextRemovalStep,removalErrorMessage} from './website-removal-model.js';

export default function WebsiteRemovalRecoveryPanel(){
 const [state,setState]=useState({operations:[],loading:true,busy:null,error:null,unknown:false});const live=useRef(true);
 async function load(){setState((v)=>({...v,loading:true,error:null}));try{
  const value=await panelRequest('/website-removal-operations');if(!live.current)return;
  if(!Array.isArray(value))throw new Error('Invalid removal operation list');
  setState((v)=>({...v,operations:value.map(globalRemovalOperation),loading:false,unknown:false}));
 }catch(error){if(live.current)setState((v)=>({...v,loading:false,error:removalErrorMessage(error)}));}}
 useEffect(()=>{live.current=true;void load();return()=>{live.current=false;};},[]);
 const active=state.operations.filter((op)=>op.status!=='removed');
 async function advance(operation){
  const step=nextRemovalStep(operation);if(!step||state.busy)return;setState((v)=>({...v,busy:operation.id,error:null,unknown:false}));let sent=false;
  try{sent=true;const value=await panelRequest('/website-removal-operations/'+encodeURIComponent(operation.id)+'/continue',{method:'POST',
    body:{expectedUpdatedAt:operation.updatedAt,stepId:step.stepId,confirmation:step.confirmation}});
   const updated=globalRemovalOperation(value);if(live.current)setState((v)=>({...v,operations:v.operations.map((op)=>op.id===updated.id?updated:op)}));
  }catch(error){
   if(sent&&!([400,401,403,409].includes(error?.status))){try{
    const current=globalRemovalOperation(await panelRequest('/website-removal-operations/'+encodeURIComponent(operation.id)));
    if(live.current)setState((v)=>({...v,operations:v.operations.map((op)=>op.id===current.id?current:op),unknown:true,error:'Adım cevabı kayboldu; POST tekrar edilmedi ve journal yeniden okundu.'}));return;
   }catch{}}
   if(live.current)setState((v)=>({...v,error:removalErrorMessage(error)}));
  }finally{if(live.current)setState((v)=>({...v,busy:null}));}
 }
 if(!state.loading&&active.length===0)return null;
 return <Section title="Silme kurtarma" description="Domain/Website metadata kaldırıldıktan sonra bile yarım kalan removal journal’larını buradan devam ettirin."
  actions={<Button icon="refresh" disabled={state.loading||Boolean(state.busy)} onClick={()=>void load()}>Yenile</Button>}>
  <div className="ws-section-body"><ErrorNotice error={state.error}/>
   {state.loading&&<p role="status">Silme journal’ları okunuyor…</p>}
   {active.map((operation)=>{const step=nextRemovalStep(operation);return <div key={operation.id} className="ws-notice ws-notice-warn"><div>
    <strong>{operation.websiteId}</strong><KeyValues items={[
     ['Durum',operation.status],['Operation',operation.id],['Sıradaki adım',step?.kind??'Kontrol gerekli'],
    ]}/></div>{step&&<Button disabled={Boolean(state.busy)} onClick={()=>void advance(operation)}>
      {['failed','blocked'].includes(operation.status)?'Bu adımı yeniden dene':'Sonraki adımı çalıştır'}
    </Button>}</div>;})}
   {state.unknown&&<p className="ws-muted">Belirsiz mutation sonucu global journal ile uzlaştırıldı; POST replay edilmedi.</p>}
  </div>
 </Section>;
}
