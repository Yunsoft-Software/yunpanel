# RS-02d — Website sahipliği ve adet kontenjanı

2026-09-23; `development`, başlangıç `3b81245f`. Mevcut site/Unix kimlikleri ve site oluşturma motoru korunur. Bu çalışma yeni reseller rolü, HTTP/UI veya production kabulü açmaz.

## Tamamlanan kaynak alt işleri

- [x] **RS-02d.1 / `5b2afce3`:** Aynı auth DB içinde sürümlü site kontenjanı yan şeması; immutable işlem/Website/müşteri bağı, customer FK, tekrar kurulum ve boş rollback. 6 yeni SQLite şema testi.
- [x] **RS-02d.2 / `99473414`:** `hostingAccounts.siteAllocations`; atomik site kapasitesi/rezervasyon/sahiplik kaydı, tam tekrar, audit rollback, oturum iptali. 39 depo testi ve iki bağımsız SQLite bağlantısıyla 2 yarış testi.
- [x] **RS-02d.3 kaynak:** `hosting-site-create-service.js` ve `hosting-site-create-runtime.js`; mevcut `site-create-isolation-guard` preview/create motoruna iç servis bileşimi. Müşteri/plan bağlı onay, input snapshot, await sonrasında yeniden yetki kontrolü, Website registry'den bağımsız sonuç doğrulama ve aynı servis örneğinde tekrarları sıraya alma. 18 servis/kaynak-bağlantı testi. Runtime factory dosyası syntax/kaynak olarak doğrulandı; gerçek engine/host entegrasyonu bu ortamda çalıştırılmadı.
- [ ] **RS-02d kalan / RS-02e:** HTTP/job runtime bağlantısı; bütün API/job/AI/tool/gateway/WS hedeflerinde canlı müşteri/bayi kapsamı; güvenli silme/compensation sonrası reservation release; global kaynak kilidi ve veri içeren migration/rollback; RS-03–05 API/UI/native auth/host/browser kabulü.

## Çalıştırılan test

`node --test apps/api/test/hosting-site-*.test.js`: **65 geçti / 0 başarısız / 0 atlandı**, **Node v22.16.0 / npm 10.9.2**. Yeni kaynak ve test dosyaları `node --check` ile geçti. Son site kontenjanına bağımsız iki SQLite writer ve aynı işlemin iki başvurusu test edildi; yarış dosyası ayrıca 5 kez çalıştırıldı, tamamı geçti. Tekrar koşuları 65'e ek farklı test olarak sayılmaz.

SQLite, dosya tabanlı yeniden açılış ve Worker bağlantıları gerçek; kullanıcı/MFA/session/Website/create adaptörleri kontrollü fixture'dır. Önceki 97/107 test sonuçları bu toplamın içinde değildir. Tam checkout ve bağımlılıklar alınamadı (bu ortamın GitHub DNS erişimi yok); connector'dan alınan seçili kaynaklarla çalışıldı. Tam eski test paketi, native Argon2/Node24, `npm run check`, gerçek site engine/React, host ve tarayıcı testi yapılmadı.

## Davranış ve sınırlar

`reserved` kapasite tüketir. `attached`, yalnızca planla eşleşen Website snapshot'ı doğrulanıp sahiplik kaydının eklendiğini belirtir; çalışan host veya erişim izni değildir. İki durum da `accessGranted: false` döndürür; köprü ayrıca `provisioningReady: false` döndürür. Auth rol/grant korumaları değişmedi. Bekleyen kayıt varsa bayi sayımında `usageScope: registered_and_reserved_ownership`; aksi halde eski `registered_ownership`. Sayım site sağlığı/disk tüketimi değil, kayıtlı sahiplik ve ayrılmış kontenjandır.

Kota kontrolü, rezervasyon ve audit aynı auth `BEGIN IMMEDIATE` transaction'ındadır. Site registry/host işiyle auth DB arasında dağıtık transaction yoktur; await/crash sırasında kalıcı kontenjan tutulur. Başarısız işlem veya timeout rezervasyonu otomatik silmez: site kısmen oluşmuş olabilir. Temizlik ve yürütücünün artık aynı hedefe yazamayacağı doğrulanmadan kontenjan serbest bırakılmaz. Limit azaltma mevcut rezervasyonu silmez; aynı niyetin devamı yeni kontenjan tüketmez. Farklı işlem/müşteri/site/server/plan aynı kaydı devralamaz. Reservation yeni job/provisioning motoru değildir.

Köprü `customerId` ve planı aynı onaya bağlar. Önceki müşteri onayı başka müşteri için kullanılamaz. Mevcut Website veya eski `site_manager` grant'i otomatik sahiplenilmez. Hesap zaten login taşıdığı için bu yolda `siteAdmin` ile ikinci hesap açılmaz. İşlem tamamlanma cevabı yerine Website registry tekrar okunur; kimlik/server/revizyon/runtime/Unix/document-root bağı planla karşılaştırılır. Doğrulama bitince oturum tekrar kontrol edilir. Sahiplik kaydı sonradan silinirse/kayarsa yeni sayım/devam işlemi fail-closed olur; eksik kayıt sıfır sayılmaz.

Servis içindeki Map yalnız aynı örneğin eşzamanlı tekrarlarını sıralar; farklı API/CLI/provisioning/removal yazıcılarını kilitlemez. Aynı Website'a yazan bütün mevcut yolların kaynak kilidi ve yeniden yetkilendirme bağlantısı tamamlanmadan HTTP/reseller erişimi açılmaz. Registry snapshot'ının sonradan değişmemesi veya canlı kaynağın çalışması bu tur kanıtlanmış değildir; `attached` yetkilendirme kaynağı olarak tek başına kullanılamaz. Güvenli release/silme API'si yoktur; kayıtlar doğrudan SQL silinerek temizlenmez.

Yerel test edilen kaynak/test blob'ları commit oluştururken SHA ile eşlendi. GitHub Actions, main değişikliği, Files/UI değişikliği ve canlı deployment yapılmadı. Gerçek kabul `docs/ux/development-todo.md` T-DEV-RESELLER içinde açık kalır.
