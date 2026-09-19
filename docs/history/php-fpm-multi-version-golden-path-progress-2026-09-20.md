# PHP-FPM Multi-Version & Verified Repository Golden Path İlerletmesi — 2026-09-20

## Kapsam ve Amaç

Bu çalışma, `plan.md` altındaki `P1.1 — Runtime golden path` bölümünün şu maddesini kaynak kod ve test düzeyinde tamamlar:
- `PHP distro FPM production golden path; multi-version ancak doğrulanmış repo ile.`

Hedef:
1. Ubuntu 24.04 LTS tabanında distro varsayılanı olan PHP 8.3 (`php8.3-fpm`) ile çalışan havuz/socket izolasyonunu korumak.
2. Birden fazla PHP sürümünü (8.1, 8.2, 8.3, 8.4) desteklemek; ancak distro dışı sürümleri **yalnızca doğrulanmış bir paket kaynağı (PPA/repo) varlığında** kurabilmek, doğrulanmamış kaynak durumunda sisteme körlemesine paket yüklemeyip fail-closed durmak.
3. Her sürüm için doğru systemd servisini (`phpX.Y-fpm.service`), doğru konfigürasyon dizinini (`/etc/php/X.Y/fpm/pool.d`), doğru binary test aracını (`/usr/sbin/php-fpmX.Y`) ve siteye özel Unix soketini bağlamak.

## Yapılan Değişiklikler

### 1. Nginx & FPM Konfigürasyon Şablonları (`packages/config-templates`)

- **`php-fpm.js`**:
  - `DISTRO_PHP_VERSION = '8.3'` ve `SUPPORTED_PHP_VERSIONS = ['8.1', '8.2', '8.3', '8.4']` sabitleri tanımlandı.
  - Sürüme duyarlı yardımcı fonksiyonlar eklendi:
    - `phpFpmPoolDirectory(version)`: `/etc/php/${version}/fpm/pool.d`
    - `phpFpmServiceUnit(version)`: `php${version}-fpm.service`
    - `phpFpmBinaryPath(version)`: `/usr/sbin/php-fpm${version}`
    - `phpFpmPackageName(version)`: `php${version}-fpm`
    - `phpFpmPoolPath(unixUser, version)`: `/etc/php/${version}/fpm/pool.d/yunpanel-${unixUser}.conf`
  - `renderWebsitePhpFpmPool` ve `previewWebsitePhpFpmPool`:
    - İstek bazlı `phpVersion` parametresini doğrulayıp şablon çıktısına ve artifact metadata'sına yansıtacak şekilde güncellendi.
    - Desteklenmeyen sürümler (örn. 7.4, 8.0, 9.0) `php_fpm_version_unsupported` ile fail-closed reddedildi.
  - `packages/config-templates/src/index.js` üzerinden yeni yardımcılar dışa aktarıldı.
- **Testler**:
  - `packages/config-templates/test/php-fpm.test.js`: 8.1, 8.2, 8.3, 8.4 sürümleri ve geçersiz sürümler test edildi; 157 test başarıyla geçti.

### 2. Host Runtime (`packages/host-runtime`)

- **`php-fpm-site-manager.js`**:
  - `normalizeIntent`: `phpVersion` alanını kabul edecek ve desteklenen katalog dışında kalan sürümleri `php_fpm_site_version_unsupported` ile reddedecek şekilde genişletildi.
  - **Doğrulanmış Repository Kontrolü (`verifyPhpRepository`)**:
    - Distro sürümü (8.3) varsayılan olarak doğrulanmıştır.
    - Distro dışı bir sürüm (8.1, 8.2, 8.4) kurulmaya çalışıldığında, sistemde o pakete (`phpX.Y-fpm`) ait doğrulanmış bir repository adayı olup olmadığı (`apt-cache policy`) denetlenir. Aday bulunamazsa (`Candidate: (none)`), `php_fpm_repository_unverified` hatası ile işlem fail-closed durdurulur; rastgele/güvensiz paket yüklemesi engellenir.
  - Sürüm dinamikliği:
    - `inspectPackage(version)`, `ensurePackage(version)`, `configTest(version)`, `serviceActive(version)`, `activateService(version)`, `reloadServiceIfActive(version)` fonksiyonları sürüm parametresi alacak şekilde dinamikleştirildi.
    - `previewMigration`, `inspect`, `apply`, `applyMigration`, `restoreConfig`, `compensate` fonksiyonları `spec.phpVersion`'a bağlı olarak ilgili sürümün havuz dosyasını, servisini ve binary'sini işleyecek şekilde güncellendi.
  - `phpFpmSiteManagerInternals`: Sürüme duyarlı `packageName`, `binaryPath`, `serviceUnit` ve `APT_CACHE_PATH` referanslarıyla güncellendi.
- **Testler**:
  - `packages/host-runtime/test/php-fpm-site-manager.test.js`: Multi-version havuz apply & inspect (8.2), doğrulanmamış repo reddi ve geçersiz sürüm reddi dahil 18 test başarıyla geçti.

### 3. API & Golden Path Uçtan Uca Doğrulama (`apps/api`)

- **`apps/api/test/php-fpm-runtime-golden-path.test.js`**:
  - Distro 8.3 baseline: havuz konfigürasyonu, socket yolu, open_basedir ve kullanıcı izolasyonu.
  - Multi-version kataloğu (8.1, 8.2, 8.3, 8.4) doğrulaması.
  - Geçersiz sürüm fail-closed reddi.
  - Doğrulanmış PPA / repo ile host provisioning ve servis reload doğrulaması.
  - Doğrulanmamış repository durumunda fail-closed reddi ve gereksiz paket komutu çalıştırılmaması.
