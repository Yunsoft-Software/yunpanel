import fs from 'node:fs';
import path from 'node:path';
import { expect,test as base } from '@playwright/test';
import { ORIGIN,RUN_DIR,apiContext,main } from './runtime.js';
export * from './runtime.js';
export const test=base.extend({
  liveApi:async({},use)=>{const context=await apiContext();await use(context);await context.api.dispose();},
  auditObservation:[async({context,page},use,info)=>{
  const traffic=[]; const errors=[];
  page.on('response',response=>{const u=new URL(response.url());if(u.origin===ORIGIN&&u.pathname.startsWith('/api/'))traffic.push({path:u.pathname,method:response.request().method(),status:response.status()});});
  page.on('pageerror',error=>errors.push({name:error.name,message:error.message.replace(/(?:sk-[a-zA-Z0-9_-]+|Bearer\s+\S+)/g,'[REDACTED]').slice(0,400)}));
  page.auditTraffic=traffic;page.auditErrors=errors;
  // Read suites cannot mutate server state accidentally. Mutation and AI suites opt in explicitly.
  if(!info.title.includes('@mutation')&&!info.title.includes('@ai-live')) {
    await context.route('**/api/**',route=>{
      const req=route.request();const u=new URL(req.url());
      if(['GET','HEAD','OPTIONS'].includes(req.method()))return route.continue();
      if(['/api/auth/logout','/api/auth/keep-alive'].includes(u.pathname)||/\/(?:preview|prepare|elfinder-handoffs|phpmyadmin-handoffs|terminal-sessions)$/.test(u.pathname))return route.continue();
      page.auditTraffic.push({path:u.pathname,method:req.method(),status:'blocked-by-read-only-test'});
      return route.abort('blockedbyclient');
    });
  }
    try { await use(); } finally { await saveBrowserEvidence(page, info); }
  },{auto:true}],
});

async function saveBrowserEvidence(page,info) {
  const slug=(info.project.name+'-'+info.title).replace(/[^a-zA-Z0-9_-]/g,'-').slice(0,160);
  if(page && !page.isClosed()) {
    const mounted=await main(page).isVisible().catch(()=>false);
    const evidence={url:page.url(),title:info.title,project:info.project.name,status:info.status,expectedStatus:info.expectedStatus,viewport:page.viewportSize(),traffic:page.auditTraffic,pageErrors:page.auditErrors,
      workspaceMounted:mounted,acceptanceSource:process.env.YUNPANEL_AUDIT_ACCEPTANCE_SHA??null,lane:process.env.YUNPANEL_AUDIT_LANE??'read',transport:process.env.YUNPANEL_AUDIT_SSH_PROXY?'ssh-loopback-socks':'direct-https',
      headings:mounted?await main(page).locator('h1,h2,h3').allTextContents():[],
      buttons:mounted?await main(page).locator('button').evaluateAll(values=>values.map(e=>({label:e.innerText||e.getAttribute('aria-label'),disabled:e.disabled}))):[],
      links:mounted?await main(page).locator('a').evaluateAll(values=>values.map(e=>({label:e.innerText,href:e.getAttribute('href')}))):[],
    };
    const evidenceFile=path.join(RUN_DIR,slug+'.json');fs.writeFileSync(evidenceFile,JSON.stringify(evidence,null,2),{mode:0o600});
    const screenshot=path.join(RUN_DIR,slug+'.png');
    await page.screenshot({path:screenshot,fullPage:false,mask:[page.locator('input[type="password"]'),page.locator('textarea')]}).catch(()=>{});
    if(fs.existsSync(screenshot))await info.attach('actual-browser-screen',{path:screenshot,contentType:'image/png'});
    await info.attach('actual-route-and-api-observation',{path:evidenceFile,contentType:'application/json'});
  }
}
export {expect};
