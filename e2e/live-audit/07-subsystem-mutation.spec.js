import fs from 'node:fs';
import path from 'node:path';
import tls from 'node:tls';
import {randomBytes} from 'node:crypto';
import {test,expect,manifest,saveManifest,apiCall,waitJob,ready,main,RUN_DIR} from './support.js';
function owned(){const m=manifest();expect(m.fixture.createdWebsiteIds).toContain(m.fixture.websiteId);expect(m.fixture.provisioningReady).toBe(true);return m;}
function store(patch){const m=manifest();Object.assign(m.fixture,patch);saveManifest(m);}
function log(action,data){const m=manifest();m.fixture.operations.push({action,...data,at:new Date().toISOString()});saveManifest(m);}
function secret(){return JSON.parse(fs.readFileSync(path.join(RUN_DIR,'fixture-secrets.json'),'utf8'));}
function saveSecret(value){fs.writeFileSync(path.join(RUN_DIR,'fixture-secrets.json'),JSON.stringify(value),{mode:0o600});}
async function mailApply(c,id,status='enabled'){
 const d=await apiCall(c.api,c.csrf,'GET','/api/panel/mail-domains/'+id);expect(d.status).toBe(200);
 const p=await apiCall(c.api,c.csrf,'POST','/api/panel/mail-domains/'+id+'/config-preview',{expectedRevision:d.data.revision,status});log('mail.apply.preview',{httpStatus:p.status,code:p.body.error?.code});expect(p.status).toBe(200);
 const q=await apiCall(c.api,c.csrf,'POST','/api/panel/mail-domains/'+id+'/config-apply',{expectedRevision:d.data.revision,status,previewDigest:p.data.previewDigest,configurationSha256:p.data.configuration.sha256,confirmation:p.data.confirmation});log('mail.apply.queue',{httpStatus:q.status,code:q.body.error?.code});expect(q.status).toBe(202);const j=await waitJob(c.api,q.data.id);log('mail.apply.finished',{jobId:j.id,status:j.status,code:j.error?.code});expect(j.status).toBe('succeeded');
}
function imapLogin(address,password){return new Promise((resolve,reject)=>{
 const s=tls.connect({host:'server.cryptoraichu.website',port:993,servername:'server.cryptoraichu.website',rejectUnauthorized:true});let sent=false,buffer='';
 s.setTimeout(12000,()=>s.destroy(new Error('IMAP test timed out')));s.on('error',()=>reject(new Error('IMAP connection or trusted TLS failed; protocol and credentials withheld')));
 s.on('data',chunk=>{buffer+=chunk.toString();if(!sent&&buffer.includes('\r\n')){sent=true;s.write('A1 LOGIN '+JSON.stringify(address)+' '+JSON.stringify(password)+'\r\n');}const result=buffer.match(/(?:^|\r\n)A1 (OK|NO|BAD) /);if(result){resolve(result[1]);s.end();}});
});}
test('@mutation Mail domain is created through its real form for the owned Website',async({page})=>{
 const m=owned();await ready(page,'/mail');await main(page).getByRole('button',{name:'Mail alan adı ekle',exact:true}).first().click();const d=page.getByRole('dialog');await expect(d).toBeVisible();await d.getByRole('combobox',{name:/Web Domain/}).selectOption(m.fixture.domainId);await d.getByRole('combobox',{name:/Yönetim modu/}).selectOption('local');
 const response=page.waitForResponse(r=>r.url().endsWith('/api/panel/mail-domains')&&r.request().method()==='POST');await d.getByRole('button',{name:'Mail domain oluştur',exact:true}).click();const r=await response;expect(r.status()).toBe(201);const value=(await r.json()).data;store({mailDomainId:value.id});await expect(d).toBeHidden();
 await ready(page,'/mail/'+value.id);await expect(main(page)).toContainText(m.fixture.hostname);
});
test('@mutation Two actual mailboxes are created and rendered in the owned mail workspace',async({liveApi,page})=>{
 const m=owned();expect(m.fixture.mailDomainId).toBeTruthy();const ids=[];const s=secret();s.mailPasswords??={};
 for(const name of ['alpha','beta']){s.mailPasswords[name]=randomBytes(22).toString('base64url');saveSecret(s);const r=await apiCall(liveApi.api,liveApi.csrf,'POST','/api/panel/mailboxes',{mailDomainId:m.fixture.mailDomainId,address:name+'@'+m.fixture.hostname,password:s.mailPasswords[name]});expect(r.status).toBe(201);ids.push(r.data.id);store({mailboxIds:ids});}
 await ready(page,'/mail/'+m.fixture.mailDomainId);await expect(main(page)).toContainText('alpha@'+m.fixture.hostname);await expect(main(page)).toContainText('beta@'+m.fixture.hostname);
});
test('@mutation Mail quota, forwarding and alias CRUD retain actual revisions',async({liveApi})=>{
 const m=owned();expect(m.fixture.mailboxIds?.length).toBe(2);const id=m.fixture.mailboxIds[0],root='/api/panel/mailboxes/'+id;
 const quota=await apiCall(liveApi.api,liveApi.csrf,'PUT',root+'/quota',{expectedRevision:0,quotaBytes:104857600});expect(quota.status).toBe(200);expect((await apiCall(liveApi.api,liveApi.csrf,'GET',root+'/quota')).data.quotaBytes).toBe(104857600);
 const forwarding=await apiCall(liveApi.api,liveApi.csrf,'PUT',root+'/forwarding',{expectedRevision:0,mode:'copy',destinations:['beta@'+m.fixture.hostname],enabled:true});expect(forwarding.status).toBe(200);
 const alias=await apiCall(liveApi.api,liveApi.csrf,'POST','/api/panel/mail-aliases',{mailDomainId:m.fixture.mailDomainId,source:'team@'+m.fixture.hostname,destinations:['alpha@'+m.fixture.hostname]});expect(alias.status).toBe(201);store({mailAliasId:alias.data.id});
 const updated=await apiCall(liveApi.api,liveApi.csrf,'PATCH','/api/panel/mail-aliases/'+alias.data.id,{expectedRevision:alias.data.revision,destinations:['beta@'+m.fixture.hostname],enabled:true});expect(updated.status).toBe(200);expect(updated.data.revision).toBeGreaterThan(alias.data.revision);
 const removed=await apiCall(liveApi.api,liveApi.csrf,'DELETE','/api/panel/mail-aliases/'+alias.data.id,{expectedRevision:updated.data.revision,confirmation:'delete-mail-alias:team@'+m.fixture.hostname});expect(removed.status).toBe(200);
 expect((await apiCall(liveApi.api,liveApi.csrf,'DELETE',root+'/forwarding',{expectedRevision:forwarding.data.revision,confirmation:'clear-mailbox-forwarding:'+id})).status).toBe(200);
 expect((await apiCall(liveApi.api,liveApi.csrf,'DELETE',root+'/quota',{expectedRevision:quota.data.revision,confirmation:'clear-mailbox-quota:'+id})).status).toBe(200);
});
test('@mutation Mail apply supports real IMAP login after a password rotation',async({liveApi})=>{
 test.setTimeout(180000);const m=owned();expect(m.fixture.mailboxIds?.length).toBe(2);const id=m.fixture.mailboxIds[0],root='/api/panel/mailboxes/'+id;const current=await apiCall(liveApi.api,liveApi.csrf,'GET',root);const s=secret();s.mailPasswords.alpha=randomBytes(22).toString('base64url');saveSecret(s);
 const rotated=await apiCall(liveApi.api,liveApi.csrf,'POST',root+'/password',{expectedRevision:current.data.revision,password:s.mailPasswords.alpha});expect(rotated.status).toBe(200);await mailApply(liveApi,m.fixture.mailDomainId);
 const result=await imapLogin('alpha@'+m.fixture.hostname,s.mailPasswords.alpha);log('mail.imap.real-login',{status:result});expect(result).toBe('OK');
});
test('@mutation Mail delivery sends only to the disposable sibling mailbox',async({liveApi,page})=>{
 test.setTimeout(120000);const m=owned();expect(m.fixture.mailboxIds?.length).toBe(2);
 const r=await apiCall(liveApi.api,liveApi.csrf,'POST','/api/panel/mailboxes/'+m.fixture.mailboxIds[0]+'/test-delivery',{recipient:'beta@'+m.fixture.hostname,subject:'YP-AUDIT-'+m.runId});log('mail.local-delivery',{httpStatus:r.status,delivered:r.data?.delivered,code:r.body.error?.code});expect(r.status).toBe(200);expect(r.data.delivered).toBe(true);
 await ready(page,'/mail/'+m.fixture.mailDomainId+'?section=webmail');await expect(main(page).getByRole('link',{name:/Webmail.*aç/i}).first(),'Webmail requires an actual launch operation').toBeVisible();
});
test('@mutation DNS zone provisioning and TXT create update delete run on the owned hostname',async({liveApi,page})=>{
 test.setTimeout(120000);const m=owned(),root='/api/panel/domains/'+m.fixture.domainId+'/dns';
 let zone=await apiCall(liveApi.api,liveApi.csrf,'GET',root+'/zone');if(zone.status===404){zone=await apiCall(liveApi.api,liveApi.csrf,'POST',root+'/provision-zone',{});log('dns.provision',{httpStatus:zone.status,code:zone.body.error?.code});}expect(zone.status).toBe(200);store({ownedDnsZone:true});
 const owner='_ypaudit',value='YP-DNS-'+m.runId;
 for(const text of [value,value+'-UPDATED']){const fresh=await apiCall(liveApi.api,liveApi.csrf,'GET',root+'/zone');const r=await apiCall(liveApi.api,liveApi.csrf,'POST',root+'/records',{owner,type:'TXT',ttl:300,values:[text],expectedSerial:fresh.data.serial});log('dns.txt.write',{httpStatus:r.status,code:r.body.error?.code});expect(r.status).toBe(200);}
 await ready(page,'/websites/'+m.fixture.domainId+'/dns');await expect(main(page)).toContainText(value+'-UPDATED');const fresh=await apiCall(liveApi.api,liveApi.csrf,'GET',root+'/zone');const r=await apiCall(liveApi.api,liveApi.csrf,'POST',root+'/records/delete',{owner,type:'TXT',expectedSerial:fresh.data.serial});expect(r.status).toBe(200);expect((await apiCall(liveApi.api,liveApi.csrf,'GET',root+'/zone')).data.rrsets.some(v=>v.owner.startsWith(owner+'.'))).toBe(false);
});
test('@mutation Docker Compose creates a dedicated project with no published ports',async({page})=>{
 const m=owned();await ready(page,'/docker');await main(page).getByRole('button',{name:/Compose projesi ekle/i}).first().click();const d=page.getByRole('dialog');await expect(d).toBeVisible();await d.getByLabel('Proje adı',{exact:true}).fill('ypaudit_'+m.runId.replaceAll('-','_'));await d.getByLabel('Compose document').fill('services:\n  web:\n    image: nginx:alpine\n');
 const response=page.waitForResponse(r=>r.url().endsWith('/api/panel/docker/projects')&&r.request().method()==='POST');await d.getByRole('button',{name:'Projeyi kaydet',exact:true}).click();const r=await response;log('docker.create',{httpStatus:r.status});expect(r.status()).toBe(201);const v=(await r.json()).data.project;store({dockerProjectId:v.id,dockerProjectName:v.projectName});await expect(main(page)).toContainText(v.projectName);
});
test('@mutation Docker pulls starts stops its own actual Compose service',async({liveApi,page})=>{
 test.setTimeout(240000);const m=owned();expect(m.fixture.dockerProjectId).toBeTruthy();const root='/api/panel/docker/projects/'+m.fixture.dockerProjectId;
 for(const action of ['pull','start','stop']){const p=await apiCall(liveApi.api,liveApi.csrf,'POST',root+'/operations/'+action+'/preview',{});expect(p.status).toBe(200);const q=await apiCall(liveApi.api,liveApi.csrf,'POST',root+'/operations/'+action,{expectedPreviewDigest:p.data.previewDigest,confirmation:p.data.confirmation});log('docker.'+action,{httpStatus:q.status,code:q.body.error?.code});expect(q.status).toBe(202);const j=await waitJob(liveApi.api,q.data.job.id,180000);log('docker.'+action+'.finished',{jobId:j.id,status:j.status,code:j.error?.code});expect(j.status).toBe('succeeded');if(action==='start'){const runtime=await apiCall(liveApi.api,liveApi.csrf,'GET',root+'/runtime');expect(runtime.status).toBe(200);log('docker.actual-runtime',{data:runtime.data});expect(JSON.stringify(runtime.data)).toMatch(/running/i);}}
 await ready(page,'/docker/'+m.fixture.dockerProjectId);
});
test('@mutation Docker project offers normal teardown and removal in its real workspace',async({page})=>{
 const m=owned();expect(m.fixture.dockerProjectId).toBeTruthy();await ready(page,'/docker/'+m.fixture.dockerProjectId);await expect(main(page).getByRole('button',{name:/Projeyi sil|Projeyi kaldır|Delete project|Remove project/i}).first(),'Stopping containers is not a complete remove operation').toBeVisible();
});
