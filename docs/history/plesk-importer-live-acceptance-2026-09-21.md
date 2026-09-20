# Plesk Salt-Okunur İçe Aktarıcı (Importer) Canlı Kabul Raporu — 2026-09-21

## 1. Amaç ve Kapsam

Bu rapor, YunPanel test sunucusunda (`157.180.11.28`, hostname `test`, `YUNPANEL_LOCAL_SERVER_ID: 99bc760a-d508-4ae6-92be-efdedee9658d`) Plesk salt-okunur çevrimdışı dışa aktarım (offline export) önizleme içe aktarıcısının (`plesk-importer`) canlı ortamda test edildiğini ve kabul kriterlerini karşıladığını belgeler.

**Kapsam ve Güvenlik Sınırları**:
- `.44` IP adresli Plesk sunucusuna kesinlikle hiçbir bağlantı kurulmamış, taranmamış veya müdahale edilmemiştir.
- İçe aktarıcı tümüyle çevrimdışı JSON/fikstür girdi modeliyle çalışır (`readOnly: true`).
- Girdi verileri derinlemesine taranarak `.44` sunucusuna yapılan herhangi bir referans tespit edildiğinde `403 plesk_forbidden_target_server` ile işlem fail-closed olarak durdurulur.
- İçe aktarıcı yalnızca kimlik doğrulanmış `owner` rolüne açık yönetim API'si (`POST /api/panel/importer/plesk/preview`) üzerinden erişilebilmektedir.

## 2. Doğrulama Adımları ve Çıktılar

### 2.1. Kimlik Doğrulama Sınırı
- Anonim istemci ile `POST /api/panel/importer/plesk/preview` çağrıldı:
  - Yanıt: `HTTP 401 Unauthorized` (`code: unauthorized`).
- `yunsoft-owner` oturum çerezi ve CSRF token'ı ile kimlik doğrulaması tamamlandı.

### 2.2. Yasaklı Sunucu Koruması (`.44` Kontrolü)
- `.44` adresini hedef veya DNS kaydı olarak içeren bir fikstür ile önizleme çağrıldı:
  - Yanıt: `HTTP 403 Forbidden`
  - Hata Kodu: `plesk_forbidden_target_server`
  - Açıklama: Prohibited server (.44) referansı tespit edildiğinde sunucu mutasyonu veya önizleme üretimi anında engellendi.

### 2.3. Çoklu Runtime ve Kaynak Eşleme Önizlemesi
Canlı sunucuya Node (Passenger), PHP (FPM), Python, Static siteler, MariaDB veritabanları, e-posta etki alanları/posta kutuları/takma adlar/yönlendirmeler, PowerDNS kayıtları, zamanlanmış görevler (cron), SSL sertifikaları ve yedek arşivleri içeren kapsamlı bir çevrimdışı Plesk fikstürü gönderildi.

Dönen HTTP 200 yanıtı:
```json
{
  "preview": {
    "readOnly": true,
    "serverId": "99bc760a-d508-4ae6-92be-efdedee9658d",
    "previewDigest": "23d9d9ac0064d98d321f3f30e9addef9787a8f99d0bff9d72fd3fd895089a74a",
    "summary": {
      "websitesCount": 4,
      "domainsCount": 5,
      "databasesCount": 2,
      "mailboxesCount": 1,
      "dnsZonesCount": 1,
      "cronsCount": 1,
      "certificatesCount": 1
    }
  }
}
```

Eşleme Doğrulamaları:
1. **Node Runtime**: Plesk `node` tipi YunPanel Nginx + Phusion Passenger adapter'ına, `nodeMajor: "24"`, `entryFile: "server.js"` ve `documentRoot: "dist/public"` olarak normalize edildi.
2. **PHP Runtime**: Plesk `php` tipi PHP-FPM havuz modeline ve desteklenen sürüme (`8.3`, `httpdocs`) eşlendi.
3. **Python Runtime**: Plesk `python` tipi Python 3.12 (`app.py`, `httpdocs`) modeline eşlendi.
4. **Static Runtime**: Statik yayın klasörüne (`httpdocs`) eşlendi.
5. **MariaDB/MySQL**: `nodedb_test` ve `wp_test` şemaları MariaDB veritabanı kaynağı olarak yapılandırıldı.
6. **Mail**: `admin@node-app.test.local` posta kutusu (500 MB kota), `contact@` takma adı ve `info@` yönlendirmesi yerel posta etki alanı modeliyle eşleştirildi.
7. **DNS**: Apex ve mail A kayıtları yerel PowerDNS bölgesi için hazırlandı.
8. **Cron**: Geçerli zamanlanmış görevler Debian uyumlu program ve normalize komutla eşlendi.
9. **Sertifika & Yedek**: SSL sertifika PEM blokları ve arşiv yolu güvenli önizleme özetine dahil edildi.
10. **Özet & Özet Özeti (Digest)**: Değiştirilemez SHA-256 `previewDigest` üretildi.

## 3. Sonuç
Plesk read-only offline export importer'ı, YunPanel yerel sunucu kimliği ve model hiyerarşisiyle tam uyumlu olarak canlı ortamda (`.28`) doğrulanmış ve kabul edilmiştir.
