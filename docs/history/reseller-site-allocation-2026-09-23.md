# RS-02d — Website sahipliği ve adet kontenjanı

2026-09-23; `development`, başlangıç `3b81245f`. Mevcut site/Unix kimlikleri ve site oluşturma motoru korunur. Bu dilim yeni reseller rolünü, HTTP/UI erişimini veya production kabulünü açmaz.

- [x] RS-02d.1 kaynak: aynı auth DB içinde sürümlü site kontenjanı yan şeması; immutable işlem/Website/müşteri bağı, customer FK, tekrar kurulum ve boş rollback. Altı yeni SQLite şema testi Node22.16.0 altında geçti.
- [ ] RS-02d.2 kaynak: atomik site kapasitesi/rezervasyon/sahiplik kaydı, tam tekrar ve hata/oturum iptali.
- [ ] RS-02d.3 kaynak: mevcut site-create preview/create ve gerçek Website okumasıyla iç servis köprüsü; müşteri/plan bağlı onay.
- [ ] HTTP/UI, reseller login, bütün API/job/tool/gateway/WS hedeflerinde canlı kapsam, güvenli reservation release/silme ve gerçek host/browser kabulü.

Kontenjan kaydı ikinci bir provisioning/job motoru değildir. Başarısız işlem veya timeout sonrasında rezervasyon otomatik silinmez: site kısmen oluşmuş olabilir. Temizlik ve yürütücünün artık aynı hedefe yazamayacağı doğrulanmadan kontenjan serbest bırakılmaz. Kullanıcıdan gelen rol, usage, limit veya Website snapshot yetki/kanıt sayılmaz.

Bu şema diliminin komutu: `node --test apps/api/test/hosting-site-allocation-schema.test.js` — **6 geçti / 0 başarısız**. Tam checkout, native Argon2/Node24, `npm run check`, React, gerçek host veya tarayıcı testi değildir. GitHub Actions, main değişikliği ve canlı deployment yapılmadı.
