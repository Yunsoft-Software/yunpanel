# Website database resources — 2026-09-17

Site detayındaki Bağlı Kaynaklar ekranı database ownership'i artık sunucu geneli listeyi tarayarak türetmez.

- `GET /api/servers/:serverId/websites/:websiteId/database-resources` authenticated local-server ve persisted Website kimliğini doğrular.
- Binding ve credential listeleri server + Website scope'unda okunur; credential'ın binding, schema, Website, Application ve site Unix user kimlikleri exact eşleşmeden response üretilmez.
- Duplicate binding/credential, orphan credential, cross-server veya cross-Website state `website_database_state_unavailable` ile fail-closed kalır.
- Response yalnız binding kimliği/schema/site user/revision ile credential username/localhost grants/revision/password-updated metadata'sını taşır. Password, ciphertext, private marker/path ve registry'nin bilinmeyen alanları allowlist dışında kalır.
- React Bağlı Kaynaklar görünümü bu scoped endpoint'i kullanır; DB user ve grant listesini ilgili Website satırında gösterir. Frontend model de scope kimliklerini ve bounded alanları yeniden doğrular.
- Site Owner credential parolasını Website satırından typed confirmation ile döndürebilir. UI mevcut credential revision'ını backend'e pinler; güncel apply preview'daki credential/binding revision, desired-state SHA-256 ve confirmation değerlerini değiştirmeden durable apply job'ına taşır.
- İş database resource lock'ına bağlanır, job drawer'da izlenir ve başarılı terminal sonuçtan sonra Website kaynağı yenilenir. Üretilen parola hiçbir request input'una, frontend state'ine, response alanına veya job metadata'sına girmez.
- Apply öncesi geçici hata yeni secret desired-state'ini korur; terminal job failure/cancellation sonrasında yeni kullanıcı onayı yeni revision üretmeden otomatik replay yapılmaz.
- Credential revoke da Website satırından typed confirmation ile yürür: güncel delete preview exact revision/digest ile durable host delete job'ına çevrilir; registry kaydı yalnız aynı credential/binding state'ine ait başarılı job kanıtından sonra finalize edilir.
- Revoke schema'yı ve Website binding'i korur. Failed/cancelled veya sonucu okunamayan delete işi otomatik yeniden kuyruğa alınmaz; mevcut job tanısı Owner'a bırakılır.
- Website satırındaki `Yedek al` eylemi credential varlığına bağlı değildir; exact schema adıyla typed confirmation ister ve mevcut `database.backup` durable job'ını kullanır. Native vendor dump root-private artifact, bounded metadata ve checksum kanıtı üretmeden UI başarı göstermez.
- Backup job bilinmeyen veya terminal hata durumunda ikinci bir işi otomatik kuyruğa almaz; Owner mevcut job drawer tanısını görür. Başarılı backup kimliği restore seçimi için public job evidence'ında kalır.
- Restore seçicisi yalnız aynı local server ve schema için terminal `database.backup` job'ı ile exact `result.backupId`, engine, checksum, byte ve timestamp kanıtı eşleşen allowlisted kayıtları gösterir; private dump path veya bilinmeyen result alanlarını UI modeline taşımaz.
- Seçilen artifact backend restore preview'ında yeniden doğrulanır. UI server/schema/backup identity, preview SHA-256, backup SHA-256 ve confirmation bağını fail-closed kontrol eder; typed schema onayından sonra exact preview durable restore job'ına çevrilir.
- Başarılı restore pre-restore vendor dump kimliği, checksum ve post-restore verification kanıtı olmadan terminal başarı sayılmaz. Failed/cancelled veya belirsiz restore otomatik replay edilmez.

Drop-preview eyleminin aynı Website akışına eklenmesi `plan.md` içinde açık kalır. Gerçek iki-site izolasyon, rotation/revoke, backup/restore ve browser kabulü `todo.md` T-DATABASE altındadır.
