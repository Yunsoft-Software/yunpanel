# Kararlar

> Sadece senior yazar, sadece İNSAN'ın onayladığı kararlar. Sohbette kalan karar yok sayılır. Önceki kararlar `agents.md`'de; burası 26 Ekim 2026 ve sonrası.

## 2026-10-26 · Orkestra çalışma düzeni
- **Karar:** YunPanel'de iş senior (Claude veya Codex) / junior (Antigravity, 6 yuva) düzeniyle yürür; görev ve kabul kaydı Code Factory yerine orkestradır (`docs/gorevler/`, `tasks/`).
- **Gerekçe:** Durum diskte ve git'te kalsın; araç ya da ekip arkadaşı değişince kaldığı yerden devam edilsin; yapan ile doğrulayan ayrı olsun.
- **Onaylayan:** İNSAN

## 2026-10-26 · Canlı test tek kilitle
- **Karar:** `.28`'e dokunan her iş `sunucu-28` kilidiyle, aynı anda tek ajanla yapılır; ajanlar test kaynaklarını kendi önekleriyle açar ve temizler.
- **Gerekçe:** Paralel kurulum/silme testleri birbirinin verisini bozar.
- **Onaylayan:** İNSAN

## 2026-10-26 · Test zamanı
- **Karar:** Görev tesliminde lint + ilgili birim/API testleri; dalga sonunda tam `verify` (tüm testler, build, `.28` Playwright). "Tamamlandı" yalnız tam doğrulamadan sonra söylenir.
- **Gerekçe:** agents.md "dilim sonunda toplu koşturma" kuralı ile hızlı geri bildirimi birleştirir.
- **Onaylayan:** İNSAN

## 2026-10-26 · Push ve günlük dal
- **Karar:** Junior ajanlar push etmez. Senior değerlendirmeden sonra İNSAN'ın açık onayıyla yalnız aktif dalı push eder; `main`'e asla. Aktif dal günün tarihidir (`DD-MM-YYYY`); yeni günde bir önceki aktif daldan açılır, aktif claim varken değiştirilmez.
- **Gerekçe:** Ekip arkadaşı GitHub'dan devam edebilsin; günlük dal düzeni korunsun.
- **Onaylayan:** İNSAN

## 2026-10-26 · YunPanel iş sırası
- **Karar:** (1) Mevcut özelliklerin hepsi gerçek tarayıcıda, gerçek kullanıcı gibi manuel test edilir ve raporlanır. (2) Mevcut özelliklere mock/sahte API olmadan gerçek senaryo testleri yazılır. (3) Plesk'te sık kullanılıp YunPanel'de olmayan özellikler eklenir; listeyi İNSAN verir.
- **Gerekçe:** 162 Plesk özelliğinden hiçbiri doğrulanmış değil (9 kritik açık, 31 kısmi, 84 incelenmedi); önce gerçek durum ölçülmeli.
- **Onaylayan:** İNSAN

## 2026-10-26 · 1. dalga: manuel test
- **Karar:** "Sonraki faz" ve "Ayrı hat" dışındaki 124 özellik ID'sinin her biri ayrı görevdir; Antigravity kesintisiz yürütür, senior ertesi gün raporları inceler.
- **Hatalar:** Kritik hata (testi engelleyen, veri kaybı/bozulması, güvenlik/tenant sızıntısı, servis çökmesi) bulunduğu an bulgu görevi olur ve düzeltilir. Kritik olmayan hatalar yalnız rapora yazılır; 1. dalga sonunda İNSAN önceliklendirir.
- **Canlı test eşzamanlılığı:** "Canlı test tek kilitle" kararının yerine geçer. `.28`'de aynı anda en fazla 3 ajan (`sunucu-28-1/2/3` kilitleri), her ajan kendi önekli kaynaklarında; sunucu geneli işlemler `sunucu-28-genel` kilidiyle tek ajan.
- **Onaylayan:** İNSAN

## 2026-10-26 · Mevcut testler önce incelenir
- **Karar:** Bir özellik için test varsa önce incelenir ve çalıştırılır. Doğru ve yeterliyse (GEÇERLİ) yeniden yazılmaz, korunur ve yalnız çalıştırılır. YÜZEYSEL, MOCK, YANLIŞ veya KIRMIZI olan düzeltilir; testi olmayan senaryo (EKSİK) yazılır. 1. dalgada her manuel test görevi o özelliğin test envanterini ve sınıflarını rapora yazar ama test dosyasını değiştirmez; 2. dalga bu envanterden üretilir.
- **Gerekçe:** ~1000 test dosyası zaten var; aynı işi tekrar yazmak zaman kaybı. Ama 82 dosyada mock/stub izi var ve audit yüzeysel testler tespit etti; "test var" demek doğru olduğu anlamına gelmez.
- **Onaylayan:** İNSAN

## 2026-10-27 · 1. dalga hız ve token ayarı
- **Karar:** Yuva sayısı 6 → 4 (3 canlı test + 1 inceleme/kritik düzeltme). İnceleme hafif: rapor kontrolü + tek fiziksel kontrol (`curl`/`dig`/SSH okuma); tarayıcıda tekrar yalnız ÇALIŞIYOR raporlarında. Rapor en fazla 80 satır, ekran görüntüsü yalnız hata için. KRİTİK bulgular her zaman sıranın başında (`priority_patterns`).
- **Gerekçe:** İlk gecede 17 görev ~3,5 saat aktif çalışmada bitti, kota bitti (21:05–01:17 boşluk); `.28` 3 kilitle sınırlı olduğu için 6 ajanın ikisi bekleyerek token harcıyordu; raporlar ortalama 33 KB idi; kritik bulgular T800/T801 dosya sırası yüzünden 6 saat bekledi.
- **Onaylayan:** İNSAN
