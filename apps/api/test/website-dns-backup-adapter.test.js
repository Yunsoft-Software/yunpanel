import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {mkdtemp,readFile,writeFile,rm,stat} from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import {powerDnsZoneManagerInternals as dns} from '@yunpanel/host-runtime/powerdns-zone-manager';
import {createWebsiteDnsBackupAdapter} from '../src/website-dns-backup-adapter.js';
import {createWebsiteResourceBackupCodec} from '../src/website-resource-backup-codec.js';

// Actual protected files and codec; the authoritative host adapter is controlled.
async function fixture(t){
 const stagedRoot=await mkdtemp(path.join(os.tmpdir(),'yp-dns-backup-'));t.after(()=>rm(stagedRoot,{recursive:true,force:true}));
 const website={id:randomUUID(),serverId:randomUUID()},domain={id:randomUUID(),websiteId:website.id,serverId:website.serverId,
  primaryDomain:'owned.example.test',parentDomainId:null};
 const entry={domainId:domain.id,primaryDomain:domain.primaryDomain,stagedZonePath:path.join(stagedRoot,'dns',domain.primaryDomain+'.zone.json')};
 const backupSet={website,stagedRoot,dns:[entry]};let status='provisioning_created',exists=true,domains=[domain],writes=0;
 let live={version:1,zoneName:domain.primaryDomain,id:domain.primaryDomain+'.',kind:'Native',dnssec:false,rrsets:[
  {name:domain.primaryDomain+'.',type:'SOA',ttl:3600,records:[{content:'ns1.example.test. hostmaster.example.test. 2026101001 3600 600 86400 300',disabled:false}],comments:[]},
  {name:'proof.'+domain.primaryDomain+'.',type:'TXT',ttl:300,records:[{content:'"saved-owned-record"',disabled:false}],comments:[]},
 ]};
 const manager={getZone:async(name,key)=>{assert.equal(name,domain.primaryDomain);assert.equal(key,'controlled-key');return exists?structuredClone(live):null;},
  restoreSnapshot:async input=>{assert.equal(input.zoneName,domain.primaryDomain);assert.equal(input.apiKey,'controlled-key');
   assert.equal(dns.sameZoneState(input.after,live),true);writes++;live=structuredClone(input.before);return{satisfied:true,zoneName:input.zoneName};}};
 const adapter=createWebsiteDnsBackupAdapter({websiteRegistry:{getWebsite:async()=>website},domainRegistry:{getDomain:async()=>domain,listDomains:async()=>domains},
  powerDnsSecretRegistry:{materializeForServer:async id=>{assert.equal(id,website.serverId);return{apiKey:'controlled-key'};}},zoneManager:manager,
  codec:createWebsiteResourceBackupCodec({masterKey:Buffer.alloc(32,27)}),ownershipInspector:{preview:async()=>({domain:{...domain},
   zone:{exists,dnssec:live.dnssec,snapshotDigest:exists?dns.zoneSnapshotDigest(live):null,
    ownershipOrigin:{status,operationId:'original-owned-operation',evidenceDigest:'a'.repeat(64)}}})}});
 return{website,domain,entry,backupSet,adapter,get writes(){return writes;},get live(){return live;},
  change(){live.rrsets[1].records[0].content='"changed-owned-record"';},setStatus(value){status=value;},setExists(value){exists=value;},
  foreignChild(){domains=[domain,{id:randomUUID(),websiteId:randomUUID(),primaryDomain:'foreign.'+domain.primaryDomain}];}};
}
test('capture encrypts actual RRsets and restore verifies the original authoritative data',async t=>{
 const f=await fixture(t),original=structuredClone(f.live);const captured=await f.adapter.capture(f.backupSet,f.entry);
 assert.equal(captured.captured,true);assert.equal(captured.rrsetCount,2);
 const protectedFile=await readFile(f.entry.stagedZonePath,'utf8');assert.doesNotMatch(protectedFile,/saved-owned-record|controlled-key/);
 assert.equal((await stat(f.entry.stagedZonePath)).mode&0o777,0o600);f.change();
 const result=await f.adapter.restore({backupSet:f.backupSet,include:[f.entry.stagedZonePath]});
 assert.equal(result[0].restored,true);assert.equal(dns.sameZoneState(f.live,original),true);assert.equal(f.writes,1);
});
test('external references never claim DNS records were captured or restoreable',async t=>{
 const f=await fixture(t);f.setStatus('unavailable');const result=await f.adapter.capture(f.backupSet,f.entry);
 assert.equal(result.captured,false);assert.equal(result.rrsetCount,0);
 await assert.rejects(f.adapter.restore({backupSet:f.backupSet,include:[f.entry.stagedZonePath]}),e=>e.code==='website_dns_restore_scope_unavailable');assert.equal(f.writes,0);
});
test('a missing provisioned zone and a shared foreign namespace fail before capture or restore',async t=>{
 const f=await fixture(t);f.setExists(false);
 await assert.rejects(f.adapter.capture(f.backupSet,f.entry),e=>e.code==='website_dns_backup_zone_missing');
 f.setExists(true);f.foreignChild();await assert.rejects(f.adapter.capture(f.backupSet,f.entry),e=>e.code==='website_dns_backup_shared_zone_unavailable');
 assert.equal(f.writes,0);
});
test('a tampered or legacy metadata-only file cannot modify the authoritative zone',async t=>{
 const f=await fixture(t);await f.adapter.capture(f.backupSet,f.entry);f.change();
 await writeFile(f.entry.stagedZonePath,JSON.stringify({domainId:f.domain.id,primaryDomain:f.domain.primaryDomain}),{mode:0o600});
 await assert.rejects(f.adapter.restore({backupSet:f.backupSet,include:[f.entry.stagedZonePath]}),e=>e.code==='website_resource_backup_invalid');assert.equal(f.writes,0);
});
test('a staged path or Website binding outside the confirmed scope is rejected',async t=>{
 const f=await fixture(t);await assert.rejects(f.adapter.capture(f.backupSet,{...f.entry,stagedZonePath:'/etc/powerdns/pdns.conf'}),e=>e.code==='website_dns_backup_scope_invalid');
 const previous=f.domain.websiteId;f.domain.websiteId=randomUUID();await assert.rejects(f.adapter.capture(f.backupSet,f.entry),e=>e.code==='website_dns_backup_scope_invalid');
 f.domain.websiteId=previous;assert.equal(f.writes,0);
});

test('a separately provisioned child zone is captured and restored without accessing its parent',async t=>{
 const f=await fixture(t);f.domain.parentDomainId=randomUUID();const original=structuredClone(f.live);
 const captured=await f.adapter.capture(f.backupSet,f.entry);assert.equal(captured.captured,true);
 f.change();await f.adapter.restore({backupSet:f.backupSet,include:[f.entry.stagedZonePath]});
 assert.equal(dns.sameZoneState(f.live,original),true);assert.equal(f.writes,1);
});
test('an inherited child without its own provisioning receipt remains a reference and cannot restore a parent zone',async t=>{
 const f=await fixture(t);f.domain.parentDomainId=randomUUID();f.setStatus('unavailable');
 assert.equal((await f.adapter.capture(f.backupSet,f.entry)).captured,false);
 await assert.rejects(f.adapter.restore({backupSet:f.backupSet,include:[f.entry.stagedZonePath]}),e=>e.code==='website_dns_restore_scope_unavailable');
 assert.equal(f.writes,0);
});
