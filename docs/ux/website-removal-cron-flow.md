# REMOVE-CRON — Site silmede doğrulanmış zamanlanmış görev temizliği

2026-09-24; başlangıç `development@fd1a5642`. BUG-20260923-02 / UX-PL-06 kaynak dilimi. Mevcut website-removal, cron.remove, job registry ve /etc/cron.d yöneticisi kullanılır; yeni cron veya root komut motoru kurulmaz.

- [x] RC-01: `6e2aa1c2`; cron silme `accepted/deleted` ayrımını korur. `cron.remove` worker exact host resultini doğrular, metadata'yı revision ile kaldırır, yokluğu yeniden okur ve durable receipt yazar; queued/running job silinmiş sayılmaz.
- [x] RC-02: `dedb4848`, `8876be3d`, `2d92f9cc`; Website removal artık metadata-only `removeTask` çağırmıyor. Planlı task identity journal checkpoint'e yazılır; deterministic `cron.remove` idempotency key ile mevcut job bulunur/oluşturulur; queued/running parent step'i bitirmez, succeeded job + metadata yokluğu doğrulanmadan `cronsCleaned` üretilmez.
- [x] RC-03: `2ead7dc2`; production Website removal runtime ortak audited/durable `jobRegistry` ile bağlandı. Önizleme cron planı varken checkpoint/list/get/enqueue/idempotent-lookup bağımlılıklarını start öncesi fail-closed doğrular; mevcut cron ekranı/tekil delete response sözleşmesi değiştirilmedi.
- [ ] RC-04: `ea53f6d3`, `54882e9b`, `c1f04c24` ile queued→succeeded, enqueue/checkpoint crash recovery, inventory drift, failed/cancelled job, dependency gate ve journal checkpoint kaynak testleri eklendi/güncellendi. Bu oturumda gerçek checkout olmadığı için çalıştırılmış sayılmaz; Node24/npm11 kapısı aşağıda açık.

## Açık sınırlar

Canonical file cleanup ve provisioning receipt-owned Unix identity cleanup artık production composition'a bağlıdır; bunların gerçek host kabulü hâlâ açıktır. Ayrıca bütün Website yazıcılarının ortak kilidi, çalışmaya başlamış cron süreçlerinin durması, tenant yetkisinin worker anında doğrulanması ve gerçek host kabulü ayrı açık kalır. Bir zamanlayıcı dosyasının kaldırılması önceden başlamış işi durdurduğu anlamına gelmez. `direct-systemd` cleanup ve legacy/unowned Unix identity hâlâ fail-closed blocker olabilir. Yedek/retention ve başka siteye dokunmama şartları kaldırılmaz.

## T-DEV-REMOVE-CRON — Gerçek kabul

- [ ] Node24/npm11 tam checkout/npm ci/lint/test/build; cron ve website-removal regresyonları birlikte çalışsın.
- [ ] Owner ve Site A/Site B sınırları, iki süreç/tarayıcı, apply/remove yarışı, worker/reply kaybı, disk yazma hatası ve restart. Kayıt veya job eksikliği tek başına tamamlanma sayılmasın.
- [ ] İzinli test hostunda yalnız hedef /etc/cron.d girdilerinin kaldırılması, diğer sitenin görevlerinin korunması; zaten çalışan görevler ve cron reload davranışı ayrı doğrulansın. `.44` kesinlikle hariç.
- [ ] Gerçek site silme ekranında queued/blocked/failed/complete ayrımı, mevcut cron işine dönüş ve kontrollü devam; `direct-systemd`, legacy/unowned Unix receipt veya unsafe path blockerları fail-closed kalmalı.

GitHub Actions, main değişikliği ve canlı deploy yapılmaz. Kaynak alt işleri tamamlanınca üst BUG-02/production otomatik kapanmaz.


## 2026-09-25 devam — worker authorization

- [x] User cron create/update/delete exact session/user/role ile queue edilir.
- [x] Local cron worker site mutation lock sonrasında canlı session, role, Owner MFA veya site_manager Website grant'ını yeniden doğrular; revoke olmuş actor hosta dokunamaz.
- [x] Website removal cron cleanup ayrı `system_removal` authorization modu kullanır; protocol ve worker bu modu yalnız `cron.remove` için kabul eder.
- [ ] Gerçek logout/grant revoke ile queued job, iki process worker ve Node24/npm11 acceptance çalıştırılmalı.
