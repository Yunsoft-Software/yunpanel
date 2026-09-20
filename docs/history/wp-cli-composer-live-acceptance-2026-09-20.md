# WP-CLI ve Composer Canlı İzolasyon Kabul Raporu (2026-09-20)

## 1. Test Hedefi ve Kapsam

`todo.md` altındaki `T-SITE-FEATURES-SETTINGS`:
> WordPress Website'te WP-CLI ve PHP Website'te Composer yalnız site user/cwd ile çalışsın.

Bu kabul çalışması, Ubuntu 24.04 LTS `.28` test sunucusu (`157.180.11.28`) üzerinde WP-CLI ve Composer araçlarının `phpCliToolManager` ve `websitePhpToolsService` aracılığıyla çalıştırılmasını, süreç yetkisi düşürme (UID/GID), çalışma dizini (CWD) izolasyonu ve güvenlik kalkanlarını doğrulamıştır.

## 2. Sunucu Ortamı ve Araç Sürümleri

- **Sunucu**: `157.180.11.28` (hostname: `test`, Ubuntu 24.04 LTS x86_64)
- **WP-CLI**: `2.12.0` (`/usr/local/bin/wp`)
- **Composer**: `2.7.1` (`/usr/bin/composer`)
- **PHP**: `8.4.25` (`/usr/bin/php8.4`)
- **Test Edilen PHP Website**: `provtest.webrich.news` (ID: `01944d99-9289-5b83-90f7-cec1402e6722`)
- **Dedicated Site Kullanıcısı**: `yunapp-d4c467173909` (UID: 990, GID: 990, Home: `/var/lib/yunpanel/data/392d53e7-a6f5-5f12-85cb-828a3f4211cf`)
- **Yönetilen Sürüm Dizini**: `/var/lib/yunpanel/apps/392d53e7-a6f5-5f12-85cb-828a3f4211cf/releases/861088e0-84f4-40ec-8df1-4edb5c77def9`

## 3. Doğrulanan Güvenlik ve İzolasyon Kontratları

### 3.1. İkili (Binary) Tespiti ve Sürüm Denetimi
- `inspectWpCli()` çağrısı `/usr/local/bin/wp` yolunu tespit etmiş ve sürümü `2.12.0` olarak dönmüştür.
- `inspectComposer()` çağrısı `/usr/bin/composer` yolunu tespit etmiş ve sürümü `2.7.1` olarak dönmüştür.
- `websitePhpToolsService.getWpCliStatus()` ve `getComposerStatus()` methodları canlı ortamda durum ve metadata raporlamıştır.

### 3.2. Site Kullanıcısı Yetkisine Düşürme (Privilege Drop)
- WP-CLI komutları `/usr/sbin/runuser -u yunapp-d4c467173909 -- /usr/local/bin/wp <args>` aracılığıyla çalıştırılmıştır.
- `wp eval --skip-wordpress 'echo "UID: " . posix_getuid() . " USER: " . posix_getpwuid(posix_getuid())["name"];'` canlı çıktısı:
  ```
  UID: 990 USER: yunapp-d4c467173909
  ```
  Komutun root (UID 0) olarak değil, izole site kullanıcısı altında çalıştığı kanıtlanmıştır.

### 3.3. CWD İzolasyonu ve Symlink Çözümlemesi
- `current` symlink'i `realpath` ile doğrulanmış sürüm dizinine çözülmüş (`/var/lib/yunpanel/apps/392d53e7-a6f5-5f12-85cb-828a3f4211cf/releases/861088e0-84f4-40ec-8df1-4edb5c77def9`) ve CWD olarak atanmıştır.
- `wp eval --skip-wordpress 'echo getcwd();'` çıktısının tam olarak bu yönetilen dizin olduğu teyit edilmiştir.
- `/etc` gibi yönetilmeyen veya sistem dizinlerine kaçış girişimleri `400 php_cli_cwd_invalid` / `409 php_cli_cwd_escape` ile engellenmiştir.

### 3.4. `--allow-root` Kesin Engeli
- WP-CLI ve Composer komutlarına `--allow-root` veya `--allow-root=*` argümanı verilmesi `403 wp_cli_root_forbidden` ve `403 composer_root_forbidden` ile mutlak olarak durdurulmuştur.

### 3.5. Komut Beyaz Listesi (Allowlist)
- Beyaz listede bulunmayan komutlar (örn. `wp shell`, `composer exec`) `400 wp_cli_command_unsupported` ve `400 composer_command_unsupported` ile reddedilmiştir.
- Kontrol karakteri (`\0`, `\r`, `\n`) içeren argümanlar `400 wp_cli_argument_invalid` ile engellenmiştir.

### 3.6. PHP Dışı Runtime Koruması
- Node.js Website'i (`yunpanel-node-smoke.test`) üzerinde WP-CLI veya Composer çalıştırma isteği `409 website_runtime_not_php` ile reddedilmiştir.

## 4. Düzeltilen Hata

- `php-cli-tool-manager.js` içinde `cwd` kontrolünde `lstat(cwd).isDirectory()` çağrısı, `current` bir sembolik bağ olduğu için `false` dönüyordu. Bu durum `realpath` sonrası çözülen asıl dizin üzerinde `stat` denetimi yapacak şekilde (`inspectDirStat`) düzeltilmiş ve birim testi eklenmiştir.
