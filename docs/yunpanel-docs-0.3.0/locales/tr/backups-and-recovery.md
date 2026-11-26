# Yedekleme ve Kurtarma

> **Sürüm:** YunPanel `0.3.0` · **Doğrulanmış kaynak revizyonu:** `c1a84a51` (`c1a84a5159add2f2f87fd6e21725f7c657cf98ec`) · **Doğrulanmış Linux `.deb` paket tabanı:** `0.3.0-2026112301` (`f13b2b78`) · **Arayüz dili:** Türkçe (`tr`)

YunPanel yedekleme mimarisi iki tamamlayıcı katmandan oluşur: **site bazlı Restic/rclone yedekleme ve geri yükleme** (panel arayüzünden) ve **kontrol düzlemi / sunucu kurtarma yedekleri** (yerel operatör CLI araçlarından).

## Site bazlı yedekleme ve geri yükleme (Restic & rclone)

Her web sitesinin **Yedekleme ve Geri Yükleme** (`/websites/<id>/backup`) sekmesi şifreli Restic depoları üzerinden çalışır:

- **Kapsam özeti:** Dosya yolları, bağlı MariaDB veritabanları, posta yapılandırması/verileri, DNS kayıtları, ortam değişkenleri ve Nginx/hosting ayarları tek kapsam özetinde gösterilir.
- **Yerel ve uzak depolar:** Yerel Restic deposuna ek olarak isimli **rclone** uzak hedefleri (ör. WebDAV / S3 uyumlu uzak depolar) şifreli kimlik bilgileriyle bağlanabilir.
- **Zamanlama ve saklama politikası (Plan ve Zamanlama):** Günlük, haftalık veya özel cron zamanlamasıyla otomatik yedekleme ve saklama (retention) kuralları tanımlanabilir.
- **Doğrulanmış geri yükleme:** Geri yükleme öncesinde seçilen snapshot içeriği önizlenir, mevcut canlı durumun güvenlik yedeği alınır ve değiştirilmiş yapılandırma/drift durumları güvenli biçimde denetlenir.

![Site Yedekleme ve Geri Yükleme ekranı](assets/tr/15-site-backup.png)

## Kontrol düzlemi taşıma ve kurtarma yedeği

Sunucu genelindeki YunPanel kontrol düzlemi yapılandırmasını yedeklemek ve boş bir Linux sunucusunda kurtarmaya hazırlamak için paketli `local-migration-backup.mjs` aracı kullanılır:

```bash
# 1. Kontrol düzlemi yedeği oluştur (sabit allowlist; /etc/shadow hariç)
sudo /usr/local/bin/node /usr/lib/yunpanel/scripts/local-migration-backup.mjs create --confirm

# 2. Arşivi ve SHA-256 bütünlüğünü doğrula
sudo /usr/local/bin/node /usr/lib/yunpanel/scripts/local-migration-backup.mjs verify /var/backups/yunpanel/migration-<zaman>

# 3. Dış depodan indirilen arşivi kurtarma öncesi kontrol et
sudo /usr/local/bin/node /usr/lib/yunpanel/scripts/local-migration-backup.mjs preflight /yol/yedek --expected-sha256 <sha256> --expected-server-id <uuid>

# 4. Canlı sisteme dokunmadan özel hazırlık (staging) alanına aç
sudo /usr/local/bin/node /usr/lib/yunpanel/scripts/local-migration-backup.mjs stage /var/backups/yunpanel/migration-<zaman> --confirm
```

Sabit yedekleme listesi `/etc/yunpanel`, `/var/lib/yunpanel`, `/etc/passwd`, `/etc/group` ve mevcutsa Nginx / Let's Encrypt / systemd dosyalarını içerir; `/etc/shadow` arşive alınmaz. Kurtarma için `YUNPANEL_SECRET_MASTER_KEY` anahtarının ayrı ve güvenli biçimde saklanması zorunludur.

## Kalıcı iş kurtarma ve kök anahtar rotasyonu

- **İş kurtarma (`job-recovery.mjs`):** Kesintiye uğrayan kalıcı işlemleri incelemek için `sudo /usr/local/bin/node /usr/lib/yunpanel/scripts/job-recovery.mjs status` komutunu kullanın. Kurtarma komutları yalnız desteklenen işlem türü ve eşleşen sunucu/iş kimliğiyle çalışır.
- **Kök anahtar rotasyonu (`rotate-secret-master-key.mjs`):** `YUNPANEL_SECRET_MASTER_KEY` hiçbir zaman yalnızca `.env` dosyası düzenlenerek değiştirilmez; API durdurulduktan sonra çevrimdışı rotasyon aracıyla tüm şifreli depolar yeniden sarılır ve geri dönüş yedeği alınır.

## İlgili kılavuzlar

- Yükseltme öncesi yedek adımları için [Kurulum ve Yükseltme](doc:installation-and-upgrade)
- WordPress seçici aktarım ve otomatik geri alma için [WordPress Yönetimi](doc:wordpress)
