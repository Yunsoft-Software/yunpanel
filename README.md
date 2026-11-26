# YunPanel

Yunsoft'un hosting paneli. Plesk Obsidian'ın ekran düzenini, iş akışlarını ve özelliklerini Node/React ile karşılar. Günlük merkez Web Siteleri ekranıdır. Dosya, veritabanı, SSL, posta, DNS, çalışma ortamı, yedek ve erişim aynı site bağlamında yönetilir.

**İlk okunacak belge: [docs/DEVIR.md](docs/DEVIR.md).** Güncel durum, çalışma düzeni, test sunucusu, kurulum ve bilinen tuzaklar oradadır. Bağlayıcı kurallar [agents.md](agents.md) içindedir.

## Belge haritası

| Belge | Ne için |
| --- | --- |
| [docs/DEVIR.md](docs/DEVIR.md) | Şu anki durum. Buradan başlayın. |
| [agents.md](agents.md) | Bağlayıcı çalışma ve güvenlik kuralları |
| [docs/orkestra/PROJE.md](docs/orkestra/PROJE.md) | Senior/junior düzeni, kilitler, doğrulama |
| [plan.md](plan.md) | Açık uygulama işleri |
| [todo.md](todo.md) | Açık gerçek host ve tarayıcı kabulleri |
| [docs/yapilanlar.md](docs/yapilanlar.md) | Biten işler, en yeni üstte |
| [docs/plesk-feature-parity.md](docs/plesk-feature-parity.md) | Plesk karşılaştırması: 162 özellik ve eksikler |
| [docs/ui-plan.md](docs/ui-plan.md) | Ekran ve akış sözleşmesi |
| [docs/gorevler/](docs/gorevler/) | Görev sözleşmeleri ve kabul kayıtları |
| [docs/architecture.md](docs/architecture.md) | Kimlik, motor, işlem ve rol sınırı |
| [docs/security.md](docs/security.md) | Auth, tenant, secret ve veri koruma |
| [docs/operations.md](docs/operations.md) | Yedek, taşıma, kurtarma ve dağıtım |
| [docs/development.md](docs/development.md) | Çalıştırma ve doğrulama |
| [docs/history/](docs/history/) | Tarihli eski planlar, raporlar ve denetimler |

Diğer başvuru belgeleri `docs/` altındadır: alan adı hiyerarşisi, site çalışma alanı, yerel yürütücü güvenliği, yerel taşıma ve yedek, paket izinleri, lisans yapılandırması, otomasyon API'si ve test senaryoları matrisi. Yayımlanan ürün dokümanı `docs/yunpanel-docs-0.3.0/` içindedir.

## Çalıştırma

Node >=24.11.1 ve npm >=11. `npm ci`, `npm run dev`, `npm run check` (lint, test, derleme). Ubuntu 24.04 ilk hedeftir; Debian 12 Contabo sunucularında ayrıca doğrulandı. Diğer dağıtımlar, Windows ve harici/premium entegrasyonlar kendi kabul hattındadır.

Production tek yerel hosttur. Root yetkisi yalnız backend'dedir; site işleri ayrı Unix kullanıcısında çalışır. `.44` ile biten Plesk sunucusuna dokunulmaz; `.28` test hedefi repo dışındaki `.local/test-server.env` ile doğrulanır.

Yerel kimlik kontrolü: `local-runtime.mjs validate <server-uuid>`. Değişiklikten önce doğrulanmış yedek: `create --backup-dir /var/backups/yunpanel/migration-<timestamp> --confirm`. Ayrıntı [operasyon belgesinde](docs/operations.md).
