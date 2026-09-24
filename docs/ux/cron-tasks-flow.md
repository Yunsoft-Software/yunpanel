# CRON-UI — Site içinden zamanlanmış görevler

2026-09-25 · development · UX-PL-04/06/07/08 alt dilimi.
Başlangıç: `6e2aa1c299094b32b418c52bf415dc54b319987c`. Kaynak dilimi: `f070578c` → `fa0accf2`.

## İnceleme ve tamamlanan kaynak akışı

Mevcut `website-cron-http.js` ve `website-cron-apply-service.js` site kapsamında liste/tek kayıt/ekle/düzenle/sil API'lerini sağlar. Ekleme ve düzenleme zaten `cron.apply` işi oluşturur; ikinci bir uygulama motoru veya gereksiz ikinci POST kurulmadı. Başlangıç `6e2aa1c2` silmede `accepted` ile doğrulanmış `deleted` sonucunu ayırır. Başlangıç incelemesinde site gezinmesine bağlı cron ekranı yoktu; aşağıdaki kaynak dilimi bu mevcut API'lere bağlandı.

- [x] **CRON-UI-01 kaynak:** `f20f0c38`, `97b6e833`; Website/sunucu/uygulama/Unix kullanıcısı ve revizyon kontrolü. Ham kayıt ile reconciliation cevabındaki `id`/`taskId` farkı açıkça normalleştirilir. Eksik/yanlış hedef başka siteye düşmez; destek mevcut HTTP servisiyle aynı static/node/php kapsamındadır.
- [x] **CRON-UI-02 kaynak:** oluştur/düzenle/sil ve etkinlik tercihi; güncel kayıt GET'i ve revizyon, açık değişiklik incelemesi, silmede görev adı onayı. Aynı istemcide tek yazma, devam eden bilinen görevler için engel, belirsiz sonuçta otomatik tekrar yok. İstemci kontrolü backend ortak kilidi değildir.
- [x] **CRON-UI-03 kaynak:** aynı job kimliğiyle yalnız GET takibi. İş kabulü tamamlanma değildir; doğru hedef/revizyon ve terminal sonuç doğrulanır. Apply başarısı komutun çalıştırıldığı anlamına gelmez. Silme ancak başarılı doğru job kanıtı ve güncel listede yoklukla tamamlanır.
- [x] **CRON-UI-04 kaynak:** `3382652c`, `fa0accf2`; Site → Barındırma ve DNS → Zamanlanmış Görevler, Genel Bakış kısayolu ve `/websites/:domainId/cron` rotası. Liste/arama, hazır veya özel zamanlama, komut, etkinlik, inceleme ve onay ekranları. Mevcut Ember bileşenleri, JobDrawer, taslak ayrılma uyarısı, global ve site Files rotaları korunur. Cron için ayrı dördüncü görev grubu kurulmadı.
- [x] **CRON-UI-05 seçili kontrol:** 83 geçti / 0 başarısız / 0 atlandı; aşağıdaki aynı kaynak kontrolleri. Gerçek build/browser/API/host kabulü açık kalır.

## Kullanıcı akışı ve kanıt sınırı

Görev ekle veya Düzenle → adı/zamanlamayı/komutu/etkinlik tercihini gir → Değişikliği incele → Kaydet ve sunucuya uygula. Bu eylem mevcut tek POST/PATCH akışını kullanır. Sil… seçilen görevin adının yazılmasıyla onaylanır; yalnız listeden iyimser kaldırma yapılmaz. Önceden başlatılmış bir komutun durdurulduğu iddia edilmez.

Sunucu durumu: doğrulanmadı, cron servisi kapalı, sunucu dosyası eksik, kayıtla uyuşmuyor ve yapılandırma hazır ayrı gösterilir. `enabled` yalnız kayıt tercihidir. Hazır yapılandırma, komutun başarıyla çalıştığının veya gerçek hizmet sağlığının kanıtı değildir. Sonraki çalışma zamanı/çıktı geçmişi eklenmedi; zamanlamanın sunucunun saat diliminde olduğu açıklanır.

Geçici koleksiyon yenilemesinde önceden doğrulanmış form korunur ve yazma durur. Yeni stale envanterden istemci açılmaz; kullanıcı/oturum/site bağı değişimi eski yanıtın kullanılmasını engeller. 401/403 korunan veriyi temizler. Backend auth/CSRF/tenant denetimleri değiştirilmedi; yeni rol veya alternatif erişim motoru açılmadı. Komutlar URL veya tarayıcı kalıcı depolamasına yazılmaz.

**Bellek sınırı:** taslak ve bu ekranın işlem takibi kalıcı değildir. Tam sayfa yenileme/ayrılma sonrasında bilinmeyen işlemin otomatik yeniden bağlanması bu dilimde yoktur. Mevcut İşlem geçmişi ve job altyapısı korunur. Bilinmeyen sonuçta yeni işlem açılması ancak yeni başarılı liste okuması ve açık kullanıcı kabulünden sonradır; bu kabul önceki işi başarılı saymaz veya yeniden göndermez. Farklı sekmeler/süreçler arası atomik kilit ve canlı tenant yarışları ayrıca doğrulanmalıdır.

## Çalıştırılan kontroller — yalnız bu kaynak dilimi

Node **22.16.0**, npm **10.9.2**; hedef Node24/npm11 yerine geçmez.

```sh
node --test apps/web/test/cron-task-client.test.js apps/web/test/cron-task-access.test.js apps/web/test/cron-task-wiring.test.js
```

**83 geçti / 0 başarısız / 0 atlandı:** 54 istemci davranışı + 17 kapsam çözümleme + 12 gezinme/bağlantı kontrolü. Son 12'nin 4'ü saf rota/model davranışı, 8'i kaynak bağlantısı kontrolüdür; React render testi değildir. Kayıp cevap, yanlış task/job/proof, stale revizyon, çift tıklama, başarılı silmede listede yokluk, 401/403, unmount ve oturum değişimi kapsanır. Önceki turlardaki testler bu toplama eklenmedi.

`SiteCronPanel.jsx`, `SiteDetailPage.jsx`, `ui/SiteNavigation.jsx` için üç JSX parse/dönüşüm kontrolü; beş kaynak JS modülü için `node --check` geçti. Dönüşüm ortamda bulunan TypeScript aracıyla sözdizimi kontrolüdür; uygulamanın Vite build'i veya React çalıştırması değildir. Test edilen **12 kaynak/test dosyasının Git blob'ları `fa0accf21697385773a40c72ee7fe848fee477ca` ile birebir eşleşti**; eşitleme sonrası aynı 83 test yeniden geçti.

Tam checkout/paket kurulumu, tüm depo lint/test/build, gerçek tarayıcı, gerçek HTTP/auth ve test hostu bu ortamda çalıştırılmadı. Hiçbir production hostuna veya `.44` Plesk hostuna dokunulmadı. GitHub Actions kullanılmadı; tüm commitlerde `[skip ci]` var.

## T-DEV-CRON-UI — Codex / gerçek ortam kabulü

- [ ] Node >=24.11.1/npm >=11 tam checkout: npm ci, mevcut lint/test/build ve yukarıdaki cron testleri. Üretim React bundle'ındaki hook/lifecycle davranışını ayrıca kontrol et.
- [ ] Owner ve iki site_manager ile gerçek API: yalnız atanmış Website; yabancı task/job/Domain-ID, 401/403/409/500, CSRF, oturum/Website/Unix bağı değişimi ve eşzamanlı düzenleme. Mevcut gateway/route ve backend tenant sınırlarını doğrula; istemci testini gerçek auth kanıtı sayma.
- [ ] İzinli test hostunda static/node/php sitesi: ekle, düzenle, devre dışı bırak, etkinleştir, sil; doğru cron dosyası ve site kullanıcısı. Komutun çalışması ayrıca gözlensin. `.44` Plesk hostuna hiçbir amaçla dokunma.
- [ ] Yavaş/kayıp POST/PATCH/DELETE cevabı, başarısız/iptal/yanlış job, süreç restartı, farklı sekmeler, metadata gecikmesi ve son GET ile mutation arasındaki yarış. Aynı job yalnız GET ile takip edilsin; yanlış hedef veya yarım cleanup başarı sayılmasın.
- [ ] Chromium/Firefox üretim bundle'ı: 320/390/834/1440 px, yüzde 200 zoom, klavye/modal focus, uzun komut, kaydedilmemiş taslak, reload/back/forward, site değişimi, hata/yenileme ve eski Files rotaları. Ekrandan ayrıldıktan sonra bilinmeyen iş/taslak için kalıcı devam gerekiyorsa ayrı kaynak dilimi olarak geliştir; kör POST tekrarı yapma.

Üst UX-PL-06, BUG-02, RS-02e ve production kapıları bu alt dilimle kapanmaz. Website silme/askı, reseller self-service, ayrıntılı PHP/backup/istatistik işleri ayrı kalır. Kök `plan.md` üst kabul maddeleri korunur; bu tamamlanan kaynak dilimi `ui-plan.md` ilerlemesinde bağlantılıdır.
