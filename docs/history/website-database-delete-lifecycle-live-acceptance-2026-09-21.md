# Website Database Delete Lifecycle Live Acceptance (.28 Test Sunucusu)

- **Tarih**: 2026-09-21
- **Hedef Sunucu**: `157.180.11.28` (hostname: `test`, `YUNPANEL_LOCAL_SERVER_ID: 99bc760a-d508-4ae6-92be-efdedee9658d`)
- **İlgili Görev**: `T-DATABASE` — Website Database Delete Lifecycle Live Verification
- **Test Scripti**: `.local/verify-database-delete-lifecycle-acceptance.mjs`

---

## 1. Kapsam ve Doğrulanan Güvenlik Kontratları

1. **Mevcut Şema Koruması ve Blocker Denetimi**:
   - `site_a_db` üzerindeki delete-preview sorgulandı; `database_credential_exists` ve `database_current_binding_backup_required` blocker'ları teyit edildi.
   - Blocker'lar aktifken premature delete çağrısı 409 `website_database_delete_not_ready` ile fail-closed reddedildi.
   - Blocker'lar aktifken premature finalize çağrısı 409 `website_database_delete_job_evidence_missing` ile fail-closed reddedildi.

2. **İzole Yaşam Döngüsü Testi (Dedicated Test Database)**:
   - Yeni veritabanı oluşturuldu (`test_del_muab8kzc`, job `7563f04e-077c-463d-aafe-eb4eae2c650c`).
   - Website `2689cb56-55a4-50c0-a3a4-258c7f2d48dd` ile bağlandı (bindingId `7509fc63-faf4-4c4c-af77-7ee37adc28b3`, revision `1`).
   - Credential oluşturuldu ve hosta uygulandı (`883dd2d8-abea-4c80-a472-386d328dae15`).
   - Delete preview'da hem `database_credential_exists` hem `database_current_binding_backup_required` görüldü.

3. **Credential Tasfiyesi ve Blocker Temizliği**:
   - Credential silindi (job `9b062d7e-decc-449c-8a24-f190274d3056`) ve finalize edildi.
   - Delete preview yeniden sorgulandı: `database_credential_exists` blocker'ının kalktığı, yalnızca `database_current_binding_backup_required` kaldığı doğrulandı.

4. **Scoped Vendor Dump Yedek Kanıtı**:
   - Binding kapsamlı yedek alındı (job `86894dc1-e934-4ad9-a5a9-b5725776516d`, SHA-256 `d8f11e7971247f75af36f90a32d8d5a1df2a76f63dc2fef6670dc3d94d421078`, dump boyutu `1653` byte).
   - Delete preview'ın `readyToDelete: true`, `blockers: []`, ve deterministik confirmation (`delete-website-database:7509fc63-faf4-4c4c-af77-7ee37adc28b3:1:f945258bdce491183ef916dc0dc782a48666bfc93bf7be28c3be1efa099b363a`) ürettiği teyit edildi.

5. **Failure Injection (Hata Enjeksiyonu)**:
   - Stale / geçersiz `previewDigest` ile yapılan DROP isteği 409 `website_database_delete_preview_stale` ile reddedildi.
   - Yanlış confirmation string ile yapılan DROP isteği 409 `website_database_delete_confirmation_invalid` ile reddedildi.

6. **DROP Operasyonu ve readyToFinalize Durumu**:
   - Geçerli kanıtlarla DROP isteği iletildi (job `3c616c07-3301-4c60-aaf6-cfac4af57ae0`).
   - Job başarıyla tamamlandı; MariaDB üzerinde `test_del_muab8kzc` şeması düşürüldü.
   - DROP sonrası delete-preview sorgulandı: `readyToDelete: false`, `readyToFinalize: true`, `completedDelete.jobId: 3c616c07-3301-4c60-aaf6-cfac4af57ae0` ve finalize confirmation üretildiği görüldü.

7. **Finalizasyon ve Güvenli Kapanış**:
   - `delete-finalize` endpoint'i çağrıldı; binding başarıyla kaldırıldı (`unbound: true`).
   - Finalizasyon sonrası sorgulanan delete-preview 404 dönerek kaynağın güvenli şekilde temizlendiğini doğruladı.
   - Canlı MariaDB üzerinde `site_a_db`, `site_b_db`, `roundcube` gibi temel veri tabanlarının dokunulmadan korunduğu teyit edildi.

---

## 2. Giderilen Hata

- `jobRegistry.getJob()` ve `jobRegistry.listJobs()` dahili fonksiyonlarının döndürdüğü `publicJob` nesnesinde `payload` alanı eksikti. Bu durum, dahili servislerin (`backupEvidence`, `completedDeleteEvidence`, `matchesOwnershipScope`) scoped job payload parametrelerini (`databaseBindingId`, `expectedBindingRevision`, `expectedBackupSha256` vb.) okumasını engelliyordu.
- `apps/api/src/job-registry.js` dosyasında `publicJob` nesnesine `payload: job.payload == null ? null : structuredClone(job.payload)` eklendi; harici istemcilere yönelik `jobPublicView` fonksiyonunda ise `delete view.payload;` ile secret koruması ve güvenlik izolasyonu korundu.
