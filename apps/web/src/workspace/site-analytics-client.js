import {analyticsReport,analyticsRealtime,analyticsStatus,siteAnalyticsErrorMessage,siteAnalyticsScope} from './site-analytics-model.js';

export function createSiteAnalyticsClient({scope:input,request,isOwner=false,isCurrent=()=>true}){
 const scope=siteAnalyticsScope(input),listeners=new Set();let active=true,sequence=0,controller=null;
 let state=Object.freeze({status:null,report:null,loading:false,busy:false,denied:false,error:null,unknownMutation:false});
 const current=()=>active&&isCurrent();
 function publish(patch){if(!current())return;state=Object.freeze({...state,...patch});for(const fn of listeners){try{fn(state);}catch{}}}
 async function load(){
  if(!current()||state.denied)return false;const seq=++sequence;controller?.abort();controller=new AbortController();
  publish({loading:true,error:null});
  try{const value=await request('/websites/'+encodeURIComponent(scope.websiteId)+'/analytics/status',{signal:controller.signal});
   if(!current()||seq!==sequence)return false;publish({status:analyticsStatus(value,scope,{owner:isOwner})});return true;
  }catch(error){
   if(!current()||seq!==sequence)return false;
   if([401,403].includes(error?.status)||['unauthorized','forbidden'].includes(error?.code)){
    publish({status:null,denied:true,error:'Oturum veya site istatistik erişimi geçerli değil.'});
   }else publish({error:siteAnalyticsErrorMessage(error)});
   return false;
  }finally{if(current()&&seq===sequence)publish({loading:false});}
 }
 async function generateReport(){
  if(!current()||state.denied||state.busy)return null;publish({busy:true,error:null});
  try{const value=await request('/websites/'+encodeURIComponent(scope.websiteId)+'/analytics/report');
   if(!current())return null;const report=analyticsReport(value,scope);publish({report});return report;
  }catch(error){if(current())publish({error:siteAnalyticsErrorMessage(error)});return null;}
  finally{if(current())publish({busy:false});}
 }
 async function realtime(action){
  if(!isOwner||!['start','stop','restart'].includes(action)||!current()||state.denied||state.busy)return null;
  publish({busy:true,error:null,unknownMutation:false});let sent=false;
  try{sent=true;const value=await request('/websites/'+encodeURIComponent(scope.websiteId)+'/analytics/realtime/'+action,{method:'POST',body:{}});
   if(!current())return null;const result=analyticsRealtime(value,scope,action);await load();return result;
  }catch(error){
   if(!current())return null;
   if(sent&&!([400,401,403,409].includes(error?.status))){publish({unknownMutation:true,error:'İsteğin sonucu bilinmiyor. İşlem tekrar gönderilmedi; servis durumu yeniden okunuyor.'});await load();}
   else publish({error:siteAnalyticsErrorMessage(error)});
   return null;
  }finally{if(current())publish({busy:false});}
 }
 return Object.freeze({getSnapshot:()=>state,load,generateReport,realtime,
  subscribe(fn){listeners.add(fn);return()=>listeners.delete(fn);},
  dispose(){active=false;++sequence;controller?.abort();listeners.clear();}});
}
