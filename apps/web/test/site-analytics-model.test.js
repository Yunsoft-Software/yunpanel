import assert from 'node:assert/strict';import test from 'node:test';
import {analyticsReport,analyticsStatus,resolveSiteAnalyticsAccess} from '../src/workspace/site-analytics-model.js';
const scope={websiteId:'11111111-1111-4111-8111-111111111111',serverId:'22222222-2222-4222-8222-222222222222'};
test('site analytics status accepts safe fields and owner wsUrl only',()=>{
 assert.deepEqual(analyticsStatus({websiteId:scope.websiteId,available:true,version:'1.8.1',running:true,socketReady:true},scope),{websiteId:scope.websiteId,available:true,version:'1.8.1',running:true,socketReady:true});
 assert.throws(()=>analyticsStatus({websiteId:scope.websiteId,available:true,version:'1',running:true,socketReady:true,wsUrl:'/tools/goaccess/'+scope.websiteId+'/ws'},scope));
 assert.equal(analyticsStatus({websiteId:scope.websiteId,available:true,version:'1',running:true,socketReady:true,wsUrl:'/tools/goaccess/'+scope.websiteId+'/ws'},scope,{owner:true}).wsUrl.includes('/tools/goaccess/'),true);
});
test('report binds generated metadata to Website',()=>{const v=analyticsReport({websiteId:scope.websiteId,primaryDomain:'example.test',generatedAt:'2026-09-25T00:00:00.000Z'},scope);assert.equal(v.primaryDomain,'example.test');assert.throws(()=>analyticsReport({...v,websiteId:'33333333-3333-4333-8333-333333333333'},scope));});
test('access resolves explicit Domain Website only',()=>{const input={domainId:'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',canManage:true,domains:{status:'ready',items:[{id:'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',websiteId:scope.websiteId,serverId:scope.serverId}]},websites:{status:'ready',items:[{id:scope.websiteId,serverId:scope.serverId}]}};assert.deepEqual(resolveSiteAnalyticsAccess(input),{state:'ready',scope});});
