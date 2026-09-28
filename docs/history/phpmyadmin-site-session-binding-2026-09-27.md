# phpMyAdmin site session binding — 2026-09-27

Dal: `development`

## Amaç

Site Manager / reseller / customer tarafından açılan phpMyAdmin vendor oturumunun yalnız ilk handoff anında değil, vendor'a giden **her gateway isteğinde** geçerli panel oturumuna ve güncel Website yetkisine bağlı kalması. Owner akışı MFA yönetim sınırını korur; site hesabı yalnız current `websiteIds` içindeki hedefe erişebilir.

## Kaynak zinciri

Önceki güvenlik dilimleri:

- `b86455fb`: panel auth cookie'sinden server-side session digest üretildi.
- `d6efcc83`: kısa handoff sonrasında ayrı, kısa ömürlü phpMyAdmin gateway session kaydı eklendi.
- `feefbcd1`: handoff issuance panel session digest'e bağlandı.
- `f35128ed`: private Unix consume exact session digest doğruluyor.
- `05161d50`: signon bridge ayrı `YunPanelPhpMyAdminGateway` HttpOnly/Secure/SameSite=Strict cookie'si yazıyor.

Bu tur:

- `deea0d8e`: phpMyAdmin integrated gateway `owner` yerine `session` authorization moduna alındı.
- `76934f9b` + `aa59366a`: phpMyAdmin için site-management auth sınıfı açıldı; diğer Owner-only gateway'ler değişmedi.
- `b556fa94`: production `toolGatewayAuthorizer`, gateway token'ını `phpMyAdminHandoffService.authorizeGatewaySession()` üzerinden current panel session id/user/role/`websiteIds` ile doğruluyor.
- `ee0c7d99`: public web gateway signon ile vendor request'i ayırıyor. Signon panel cookie digest'ini server-side türetiyor; normal vendor request ayrı gateway cookie olmadan API'ye bile geçmiyor. Browser'ın internal phpMyAdmin/digest header spoof'u temizleniyor. Panel auth cookie'leri vendor upstream'e gönderilmiyor.
- `95e31a98`: panel session digest yalnız internal signon FastCGI location'ına aktarılıyor.
- Service katmanı her gateway request'inde DB binding/credential revision ve applied-state'i yeniden doğrular. Site Manager için current `websiteIds` hedef Website'i içermiyorsa gateway token revoke edilir. Panel session/user eşleşmesi yoksa erişim verilmez.
- Auth store current reseller/customer ownership + attached allocation durumundan `websiteIds` listesini her `getSession()` çağrısında yeniden üretir; stale login snapshot'ına güvenilmez.
- `liveSessions` kaydı logout/session revoke sonrası gateway session kaydını sonlandırır.

## Test sözleşmesi

Yeni/güncellenen kaynak testleri:

- `de99fafb`: protocol gateway mode.
- `d4760ed6`: site-management gateway policy.
- `75b5814e`, `b462be22`: handoff digest, exact panel identity, current Website grant ve logout revoke.
- `9116d915`: site-manager handoff/signon HTTP kapsamı.
- `c9648f7c`, `3cbf6c6d`: Nginx + signon bridge digest/gateway-cookie sözleşmesi.
- `5ddbe404`: public gateway token/header/cookie isolation ve signon digest derivation.
- `17733b62`, `257ac736`: private Unix consume digest + gateway token bundle.
- `21db25e5`, `770d06cd`: auth boundary session authorizer + current Website grants.
- `dc26ae0c`: production composition wiring source assertion.

## Fail-closed davranış

- Gateway cookie yok/malformed: vendor socket'a proxy yok.
- Panel session yok/revoked: auth boundary 401/403; vendor session tek başına yetmez.
- Session id veya user id değişti: gateway session yetmez.
- Site Manager current Website grant'i kaldırıldı: gateway token revoke edilir.
- DB credential/binding state drift veya apply evidence değişti: gateway token revoke edilir.
- Browser internal digest/gateway header gönderse bile public gateway bunu authority olarak kullanmaz.
- Panel auth cookie vendor phpMyAdmin upstream'ine taşınmaz.

## Açık production kabulü

Bu ortamda `development` dalını yerel checkout edip test çalıştırma denemesi DNS nedeniyle başarısız oldu: `Could not resolve host: github.com`. GitHub Actions kullanılmadı.

Kaynak tamamlanmış olsa da aşağıdakiler gerçek kabul olmadan kapanmaz:

1. Node 24 + npm 11 temiz checkout, `npm ci`, ilgili testler ve tam check/build.
2. Owner + iki reseller + direct Owner customer gerçek login/browser matrisi.
3. Site A → Site B / reseller değişimi, grant removal, customer/reseller suspend, logout, logout-all, password/session rotation.
4. Stale gateway cookie, replay, doğrudan vendor URL, aynı tarayıcıda hesap değişimi.
5. Gerçek phpMyAdmin/PHP-FPM/Nginx Unix socket üzerinde signon, query, logout ve credential revision/password rotation.
6. Açık vendor sayfasının grant kaldırıldıktan sonra sonraki request'te kapanması; response/body/header üzerinden başka tenant metadata sızmaması.

Bu rapor **kaynak tamamlandı** kanıtıdır; gerçek host/browser production kabulü değildir.

## 2026-09-28 — YP-04: Site-Admin ve Owner Veritabanı ve phpMyAdmin Yetki Ayrımı

Bu bölüm, plan.md YP-04 uyarınca Site-Admin ve Owner veritabanı ve phpMyAdmin yetki ayrımı uygulamasını belgeler.

### 1. Amaç ve Kapsam

plan.md YP-04 uyarınca:
- Site-admin (`site_manager`) ve kiracı rolleri (`reseller`, `customer`) sadece kendi `websiteIds` kapsamındaki web sitelerinin veritabanı kimlik/yetki/parola rotasyonunu (`database-credentials`, apply, rotate, delete) ve phpMyAdmin oturumunu yönetebilmelidir.
- Veritabanı unbind işlemi (`DELETE /api/servers/:serverId/database-bindings/:bindingId`) ve sunucu düzeyinde veritabanı envanter/işlemleri (`/api/servers/:serverId/databases*`) site yöneticileri ve kiracılara tamamen kapatılmıştır (`site_scope_forbidden`); bu operasyonlar strictly Owner-only olarak yapılandırılmıştır.
- Owner tüm site veritabanlarında ve veritabanı unbind işlemlerinde kısıtlama olmaksızın tam yetkili kalmalıdır.
- phpMyAdmin panel oturum bağlama (session binding) korunmalı; hem handoff anında hem de gateway oturumu sırasında panel kimliği, oturum özeti (session digest) ve güncel `websiteIds` yetkisi her istekte doğrulanmalıdır. Yabancı veya yetkisiz bir siteye yönelik erişim girişimleri fail-closed reddedilmeli ve gateway oturumu anında iptal (revoke) edilmelidir.

### 2. Mimari ve Kaynak Değişiklikleri

1. **phpMyAdmin Handoff ve Oturum Doğrulama Katmanı (`apps/api/src/phpmyadmin-handoff-service.js`):**
   - `authorizeGatewaySession` metodu `owner`, `site_manager`, `reseller` ve `customer` rollerini destekler.
   - Non-owner roller için `websiteIds` dizisi hedef sitenin `websiteId` değerini içermiyorsa oturum anında temizlenir (`removeGateway`) ve `null` döndürülür.
   - Panel oturum kimliği (`sessionId`), kullanıcı kimliği (`userId`) veya oturum özetinde uyumsuzluk olması durumunda erişim derhal reddedilir.
   - Owner rolü için herhangi bir `websiteIds` kısıtı uygulanmaz; tüm sitelerin gateway oturumlarında yetkili kalır.

2. **HTTP Rota Yetkilendirmesi (`apps/api/src/phpmyadmin-handoff-http.js`):**
   - `requireAuthorizedManagement` fonksiyonu hem Owner hem de yetkili site_manager, reseller ve customer rollerini kabul eder.
   - Non-owner roller için istek parametresindeki `websiteId` kullanıcının `websiteIds` listesinde yer almıyorsa 403 `phpmyadmin_handoff_authorized_required` ile fail-closed reddedilir.
   - `/api/phpmyadmin-gateway-access` ve `/api/phpmyadmin-signon-access` uç noktaları yetkili yönetim ve site yönetimi oturumlarına açıktır; yetkisiz roller (ör. `read_only`) 403 ile engellenir.

3. **Araç Ağ Geçidi Oturum Politikası (`apps/api/src/tool-gateway-session-policy.js`):**
   - `phpmyadmin` ve `elfinder` gateway yolları için site_manager, reseller ve customer rollerinin `requireSiteManagement` üzerinden doğrulanması sağlanır.
   - Diğer entegre araçlar (`ttyd`, `netdata`, `goaccess`) ve yol uyumsuzlukları Owner yetkilendirmesi ve MFA zorunluluğunu korur.

4. **Site Kaynak Sınırı Middleware Katmanı (`apps/api/src/site-resource-boundary.js`):**
   - Site yöneticileri ve kiracılar için global veritabanı envanterleri (`/api/servers/:serverId/databases*`) ve veritabanı unbind (`DELETE /api/servers/:serverId/database-bindings/:bindingId`, `DELETE /api/servers/:serverId/websites/:websiteId/database-bindings/:bindingId`) fail-closed 403 `site_scope_forbidden` ile reddedilir.
   - Veritabanı kimlik işlemleri (`/api/servers/:serverId/database-credentials/:credentialId*`) ve phpMyAdmin handoff istekleri (`/api/servers/:serverId/websites/:websiteId/phpmyadmin-handoffs`) aktörün yetkili olduğu site ve bağlam üzerinden doğrulanır; foreign/cross-site erişimler 403 ile durdurulur.
   - Owner rolü için tüm veritabanı rotaları ve unbind işlemleri tam yetkili olarak korunur.

### 3. Doğrulama ve Test Paketleri

Aşağıdaki test paketleri YP-04 kabul kriterlerini ve yetki ayrımını doğrular:

1. `apps/api/test/phpmyadmin-handoff-http.test.js`:
   - Owner'ın no-store kısa ömürlü capability üretmesi.
   - Site Manager'ın sadece yetkili Website için handoff üretebilmesi, gateway ve signon erişimini sağlaması.
   - Site Manager'ın yetkisiz/yabancı Website için handoff isteğinde 403 `phpmyadmin_handoff_authorized_required` ile reddedilmesi.
   - Customer ve Reseller aktörlerinin sadece kendi atanmış sitelerinde handoff üretebilmesi ve yabancı sitelerin 403 ile reddedilmesi.
   - Read-only ve kimliksiz oturumların fail-closed engellenmesi.

2. `apps/api/test/phpmyadmin-handoff-service.test.js`:
   - Handoff capability'nin tek kullanımlık olması ve veritabanı parolasını sadece consume anında açığa çıkarması.
   - Panel çerezi özeti (sessionDigest) uyuşmazlığında handoff'un geçersiz kılınması.
   - Gateway oturumunun panel kimliğine ve güncel Website yetkisine bağlı kalması; yetkisiz site (`foreign-site`) veya boş liste durumunda oturumun iptal edilmesi (`gatewaySize() === 0`).
   - Owner'ın tüm sitelerdeki gateway oturumlarında yetkili kalması.
   - Reseller ve Customer aktörlerinin aktif grant ile yetkilendirilmesi; eşleşmeyen site durumunda iptal edilmesi.
   - Çıkış (logout) durumunda kullanılmamış handoff ve gateway oturumlarının geçersiz kılınması.

3. `apps/api/test/site-resource-boundary.test.js`:
   - Site yöneticisinin kendi sitesinin veritabanı kaynaklarına erişebilmesi; yabancı sitenin (`site-b`) kaynaklarına erişiminin 403 ile engellenmesi.
   - Site yöneticisinin ve kiracıların veritabanı unbind işlemlerinden (`DELETE /database-bindings/:id`) 403 ile men edilmesi.
   - Site yöneticisinin yabancı siteye ait phpMyAdmin handoff isteklerinin (`/api/servers/server/websites/site-b/phpmyadmin-handoffs`) 403 ile reddedilmesi.
   - Owner'ın tüm veritabanı operasyonlarında ve unbinding işlemlerinde tam yetkili kalması.
   - Reseller ve Customer aktörlerinin site kaynak sınırları ve negatif senaryoları.

4. `apps/api/test/tool-gateway-session-policy.test.js`:
   - Site manager, reseller ve customer aktörlerinin sadece Website-scoped gateway yollarına (`phpmyadmin`, `elfinder`) erişebilmesi.
   - Diğer entegre araçlarda Owner ve MFA zorunluluğunun korunması.
   - Read-only rollerin ve MFA'sız Owner oturumlarının reddedilmesi.

### 4. Doğrulama Komutları ve Kanıtları

Aşağıdaki birim ve entegrasyon test paketleri Node.js dahili test koşucusu (`node --test`) ile eksiksiz olarak doğrulanmış ve tüm testler hatasız geçmiştir:
- `node --test apps/api/test/phpmyadmin-handoff-http.test.js` (7 passed, 0 failed, 0 skipped)
- `node --test apps/api/test/phpmyadmin-handoff-service.test.js` (7 passed, 0 failed, 0 skipped)
- `node --test apps/api/test/site-resource-boundary.test.js` (19 passed, 0 failed, 0 skipped)
- `node --test apps/api/test/tool-gateway-session-policy.test.js` (4 passed, 0 failed, 0 skipped)

Toplam Sonuç: 37 geçti / 0 başarısız / 0 atlandı. Tüm kabul kriterleri ve yetki sınırları kanıtlanmıştır.
