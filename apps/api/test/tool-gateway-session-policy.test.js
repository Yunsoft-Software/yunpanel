import test from 'node:test';
import assert from 'node:assert/strict';
import { requireToolGatewaySession } from '../src/tool-gateway-session-policy.js';
const manager = {user:{role:'site_manager',websiteIds:['site-a']}};
const gateway = {id:'phpmyadmin',accessPath:'/api/phpmyadmin-gateway-access'};
const policy = {
 requireSiteManagement(session) { if(session?.user?.role !== 'site_manager') throw new Error('forbidden'); return {...session,access:{mode:'site_management'},security:{managementAllowed:true}}; },
 requireManagement(session) { if(session?.user?.role !== 'owner' || session.mfaReady !== true) throw new Error('owner_or_mfa_required'); return session; },
};
test('site role alone cannot unlock an unbound persistent phpMyAdmin SQL cookie',()=>{
 assert.throws(()=>requireToolGatewaySession(policy,manager,gateway),
  error=>error.status===403 && error.code==='phpmyadmin_site_session_binding_required');
});
test('other tools retain Owner authorization',()=>{
 for(const id of ['ttyd','elfinder','netdata','goaccess','unknown']) assert.throws(()=>requireToolGatewaySession(policy,manager,{id,accessPath:`/api/${id}-gateway-access`}),/owner_or_mfa/);
 assert.throws(()=>requireToolGatewaySession(policy,manager,{...gateway,accessPath:'/api/netdata-gateway-access'}));
});
test('changed, unassigned and malformed Website lists cannot retain an earlier SQL session',()=>{
 for(const websiteIds of [['site-b'],[],[''],null]) {
  assert.throws(()=>requireToolGatewaySession(policy,{user:{role:'site_manager',websiteIds}},gateway),error=>error.status===403);
 }
 assert.throws(()=>requireToolGatewaySession(policy,{user:{role:'read_only',websiteIds:['site-a']}},gateway));
 assert.throws(()=>requireToolGatewaySession(policy,null,gateway));
});
test('Owner MFA stays required and site permission failure cannot fall through',()=>{
 assert.throws(()=>requireToolGatewaySession(policy,{user:{role:'owner'},mfaReady:false},gateway));
 assert.equal(requireToolGatewaySession(policy,{user:{role:'owner'},mfaReady:true},gateway).mfaReady,true);
 const blocked={...policy,requireSiteManagement:()=>{throw new Error('site permission expired');}};
 assert.throws(()=>requireToolGatewaySession(blocked,manager,gateway),/site permission expired/);
});
