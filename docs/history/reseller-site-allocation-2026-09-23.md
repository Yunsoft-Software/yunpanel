# RS-02d — Website sahipliği ve adet kontenjanı

2026-09-23; `development`, başlangıç `3b81245f`. Mevcut site/Unix kimlikleri ve site oluşturma motoru korunur. Yeni reseller rolü, HTTP/UI veya production kabulü açılmaz.

- [x] RS-02d.1 kaynak (`5b2afce3`): aynı auth DB içinde sürümlü site kontenjanı yan şeması; immutable işlem/Website/müşteri bağı, customer FK, tekrar kurulum ve boş rollback. Altı yeni SQLite şema testi geçti.
- [x] RS-02d.2 kaynak: `hostingAccounts.siteAllocations`; atomik site kapasitesi/rezervasyon/sahiplik kaydı, tam tekrar, audit rollback, oturum iptali. 39 depo testi ve iki bağımsız SQLite bağlantısıyla 2 yarış testi geçti. Şema ile bu aşamanın toplamı **47 geçti / 0 başarısız**, Node22.16.0.
- [ ] RS-02d.3 kaynak: mevcut site-create preview/create ve güncel Website okumasıyla iç servis köprüsü; müşteri/plan bağlı onay.
- [ ] HTTP/UI, reseller login, bütün API/job/tool/gateway/WS hedeflerinde canlı kapsam, güvenli reservation release/silme ve gerçek host/browser kabulü.

Kontenjan kaydı ikinci bir provisioning/job motoru değildir. `reserved` kapasite tüketir; `attached` sahiplik kaydının eklendiğini belirtir, çalışan host veya erişim izni değildir. İki durum da `accessGranted: false` döndürür. Auth rol/grant tetikleyicileri değişmedi. Bekleyen kayıt varsa bayi sayımında `usageScope: registered_and_reserved_ownership`; aksi halde eski `registered_ownership`. Site sağlığı veya disk kullanımı değildir.

Başarısız işlem veya timeout sonrasında rezervasyon otomatik silinmez: site kısmen oluşmuş olabilir. Temizlik ve yürütücünün artık aynı hedefe yazamayacağı doğrulanmadan kontenjan serbest bırakılmaz. Limit azaltma mevcut rezervasyonu silmez; aynı niyetin devamı yeni kontenjan tüketmez. Farklı işlem/müşteri/site/server/plan aynı kaydı devralamaz. Parola/token saklanmaz; yalnız kimlikler ve plan/Website özetleri tutulur.

Bu aşamanın komutu: `node --test apps/api/test/hosting-site-allocation*.test.js` — **47 geçti / 0 başarısız**. SQLite ve worker bağlantıları gerçek; auth/MFA/Website adaptörleri kontrollü test girdisidir. Tam checkout, native Argon2/Node24, `npm run check`, React, gerçek host veya tarayıcı testi değildir. GitHub Actions, main değişikliği ve canlı deployment yapılmadı.
