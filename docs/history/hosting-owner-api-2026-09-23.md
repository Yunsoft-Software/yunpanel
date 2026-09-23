# RS-03a — Owner için sade hesap API'si

2026-09-23; `development`, kaynak commitleri `fc4672df` ve `cca9745b`.

## Güncel bağlantı ve kapsam

Kök yol **`/api/users/hosting/accounts`**. Mevcut `user-admin-http.js` üzerinden 4 ek satırla bağlandı; `auth-http.js` değiştirilmedi. İlk handler dilimindeki `/api/hosting-accounts` henüz yayımlanmamış taslak yoldu; güncel istemci onu kullanmaz. `/api/panel/users/hosting/accounts` mevcut uyumluluk katmanından aynı korumalarla geçer.

RS-02e'nin ortak site kilidi, bütün hedeflerde tenant yetkisi ve güvenli kontenjan temizliği açıktır. Owner profil yönetimi bunlardan bağımsız ilerler. Profil bağlamak yeni login, çalışan bayi paneli veya site erişimi oluşturmaz.

## API sözleşmesi

| İstek | Davranış |
| --- | --- |
| `GET /api/users/hosting/accounts` | `kind=reseller|customer`, `resellerId=<id>` veya müşteriler için `direct=true`, `limit=1..100`, `offset>=0`. Tekrarlı, bilinmeyen ve çelişen filtreler reddedilir. |
| `POST /api/users/hosting/accounts` | Mevcut, site üyeliği olmayan site_manager hesabına profil bağlar. Bayi: `{kind:'reseller',userId,expectedUserRevision,limits:{maxCustomers,maxWebsites}}`. Müşteri: `{kind:'customer',userId,expectedUserRevision,resellerId}`. Doğrudan müşteri için `resellerId:null`. |
| `GET /api/users/hosting/accounts/:id` | Güncel profil, revizyon ve desteklenen kayıtlı kullanım. `stage:profile_only` korunur. |
| `PATCH /api/users/hosting/accounts/:id/limits` | `{revision,limits}`. İki açık adet sınırı; `null` sınırsız, `0` yeni kayıt yok. |
| `DELETE /api/users/hosting/accounts/:id/profile` | `{revision,confirmation:'unregister-hosting-profile:<id>:<revision>'}`. Yalnız boş profili kaldırır. Bağlı müşteri/site/rezervasyon 409; login ve siteler silinmez (`loginDeleted:false`). |

Girdi rolü/actor/usage yetki kaynağı değildir. Mutation önce cookie, Origin, CSRF ve Owner/MFA katmanından geçer; depo işlem içinde güncel Owner yetkisini tekrar kontrol eder. Bilinmeyen alt yollar başka router'a düşmez. Site allocation/create/release, transfer, suspend ve login-as bu API'de yoktur. Profil değişimi hedef oturumlarını iptal eder; işlemi yapan Owner'ın cookie'sini silmez.

## Kaydedilen kaynak kabulü

- [x] **RS-03a.1:** `fc4672df`, handler ve query sözleşmesi; 51 test.
- [x] **RS-03a.2:** `cca9745b`, mevcut kullanıcı router'ı bağlantısı ve 32 yerel HTTP/SQLite testi.
- [x] Önceki çalışma turunda `node --test apps/api/test/hosting-account-http*.test.js`: **83 geçti / 0 başarısız / 0 atlandı**, Node22.16.0. Bu doküman düzeltmesinde yeniden çalıştırıldığı iddia edilmez.
- [ ] Owner arayüzü: mevcut kullanıcı satırından profil yönetimi, açık limitler ve müşteri için bayi seçimi; yeni login veya site yetkisi varmış gibi sunma.
- [ ] RS-02e, reseller/customer self-service ve RS-03–05 üst kabulleri.
- [ ] Node>=24.11.1/npm>=11 tam check, native login/MFA, gerçek tarayıcı ve izinli host kabulü.

HTTP testleri gerçek loopback Node HTTP sunucusu, mevcut cookie/Origin/CSRF sınırı, Owner/MFA policy, kullanıcı router'ı ve hosting SQLite deposunu çalıştırır. Oturum ve MFA enrollment fixture'dır; native Argon2/setup/login veya ikinci faktör challenge kabulü değildir. İlgisiz webhook/gateway/genel-audit adapter'ları test importunda taklittir; hosting transaction/audit deposu gerçektir. Loader import sonrasında hook'u kaldırır.

GitHub Actions, main değişikliği ve host deployment yapılmadı. Kaynak kabulü production-ready anlamına gelmez. Güncel alt iş ve kalan kabuller `docs/ux/plesk-full-scope.md`, `plan.md` ve `docs/ux/development-todo.md` ile birlikte izlenir.
