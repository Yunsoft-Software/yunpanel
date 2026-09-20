# Python Runtime Live Acceptance — 2026-09-20

## Özet

Ubuntu 24.04 LTS kurulu YunPanel test sunucusunda (`157.180.11.28` — `.28`, hostname `test`), `todo.md` altındaki şu P0 maddesi canlı ortamda uçtan uca doğrulanmıştır:

> Python runtime kabulü: Ubuntu 24.04 test sunucusunda `python3` ve `python3-venv` kurulu iken dedicated site kullanıcısı altında venv (`/var/lib/yunpanel/data/<applicationId>/venv`) oluşturulduğunu, `requirements.txt` varsa bağımlılıkların izole yüklendiğini, systemd unit'in (`yunpanel-python-<appId>.service`) unix socket (`/run/yunpanel/python-<appId>.sock`) veya loopback TCP portu üzerinde Gunicorn/Uvicorn ile çalıştığını, Nginx reverse proxy hedefinin doğru bağlandığını ve restart/rollback operasyonlarının servis sürekliliğini koruduğunu doğrula.

---

## Test Ortamı ve Canlı Çalıştırma

- **Hedef Sunucu**: `157.180.11.28` (Ubuntu 24.04 LTS, hostname `test`)
- **Yürütülen Script**: `/root/acceptance-python-runtime.mjs`
- **Tarih**: 2026-09-20T19:37:50Z
- **Sonuç**: `satisfied: true` (Tüm 9 kontrol eksiksiz geçti)

---

## Doğrulanan Adımlar ve Güvenlik Sınırları

### 1. Ön Koşul Kontrolü (Prerequisites Check)
- Sunucuda `/usr/bin/python3` (Python 3.12.3) ve `python3-venv` (`python3.12-venv` / `ensurepip`) kurulu olduğu doğrulandı (`venvAvailable: true`).
- `python-site-manager` içerisindeki `ensurePrerequisites` fonksiyonu `python3 -c "import ensurepip"` çağrısıyla eksik `python3-venv` durumunu fail-closed tespit edecek şekilde güncellendi.

### 2. Site Kullanıcısı Kimliği ve Dizin İzolasyonu
- `identityManager.apply` ile dedicated site kullanıcısı oluşturuldu (`yunapp-d1fa8af53cbb`, UID 987, GID 987).
- Persistent data dizini `/var/lib/yunpanel/data/<applicationId>` mode `0750`, UID 987, GID 987 olarak doğrulandı.

### 3. Sanal Ortam (Virtualenv) Oluşturma
- `pythonManager.ensureVirtualenv` ile `/var/lib/yunpanel/data/<applicationId>/venv` sanal ortamı dedicated site kullanıcısı altında izole olarak oluşturuldu.
- `venv/bin/python` ve `venv/bin/pip` çalıştırılabilir ikilileri doğrulandı.

### 4. Sürüm Hazırlığı ve İzolasyonlu Bağımlılık Kurulumu
- Sürüm dizini `/var/lib/yunpanel/apps/<applicationId>/releases/<release1>` oluşturuldu.
- `requirements.txt` (`gunicorn==23.0.0`) ve `wsgi.py` ("Hello from Python Release 1") oluşturuldu.
- `pythonManager.installRequirements` ile bağımlılıklar izole olarak venv içerisine yüklendi (`venv/bin/gunicorn` doğrulandı).
- `current` symlink'i `releases/<release1>` hedefine bağlandı.

### 5. Systemd Servisi ve Unix Domain Socket Modu
- `RUN_ROOT` (`/run/yunpanel`) mode `1777` (sticky-bit) ve `yunpanel.conf` tmpfiles yapılandırması güncellendi; site kullanıcısının kendi soketini izole oluşturabilmesi sağlandı.
- `pythonManager.apply` ile `yunpanel-python-d1fa8af53cbb2dd8.service` unit'i oluşturuldu ve başlatıldı.
- Servis durumu `active` (PID 1002366) ve Unix domain socket `/run/yunpanel/python-<applicationId>.sock` doğrulandı.

### 6. Nginx Reverse Proxy Entegrasyonu
- `renderPythonSiteConfig` ile Nginx reverse proxy yapılandırması (`unix:/run/yunpanel/python-<applicationId>.sock` upstream) oluşturuldu ve `/etc/nginx/sites-enabled/` altına yazıldı.
- `nginx -t` ve `systemctl reload nginx` sonrası `curl -H "Host: python-smoke-..." http://127.0.0.1/` çağrısıyla HTTP 200 ve beklenen yanıt ("Hello from Python Release 1") alındı.

### 7. Servis Yeniden Başlatma (Restart)
- `pythonManager.restart` çağrıldı; servis yeni PID (1002433) ile çalışmaya devam etti.
- Nginx üzerinden yapılan HTTP isteği kesintisiz HTTP 200 yanıtı döndürdü.

### 8. Yeni Sürüm (Release 2) ve Rollback Operasyonu
- Release 2 hazırlandı ("Hello from Python Release 2") ve `current` symlink'i Release 2'ye yönlendirildi. Servis restart sonrası HTTP 200 ile Release 2 yanıtı döndürdü.
- `current` symlink'i Release 1'e geri alındı (rollback). Servis restart sonrası HTTP 200 ile Release 1 yanıtı ("Hello from Python Release 1") döndürdü.

### 9. Loopback TCP Port Modu
- Servis TCP port moduyla (`port: 4255`) yeniden uygulandı (`active: true`, PID 1002616).
- Nginx yapılandırması `http://127.0.0.1:4255` upstream'ine güncellendi ve reloaded edildi.
- Nginx üzerinden yapılan HTTP isteği başarıyla HTTP 200 ve "Hello from Python Release 1" yanıtı döndürdü.

### 10. Temizlik (Cleanup & Compensation)
- Nginx yapılandırması kaldırılıp Nginx reload edildi.
- `pythonManager.compensate` ile systemd servisi durduruldu, unit dosyası kaldırıldı ve daemon reload yapıldı.
- Uygulama ve data dizinleri ile site kullanıcısı sistemden temizlendi.

---

## Sonuç

`todo.md` içerisindeki **Python runtime kabulü** maddesi Ubuntu 24.04 LTS test sunucusunda (`157.180.11.28`) eksiksiz olarak doğrulanmış ve tamamlanmıştır.
