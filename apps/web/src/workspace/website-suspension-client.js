import {suspensionAction,websiteSuspensionErrorMessage,websiteSuspensionOperation,websiteSuspensionScope,websiteSuspensionState} from './website-suspension-model.js';

export function createWebsiteSuspensionClient({scope:input,request,isCurrent=()=>true}){
 const scope=websiteSuspensionScope(input),listeners=new Set();let active=true,sequence=0,controller=null;
 let state=Object.freeze({data:null,loading:false,busy:false,denied:false,error:null,unknownMutation:false});
 const current=()=>active&&isCurrent();
 function publish(patch){if(!current())return;state=Object.freeze({...state,...patch});for(const fn of listeners){try{fn(state);}catch{}}}
 async function load(){
  if(!current()||state.denied)return false;const seq=++sequence;controller?.abort();controller=new AbortController();
  publish({loading:true,error:null});
  try{const value=await request('/websites/'+encodeURIComponent(scope.websiteId)+'/suspension',{signal:controller.signal});
   if(!current()||seq!==sequence)return false;publish({data:websiteSuspensionState(value,scope)});return true;
  }catch(error){
   if(!current()||seq!==sequence)return false;
   if([401,403].includes(error?.status)||['unauthorized','forbidden','site_scope_forbidden'].includes(error?.code))publish({data:null,denied:true,error:'Oturum veya site yönetim izni geçerli değil.'});
   else publish({error:websiteSuspensionErrorMessage(error)});return false;
  }finally{if(current()&&seq===sequence)publish({loading:false});}
 }
 async function mutate(kind){
  if(!current()||state.denied||state.busy||!state.data)return null;
  const selected=suspensionAction(state.data);if(!selected||selected.kind!==kind)return null;
  let path,body;
  if(kind==='start'){path='/suspension/start';body={previewDigest:state.data.preview.previewDigest,confirmation:state.data.preview.confirmation};}
  else {
   const op=selected.operation;path=kind==='retry-suspend'?'/suspension/retry':kind==='resume'?'/suspension/resume':'/suspension/resume-retry';
   const confirmation=kind==='retry-suspend'?op.actions.suspendRetryConfirmation:kind==='resume'?op.actions.resumeConfirmation:op.actions.resumeRetryConfirmation;
   body={operationId:op.id,expectedUpdatedAt:op.updatedAt,confirmation};
  }
  publish({busy:true,error:null,unknownMutation:false});let sent=false;
  try{sent=true;const value=await request('/websites/'+encodeURIComponent(scope.websiteId)+path,{method:'POST',body});
   if(!current())return null;const operation=websiteSuspensionOperation(value,scope);await load();return operation;
  }catch(error){
   if(!current())return null;
   if(sent&&!([400,401,403,409].includes(error?.status))){publish({unknownMutation:true,error:'İsteğin sonucu bilinmiyor. İşlem tekrar gönderilmedi; site durumu yeniden okunuyor.'});await load();}
   else publish({error:websiteSuspensionErrorMessage(error)});return null;
  }finally{if(current())publish({busy:false});}
 }
 return Object.freeze({getSnapshot:()=>state,load,mutate,subscribe(fn){listeners.add(fn);return()=>listeners.delete(fn);},
  dispose(){active=false;++sequence;controller?.abort();listeners.clear();}});
}

export async function resumeDomainOrWebsite({ domain, websiteId = domain?.websiteId ?? null, request } = {}) {
 if (typeof request !== 'function') {
  throw Object.assign(new Error('Request function is required'), { code: 'website_suspension_response_invalid' });
 }
 if (websiteId) {
  const value = await request(`/websites/${encodeURIComponent(websiteId)}/suspension`);
  const data = value?.data ?? value;
  const operations = Array.isArray(data?.operations) ? data.operations : [];
  const op = operations.find(
   (item) => item && (item.status === 'suspended' || ['resuming', 'resume_partial', 'resume_failed'].includes(item.status)),
  );
  if (!op) {
   throw Object.assign(new Error('Site askıda değil veya işlem durumu değişti.'), { code: 'website_resume_invalid' });
  }
  const isFirstResume = op.status === 'suspended';
  const endpoint = isFirstResume ? 'resume' : 'resume-retry';
  const confirmation = isFirstResume ? op.actions?.resumeConfirmation : op.actions?.resumeRetryConfirmation;
  if (!confirmation) {
   throw Object.assign(new Error('Yeniden açma onayı üretilemedi.'), { code: 'website_resume_invalid' });
  }
  return request(`/websites/${encodeURIComponent(websiteId)}/suspension/${endpoint}`, {
   method: 'POST',
   body: {
    operationId: op.id,
    expectedUpdatedAt: op.updatedAt,
    confirmation,
   },
  });
 }
 if (domain?.id) {
  const value = await request(`/domains/${encodeURIComponent(domain.id)}/suspension-operations`);
  const unwrapped = value?.data ?? value;
  const operations = Array.isArray(unwrapped) ? unwrapped : (Array.isArray(unwrapped?.operations) ? unwrapped.operations : []);
  const op = operations.find(
   (item) => item && (item.status === 'suspended' || ['resuming', 'resume_partial', 'resume_failed'].includes(item.status)),
  );
  if (!op) {
   throw Object.assign(new Error('Alan adı askıda değil veya işlem durumu değişti.'), { code: 'domain_resume_invalid' });
  }
  const isFirstResume = op.status === 'suspended';
  const endpoint = isFirstResume ? 'resume' : 'resume-retry';
  const confirmation = isFirstResume ? op.actions?.resumeConfirmation : op.actions?.resumeRetryConfirmation;
  if (!confirmation) {
   throw Object.assign(new Error('Alan adı yeniden açma onayı üretilemedi.'), { code: 'domain_resume_invalid' });
  }
  return request(`/domains/${encodeURIComponent(domain.id)}/suspension-operations/${encodeURIComponent(op.id)}/${endpoint}`, {
   method: 'POST',
   body: {
    expectedUpdatedAt: op.updatedAt,
    checksum: op.checksum,
    confirmation,
   },
  });
 }
 throw Object.assign(new Error('Geçerli bir site veya alan adı seçilmedi.'), { code: 'website_suspension_response_invalid' });
}

export { resumeDomainOrWebsite as resumeWebsiteOrDomain };
