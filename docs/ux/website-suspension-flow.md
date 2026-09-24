# SUSPEND-UI — Website askıya alma / yeniden açma

2026-09-25 · development · başlangıç `e748f25a610506535ddf45c0e627574c630bd856`.
UX-PL-06/07 ve Website lifecycle alt dilimi. Mevcut Website/Domain suspension journal ve host compensation motoru yeniden kullanılır.

## Tamamlanan kaynak

- [x] **SUSPEND-UI-01 panel API sözleşmesi:** `482fb0e6`; Website suspension GET ve mutation cevapları mevcut legacy alanları korurken `panelRequest` için `data` zarfı da taşır. GET `no-store`.
- [x] **SUSPEND-UI-02 site akışı:** `861ed2f9`; Site → Barındırma ayarları → **Site erişimi**. Güncel Website preview, bağlı domain sayısı, blocker ve son operation durumu gösterilir. Kullanıcı birincil domain adını yazarak askıya alma/yeniden açmayı açıkça onaylar.
- [x] **SUSPEND-UI-02 durable lifecycle:** yeni host motoru yazılmadı. Mevcut preview digest + Website revision + kalıcı Website suspension registry + Domain suspension child operations kullanılır. `partial/failed` askıya alma aynı operation confirmation ile retry; `suspended` aynı journal üzerinden resume; `resume_partial/resume_failed` explicit resume retry.
- [x] **SUSPEND-UI-02 unknown result:** POST cevabı kaybolursa istemci aynı mutation'ı otomatik tekrarlamaz; Website suspension GET yeniden okunur ve belirsizlik kullanıcıya gösterilir.
- [ ] **SUSPEND-UI-03 seçili test/kabul:** panel contract/model/wiring testleri yazıldı fakat bu oturumda tam checkout/test çalıştırılmadı. Node24/npm11 tam regresyon, gerçek Owner/Site A/Site B, Nginx host state ve restart/partial recovery kabulü açık.

## Kapsam

Askıya alma bu Website'e bağlı domainlerin web yayınını devre dışı bırakır. Bu akış posta kutularını, veritabanlarını veya site dosyalarını silmez. Website silme lifecycle'ı ayrı BUG-20260923-02 işidir.

Site hesabı yalnız kendi Website URL'si üzerinden suspension rotalarına ulaşır; site-resource-boundary her Website isteğinde güncel site grantini doğrular. Owner ve yetkili site hesabı mevcut backend politikasına göre reversible suspend/resume kullanır. Reseller/customer sahiplik modeli tamamlandı varsayılmaz.

## T-DEV-SUSPEND-UI

- [ ] Node >=24.11.1/npm >=11 tam checkout: yeni `website-suspension-panel-contract.test.js`, `website-suspension-model.test.js`, `website-suspension-wiring.test.js` ve mevcut Domain/Website suspension runtime/registry/HTTP regresyonları; tam lint/test/build.
- [ ] Owner/Site A/Site B: Site A yalnız kendi Website suspension preview/operations; doğrudan Site B API 403. Grant/session iptali mutation öncesi ve refresh sırasında doğrulansın.
- [ ] Birden fazla domain/subdomain/alias: hepsi suspend; bir child başarısızsa partial görünür ve retry yalnız eksik child'larda ilerler. Başka site/domain etkilenmemeli.
- [ ] Kayıp start/retry/resume cevabı, API restartı, process restartı ve yarım Nginx/control-plane durumlarında kör replay olmamalı; mevcut journal/inspection/compensation davranışı doğrulansın.
- [ ] Browser 320/390/834/1440 px, %200 zoom, klavye, typed confirmation, refresh/back/forward ve site değişimi. Files/cron/PHP/backup/analytics/SSL regresyonları.
- [ ] Yalnız izinli test hostu; `.44` kullanılmaz.
