# RS-02 — Mevcut auth veritabanına sade hesap ilişkileri

2026-09-23; `development`, başlangıç `cdf221b7`. RS-01'in saf politikaları tekrar yazılmaz. Ayrı login deposu, paket veya abonelik motoru eklenmez.

## Dar entegrasyon sözleşmesi

Aynı auth SQLite dosyasına sürümlü yan tablolar eklenir: mevcut `users.id` ile hesap profili, tek bayi–müşteri ilişkisi, iki açık adet limiti ve ileride doğrulanmış Website sahipliği. `auth_user_websites` erişim üyeliği sahiplik diye otomatik taşınmaz. Kullanıcı/Website/Unix kimlikleri, parola, MFA ve eski site erişimleri kurulumda aynen kalır.

İlk depolama dilimi yeni reseller login rolünü veya HTTP/UI erişimini açmaz. Profil yalnız mevcut ve site üyeliği olmayan `site_manager` hesabına açıkça bağlanabilir. Owner yetkisi işlem içinde güncel oturumdan yeniden alınır. Profil bağlama/kaldırma kullanıcı revizyonunu yükseltir, oturum ve bekleyen MFA işlemlerini iptal eder; açık bağlantı iptali commit sonrasıdır. Genel kullanıcı API'si profil sahipliğini, rol/active/site grant ilişkisini değiştiremez. Güvenli parola/isim değişikliği ayrı kalır.

Müşteri kapasitesi tam veritabanı snapshot'ından hesaplanır; kontrol, ilişki kaydı ve audit aynı `BEGIN IMMEDIATE` transaction'ındadır. Pasif kayıtlar da sayılır. Website sahipliği/site provisioning bağlama API'si, tüm job/tool/gateway yolları ve Unix izolasyonu doğrulanmadan açılmaz. Yeni tablo varlığı mevcut sitelerin migrasyonunun veya gerçek site kotasının tamamlanması değildir.

## Kaynak ilerlemesi

- [x] **RS-02a:** `hosting-account-schema.js`: idempotent sürümlü yan şema, tek-seviye/FK/sahiplik korumaları, eksik veya gelecek şemada fail-closed; verili rollback reddi, boş rollback. `hosting-account-schema.test.js`: Node22.16.0 altında **21 geçti / 0 başarısız**. Fixture gerçek SQLite kullanır; auth KDF/HTTP testi değildir.
- [ ] **RS-02b:** Owner kontrollü kalıcı profil deposu, atomik müşteri kotası, audit/revizyon ve iptal; bağımsız iki bağlantı yarışı.
- [ ] **RS-02c:** Auth store ve eski kullanıcı yönetimi entegrasyonu; gerçek auth regresyonları.
- [ ] **RS-02 kalan:** Website state/provisioning kilidi ve sahiplik bağlantısı, canlı tenant kapsamı, suspend/revoke, veri içeren migration/rollback, RS-03–05 API/UI/host kabulü.

Boş yan şema rollback'i yalnız yazıcılar durdurulup doğrulanmış yedek alındıktan sonra uygulanır. Veri içeren rollback sessizce tablo düşürmez; migration gerektirir. Kaynak testleri Node24/npm11 tam check veya canlı host/browser kanıtı değildir. Actions, main değişimi ve deploy yapılmaz.
