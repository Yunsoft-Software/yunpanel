# Website Canonical Unix Identity Isolation Migration & Rollback Live Acceptance — 2026-09-20

## Özet

Ubuntu 24.04 LTS kurulu YunPanel test sunucusunda (`157.180.11.28` — `.28`, hostname `test`), `T-PROVISIONING` kapsamındaki aşağıdaki madde canlı ortamda uçtan uca doğrulanmıştır:

> Canonical Unix user/group/HOME tamamen eksik legacy Website fixture'ında isolation audit yalnız all-missing exact preview için identity apply açsın. Authenticated typed-confirmation apply durable identity receipt yazıp canonical `yunapp-*` user/group/HOME oluştursun; mutation/evidence sınırında restart tamamlanmış receipt'i inspection ile kapatsın, belirsiz state'i kör replay etmesin. Pre-existing user/group/HOME veya yanlış shell/mode/owner state fail-closed kalsın. Typed rollback user/group'u yalnız receipt ownership'iyle geri alsın; HOME boşsa kaldırabilsin, HOME içine veri eklendiyse recursive silmeden koruyup panelde `preservedHomeData` evidence'ı göstersin.

---

## Test Ortamı ve Hedef Kimlikler

- **Test Edilen Web Sitesi**: `provtest.webrich.news`
  - Website ID: `01944d99-9289-5b83-90f7-cec1402e6722`
  - Application ID: `392d53e7-a6f5-5f12-85cb-828a3f4211cf`
  - Canonical Unix User / Group: `yunapp-d4c467173909` (UID 990, GID 990)
  - Canonical HOME: `/var/lib/yunpanel/data/392d53e7-a6f5-5f12-85cb-828a3f4211cf` (mode `0750`)

---

## Doğrulanan Yaşam Döngüsü ve Güvenlik Adımları

### 1. Cascading Identity Audit & All-Missing Preview İzolasyonu
- `apps/api/src/website-isolation-audit.js` üzerinde `cascadingIdentityDefect` koruması uygulandı: `unix_identity` eksik olduğunda ve `create_canonical_unix_identity` planlandığında, downstream adımların (SFTP, PHP-FPM pool vb.) Unix kullanıcısının henüz var olmamasından kaynaklanan zincirleme hataları migration changes listesine eklenerek planın kilitlenmesi engellendi.
- Canlı host üzerinde `userdel`, `groupdel` ve `rm -rf <home>` ile user, group ve HOME tamamen kaldırıldı.
- `GET /api/panel/websites/:id/isolation-audit` sorgulandı:
  - `status: "migration_required"`, `migrationRequired: true`.
  - `changes.length: 1`.
  - `action: "create_canonical_unix_identity"`.
  - `applyAvailable: true`.
  - `ownership: "operation_receipt_planned"`, `applyState: "requires_explicit_apply"`.
  - `previewDigest` ve typed confirmation (`migrate-isolation:<id>:<rev>:<digest>`) başarıyla üretildi.

### 2. Pre-existing State ve Drift Sınırları (Fail-Closed)
- **Pre-existing / Conflicted HOME**:
  - Hostta HOME dizini yanlış izinlerle (`0777`) oluşturulduğunda audit anında `applyAvailable: false` durumuna düştü, adım `applyState: "blocked"` oldu. Eski onay ile gönderilen apply isteği `409 Conflict` ile reddedildi.
- **Pre-existing / Yanlış Shell User**:
  - Hostta Unix kullanıcısı `/bin/bash` login shell'i ile oluşturulduğunda audit `applyAvailable: false` olarak kilitlendi.
- **Request Sınırları**:
  - Var olmayan website ID: `404 Not Found`.
  - Geçersiz onay metni: `400/409` ret.
  - Tahrif edilmiş / uyuşmayan digest: `409 Conflict`.

### 3. Authenticated Typed-Confirmation Apply & Host Kaynakları
- Temiz all-missing durumda geçerli confirmation ile migrasyon başlatıldı (`POST /api/panel/websites/:id/isolation-migrations`):
  - Operasyon oluşturuldu (`operationId: a49dc7dc-e716-4119-ab8e-f9260936f2e3`, durum `succeeded`).
- **Host Seviyesinde Doğrulama**:
  - `getent passwd yunapp-d4c467173909`: `yunapp-d4c467173909:x:990:990::/var/lib/yunpanel/data/392d53e7-a6f5-5f12-85cb-828a3f4211cf:/usr/sbin/nologin` (UID 990, GID 990, nologin shell).
  - `getent group yunapp-d4c467173909`: `yunapp-d4c467173909:x:990:` (izole tekil grup).
  - HOME dizini: `/var/lib/yunpanel/data/392d53e7-a6f5-5f12-85cb-828a3f4211cf`, mode `0750`, mülkiyet `990:990`.
  - Durable Identity Receipt: `/var/lib/yunpanel/staging/website-identities/a49dc7dc-e716-4119-ab8e-f9260936f2e3.json` oluşturuldu, izinleri root-private `0600` olarak doğrulandı.

### 4. API Restart & Inspection Sınırı
- `systemctl restart yunpanel-api` ile servis yeniden başlatıldı.
- `GET /api/panel/websites/:id/isolation-migrations/:opId` sorgulandı:
  - Durum `succeeded` olarak korundu, makbuz inspect edildi, kör mutation replay yapılmadı.

### 5. Boş HOME için Typed Rollback
- `rollback-isolation-migration:<opId>:<digest>` onayı ile rollback uygulandı:
  - Durum: `compensated`.
  - Sonuç: `removedUser: true`, `removedGroup: true`, `removedHome: true`.
- **Host Doğrulaması**:
  - `getent passwd yunapp-d4c467173909`: `null` (kullanıcı silindi).
  - `getent group yunapp-d4c467173909`: `null` (grup silindi).
  - `fs.existsSync(homeDir)`: `false` (boş HOME dizini temizlendi).

### 6. HOME Veri Koruma & `preservedHomeData` Kanıtı
- Kimlik migrasyonu tekrar uygulandı (`operationId: 221b9358-2672-40d3-8077-a9a380fbace9`).
- HOME dizini içine kritik kullanıcı verisi yerleştirildi: `/var/lib/yunpanel/data/392d53e7-a6f5-5f12-85cb-828a3f4211cf/important_user_database.sqlite`.
- Typed rollback çalıştırıldı (`rollback-isolation-migration:221b9358-...:<digest>`):
  - API Yanıtı: `status: "compensated"`, `compensation: {"satisfied": true, "removedUser": true, "removedGroup": true, "removedHome": false, "preservedHomeData": true}`.
- **Host Seviyesinde Doğrulama**:
  - Unix kullanıcısı ve grubu kaldırıldı (`userdel`/`groupdel` başarılı).
  - HOME dizini **silinmedi** (`fs.existsSync(homeDir) === true`).
  - Kullanıcı dosyası `important_user_database.sqlite` içeriği ve kendisi **eksiksiz korundu**. Özyinelemeli / yıkıcı silme yapılmadı.
