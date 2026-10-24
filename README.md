# YunPanel

Yunsoft'un Plesk Obsidian ekran düzenini, kullanım akışlarını ve özelliklerini mevcut Node/React altyapısıyla uyarlayan hosting paneli. Günlük merkez Web Siteleri ve Alan Adları; dosya, veritabanı, SSL, posta, DNS, runtime, yedek ve erişim aynı site bağlamında.

9–10 Ekim 2026 incelemesi: .28'de güncel kaynak çalışıyor; günlük iş akışları ve gerçek sonuç/kabul zincirinde somut açıklar var. Kaynak testi, katalog veya Code Factory DONE ürün kabulü yerine geçmez. Gerçek 320 tarayıcı vakası ve izole host işlemleri yürütüldü; başarısız işlevler audit/plan içinde. 10 Ekim kullanıcı UI/UX ve hata düzeltme planının uygulanmasını onayladı. Kaynak geliştirmesi sürüyor; yeni deployment için ayrı hedef/kapsam onayı gerekir.

| Belge | İçerik |
| --- | --- |
| [agents.md](agents.md) | Bağlayıcı çalışma ve güvenlik kuralları |
| [plan.md](plan.md) | Öncelikli açık uygulama işleri |
| [ui-plan.md](ui-plan.md) | Plesk ekran/akış sözleşmesi |
| [todo.md](todo.md) | Gerçek host ve tarayıcı kabulü |
| [Audit](docs/audit-2026-10-09.md) | Kanıtlı kusurlar ve inceleme sınırı |
| [162 özellik](docs/plesk-feature-parity.md) | Kaybolmayan tam hedef kapsam |
| [Mimari](docs/architecture.md) | Kimlik, motor, işlem ve rol sınırı |
| [Güvenlik](docs/security.md) | Auth, tenant, secret ve veri koruma |
| [Operasyon](docs/operations.md) | Backup, migration, recovery ve dağıtım |
| [Geliştirme](docs/development.md) | Çalıştırma ve doğrulama |

Node >=24.11.1, npm >=11; npm ci, npm run dev, npm run check. Ubuntu ilk hedef; Windows ve harici/premium entegrasyon kendi native kabul hattındadır. Sade reseller ilk sürümde kalır; paket/abonelik uzun vadeli envanterde korunur.

Production tek yerel host; root backend, site workload dedicated Unix kullanıcı. .44 yasak; .28 hedefi private test-server.env'den doğrulanır. Local identity: local-runtime.mjs validate <server-uuid>; mutation öncesi doğrulanmış backup: create --backup-dir /var/backups/yunpanel/migration-<timestamp> --confirm. Ayrıntı operasyon belgesinde.

Dokümanlar 9 Ekim'de birleştirildi. Eski rapor/sözleşmeler development@e997bdf9053cea895eba1e7ae947a3ec4fddf059 Git ağacında; Code Factory sonuçları görev/run/event kayıtlarında. done.md kısa geçmiş açıklamasıdır. Bu temizlik özellik/servis/API silme veya canlı dağıtım değildir.
