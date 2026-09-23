# BUG-20260923-01 / UX-PL-07 — İşlem durumu ve güvenli ilerletme

Başlangıç: `development@68372c27`, 2026-09-23. Mevcut İşlem geçmişi, JobDrawer ve site oluşturma/provisioning motoru korunur. Yeni job/retry endpoint'i, tema veya backend motoru eklenmez.

## Kaynakta görülen sorunlar

`jobLifecycle()` kuyruk/çalışıyor/terminal durumlarını sabit 1/3, 2/3, 3/3 diye sunuyor; başarısız ve iptal işi de 3/3 görünüyor. Bu bir ölçüm veya deneme sayısı değil. JobDrawer ayrıca eksik deneme bilgisini sıfır saymamalı; negatif/bozuk değer göstermemeli.

`autoAdvanceWebsiteProvisioning()` her POST hatasını üç kez deniyor ve başarısız her adımı hata sınıfını ayırmadan yeniden sıraya alıyor. Cevabın kaybı işin sunucuda gerçekleşmediğini kanıtlamaz. Bu istemci otomatik tekrarın güvenli olduğuna karar veremez; mevcut manuel recovery yolu ve sunucu izinleri korunarak belirsiz/başarısız sonuçta durmalıdır.

## Dar kaynak dilimi

- [ ] JOB-UX-01: Gerçek işlem durumu ve bildirilen deneme sayısını ayır; ölçülmemiş oran/yüzde gösterme. Başarısız/iptal işi başarı diye etiketleme.
- [ ] JOB-UX-02: Mevcut tablo ve detay penceresini bu modele bağla; kaynak, hata, tanılama, log ve iptal erişimini koru.
- [ ] JOB-UX-03: Otomatik ilerletmede yalnız doğrulanmış aynı işlemde başarılı ilerlemeden sonra sıradaki adıma geç. POST hatası, yanlış/belirsiz cevap, başarısız/bloke/kesintili iş ve iptalde kör tekrar yapma. Mevcut yazılı onaylı manuel retry/continue/compensate API'lerini kaldırma veya yetkilerini genişletme.
- [ ] JOB-UX-04: Odaklı davranış/regresyon testleri ve yapılabilen JSX kontrolleri; test ile gerçek ortam kabulünü ayır.

Önceki SSL formu kaynak alt işleri `36a46185` / `96db8b9b` ile zaten yapılmıştır (`docs/ux/ssl-form-flow.md`); tekrar kodlanmaz. Ana plandaki kaynak işaretleri eşitlenecek, üst BUG-04/05 kabulü açık kalacaktır.

## T-DEV-JOB-UX — Codex gerçek ortam kabulü (açık)

- [ ] Hedef Node24/npm11 tam checkout, lint/test/build; gerçek React/Vite ile İşlem geçmişi, site içi işler ve JobDrawer. Kuyruk/çalışıyor/başarılı/başarısız/iptal/unknown, 0/eksik/bozuk deneme sayısı ve API hatası test edilsin.
- [ ] Başarılı site kurulumunun adımları bir kez ilerlesin; son başarılı işlem üçüncü kez tekrar edilmesin. Yanlış operationId, bozuk cevap, ağ kopması/yanıt kaybı, 401/403/409/429/5xx ve sayfadan ayrılma durumlarında istemci kör POST tekrarlamasın.
- [ ] Gerçek sunucu durumunu yeniden okuyup mevcut Site → Genel Bakış recovery akışıyla kontrollü devam/retry yap. Sonuç belirsizken siteyi yeniden oluşturma veya cleanup başlatma. Manuel retry sonrasında idempotency, ortak kaynak kilidi, yetki iptali ve restart doğrulansın.
- [ ] Otomatik geçici-hata retry'sini backend sınıflandırması, güvenli yeniden yürütme kanıtı, kalıcı deneme bütçesi ve sağlayıcı bekleme süresiyle tamamla. Bu kaynak dilimi genel otomatik retry motorunu tamamlamaz. Otomatik limit dolduktan sonra yetkili manuel retry'nin çalışması backend/host kabulünde açık kalır.
- [ ] Owner/Site A/Site B, gerçek router/tarayıcı, klavye, mobil ve koyu tema; log/kaynak/iptal erişimi korunsun. `.44` Plesk hostuna dokunma; yalnız doğrulanmış izinli test hostunu kullan.

Kök `todo.md`, `docs/ux/development-todo.md`, BUG-01 ve UX-PL-07 üst kapıları kapanmaz. GitHub Actions ve canlı deploy yapılmaz.
