# G2 — Raporu olup tekrar koşulabilir testi olmayan özellikler (28-10-2026)

T101–T124 raporları `YONTEM.md`'den önce yazıldı; kendi `e2e/ozellik` testleri yok. Her görev o özelliğin gerçek panelde tekrar koşulabilir testini yazar.

Ortak kurallar (hepsi için): yalnız bu koşunun benzersiz önekiyle (`t<id>-a<N>-<zaman>`) kaynak oluştur; `afterAll` yalnız kendi kaynak kimliklerini panelin normal silme akışıyla siler. Glob/önek taraması ile silme, registry/veritabanı dosyası düzenleme, servis restart, başka hesabın veya mevcut sitenin değiştirilmesi yasak. Mevcut kaynaklar yalnız okunur ve korunduğu fiziksel kanıtla (hash/metadata) doğrulanır. Site kurarken posta seçeneğini kapalı tut (T823 bitene kadar). `test-results/` içeriğini rapora/çıktıya kopyalama: Playwright anlık görüntüsü giriş parolasını içerebilir.

### T828 · Özellik testi: BAK-08 — Gerçek kurtarma, hata bildirimi ve yedek sahipliği
- **Bağımlı:** T107
- **Dosyalar:** `e2e/ozellik/bak-08.spec.js`, `docs/manuel-test/BAK-08.md`
- **İş:** `docs/manuel-test/BAK-08.md` raporundaki senaryoları `docs/manuel-test/YONTEM.md` yöntemiyle gerçek panele karşı Playwright testine çevir ve `sunucu-28-n` kilidiyle koş: 1 mutlu yol, 1 hatalı girdi, yetki içeriyorsa rol senaryosu; en az bir fiziksel sonuç. Rapordaki gerçek hatayı `test.fail` ile işaretle; yeni KRİTİK hatayı hemen bulgu görevi yap. Uygulama kodunu değiştirme. Ortak kurallara uy.
- **Kabul:** `e2e/ozellik/bak-08.spec.js` .28'de iki kez art arda koşuyor ve beklenmeyen düşüş yok; mock/`page.route`/sahte veri yok; koşudan sonra .28'de bu öneke ait kaynak kalmıyor (kanıtı raporda). Rapor ≤40 satır ve test dosyasının adını içeriyor.

### T829 · Özellik testi: DB-01 — MySQL/MariaDB oluşturma, silme, site ilişkisi ve boyut
- **Bağımlı:** T104
- **Dosyalar:** `e2e/ozellik/db-01.spec.js`, `docs/manuel-test/DB-01.md`
- **İş:** `docs/manuel-test/DB-01.md` raporundaki senaryoları `docs/manuel-test/YONTEM.md` yöntemiyle gerçek panele karşı Playwright testine çevir ve `sunucu-28-n` kilidiyle koş: 1 mutlu yol, 1 hatalı girdi, yetki içeriyorsa rol senaryosu; en az bir fiziksel sonuç. Rapordaki gerçek hatayı `test.fail` ile işaretle; yeni KRİTİK hatayı hemen bulgu görevi yap. Uygulama kodunu değiştirme. Ortak kurallara uy.
- **Kabul:** `e2e/ozellik/db-01.spec.js` .28'de iki kez art arda koşuyor ve beklenmeyen düşüş yok; mock/`page.route`/sahte veri yok; koşudan sonra .28'de bu öneke ait kaynak kalmıyor (kanıtı raporda). Rapor ≤40 satır ve test dosyasının adını içeriyor.

### T830 · Özellik testi: DB-02 — DB kullanıcıları, parolalar, roller ve grant yönetimi
- **Bağımlı:** T105
- **Dosyalar:** `e2e/ozellik/db-02.spec.js`, `docs/manuel-test/DB-02.md`
- **İş:** `docs/manuel-test/DB-02.md` raporundaki senaryoları `docs/manuel-test/YONTEM.md` yöntemiyle gerçek panele karşı Playwright testine çevir ve `sunucu-28-n` kilidiyle koş: 1 mutlu yol, 1 hatalı girdi, yetki içeriyorsa rol senaryosu; en az bir fiziksel sonuç. Rapordaki gerçek hatayı `test.fail` ile işaretle; yeni KRİTİK hatayı hemen bulgu görevi yap. Uygulama kodunu değiştirme. Ortak kurallara uy.
- **Kabul:** `e2e/ozellik/db-02.spec.js` .28'de iki kez art arda koşuyor ve beklenmeyen düşüş yok; mock/`page.route`/sahte veri yok; koşudan sonra .28'de bu öneke ait kaynak kalmıyor (kanıtı raporda). Rapor ≤40 satır ve test dosyasının adını içeriyor.

### T831 · Özellik testi: DB-03 — Uzak erişim, izinli kaynaklar ve bağlantı bilgileri
- **Bağımlı:** T106
- **Dosyalar:** `e2e/ozellik/db-03.spec.js`, `docs/manuel-test/DB-03.md`
- **İş:** `docs/manuel-test/DB-03.md` raporundaki senaryoları `docs/manuel-test/YONTEM.md` yöntemiyle gerçek panele karşı Playwright testine çevir ve `sunucu-28-n` kilidiyle koş: 1 mutlu yol, 1 hatalı girdi, yetki içeriyorsa rol senaryosu; en az bir fiziksel sonuç. Rapordaki gerçek hatayı `test.fail` ile işaretle; yeni KRİTİK hatayı hemen bulgu görevi yap. Uygulama kodunu değiştirme. Ortak kurallara uy.
- **Kabul:** `e2e/ozellik/db-03.spec.js` .28'de iki kez art arda koşuyor ve beklenmeyen düşüş yok; mock/`page.route`/sahte veri yok; koşudan sonra .28'de bu öneke ait kaynak kalmıyor (kanıtı raporda). Rapor ≤40 satır ve test dosyasının adını içeriyor.

### T832 · Özellik testi: HSP-01 — Müşteri oluştur/düzenle/askıya al/etkinleştir/sil
- **Bağımlı:** T116
- **Dosyalar:** `e2e/ozellik/hsp-01.spec.js`, `docs/manuel-test/HSP-01.md`
- **İş:** `docs/manuel-test/HSP-01.md` raporundaki senaryoları `docs/manuel-test/YONTEM.md` yöntemiyle gerçek panele karşı Playwright testine çevir ve `sunucu-28-n` kilidiyle koş: 1 mutlu yol, 1 hatalı girdi, yetki içeriyorsa rol senaryosu; en az bir fiziksel sonuç. Rapordaki gerçek hatayı `test.fail` ile işaretle; yeni KRİTİK hatayı hemen bulgu görevi yap. Uygulama kodunu değiştirme. Ortak kurallara uy.
- **Kabul:** `e2e/ozellik/hsp-01.spec.js` .28'de iki kez art arda koşuyor ve beklenmeyen düşüş yok; mock/`page.route`/sahte veri yok; koşudan sonra .28'de bu öneke ait kaynak kalmıyor (kanıtı raporda). Rapor ≤40 satır ve test dosyasının adını içeriyor.

### T833 · Özellik testi: HSP-02 — Reseller oluştur/düzenle/askıya al/etkinleştir/sil
- **Bağımlı:** T117
- **Dosyalar:** `e2e/ozellik/hsp-02.spec.js`, `docs/manuel-test/HSP-02.md`
- **İş:** `docs/manuel-test/HSP-02.md` raporundaki senaryoları `docs/manuel-test/YONTEM.md` yöntemiyle gerçek panele karşı Playwright testine çevir ve `sunucu-28-n` kilidiyle koş: 1 mutlu yol, 1 hatalı girdi, yetki içeriyorsa rol senaryosu; en az bir fiziksel sonuç. Rapordaki gerçek hatayı `test.fail` ile işaretle; yeni KRİTİK hatayı hemen bulgu görevi yap. Uygulama kodunu değiştirme. Ortak kurallara uy.
- **Kabul:** `e2e/ozellik/hsp-02.spec.js` .28'de iki kez art arda koşuyor ve beklenmeyen düşüş yok; mock/`page.route`/sahte veri yok; koşudan sonra .28'de bu öneke ait kaynak kalmıyor (kanıtı raporda). Rapor ≤40 satır ve test dosyasının adını içeriyor.

### T834 · Özellik testi: HSP-03 — İletişim, şirket, açıklama ve hesap erişim bilgileri
- **Bağımlı:** T118
- **Dosyalar:** `e2e/ozellik/hsp-03.spec.js`, `docs/manuel-test/HSP-03.md`
- **İş:** `docs/manuel-test/HSP-03.md` raporundaki senaryoları `docs/manuel-test/YONTEM.md` yöntemiyle gerçek panele karşı Playwright testine çevir ve `sunucu-28-n` kilidiyle koş: 1 mutlu yol, 1 hatalı girdi, yetki içeriyorsa rol senaryosu; en az bir fiziksel sonuç. Rapordaki gerçek hatayı `test.fail` ile işaretle; yeni KRİTİK hatayı hemen bulgu görevi yap. Uygulama kodunu değiştirme. Ortak kurallara uy.
- **Kabul:** `e2e/ozellik/hsp-03.spec.js` .28'de iki kez art arda koşuyor ve beklenmeyen düşüş yok; mock/`page.route`/sahte veri yok; koşudan sonra .28'de bu öneke ait kaynak kalmıyor (kanıtı raporda). Rapor ≤40 satır ve test dosyasının adını içeriyor.

### T835 · Özellik testi: ROL-01 — Yönetici Service Provider görünümü
- **Bağımlı:** T110
- **Dosyalar:** `e2e/ozellik/rol-01.spec.js`, `docs/manuel-test/ROL-01.md`
- **İş:** `docs/manuel-test/ROL-01.md` raporundaki senaryoları `docs/manuel-test/YONTEM.md` yöntemiyle gerçek panele karşı Playwright testine çevir ve `sunucu-28-n` kilidiyle koş: 1 mutlu yol, 1 hatalı girdi, yetki içeriyorsa rol senaryosu; en az bir fiziksel sonuç. Rapordaki gerçek hatayı `test.fail` ile işaretle; yeni KRİTİK hatayı hemen bulgu görevi yap. Uygulama kodunu değiştirme. Ortak kurallara uy.
- **Kabul:** `e2e/ozellik/rol-01.spec.js` .28'de iki kez art arda koşuyor ve beklenmeyen düşüş yok; mock/`page.route`/sahte veri yok; koşudan sonra .28'de bu öneke ait kaynak kalmıyor (kanıtı raporda). Rapor ≤40 satır ve test dosyasının adını içeriyor.

### T836 · Özellik testi: ROL-03 — Reseller paneli ve kendi kaynak/kullanıcı sınırı
- **Bağımlı:** T111
- **Dosyalar:** `e2e/ozellik/rol-03.spec.js`, `docs/manuel-test/ROL-03.md`
- **İş:** `docs/manuel-test/ROL-03.md` raporundaki senaryoları `docs/manuel-test/YONTEM.md` yöntemiyle gerçek panele karşı Playwright testine çevir ve `sunucu-28-n` kilidiyle koş: 1 mutlu yol, 1 hatalı girdi, yetki içeriyorsa rol senaryosu; en az bir fiziksel sonuç. Rapordaki gerçek hatayı `test.fail` ile işaretle; yeni KRİTİK hatayı hemen bulgu görevi yap. Uygulama kodunu değiştirme. Ortak kurallara uy.
- **Kabul:** `e2e/ozellik/rol-03.spec.js` .28'de iki kez art arda koşuyor ve beklenmeyen düşüş yok; mock/`page.route`/sahte veri yok; koşudan sonra .28'de bu öneke ait kaynak kalmıyor (kanıtı raporda). Rapor ≤40 satır ve test dosyasının adını içeriyor.

### T837 · Özellik testi: ROL-04 — Müşteri paneli ve abonelik/site seçimi
- **Bağımlı:** T112
- **Dosyalar:** `e2e/ozellik/rol-04.spec.js`, `docs/manuel-test/ROL-04.md`
- **İş:** `docs/manuel-test/ROL-04.md` raporundaki senaryoları `docs/manuel-test/YONTEM.md` yöntemiyle gerçek panele karşı Playwright testine çevir ve `sunucu-28-n` kilidiyle koş: 1 mutlu yol, 1 hatalı girdi, yetki içeriyorsa rol senaryosu; en az bir fiziksel sonuç. Rapordaki gerçek hatayı `test.fail` ile işaretle; yeni KRİTİK hatayı hemen bulgu görevi yap. Uygulama kodunu değiştirme. Ortak kurallara uy.
- **Kabul:** `e2e/ozellik/rol-04.spec.js` .28'de iki kez art arda koşuyor ve beklenmeyen düşüş yok; mock/`page.route`/sahte veri yok; koşudan sonra .28'de bu öneke ait kaynak kalmıyor (kanıtı raporda). Rapor ≤40 satır ve test dosyasının adını içeriyor.

### T838 · Özellik testi: ROL-05 — Ek kullanıcılar, roller ve izin matrisi
- **Bağımlı:** T113
- **Dosyalar:** `e2e/ozellik/rol-05.spec.js`, `docs/manuel-test/ROL-05.md`
- **İş:** `docs/manuel-test/ROL-05.md` raporundaki senaryoları `docs/manuel-test/YONTEM.md` yöntemiyle gerçek panele karşı Playwright testine çevir ve `sunucu-28-n` kilidiyle koş: 1 mutlu yol, 1 hatalı girdi, yetki içeriyorsa rol senaryosu; en az bir fiziksel sonuç. Rapordaki gerçek hatayı `test.fail` ile işaretle; yeni KRİTİK hatayı hemen bulgu görevi yap. Uygulama kodunu değiştirme. Ortak kurallara uy.
- **Kabul:** `e2e/ozellik/rol-05.spec.js` .28'de iki kez art arda koşuyor ve beklenmeyen düşüş yok; mock/`page.route`/sahte veri yok; koşudan sonra .28'de bu öneke ait kaynak kalmıyor (kanıtı raporda). Rapor ≤40 satır ve test dosyasının adını içeriyor.

### T839 · Özellik testi: ROL-06 — Ek yönetici hesapları ve yönetim yetkileri
- **Bağımlı:** T114
- **Dosyalar:** `e2e/ozellik/rol-06.spec.js`, `docs/manuel-test/ROL-06.md`
- **İş:** `docs/manuel-test/ROL-06.md` raporundaki senaryoları `docs/manuel-test/YONTEM.md` yöntemiyle gerçek panele karşı Playwright testine çevir ve `sunucu-28-n` kilidiyle koş: 1 mutlu yol, 1 hatalı girdi, yetki içeriyorsa rol senaryosu; en az bir fiziksel sonuç. Rapordaki gerçek hatayı `test.fail` ile işaretle; yeni KRİTİK hatayı hemen bulgu görevi yap. Uygulama kodunu değiştirme. Ortak kurallara uy.
- **Kabul:** `e2e/ozellik/rol-06.spec.js` .28'de iki kez art arda koşuyor ve beklenmeyen düşüş yok; mock/`page.route`/sahte veri yok; koşudan sonra .28'de bu öneke ait kaynak kalmıyor (kanıtı raporda). Rapor ≤40 satır ve test dosyasının adını içeriyor.

### T840 · Özellik testi: ROL-07 — Profil, iletişim bilgisi, parola, oturum ve MFA
- **Bağımlı:** T115
- **Dosyalar:** `e2e/ozellik/rol-07.spec.js`, `docs/manuel-test/ROL-07.md`
- **İş:** `docs/manuel-test/ROL-07.md` raporundaki senaryoları `docs/manuel-test/YONTEM.md` yöntemiyle gerçek panele karşı Playwright testine çevir ve `sunucu-28-n` kilidiyle koş: 1 mutlu yol, 1 hatalı girdi, yetki içeriyorsa rol senaryosu; en az bir fiziksel sonuç. Rapordaki gerçek hatayı `test.fail` ile işaretle; yeni KRİTİK hatayı hemen bulgu görevi yap. Uygulama kodunu değiştirme. Ortak kurallara uy.
- **Kabul:** `e2e/ozellik/rol-07.spec.js` .28'de iki kez art arda koşuyor ve beklenmeyen düşüş yok; mock/`page.route`/sahte veri yok; koşudan sonra .28'de bu öneke ait kaynak kalmıyor (kanıtı raporda). Rapor ≤40 satır ve test dosyasının adını içeriyor.

### T841 · Özellik testi: RUN-02 — PHP sürümü/handler, php.ini ve PHP-FPM ayarları
- **Bağımlı:** T101
- **Dosyalar:** `e2e/ozellik/run-02.spec.js`, `docs/manuel-test/RUN-02.md`
- **İş:** `docs/manuel-test/RUN-02.md` raporundaki senaryoları `docs/manuel-test/YONTEM.md` yöntemiyle gerçek panele karşı Playwright testine çevir ve `sunucu-28-n` kilidiyle koş: 1 mutlu yol, 1 hatalı girdi, yetki içeriyorsa rol senaryosu; en az bir fiziksel sonuç. Rapordaki gerçek hatayı `test.fail` ile işaretle; yeni KRİTİK hatayı hemen bulgu görevi yap. Uygulama kodunu değiştirme. Ortak kurallara uy.
- **Kabul:** `e2e/ozellik/run-02.spec.js` .28'de iki kez art arda koşuyor ve beklenmeyen düşüş yok; mock/`page.route`/sahte veri yok; koşudan sonra .28'de bu öneke ait kaynak kalmıyor (kanıtı raporda). Rapor ≤40 satır ve test dosyasının adını içeriyor.

### T842 · Özellik testi: TLS-01 — Ücretsiz ACME issue, renew ve otomatik yenileme
- **Bağımlı:** T102
- **Dosyalar:** `e2e/ozellik/tls-01.spec.js`, `docs/manuel-test/TLS-01.md`
- **İş:** `docs/manuel-test/TLS-01.md` raporundaki senaryoları `docs/manuel-test/YONTEM.md` yöntemiyle gerçek panele karşı Playwright testine çevir ve `sunucu-28-n` kilidiyle koş: 1 mutlu yol, 1 hatalı girdi, yetki içeriyorsa rol senaryosu; en az bir fiziksel sonuç. Rapordaki gerçek hatayı `test.fail` ile işaretle; yeni KRİTİK hatayı hemen bulgu görevi yap. Uygulama kodunu değiştirme. Ortak kurallara uy.
- **Kabul:** `e2e/ozellik/tls-01.spec.js` .28'de iki kez art arda koşuyor ve beklenmeyen düşüş yok; mock/`page.route`/sahte veri yok; koşudan sonra .28'de bu öneke ait kaynak kalmıyor (kanıtı raporda). Rapor ≤40 satır ve test dosyasının adını içeriyor.

### T843 · Özellik testi: TLS-06 — Geçerlilik, gerçek sunulan sertifika, durum ve uyarılar
- **Bağımlı:** T103
- **Dosyalar:** `e2e/ozellik/tls-06.spec.js`, `docs/manuel-test/TLS-06.md`
- **İş:** `docs/manuel-test/TLS-06.md` raporundaki senaryoları `docs/manuel-test/YONTEM.md` yöntemiyle gerçek panele karşı Playwright testine çevir ve `sunucu-28-n` kilidiyle koş: 1 mutlu yol, 1 hatalı girdi, yetki içeriyorsa rol senaryosu; en az bir fiziksel sonuç. Rapordaki gerçek hatayı `test.fail` ile işaretle; yeni KRİTİK hatayı hemen bulgu görevi yap. Uygulama kodunu değiştirme. Ortak kurallara uy.
- **Kabul:** `e2e/ozellik/tls-06.spec.js` .28'de iki kez art arda koşuyor ve beklenmeyen düşüş yok; mock/`page.route`/sahte veri yok; koşudan sonra .28'de bu öneke ait kaynak kalmıyor (kanıtı raporda). Rapor ≤40 satır ve test dosyasının adını içeriyor.

### T844 · Özellik testi: UX-01 — Plesk görev yerleşimi ve tüm rollerin doğru menüsü
- **Bağımlı:** T108
- **Dosyalar:** `e2e/ozellik/ux-01.spec.js`, `docs/manuel-test/UX-01.md`
- **İş:** `docs/manuel-test/UX-01.md` raporundaki senaryoları `docs/manuel-test/YONTEM.md` yöntemiyle gerçek panele karşı Playwright testine çevir ve `sunucu-28-n` kilidiyle koş: 1 mutlu yol, 1 hatalı girdi, yetki içeriyorsa rol senaryosu; en az bir fiziksel sonuç. Rapordaki gerçek hatayı `test.fail` ile işaretle; yeni KRİTİK hatayı hemen bulgu görevi yap. Uygulama kodunu değiştirme. Ortak kurallara uy.
- **Kabul:** `e2e/ozellik/ux-01.spec.js` .28'de iki kez art arda koşuyor ve beklenmeyen düşüş yok; mock/`page.route`/sahte veri yok; koşudan sonra .28'de bu öneke ait kaynak kalmıyor (kanıtı raporda). Rapor ≤40 satır ve test dosyasının adını içeriyor.

### T845 · Özellik testi: UX-06 — İş ilerlemesi, güvenli yeniden deneme ve gerçek durum
- **Bağımlı:** T109
- **Dosyalar:** `e2e/ozellik/ux-06.spec.js`, `docs/manuel-test/UX-06.md`
- **İş:** `docs/manuel-test/UX-06.md` raporundaki senaryoları `docs/manuel-test/YONTEM.md` yöntemiyle gerçek panele karşı Playwright testine çevir ve `sunucu-28-n` kilidiyle koş: 1 mutlu yol, 1 hatalı girdi, yetki içeriyorsa rol senaryosu; en az bir fiziksel sonuç. Rapordaki gerçek hatayı `test.fail` ile işaretle; yeni KRİTİK hatayı hemen bulgu görevi yap. Uygulama kodunu değiştirme. Ortak kurallara uy.
- **Kabul:** `e2e/ozellik/ux-06.spec.js` .28'de iki kez art arda koşuyor ve beklenmeyen düşüş yok; mock/`page.route`/sahte veri yok; koşudan sonra .28'de bu öneke ait kaynak kalmıyor (kanıtı raporda). Rapor ≤40 satır ve test dosyasının adını içeriyor.

### T846 · Özellik testi: WEB-01 — Domain ekleme ve amaca göre site oluşturma sihirbazı
- **Bağımlı:** T119
- **Dosyalar:** `e2e/ozellik/web-01.spec.js`, `docs/manuel-test/WEB-01.md`
- **İş:** `docs/manuel-test/WEB-01.md` raporundaki senaryoları `docs/manuel-test/YONTEM.md` yöntemiyle gerçek panele karşı Playwright testine çevir ve `sunucu-28-n` kilidiyle koş: 1 mutlu yol, 1 hatalı girdi, yetki içeriyorsa rol senaryosu; en az bir fiziksel sonuç. Rapordaki gerçek hatayı `test.fail` ile işaretle; yeni KRİTİK hatayı hemen bulgu görevi yap. Uygulama kodunu değiştirme. Ortak kurallara uy.
- **Kabul:** `e2e/ozellik/web-01.spec.js` .28'de iki kez art arda koşuyor ve beklenmeyen düşüş yok; mock/`page.route`/sahte veri yok; koşudan sonra .28'de bu öneke ait kaynak kalmıyor (kanıtı raporda). Rapor ≤40 satır ve test dosyasının adını içeriyor.

### T847 · Özellik testi: WEB-07 — Domain kartı/liste, arama, filtre ve doğru araç grupları
- **Bağımlı:** T124
- **Dosyalar:** `e2e/ozellik/web-07.spec.js`, `docs/manuel-test/WEB-07.md`
- **İş:** `docs/manuel-test/WEB-07.md` raporundaki senaryoları `docs/manuel-test/YONTEM.md` yöntemiyle gerçek panele karşı Playwright testine çevir ve `sunucu-28-n` kilidiyle koş: 1 mutlu yol, 1 hatalı girdi, yetki içeriyorsa rol senaryosu; en az bir fiziksel sonuç. Rapordaki gerçek hatayı `test.fail` ile işaretle; yeni KRİTİK hatayı hemen bulgu görevi yap. Uygulama kodunu değiştirme. Ortak kurallara uy.
- **Kabul:** `e2e/ozellik/web-07.spec.js` .28'de iki kez art arda koşuyor ve beklenmeyen düşüş yok; mock/`page.route`/sahte veri yok; koşudan sonra .28'de bu öneke ait kaynak kalmıyor (kanıtı raporda). Rapor ≤40 satır ve test dosyasının adını içeriyor.
