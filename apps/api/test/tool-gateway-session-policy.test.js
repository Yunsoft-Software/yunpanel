import test from 'node:test';
import assert from 'node:assert/strict';
import { requireToolGatewaySession } from '../src/tool-gateway-session-policy.js';
const manager = {user:{role:'site_manager',websiteIds:['site-a']}};
const gateway = {id:'phpmyadmin',accessPath:'/api/phpmyadmin-gateway-access'};
const policy = {
 requireSiteManagement(session) { if(session?.user?.role !== 'site_manager') throw new Error('forbidden'); return {...session,access:{mode:'site_management'},security:{managementAllowed:true}}; },
 requireManagement(session) { if(session?.user?.role !== 'owner' || session.mfaReady !== true) throw new Error('owner_or_mfa_required'); return session; },
};
test('assigned site manager may reach only phpMyAdmin while SQL handoff remains separate',()=>{
 assert.equal(requireToolGatewaySession(policy,manager,gateway).access.mode,'site_management');
});
test('other tools retain Owner authorization',()=>{
 for(const id of ['ttyd','elfinder','netdata','goaccess','unknown']) assert.throws(()=>requireToolGatewaySession(policy,manager,{id,accessPath:`/api/${id}-gateway-access`}),/owner_or_mfa/);
 assert.throws(()=>requireToolGatewaySession(policy,manager,{...gateway,accessPath:'/api/netdata-gateway-access'}));
});
test('unassigned, malformed, read-only and missing sessions never get the site exception',()=>{
 for(const user of [{role:'site_manager',websiteIds:[]},{role:'site_manager',websiteIds:['']},{role:'site_manager'}, {role:'read_only',websiteIds:['site-a']}]) assert.throws(()=>requireToolGatewaySession(policy,{user},gateway));
 assert.throws(()=>requireToolGatewaySession(policy,null,gateway));
});
test('Owner MFA is not weakened and failed live site permission is rejected',()=>{
 assert.throws(()=>requireToolGatewaySession(policy,{user:{role:'owner'},mfaReady:false},gateway));
 assert.equal(requireToolGatewaySession(policy,{user:{role:'owner'},mfaReady:true},gateway).mfaReady,true);
 const blocked={...policy,requireSiteManagement:()=>({access:{mode:'site_management'},security:{managementAllowed:false}})};
 assert.throws(()=>requireToolGatewaySession(blocked,manager,gateway));
});
