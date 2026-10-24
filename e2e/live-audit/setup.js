import fs from 'node:fs';
import path from 'node:path';
import dns from 'node:dns/promises';
import { randomBytes } from 'node:crypto';
import { request } from '@playwright/test';
import { ORIGIN,RUN_DIR,AUTH_PATH,envFile,privateJson,saveManifest,safeApi,auditNetworkOptions } from './runtime.js';
export default async function setup() {
  const configured=envFile('.local/test-server.env');
  if(configured.YUNPANEL_TEST_SERVER_HOST!=='157.180.11.28')throw new Error('Explicit .28 test-host allowlist mismatch');
  const addresses=await dns.lookup(new URL(ORIGIN).hostname,{all:true});
  if(!addresses.length||addresses.some(({address})=>address!=='157.180.11.28'))throw new Error('Panel DNS no longer points exclusively to the allowed .28 test host');
  fs.mkdirSync(RUN_DIR,{recursive:true,mode:0o700});fs.chmodSync(RUN_DIR,0o700);
  const credentials=JSON.parse(fs.readFileSync('.local/yunpanel-owner-password-only.json','utf8'));
  const rawApi=await request.newContext({baseURL:ORIGIN,ignoreHTTPSErrors:false,extraHTTPHeaders:{Origin:ORIGIN},...auditNetworkOptions()});
  const api=safeApi(rawApi);
  if(process.env.YUNPANEL_AUDIT_ACCEPTANCE_SHA){
    const identity=await api.get('/api/auth/session');
    if(identity.headers()['x-yunpanel-acceptance-source']!==process.env.YUNPANEL_AUDIT_ACCEPTANCE_SHA)throw new Error('Native candidate identity is not active; no login or mutations are permitted');
  }
  const login=await api.post('/api/auth/login',{data:{username:credentials.username,password:credentials.password}});
  if(login.status()!==200)throw new Error('Real Owner login failed: '+login.status());
  await api.storageState({path:AUTH_PATH});fs.chmodSync(AUTH_PATH,0o600);
  const responses={};
  for(const resource of ['servers','websites','domains','applications','certificates','ai/providers']){
    const response=await api.get('/api/panel/'+resource);if(response.status()!==200)throw new Error('Real inventory prerequisite failed: '+resource+' '+response.status());responses[resource]=await response.json();
  }
  if(fs.existsSync(path.join(RUN_DIR,'manifest.json'))){
    const saved=JSON.parse(fs.readFileSync(path.join(RUN_DIR,'manifest.json'),'utf8'));
    if(saved.origin!==ORIGIN||saved.target!=='157.180.11.28')throw new Error('Existing run identity mismatch');
    await api.dispose();return;
  }
  const suffix=Date.now().toString(36)+'-'+randomBytes(3).toString('hex');
  const php=responses.websites.data.find(v=>v.runtimeType==='php');
  const domain=responses.domains.data.find(v=>v.websiteId===php?.id);
  if(!php||!domain)throw new Error('A real, explicitly bound PHP Website is required to audit existing PHP screens');
  const publicProjection=list=>list.map(v=>({id:v.id,name:v.name,primaryDomain:v.primaryDomain,type:v.type,runtimeType:v.runtimeType,websiteId:v.websiteId,applicationId:v.applicationId,revision:v.revision}));
  saveManifest({runId:suffix,origin:ORIGIN,target:'157.180.11.28',sourceCommit:process.env.YUNPANEL_AUDIT_SOURCE_HEAD||'e997bdf9053cea895eba1e7ae947a3ec4fddf059',evidenceLane:process.env.YUNPANEL_AUDIT_LANE||'read',createdAt:new Date().toISOString(),serverId:responses.servers.data[0].id,existingPhpWebsiteId:php.id,existingPhpDomainId:domain.id,existingPhpDomain:domain.primaryDomain,originalActiveProviderId:responses['ai/providers'].activeProviderId,
    baseline:Object.fromEntries(Object.entries(responses).map(([k,v])=>[k,publicProjection(v.data)])),
    fixture:{hostname:'ypaudit-'+suffix+'.157.180.11.28.sslip.io',databaseName:'ypaudit_'+suffix.replaceAll('-','_'),createdWebsiteIds:[],createdDomainIds:[],createdDatabaseNames:[],createdProviderIds:[],createdUserIds:[],operations:[]}});
  // Existing key is loaded only by the provider test, never into a public report or a browser trace.
  privateJson('fixture-secrets.json',{siteAdminEmail:'ypaudit-'+suffix+'@example.com',siteAdminPassword:randomBytes(24).toString('base64url'),wpAdminPassword:randomBytes(24).toString('base64url')});
  await api.dispose();
}
