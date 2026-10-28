# Yapılanlar

> Her biten iş tek kısa satır. Yeni en üstte. Tür: **Özellik**, **Hata**, **Güvenlik**, **Altyapı**. Ayrıntı commit'te; görev raporları `tasks/done/`.

## 28-10-2026
- **Hata** — Aynı slug ile tenant yeniden kurma `.28`de gerçek HTTPS/Chromium ile 20/20 + 19/19 geçti; nesil ve üç kaynak/işlem kimliği ayrıldı. Onaylı dört API dosyası hash kontrolüyle aktarıldı; tenant/üst domain/upstream temizlendi, anahtarlar iptal edildi; emekli sertifika materyali 30 günlük politikayla korunuyor (T818).
- **Altyapı** — Otomasyon API'si benzersiz tenant ile `.28` gerçek HTTPS/API/Chromium kabulü 19/19 geçti; ACME ayarı yapıldı, tenant/üst domain/geçici uygulama/anahtar temizliği doğrulandı (`docs/otomasyon-api.md`).
- **Hata** — Uygulaması ve dosya kökü olmayan proxy sitesi silinemiyordu; üretim dosya temizleme adaptörü düzeltildi, gerçek registry regresyonu ve ilgili 82 test geçti; tek dosya kullanıcı onayıyla `.28`e uygulandı.
- **Hata** — Herkese açık web geçidi otomasyon isteklerini geçirmiyordu (Authorization siliniyordu); ayrı `/api/automation` yolu.
- **Hata** — Tenant sitesi hazır olmadan durum değişikliği kabul edilip sonsuza dek bekliyordu; artık 409.
- **Hata** — Orkestra `lock.sh break` SENIOR kilitlerini kırıyordu; ajanlar senior kurulumu sırasında `.28`'de test yaptı. Korumalı kilitler artık kırılmıyor.

## 27-10-2026
- **Özellik** — Otomasyon API'si: kapsamlı API anahtarları (Ayarlar), tek çağrıyla tenant sitesi kurma/durdurma (503)/arşivleme (302)/silme; Plesk'teki Novasis kurulumunun karşılığı (`docs/otomasyon-api.md`).
- **Özellik** — Bakım modu: her site için 503 (yönlendirme kuralları ve şifreli dizinler atlatamaz); .28'de nginx ile doğrulandı.
- **Özellik** — Yönlendirme amaçlı (hosting'siz) domain: 301/302, yolu koruma, hedef sonradan değiştirilebilir; kendine yönlendirme engellendi. .28'de gerçek nginx ile doğrulandı.
- **Hata** — E2E testleri kurulu Google Chrome'u görünmez açıyordu; testler sürerken kullanıcının Chrome'u açılmıyordu. Artık Playwright'ın kendi Chromium'u (`npm run e2e:install`).
- **Özellik** — Şifre korumalı dizinler: site başına en çok 20 dizin, dizin başına kullanıcılar (parola yalnız hash olarak sunucuda); .28'de nginx ile atlatma denemelerine karşı doğrulandı.
- **Özellik** — Posta teslimat takibi: ileti başına gönderen/alıcı/durum/sebep (Teslimat sekmesi); .28 journal'ında doğrulandı.
- **Hata** — Teslimat log ucu hiç çalışmıyordu: journal okuyucusuna zaman aralığı verilmiyordu ve yanlış Postfix birimi (postfix.service) okunuyordu.
- **Güvenlik** — Teslimat logu alan adını alt metinle süzüyordu (a.com, data.com'u görürdü); artık tam adres alan adı eşleşmesi.
- **Hata** — Posta kuyruğu ve teslimat logunda arama hiç çalışmıyordu (istemci `search`, sunucu `q`).
- **Güvenlik** — KRİTİK: site rolleri başka kiracıların DNS bölgelerini ve DNS sağlayıcı kimlik bilgisini görüp değiştirebiliyordu; kapatıldı.
- **Güvenlik** — KRİTİK: site rolleri Owner bildirim geçmişini okuyup tercihlerini değiştirebiliyor, test e-postası gönderttirebiliyordu; kapatıldı.
- **Güvenlik** — Parity adaptörü çalıştırma (istemci adlı metot) yalnız Owner'a açıldı.
- **Altyapı** — 284 ucun yetki denetimi: `docs/guvenlik-denetimi-2026-10-27.md`.
- **Güvenlik** — Derinlemesine savunma: sunucu logları, posta kuyruğu ve uygulama/dağıtım logları uç düzeyinde de kapsamlandı (site kaynak sınırı bunları zaten engelliyordu; ilk "kritik" değerlendirmesi düzeltildi).
- **Özellik** — Smarthost: giden posta başka SMTP üzerinden (yalnız Owner, TLS zorunlu, parola şifreli); .28'de gerçek Postfix ile doğrulandı.
- **Güvenlik** — KRİTİK: site log sayfası müşterilere sunucunun genel nginx logunu (başka sitelerin kayıtları) gösteriyordu; artık yalnız sitenin kendi dosyası.
- **Hata** — Site log sayfasında hata logu hiç açılamıyordu (`kind` parametresi reddediliyordu).
- **Hata** — Müşteriler kendi site loglarını göremiyordu; panel Owner'a özel sunucu ucunu çağırıyordu.
- **Özellik** — Canlı log: site log ekranında 3 sn'de bir yeni satırlar; logrotate/copytruncate algılanıyor.
- **Özellik** — Performance Booster: site başına gzip (CSS/JS/JSON/SVG/font, proxy dahil) ve PHP'de tarayıcı önbelleği; .28'de gerçek yanıtla doğrulandı.
- **Hata** — PHP/Node sitelerinde yeni nginx ayarlarının kaybolması kökten çözüldü: alanlar tek listede.
- **Altyapı** — Yönlendirmelerin gerçek 301/302 davranışı .28'de geçici nginx ile doğrulandı.
- **Özellik** — Site başına yönlendirme kuralları (tam yol / klasör, 301/302); gerçek nginx -t ile doğrulandı.
- **Hata** — PHP ve Node sitelerinde yeni nginx ayarları (yönlendirmeler) sessizce kayboluyordu.
- **Hata** — Barındırma formu yeniden yüklenince kaydedilmemiş yönlendirmeler kayboluyordu.
- **Güvenlik** — Yönlendirme yolu doğrulamasındaki ReDoS riski yazılırken önlendi.
- **Güvenlik** — Owner parolası e2e testlerinde açık metindi; artık `.local`'den okunuyor.
- **Hata** — Kritik T800: sertifika yenileme uçlarında kiracı izolasyonu eksikti (junior düzeltti, incelemede).
- **Altyapı** — Kalan özellik testleri Playwright senaryosu yöntemine geçti; 33 çekirdek özellik öne alındı.

## 26-10-2026
- **Hata** — `npm test` aralıklı takılıyordu: 4 sınırsız bekleme döngüsü 10 sn ile sınırlandı, test başına 2 dk zaman aşımı eklendi.
- **Altyapı** — Orkestra (senior/junior) düzeni kuruldu; 124 özellik için manuel test görevleri açıldı.
- **Altyapı** — Push artık tek komut (`orchestrator.py push`), saniyeler sürüyor.
