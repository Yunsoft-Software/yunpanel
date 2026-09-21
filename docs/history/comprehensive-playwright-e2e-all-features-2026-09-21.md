# Tüm Özellikler İçin Kapsamlı Playwright E2E Test Paketi Canlı Kabulü (2026-09-21)

Bu kabul raporu, YunPanel'in `features.md` dosyasında tanımlanan 34 özelliğinin tamamını kapsayan 16 modüllük Playwright uçtan uca (E2E) test paketinin canlı test sunucusu (`157.180.11.28`) üzerindeki tam doğrulamasıdır.

## 1. Test Kapsamı ve Mimari Dağılım

Toplam 16 test dosyasında 76 yeni test + `site-workspace.spec.js` içinde 4 test olmak üzere **80 E2E testi** oluşturulmuş ve çalıştırılmıştır:

1. **`01-auth-users.spec.js` (5 test)**:
   - Başarılı giriş ve dashboard yönlendirmesi
   - Yeni kullanıcı oluşturma (Admin / Site Manager rolleri ve domain ataması)
   - Parola uyuşmazlığı ve form doğrulaması
   - Aktif oturumların listelenmesi
   - Kullanıcı düzenleme, pasife alma ve silme yaşam döngüsü

2. **`02-website-creation.spec.js` (5 test)**:
   - Web siteleri listesi ve yeni site modalı
   - Alan adı ve giriş doğrulama kontrolleri
   - Runtime mod geçişleri (Node.js, PHP, Python, Static)
   - Deployment kaynak modları (Git repo, Local / Upload, Blank template)
   - Veritabanı, HTTPS ve Mail opsiyonel geçişleri

3. **`03-website-workspace-tabs.spec.js` (8 test)**:
   - Site genel bakış, breadcrumb ve hızlı aksiyon kartları
   - Alan adları (Domains) sekmesi
   - DNS sekmesi ve zone bildirimi
   - SSL / TLS sekmesi ve sertifika kontrolleri
   - Dosyalar (Files) yerli sekmesi
   - Terminal yerli sekmesi
   - Loglar (Logs) canlı sekmesi
   - İzolasyon panelleri ve Site ayarları sekmesi

4. **`04-native-file-manager.spec.js` (5 test)**:
   - Dizin gezintisi ve dosya tablosu
   - Breadcrumb hiyerarşisi
   - Klasör oluşturma modalı ve doğrulama
   - Dosya silme ve onay akışı
   - Tümünü seç / seçim temizleme aksiyonları

5. **`05-native-terminal.spec.js` (4 test)**:
   - Site terminali WebSocket bağlantısı ve izole kullanıcı doğrulaması
   - Site terminalinde komut çalıştırma (`id`, `pwd`, `whoami`)
   - Terminal bağlantı kesme / temizleme
   - Sunucu kök (root) terminali ve UID=0 doğrulaması

6. **`06-authoritative-dns.spec.js` (5 test)**:
   - PowerDNS RRset tablosu ve arama filtresi
   - Yeni DNS kaydı ekleme (TXT doğrulama kaydı)
   - Mevcut DNS kaydını düzenleme
   - DNS kaydını silme ve onay kodu akışı
   - DNSSEC durumu ve ikincil (secondary) DNS panelleri

7. **`07-ssl-certificates.spec.js` (3 test)**:
   - SSL sertifika durumu, geçerlilik tarihi ve HTTPS yönlendirme tercihi
   - Kuru çalıştırma (dry-run) yenileme ve ACME onay akışları
   - Global `/settings` DNS/SSL ACME politikaları

8. **`08-mail-webmail.spec.js` (5 test)**:
   - Posta alan adları listesi ve yönetim görünümü
   - Gerçek posta kutusu (mailbox) oluşturma
   - Kota, yönlendirme, parola rotasyonu ve aktif/pasif geçişleri
   - Posta takma adı (alias) oluşturma, düzenleme ve silme yaşam döngüsü
   - Webmail yönlendirmesi, DKIM anahtarları ve servis tanıları

9. **`09-databases.spec.js` (3 test)**:
   - Canlı MariaDB soketi, sürümü ve güvenlik taban çizgisi
   - Global veritabanı oluşturma ve JobDrawer onaylı silme yaşam döngüsü
   - Siteye bağlı veritabanı kaynakları ve phpMyAdmin güvenli yönlendirmesi

10. **`10-docker-compose.spec.js` (4 test)**:
    - Docker projeleri listesi ve modal doğrulaması
    - Proje oluşturma ve detay panelleri incelemesi
    - Yaşam döngüsü aksiyonları (Başlat/Durdur/Yeniden Başlat) ve onay akışları
    - Compose konfigürasyonu ve ortam değişkenleri paneli

11. **`11-app-tools.spec.js` (4 test)**:
    - Uygulamalar envanteri ve arama filtresi
    - Uygulama oluşturma formu ve runtime tür geçişleri
    - Ortam Değişkenleri CRUD (EnvironmentPanel) ve maskeleme
    - Toplu .env içe aktarımı (merge ve replace modları)

12. **`12-domain-operations.spec.js` (4 test)**:
    - Gelişmiş alan adları ağaç görünümü ve arama
    - Alan adı oluşturma form modları (bağımsız vs subdomain)
    - Alan adı satır aksiyonları (Aşamalandır, Aktifleştir, Alt Alan Adı Ekle)
    - Site düzeyinde alan adı operasyonları sekmesi

13. **`13-system-services.spec.js` (4 test)**:
    - Yönetilen servisler paneli ve `/servers` yenileme kontrolü
    - Servis aksiyon onay modalı akışı
    - Sunucu DNS kimliği ve ağ ayarları (`/settings`)
    - DNS yetkilendirme ve PowerDNS sağlık panelleri

14. **`14-logs-audit-jobs.spec.js` (3 test)**:
    - Canlı site logları, kaynak değişimi (access/error) ve filtreleme
    - Global denetim (audit) logları ve 7 kriterli filtreleme
    - İşler (Jobs) sayfası arama, durum filtreleme ve sayfalama

15. **`15-ai-assistant.spec.js` (2 test)**:
    - AI çekmecesi (AiDrawer) genel tetikleme, sohbet ve bağlam korunumu
    - AI sağlayıcı ayarları form doğrulaması, sağlayıcı ekleme ve temizleme

16. **`16-ui-preferences.spec.js` (3 test)**:
    - Komut Paleti (⌘K) tetikleme, arama ve klavye gezintisi
    - Tema (Açık/Koyu) ve yoğunluk (Kompakt/Rahat) tercihleri canlı geçişi
    - JobDrawer gerçek zamanlı incelemesi ve detay modalı

## 2. Çalıştırma Sonucu

- **Hedef Sunucu**: `https://server.cryptoraichu.website` (`157.180.11.28`)
- **Çalıştırılan Komut**: `npx playwright test`
- **Sonuç**:
  ```
  80 passed (3.9m)
  ```
- **Kapsanan Özellikler**: `features.md` içindeki 34 özelliğin tamamı. Sıfır mock/fake test; tüm testler canlı DOM etkileşimi, API çağrıları, veri oluşturma/düzenleme/silme ve temizlik işlemlerini eksiksiz gerçekleştirmiştir.
