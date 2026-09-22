# Canlı Kabul Raporu: Site Yaşam Döngüsü, Site Yöneticisi, Veritabanı ve Arayüz Düzenlemeleri

**Tarih:** 2026-09-22  
**Hedef Sunucu:** `157.180.11.28` (Ubuntu 24.04 LTS, `.44` Plesk sunucusu kesinlikle hariç)  
**Kapsam:** YP-01, YP-02, YP-03, YP-05, YP-06, YP-07, YP-08, YP-09, YP-10, YP-12, YP-14

---

## 1. Gerçekleştirilen Değişiklikler ve Doğrulamalar

### 1.1. Roundcube Veritabanlarının Gizlenmesi (YP-01)
- `packages/shared/src/database.js` içine `isInfrastructureDatabase` eklenerek `roundcube`, `roundcube_*` ve `roundcubemail*` şemaları tespit edildi.
- `apps/web/src/workspace/database-model.js` ve API listeleme/sayım katmanlarında altyapı veritabanları genel veritabanı envanterinden ve website veritabanı sekmelerinden gizlendi.
- Fiziksel şemaya ve Roundcube'un çalışmasına müdahale edilmedi.
- `e2e/09-databases.spec.js` ile canlı sunucuda doğrulandı.

### 1.2. Site Yöneticisi Yaşam Döngüsü ve Koruma (YP-02, YP-03)
- Website oluşturulurken `adminEmail` ve `adminPassword` zorunlu kılındı.
- `apps/api/src/user-admin-store.js` içine `createSiteManager` ve website scoping bağlamı eklendi.
- Bir web sitesine bağlı `site_manager` kullanıcısının silinmesi, devre dışı bırakılması veya rolünün değiştirilmesi HTTP 409 Conflict ile engellendi.
- Owner'ın site yöneticisinin e-posta ve parolasını güncelleyebilmesi korundu.
- `apps/api/test/user-admin-store.test.js` ve `e2e/01-auth-users.spec.js` ile doğrulandı.

### 1.3. İsteğe Bağlı Veritabanı ve phpMyAdmin Butonu (YP-05, YP-06)
- Yeni site formundaki başlangıç veritabanı seçeneği kaldırıldı; veritabanları isteğe bağlı olarak site oluşturulduktan sonra eklenir hale getirildi.
- Veritabanı kullanıcı adı ve parolası site yöneticisinden bağımsız bağımsız MySQL yapılandırması olarak ayrıldı.
- Veritabanı satırlarına doğrudan phpMyAdmin oturumuna yönlendiren güvenli bağlantı düğmesi eklendi.
- `e2e/09-databases.spec.js` ile doğrulandı.

### 1.4. Otomatik Provisioning, İlerleme ve Hata Tanılama (YP-07, YP-08, YP-09, YP-10)
- Subdomain hariç ana web siteleri için DNS, Mail ve Roundcube webmail otomatik yapılandırma planına dahil edildi.
- `WebsiteCreateForm.jsx` içinde adım adım görsel ilerleme göstergesi ve hata anında detaylı teşhis bilgisi sunuldu.
- `provisioning-client.js` içinde 3 başarısız denemede otomatik tekrar durdurulup `retry_exhausted` durumuna geçilmesi sağlandı.
- `e2e/02-website-creation.spec.js` ile doğrulandı.

### 1.5. SSL E-posta Ön Doldurma ve Certbot İyileştirmesi (YP-12)
- SSL oluşturma modalında kullanıcının e-posta adresi otomatik olarak ön dolduruldu.
- `packages/host-runtime/src/acme-manager.js` içinde certbot renew komutuna `--no-random-sleep-on-renew` bayrağı eklenerek non-interactive yenilemelerde 4 dakikaya varan rastgele bekleme engellendi.
- `e2e/07-ssl-certificates.spec.js` ile doğrulandı.

### 1.6. Ayarlar ve Sunucu Tanılama Ayrımı (YP-13, YP-14)
- Ayarlar sayfası sekmeli yapıya (`?section=account`, `?section=dns`, `?section=ai`, `?section=updates`, `?section=records`) kavuşturuldu.
- "Yerel yönetim (Agentless Root)" metni Ayarlar sayfasından kaldırıldı; Sunucu > Tanılama altına taşındı.
- `ManagedServicesPanel.jsx` içindeki `[object Object]` servis unit render hatası giderildi.
- Dashboard'a dairesel animasyonlu SVG kaynak göstergeleri eklendi.
- `e2e/08-server-settings-jobs.spec.js` ve `e2e/13-system-services.spec.js` ile doğrulandı.

---

## 2. Test Sonuçları

- **Playwright Uçtan Uca (E2E) Test Paketi (`e2e/`):**
  - Toplam Test: 80
  - Başarılı: 80
  - Başarısız: 0
  - Başarı Oranı: %100 (Süre: 3.7 dakika, canlı `157.180.11.28` üzerinde)
- **Birim & Entegrasyon Testleri (`npm run check`):**
  - Lint: Geçti
  - Shared paket testleri: 40/40 geçti
  - Protocol paket testleri: 77/77 geçti
  - Host-runtime paket testleri: 37/37 geçti
  - API paket testleri: 104/104 geçti
  - Web derlemesi: Hata vermeden tamamlandı
