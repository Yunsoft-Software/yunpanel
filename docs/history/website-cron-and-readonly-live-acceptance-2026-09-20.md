# Website Cron ve Read-Only Rolü Canlı Kabulü — 2026-09-20

## 1. Kapsam ve Güvenlik Sınırı

Bu kabul testi, repo dışı `.local/test-server.env` dosyasında tanımlı `157.180.11.28` (.28) test sunucusunda yürütülmüştür. IP adresi `.44` ile biten Plesk sunucusuna hiçbir bağlantı kurulmamış ve işlem yapılmamıştır.

Doğrulanan başlıklar:
1. **`T-CRON`**: Ubuntu 24.04 üzerinde Website cron yaşam döngüsü (apply, update, disable, remove), `yunapp-*` kullanıcı izolasyonu, `%` ve tırnak kaçışları, manuel dosya drift tespiti, sahte/yetkisiz cron dosyası bloklaması ve Domain/Website delete impact sağlayıcısı doğrulaması.
2. **`T-BASE`**: `read_only` rolü yetki sınırları (izinli GET/HEAD yüzeyleri, tool gateway, terminal WebSocket, phpMyAdmin signon, elFinder connector, mutation ve hassas yönetim alanlarının 403 ile reddedilmesi) ve audit loglarında parola/token/secret sızdırılmadığının canlı veritabanı incelemesi.

---

## 2. T-CRON: Website Cron Doğrulama Kanıtları

### 2.1. Cron Servisi ve Dosya Yaşam Döngüsü
- Ubuntu 24.04 LTS üzerinde `cron.service` durumu denetlendi: `active`.
- `webrich.news` sitesi (`2689cb56-55a4-50c0-a3a4-258c7f2d48dd`, Unix kullanıcısı: `yunapp-a404896cf12e`) için API üzerinden cron oluşturuldu:
  - İstek: `POST /api/panel/websites/2689cb56-55a4-50c0-a3a4-258c7f2d48dd/crons`
  - Gövde: `{"name":"Test Cron 1","schedule":"*/10 * * * *","command":"echo \"test 100%\" >> /var/lib/yunpanel/data/2689cb56-55a4-50c0-a3a4-258c7f2d48dd/cron-output.log"}`
  - Sonuç: Task ID `611959da-8840-4ca9-b555-6aa6544d173e`, Job ID `9b9887c5-96de-463b-a97a-42f63b1df428`.
- Host üzerinde oluşturulan dosya incelendi:
  - Yol: `/etc/cron.d/yunpanel-611959da-8840-4ca9-b555-6aa6544d173e.cron`
  - İzinler: `-rw-r--r-- 1 root root` (`0644`)
  - Çalıştırma kullanıcısı: `yunapp-a404896cf12e`
  - `%` kaçışı: `echo "test 100\%"` (Cron daemon'unun `%` karakterini yeni satır olarak yorumlamaması için otomatik kaçırıldı).
- Güncelleme (`PATCH`):
  - `expectedRevision: 1` ile schedule `*/15 * * * *` yapıldı; revizyon 2'ye yükseldi ve host dosyası atomik olarak güncellendi.
- Devre dışı bırakma (`PATCH`):
  - `expectedRevision: 2`, `enabled: false` gönderildi; dosya `# disabled: */15 * * * * yunapp-a404896cf12e ...` biçimine dönüştürüldü.
- Silme (`DELETE`):
  - `expectedRevision: 3` ile `DELETE` çağrıldı; `/etc/cron.d/yunpanel-611959da-8840-4ca9-b555-6aa6544d173e.cron` dosyası diskten tamamen temizlendi ve registry'den silindi.

### 2.2. Kullanıcı ve Dizin İzolasyonu
- Sitenin çalıştırma kullanıcısı `yunapp-a404896cf12e` kimliğiyle başka bir sitenin (`mailtest.webrich.news`, `yunapp-71355c1cda8a`) veri dizinine yazma denendi:
  ```bash
  su -s /bin/sh yunapp-a404896cf12e -c 'touch /var/lib/yunpanel/data/6e7d89a3-f363-5c78-a832-358f8ad0b8d8/test'
  ```
  Çıktı: `touch: cannot touch '...': Permission denied` (İzolasyon doğrulandı).

### 2.3. Manuel Dosya Drift Tespiti
- Host dosyasının sonuna manuel `# manual drift line` eklendi.
- `GET /api/panel/websites/2689cb56-55a4-50c0-a3a4-258c7f2d48dd/crons` çağrıldığında:
  - `"status": "drifted"`
  - `"reconciled": false`
  - `"summary": {"total": 1, "ready": 0, "drifted": 1}`
  - Dosyanın üzerine körlemesine yazılmadığı ve drift durumunun güvenle raporlandığı teyit edildi.

### 2.4. Domain/Website Delete Impact ve Fail-Closed Davranışı
- Drift varken `POST /api/panel/websites/2689cb56-55a4-50c0-a3a4-258c7f2d48dd/impact-preview` (`operation: "delete"`):
  - Sonuç: `{"error":{"code":"cron_impact_unavailable","message":"cron impact inventory is unavailable"}}` (Fail-closed bloklandı).
- Host üzerinde sahte/unmanaged `yunpanel-00000000-0000-0000-0000-000000000001.cron` dosyası oluşturulduğunda:
  - Sonuç: `{"error":{"code":"cron_impact_unavailable","message":"cron impact inventory is unavailable"}}` (Orphan tespitiyle silme işlemi bloklandı).
- Temiz ve uyumlu durumda:
  - `dependencies.crons.status`: `"available"`
  - `dependencies.crons.items`: `[{"id":"611959da-8840-4ca9-b555-6aa6544d173e","state":"disabled"}]`
  - `blockers`: `[{"code":"cron_dependencies_present","resourceType":"cron","count":1}]` (Silme öncesi bağlı cron bağımlılığı başarıyla raporlandı).

---

## 3. T-BASE: Read-Only Rolü ve Audit Güvenlik Sınırları

### 3.1. Read-Only Kullanıcı Yetki Matrisi
`yunsoft-readonly` kullanıcısı oluşturuldu ve oturum açıldı. Elde edilen yetki yanıtı:
- `access.mode`: `"read_only"`
- `access.permissions`: `["servers.read","websites.read","applications.read","domains.read","certificates.read","dns_zones.read","mail_domains.read","mailboxes.read","docker_workloads.read"]`

Canlı test sonuçları:
1. **İzin Verilen Okuma (GET/HEAD):**
   - `GET /api/panel/websites` -> `HTTP 200 OK`
   - `GET /api/panel/domains` -> `HTTP 200 OK`
   - `GET /api/panel/servers` -> `HTTP 200 OK`
2. **Tool Gateway Erişimi (Owner Zorunlu):**
   - `GET /tools/ttyd/<uuidv4>` -> `Terminal access denied. HTTP 403 Forbidden`
   - `GET /tools/phpmyadmin/` -> `phpMyAdmin access denied. HTTP 403 Forbidden`
   - `GET /tools/elfinder/<websiteId>` -> `elFinder access denied. HTTP 403 Forbidden`
   - `GET /tools/elfinder/<websiteId>/connector` -> `elFinder access denied. HTTP 403 Forbidden`
   - `GET /tools/netdata/` -> `Netdata access denied. HTTP 403 Forbidden`
   - `GET /tools/goaccess/<websiteId>/` -> `GoAccess access denied. HTTP 403 Forbidden`
3. **Web Terminali ve WebSocket Yükseltmesi:**
   - `GET /api/terminal` (Upgrade: websocket) -> `HTTP 403 Forbidden`
4. **phpMyAdmin Handoff:**
   - `POST /api/panel/servers/.../websites/.../phpmyadmin-handoffs` -> `HTTP 403 Forbidden` (`phpmyadmin_handoff_owner_required`)
5. **Yazma / Mutasyon İşlemleri:**
   - `POST /api/panel/websites/.../crons` -> `HTTP 403 Forbidden` (`forbidden`)
   - `POST /api/panel/users` -> `HTTP 403 Forbidden` (`forbidden`)
6. **Hassas Yönetim Alanları:**
   - `GET /api/panel/users` -> `HTTP 403 Forbidden`
   - `GET /api/panel/jobs` -> `HTTP 403 Forbidden`
   - `GET /api/panel/audit` -> `HTTP 403 Forbidden`

### 3.2. Audit Veritabanı ve Secret Sızdırmazlığı
`/var/lib/yunpanel/control-plane/auth/auth.sqlite` içerisindeki `audit_events` tablosu canlı olarak incelendi:
- Kayıt yapısı: `id | actor_id | action | resource_type | resource_id | outcome | details | created_at`
- İncelenen kayıtlar:
  - `user.created`: Parola veya hash bilgisi içermez.
  - `job.cron.apply`: Cron komutu, parametre veya betik içeriği içermez; yalnız task ID ve durum taşır.
  - `login.succeeded`: Oturum çerezi, token veya parola bilgisi içermez.
- Hiçbir audit kaydında password, cookie, CSRF token, ortam değişkeni, servis parolası veya terminal çıktısı bulunmadığı kanıtlandı.
