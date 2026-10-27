import { defineConfig } from '@playwright/test';
import { AUTH_PATH,RUN_DIR,ORIGIN,auditNetworkOptions } from './e2e/live-audit/runtime.js';
export default defineConfig({
  testDir:'./e2e/live-audit',globalSetup:'./e2e/live-audit/setup.js',timeout:45000,workers:1,retries:0,
  expect:{timeout:5000},outputDir:RUN_DIR+'/'+(process.env.YUNPANEL_AUDIT_LANE||'read')+'-artifacts',
  reporter:[['line'],['json',{outputFile:RUN_DIR+'/'+(process.env.YUNPANEL_AUDIT_LANE||'read')+'-results.json'}],['html',{outputFolder:RUN_DIR+'/'+(process.env.YUNPANEL_AUDIT_LANE||'read')+'-report',open:'never'}]],
  use:{baseURL:ORIGIN,storageState:AUTH_PATH,ignoreHTTPSErrors:false,headless:true,trace:'off',video:'off',screenshot:'off',actionTimeout:10000,navigationTimeout:20000,...auditNetworkOptions()},
  projects:[
    // Playwright's own Chromium, not the installed Google Chrome (see playwright.config.js).
    {name:'chrome-desktop',use:{browserName:'chromium',viewport:{width:1440,height:1000}}},
    {name:'firefox-desktop',use:{browserName:'firefox',viewport:{width:1440,height:1000}},testIgnore:/mutation/},
  ],
});
