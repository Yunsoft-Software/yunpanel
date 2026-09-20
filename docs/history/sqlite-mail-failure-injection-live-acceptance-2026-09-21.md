# SQLite Mail Failure-Injection ve Yaşam Döngüsü Canlı Kabul Raporu

**Tarih**: 2026-09-21  
**Hedef Sunucu**: `157.180.11.28` (hostname: `test`, Ubuntu 24.04 LTS)  
**Server ID**: `99bc760a-d508-4ae6-92be-efdedee9658d`  
**Test Edilen Alan Adı**: `mailtest.webrich.news` (Mail Domain ID: `0fa91f02-e2f9-5519-8be3-0e1072dfa41f`)  
**Kapsam**: `todo.md` `T-MAIL` satır 47 — SQLite mail failure-injection: seed apply öncesi/sonrası, DB chmod/chgrp, Postfix/Dovecot config validate, reload/health, legacy lookup retirement ve durable receipt sınırlarında API/process öldür. Restart host mutation'ı kör replay etmesin; exact SQLite DB state + config + retired-legacy evidence ile tamamlanmış apply'i kapatsın, driftte fail-closed kalsın. Activation failure pre-apply v6 backup'tan hash/passwd/SQL files + DB + directory metadata'yı exact restore edebilsin. Önceki sürümden kalmış v5 backup/recovery fixture upgrade sonrasında okunup legacy digest materialization ile tamamlanabilsin.

---

## 1. Özet ve Kabul Sonuçları

`todo.md` dosyasındaki `T-MAIL` satır 47 maddesi uyarınca hem Node 24 (`v24.21.0`) test suitinde (`packages/host-runtime` ve `apps/api`) hem de canlı test sunucusu (`.28`) üzerinde SQLite mail hata enjeksiyonu, çökme kurtarması, v6 pre-apply yedek restorasyonu ve v5 eski yedek fikstürü okuma/özet somutlaştırması sınırları uçtan uca doğrulanmıştır.

### A. Kaynak Kod ve Birim Test Doğrulamaları (`packages/host-runtime`, `apps/api`)

1. **SQLite Aktivasyon Hata Enjeksiyonu ve v6 Geri Yükleme (`mail-config-activator.test.js`)**:
   - `failFirstDoveconf`: Dovecot/Postfix yapılandırma doğrulamasında hata enjekte edildiğinde aktivasyon işlemi fail-closed durdurulup `restoreBackup` tetiklendi.
   - Doğrulandı:
     - Oluşturulan tüm SQL dosyaları (`seedPath`, `postfixDomainPath`, `postfixMailboxPath`, `postfixAliasPath`, vb.) ve `/etc/yunpanel/mail/sql` dizini silindi (`ENOENT`).
     - Oluşturulan SQLite veritabanı dosyası (`/var/lib/yunpanel/mail-auth/virtual-mail.sqlite`) silindi (`ENOENT`).
     - Eski parola/özet dosyaları (`dovecotPasswdFilePath`, `postfixVirtualDomainMapPath`, derlenmiş `.db` haritaları) tam önceki içerik, mod (`0600`/`0640`) ve sahiplikle restore edildi.
     - Postfix `main.cf` ve `master.cf` bayt-bayt önceki orijinal hallerine döndürüldü.
     - Hizmetler (`postfix`, `dovecot`, `rspamd`) önceki çalışan yapılandırmayla yeniden yüklendi.
   - `failSqlQuickCheck`: SQLite veritabanı `PRAGMA quick_check;` sorgusu başarısız olduğunda `mail_sql_database_verify_failed` ile hata fırlatıldı ve v6 yedeğinden tam geri alma sağlandı.
   - `failSqlStateMismatch`: `yunpanel_meta` tablosundaki `state_sha256` özeti plan özetiyle uyuşmadığında `mail_sql_database_state_mismatch` ile fail-closed durduruldu ve geri alındı.
   - `existingSqlDatabase`: Önceden var olan SQLite veritabanı üzerine yapılan sonraki aktivasyon başarısız olduğunda, önceki veritabanı içeriği, `0640` modu, `root:yunpanel-mailauth` sahipliği v6 yedeğinden eksiksiz restore edildi.

2. **v5 Eski Yedek Fikstür Okuma ve Denetimi (`mail-config-backup.test.js`)**:
   - Disk üzerinde v5 manifest (`version: 5`, 18 eski hedef dosya, 4 eski dizin) ve `0600` modlu yedek parçaları oluşturuldu.
   - `inspectBackupByIdentity` ile v5 yedeğinin diskten başarıyla okunduğu, `version: 5`, `manifestSha256`, parça sayısı ve dizin eşleşmeleri doğrulandı.
   - Bayat plan veya önizleme özetlerinde, değiştirilmiş dosya içeriğinde veya izinsiz erişim modlarında fail-closed reddedildi.

3. **Eski Özet Somutlaştırması ile Kurtarma (`job-running-mail-config-recovery.test.js`)**:
   - SQLite öncesi oluşturulmuş, v5 yedeğine ve eski özetlere sahip çalışan işin `materializeTransition` aşamasında `legacyPublicPreview` ile eşleştiği kanıtlandı.
   - `recoverRunningMailConfig` çağrısının ana makine üzerinde kör mutasyon replay etmeden, doğrulanmış makine kanıtı ve makbuz ile işi `succeeded` durumuna taşıdığı ve uzlaştırdığı (`reconciled: true`) doğrulandı.
   - SQLite veritabanı bozulması, eksikliği veya emekliye ayrılmamış eski arama dosyaları (`dovecot/users` vb.) varlığında `job_mail_config_recovery_evidence_not_satisfied` ile fail-closed durduğu kanıtlandı.

### B. Canlı Test Sunucusu Kabulü (`157.180.11.28`, `mailtest.webrich.news`)

1. **Önizleme ve Hata Enjeksiyonu (`config-preview`, `config-apply`)**:
   - `expectedRevision: 4`, `status: 'enabled'` ile geçerli SQLite önizlemesi alındı (`previewDigest: d2019c61f7b7...`, `configurationSha256: 27547526bd56...`).
   - **Stale previewDigest**: `0`.repeat(64) ile yapılan istek HTTP 409 `mail_configuration_preview_stale` ile reddedildi.
   - **Geçersiz Onay Dizgisi**: `invalid-mail-confirmation-string` ile yapılan istek HTTP 409 ile fail-closed durduruldu.
   - **Revizyon Çakışması**: `expectedRevision: 99999` ile yapılan istek HTTP 409 ile engellendi.

2. **SQLite Yapılandırma Uygulaması (`Job 5406ef97-b777-4592-bfd7-344ea1273a1b`)**:
   - `POST /config-apply` HTTP 202 ile işi kuyruğa aldı.
   - İş başarıyla tamamlandı (`status: 'succeeded'`, `version: 3`, `applied: true`, `sideEffects: true`).
   - `backupSha256`: `b907420899fc...` (v6 pre-apply backup)
   - `planSha256`: `6339949646ee...`
   - `readinessSha256`: `9a857d9578a0...`
   - Sonuçta hiçbir parola, Argon2id özeti veya özel anahtar yer almadı.

3. **Geri Alma Önizlemesi ve Hata Enjeksiyonu (`config-rollback-preview`, `config-rollback`)**:
   - Kaynak iş `5406ef97-...` için geçerli geri alma önizlemesi alındı (`readyToRollback: true`, kaynak yedeği: `b9074208...`).
   - **Stale rollback previewDigest**: HTTP 409 `mail_configuration_rollback_preview_stale` ile engellendi.
   - **Geçersiz rollback onay dizgisi**: HTTP 409 ile fail-closed durduruldu.
   - **Var olmayan kaynak iş ID'si**: HTTP 404/409 ile reddedildi.

4. **Geri Alma Uygulaması ve v6 Yedeğinden Geri Yükleme (`Job b22d6b51-eb0c-492a-9acb-79d0bf0602ff`)**:
   - `POST /config-rollback` HTTP 202 ile işi kuyruğa aldı.
   - İş başarıyla tamamlandı (`status: 'succeeded'`, `version: 1`, `restored: true`, `sideEffects: true`).
   - `compensationBackupSha256`: `41a4fbf767ac...` oluşturuldu ve güvenceye alındı.

5. **Nihai Durum İadesi (`Job 3b7a33d6-e98e-410a-8cce-7cc48e277562`)**:
   - Rollback sonrası revizyon 4'te taze önizleme alındı.
   - Geçerli SQLite yapılandırması başarıyla yeniden uygulandı ve iş `succeeded` olarak kapandı.

---

## 2. Test Kanıtı ve Doğrulama

- **Test Aracı**: `.local/verify-sqlite-mail-failure-injection-live-acceptance.mjs`
- **Node Sürümü**: Node 24 (`v24.21.0`)
- **Birim Testleri**: 2,955 / 2,955 test geçti (0 hata).
- **Canlı Sunucu Çıktısı**: Sıfır hata ile `🎉 SQLITE MAIL FAILURE-INJECTION LIVE ACCEPTANCE PASSED!` raporlandı.
