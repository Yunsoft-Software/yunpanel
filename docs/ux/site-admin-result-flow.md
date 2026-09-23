# ADMIN-RESULT — Site yöneticisi oluşturma sonucu

Başlangıç: `development@97413ca6`, 2026-09-24. CREATE-RESULT / PROD-06 alt dilimi; mevcut site ve kullanıcı motorları korunur.

Kaynak kontrolünde `site-create-http.js` yalnız `createSiteCreateHandlers` dışa aktarırken `app.js` dosyasının `mountSiteCreateRoutes` beklediği, ayrıca bulunmayan `createSiteError` importu görüldü. Mevcut kullanıcı deposu `async createSiteManager({ username, password, websiteId, actorId })` beklerken handler `email` veriyor, await etmiyor ve hatayı ham olarak logluyor. Önceki kabul edilmiş rota sözleşmesi `1a45ded8` sürümünde; yalnız bu dosyanın ilgili bağlantısı güncel motorlara yeniden bağlanacaktır.

- [ ] ADMIN-RESULT-01: Mevcut kullanıcı deposuna doğru parametrelerle await edilmiş çağrı; başarılı hesap rolü/aktifliği/tek Website bağı doğrulansın. Beklenmeyen hata veya bozuk sonuç başarı sayılmasın, ham hata/parola loglanmasın.
- [ ] ADMIN-RESULT-02: Gerçek mount/export, panel yetki kapısı, local-server, exact-body, preview/digest/onay, async create ve `{ data }` cevap sözleşmesi korunsun. Hesap hatası oluşmuş site kaydını gizlemesin; dar `siteAdmin` sonucu ayrı dönsün.
- [ ] ADMIN-RESULT-03: Mevcut sonuç kartında hesap sonucu ayrı görünsün. Hesap istenmişken eksik/yanlış siteye ait cevap hazır sayılmasın; kurulum hazır olsa bile hesap uyarısı korunsun.
- [ ] ADMIN-RESULT-04: Yapılabilen kaynak/davranış ve rota fixture kontrolleri çalıştırılsın; gerçek auth/Argon2/SQLite/Express/host kabulü ayrı kalsın.

Replay veya yarım oluşturma devamında hesap otomatik yeniden oluşturulmaz, mevcut kullanıcıya sessizce Website eklenmez, parola değiştirilmez. Bu dilim kalıcı operation→user ilişki kaydı veya atomik create/user/provisioning transaction eklemez. Hata sonrası düzeltme mevcut Owner kullanıcı yönetiminden yapılır; yeni otomatik retry/cleanup endpoint'i yoktur.

## T-DEV-ADMIN-RESULT — Codex gerçek kabulü (açık)

- [ ] Node24/npm11 tam checkout/npm ci/lint/test/build. Gerçek `app.js` ESM importu ve mevcut `site-create-http.test.js` auth/CSRF regresyonları çalışsın.
- [ ] Gerçek authStore/Argon2/SQLite ile hesap oluşturma beklensin; username/actorId ve tek Website yetkisi doğrulansın. Yeni hesapla yalnız kendi sitesine giriş denensin.
- [ ] Hesap çakışması, hash/store/commit hatası, eksik bağımlılık ve create reply kaybında mevcut site korunsun; hesap başarısı taklit edilmesin. Replay mevcut hesabın parolasını/rolünü/site bağını değiştirmesin.
- [ ] Hash sürerken yetki iptali, Website silme ve iki süreç yarışı; atomik yetki/kilit ve kalıcı işlem→hesap uzlaştırması ayrı backend kapısıdır.
- [ ] Gerçek React/router ile hazır kurulum + başarısız/eksik hesap, eski API cevabı, site değişimi ve sonuç bağlantıları; mobil/klavye/koyu tema. `.44` hostu kapsam dışı; GitHub Actions ve canlı deploy yok.
