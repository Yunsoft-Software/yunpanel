# RS-04a — Owner profil yönetimi, mevcut Kullanıcılar ekranında

2026-09-23; `development`, başlangıç `cca9745b`. Önce `062c3151` ile önceki API raporunun yolu ve kaydedilmiş HTTP kabulü düzeltildi. Owner yönetimi RS-02e'nin reseller/site runtime erişimini açmadan ilerleyen ayrı kaynak dilimidir.

## Kaynakta tamamlananlar

- [x] **RS-03a doküman uzlaştırma:** Gerçek kök `/api/users/hosting/accounts`; bağlantı `user-admin-http.js` üzerinden. Önceki tur 83 HTTP/handler testi raporlandı; bu tur yeniden çalıştırılmış sayılmaz.
- [x] **RS-04a.1 — `058433a4`:** Genel kullanıcı formu yalnız değişen alanları PATCH eder. Profilli hesabın ismini değiştirirken değişmeyen rol/active/site grant alanları yeniden gönderilmez. Gerçek rol/site değişimi backend'e gider ve mevcut koruma tarafından reddedilebilir; backend koruması değiştirilmedi. 15 yeni test + 12 mevcut istemci testi geçti. Eski bir testin beklediği PATCH payload'ı yeni delta sözleşmesine uyarlandı.
- [x] **RS-04a.2 — `ecd39609`:** `hosting-account-client.js`: açık null/0/boş limit ayrımı, mevcut login kimliği/revizyonuna profil bağlama, gerçek API yolu, filtre ve sayfalama, sonuç kimliği/kind/parent/limit doğrulama, dar alan listesi. İsteklerin eski oturuma ait sonuçlarını ve geç yanıtları reddeder. Belirsiz mutation otomatik tekrar edilmez; aynı kayıt açıkça tekrar okunmadan istemci yeni yazmayı engeller. 49 yeni istemci/model testi geçti.
- [x] **RS-04a.3 — `c7eed21e`:** Mevcut Owner korumalı `/settings/users` sayfasında Bayiler/Müşteriler listesi, kullanıcı satırında Bayi / müşteri düğmesi ve ortak profil penceresi. Uygun mevcut boş site_manager hesabına profil bağlama, doğrudan Owner veya sayfalanmış listeden bayi seçme, bayi limitlerini düzenleme, kullanıcı adıyla açık onay sonrası boş profili kaldırma. PanelKit/Modal/Button/Section, mevcut session-client ve unsaved-change mekanizmaları kullanılır. 6 kaynak bağlantı testi geçti; React render kabulü değildir.
- [ ] **RS-04a gerçek kabul:** hedef Node24/npm11, React/Vite build, gerçek HTTP/backend ile tarayıcı görevleri, erişilebilirlik ve responsive kabulü.

## Kullanım yolu ve sınırlar

Ayarlar → Kullanıcılar. Üst liste giriş hesaplarını yönetir; yalnız site_manager satırında profil düğmesi vardır. Alt bölüm bayi ve müşteri profillerini 25'lik sayfalarla listeler. Yeni giriş hesabı gerektiğinde mevcut Kullanıcı ekle formu kullanılır; profil penceresi parola tutmaz veya ikinci kullanıcı yaratmaz. Eski site üyelikleri otomatik sahipliğe çevrilmez. Mevcut profilli hesapta yalnız desteklenen limit/kaldırma işlemleri sunulur; tür/parent/activation/transfer alanları düzenlenmez.

API 404 vermesi tek başına profilsiz kullanıcı demek değildir. Yalnız `hosting_account_not_found` sonucu profil bağlama akışını açabilir; eksik endpoint, sunucu veya ağ hatası hata olarak kalır. Profil kaldırma yanıtında `loginDeleted:false` ve `accessGranted:false` doğrulanır. Kullanım sütunu kayıtlı/ayrılmış site adedidir; çalışan site veya disk ölçümü değildir. Oturum kaybında ortak oturum akışı kullanılır; eski bir isteğin cevabı yeni oturumu kapatmaz. Başarılı işlem sonrası kullanıcı/profil listeleri yeniden okunur.

Bu kod Owner için profil hazırlığını arayüze bağlar. **Reseller/customer self-service, site oluşturma HTTP/job runtime, ortak kaynak kilidi, güvenli kontenjan release, hesap askısı ve bütün araçlarda tenant kapsamı RS-02e/RS-03–05 altında açık kalır.** Yeni reseller login rolü, site yetkisi, paket/abonelik motoru, tema veya Files değişikliği yoktur. Profilin kayıtlı olması site erişim yetkisi değildir.

## Bu tur çalıştırılan kontroller

```sh
node --test apps/web/test/user-admin-client.test.js apps/web/test/user-admin-patch.test.js apps/web/test/hosting-account-client.test.js apps/web/test/hosting-accounts-wiring.test.js
```

**82 geçti / 0 başarısız / 0 atlandı; Node v22.16.0, npm 10.9.2.** Dağılım: 12 mevcut istemci, 15 PATCH, 49 profil istemcisi ve 6 kaynak bağlantısı. Yeni/değişen JS kaynak ve testlerinde `node --check` geçti. İki JSX dosyası ortamda kurulu sözdizimi ayrıştırıcısıyla ayrıca kontrol edildi; projeye TypeScript veya dependency eklenmedi. Bu ayrıştırma React render, Vite build veya kullanıcı görevi testi değildir.

Seçili dosyalar connector'dan alındı; mevcut dosyaların başlangıç blob'ları doğrulandı. Tam Git checkout denemesi GitHub DNS erişimi olmadığından başarısızdı. `npm ci`, tam lint/test/build, önceki backend testleri, native Argon2/MFA, gerçek tarayıcı ve host testleri bu tur çalıştırılmadı. Önceki 83/65/97/107 sonuçları 82'ye eklenmez.

GitHub Actions, main değişikliği ve canlı deployment yok. Gerçek kabul `docs/ux/development-todo.md` T-DEV-OWNER-PROFILES içindedir. Source-only kutular production-ready veya reseller özelliğinin tamamlandığı anlamına gelmez.
