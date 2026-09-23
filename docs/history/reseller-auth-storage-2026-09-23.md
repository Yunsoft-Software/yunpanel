# RS-02 — Mevcut auth veritabanına sade hesap ilişkileri

2026-09-23; `development`, başlangıç `cdf221b7`. RS-01'in saf politikaları tekrar yazılmaz. Ayrı login deposu, paket veya abonelik motoru eklenmez.

## Dar entegrasyon sözleşmesi

Aynı auth SQLite dosyasına sürümlü yan tablolar eklenir: mevcut `users.id` ile hesap profili, tek bayi–müşteri ilişkisi, iki açık adet limiti ve ileride doğrulanmış Website sahipliği. `auth_user_websites` erişim üyeliği sahiplik diye otomatik taşınmaz. Kullanıcı/Website/Unix kimlikleri, parola, MFA ve eski site erişimleri kurulumda aynen kalır.

İlk depolama dilimi yeni reseller login rolünü veya HTTP/UI erişimini açmaz. Profil yalnız mevcut ve site üyeliği olmayan `site_manager` hesabına açıkça bağlanabilir. Owner yetkisi işlem içinde güncel oturumdan yeniden alınır. Profil bağlama/kaldırma kullanıcı revizyonunu yükseltir, oturum ve bekleyen MFA işlemlerini iptal eder; açık bağlantı iptali commit sonrasıdır. Genel kullanıcı API'si profil sahipliğini, rol/active/site grant ilişkisini değiştiremez. Güvenli parola/isim değişikliği ayrı kalır.

Müşteri kapasitesi tam veritabanı snapshot'ından hesaplanır; kontrol, ilişki kaydı ve audit aynı `BEGIN IMMEDIATE` transaction'ındadır. Pasif kayıtlar da sayılır. Website sahipliği/site provisioning bağlama API'si, tüm job/tool/gateway yolları ve Unix izolasyonu doğrulanmadan açılmaz. Yeni tablo varlığı mevcut sitelerin migrasyonunun veya gerçek site kotasının tamamlanması değildir.

## Kaynak ilerlemesi

- [x] **RS-02a — `ca40a2ae`:** `hosting-account-schema.js`: idempotent sürümlü yan şema, tek-seviye/FK/sahiplik korumaları, eksik veya gelecek şemada fail-closed; verili rollback reddi, boş rollback. `hosting-account-schema.test.js`: **21 geçti**. Fixture gerçek SQLite kullanır; auth KDF/HTTP testi değildir.
- [x] **RS-02b — `524b0627`:** `hosting-account-store.js`: Owner kontrollü mevcut login–profil bağlantısı, kalıcı filtreli liste, iki açık adet limiti, atomik müşteri kapasitesi + kayıt + audit, revizyon/oturum iptali, bağlı kaynakta profil kaldırma engeli. `hosting-account-store.test.js`: **54 geçti**. `hosting-account-concurrency.test.js`: **1 geçti**; iki Worker/bağımsız SQLite bağlantısı aynı son müşteri kontenjanına başvurur, yalnız biri kaydolur. Başarısız tarafta profil/revizyon/audit oluşmaz.
- [x] **RS-02c kaynak/fixture — `e1bd0edb`:** mevcut `createUserAdminStore` üzerinden **`authStore.users.hostingAccounts`** bağlantısı; genel kullanıcı mutation'larında profilli hesap için rol/active/site grant/silme engeli. Mevcut dosyada yalnız 5 ek satır; auth rol listesi ve oturum görünümü değiştirilmedi. Yeni `hosting-account-integration.test.js`: **5 geçti**; mevcut değiştirilmemiş `user-admin-store.test.js`: **16 geçti**.
- [ ] **RS-02 kalan:** Website state/provisioning kilidi ve sahiplik bağlantısı, bütün API/job/AI/tool/gateway/WS hedeflerinde canlı tenant kapsamı, hesap suspend/revoke, veri içeren migration/rollback, native auth/Node24 ve RS-03–05 API/UI/host kabulü.

## Çalıştırılan test ve sınırı

Ortam: **Node v22.16.0, npm 10.9.2**. Çalıştırılan komut:

```sh
node --test apps/api/test/hosting-account-*.test.js apps/api/test/user-admin-store.test.js
```

**98 test: 97 geçti / 0 başarısız / 1 atlandı.** Şema + depo + eşzamanlılık + yeni kullanıcı entegrasyonu + eski kullanıcı regresyonları dahildir. Eşzamanlılık dosyası ayrıca beş ayrı kez çalıştırıldı ve **5/5 geçti**; bunlar toplam teste ek beş farklı test değildir. Bu tur eklenen/değişen bütün JS dosyalarında `node --check` geçti.

`hosting-account-native-auth.test.js` native Argon2 mevcut olmadığından Node22'de **atlandı**. Test hedef Node>=24.11.1 ile kurulu bağımlılıklarda gerçek `createAuthStore`, setup/Argon2 login, profil bağlantısında eski oturum iptali ve sonraki giriş kapsamını sınayacak; çalıştırılmadan native auth kabulü kapatılmaz. Parola algoritması için shim/fallback eklenmedi.

Yerelde connector'dan alınan seçili kaynaklar/testler çalıştırıldı; tam checkout/bağımlılıklar kurulmadı. SQLite gerçek; fixture oturum, MFA, parola ve audit adaptörleri kontrollüdür. Bu nedenle tam auth/MFA/HTTP, `npm run check`, React/Vite, gerçek tarayıcı ve host kabulü değildir. Önceki RS-01'in 107 test sonucu ayrı tarihli rapordadır; bu koşuya eklenip sahte toplam üretilmez.

## Geçişin açık sınırları

Depo iç servis olup yalnız Owner politikasını kabul eder; HTTP rotası veya yeni reseller login rolü yoktur. Profil `stage: profile_only` döndürür. Site kullanımının `usageScope: registered_ownership` olması bilinçlidir: şema gerçek Website kayıtlarını kendiliğinden içe aktarmadı, site provisioning ve gerçek Website kotası henüz bağlanmadı. Legacy site üyeliği sahipliğe otomatik çevrilmez, Unix kimliği değiştirilmez.

Profil bağlanmış hesaba genel kullanıcı API'sinden rol/active/site grant değişimi veya silme geçiş boyunca kapalıdır; parola/isim değişimi ve profilsiz hesaplar mevcut davranışını korur. Hesap askısını veya Website erişimini açmak için bu korumalar gelişigüzel silinmez; sonraki sürümlü entegrasyonda bütün erişim yolları bağlanır. Profil kaldırmak login'i silmez; bağlı müşteri/site varsa engellenir.

Boş yan şema rollback'i yalnız yazıcılar durdurulup doğrulanmış yedek alındıktan sonra uygulanır. Veri içeren rollback sessizce tablo düşürmez; migration gerektirir. Hostta migration/deploy, GitHub Actions ve main değişikliği yapılmadı. Gerçek kabul `docs/ux/development-todo.md` T-DEV-RESELLER içinde açık kalır.
