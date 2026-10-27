# T804 İnceleme Notu — KRİTİK ROL-03: Bayi Site Tahsisinde customerLookup Bağlama Hatası ve 0 Siteli Sunucu Listesi

**İnceleyen:** AGENT_2  
**Tarih:** 2026-10-27  
**Karar:** KABUL (APPROVE)  

---

## 1. Görev Tanımı ve Problem Tespiti
- **Görev:** T804 · KRİTİK ROL-03: Bayi (Reseller) müşterisine site tahsis etme uç noktaları (`/api/panel/sites/hosted*`) `customerLookup` bağlama hatası nedeniyle 403 dönüyor ve 0 siteli bayide sunucu listesi boş geliyor.
- **Problemler:**
  1. `apps/api/src/management-app.js` satır 444'te `userAdminStore` nesnesi `allOptions` destructuring işleminde ayrıştırıldığı için, satır 499'da `options.userAdminStore` tanımsız (`undefined`) kalmaktaydı. Bu nedenle `customerLookup` değeri `createTenantBoundaryMiddleware` katmanına `null` olarak aktarılıyor ve `tenant-boundary.js:357` üzerinde bayi tarafından gönderilen tüm site tahsis istekleri 403 `tenant_boundary_forbidden` (*"Site allocation requires customer verification."*) hatasıyla reddediliyordu.
  2. `apps/api/src/site-resource-boundary.js` satır 214'te `GET /api/servers` yanıtını bayinin mevcut sitelerinin `serverId` kümesiyle filtrelediği için, henüz sitesi bulunmayan (0 siteli) bayiye boş dizi `[]` dönmekteydi. Bu durum bayinin kendi müşterisine ilk siteyi tahsis ederken yerel sunucuyu seçmesini engelliyordu.

---

## 2. Yapılan Değişiklikler ve Kod İncelemesi

### `apps/api/src/management-app.js`
- `hostingAccounts` ataması `allOptions.hostingAccountStore ?? userAdminStore?.hostingAccounts ?? options.hostingAccountStore ?? null;` olarak güncellendi.
- `customerLookup` parametresi `allOptions.customerLookup` kontrolü yapılarak doğrudan middleware katmanına bağlandı; böylece `createTenantBoundaryMiddleware` içinde bayi müşteri doğrulamasının (`assertCustomerBelongsToReseller`) hatasız çalışması sağlandı.

### `apps/api/src/site-resource-boundary.js`
- `GET /api/servers` filtreleme mantığı bayi rolü (`actorTenant.isReseller`) gözetilerek güncellendi.
- Bayi için `localServerId` varsa `ids` kümesine eklendi; bayinin henüz hiç sitesi olmasa dahi (`ids.size === 0`) yerel sunucunun filtrelenmeden güvenli/sanitize edilmiş metadata ile dönmesi sağlandı. Diğer taraftan sitesi olmayan son müşterilerin (`customer`) boş sunucu listesi alması kuralı korundu.

### Test Kapsamı
- `apps/api/test/tenant-boundary.test.js`: `management-app correctly binds customerLookup from userAdminStore and options without leaving options.userAdminStore undefined` birim testi ile `customerLookup` fonksiyonunun `userAdminStore` üzerinden başarıyla bağlandığı doğrulandı.
- `apps/api/test/site-resource-boundary.test.js`: `0-site reseller can list local servers for site allocation while customer without sites gets empty list` testi ile 0 siteli bayinin yerel sunucuyu listeleyebildiği ve müşteri izolasyonunun korunduğu doğrulandı.

---

## 3. Doğrulama ve Test Sonuçları
- **Birim ve Entegrasyon Testleri:**
  - `node --test apps/api/test/site-resource-boundary.test.js`: 23 test geçti (0 fail).
  - `node --test apps/api/test/tenant-boundary.test.js`: 31 test geçti (0 fail).
  - `node --test apps/web/test/workspace-resources.test.js`: 12 test geçti (0 fail).
- **Orkestra Bütünlük Kontrolleri:**
  - `python3 orkestra/orchestrator.py verify --quick`: `doğrulama: ok; yeniden açılan: -; bulgu: -`
- **Görev Tahtası Lint:**
  - `python3 orkestra/tasks.py lint`: 131 tasks, lint OK.

---

## 4. Karar
T804 görevinin tüm gereksinimleri, güvenlik sınırları ve kabul kriterleri eksiksiz karşılanmıştır.
Görev onaylanmıştır (ACCEPT).
