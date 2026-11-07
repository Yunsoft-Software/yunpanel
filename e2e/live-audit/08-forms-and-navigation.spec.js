import {test,expect,ready,main,manifest} from './support.js';
const forms=[
 ['/databases',/Veritabanı oluştur/i,/Veritabanı adı/],
 ['/mail',/Mail alan adı ekle|Posta alan adı ekle/i,/Alan adı/],
 ['/docker',/Compose.*(projesi|stack).*ekle/i,/Proje adı/],
 ['/settings/users',/Kullanıcı ekle/i,/Kullanıcı adı/],
];
for(const [route,action,field] of forms)test('FORM '+route+' opens fields and exits without a server mutation',async({page})=>{
 await ready(page,route);await main(page).getByRole('button',{name:action}).first().click();const dialog=page.getByRole('dialog');await expect(dialog).toBeVisible();await expect((route==='/mail'?dialog.getByRole('combobox',{name:field}):dialog.getByLabel(field)).first()).toBeVisible();await page.keyboard.press('Escape');await expect(dialog).toBeHidden();expect(page.auditTraffic.filter(v=>v.status==='blocked-by-read-only-test')).toEqual([]);
});
test('A new empty PHP website hides irrelevant Node and Git fields',async({page})=>{
 await ready(page,'/websites/new');
 await main(page).getByLabel('Alan adı',{exact:true}).fill('audit-test.example.com');
 await main(page).getByRole('button',{name:/Devam et/i}).click();
 await main(page).getByRole('combobox',{name:/Site türü/i}).selectOption('new_php');
 await expect(main(page).getByLabel(/Repository|GitHub repository|Node.js başlangıç/).first()).toBeHidden();
});
test('An empty static website can be created without mandatory Git and npm build fields',async({page})=>{
 await ready(page,'/websites/new');
 await main(page).getByLabel('Alan adı',{exact:true}).fill('audit-static.example.com');
 await main(page).getByRole('button',{name:/Devam et/i}).click();
 await main(page).getByRole('combobox',{name:/Site türü/i}).selectOption('new_static_upload');
 const repo=main(page).getByLabel(/GitHub repository|Repository/i);
 await expect(repo).toHaveCount(0);
});
test('User creation offers customer and reseller as actual account purposes',async({page})=>{
 await ready(page,'/settings/users');
 const accountsPanel = main(page).getByRole('heading', { name: /Müşteri ve Bayi Hesapları|Hosting/i }).or(main(page).getByText(/Bayi \/ müşteri/i));
 await expect(accountsPanel.first()).toBeVisible();
});
test('Customers has one actual account screen instead of silently becoming Website list',async({page})=>{
 await ready(page,'/customers');await expect(main(page).locator('h1')).toContainText(/Müşteri|Customer/i);
});
test('Resellers has one actual account screen instead of silently becoming Website list',async({page})=>{
 await ready(page,'/resellers');await expect(main(page).locator('h1')).toContainText(/Bayi|Reseller/i);
});
test('Firewall controls have associated labels usable by keyboard and assistive tools',async({page})=>{
 await ready(page,'/firewall');await expect.soft(main(page).getByLabel('Port Numarası',{exact:true})).toBeVisible();await expect.soft(main(page).getByLabel('Kaynak IP / CIDR',{exact:true})).toBeVisible();
});
test('Global Files selection opens the same actual site file manager',async({page})=>{
 const m=manifest();await ready(page,'/files');const row=main(page).getByRole('row').filter({hasText:m.existingPhpDomain});const link=row.getByRole('link',{name:'Dosya Yöneticisi',exact:true});await expect(link).toBeVisible();await link.click();await expect(page).toHaveURL(new RegExp('/websites/'+m.existingPhpDomainId+'/files'));await expect(main(page)).toContainText(/Dosya|Files/i);
});
for(const section of ['mailboxes','webmail','aliases','security','configuration','operations'])test('MAIL '+section+' is a real persistent workspace with its exact tab active',async({page,liveApi})=>{
 const r=await liveApi.api.get('/api/panel/mail-domains');expect(r.status()).toBe(200);
 const mailDomains = (await r.json()).data || [];
 const domain=mailDomains.find(d=>d.domainName===manifest().existingPhpDomain) || mailDomains[0];
 test.skip(!domain, 'No configured mail domain exists on test server');
 await ready(page,'/mail/'+domain.id+'?section='+section);await expect(main(page).locator('.ws-tabs a[aria-current="page"]')).toHaveAttribute('href',new RegExp('section='+section));expect(page.auditErrors).toEqual([]);
});
test('The owned populated DB workspace obtains consumption from a real working gateway',async({page})=>{
 const m=manifest();
 test.skip(!m.fixture.binding, 'Populated DB binding only exists in mutation lane');
 await ready(page,'/websites/'+m.fixture.domainId+'/resources');const requests=page.auditTraffic.filter(v=>v.path.endsWith('/consumption'));expect(requests.length,'The actual UI must request its consumption data').toBeGreaterThan(0);expect(requests.filter(v=>v.status>=400)).toEqual([]);await expect(main(page)).not.toContainText(/tüketim verisi alınamadı/i);
});
