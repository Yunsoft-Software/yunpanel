# Website-Scoped Database Vendor Dump/Restore Live Acceptance (.28 Test Sunucusu)

- **Tarih**: 2026-09-21
- **Hedef Sunucu**: `157.180.11.28` (hostname: `test`, `YUNPANEL_LOCAL_SERVER_ID: 99bc760a-d508-4ae6-92be-efdedee9658d`)
- **İlgili Görev**: `T-DATABASE` — Website-Scoped Database Vendor Dump/Restore Acceptance (`todo.md` line 56)
- **Test Scripti**: `.local/verify-website-database-scoped-restore-acceptance.mjs`

---

## 1. Kapsam ve Doğrulanan Güvenlik Kontratları

1. **Global Endpoint Koruması (Bound Database Scope Check)**:
   - Bir website'a bağlanmış olan `site_a_db` veritabanı için global `POST /api/panel/servers/:serverId/databases/:name/restore-preview` endpoint'i çağrıldı; istek 409 `database_restore_website_scope_required` hatasıyla fail-closed reddedildi.
   - Aynı şekilde global `POST /api/panel/servers/:serverId/databases/:name/restore` endpoint'i de 409 `database_restore_website_scope_required` hatasıyla reddedildi.

2. **Website-Scoped Vendor Dump Alımı**:
   - Website A (`2689cb56-55a4-50c0-a3a4-258c7f2d48dd`) ve binding `da72dc47-d2e2-413a-a0a2-7b8766b0d58e` üzerinden scoped yedekleme isteği iletildi (`expectedBindingRevision: 1`).
   - Backup job'ı (`e78f5b2d-c932-4482-8997-bcd74cbe7a8c`) başarıyla tamamlandı.
   - Dump SHA-256 (`d21272fcde97da91927cc8bb9dc4d73faa33f84b665e7c96d6c2de8752176a24`) ve `backedUp: true`, `sideEffects: true` durable kanıtı üretildi.

3. **Cross-Site Restore Önleme (Çapraz Site Koruması)**:
   - Site A'ya ait veritabanı yedek ID'si (`e78f5b2d-c932-4482-8997-bcd74cbe7a8c`), Site B (`2c4ba551-df97-58e6-9bff-36a0e79c7b4e`) binding'i (`ef64c1b9-9989-4bd2-9da4-463269a0b95e`) üzerinden geri yüklenmeye çalışıldı.
   - İstek 409 `database_restore_backup_job_mismatch` ile fail-closed reddedildi.

4. **Stale Binding Revision Reddi**:
   - `expectedBindingRevision: 999` ile yapılan restore-preview isteği 409 `website_database_binding_revision_conflict` ile reddedildi.

5. **Geçerli Website-Scoped Restore Preview**:
   - Doğru parametrelerle (`expectedBindingRevision: 1`, `backupId`) restore-preview çağrıldı.
   - `previewDigest` (`d5279b538f7c1b9a5e4da1db603ffc00b6b115ab2b7600c2cb13dffa44f5b3fa`) ve deterministik `confirmation` token'ı (`restore-database:site_a_db:d5279b538f7c1b9a5e4da1db603ffc00b6b115ab2b7600c2cb13dffa44f5b3fa`) başarıyla elde edildi.

6. **Hata Enjeksiyonu (Failure Injection)**:
   - Stale / uyuşmayan `expectedPreviewDigest` ile yapılan restore apply isteği 409 ile reddedildi.
   - Geçersiz confirmation token (`wrong-confirmation`) ile yapılan restore apply isteği 409 ile reddedildi.

7. **Geçerli Website-Scoped Restore Apply ve Pre-Restore Snapshot**:
   - Doğru kanıtlarla restore apply isteği gönderildi (job `e7f0e14b-5cc2-4f5f-a79f-8cb3a6cf5c87`).
   - Geri yükleme job'ı başarıyla tamamlandı:
     - `restored: true`
     - Güvenlik önlemi olarak otomatik alınan pre-restore snapshot: `preRestoreBackupId: pre-restore:e7f0e14b-5cc2-4f5f-a79f-8cb3a6cf5c87`.
