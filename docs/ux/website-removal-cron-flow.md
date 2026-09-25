# REMOVE-CRON — Site silmede doğrulanmış zamanlanmış görev temizliği

2026-09-24; başlangıç `development@fd1a5642`. BUG-20260923-02 / UX-PL-06 kaynak dilimi. Mevcut website-removal, cron.remove, job registry ve /etc/cron.d yöneticisi kullanılır; yeni cron veya root komut motoru kurulmaz.

- [x] RC-01: `6e2aa1c2`; cron silme `accepted/deleted` ayrımını korur. `cron.remove` worker exact host resultini doğrular, metadata'yı revision ile kaldırır, yokluğu yeniden okur ve durable receipt yazar; queued/running job silinmiş sayılmaz.
- [ ] RC-02: Website silmedeki yanlış removeTask metadata çağrısını mevcut cron.remove işiyle değiştir. Planlı görev kapsamı, kalıcı işlem kanıtı, mevcut işi okumayla devam ve silinmiş görevin kanıtı korunsun.
- [ ] RC-03: Gerçek üretim bileşimine gerekli cron servis/job bağlantısını ekle; eksik dosya/Unix temizliği kapıları gevşetilmesin. Mevcut cron ekranı ve response sözleşmesi yeni queued durumuyla uyumlu kalsın.
- [ ] RC-04: Yapılabilen davranış/gerçek geçici dosya ve modül entegrasyon testlerini çalıştır; çalıştırılmayanları ayrı yaz.

## Açık sınırlar

Canonical file cleanup ve provisioning receipt-owned Unix identity cleanup artık production composition'a bağlıdır; bunların gerçek host kabulü hâlâ açıktır. Ayrıca bütün Website yazıcılarının ortak kilidi, çalışmaya başlamış cron süreçlerinin durması, tenant yetkisinin worker anında doğrulanması ve gerçek host kabulü ayrı açık kalır. Bir zamanlayıcı dosyasının kaldırılması önceden başlamış işi durdurduğu anlamına gelmez. `direct-systemd` cleanup ve legacy/unowned Unix identity hâlâ fail-closed blocker olabilir. Yedek/retention ve başka siteye dokunmama şartları kaldırılmaz.

## T-DEV-REMOVE-CRON — Gerçek kabul

- [ ] Node24/npm11 tam checkout/npm ci/lint/test/build; cron ve website-removal regresyonları birlikte çalışsın.
- [ ] Owner ve Site A/Site B sınırları, iki süreç/tarayıcı, apply/remove yarışı, worker/reply kaybı, disk yazma hatası ve restart. Kayıt veya job eksikliği tek başına tamamlanma sayılmasın.
- [ ] İzinli test hostunda yalnız hedef /etc/cron.d girdilerinin kaldırılması, diğer sitenin görevlerinin korunması; zaten çalışan görevler ve cron reload davranışı ayrı doğrulansın. `.44` kesinlikle hariç.
- [ ] Gerçek site silme ekranında queued/blocked/failed/complete ayrımı, mevcut cron işine dönüş ve kontrollü devam; `direct-systemd`, legacy/unowned Unix receipt veya unsafe path blockerları fail-closed kalmalı.

GitHub Actions, main değişikliği ve canlı deploy yapılmaz. Kaynak alt işleri tamamlanınca üst BUG-02/production otomatik kapanmaz.
