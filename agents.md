# YunPanel Agent Rules

Bu dosya YunPanel reposunda çalışan tüm geliştiriciler ve kodlama ajanları için bağlayıcı proje kurallarını tanımlar.

## 1. Projenin amacı

YunPanel, Yunsoft'un kendi sunucularında Plesk bağımlılığını zamanla azaltmak ve mümkün olan yerlerde ortadan kaldırmak için geliştirilen bir hosting/server yönetim panelidir.

İlk hedef genel amaçlı ticari bir Plesk klonu yapmak değildir. Öncelik Yunsoft'un gerçek kullanım senaryolarıdır:

- Node.js uygulamaları,
- Passenger uyumlu mevcut uygulamalar,
- systemd ile çalışan Node.js uygulamaları,
- React/Vite gibi statik build çıktıları,
- Docker ve Docker Compose projeleri,
- domain ve reverse proxy yönetimi,
- Let's Encrypt SSL,
- MySQL/MariaDB,
- Git tabanlı deploy,
- environment variable yönetimi,
- cron/scheduled jobs,
- loglar,
- backup/restore,
- mail hesapları ve Roundcube,
- temel sunucu monitoring ve güvenlik işlemleri.

## 2. Teknoloji kuralları

### Frontend

- Frontend React ile geliştirilecek.
- TypeScript KULLANILMAYACAK.
- `.ts` ve `.tsx` dosyaları eklenmeyecek.
- Frontend kaynakları JavaScript/JSX olacak.
- Gereksiz frontend framework veya ağır bağımlılıklar eklenmeyecek.
- UI, hosting ve server operasyonlarını hızlı ve anlaşılır hale getirmeye odaklanacak.

### Backend

- Backend Node.js tabanlı olacak.
- Yönetim API'si ile ayrıcalıklı sunucu işlemleri birbirinden ayrılacak.
- Panel web/backend süreci root olarak çalıştırılmayacak.
- Root gerektiren işlemler ayrı bir `yun-agent`/privileged agent katmanından geçirilecek.
- Arbitrary shell command çalıştırma API'si oluşturulmayacak.
- Agent sadece açıkça tanımlanmış ve doğrulanmış operasyonları kabul edecek.

Örnek operasyon isimleri:

- `server.inspect`
- `domain.create`
- `domain.update`
- `domain.delete`
- `ssl.issue`
- `ssl.renew`
- `app.deploy`
- `app.restart`
- `app.rollback`
- `docker.deploy`
- `database.create`
- `database.backup`
- `mailbox.create`
- `backup.run`

## 3. Destek matrisi

İlk sürüm gereksiz uyumluluk yükü almamalıdır.

Başlangıç hedefi:

- Ubuntu 24.04 LTS
- Nginx
- Node.js LTS
- systemd
- isteğe bağlı Passenger compatibility
- Docker Engine + Docker Compose plugin
- MySQL/MariaDB
- Let's Encrypt / ACME
- Postfix + Dovecot + Rspamd tabanlı mail stack
- Roundcube webmail

Başka Linux dağıtımları veya hosting stack'leri yalnızca planlı bir milestone kapsamında eklenebilir.

## 4. Git ve commit kuralları

- HER ZAMAN küçük commitlerle ilerle.
- Bir commit mümkün olduğunca tek mantıksal değişiklik içermelidir.
- Büyük, alakasız değişiklikleri tek commit altında toplama.
- Refactor ile özellik geliştirmeyi mümkünse ayrı commitlerde tut.
- Commit mesajları kısa, açıklayıcı ve değişikliğin amacını belirtecek şekilde yazılmalıdır.
- Mevcut çalışan özellikleri sırf temizlik amacıyla gereksiz yere yeniden yazma.
- İlgisiz dosyalara dokunma.

Örnek commit mesajları:

- `docs: define project agent rules`
- `feat: add server inventory endpoint`
- `feat: add static app deployment model`
- `fix: prevent duplicate nginx host creation`
- `test: cover failed deployment rollback`

## 5. GitHub Actions kesinlikle yasak

- GitHub Actions KULLANILMAYACAK.
- `.github/workflows/` altında workflow oluşturma.
- Test, build, deploy, release veya başka herhangi bir amaçla GitHub Actions ekleme.
- Var olmayan bir Actions altyapısını projeye dahil etme.
- Otomasyon gerekiyorsa YunPanel'in kendi deploy/job sistemi, yerel scriptler veya açıkça seçilmiş harici altyapı kullanılmalıdır.

## 6. Güvenlik kuralları

YunPanel yüksek yetkili sunucu operasyonları yaptığı için güvenlik özellik değil, çekirdek gereksinimdir.

- Panel backend'i root olarak çalıştırılmayacak.
- Root yetkili agent minimum izinle tasarlanacak.
- Shell injection'a açık string birleştirme yapılmayacak.
- Komut argümanları allowlist ve schema doğrulamasından geçirilecek.
- Domain, path, username, service name ve environment inputları doğrulanacak.
- Path traversal engellenecek.
- Secrets loglara yazılmayacak.
- Environment variable değerleri maskelenebilir olmalı.
- Şifreler geri döndürülemez biçimde hash'lenmeli.
- API tokenları güvenli biçimde saklanmalı.
- Hassas işlemler audit log'a yazılmalı.
- Destructive işlemler açık ve doğrulanabilir olmalı.
- Backup olmadan geri dönüşü zor destructive migration yapılmamalı.
- Uygulamalar birbirinin dosyalarına erişemeyecek şekilde kullanıcı/izin izolasyonu hedeflenmeli.

## 7. Deploy kuralları

YunPanel ilk sürümde üç ana application type destekleyecek:

### Static

Örnek akış:

`git clone/pull -> install -> build -> release directory -> nginx root switch -> health check`

### Node.js

Öncelikli yeni uygulama akışı:

`git clone/pull -> install -> build -> release directory -> systemd service -> nginx reverse proxy -> health check`

Mevcut Plesk uygulamaları için Passenger compatibility sonradan/ayrı adapter olarak korunabilir.

### Docker

Örnek akış:

`git clone/pull -> validate compose -> pull/build -> compose up -> health check -> proxy switch`

Deploy sistemi mümkün olduğunca atomik ve rollback edilebilir olmalıdır.

## 8. Konfigürasyon yönetimi

- Nginx, systemd, mail ve diğer servis konfigürasyonları template/adapter katmanından üretilmeli.
- Doğrudan birçok yerde string halinde config üretme.
- Üretilen konfigürasyon uygulanmadan önce validate edilmeli.
- Nginx değişikliğinde önce `nginx -t` benzeri doğrulama yapılmalı, sonra reload uygulanmalı.
- Servis reload/restart başarısız olursa önceki çalışan config korunmalı veya geri yüklenmeli.

## 9. Veri modeli ilkeleri

Temel domain modelleri en az şunları kapsamalıdır:

- servers
- users
- roles
- applications
- deployments
- domains
- certificates
- databases
- database_users
- environment_variables
- cron_jobs
- backups
- backup_targets
- mail_domains
- mailboxes
- aliases
- docker_projects
- audit_logs
- jobs
- service_events

Veri modeli UI ekranlarına göre değil, gerçek server state ve lifecycle'a göre tasarlanmalıdır.

## 10. Async job yaklaşımı

Deploy, backup, restore, certificate issuance, Docker build ve benzeri uzun işlemler HTTP request içinde bloklanmamalıdır.

- İşler job queue üzerinden yürütülmeli.
- Job durumları tutulmalı: `queued`, `running`, `succeeded`, `failed`, `cancelled`.
- Log stream veya job log kayıtları bulunmalı.
- Aynı kaynağa zarar verebilecek çakışan operasyonlar lock edilmelidir.

## 11. Test yaklaşımı

Özellikle aşağıdaki alanlar testsiz bırakılmamalıdır:

- permission kontrolleri,
- privileged agent validation,
- nginx config generation,
- systemd unit generation,
- path validation,
- deploy state transitions,
- rollback,
- backup manifest,
- destructive operations,
- secret masking,
- duplicate resource prevention.

Test çalıştırmak için GitHub Actions kullanılmayacak; testler lokal veya proje tarafından yönetilen runner/sunucu üzerinde çalıştırılacaktır.

## 12. `plan.md` ve `todo.md` kullanımı

- `plan.md` ürünün ve mimarinin ana geliştirme planıdır.
- Tamamlanan plan maddeleri güncellenebilir ancak geçmiş hedefler sebepsiz silinmemelidir.
- `todo.md`, bu geliştirme ortamında doğrudan yapılamayan, gerçek Plesk/sunucu erişimi gerektiren veya kullanıcı/Codex tarafından production ortamında uygulanması/test edilmesi gereken işleri içerir.
- Bu ortamda yapılamayan bir server/Plesk işi fark edildiğinde `todo.md` güncellenmelidir.
- Yapılabilecek kod işi sırf kolaylık olsun diye `todo.md`'ye atılmamalıdır.
- **`plan.md` ve `todo.md` geliştirmeden sonra topluca güncellenen rapor dosyaları değildir; geliştirmeyle paralel yaşayan kaynaklardır.**
- Bir plan maddesi kodla tamamlandığı veya kapsamı değiştiği anda aynı çalışma turunda `plan.md` güncellenmelidir.
- Gerçek sunucu/Plesk testi gerektiği fark edildiği anda aynı çalışma turunda `todo.md` maddesi eklenmeli; test yapıldığında sonuç, tarih ve durum yine aynı turda işlenmelidir.
- Kod ile `plan.md`/`todo.md` arasında bilinen bir uyumsuzluk bırakıp bir sonraki geliştirme işine geçmek yasaktır.

## 13. Kapsam kontrolü

İlk sürümde şu özellikler ana hedef değildir:

- reseller sistemi,
- müşteri faturalama,
- hosting paketleri,
- shared hosting quota ürünleştirmesi,
- çok sayıda Linux dağıtımı,
- WordPress Toolkit benzeri özel ekosistemler,
- cPanel/Plesk'in tüm historical compatibility davranışları.

Bu özellikler ancak Yunsoft'un gerçek ihtiyacı oluşursa veya YunPanel ticari ürüne dönüştürülürse ayrı milestone olarak ele alınmalıdır.

## 14. Çalışma prensibi

Her değişiklikte şu sıra izlenmelidir:

1. İlgili mevcut kodu ve dokümanı oku.
2. En küçük mantıksal değişikliği belirle.
3. Değişikliği uygula.
4. Mümkün olan test/validation işlemlerini yap.
5. Küçük commit oluştur.
6. Tamamlanan/değişen geliştirme durumunu aynı turda `plan.md`'ye işle.
7. Server/Plesk üzerinde yapılması gereken harici adım oluştuysa aynı turda `todo.md`'ye ekle; yapılmışsa sonucu işaretle ve doğrulama notunu yaz.
8. `plan.md`, `todo.md` ve kodun birbirini anlattığını kontrol et.
9. Bir sonraki bağımsız işe geç.

YunPanel'in hedefi çok özellikli görünmek değil; Yunsoft'un production sunucularını güvenli, öngörülebilir ve hızlı yönetmektir.
