# Passenger Runtime Golden Path İlerletmesi — 2026-09-19

## Kapsam ve Amaç

Bu çalışma, `plan.md` altındaki `P1.1 — Runtime golden path` bölümünün şu maddesini tamamlar:
- `Passenger dependency/env/log/startup/config validation + rollback.`

Hedef: Nginx + Phusion Passenger 6 tabanlı Node.js web siteleri için bağımlılık, ortam değişkenleri (environment), log yönlendirmesi, başlangıç dosyası (startup file) ve Nginx konfigürasyon doğrulamasını eksiksiz hale getirmek ve olası hata durumlarında receipt-bound atomik rollback/compensation mekanizmasını doğrulamaktır.

## Yapılan Değişiklikler

### 1. Nginx Konfigürasyon Şablonları (`packages/config-templates`)

- **`passenger-nginx.js`**:
  - `appLogFile` parametresi eklendi.
  - Phusion Passenger'ın `passenger_app_log_file <path>;` direktifi şablona eklendi. Böylece uygulamanın stdout/stderr logları doğrudan sitenin izole log dizinindeki dosyaya (`/var/lib/yunpanel/data/:applicationId/logs/passenger.log`) yönlendirilir.
  - Güvenlik: `appLogFile` absolute path olmalı, newline/injection karakterleri içermemelidir; aksi halde konfigürasyon üretiminde fail-closed hata verilir.
- **Testler**:
  - `passenger-nginx.test.js` ve `nginx-passenger-site.test.js`: `passenger_app_log_file` direktifinin doğru üretildiği ve güvenliğinin sağlandığı test edildi.

### 2. Host Runtime (`packages/host-runtime`)

- **`passenger-site-manager.js`**:
  - **Startup File Extension Doğrulaması**: `startupFile` için dosya uzantısı kontrolü eklendi. Node.js tarafından doğrudan çalıştırılabilen `.js`, `.mjs`, `.cjs` uzantılarına izin verilirken, derleme/transpilation gerektiren `.ts`, `.py`, `.sh` vb. dosyalar `passenger_site_startup_extension_invalid` kodu ile anında reddedilir.
  - **App Log File Path İzolasyonu**: `appLogFile` parametresi sağlandığında, dosyanın sitenin tanımlı `logDirectory` sınırı içinde kaldığı (`isSubdirectoryOrSame`) doğrulanır; dışına taşan path'ler `passenger_site_path_invalid` kodu ile engellenir.
  - **Setup Validation Helper (`validatePassengerSetup`)**:
    - Nginx Passenger modülünün (`libnginx-mod-http-passenger`), Nginx binary'sinin ve Node.js runtime binary'sinin varlığını ve çalışabilirliğini denetleyen merkezi doğrulama fonksiyonu eklendi.
    - `packages/host-runtime/src/index.js` üzerinden dışa aktarıldı.
- **Testler**:
  - `passenger-site-manager.test.js`: Startup extension, appLogFile dizin izolasyonu ve setup validation durumları için kapsamlı unit testler eklendi.

### 3. API & Golden Path Uçtan Uca Doğrulama (`apps/api`)

- **`passenger-runtime-golden-path.test.js`**:
  - **Dependency & Setup Validation**: Nginx Passenger modülü ve Node runtime eksik olduğunda doğru blocker/hata kodlarının döndüğü doğrulandı.
  - **Environment Validation & Rollback**: `website-passenger-environment-manager.js` ile environment yazma ve receipt-bound compensation (hem sıfırdan oluşturulan hem de pre-existing dosya durumunda atomik rollback) doğrulandı.
  - **Log Path & Config Directives**: `passenger_app_log_file` direktifinin ve log dizini izolasyonunun Nginx vhost konfigürasyonuna doğru yansıdığı doğrulandı.
  - **Startup File Validation**: Geçerli (`app.js`, `server.mjs`) ve geçersiz (`index.ts`, `start.sh`) uzantıların fail-closed reddedildiği ve güvenliğin sağlandığı doğrulandı.
