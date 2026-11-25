# 22 Kasım 2026 · Contabo üzerinde iki yönlü YunPanel geri yükleme

İki yeni Contabo kurulumunda `amd64` YunPanel `0.3.0-2026112104` (`6708dc07`), Node.js `24.21.0` ve Restic `0.19.1` çalıştırıldı. Paket bütünlüğü ve sağlayıcıdaki sunucu/IP eşleşmesi doğrulandı. Kurulum sonrasında her sunucuda panel sayfası, API sağlık kontrolü ve web üzerinden API sağlık kontrolü HTTP 200 döndü.

| Yön | Hedef PHP | PHP HTTP | MariaDB | Dovecot IMAP | Restic snapshot |
| --- | --- | --- | --- | --- | --- |
| Debian 12 `217.216.33.14` → Ubuntu 24.04 `46.250.231.212` | 8.3 | 200, kaynakla aynı SHA-256 | 2 Türkçe UTF-8 satır, aynı veri özeti | 1 ileti, aynı RFC822 SHA-256 | `ed2ba4df344d` |
| Ubuntu 24.04 `46.250.231.212` → Debian 12 `217.216.33.14` | 8.2 | 200, kaynakla aynı SHA-256 | 2 Türkçe UTF-8 satır, aynı veri özeti | 1 ileti, aynı RFC822 SHA-256 | `857afc3bea3a` |

- Her kaynakta paketin `local-migration-backup.mjs create --confirm` komutuyla yedek üretildi. Yönlerin şifreli Restic depoları hem kaynakta hem hedefte `check --read-data` kontrolünden geçti. Aktarım sırasında kaynak, ara kopya ve hedef arşiv SHA-256 değerleri eşleşti.
- Hedefte paketli `preflight`, `verify`, `preview` ve `stage` çalıştı. Her yönde 38 arşiv üyesi doğrulandı. Operatör betiği özel hazırlık dizininden yalnız test sitesinin dosya, SQL ve Maildir verisini uyguladı. Hedefin kendi PHP-FPM sürümü ve ayrı Unix kullanıcı kimliği kullanıldı. Tam arşiv canlı köke açılmadı.
- Her iki hedefte mevcut test sitesine ait sekiz HTTP, SQL, IMAP, Unix ve Nginx karşılaştırması geri yükleme boyunca eşleşti. Son temizlik test sitelerini, SQL kullanıcılarını, posta kutularını, şifreli test depolarını ve geçici parolaları kaldırdı. Kurulu YunPanel servisleri ve yerel HTTP sağlık kontrolleri temizliğin ardından geçti.
- Canlı çalıştırmada başlangıç kontrolü Node.js dinleyicisini süreç adı yüzünden yanlış işaretledi. Yerel test betiği systemd PID eşleşmesini kontrol edecek biçimde düzeltildi. Boş Restic deposunu ilk kez yoklayan komutun çalışma dizinini erken temizlemesine neden olan test betiği hatası da düzeltildi ve iki yön yeniden çalıştırıldı. Ürün kaynakları değişmedi.

Bu çalışma paketli taşıma komutları ve operatör betiğiyle yapılan site, SQL ve posta provasıdır. WordPress ve panel hesabı dahil kaynak kapalıyken bağımsız depodan kurtarma ayrı koşuda doğrulandı. SMTP teslimatı ve genel DNS kullanılmadı. Panel ve test IMAP erişimi sunucu içinde doğrulandı. [Kaynak kapalı kurtarma kaydı](contabo-cold-recovery-20261122.md)

Yerel kabul kayıtları `.local/contabo-cross-restore/live-20261122/evidence/` altında. Kaynak ve hedef kayıtları `*-backup-source.json`, `*-transfer.json`, `*-restore-target.json`, `*-cleanup-foreign.json` ve `*-teardown.json` dosyalarıdır.
