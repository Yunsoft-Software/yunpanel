# ttyd ve elFinder Tools Gateway Canlı Kabulü (2026-09-20)

## Kapsam ve Amaç

Bu test, `todo.md` altındaki `T-TOOLS` maddeleri ve `plan.md` altındaki `P0.6` (elFinder) ile `P0.7` (IntegratedToolGateway / ttyd) gereksinimlerinin `.28` test sunucusu (`157.180.11.28`) üzerinde canlı olarak doğrulanmasını kapsar.

## Gerçekleştirilen Doğrulamalar ve Sonuçlar

### 1. ttyd Runtime Engine İncelemesi
- `createTtydRuntimeManager().inspect()` çalıştırıldı.
- `ttyd` paketi: `1.7.4-1build2` kurulu.
- Binary: `/usr/bin/ttyd` (sürüm 1.7.4), çalışabilir ve `satisfied: true`.
- Dağıtım servisi `ttyd.service`: masked (`distroServiceMasked: true`), pasif (`distroServiceActive: false`).
- ttyd asla public bir daemon olarak dinlemez; yalnızca on-demand one-shot process olarak YunPanel gateway'i arkasında başlatılır.

### 2. ttyd Sunucu (Root) One-Shot Oturumu
- `ttydSessionManager.start({ target: { scope: 'server', user: 'root', cwd: '/root' } })` çağrıldı.
- One-shot oturum UUID'si oluşturuldu (`dade0366-52d8-4c81-a931-83f5897f32e3`).
- Özel Unix domain soketi `/run/yunpanel/ttyd/<sessionId>.sock` üzerinde oluşturuldu, dosya izinleri `0660` olarak doğrulandı.
- `curl -s -H 'X-YunPanel-TTYD-Auth: owner' --unix-socket /run/yunpanel/ttyd/<sessionId>.sock http://localhost/tools/ttyd/<sessionId>/` ile ttyd HTTP arayüzüne yapılan probe 700.310 bayt tam HTML yanıtı ile başarılı oldu.
- `ttydSessionManager.terminateOwned(...)` ile oturum sonlandırıldı; ttyd süreci kapandı ve soket dosyası temizlendi (`ENOENT`).

### 3. Dedicated Site Kullanıcısı ve Dizin Hazırlığı
- `createWebsiteIdentityPathManager().apply(...)` ile site kimliği `yunapp-82fb7a0bb529` oluşturuldu (UID: 986, GID: 986).
- Sitenin document root ve releases dizinleri hazırlandı (`/var/lib/yunpanel/apps/<appId>/current`).

### 4. ttyd Site (Site Kullanıcısı) One-Shot Oturumu
- `ttydSessionManager.start({ target: { scope: 'site', user: 'yunapp-82fb7a0bb529', cwd: '/var/lib/yunpanel/apps/<appId>/current' } })` çağrıldı.
- ttyd süreci `--uid 986 --gid 986` yetki düşürme bayraklarıyla başlatıldı.
- Özel Unix domain soketi `/run/yunpanel/ttyd/<sessionId>.sock` üzerinde oluşturuldu, dosya izinleri `0660` olarak doğrulandı.
- `curl -s -H 'X-YunPanel-TTYD-Auth: owner' --unix-socket /run/yunpanel/ttyd/<sessionId>.sock http://localhost/tools/ttyd/<sessionId>/` ile ttyd HTTP arayüzüne yapılan probe 700.310 bayt tam HTML yanıtı ile başarılı oldu.
- `ttydSessionManager.terminateOwned(...)` ile oturum sonlandırıldı; ttyd süreci kapandı ve soket temizlendi.

### 5. elFinder Paket ve Connector İncelemesi
- elFinder sürümü: `2.1.70` (`/usr/share/yunpanel/elfinder/VERSION`).
- `connector.php` sözdizimi: `php -l /usr/share/yunpanel/elfinder/connector.php` -> `No syntax errors detected`.
- elFinder vendor çekirdeği: `/usr/share/yunpanel/elfinder/vendor/elfinder/php/elFinder.class.php` doğrulandı.

### 6. elFinder Site Başına PHP-FPM Havuzu Materyalizasyonu ve Telafisi (Compensation)
- `createElFinderFpmSiteManager().apply(...)` çalıştırıldı.
- Havuz konfigürasyonu `/etc/php/8.3/fpm/pool.d/yunpanel-elfinder-yunapp-82fb7a0bb529.conf` oluşturuldu (izinler `0600`).
- Havuz soketi `/run/php/yunpanel-elfinder-yunapp-82fb7a0bb529.sock` oluşturuldu (izinler `0660`, soket tipi).
- `createElFinderFpmSiteManager().compensate(...)` çalıştırıldı; havuz konfigürasyonu ve soketi temizlendi (`ENOENT`).

## Sonuç
`T-TOOLS` kapsamındaki ttyd one-shot daemonless mimarisi, root sunucu oturumu, site kullanıcısı oturumu, elFinder 2.1.70 connector ve site başına izole PHP-FPM havuz materyalizasyonu/telafisi `.28` test sunucusunda eksiksiz çalışmaktadır.
