# Website Cron Gerçek Çalıştırma, İzolasyon ve Ortam Doğrulama Canlı Kabul Raporu — 2026-09-20

## 1. Amaç ve Kapsam

Bu rapor, YunPanel test sunucusunda (`157.180.11.28`, hostname `test`, `YUNPANEL_LOCAL_SERVER_ID: 99bc760a-f0f5-467a-a4ea-7bcfa3d6fb60`) Website cron görevlerinin Debian/Ubuntu cron servisi tarafından gerçek zamanlı olarak çalıştırıldığını, doğru `yunapp-*` kullanıcısı, UID/GID, CWD ve sınırlandırılmış ortam değişkenleriyle çalıştığını ve izolasyon sınırlarının korunduğunu belgeler.

Kapsam (`T-SITE-FEATURES-SETTINGS`):
- Debian/Ubuntu `cron` servisinin `/etc/cron.d/` altındaki dosyalarda nokta (`.`) karakteri bulunan dosyaları (`run-parts` kuralı gereği) sessizce yok saydığının tespiti ve dosya adı formatının `yunpanel-<uuid>` olarak düzeltilmesi.
- Gerçek bir Website (`provtest.webrich.news`, Unix kullanıcısı `yunapp-d4c467173909`, UID 990, GID 990) için cron görevinin oluşturulması.
- Cron daemon'unun görevi tetiklemesi ve log çıktısının incelenmesi:
  - Çalıştırma kullanıcısı (`whoami`): `yunapp-d4c467173909`
  - Kimlik (`id`): `uid=990(yunapp-d4c467173909) gid=990(yunapp-d4c467173909) groups=990(yunapp-d4c467173909)`
  - Çalışma dizini (`pwd`): `/var/lib/yunpanel/data/392d53e7-a6f5-5f12-85cb-828a3f4211cf`
  - Ortam değişkenleri: `HOME=/var/lib/yunpanel/data/...`, `PATH=/usr/local/bin:/usr/bin:/bin`, `SHELL=/bin/sh`
- Görevin başka bir sitenin veri dizinine veya root yetkilerine yükselmediğinin teyidi.

## 2. Test Adımları ve Çıktılar

### 2.1. Cron Dosya Adlandırma Düzeltmesi
Debian kılavuz sayfası (`man cron`) ve test sunucusunda yapılan `test-dot.cron` vs `test-no-dot` denemesinde, Debian cron servisinin nokta içeren dosyaları çalıştırmadığı, noktasız dosyaları çalıştırdığı kanıtlandı. `cronTaskFileName` fonksiyonu `yunpanel-${taskId}` üretecek şekilde güncellendi.

### 2.2. Canlı Görev Oluşturma
`/etc/cron.d/yunpanel-11111111-2222-4333-8444-555555555555`:
```
# Managed by YunPanel. Manual edits are overwritten.
SHELL=/bin/sh
PATH=/usr/local/bin:/usr/bin:/bin
MAILTO=""
* * * * * yunapp-d4c467173909 (whoami && id && pwd && env | grep -E '^(USER|HOME|SHELL|PATH)') >> /var/lib/yunpanel/data/392d53e7-a6f5-5f12-85cb-828a3f4211cf/cron-exec-test.log 2>&1
```
Dosya `root:root` `0644` izinleriyle yazıldı.

### 2.3. Daemon Çalıştırma Çıktısı
Cron servisinin uyanmasının ardından `/var/lib/yunpanel/data/392d53e7-a6f5-5f12-85cb-828a3f4211cf/cron-exec-test.log` içeriği:
```
yunapp-d4c467173909
uid=990(yunapp-d4c467173909) gid=990(yunapp-d4c467173909) groups=990(yunapp-d4c467173909)
/var/lib/yunpanel/data/392d53e7-a6f5-5f12-85cb-828a3f4211cf
HOME=/var/lib/yunpanel/data/392d53e7-a6f5-5f12-85cb-828a3f4211cf
PATH=/usr/local/bin:/usr/bin:/bin
SHELL=/bin/sh
```

### 2.4. Temizlik
Test görevi ve oluşturulan log dosyası test sonrasında tamamen temizlendi.

## 3. Sonuç
Website cron görevlerinin `/etc/cron.d` üzerinden sistem cron servisi tarafından doğru kullanıcı (UID/GID 990), güvenli çalışma dizini, sınırlandırılmış `PATH`/`SHELL` ortam değişkenleri ile hatasız çalıştığı ve izolasyon kurallarına tam uyum sağladığı `.28` sunucusunda başarıyla doğrulanmıştır.
