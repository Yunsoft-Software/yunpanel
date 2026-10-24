import {test,expect,ready,main,manifest,saveManifest,apiCall,envFile} from './support.js';

test('@ai-live Existing env key reaches real OpenRouter while the active provider is preserved',async({liveApi})=>{
 test.setTimeout(120000);const m=manifest();const key=envFile('.local/ai-credentials.env').OPENROUTER_API_KEY;expect(Boolean(key),'The existing private env token is required').toBe(true);
 const before=await apiCall(liveApi.api,liveApi.csrf,'GET','/api/panel/ai/providers');expect(before.status).toBe(200);
 const active=before.data.find(v=>v.id===before.body.activeProviderId);expect(active.type).toBe('openrouter');
 const id='ypaudit-'+m.runId+'-env';
 const created=await apiCall(liveApi.api,liveApi.csrf,'POST','/api/panel/ai/providers',{id,type:'openrouter',apiKey:key,baseUrl:'https://openrouter.ai/api/v1',defaultModel:active.defaultModel,makeActive:false});expect(created.status).toBe(201);
 const current=manifest();current.fixture.createdProviderIds.push(id);saveManifest(current);
 try{
  expect(JSON.stringify(created.body).includes(key),'API must not return the configured secret').toBe(false);
  const response=await apiCall(liveApi.api,liveApi.csrf,'POST','/api/panel/ai/providers/'+id+'/test',{});
  const data=manifest();data.fixture.operations.push({action:'ai.env-provider.real-call',httpStatus:response.status,success:response.data?.success,at:new Date().toISOString()});saveManifest(data);
  expect(response.status,'Real provider invocation must succeed').toBe(200);expect(response.data.success).toBe(true);
  const after=await apiCall(liveApi.api,liveApi.csrf,'GET','/api/panel/ai/providers');expect(after.body.activeProviderId).toBe(before.body.activeProviderId);
 }finally{
  const result=await apiCall(liveApi.api,liveApi.csrf,'DELETE','/api/panel/ai/providers/'+id);expect(result.status).toBe(200);
 }
});
test('@ai-live AI streams a real nonce response and retains it after close/reopen/reload',async({page,liveApi})=>{
 test.setTimeout(120000);const m=manifest();const marker='YP-LIVE-'+m.runId.toUpperCase();
 await ready(page,'/websites');await page.getByRole('button',{name:'AI asistanı aç (Ürün uzantısı)',exact:true}).click();const dialog=page.getByRole('dialog');await expect(dialog).toBeVisible();
 const created=page.waitForResponse(r=>r.url().endsWith('/ai/conversations')&&r.request().method()==='POST');
 await dialog.getByRole('button',{name:'Yeni',exact:true}).click();const newResponse=await created;expect(newResponse.status()).toBe(201);const conversation=(await newResponse.json()).data;
 await dialog.getByRole('textbox',{name:'AI mesajınız',exact:true}).fill('Yalnızca '+marker+' yaz. Araç çağırma ve sunucuda işlem yapma.');await dialog.getByRole('button',{name:'Gönder',exact:true}).click();
 
 const current=manifest();current.fixture.createdConversationIds=[...(current.fixture.createdConversationIds||[]),conversation.id];saveManifest(current);
 try{
  await expect(dialog.getByText(marker,{exact:true}),'An actual assistant message must answer the unique nonce').toBeVisible({timeout:90000});
  await dialog.getByRole('button',{name:'Pencereyi kapat',exact:true}).click();await expect(dialog).toBeHidden();
  await page.getByRole('button',{name:'AI asistanı aç (Ürün uzantısı)',exact:true}).click();await expect(page.getByRole('dialog').getByText(marker,{exact:true})).toBeVisible();
  await page.reload();await expect(main(page).locator('h1')).toBeVisible();await page.getByRole('button',{name:'AI asistanı aç (Ürün uzantısı)',exact:true}).click();
  const history=await apiCall(liveApi.api,liveApi.csrf,'GET','/api/panel/ai/conversations/'+conversation.id);expect(history.status).toBe(200);expect(JSON.stringify(history.data).includes(marker)).toBe(true);
  const record=manifest();record.fixture.operations.push({action:'ai.browser.real-stream-and-persistence',conversationId:conversation.id,at:new Date().toISOString()});saveManifest(record);
 }finally{
  const removed=await apiCall(liveApi.api,liveApi.csrf,'DELETE','/api/panel/ai/conversations/'+conversation.id);expect(removed.status).toBe(200);
 }
});
