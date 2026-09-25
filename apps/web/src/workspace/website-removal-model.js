const UUID=/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const SAFE=/^[A-Za-z0-9._:-]{1,128}$/;
const SHA=/^[a-f0-9]{64}$/;
const record=(v)=>Boolean(v&&typeof v==='object'&&!Array.isArray(v));
const text=(v,max=160)=>typeof v==='string'&&v.length>0&&v.length<=max&&!/[\u0000-\u001f\u007f]/u.test(v);
const iso=(v)=>typeof v==='string'&&Number.isFinite(Date.parse(v))&&new Date(v).toISOString()===v;
const need=(v)=>{if(!v)throw new WebsiteRemovalModelError();};
export class WebsiteRemovalModelError extends Error{constructor(code='website_removal_response_invalid'){super(code);this.code=code;}}
export function removalScope(value){
 need(record(value)&&UUID.test(value.websiteId??'')&&UUID.test(value.serverId??'')&&text(value.label,253));
 return Object.freeze({websiteId:value.websiteId,serverId:value.serverId,label:value.label});
}
function bucket(value){
 need(record(value)&&['available','unavailable'].includes(value.status)&&Array.isArray(value.ids)&&value.ids.length<=500
   &&value.ids.every((id)=>typeof id==='string'&&SAFE.test(id)));
 return Object.freeze({status:value.status,ids:Object.freeze([...value.ids])});
}
function domain(value){
 need(record(value)&&SAFE.test(value.id??'')&&text(value.primaryDomain,253));
 return Object.freeze({id:value.id,primaryDomain:value.primaryDomain});
}
export function removalPreview(value,scope){
 need(record(value)&&value.version===1&&value.operation==='website_remove'&&record(value.website)
   &&value.website.id===scope.websiteId&&value.website.serverId===scope.serverId
   &&text(value.website.name,120)&&Array.isArray(value.hardBlockers)&&value.hardBlockers.length<=100
   &&value.hardBlockers.every((code)=>typeof code==='string'&&/^[a-z0-9_]{1,120}$/.test(code))
   &&typeof value.readyToStart==='boolean'&&SHA.test(value.previewDigest??'')
   &&(value.confirmation===null||text(value.confirmation,500))&&value.sideEffects===false&&record(value.plan));
 const plan=value.plan;
 need(Array.isArray(plan.domains)&&plan.domains.length<=100&&Array.isArray(plan.activeJobIds)&&plan.activeJobIds.length<=100
   &&record(plan.additional));
 const additional={};
 for(const key of ['databases','sftpKeys','runtimeBindings','unixIdentities','logScopes','crons','backups']) additional[key]=bucket(plan.additional[key]);
 return Object.freeze({
   version:1,operation:'website_remove',
   website:Object.freeze({id:value.website.id,name:value.website.name,serverId:value.website.serverId,applicationId:value.website.applicationId??null,systemUser:value.website.systemUser??null}),
   plan:Object.freeze({domains:Object.freeze(plan.domains.map(domain)),activeJobIds:Object.freeze([...plan.activeJobIds]),additional:Object.freeze(additional)}),
   hardBlockers:Object.freeze([...value.hardBlockers]),readyToStart:value.readyToStart,previewDigest:value.previewDigest,
   confirmation:value.confirmation,sideEffects:false,
 });
}
export function removalOperation(value,scope){
 need(record(value)&&SAFE.test(value.id??'')&&value.websiteId===scope.websiteId&&value.serverId===scope.serverId
  &&['pending','running','blocked','failed','removed'].includes(value.status)&&Array.isArray(value.steps)&&value.steps.length<=200
  &&SHA.test(value.previewDigest??'')&&iso(value.updatedAt)&&record(value.actions));
 const confirmation=value.actions.stepContinuationConfirmation;
 need(confirmation===null||text(confirmation,700));
 return Object.freeze({id:value.id,websiteId:value.websiteId,serverId:value.serverId,
  applicationId:value.applicationId??null,previewDigest:value.previewDigest,status:value.status,updatedAt:value.updatedAt??null,
  actions:Object.freeze({stepContinuationConfirmation:confirmation}),steps:Object.freeze(value.steps.map((step)=>{
   need(record(step)&&SAFE.test(step.id??'')&&typeof step.kind==='string'&&['pending','running','succeeded','blocked','failed'].includes(step.status));
   return Object.freeze({id:step.id,kind:step.kind,status:step.status,error:step.error&&typeof step.error.code==='string'?Object.freeze({code:step.error.code}):null});
 }))});
}
export function nextRemovalStep(operation){
 if(!operation||operation.status==='removed')return null;
 const step=operation.steps.find((item)=>item.status!=='succeeded')??null;
 if(!step||!operation.actions.stepContinuationConfirmation)return null;
 return Object.freeze({stepId:step.id,kind:step.kind,status:step.status,confirmation:operation.actions.stepContinuationConfirmation});
}
export function globalRemovalOperation(value){
 need(record(value)&&UUID.test(value.websiteId??'')&&UUID.test(value.serverId??''));
 return removalOperation(value,{websiteId:value.websiteId,serverId:value.serverId,label:value.websiteId});
}

export function removalState(value,scope){
 need(record(value)&&record(value.preview)&&Array.isArray(value.operations)&&value.operations.length<=100);
 return Object.freeze({preview:removalPreview(value.preview,scope),operations:Object.freeze(value.operations.map((op)=>removalOperation(op,scope)))});
}
export function resolveRemovalAccess({domainId,domains,websites,isOwner}){
 if(!isOwner)return{state:'forbidden'};
 if(domains?.status!=='ready'||websites?.status!=='ready'||!Array.isArray(domains.items)||!Array.isArray(websites.items))return{state:'unavailable'};
 const ds=domains.items.filter((v)=>v?.id===domainId);if(ds.length!==1)return{state:'not_found'};const d=ds[0];
 if(!d.websiteId)return{state:'unbound'};const ws=websites.items.filter((v)=>v?.id===d.websiteId);if(ws.length!==1)return{state:'not_found'};
 const w=ws[0];if(w.serverId!==d.serverId)return{state:'inconsistent'};
 try{return{state:'ready',scope:removalScope({websiteId:w.id,serverId:w.serverId,label:d.primaryDomain})};}catch{return{state:'inconsistent'};}
}
const blockerLabels=Object.freeze({
 application_cleanup_unavailable:'Uygulama kaydı ve kalıcı uygulama durumu için güvenli silme lifecycle’ı henüz bağlı değil.',
 file_cleanup_unavailable:'Site dosyaları için doğrulanabilir cleanup adapterı henüz bağlı değil.',
 unix_cleanup_unavailable:'Site Unix kullanıcısı için doğrulanabilir cleanup adapterı henüz bağlı değil.',
 active_jobs_present:'Bu site veya uygulamada devam eden bir işlem var.',
 dependency_inventory_unavailable:'Silme etkisi için gerekli bağımlılık envanteri okunamadı.',
 database_cleanup_unavailable:'Veritabanı bağlantıları güvenli biçimde temizlenemiyor.',
 sftp_cleanup_unavailable:'SFTP anahtarları güvenli biçimde temizlenemiyor.',
 runtime_cleanup_unavailable:'Runtime bağlantısı güvenli biçimde temizlenemiyor.',
 cron_cleanup_unavailable:'Zamanlanmış görevler güvenli biçimde temizlenemiyor.',
 metadata_cleanup_unavailable:'Website metadata lifecycle’ı kullanılamıyor.',
 application_cleanup_unavailable:'Application metadata/env cleanup lifecycle’ı kullanılamıyor.',
 file_cleanup_preflight_failed:'Canonical site dosya kökleri güvenli olarak doğrulanamadı.',
 unix_cleanup_evidence_unavailable:'Site Unix kullanıcısının ownership receipt’i bulunamadı; legacy kullanıcı otomatik silinmez.',
 runtime_cleanup_adapter_unsupported:'Bu runtime adapterı için doğrulanmış kaldırma yolu henüz yok.',
 runtime_cleanup_unverified:'Runtime binding cleanup durumu doğrulanamadı.',
});
export function removalBlockerLabel(code){return blockerLabels[code]??'Silme işlemi için gerekli güvenlik kontrolü tamamlanmadı: '+code;}
export function removalErrorMessage(error){return ({
 website_removal_preview_stale:'Site durumu değişti. Silme etkisini yeniden yükleyin.',
 website_removal_operation_in_progress:'Bu site için mevcut silme journal’ı tamamlanmadan yeni işlem başlatılamaz.',
 website_removal_step_continuation_stale:'Silme adımı değişti. Güncel journal yeniden okundu.',
 site_scope_forbidden:'Bu siteye erişim izniniz yok.',
 forbidden:'Site silme yalnız Owner tarafından yönetilir.',
})[error?.code]??'Site silme bilgileri alınamadı.';}
