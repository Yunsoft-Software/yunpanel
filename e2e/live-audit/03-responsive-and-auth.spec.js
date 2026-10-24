import { test,expect,ready,main,manifest,ORIGIN } from './support.js';
for(const width of [320,390,834,1440])for(const screen of ['websites','databases','settings/users','tools-settings'])test('VIEWPORT '+width+' '+screen+' has usable controls and no page overflow',async({page})=>{
 await page.setViewportSize({width,height:900});await ready(page,'/'+screen);
 const metrics=await page.evaluate(()=>({viewport:innerWidth,body:document.documentElement.scrollWidth}));
 expect(metrics.body,'The page should not horizontally overflow at '+width).toBeLessThanOrEqual(metrics.viewport+2);
 await expect(main(page).locator('h1')).toBeVisible();
});
test('DB modal traps keyboard focus, closes with Escape, restores opener',async({page})=>{
 await ready(page,'/databases');const opener=main(page).getByRole('button',{name:'Veritabanı oluştur',exact:true});await opener.click();const dialog=page.getByRole('dialog');await expect(dialog).toBeVisible();
 await page.keyboard.press('Tab');const focusIsInside=await dialog.evaluate(e=>e.contains(document.activeElement));expect(focusIsInside).toBe(true);
 await page.keyboard.press('Escape');await expect(dialog).toBeHidden();await expect(opener).toBeFocused();
});
test('Site navigation back/forward preserves site context and search URL',async({page})=>{
 const m=manifest();await ready(page,'/websites?q='+encodeURIComponent(m.existingPhpDomain));
 await main(page).getByRole('link',{name:m.existingPhpDomain,exact:true}).click();await expect(main(page).locator('h1')).toHaveText(m.existingPhpDomain);
 await page.goBack();await expect(page).toHaveURL(new RegExp('q='+m.existingPhpDomain.replace('.','\\.')));
 await page.goForward();await expect(main(page).locator('h1')).toHaveText(m.existingPhpDomain);
});
test('Anonymous managed API requests are denied, not exposed by another route',async({playwright})=>{
 const anonymous=await playwright.request.newContext({baseURL:ORIGIN,ignoreHTTPSErrors:false,storageState:{cookies:[],origins:[]}});
 for(const endpoint of ['/api/panel/websites','/api/panel/servers/'+manifest().serverId+'/databases','/api/panel/ai/providers','/api/panel/jobs']){
  const response=await anonymous.get(endpoint);expect.soft([401,403].includes(response.status()),endpoint+' must reject unauthenticated reads').toBe(true);
 }await anonymous.dispose();
});
test('Actual API inventory preserves Website/Domain identities',async({liveApi})=>{
 const m=manifest();const response=await liveApi.api.get('/api/panel/websites/'+m.existingPhpWebsiteId);expect(response.status()).toBe(200);const w=(await response.json()).data;expect(w.id).toBe(m.existingPhpWebsiteId);expect(w.id).not.toBe(m.existingPhpDomainId);
});
