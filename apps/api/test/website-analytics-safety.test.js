import assert from 'node:assert/strict';
import test from 'node:test';
import { websiteAnalyticsHttpInternals } from '../src/website-analytics-http.js';

const websiteId='11111111-1111-4111-8111-111111111111';
const raw={websiteId,running:true,pid:1234,socketExists:true,socketPath:'/run/private.sock',pidPath:'/run/private.pid'};

test('analytics status hides pid and host socket paths',()=>{
 const value=websiteAnalyticsHttpInternals.analyticsStatusView(raw,websiteId,{owner:false});
 assert.deepEqual(value,{websiteId,running:true,socketReady:true});
 assert.equal(Object.hasOwn(value,'pid'),false);assert.equal(Object.hasOwn(value,'socketPath'),false);
});
test('owner status gets only same-origin websocket url, not host path',()=>{
 const value=websiteAnalyticsHttpInternals.analyticsStatusView(raw,websiteId,{owner:true});
 assert.equal(value.wsUrl,'/tools/goaccess/'+websiteId+'/ws');assert.equal(Object.hasOwn(value,'pidPath'),false);
});
test('realtime result is narrowed and rejects mismatched Website',()=>{
 assert.deepEqual(websiteAnalyticsHttpInternals.realtimeView({websiteId,running:true,alreadyRunning:false,pid:1,socketPath:'/x'},websiteId,'start'),{websiteId,running:true,alreadyRunning:false});
 assert.throws(()=>websiteAnalyticsHttpInternals.realtimeView({...raw,websiteId:'22222222-2222-4222-8222-222222222222'},websiteId,'start'));
});
