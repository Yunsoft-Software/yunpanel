const UUID=/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const SAFE_ID=/^[A-Za-z0-9._:-]{1,128}$/;
const SHA=/^[a-f0-9]{64}$/;
const CODE=/^[a-z0-9_]{1,120}$/;
const record=(v)=>Boolean(v&&typeof v==='object'&&!Array.isArray(v));
const text=(v,max=253)=>typeof v==='string'&&v.length>0&&v.length<=max&&!/[\u0000-\u001f\u007f]/u.test(v);
const iso=(v)=>typeof v==='string'&&Number.isFinite(Date.parse(v))&&new Date(v).toISOString()===v;
const need=(v)=>{if(!v)throw new WebsiteSuspensionModelError();};

export class WebsiteSuspensionModelError extends Error{constructor(code='website_suspension_response_invalid'){super(code);this.code=code;}}

export function websiteSuspensionScope(value){
 need(record(value)&&UUID.test(value.websiteId??'')&&UUID.test(value.serverId??'')&&text(value.label));
 return Object.freeze({websiteId:value.websiteId,serverId:value.serverId,label:value.label});
}

function safeError(value){
 if(value===null||value===undefined)return null;
 need(record(value)&&typeof value.code==='string'&&CODE.test(value.code));
 return Object.freeze({code:value.code});
}
function domainPreview(value){
 need(record(value)&&UUID.test(value.id??'')&&text(value.primaryDomain)&&typeof value.state==='string'
  &&typeof value.readyToSuspend==='boolean'&&Array.isArray(value.blockers)&&value.blockers.length<=20
  &&value.blockers.every((code)=>typeof code==='string'&&CODE.test(code))
  &&(value.previewDigest===null||SHA.test(value.previewDigest))
  &&(value.confirmation===null||text(value.confirmation,500)));
 return Object.freeze({id:value.id,primaryDomain:value.primaryDomain,state:value.state,readyToSuspend:value.readyToSuspend,
  previewDigest:value.previewDigest,confirmation:value.confirmation,blockers:Object.freeze([...value.blockers])});
}
export function websiteSuspensionPreview(value,scope){
 need(record(value)&&record(value.website)&&value.website.id===scope.websiteId&&text(value.website.name,120)
  &&Number.isSafeInteger(value.website.revision)&&value.website.revision>0&&Array.isArray(value.domains)&&value.domains.length>0&&value.domains.length<=100
  &&typeof value.readyToSuspend==='boolean'&&typeof value.readyToResume==='boolean'&&SHA.test(value.previewDigest??'')
  &&(value.confirmation===null||text(value.confirmation,500))&&value.sideEffects===false);
 return Object.freeze({website:Object.freeze({id:value.website.id,name:value.website.name,revision:value.website.revision}),
  domains:Object.freeze(value.domains.map(domainPreview)),readyToSuspend:value.readyToSuspend,readyToResume:value.readyToResume,
  previewDigest:value.previewDigest,confirmation:value.confirmation,sideEffects:false});
}
const OP_STATUSES=new Set(['pending','suspending','suspended','partial','failed','resuming','resumed','resume_partial','resume_failed']);
function domainOperation(value){
 need(record(value)&&UUID.test(value.domainId??'')&&(value.operationId===null||SAFE_ID.test(value.operationId??''))
  &&['pending','suspending','suspended','failed','resuming','resumed','resume_failed'].includes(value.status));
 return Object.freeze({domainId:value.domainId,operationId:value.operationId,status:value.status,error:safeError(value.error)});
}
export function websiteSuspensionOperation(value,scope){
 need(record(value)&&SAFE_ID.test(value.id??'')&&value.websiteId===scope.websiteId&&value.serverId===scope.serverId
  &&Number.isSafeInteger(value.websiteRevision)&&value.websiteRevision>0&&OP_STATUSES.has(value.status)
  &&Array.isArray(value.domainOperations)&&value.domainOperations.length<=100&&iso(value.createdAt)&&iso(value.updatedAt)
  &&(value.completedAt===null||iso(value.completedAt))&&record(value.actions));
 const action=(key)=>value.actions[key]===null?null:(text(value.actions[key],500)?value.actions[key]:null);
 need(value.actions.suspendRetryConfirmation===null||action('suspendRetryConfirmation'));
 need(value.actions.resumeConfirmation===null||action('resumeConfirmation'));
 need(value.actions.resumeRetryConfirmation===null||action('resumeRetryConfirmation'));
 return Object.freeze({id:value.id,websiteId:value.websiteId,serverId:value.serverId,websiteRevision:value.websiteRevision,
  status:value.status,domainOperations:Object.freeze(value.domainOperations.map(domainOperation)),error:safeError(value.error),
  createdAt:value.createdAt,updatedAt:value.updatedAt,completedAt:value.completedAt,
  actions:Object.freeze({suspendRetryConfirmation:action('suspendRetryConfirmation'),
   resumeConfirmation:action('resumeConfirmation'),resumeRetryConfirmation:action('resumeRetryConfirmation')})});
}
export function websiteSuspensionState(value,scope){
 need(record(value)&&record(value.preview)&&Array.isArray(value.operations)&&value.operations.length<=100);
 return Object.freeze({preview:websiteSuspensionPreview(value.preview,scope),
  operations:Object.freeze(value.operations.map((op)=>websiteSuspensionOperation(op,scope)))});
}
export function resolveWebsiteSuspensionAccess({domainId,domains,websites,canManage}){
 if(!canManage||[domains?.status,websites?.status].some((s)=>['unauthorized','forbidden'].includes(s)))return{state:'forbidden'};
 if(domains?.status!=='ready'||websites?.status!=='ready'||!Array.isArray(domains.items)||!Array.isArray(websites.items))return{state:'unavailable'};
 const matches=domains.items.filter((v)=>v?.id===domainId);if(matches.length!==1)return{state:'not_found'};
 const domain=matches[0];if(!domain.websiteId)return{state:'unbound'};
 const sites=websites.items.filter((v)=>v?.id===domain.websiteId);if(sites.length!==1)return{state:'not_found'};
 const website=sites[0];if(website.serverId!==domain.serverId)return{state:'inconsistent'};
 try{return{state:'ready',scope:websiteSuspensionScope({websiteId:website.id,serverId:website.serverId,label:domain.primaryDomain})};}
 catch{return{state:'inconsistent'};}
}
export function suspensionAction(state){
 const latest=state?.operations?.[0]??null;
 if(latest&&['suspending','partial','failed'].includes(latest.status)&&latest.actions.suspendRetryConfirmation)return{kind:'retry-suspend',operation:latest};
 if(latest&&latest.status==='suspended'&&latest.actions.resumeConfirmation)return{kind:'resume',operation:latest};
 if(latest&&['resuming','resume_partial','resume_failed'].includes(latest.status)&&latest.actions.resumeRetryConfirmation)return{kind:'retry-resume',operation:latest};
 if(state?.preview?.readyToSuspend&&state.preview.confirmation)return{kind:'start',operation:null};
 return null;
}
export function websiteSuspensionErrorMessage(error){
 return ({website_suspension_blocked:'Site şu anda askıya alınmaya hazır değil.',website_suspension_confirmation_mismatch:'Site durumu değişti. Yeniden inceleyin.',
  website_suspension_retry_invalid:'Askıya alma işlemi artık tekrar edilemez.',website_resume_invalid:'Site askıda değil veya işlem durumu değişti.',
  website_resume_retry_invalid:'Yeniden açma işlemi artık tekrar edilemez.',site_scope_forbidden:'Bu siteyi yönetme izniniz yok.'})[error?.code]??'Site erişim işlemi tamamlanmadı.';
}
