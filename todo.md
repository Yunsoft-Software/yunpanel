# YunPanel — Açık canlı kabuller

Güncelleme: 26 Kasım 2026. Bu dosya yalnız açık gerçek host ve tarayıcı kabullerini tutar. Kapananlar ve eski giriş notları [arşivde](docs/history/todo-2026-11-26.md). Güncel durum [devir notunda](docs/DEVIR.md), açık kaynak işleri [plan.md](plan.md).

Canlı işler yalnız `.local/test-server.env` ile doğrulanan `.28` hedefinde ve izinli Contabo test sunucularında yapılır. `.44` ile biten Plesk sunucusu hiçbir kabulde kullanılmaz. Geçen alt test bütün kapıyı kapatmaz.

## Linux hosting pilotu ve Plesk geçişi

[Onaylanan plan](plan.md#20-kasım-2026--onaylanan-linux-hosting-pilotu-ve-plesk-geçişi) ve [yerel kanıt](docs/gorevler/linux-hosting-pilot.md#20-kasım-yerel-ubuntu-kanıtı) pilotu hazırlıyor. Aşağıdaki maddeler bağımsız ortamda sistem servisi, müşteri verisi ve canlı taşıma sonuçlarını izler.

- [ ] Tek veritabanlı PHP ve postalı WordPress pilotlarında izinli Plesk dışa aktarımı, dosya/SQL/posta bütünlüğü, aynı girdinin tekrar işlenmesi, DNS öncesi test ve son eşitleme doğrulanır. Prova sırasında hedefte yeni yazılmış içerik ve postalar korunarak geri dönülür.
- [ ] WordPress staging’den seçili tema ve eklenti dosyalarının panelde önizleme, kuyruk ve geri alma akışı gerçek Debian 12 PHP-FPM, MariaDB ve Chromium’da doğrulandı. Farklı tablo önekleri, canlı WordPress yazısı ve korunan dosyalar denetlendi. `.28` yayın kabulü bekleniyor. [Kabul kaydı](docs/gorevler/linux-hosting-pilot.md#22-kasım--wordpress-staging-dosyalarının-panelden-aktarımı)

## Ürün kabul kapıları

9–10 Ekim 2026'da açıldı. Önceki checkbox veya Code Factory DONE kanıt değildir.

Her senaryo: kaynak commit, çalışan API release, web asset/hash, tarih, rol, site/runtime, viewport, adımlar, beklenen/gerçek sonuç, okunabilir artifact ve fiziksel çıktı. Test parolası/cookie/token/private key raporda bulunmaz. Negatif, hata, restart ve rollback ayrı kaydedilir. Bu tur mutation izni var; yeni ortam veya mevcut kullanıcı verisini değiştiren kapsam için hedef/scope yeniden doğrulanır.

- [ ] **T-SSL / YP2-02:** gerçek yeni sertifika, değişmeyen sertifika, dry-run, failed/cancelled; registry/job/kart/SSL sayfası ve SNI TLS fingerprint/tarih eşitliği. Nginx/mail reload ve hata sonrası çalışan sertifika; restart ve gecikmiş eski poll.
- [ ] **T-DB / YP2-03/04:** boş sitede tek formdan schema+binding+credential+grant; gerçek uygulama SELECT, phpMyAdmin, parola/hak değişimi, bağlantı bilgisi ve yanlış-site retleri. Mevcut DB'yi bağla. SQL import/export/copy/repair yalnız gerçekten varsa ayrı kabul. Roundcube/sistem schema'ları saklı ve korumalı.
- [ ] **T-PHP / YP2-05:** gerçek PHP sürümü/FPM pool/socket/config değişimi, configtest/reload/health, disk kalıcılığı, bozuk ayarda rollback. UI formu ve kayıp cevap; eksik adapter success üretemez.
- [ ] **T-ROUTES / YP2-06:** /ssl, /cron, /backup, /backups, /logs, /php, /access; ilk açılış/reload/back/forward, tek/çok/hiç site, selected-site koruması ve yanlış Domain/Website/Application kimliği.
- [ ] **T-BACKUP / YP2-07:** `.28` üzerinde yalnız açık yedekleme/geri yükleme testi için yedek alınır; başarılı içerik/restore doğrulamasından sonra testin snapshot/arşivleri silinir ve yokluğu kanıtlanır. gerçek snapshot içinde site marker dosyası bulunmalı; current symlink tek başına backup değildir. Restore sonucu marker içeriği eski haline dönmeli; başarılı job/HTTP 200 yeterli değil.  gerçek Restic/rclone repository/snapshot; API/process crash ve aynı operation recovery; duplicate snapshot/restore yok. Dosya/DB/mail/config/relationships/keys geri yükleme, boş hedef, RPO/RTO, retention/schedule; verify başarısızsa işlem başarı olmaz.
- [ ] **T-VISUAL / YP2-08:** site kartı ve temel görevler Plesk referansıyla karşılaştırılır. 320/390/834/1440 px, %200 zoom, Chromium/Firefox, uzun domain, 100+ kayıt, loading/403/500/eksik servis, klavye/modal odak. Önizleme yerine authenticated ürün görevi.
- [ ] Son kullanıcı onayı için gerçek üretim bundle'ından masaüstü/tablet/mobil ekran görüntüleri üret; T-VISUAL kapsamında sürüm/rol/gerçek görev ve fiziksel sonuç kanıtıyla birlikte aç.
- [ ] Yeni tarayıcı profili Gece temasını açmalı; daha önce açık/sistem tema kaydeden kişinin tercihi değişmemeli. T-VISUAL'de gerçek browser/profile kabulü.
- [ ] **T-CREATE / YP2-09:** PHP/static/Passenger Node/Docker/Python destek sınırı; amaç bazlı form, site yöneticisi, Unix/release/document root, DNS/delegation/mail/SSL health, hata sonrası durable devam ve reverse compensation. Domain metadata'sı hazır Website değildir.
- [ ] **T-HOSTING / YP2-10:** document root, index/hata sayfası/redirect/www/Nginx; gerçek HTTP cevabı. Domain/subdomain/alias, DNSSEC DS/rollover, Cloudflare, local/secondary NS, propagation ve SSL/mail kapsamı. Tek IP'deki iki NS bağımsız redundancy değildir.
- [ ] **T-FILES / T-SITE-WORKSPACE / YP2-11:** global Files ve domain Files; gerçek list/upload/edit/save/rename/copy/move/archive/download/permissions/delete; draft/path/conflict ve symlink/traversal. Site A/B, gerçek Unix kullanıcı, ttyd ve elFinder socket; logout/rotation/suspend/removal açık bağlantıyı kapatır.
- [ ] **T-MAIL / YP2-11:** gerçek mailbox create/password/quota/alias/forward, SMTP/IMAP/POP3/webmail/discovery, SPF/DKIM/DMARC ve relay-abuse; tek mailbox silinirken kardeşinin mevcut ve yeni oturumu/teslimatı sürer. Backup/delete/finalize ve Dovecot cache/kick/LMTP yarışları.
- [ ] **T-JOBS / YP2-12:** çift tık, kayıp POST, uzun job, reload/tarayıcı kapanışı, iki process yarışları, diske yazma/crash, stale confirmation ve reauthorization. Kör retry yok; Güvenli otomatik retry/backoff/kalıcı bütçe ve site-admin hata yayılımı `plan.md` içinde açık backend işleridir.
- [ ] **T-ROLES / YP2-13/18:** bağlı site_manager hesap kapatma 409 hatasını gider; site verisini silmeden erişim/oturum/WS iptalini fiziksel doğrula.  doğru yönetim gateway yoluyla gerçek site consumption;  gerçek Owner, iki reseller, direct Owner customer, customer ve Site A/B; Files/DB/mail/job/log/backup/AI/tool/gateway/WS. Suspend/remove/logout/session rotation, quota ve veri içeren ownership migration/rollback. Sahipsiz kayda rastgele kullanıcı ataması yok.
- [ ] **T-LIFECYCLE / YP2-15:** 409 veren hazır-site removal önizlemesi, DB credential delete, mailbox backup/delete ve eksik Docker project remove akışları; audit run mv1f65iv-90e268 kapalı artıklarını temizleme.  site/domain silme/askı/resume, sibling veri korunması, gerçek cron/Unix/runtime/env/file/DB/mail/SSL/DNS cleanup; kalıcı receipt, interruption/recovery ve kontenjanın güvenli bırakılması.
  Alt kabul: temiz `.28` paketinde PHP havuzu, SFTP mount ve dokuz test sitesinin silme temizliği geçti; [ayrıntı](docs/history/todo-2026-11-26.md#11-ekim-2026--t-lifecycle--yp2-15-alt-kabul-kanıtı). Güncel kaynak paketiyle bütün silme akışının kabulü, PHP sürüm değişimi, imported pool, DB/mail bağımlılıkları ve tam kapı açık.
- [ ] **T-RUNTIME:** Passenger/static/direct-systemd uyumluluğu, PHP multi-version, Python venv/Gunicorn, Docker Compose volume/env/network ve Git build/deploy/restart/rollback; workload dedicated Unix kullanıcıda. Panel durunca hosted servisler devam eder.
- [ ] **T-SECURITY / T-DR:** auth/CSRF/MFA opsiyonel .28 politikası, Owner recovery mail, firewall/CrowdSec, port/allowlist, secret masking/master-key rotation ve private migration backup/restore. Paket upgrade/rollback, dpkg/Nginx/systemd sağlığı ve cold-start kalıcılığı.
- [ ] **T-AI:** iki kullanıcı/iki site sohbet geçmişi/stream/tool yetkileri, cancel/reconnect, cursor/pagination, migration, kayıp cevap ve provider sınırı. AI kabulü hosting görevlerinin yerine geçmez.
- [ ] **T-PARITY / T-PL / YP2-14:** [162 ID](docs/plesk-feature-parity.md) için gerçek endpoint + UI + host kanıtı. Windows/IIS/.NET/MSSQL ve premium/vendor hatları kendi ortamında; Linux mock veya unsupported adapter kabul değildir.
- [ ] **T-WP / YP2-16:** gerçek veritabanı ile WordPress install/login/admin-password/plugin/theme/update/clone/staging/uninstall; iki PHP girişinin tek doğru amaca bağlanması. Core download geçti; uygulama kurulum/kullanım kabulü açık.

Node >=24.11.1/npm >=11 tam lint/test/build uygulama diliminde çalıştırılır. Sonuçlar ve bağımsız review aynı candidate'a ait olmalı. Kök plan açık iş, bu belge dış kabul, Code Factory görev/run/event sonuç ve Git geçmişi eski belgelerin kaydıdır.
