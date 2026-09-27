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
