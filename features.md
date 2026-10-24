# YunPanel — Kısa özellik haritası

Bu dosya tamamlandı raporu değildir. Plesk hedefinin 21 grup / 162 ID'si [parity envanterinde](docs/plesk-feature-parity.md), açık uygulama [plan.md](plan.md), tasarım [ui-plan.md](ui-plan.md), fiziksel kabul [todo.md](todo.md).

- Hesaplar: Owner, isteğe bağlı tek reseller katmanı, Customer/site yöneticileri, native auth/session/MFA/permissions/audit.
- Hosting: Website/Domain/Application, domain/alias/subdomain, Nginx, dedicated Unix user, redirect/SSL/DNS, safe lifecycle.
- Dosya/erişim: global Files + site File Manager, mevcut elFinder/FilesPanel, SFTP/SSH, site terminali; Owner root terminali ayrı.
- Runtime/dev: statik, Node/Passenger, PHP-FPM, Python ve Docker adapterları; Git, environment, deployment/rollback, Composer/WP/Laravel araçları. Her alt davranışın gerçek kabulü ayrı.
- DB: MariaDB, schema/binding/credential/grant, phpMyAdmin, backup/restore ve güvenli silme; tek form/connection-info açık. PostgreSQL ayrı koşullu hedef.
- Mail: domain/mailbox/alias/forward/auto-reply/quota/spam/DKIM, Roundcube/SMTP/IMAP, credential/lifecycle ve ayrı restore.
- Backup/jobs: Restic, scope/targets/schedule/restore, operation registry, durable intent/lock/idempotency/receipts/recovery; startup worker bağlantısı açık.
- Sunucu: package/service/runtime inventory, update, network/firewall/security, cron/log/monitoring/statistics, DNSSEC/secondary ve DR kabulü.
- YunPanel'e özgü mevcut AI/Codex/terminal yardımcıları ve sağlayıcı secret/budget/recovery sınırları korunur; Plesk temel görevlerini tamamlamanın önkoşulu olmaz.
- Uzun vade: paket/abonelik/add-on/overselling, migration/importer, API/CLI/SSO, vendor/marketplace/Windows eşdeğerleri. Sade reseller ilk sürümde ertelenen kapsam bitmiş sayılmaz.

Bir adapter/saf politika/endpoint/katalog/mock testi özellik kabulü değildir. Gerçek rol/ekran → API → host sonucu ve failure/restart/rollback kanıtı gerekir. Eksiklerin önceliği [9 Ekim araştırmasında](docs/audit-2026-10-09.md).
