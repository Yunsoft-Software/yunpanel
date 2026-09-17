# Website database resources — 2026-09-17

Site detayındaki Bağlı Kaynaklar ekranı database ownership'i artık sunucu geneli listeyi tarayarak türetmez.

- `GET /api/servers/:serverId/websites/:websiteId/database-resources` authenticated local-server ve persisted Website kimliğini doğrular.
- Binding ve credential listeleri server + Website scope'unda okunur; credential'ın binding, schema, Website, Application ve site Unix user kimlikleri exact eşleşmeden response üretilmez.
- Duplicate binding/credential, orphan credential, cross-server veya cross-Website state `website_database_state_unavailable` ile fail-closed kalır.
- Response yalnız binding kimliği/schema/site user/revision ile credential username/localhost grants/revision/password-updated metadata'sını taşır. Password, ciphertext, private marker/path ve registry'nin bilinmeyen alanları allowlist dışında kalır.
- React Bağlı Kaynaklar görünümü bu scoped endpoint'i kullanır; DB user ve grant listesini ilgili Website satırında gösterir. Frontend model de scope kimliklerini ve bounded alanları yeniden doğrular.

Rotate/revoke, backup/restore ve drop-preview eylemlerinin aynı Website akışına eklenmesi `plan.md` içinde açık kalır. Gerçek iki-site izolasyon ve browser kabulü `todo.md` T-DATABASE altındadır.
