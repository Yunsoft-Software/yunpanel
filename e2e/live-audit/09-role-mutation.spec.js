import {request} from '@playwright/test';
import {randomBytes} from 'node:crypto';
import {test,expect,manifest,saveManifest,apiCall,safeApi,ORIGIN} from './support.js';
test('@mutation Real read-only and site manager sessions enforce scope and immediate revocation',async({liveApi})=>{
 test.setTimeout(120000);const m=manifest();expect(m.fixture.createdWebsiteIds).toContain(m.fixture.websiteId);
 for(const role of ['read_only','site_manager']){
  const username='ypaudit-'+m.runId+'-'+role,password=randomBytes(24).toString('base64url');const created=await apiCall(liveApi.api,liveApi.csrf,'POST','/api/panel/users',{username,password,role,active:true,...(role==='site_manager'?{websiteIds:[m.fixture.websiteId]}:{})});expect(created.status).toBe(201);const user=created.data.user;const current=manifest();current.fixture.createdUserIds.push(user.id);saveManifest(current);
  const actor=safeApi(await request.newContext({baseURL:ORIGIN,storageState:{cookies:[],origins:[]},ignoreHTTPSErrors:false,extraHTTPHeaders:{Origin:ORIGIN}}));
  try{const login=await actor.post('/api/auth/login',{data:{username,password}});expect(login.status()).toBe(200);const session=(await (await actor.get('/api/auth/session')).json()).data;
   const readEndpoint=role==='site_manager'?'/api/panel/websites/'+m.fixture.websiteId+'/files':'/api/panel/websites';expect((await actor.get(readEndpoint)).status()).toBe(200);
   const write=await apiCall(actor,session.csrfToken,'POST','/api/panel/servers/'+m.serverId+'/databases',{name:'ypaudit_denied_'+m.runId.replaceAll('-','_'),confirmation:'create:ypaudit_denied_'+m.runId.replaceAll('-','_')});expect(write.status).toBe(403);
   if(role==='site_manager'){expect([403,404]).toContain((await actor.get('/api/panel/websites/'+m.existingPhpWebsiteId+'/files')).status());expect((await actor.get('/api/panel/ai/providers')).status()).toBe(403);}
   const fresh=await apiCall(liveApi.api,liveApi.csrf,'GET','/api/panel/users?limit=100');const revision=fresh.data.users.find(u=>u.id===user.id).revision;const changed=await apiCall(liveApi.api,liveApi.csrf,'PATCH','/api/panel/users/'+user.id,{revision,active:false});expect(changed.status).toBe(200);expect((await actor.get(readEndpoint)).status()).toBe(401);
  }finally{await actor.dispose();const users=await apiCall(liveApi.api,liveApi.csrf,'GET','/api/panel/users?limit=100');let latest=users.data.users.find(u=>u.id===user.id);if(latest){if(latest.role==='site_manager'&&latest.websiteIds?.length){const clear=await apiCall(liveApi.api,liveApi.csrf,'PATCH','/api/panel/users/'+user.id,{revision:latest.revision,websiteIds:[]});expect(clear.status).toBe(200);latest=clear.data.user;}const deleted=await apiCall(liveApi.api,liveApi.csrf,'DELETE','/api/panel/users/'+user.id,{revision:latest.revision});expect(deleted.status).toBe(200);}}
 }
});

test('@mutation Site manager phpMyAdmin uses the real owned SQL session and rejects cookie replay after immediate deactivation', async ({ liveApi, browser }) => {
 test.setTimeout(120000); const m = manifest();
 expect(m.fixture.createdWebsiteIds).toContain(m.fixture.websiteId);
 expect(m.fixture.credential?.id).toBeTruthy();
 const username = 'ypaudit-' + m.runId + '-sql-manager-' + randomBytes(4).toString('hex');
 const password = randomBytes(28).toString('base64url');
 const created = await apiCall(liveApi.api, liveApi.csrf, 'POST', '/api/panel/users', {
  username, password, role: 'site_manager', active: true, websiteIds: [m.fixture.websiteId],
 });
 expect(created.status).toBe(201); const user = created.data.user;
 const saved = manifest(); saved.fixture.createdUserIds.push(user.id); saveManifest(saved);
 const actor = safeApi(await request.newContext({ baseURL: ORIGIN, storageState: { cookies: [], origins: [] },
  ignoreHTTPSErrors: false, extraHTTPHeaders: { Origin: ORIGIN } }));
 let context;
 try {
  expect((await actor.post('/api/auth/login', { data: { username, password } })).status()).toBe(200);
  const session = (await (await actor.get('/api/auth/session')).json()).data;
  const endpoint = '/api/panel/servers/' + m.serverId + '/websites/' + m.fixture.websiteId + '/phpmyadmin-handoffs';
  const handoff = await apiCall(actor, session.csrfToken, 'POST', endpoint, { credentialId: m.fixture.credential.id });
  expect(handoff.status).toBe(201);
  const signon = await actor.post('/tools/phpmyadmin/__yunpanel/signon', {
   form: { capability: handoff.data.capability }, maxRedirects: 0,
  });
  expect(signon.status()).toBe(303);
  context = await browser.newContext({ storageState: await actor.storageState(), ignoreHTTPSErrors: false });
  const page = await context.newPage(), target = ORIGIN + '/tools/phpmyadmin/index.php?route=%2Fdatabase%2Fstructure&db=' + encodeURIComponent(m.fixture.databaseName);
  const response = await page.goto(target); expect(response.status()).toBe(200);
  await expect(page.getByRole('link', { name: 'yp_native_proof', exact: true }).first()).toBeVisible();
  const foreignId = m.fixture.extraStatic.websiteId;
  expect((await apiCall(actor, session.csrfToken, 'POST', '/api/panel/servers/' + m.serverId + '/websites/' + foreignId + '/phpmyadmin-handoffs', { credentialId: m.fixture.credential.id })).status).toBe(403);
  const current = await apiCall(liveApi.api, liveApi.csrf, 'GET', '/api/panel/users?limit=100');
  const revision = current.data.users.find(candidate => candidate.id === user.id).revision;
  expect((await apiCall(liveApi.api, liveApi.csrf, 'PATCH', '/api/panel/users/' + user.id, { revision, active: false })).status).toBe(200);
  expect((await actor.get('/api/panel/websites/' + m.fixture.websiteId + '/files')).status()).toBe(401);
  const replay = safeApi(context.request);
  expect([401, 403]).toContain((await replay.get(target)).status());
  expect((await liveApi.api.get('https://' + m.fixture.hostname + '/')).status()).toBe(200);
  const result = manifest(); result.fixture.operations.push({ action: 'access.native-site-manager-sql-revoke',
   userId: user.id, ownDatabaseVisible: true, foreignHandoffDenied: true, vendorCookieReplayDenied: true,
   sitePreserved: true, at: new Date().toISOString() }); saveManifest(result);
 } finally {
  if (context) await context.close(); await actor.dispose();
  const users = await apiCall(liveApi.api, liveApi.csrf, 'GET', '/api/panel/users?limit=100');
  let latest = users.data.users.find(candidate => candidate.id === user.id);
  if (latest) {
   const clear = await apiCall(liveApi.api, liveApi.csrf, 'PATCH', '/api/panel/users/' + user.id, { revision: latest.revision, active: false, websiteIds: [] });
   expect(clear.status).toBe(200); latest = clear.data.user;
   expect((await apiCall(liveApi.api, liveApi.csrf, 'DELETE', '/api/panel/users/' + user.id, { revision: latest.revision })).status).toBe(200);
  }
 }
});

test('@mutation Two real resellers isolate their customer lists, enforce capacity and revoke only the disabled parent chain', async ({ liveApi }) => {
 test.setTimeout(150000); const m = manifest(), root = '/api/panel/users/hosting/accounts';
 const accounts = [], actors = [];
 async function create(kind, suffix, extra = {}) {
  const username = 'ypaudit-' + m.runId + '-' + suffix + '-' + randomBytes(3).toString('hex'), password = randomBytes(28).toString('base64url');
  const result = await apiCall(liveApi.api, liveApi.csrf, 'POST', root + '/create-login', { kind, username, password, ...extra });
  expect(result.status).toBe(201); const account = result.data.account;
  accounts.push({ ...account, username, password });
  const saved = manifest(); saved.fixture.createdUserIds.push(account.id); saveManifest(saved);
  return accounts.at(-1);
 }
 async function login(account) {
  const api = safeApi(await request.newContext({ baseURL: ORIGIN, storageState: { cookies: [], origins: [] }, ignoreHTTPSErrors: false, extraHTTPHeaders: { Origin: ORIGIN } }));
  actors.push(api); expect((await api.post('/api/auth/login', { data: { username: account.username, password: account.password } })).status()).toBe(200);
  const session = (await (await api.get('/api/auth/session')).json()).data;
  expect(session.user.hosting.kind).toBe(account.kind); return { api, csrf: session.csrfToken };
 }
 try {
  const a = await create('reseller', 'ra', { limits: { maxCustomers: 1, maxWebsites: 2 } });
  const b = await create('reseller', 'rb', { limits: { maxCustomers: 1, maxWebsites: 2 } });
  const childA = await create('customer', 'ca', { resellerId: a.id });
  const childB = await create('customer', 'cb', { resellerId: b.id });
  const direct = await create('customer', 'direct', { resellerId: null });
  const aa = await login(a), ba = await login(b), ca = await login(childA), cb = await login(childB), da = await login(direct);
  for (const [actor, own, foreign] of [[aa, childA, childB], [ba, childB, childA]]) {
   const list = await apiCall(actor.api, actor.csrf, 'GET', root + '?kind=customer&limit=100'); expect(list.status).toBe(200);
   expect(list.data.accounts.map(account => account.id)).toEqual([own.id]);
   expect((await actor.api.get(root + '/' + foreign.id)).status()).toBe(403);
  }
  expect((await ca.api.get(root)).status()).toBe(403);
  const denied = await apiCall(aa.api, aa.csrf, 'POST', root + '/self/customers', {
   username: 'ypaudit-capacity-' + randomBytes(6).toString('hex'), password: randomBytes(28).toString('base64url'),
  });
  expect(denied.status).toBe(409); expect(denied.body.error.code).toBe('reseller_limit_reached');
  const current = await apiCall(liveApi.api, liveApi.csrf, 'GET', root + '/' + a.id); expect(current.status).toBe(200);
  expect((await apiCall(liveApi.api, liveApi.csrf, 'PATCH', root + '/' + a.id + '/status', { revision: current.data.revision, active: false })).status).toBe(200);
  for (const actor of [aa, ca]) expect((await actor.api.get('/api/auth/session')).status()).toBe(401);
  for (const actor of [ba, cb, da]) expect((await actor.api.get('/api/auth/session')).status()).toBe(200);
  expect((await liveApi.api.get('https://' + m.fixture.hostname + '/')).status()).toBe(200);
  const saved = manifest(); saved.fixture.operations.push({ action: 'access.native-reseller-customer-profiles',
   isolatedLists: true, capacityDenied: true, parentChainRevoked: true, siblingsPreserved: true,
   acceptanceScope: 'account profiles; assigned Website A/B ownership and native jobs remain separate', at: new Date().toISOString() }); saveManifest(saved);
 } finally {
  for (const actor of actors) await actor.dispose();
  for (const account of [...accounts.filter(account => account.kind === 'customer'), ...accounts.filter(account => account.kind === 'reseller')]) {
   const current = await apiCall(liveApi.api, liveApi.csrf, 'GET', root + '/' + account.id);
   if (current.status === 200) {
    const revision = current.data.revision;
    expect((await apiCall(liveApi.api, liveApi.csrf, 'DELETE', root + '/' + account.id + '/profile', { revision, confirmation: 'unregister-hosting-profile:' + account.id + ':' + revision })).status).toBe(200);
   }
   const users = await apiCall(liveApi.api, liveApi.csrf, 'GET', '/api/panel/users?limit=100'), user = users.data.users.find(user => user.id === account.id);
   if (user) expect((await apiCall(liveApi.api, liveApi.csrf, 'DELETE', '/api/panel/users/' + user.id, { revision: user.revision })).status).toBe(200);
  }
 }
});
