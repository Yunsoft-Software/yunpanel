# Yapılanlar

> Her biten iş tek kısa satır. Yeni en üstte. Tür: **Özellik**, **Hata**, **Güvenlik**, **Altyapı**. Ayrıntı commit'te; görev raporları `tasks/done/`.

## 27-10-2026
- **Özellik** — Performance Booster: site başına gzip (CSS/JS/JSON/SVG/font, proxy dahil) ve PHP'de tarayıcı önbelleği; .28'de gerçek yanıtla doğrulandı. *(dal: 27-10-2026-ozellik-3a)*
- **Hata** — PHP/Node sitelerinde yeni nginx ayarlarının kaybolması kökten çözüldü: alanlar tek listede. *(dal: 27-10-2026-ozellik-3a)*
- **Altyapı** — Yönlendirmelerin gerçek 301/302 davranışı .28'de geçici nginx ile doğrulandı.
- **Özellik** — Site başına yönlendirme kuralları (tam yol / klasör, 301/302); gerçek nginx -t ile doğrulandı. *(dal: 27-10-2026-ozellik-3a)*
- **Hata** — PHP ve Node sitelerinde yeni nginx ayarları (yönlendirmeler) sessizce kayboluyordu. *(dal: 27-10-2026-ozellik-3a)*
- **Hata** — Barındırma formu yeniden yüklenince kaydedilmemiş yönlendirmeler kayboluyordu. *(dal: 27-10-2026-ozellik-3a)*
- **Güvenlik** — Yönlendirme yolu doğrulamasındaki ReDoS riski yazılırken önlendi. *(dal: 27-10-2026-ozellik-3a)*
- **Güvenlik** — Owner parolası e2e testlerinde açık metindi; artık `.local`'den okunuyor.
- **Hata** — Kritik T800: sertifika yenileme uçlarında kiracı izolasyonu eksikti (junior düzeltti, incelemede).
- **Altyapı** — Kalan özellik testleri Playwright senaryosu yöntemine geçti; 33 çekirdek özellik öne alındı.

## 26-10-2026
- **Hata** — `npm test` aralıklı takılıyordu: 4 sınırsız bekleme döngüsü 10 sn ile sınırlandı, test başına 2 dk zaman aşımı eklendi.
- **Altyapı** — Orkestra (senior/junior) düzeni kuruldu; 124 özellik için manuel test görevleri açıldı.
- **Altyapı** — Push artık tek komut (`orchestrator.py push`), saniyeler sürüyor.
