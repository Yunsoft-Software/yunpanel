const UUID=/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const record=(v)=>Boolean(v&&typeof v==='object'&&!Array.isArray(v));
const safeVersion=(v)=>v===null||(typeof v==='string'&&v.length>0&&v.length<=40&&!/[\u0000-\u001f\u007f]/u.test(v));
const safeDomain=(v)=>typeof v==='string'&&v.length>0&&v.length<=253&&!/[\u0000-\u001f\u007f]/u.test(v);
const validDate=(v)=>typeof v==='string'&&Number.isFinite(Date.parse(v));

export class SiteAnalyticsError extends Error{constructor(code='site_analytics_response_invalid'){super(code);this.code=code;}}
const need=(v)=>{if(!v)throw new SiteAnalyticsError();};

export function siteAnalyticsScope(value){
 need(record(value)&&UUID.test(value.websiteId??'')&&UUID.test(value.serverId??''));
 return Object.freeze({websiteId:value.websiteId,serverId:value.serverId});
}
export function analyticsStatus(value,scope,{owner=false}={}){
 need(record(value)&&value.websiteId===scope.websiteId&&typeof value.available==='boolean'
  &&safeVersion(value.version)&&typeof value.running==='boolean'&&typeof value.socketReady==='boolean');
 if(value.wsUrl!==undefined){
  need(owner&&value.wsUrl==='/tools/goaccess/'+scope.websiteId+'/ws');
 }
 return Object.freeze({websiteId:scope.websiteId,available:value.available,version:value.version,
  running:value.running,socketReady:value.socketReady,...(value.wsUrl!==undefined?{wsUrl:value.wsUrl}:{})});
}
export function analyticsReport(value,scope){
 need(record(value)&&value.websiteId===scope.websiteId&&safeDomain(value.primaryDomain)&&validDate(value.generatedAt));
 return Object.freeze({websiteId:scope.websiteId,primaryDomain:value.primaryDomain,generatedAt:new Date(value.generatedAt).toISOString()});
}
export function analyticsRealtime(value,scope,action){
 need(record(value)&&value.websiteId===scope.websiteId&&typeof value.running==='boolean');
 if(action==='stop')need(value.running===false&&value.stopped===true);
 else need(value.running===true&&typeof value.alreadyRunning==='boolean');
 return Object.freeze({websiteId:scope.websiteId,running:value.running,
  ...(action==='stop'?{stopped:true}:{alreadyRunning:value.alreadyRunning})});
}
export function resolveSiteAnalyticsAccess({domainId,domains,websites,canManage}){
 if(!canManage||[domains?.status,websites?.status].some((s)=>['unauthorized','forbidden'].includes(s)))return{state:'forbidden'};
 if(domains?.status!=='ready'||websites?.status!=='ready'||!Array.isArray(domains.items)||!Array.isArray(websites.items))return{state:'unavailable'};
 const matches=domains.items.filter((v)=>v?.id===domainId);if(matches.length!==1)return{state:'not_found'};
 const domain=matches[0];if(!domain.websiteId)return{state:'unbound'};
 const sites=websites.items.filter((v)=>v?.id===domain.websiteId);if(sites.length!==1)return{state:'not_found'};
 const website=sites[0];if(website.serverId!==domain.serverId)return{state:'inconsistent'};
 try{return{state:'ready',scope:siteAnalyticsScope({websiteId:website.id,serverId:website.serverId})};}catch{return{state:'inconsistent'};}
}
export function siteAnalyticsErrorMessage(error){
 return ({site_analytics_response_invalid:'İstatistik yanıtı bu siteyle eşleşmiyor.',
  report_generation_failed:'Statik rapor oluşturulamadı.',report_not_found:'Statik rapor bulunamadı.',
  daemon_start_failed:'Gerçek zamanlı istatistik servisi başlatılamadı.',daemon_verify_failed:'Gerçek zamanlı servis hazır olduğunu doğrulayamadı.',
  forbidden:'Bu işlem için Owner yetkisi gerekiyor.'})[error?.code]??'İstatistik bilgileri alınamadı.';
}
