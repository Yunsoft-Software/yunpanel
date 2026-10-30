# G3 — .28 test kalıntılarının temizliği (30-10-2026)

`.28`'deki 244 alan adının 201'i eski özellik testlerinden kalmış (`t<grup><no>-…`). Artık posta alan adlı siteler de silinebiliyor (T824/T825).

Ortak kurallar: yalnız `^t[a-z]{3}[0-9]{2}-` önekli **ve** listedeki gruba ait alan adlarına dokun; diğer her şey yalnız okunur. Silme yalnız panelin normal akışıyla (`Siteyi sil…` → onay; durursa `Silme işlemine devam et…`, alan adı silmesi için `/api/panel/domains/:id/removal-operations/:op/continue`). Registry/veritabanı dosyası düzenleme, `rm`, servis restart, glob temizlik yasak. 10'arlık partiler; her partide işlenen/silinen/takılan sayısını rapora yaz. Takılan her biri için hata kodunu not et; aynı kod 3+ kez çıkarsa `orchestrator.py finding` ile bulgu aç ve o kodu atla. Bilinen takılmalar: `mail_domain_removal_config_preview_stale` (T850), `domain_removal_domain_not_stable`/draft (T826) — bunları atla. `teml09-*` siteleri SENIOR'da, dokunma. `test-results/` içeriğini rapora kopyalama.

### T853 · .28 test kalıntısı temizliği: tweb01–tweb08
- **Bağımlı:** —
- **Dosyalar:** `docs/manuel-test/temizlik-T853.md`
- **İş:** tweb01–tweb08 öneklerine ait site/alan adlarını ortak kurallarla panelden sil. Önce salt-okunur liste çıkar (alan adı, durum, site var mı, posta var mı), rapora yaz, sonra sil. `sunucu-28-n` kilidiyle çalış.
- **Kabul:** Rapor ≤40 satır: başlangıç/bitiş sayıları, silinen, atlanan (kodlarıyla). Koşu sonunda bu gruptan yalnız bilinen takılmalar kalıyor; ilgisiz alan adı sayısı değişmemiş (önce/sonra sayımı).

### T854 · .28 test kalıntısı temizliği: trun01–trun08
- **Bağımlı:** —
- **Dosyalar:** `docs/manuel-test/temizlik-T854.md`
- **İş:** trun01–trun08 öneklerine ait site/alan adlarını ortak kurallarla panelden sil. Önce salt-okunur liste çıkar (alan adı, durum, site var mı, posta var mı), rapora yaz, sonra sil. `sunucu-28-n` kilidiyle çalış.
- **Kabul:** Rapor ≤40 satır: başlangıç/bitiş sayıları, silinen, atlanan (kodlarıyla). Koşu sonunda bu gruptan yalnız bilinen takılmalar kalıyor; ilgisiz alan adı sayısı değişmemiş (önce/sonra sayımı).

### T855 · .28 test kalıntısı temizliği: tdev01–tdev06
- **Bağımlı:** —
- **Dosyalar:** `docs/manuel-test/temizlik-T855.md`
- **İş:** tdev01–tdev06 öneklerine ait site/alan adlarını ortak kurallarla panelden sil. Önce salt-okunur liste çıkar (alan adı, durum, site var mı, posta var mı), rapora yaz, sonra sil. `sunucu-28-n` kilidiyle çalış.
- **Kabul:** Rapor ≤40 satır: başlangıç/bitiş sayıları, silinen, atlanan (kodlarıyla). Koşu sonunda bu gruptan yalnız bilinen takılmalar kalıyor; ilgisiz alan adı sayısı değişmemiş (önce/sonra sayımı).

### T856 · .28 test kalıntısı temizliği: tbak03, tbak06, tdkr04, tmon03, tmon04, tpln08, tsys06, ttls01, ttls02
- **Bağımlı:** —
- **Dosyalar:** `docs/manuel-test/temizlik-T856.md`
- **İş:** tbak03, tbak06, tdkr04, tmon03, tmon04, tpln08, tsys06, ttls01, ttls02 öneklerine ait site/alan adlarını ortak kurallarla panelden sil. Önce salt-okunur liste çıkar (alan adı, durum, site var mı, posta var mı), rapora yaz, sonra sil. `sunucu-28-n` kilidiyle çalış.
- **Kabul:** Rapor ≤40 satır: başlangıç/bitiş sayıları, silinen, atlanan (kodlarıyla). Koşu sonunda bu gruptan yalnız bilinen takılmalar kalıyor; ilgisiz alan adı sayısı değişmemiş (önce/sonra sayımı).

