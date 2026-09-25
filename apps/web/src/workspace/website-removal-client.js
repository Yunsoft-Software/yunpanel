import {
  globalRemovalOperation, nextRemovalStep, removalErrorMessage, removalOperation, removalScope, removalState,
} from './website-removal-model.js';

const terminalHttp = new Set([400,401,403,409]);
export function createWebsiteRemovalClient({scope:input,request,isCurrent=()=>true,onRemoved=()=>{}}){
 const scope=removalScope(input),listeners=new Set();let active=true,seq=0,controller=null;
 let state=Object.freeze({data:null,operation:null,loading:false,busy:false,denied:false,error:null,unknownMutation:false});
 const current=()=>active&&isCurrent();
 function publish(patch){if(!current())return;state=Object.freeze({...state,...patch});for(const fn of listeners){try{fn(state);}catch{}}}
 function deny(){publish({data:null,operation:null,denied:true,error:'Owner oturumu veya site erişimi geçerli değil.'});}
 async function requestGlobalList(){
  const value=await request('/website-removal-operations');
  if(!Array.isArray(value))throw new Error('Removal operation list is invalid');
  return value.map(globalRemovalOperation);
 }
 async function load(){
  if(!current()||state.denied)return false;const currentSeq=++seq;controller?.abort();controller=new AbortController();publish({loading:true,error:null});
  try{const value=await request('/websites/'+encodeURIComponent(scope.websiteId)+'/removal',{signal:controller.signal});
   if(!current()||currentSeq!==seq)return false;const data=removalState(value,scope);
   const operation=data.operations.find((op)=>op.status!=='removed')??data.operations[0]??null;
   publish({data,operation});return true;
  }catch(error){if(!current()||currentSeq!==seq)return false;
   if([401,403].includes(error?.status)||['unauthorized','forbidden','site_scope_forbidden'].includes(error?.code))deny();
   else publish({error:removalErrorMessage(error)});return false;
  }finally{if(current()&&currentSeq===seq)publish({loading:false});}
 }
 async function reconcileStart(previousIds,previewDigest){
  const operations=await requestGlobalList();
  const candidates=operations.filter((op)=>op.websiteId===scope.websiteId&&op.previewDigest===previewDigest&&!previousIds.has(op.id));
  if(candidates.length===1){publish({operation:candidates[0],unknownMutation:false});return candidates[0];}
  publish({unknownMutation:true,error:'Silme isteğinin sonucu kesinleştirilemedi. Yeni istek gönderilmedi; Silme kurtarma bölümünü kontrol edin.'});return null;
 }
 async function start(){
  const preview=state.data?.preview;
  if(!current()||state.denied||state.busy||!preview?.readyToStart||!preview.confirmation)return null;
  if(state.operation&&state.operation.status!=='removed')return state.operation;
  const previousIds=new Set(state.data.operations.map((op)=>op.id));publish({busy:true,error:null,unknownMutation:false});let sent=false;
  try{sent=true;const value=await request('/websites/'+encodeURIComponent(scope.websiteId)+'/removal',{method:'POST',
    body:{previewDigest:preview.previewDigest,confirmation:preview.confirmation}});
   if(!current())return null;const op=removalOperation(value,scope);publish({operation:op});if(op.status==='removed')onRemoved(op);return op;
  }catch(error){
   if(!current())return null;
   if([401,403].includes(error?.status)||['unauthorized','forbidden'].includes(error?.code)){deny();return null;}
   if(sent&&!terminalHttp.has(error?.status)){try{return await reconcileStart(previousIds,preview.previewDigest);}catch{}}
   publish({error:removalErrorMessage(error)});return null;
  }finally{if(current())publish({busy:false});}
 }
 async function refreshOperation(operationId=state.operation?.id){
  if(!operationId||!current())return null;
  const value=await request('/website-removal-operations/'+encodeURIComponent(operationId));
  if(!current())return null;const op=globalRemovalOperation(value);
  if(op.websiteId!==scope.websiteId||op.serverId!==scope.serverId)throw new Error('Removal operation scope changed');
  publish({operation:op,unknownMutation:false});if(op.status==='removed')onRemoved(op);return op;
 }
 async function continueStep(){
  const operation=state.operation,step=nextRemovalStep(operation);
  if(!current()||state.denied||state.busy||!operation||!step)return null;
  publish({busy:true,error:null,unknownMutation:false});let sent=false;
  try{sent=true;const value=await request('/website-removal-operations/'+encodeURIComponent(operation.id)+'/continue',{method:'POST',
    body:{expectedUpdatedAt:operation.updatedAt,stepId:step.stepId,confirmation:step.confirmation}});
   if(!current())return null;const op=globalRemovalOperation(value);
   if(op.websiteId!==scope.websiteId||op.serverId!==scope.serverId)throw new Error('Removal operation scope changed');
   publish({operation:op});if(op.status==='removed')onRemoved(op);return op;
  }catch(error){
   if(!current())return null;
   if([401,403].includes(error?.status)||['unauthorized','forbidden'].includes(error?.code)){deny();return null;}
   if(sent&&!terminalHttp.has(error?.status)){try{const op=await refreshOperation(operation.id);publish({unknownMutation:true,error:'Önceki silme adımının cevabı kayboldu; POST tekrar edilmedi ve journal sunucudan yeniden okundu.'});return op;}catch{}}
   if(error?.status===409){try{return await refreshOperation(operation.id);}catch{}}
   publish({error:removalErrorMessage(error)});return null;
  }finally{if(current())publish({busy:false});}
 }
 return Object.freeze({getSnapshot:()=>state,load,start,continueStep,refreshOperation,
  subscribe(fn){listeners.add(fn);return()=>listeners.delete(fn);},dispose(){active=false;++seq;controller?.abort();listeners.clear();}});
}
