# ADMIN-RESULT — Site yöneticisi oluşturma sonucu

Başlangıç: `development@97413ca6`, 2026-09-24. CREATE-RESULT / PROD-06 alt dilimi; mevcut site, kullanıcı ve provisioning motorları korunur. Kapsam önce `b6597a5f` ile kaydedildi.

## Okuma düzeltmesi ve gerçek değişiklik sınırı

İlk connector okuması başka bir handler içeriği/SHA döndürdü; yazma öncesi GitHub SHA kontrolü 409 ile bunu reddetti. Yeniden okunan gerçek dosya `4f218b1a74eb80ce0cfacb197af0226b55c75bc3` zaten `mountSiteCreateRoutes`, doğru username/actorId ve await edilmiş çağrı içeriyordu. Önceki kapsam notundaki “eksik export / await / yanlış parametre” bu nedenle güncel dalın doğrulanmış hatası değildir; düzeltilen iş olarak sayılmaz. Hiçbir eski dosya bu hatalı okumayla üzerine yazılmadı.

Doğrulanan hata: hesap oluşturma hatası ham olarak console.error'a yazılıp API cevabında hesap sonucu bildirilmeden site başarısı dönüyordu. Gerçek route değişikliği yalnız yeni helper importu, mevcut hesap bloğunun dar helper'a taşınması ve cevaba siteAdmin eklenmesidir: 5 satır ekleme / 12 silme. Rota/engine/export yeniden yazılmadı.

## Tamamlanan kaynak

- [x] **ADMIN-RESULT-01 — `4c16030d`:** `site-admin-provisioning.js` mevcut async createSiteManager çağrısını aynı username/password/websiteId/actorId sözleşmesiyle bekler. Sonuçtaki kullanıcı kimliği, normalize kullanıcı adı, site_manager rolü, aktiflik ve yalnız beklenen Website bağı doğrulanmadan created dönmez. Eksik depo/actor, geçersiz girdi, hesap çakışması ve beklenmeyen hata dar attention koduyla bildirilir. Ham hata, parola, hash veya kullanıcı nesnesi sonuçta/logda yayımlanmaz.
- [x] **ADMIN-RESULT-02 — `4ecac47e`:** mevcut `/api/sites` cevabında `{ data: { ...result, siteAdmin, provisioning } }`; site kaydı ile hesap sonucu ayrıdır. Hesap hatası tek başına oluşmuş site kaydını kaybettiren genel 500'e çevrilmez. Mevcut panel yetki kapısı, local-server kontrolü, exact-body/digest/onay, asenkron engine/planner ve 201/200 sözleşmesi korunur.
- [x] **ADMIN-RESULT-03 — `20119534`, `55192541`, `975837d1`:** istemci yalnız istenen hesaba ve beklenen Website'e ait dar sonucu kabul eder. Eksik/eski/bozuk/yanlış-site cevabı hesap başarısı değildir. Sonuç kartında hesap ayrı durum ve mevcut `/settings/users` bağlantısıyla görünür; Genel Bakış ve Dosyalar girişleri korunur. Host planı ready, stopped veya hata olsa da hesap uyarısı silinmez. `phase: ready` yalnız provisioning planını anlatır; hesap başarısına dönüştürülmez.
- [x] **ADMIN-RESULT-04 — `7333a1c6`, `34c588cc`, `633f17a9`:** son seçili koşu **39 geçti / 0 başarısız / 0 atlandı**. 22 backend helper, 15 frontend model/controller davranışı, 1 gerçek route modülü + açık engine/middleware fixture testi ve 1 JSX kaynak bağlantısı kontrolü. Önceki test sayıları buna eklenmedi.

## Çalıştırılan doğrulama

Node **22.16.0**, npm **10.9.2**:

```sh
node --test apps/api/test/site-admin-provisioning.test.js apps/api/test/site-create-mount-contract.test.js apps/web/test/site-admin-result.test.js
```

Dört kaynak JS dosyası node --check ile geçti. `SiteCreateResult.jsx` hazır TypeScript parser/dönüştürücüsüyle yalnız JSX sözdizimi/dönüşüm kontrolünden geçti; çıkan JavaScript de node --check ile doğrulandı. Repoya TypeScript kaynak, paket veya lockfile değişikliği eklenmedi.

Rota testi Node'un yerleşik module mock özelliğini yalnız alt test sürecinde `--experimental-test-module-mocks` ile açar; gerçek route modülü ve yeni helper çalışır, engine/planner/guard/user store/registry açık fixture'lardır. Yerel kısmi çalışma ağacında mocklanan dört import için yalnız çözümleme placeholder'ları kullanıldı; bunlar repoya eklenmedi ve gerçek bağımlılık testi sayılmadı. Express listener, gerçek auth/CSRF, Argon2, SQLite veya host çalıştırılmadı. İlk rota denemesi eksik yerel import yollarında başarısız oldu; çözümleme fixture'ları hazırlanıp son 39'luk grup yeniden çalıştırıldı.

Sekiz test edilen kaynak/test dosyasının yerel Git blob SHA'sı `633f17a9` içeriğiyle birebir eşleşti:

| Dosya | Blob SHA |
| --- | --- |
| API site-admin-provisioning.js | 859f7c4f85e868aa5372b041c099b5fbb92c7bc7 |
| API site-create-http.js | afeab272fb40184cd4742a50b35c9210f249ddbc |
| API site-admin-provisioning.test.js | 19893fbca4d590d1959953f6d7e89c40905eb596 |
| API site-create-mount-contract.test.js | 55cd3e9986caa9eb81aad08662074f616c2b5705 |
| Web site-admin-result.js | 1e36a508569db3c1042832f169699e8688bb3382 |
| Web site-create-submission.js | 6fa6ea45db858605222e102e5bc4f3548303471c |
| Web SiteCreateResult.jsx | e08023f3df0f46b684c998d2da07470c0171a32b |
| Web site-admin-result.test.js | dd23e75943fdd10df4ecb1f2ec0748e63d7af278 |

## Bilerek açık kalanlar

Replay veya yarım oluşturma devamında hesap otomatik yeniden oluşturulmaz; mevcut kullanıcıya sessizce Website eklenmez, parola değiştirilmez. `site_admin_replay_requires_review` kesin başarısızlık değildir: hesap önceden oluşmuş olabilir ve mevcut Owner kullanıcı yönetiminden kontrol edilmelidir. Bu dilim kalıcı operation→user ilişki kaydı veya atomik create/user/provisioning transaction eklemez. Hash sürerken yetki iptali ve Website silme/iki süreç yarışı mevcut backend kilit/authorization kapısında açıktır.

Hesap sonucu yalnız create cevabı ve mevcut ekran belleğindedir; reload sonrası kalıcı yeniden uzlaştırma tamamlanmadı. Hesap adımından sonraki provisioning planı/registry kaydı ayrıca hata verirse mevcut genel hata yolu korunur; tüm partial sonuçlar bu dilimde çözülmüş sayılmaz. Shared-site akışı değiştirilmedi. Site/account kaydı girişin, dosya izolasyonunun veya canlı hizmetlerin kabulü değildir.

## T-DEV-ADMIN-RESULT — Codex gerçek kabulü (açık)

- [ ] Node24/npm11 tam checkout/npm ci/lint/test/build. Mevcut `site-create-http.test.js`, `site-create-submission.test.js`, `site-create-result-wiring.test.js` ve kullanıcı/auth regresyonlarını birlikte çalıştır. Doğrudan Git erişimi bu ortamda DNS hatasıyla başarısız oldu; tam checkout, hedef bağımlılık kurulumu ve tam build yapılmadı.
- [ ] Gerçek authStore/Argon2/SQLite ile yeni hesap beklensin; doğru username/actorId ve tek Website yetkisi doğrulansın. Yeni hesapla yalnız kendi sitesine gerçek giriş denensin.
- [ ] Hesap çakışması, hash/store/commit hatası, eksik bağımlılık ve create reply kaybında site ile hesap sonucu ayrı gösterilsin. Replay mevcut hesabın parolasını/rolünü/site bağını değiştirmesin. Kalıcı operation→user uzlaştırmasını ayrıca tamamla.
- [ ] Hash sürerken yetki iptali, Website silme, iki süreç yarışı ve hesap sonrası provisioning registry yazma hatası; atomik yetki/kilit ve bütün partial sonuç kapıları ayrıca doğrulansın.
- [ ] Gerçek React/router ile hazır kurulum + başarısız/eksik hesap, eski API cevabı, site değişimi, mevcut kullanıcı yönetimi ve sonuç bağlantıları; mobil/klavye/koyu tema. `.44` hostu kapsam dışı.

Üst CREATE-RESULT/PROD-06/production kabulü kapanmaz. Files/hosting/alias, kullanıcı deposu ve provisioning motoru, main, paket pinleri ve lockfile değişmedi. GitHub Actions ve canlı deploy yapılmadı.
