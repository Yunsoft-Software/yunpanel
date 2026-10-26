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
