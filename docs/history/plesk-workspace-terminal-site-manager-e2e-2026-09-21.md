# Plesk Site Workspace, Yerli WebSocket Terminali, Scoped site_manager Rolü ve Playwright E2E Canlı Kabulü — 21 Eylül 2026

**Tarih**: 21 Eylül 2026  
**Hedef Sunucu**: `157.180.11.28` (`server.cryptoraichu.website`, Ubuntu 24.04 LTS, Node.js `v24.20.0`)  
**Kapsam**: P0.10 — SSL / TLS Düzeltmesi, Subdomain Yönetimi, Yerli Sandboxed Terminal, Plesk-Tarzı Website Workspace, Scoped `site_manager` Rolü ve Playwright E2E Testleri

---

## 1. Amaç ve Kapsam

1. **SSL / TLS Otomatik Geçiş**: `httpsMode: 'off'` olan sitelerde dahi Let's Encrypt SSL talep edildiğinde otomatik olarak `managed` moduna geçilmesi, kullanıcıyı 409 (`https_not_managed`) ile tıkamayan tek tıkla sertifika temini.
2. **Subdomain Yönetimi ve İlişkilendirme**: Website detayından alt alan adı eklendiğinde `parentDomainId` ve `websiteId` alanlarının doğru bağlanması; ölü `/stage` ve `/activate` çağrılarının durable state motoruna geçirilmesi.
3. **ttyd Kaldırılması & Yerli İzolasyonlu WebSocket Terminali**: ttyd bağımlılığı tamamen kaldırılarak yerine doğrudan `node-pty` + xterm.js WebSocket terminali entegre edildi. Site içi terminal `website.unixUser` ve `website.documentRoot` içine hapsedildi (Linux DAC). Sunucu terminali yalnızca Owner için `/root` altında yetkilendirildi.
4. **Plesk-Tarzı Kapsamlı Website Workspace**: Website detayında sekmeli (Genel Bakış, Dosyalar, Alan Adları, SSL, Veritabanları, Mail, Docker/Uygulamalar, Loglar, Terminal, Yedekler, Ayarlar) Plesk tarzı modern çalışma alanı.
5. **Scoped Website Kullanıcı Rolü (`site_manager`)**: Kendisine atanan siteleri yönetebilen, ancak diğer siteleri, sunucu ayarlarını (`/settings`), sunucuları (`/servers`) veya audit loglarını (`/audit`) göremeyen ve bu rotalara doğrudan erişimi engellenip `/websites` sayfasına yönlendirilen rol mimarisi.
6. **Playwright ile Uçtan Uca (E2E) Gerçek Tarayıcı Testleri**: `@playwright/test` ile Chromium tarayıcısı üzerinden canlı test sunucusunda koşan uçtan uca test paketi.

---

## 2. Gerçekleştirilen Değişiklikler

### A. Backend İzin ve Güvenlik Katmanı
- `apps/api/src/owner-mfa-policy.js`:
  - `requireSiteManagement(session)` metodu eklendi; `owner` ve `site_manager` rollerini yönetim oturumu olarak kabul ederken `read_only` ve anonim oturumları fail-closed reddeder.
- `apps/api/src/auth-http.js`:
  - Rol tabanlı yetkilendirmede `site_manager` rolünün `requireSiteManagement` üzerinden doğrulanması sağlandı. `panel-http-guard.js` üzerindeki ince taneli rota izinleri korunarak `site_manager`'ın global sistem ayarları ve audit rotalarına erişimi engellendi.
- `apps/api/test/owner-mfa-policy.test.js`:
  - `requireSiteManagement` için unit test eklendi (8/8 test başarılı).

### B. Frontend SPA ve Rota İzolasyonu
- `apps/web/src/workspace/WorkspaceApp.jsx`:
  - `OwnerRoute` bileşeni eklendi.
  - `/settings`, `/settings/users`, `/servers`, `/applications`, `/domains`, `/backups` rotaları `owner(...)` guard ile korundu; `site_manager` veya yetkisiz oturumlar doğrudan `/websites` sayfasına yönlendirildi.

### C. Playwright E2E Test Paketi
- `playwright.config.js`:
  - Base URL `https://server.cryptoraichu.website`, Chromium/Chrome desteği, headless çalışma, trace ve screenshot yapılandırması.
- `e2e/panel.spec.js`:
  - **Test 1**: Owner oturum açma, sessionbar kullanıcı ve rol doğrulaması, dashboard ve web siteleri navigasyonu (`✓ passed (3.2s)`).
  - **Test 2**: Website Workspace Plesk sekmeleri (Genel bakış, Alan adları, SSL, Loglar, Ayarlar, Bağlı kaynaklar), SSL sertifikası görünümü, yerli WebSocket terminal xterm konteyner doğrulaması (`✓ passed (2.4s)`).
  - **Test 3**: `site_manager` kullanıcı oluşturma, scoped site atama, `site_manager` olarak giriş yapma, sol menüde yönetici bağlantılarının (`/settings`, `/servers`, `/audit`) görünmediğini doğrulama, `/settings/users` yönetici rotasına doğrudan girişte engellenip `/websites` sayfasına yönlendirildiğini doğrulama, oturumu kapatıp Owner ile temizlik/kullanıcı silme (`✓ passed (8.5s)`).

---

## 3. Doğrulama ve Test Sonuçları

1. **Birim ve Entegrasyon Testleri**:
   - `@yunpanel/api`: 2998 test geçti (0 hata).
   - `@yunpanel/web`: 272 test geçti (0 hata).
   - `@yunpanel/protocol`: 77 test geçti (0 hata).
   - `@yunpanel/shared`: 40 test geçti (0 hata).
   - **Toplam**: 3387 test, %100 yeşil.
2. **Repository Lint Doğrulaması**:
   - `node scripts/validate-repository.mjs`: Repository policy validation passed.
3. **Playwright Uçtan Uca Canlı Tarayıcı Testleri**:
   - `npx playwright test`: 3 passed (17.3s).
4. **Canlı Sunucu Entegrasyonu (`157.180.11.28`)**:
   - Derlenen web bundle'ı hem `/usr/share/yunpanel/web/` hem de `/usr/lib/yunpanel/apps/web/dist/` dizinlerine senkronize edildi.
   - API dosyaları `/usr/lib/yunpanel/apps/api/src/` içine aktarıldı.
   - `yunpanel-api` ve `yunpanel-web` servisleri yeniden başlatıldı, aktiflik durumu teyit edildi.
