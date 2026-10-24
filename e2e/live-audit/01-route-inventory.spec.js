import { test,expect,ready,main,manifest } from './support.js';
const globals=[
 ['websites','Web Siteleri ve Alan Adları'],['dashboard','Sunucu'],['files','Dosyalar'],['databases','Veritabanları'],['mail','Posta'],['statistics','İstatistik'],['tools-settings','Araçlar ve Ayarlar'],['servers','Sunucu'],['firewall','Güvenlik'],['applications','Uygulama'],['domains','Alan'],['docker','Docker'],['jobs','İşlem'],['audit','Denetim'],['settings','Ayarlar'],['settings/users','Kullanıcı'],['websites/new','Web sitesi'],['applications/new','Uygulama'],['settings?section=account','Ayarlar'],['settings?section=dns','Ayarlar'],['settings?section=ai','Ayarlar'],['settings?section=updates','Ayarlar'],['ssl','SSL'],['cron','Zaman'],['backup','Yedek'],['backups','Yedek'],['logs','Günlük'],['php','PHP'],['access','Erişim'],['customers','Müşteri'],
];
for(const [route,title] of globals) test('SCREEN '+route+' renders a usable real workspace',async({page})=>{
 await ready(page,'/'+route);
 await expect.soft(main(page).locator('h1')).not.toHaveText(/^$/);
 await expect.soft(main(page)).not.toContainText(/Sayfa bulunamadı|Cannot GET|Beklenmeyen bir hata|Bu işlev henüz uygulanmadı|veri okunamıyor|yükleme başarısız/i);
 expect.soft(page.auditErrors,'The actual browser must not raise runtime exceptions').toEqual([]);
 expect.soft(page.auditTraffic.filter(r=>typeof r.status==='number'&&r.status>=500),'Actual API requests must not fail with 5xx').toEqual([]);
});
const aliases=[['file-manager','/files'],['file','/files'],['database','/databases'],['db','/databases'],['stats','/statistics'],['analytics','/statistics'],['email','/mail'],['mailboxes','/mail'],['mailbox','/mail'],['scheduled-tasks','/cron'],['tasks','/cron'],['certificates','/ssl'],['certificate','/ssl'],['servers/firewall','/firewall']];
for(const [alias,target] of aliases)test('ALIAS '+alias+' returns to one canonical screen',async({page})=>{
 await ready(page,'/'+alias);expect(new URL(page.url()).pathname).toBe(target);
 await expect(main(page)).not.toContainText(/Sayfa bulunamadı|Cannot GET/);
});
for(const runtime of ['php','node','static'])for(const tab of ['overview','hosting','settings','domains','dns','files','databases','ssl','node','deploy','logs','analytics','access','terminal','cron','backup','mail'])test('SITE '+runtime+' / '+tab+' resolves the exact real Website context',async({page})=>{
 const m=manifest();const w=m.baseline.websites.find(v=>v.runtimeType===runtime);const d=m.baseline.domains.find(v=>v.websiteId===w?.id);
 expect(w,'A real '+runtime+' Website is required').toBeDefined();expect(d,'An explicit domain binding is required').toBeDefined();
 await ready(page,'/websites/'+d.id+'/'+tab);
 await expect.soft(main(page).locator('h1')).toHaveText(d.primaryDomain);
 await expect.soft(main(page)).not.toContainText(/Web sitesi bulunamadı|Yanlış kimlik|Cannot GET|Beklenmeyen bir hata/);
 expect.soft(page.auditErrors).toEqual([]);
 expect.soft(page.auditTraffic.filter(r=>typeof r.status==='number'&&r.status>=500),'Real server requests must succeed').toEqual([]);
});
