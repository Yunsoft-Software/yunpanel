import {removalErrorMessage,removalScope,removalState} from './website-removal-model.js';
export function createWebsiteRemovalClient({scope:input,request,isCurrent=()=>true}){
 const scope=removalScope(input),listeners=new Set();let active=true,seq=0,controller=null;
 let state=Object.freeze({data:null,loading:false,denied:false,error:null});
 const current=()=>active&&isCurrent();
 function publish(patch){if(!current())return;state=Object.freeze({...state,...patch});for(const fn of listeners){try{fn(state);}catch{}}}
 async function load(){
  if(!current()||state.denied)return false;const currentSeq=++seq;controller?.abort();controller=new AbortController();publish({loading:true,error:null});
  try{const value=await request('/websites/'+encodeURIComponent(scope.websiteId)+'/removal',{signal:controller.signal});
   if(!current()||currentSeq!==seq)return false;publish({data:removalState(value,scope)});return true;
  }catch(error){if(!current()||currentSeq!==seq)return false;
   if([401,403].includes(error?.status)||['unauthorized','forbidden','site_scope_forbidden'].includes(error?.code))publish({data:null,denied:true,error:'Owner oturumu veya site erişimi geçerli değil.'});
   else publish({error:removalErrorMessage(error)});return false;
  }finally{if(current()&&currentSeq===seq)publish({loading:false});}
 }
 return Object.freeze({getSnapshot:()=>state,load,subscribe(fn){listeners.add(fn);return()=>listeners.delete(fn);},dispose(){active=false;++seq;controller?.abort();listeners.clear();}});
}
