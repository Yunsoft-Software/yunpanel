# RS-03a — Owner için sade hesap API'si

2026-09-23; `development`, başlangıç `fbe2e591`.

## Dilim ve uygulama sırası

RS-02e'nin site yazıcıları/ortak kilit/tenant erişimi açık kalır. Onları tamamlanmış varsayarak site create veya reseller login açmak yerine, mevcut Owner kontrollü hesap deposu HTTP'ye bağlanır. Bu sınırlı RS-03a işi RS-02e'den bağımsızdır; yeni rol, site yetkisi, paket/abonelik motoru veya otomatik migration eklemez.

## API sözleşmesi

Kök yol `/api/hosting-accounts`; mevcut `/api/panel/` uyumluluk yolu aynı authentication katmanından geçer.

- `GET /api/hosting-accounts`: `kind=reseller|customer`, `resellerId=<id>` veya müşteri için `direct=true`, `limit=1..100`, `offset>=0`. Tekrarlı/bilinmeyen/çelişkili filtreler reddedilir. `null`/`none` metni geçerli kimlik olarak korunur, doğrudan müşteri anlamına gelmez.
- `POST /api/hosting-accounts`: mevcut boş site_manager login'ine profil bağlar. Bayi için `{kind:'reseller', userId, expectedUserRevision, limits:{maxCustomers,maxWebsites}}`; müşteri için `{kind:'customer', userId, expectedUserRevision, resellerId}`. `resellerId:null` doğrudan müşteri. Yeni login/parola yaratma işlemi değildir.
- `GET /api/hosting-accounts/:id`: güncel profil/limit/kayıtlı kullanım. `stage:profile_only` korunur; bayinin çalışan site paneli olduğu iddia edilmez.
- `PATCH /api/hosting-accounts/:id/limits`: `{revision, limits}`; yalnız Owner, limitler explicit/null/0 anlamını korur.
- `DELETE /api/hosting-accounts/:id/profile`: `{revision, confirmation:'unregister-hosting-profile:<id>:<revision>'}`. Yalnız boş profili kaldırır; bağlı müşteri/site/rezervasyon varsa mevcut depo 409 döndürür. Login, parola ve siteler silinmez (`loginDeleted:false`).

Her mutation mevcut cookie + Origin + CSRF + Owner/MFA korumasının ardından çalışır; depo güncel oturumu transaction içinde yeniden doğrular. Query/body actor veya rolü yetki değildir. Yeni yol `siteAllocations`, create/release, transfer, suspend veya login-as metotlarını dışarı açmaz. Kök namespace altındaki bilinmeyen yollar başka router'a düşmez. Kayıt/kaldırma hedefin oturumlarını iptal eder; Owner'ın tarayıcı cookie'sini silmez.

## Kaynak doğrulaması

- [x] Handler/query sözleşmesi ve 51 bağımlılıksız test: Node22.16.0, 51 geçti / 0 başarısız. Bunlar kontrollü depo/policy adaptörleriyle handler testidir; gerçek cookie/CSRF/SQLite/native login kanıtı değildir.
- [ ] Auth HTTP bağlantısı ve gerçek SQLite/HTTP sınır testleri.
- [ ] Owner UI bağlantısı; site yazıcıları/RS-02e ve bayi/müşteri self-service erişimi.
- [ ] Node>=24.11.1/npm>=11 tam check, gerçek browser/host kabulü.

GitHub Actions, main değişikliği ve host deployment yok. Kaynak tamamlanması production-ready anlamına gelmez.
