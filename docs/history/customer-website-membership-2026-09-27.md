# Customer → Website live membership — 2026-09-27

Dal: `development`. Bu kayıt RS-02e.6 kaynak diliminin sınırını belgeler; production kabulü değildir.

## Uygulanan kaynak

- `f876476b`: `auth-store.js` hosting `customer` session `websiteIds` kapsamını legacy `auth_user_websites` grant tablosundan değil, aynı customer için eşleşen `auth_customer_websites` + `auth_hosting_site_allocations(state='attached')` kayıtlarından canlı üretir.
- Hosting `reseller` bu dilimde child Website kapsamını otomatik miras almaz; legacy hosting-profili olmayan `site_manager` eski `auth_user_websites` davranışını korur.
- Ownership ve attached allocation listeleri birebir uyuşmazsa session scope boşmuş gibi davranmaz; `hosting_site_state_invalid` ile fail-closed olur.
- `91621532`: allocation projection yalnız `attached` durumda `accessGranted:true` döndürür. `available` / `reserved` erişim değildir.
- `b6e973f4`: hosted site create sonucu hard-coded `accessGranted:false` yerine doğrulanmış allocation sonucunu taşır. `provisioningReady:false` korunur; Website membership host provisioning kabulü olarak sunulmaz.
- Mevcut hosting-account create/edit sonucu `siteAccessGranted:false` kalır: yalnız customer login/profil oluşturmak site erişimi vermez; erişim ancak ayrı verified Website ownership attach sonrasında doğar.

## Kaynak testleri

- `ad1b0f1f`: customer login ve `getSessionById` attached ownership'i görür; reseller child siteyi bu dilimde görmez; legacy site_manager grant davranışı korunur; ownership kaldırılınca aynı session'ın canlı scope'u düşer; orphan ownership fail-closed test edilir.
- `c4eeb4db`: allocation completion artık customer membership verdiğini bekler, fakat legacy `auth_user_websites` satırı üretmediğini doğrulamaya devam eder.
- `88dbb5ef`: hosted create sonucu attached ownership için `accessGranted:true`, `provisioningReady:false` bekler.

## Açık kalan sınırlar

- Bu ortamda repository checkout / hedef Node24/npm11 çalıştırması yapılmadı; GitHub DNS erişimi yoktu. Yeni testler **yazıldı fakat çalıştırılmadı**.
- Reseller direct-child Website kapsamı / **Sitelerim** bu dilimde açılmadı.
- Website/list/job/log/backup/AI/tool/gateway/WebSocket yollarının tamamında tenant izolasyonu ayrı ayrı gerçek auth ile kabul edilmedi.
- Veri içeren legacy ownership migration/rollback, gerçek browser/host, session revoke sırasında açık gateway/WS bağlantıları ve iki-process/crash/write-failure kabulleri açık kalır.
