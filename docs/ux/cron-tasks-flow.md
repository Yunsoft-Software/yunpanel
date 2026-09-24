# CRON-UI — Site içinden zamanlanmış görevler

2026-09-25 · development · UX-PL-04/06/07/08 alt dilimi.
Başlangıç: `6e2aa1c299094b32b418c52bf415dc54b319987c`.

## İnceleme ve uygulanacak akış

Mevcut `website-cron-http.js` ve `website-cron-apply-service.js` site kapsamında liste/tek kayıt/ekle/düzenle/sil API'lerini sağlar. Ekleme ve düzenleme zaten `cron.apply` işi oluşturur; ikinci bir uygulama motoru veya gereksiz ikinci POST kurulmaz. Son `6e2aa1c2` silmede `accepted` ile doğrulanmış `deleted` sonucunu ayırır. `SiteDetailPage`, `SITE_TABS` ve site gezinmesinde bu API'lere bağlı cron ekranı henüz yoktur.

- [ ] CRON-UI-01: mevcut API cevaplarını hedef Website/sunucu/uygulama/Unix kullanıcısı ve revizyonla doğrulayan istemci; listeleme ve host reconciliation cevaplarının farklı alanlarını açıkça normalize et.
- [ ] CRON-UI-02: ekle/düzenle/sil ve etkinlik tercihi; düzenleme/silme öncesi güncel kayıt kontrolü, açık kullanıcı onayı, aynı anda tek yazma, belirsiz sonuçta otomatik tekrar yok.
- [ ] CRON-UI-03: aynı job kimliğiyle salt okunur takip; iş kabulü tamamlanma değildir. Apply sonucu komutun başarıyla çalıştığı anlamına gelmez. Silme ancak doğru başarılı job ve güncel listede yoklukla tamamlanır.
- [ ] CRON-UI-04: Genel Bakış ve Barındırma ve DNS içinden görünür Zamanlanmış Görevler aracı; mevcut Ember bileşenleri, site rotası, taslak uyarısı, hata/yenileme ve JobDrawer bağlantısı. Files ve diğer araçlar korunur.
- [ ] CRON-UI-05: seçili davranış/kaynak testlerini çalıştır, sonuç ve sınırları kaydet; gerçek build/browser/host kabulünü aşağıda açık bırak.

## Güvenlik ve kapsam

Domain ID API'de Website ID yerine kullanılmaz. Başka siteye fallback yoktur. Loading/stale/eksik bağ/unsupported runtime görünür durumdur. Canlı oturum değişimi, izin kaybı ve unmount sonrasında eski sonuç kullanılmaz. Backend auth/CSRF/tenant denetimleri aynen korunur; yeni reseller rolü veya erişim yolu açılmaz. Komutlar URL/localStorage'a yazılmaz. Cron sunucunun saat dilimini kullanır; kullanıcıya hayali sonraki çalışma zamanı gösterilmez. Site cron'u dedicated Unix kullanıcısında çalışmaya devam eder.

## T-DEV-CRON-UI — Codex / gerçek ortam kabulü

- [ ] Node >=24.11.1/npm >=11 tam checkout: npm ci, mevcut lint/test/build ve yeni cron istemci/bağlantı testleri. Bu ortamın seçili Node22 kontrolleri hedef sürüm veya üretim React kabulü değildir.
- [ ] Owner ve iki site_manager ile gerçek API: yalnız atanmış Website; yabancı task/job/Domain-ID, 401/403/409/500, CSRF, oturum/Website/Unix bağı değişimi ve eşzamanlı düzenleme. Mevcut backend tenant sınırlarını doğrula.
- [ ] İzinli test hostunda static/node/php sitesi: ekle, düzenle, devre dışı bırak, etkinleştir, sil; doğru cron dosyası ve site kullanıcısı. Komutun çalışması ayrıca gözlensin; apply işinin başarısı komut sonucu sayılmasın. `.44` Plesk hostuna hiçbir amaçla dokunma.
- [ ] Yavaş/kayıp POST/PATCH/DELETE cevabı, başarısız/iptal/yanlış job, süreç restartı ve metadata gecikmesi. Aynı job salt GET ile takip edilsin; yanlış hedef veya yarım cleanup başarı sayılmasın.
- [ ] Chromium/Firefox üretim bundle'ı: 320/390/834/1440 px, yüzde 200 zoom, klavye/modal focus, uzun komut, kaydedilmemiş taslak, reload/back/forward, site değişimi, hata/yenileme ve eski Files rotaları.

Üst UX-PL-06, BUG-02, RS-02e ve production kapıları bu alt dilimle kapanmaz. Gerçek host silme/askı, reseller self-service, PHP/backup/istatistik işleri ayrı kalır.
