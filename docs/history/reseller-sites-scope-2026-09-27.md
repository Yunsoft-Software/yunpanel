# Reseller Sitelerim + live Website scope — 2026-09-27

Dal: `development`. Bu kayıt Customer→Website üyeliği, direct-child reseller Website scope'u ve canlı site terminal sınırının kaynak durumunu belgeler. Production/browser/host kabulü değildir.

## Customer membership

- `f876476b`: hosting `customer` session `websiteIds` kapsamı legacy grant tablosundan değil, aynı customer için birebir eşleşen `auth_customer_websites` + `auth_hosting_site_allocations(state='attached')` kayıtlarından canlı üretilir.
- Ownership/allocation eşleşmezse erişim sessizce boşaltılmaz; `hosting_site_state_invalid` ile fail-closed olur.
- `91621532` / `b6e973f4`: yalnız attached allocation `accessGranted:true` olur; site-create sonucu bu doğrulanmış durumu taşır. `provisioningReady:false` korunur.
- `ad1b0f1f`, `c4eeb4db`, `88dbb5ef`: customer scope, legacy site_manager grant davranışı, removal ve attached erişim sözleşmesi için kaynak testleri yazıldı.

## Reseller direct-child Sitelerim

- `f19495e2`: hosting `reseller` session scope yalnız `auth_hosting_accounts.kind='customer' AND reseller_id=<current reseller>` olan direct-child customer'ların attached Website ownership'lerinden canlı türetilir.
- Başka reseller müşterisinin ve doğrudan Owner müşterisinin Website'i kapsama alınmaz. Ownership/allocation drift burada da fail-closed olur.
- `b221e9ac`: reseller `/websites` menü etiketi **Sitelerim** oldu; sıradan site-manager/customer menü dili değiştirilmedi.
- `ed324f06`, `16a5093f`, `709c42c2`: direct-child görünürlük, foreign reseller/direct Owner izolasyonu, canlı ownership removal ve UI navigation kaynak testleri yazıldı.

## Site terminal WebSocket

Kaynak auditinde terminal capability HTTP yüzeyinin `site_manager` için site-scope capability ürettiği, fakat production WebSocket'in Owner-only live authenticator kullandığı bulundu. Bu nedenle site terminali API tarafından izinli görünmesine rağmen upgrade aşamasında çalışmıyordu.

- `08b63566`: live terminal browser authenticator Owner + site_manager yönetim session'larını kabul eder. Owner yolu hâlâ MFA/management policy'den geçer; Read Only/self-service açılmaz.
- `f78b9372`: WebSocket capability tüketildikten sonra target yeniden doğrulanır. Server/root target Owner-only kalır; site target Owner veya güncel `websiteIds` içinde hedefi bulunan site_manager olmalıdır. Aynı kontrol touch ve periyodik reauthorization sırasında tekrar edilir.
- `e917d1b9`, `d4f15725`: live site-manager auth ve hedef grant kaybı policy kaynak testleri eklendi.

## Route audit notları

- Normal HTTP request'leri her istekte auth store'dan session'ı yeniden okur; Customer/Reseller Website kapsamı request snapshot'ına client'tan alınmaz.
- `site-resource-boundary` Website/Domain/Application/DB/Mail/Job ailelerinde `site_manager` kapsamını `websiteIds` üzerinden sınırlar. Files, Cron, PHP araçları, SFTP key, cache, suspension, analytics ve backup'ın site-scoped yolları `/api/websites/:websiteId/...` üzerinden bu boundary'ye düşer.
- AI conversation history mevcut Website grant'lerini kullanır. AI tool policy site_manager için owner-management gereksinimi nedeniyle tool execution'ı açmaz; bu tur AI yetkisi genişletilmedi.
- phpMyAdmin handoff issuance Website scope'u doğrulasa da vendor gateway session binding tamamlanmadığı için `phpmyadmin_site_session_binding_required` koruması **bilerek kaldırılmadı**. YP-04 açık kalır.
- elFinder handoff issuance current Website grant'i kontrol eder ve capability canlı session registry'ye bağlıdır. Hosting Website removal finalizasyonu customer ve parent reseller session/live-session kayıtlarını revoke eder.
- PowerDNS Website/Domain yolları domain scope boundary'sine, server identity/delegation yolları server-global deny sınırına düşer. Bu kaynak audit gerçek HTTP/browser/host kabulü değildir.

## Açık kalan kabul

- Bu ortamda GitHub checkout/Node24/npm11 çalıştırması yapılamadı; testler **yazıldı, çalıştırılmadı**.
- Owner + iki reseller + her reseller iki customer + direct Owner customer ile gerçek HTTP/browser tenant matrisi.
- Açık terminal/elFinder/gateway bağlantısında ownership removal, customer/reseller suspend ve logout sonrası gerçek socket kapanışı.
- phpMyAdmin için panel session + current Website assignment'a bağlı vendor SQL session/gateway tasarımı ve gerçek kabul.
- Long-running/durable job ailelerinde mutation başlamadan hemen önce canlı tenant reauthorization; gerçek iki-process/restart/write-failure.
- Veri içeren ownership migration/rollback ve Node24/native Argon2/full suite.
