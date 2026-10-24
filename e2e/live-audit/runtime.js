import fs from 'node:fs';
import path from 'node:path';
import { request, expect } from '@playwright/test';

export const ORIGIN = 'https://server.cryptoraichu.website';
export const RUN_DIR = path.resolve(process.env.YUNPANEL_AUDIT_RUN_DIR || '.local/browser-audit/current');
export const AUTH_PATH = path.join(RUN_DIR, 'auth-state.json');
export const MANIFEST_PATH = path.join(RUN_DIR, 'manifest.json');
export function auditNetworkOptions() {
  const proxy = process.env.YUNPANEL_AUDIT_SSH_PROXY;
  if (!proxy) return {};
  if (proxy !== 'socks5://127.0.0.1:19028') throw new Error('Only the recorded local test-host SSH tunnel is permitted');
  return { proxy: { server: proxy } };
}
export const main = page => page.locator('#workspace-main');
export function manifest() { return JSON.parse(fs.readFileSync(MANIFEST_PATH, 'utf8')); }
export function saveManifest(value) { fs.writeFileSync(MANIFEST_PATH, JSON.stringify(value,null,2),{mode:0o600}); }
export function privateJson(name,value) {fs.writeFileSync(path.join(RUN_DIR,name),JSON.stringify(value,null,2),{mode:0o600});}
export function envFile(filename) {
  const result={};
  for(const line of fs.readFileSync(filename,'utf8').split(/\r?\n/)) {
    const match=line.match(/^(?:export\s+)?([A-Z0-9_]+)=(.*)$/); if(!match)continue;
    let value=match[2].trim();if((value.startsWith('"')&&value.endsWith('"'))||(value.startsWith("'")&&value.endsWith("'")))value=value.slice(1,-1);
    result[match[1]]=value;
  } return result;
}
export async function apiContext(storageState=AUTH_PATH) {
  const api=safeApi(await request.newContext({baseURL:ORIGIN,storageState,ignoreHTTPSErrors:false,extraHTTPHeaders:{Origin:ORIGIN},...auditNetworkOptions()}));
  const session=await api.get('/api/auth/session');expect(session.status(),'A real, authenticated session is required').toBe(200);
  if(process.env.YUNPANEL_AUDIT_ACCEPTANCE_SHA&&session.headers()['x-yunpanel-acceptance-source']!==process.env.YUNPANEL_AUDIT_ACCEPTANCE_SHA)throw new Error('Native candidate identity changed; mutation blocked');
  const data=(await session.json()).data;
  return {api,csrf:data.csrfToken,session:data};
}
export async function apiCall(api,csrf,method,endpoint,data) {
  if(!endpoint.startsWith('/api/'))throw new Error('Expected an exact panel API route');
  const response=await api.fetch(endpoint,{method,data,headers:{Origin:ORIGIN,'x-csrf-token':csrf},timeout:90000});
  const payload=await response.json().catch(()=>({}));
  return {status:response.status(),body:payload,data:payload.data};
}
export async function waitJob(api,id,timeout=120000) {
  const deadline=Date.now()+timeout;
  while(Date.now()<deadline) {
    let response;
    try { response=await api.get('/api/panel/jobs/'+encodeURIComponent(id)); }
    catch(error) { if(!error.message.startsWith('API transport failed GET '))throw error;await new Promise(resolve=>setTimeout(resolve,600));continue; }
    if([502,503,504].includes(response.status())){await new Promise(resolve=>setTimeout(resolve,600));continue;}
    if(response.status()!==200)throw new Error('Job read failed: '+response.status());
    const job=(await response.json()).data;
    if(['succeeded','failed','cancelled'].includes(job.status))return job;
    await new Promise(resolve=>setTimeout(resolve,600));
  } throw new Error('Real durable job did not finish within the test deadline');
}
export async function ready(page,route) {
  await page.goto(route,{waitUntil:'domcontentloaded'});
  await expect(main(page),'The real panel must mount an authenticated workspace').toBeVisible();
  await expect(main(page).locator('h1')).toBeVisible();
  await page.waitForFunction(()=>!document.querySelector('#workspace-main')?.innerText?.match(/yükleniyor…|hazırlanıyor\.|kontrol ediliyor…|denetleniyor…|hesaplanıyor…|okunuyor…/i),null,{timeout:20000}).catch(()=>{});
}

export function safeApi(api){
 const wrapped=new Set(['get','post','put','patch','delete','head','fetch']);
 return new Proxy(api,{get(target,key){const value=target[key];if(typeof value!=='function')return value;if(!wrapped.has(key))return value.bind(target);return async(...args)=>{try{return await value.apply(target,args);}catch(error){const endpoint=String(args[0]).split('?')[0];const hint=String(error.message).match(/Timeout \d+ms exceeded|ECONN[A-Z_]+|ENOTFOUND|ETIMEDOUT|ERR_[A-Z_]+|Request context disposed|Invalid URL|Invalid character|Too many redirects|socket hang up/i)?.[0]??'transport_detail_withheld';throw new Error('API transport failed '+String(key).toUpperCase()+' '+endpoint+' ('+error.name+', '+hint+'). Request headers and credentials withheld.');}};}});
}
