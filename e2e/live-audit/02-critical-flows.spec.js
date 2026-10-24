import { test,expect,ready,main,manifest } from './support.js';
const site=(tab)=>'/websites/'+manifest().existingPhpDomainId+'/'+tab;
test('DB create opens one complete site/user/password form',async({page})=>{
 await ready(page,'/databases');await main(page).getByRole('button',{name:'Veritabanı oluştur',exact:true}).click();
 const dialog=page.getByRole('dialog');await expect(dialog).toBeVisible();
 await expect.soft(dialog.getByLabel(/Veritabanı adı/)).toBeVisible();
 await expect.soft(dialog.getByRole('combobox',{name:/Site|Web sitesi/i}),'Creating a DB must allow choosing its actual Website').toBeVisible();
 await expect.soft(dialog.getByLabel(/Kullanıcı|User/i),'A database user is part of the creation task').toBeVisible();
 await expect.soft(dialog.getByLabel(/Parola|Password/i),'The user must be able to configure a usable credential').toBeVisible();
 await expect.soft(dialog).not.toContainText(/Kaynaklar bölümünden yönetilir/);
});
test('DB bind opens an actual selection and apply action instead of a redirect',async({page})=>{
 await ready(page,'/databases');const buttons=main(page).getByRole('button',{name:'Siteye bağla',exact:true});await expect(buttons.first(),'Real unbound data must be available').toBeVisible();await buttons.first().click();
 const dialog=page.getByRole('dialog');await expect(dialog).toBeVisible();
 await expect.soft(dialog.getByRole('combobox',{name:/Site|Web sitesi/i})).toBeVisible();
 await expect.soft(dialog.getByRole('button',{name:/Bağla|Uygula/i})).toBeVisible();
 await expect.soft(dialog).not.toContainText(/İlgili sitenin Kaynaklar bölümünü açıp/);
});
test('Site DB empty state can create or bind a DB without leaving context',async({page})=>{
 await ready(page,site('databases'));
 await expect(main(page).getByRole('heading',{name:'Veritabanları',exact:true})).toBeVisible();
 await expect.soft(main(page).getByRole('button',{name:/Veritabanı ekle|Veritabanı oluştur|Mevcut veritabanını bağla|Siteye bağla/i}).first()).toBeVisible();
});
test('DB connection info is a real operation available from the DB inventory',async({page})=>{
 await ready(page,'/databases');await expect(main(page).getByRole('table')).toBeVisible();
 await expect(main(page).getByRole('button',{name:/Bağlantı bilgileri/i}).first()).toBeVisible();
});
test('A PHP site exposes a single PHP entry with one canonical destination',async({page})=>{
 await ready(page,site('overview'));
 const entries=main(page).getByRole('link',{name:'PHP / WordPress',exact:true});
 await expect(entries,'Two labels pointing to /node and /php confuse the same user task').toHaveCount(1);
});
test('PHP settings expose a real version/handler form',async({page})=>{
 await ready(page,site('php'));
 await expect.soft(main(page).getByRole('combobox',{name:/PHP sürümü|PHP version|Handler/i}).first()).toBeVisible();
 await expect.soft(main(page).getByRole('button',{name:/Ayarları kaydet|Uygula/i}).first()).toBeVisible();
});
for(const [id,name] of [['install',/WordPress (kur|yükle)|Kurulumu başlat/i],['remove',/WordPress.*(kaldır|sil)/i],['password',/WordPress.*(parola|şifre)|Yönetici parolasını değiştir/i],['login',/WordPress.*(giriş|admin)|Yöneticiye giriş/i],['plugin',/Eklenti (ekle|yükle|kur)/i],['theme',/Tema (ekle|yükle|kur)/i],['update',/WordPress.*güncelle|Güncellemeleri uygula/i],['clone',/Klonla|Staging oluştur/i]])test('WP required '+id+' action exists and is usable',async({page})=>{
 await ready(page,site('php'));const action=main(page).getByRole('button',{name}).or(main(page).getByRole('link',{name})).first();await expect(action,'Actual Plesk-equivalent '+id+' action must exist').toBeVisible();await expect(action).toBeEnabled();
});
test('Hosting settings contain document root and one physical apply action',async({page})=>{
 await ready(page,site('settings'));
 await expect.soft(main(page).getByLabel(/Document root|Belge kökü|Kök dizin/i)).toBeVisible();
 await expect.soft(main(page).getByLabel(/Index|Dizin indeksi/i)).toBeVisible();
 await expect.soft(main(page)).not.toContainText(/Kaydetmek tek başına yayın/);
});
test('Hosting task screen does not repeat every destination in two navigation layers',async({page})=>{
 await ready(page,site('hosting'));const data=await main(page).locator('a').evaluateAll(list=>list.map(e=>({href:e.getAttribute('href'),text:e.innerText})));
 const repeated=data.filter((v,i)=>v.href.includes('/websites/')&&data.findIndex(x=>x.href===v.href)<i);
 expect(repeated,'Same task destinations are duplicated in the toolbar and link-only body').toEqual([]);
});
test('Site resource consumption uses the management gateway and loads real metrics',async({page})=>{
 await ready(page,site('resources'));
 expect.soft(page.auditTraffic.filter(r=>r.path.includes('/consumption')&&r.status===404),'Site metrics must use the allowed /api/panel proxy').toEqual([]);
 await expect.soft(main(page)).not.toContainText(/Site tüketim verisi alınamadı/);
});
for(const path of ['ssl','cron','backup','logs','php','access'])test('GLOBAL '+path+' offers actual bound sites after reload',async({page})=>{
 await ready(page,'/'+path);await page.reload();await expect(main(page).locator('h1')).toBeVisible();
 await expect.soft(main(page)).not.toContainText(/Site listesi okunamıyor|Site bilgileri okunamıyor|kullanılamıyor|Veri yüklenemedi/i);
 const link=main(page).getByRole('link').filter({hasText:manifest().existingPhpDomain}).first();await expect(link,'A real site selection must be actionable').toBeVisible();
});
test('SSL shows a real validity interval and manual renewal control',async({page})=>{
 await ready(page,site('ssl'));await expect(main(page).getByRole('heading',{name:'SSL sertifikası',exact:true})).toBeVisible();
 await expect(main(page).getByRole('button',{name:'Sertifikayı yenile',exact:true})).toBeEnabled();
 await expect(main(page)).toContainText(/Bitiş/);await expect(main(page)).toContainText(/\d+ gün/);
});
test('SSL manual renewal asks for user intent rather than a technical digest',async({page})=>{
 await ready(page,site('ssl'));await main(page).getByRole('button',{name:'Sertifikayı yenile',exact:true}).click();
 const dialog=page.getByRole('dialog');await expect(dialog).toBeVisible();
 const text=await dialog.innerText();expect(text,'Normal renewal should not expose certificate UUID/digest confirmation syntax').not.toMatch(/renew:[0-9a-f-]+|[a-f0-9]{64}|certificate\.renew/);
});
test('Site cron is an editable task list, not another navigation-only screen',async({page})=>{
 await ready(page,site('cron'));await expect(main(page).getByRole('button',{name:/Görev ekle|Yeni görev/i}).first()).toBeVisible();
});
test('Files exposes the actual manager and an upload/create operation',async({page})=>{
 await ready(page,site('files'));await expect(main(page).getByRole('button',{name:/Yükle|Yeni dosya|Dosya oluştur/i}).first()).toBeVisible();
});
