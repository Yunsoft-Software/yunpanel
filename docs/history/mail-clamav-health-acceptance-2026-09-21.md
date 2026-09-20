# Mail ClamAV Health and Fail-Closed Live Acceptance (.28 Test Sunucusu)

- **Tarih**: 2026-09-21
- **Hedef Sunucu**: `157.180.11.28` (hostname: `test`, `YUNPANEL_LOCAL_SERVER_ID: 99bc760a-d508-4ae6-92be-efdedee9658d`)
- **İlgili Görev**: `T-MAIL` — ClamAV İsteğe Bağlı Profil Sağlık ve Fail-Closed Doğrulaması
- **Test Scripti**: `.local/verify-clamav-health-acceptance.mjs`

---

## 1. Kapsam ve Doğrulanan Güvenlik Kontratları

1. **Varsayılan Kapalı Profil**:
   - `GET /api/panel/settings` çıktısında `mail.security.antivirus` denetlendi:
     - `profile: "disabled"`, `enabled: false`, `active: false`, `healthy: false`, `status: "disabled"`, `blockers: []`.

2. **Eksik/Sağlıksız Durumda Aktif Göstermeme (Fail-Closed)**:
   - `PATCH /api/panel/settings` ile `mailSecurity.antivirusProfile: "clamav"` etkinleştirildi.
   - Sunucuda `clamav-daemon` paketi, servisi ve soketi bulunmadığı için denetim yapıldı:
     - `enabled: true`.
     - **`active: false`** (antivirüs asla aktif gösterilmez).
     - `healthy: false`.
     - `status: "unhealthy"`.
     - `blockers`: `["clamav_package_missing", "clamav_service_inactive", "clamav_socket_missing"]`.
   - "Kaynak yeterliliği/health; eksikse mail hazırmış gibi gösterme" ve "ClamAV optional profile; health yoksa aktif gösterme" kuralları tam olarak doğrulandı.

3. **Temiz Geri Alma (Revert)**:
   - Profil `disabled` olarak geri alındı; durum anında `disabled` ve blockersız hale döndü.
