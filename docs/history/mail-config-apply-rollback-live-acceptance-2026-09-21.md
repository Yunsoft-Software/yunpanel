# Mail Configuration Apply and Rollback Live Acceptance Report

**Tarih**: 2026-09-21  
**Hedef Sunucu**: `157.180.11.28` (hostname: `test`, Ubuntu 24.04 LTS)  
**Server ID**: `99bc760a-d508-4ae6-92be-efdedee9658d`  
**Test Edilen Alan Adı**: `mailtest.webrich.news` (Mail Domain ID: `0fa91f02-e2f9-5519-8be3-0e1072dfa41f`)  
**Kapsam**: `T-MAIL` line 49 — Mail config apply (v3 receipt, backup, readiness), failure injection on apply and rollback, rollback preview, compensation snapshot, durable rollback restore, non-decrementing revision fence, and secret masking.

---

## 1. Özet ve Kabul Sonuçları

`todo.md` dosyasındaki `T-MAIL` line 49 maddesi uyarınca, canlı test sunucusu (`.28`) üzerinde Mail Config Apply ve Rollback yaşam döngüsü uçtan uca test edilmiş ve doğrulanmıştır.

### Başarıyla Doğrulanan Kriterler:
1. **Mail Config Preview**:
   - `expectedRevision: 4`, `status: enabled` ile önizleme alındı.
   - `readyToApply: true`, 64 karakterli SHA-256 `previewDigest` (`d2019c61...`), `configurationSha256` (`27547526...`) ve `confirmation` (`apply-mail-configuration:...`) üretildi.
2. **Failure Injection on Config Apply**:
   - Stale / geçersiz `previewDigest` gönderimi: 409 `mail_configuration_preview_stale` ile reddedildi.
   - Hatalı `confirmation` gönderimi: 409 `mail_configuration_preview_stale` ile reddedildi.
   - Uyuşmayan `expectedRevision`: 409 ile reddedildi.
3. **Valid Config Apply Execution**:
   - HTTP 202 ile iş kuyruğa alındı (Job ID: `99d8c0b4-9ce2-44ec-bee9-a43406881a9d`).
   - İş başarıyla tamamlandı (`status: succeeded`).
   - Sürüm v3 apply sonucu doğrulandı:
     - `version: 3`
     - `applied: true`, `sideEffects: true`
     - `backupSha256: 7c90addc6bdb568827bb15d2cbeb13fb84f25e8bb2c74465039aa5451e340fc1`
     - `planSha256: 6339949646ee51b15a77da4ef409e2a4617dd31a2e1a43876508ffe284e6fe12`
     - `readinessSha256: 9a857d9578a012a0b1d00e57efafff78900a50a9a80f45bd36fe86c1f8f5f9b8`
   - Parola hash'i, argon2, private key, mailbox şifresi gibi hassas verilerin yanıta veya loga sızmadığı doğrulandı.
4. **Mail Config Rollback Preview**:
   - En son başarılı v3 apply işi (`99d8c0b4-...`) için rollback önizlemesi alındı.
   - `sourceApplyJobId`, `backupSha256` doğruluğu teyit edildi.
   - `previewDigest` (`a94dbe5a...`) ve `confirmation` (`rollback-mail-configuration:...`) üretildi.
5. **Failure Injection on Rollback**:
   - Stale / geçersiz rollback `previewDigest`: 409 `mail_configuration_rollback_preview_stale` ile reddedildi.
   - Hatalı `confirmation`: 409 `mail_configuration_rollback_preview_stale` ile reddedildi.
   - Var olmayan / sahte `sourceApplyJobId`: 404 ile fail-closed reddedildi.
6. **Valid Config Rollback Execution**:
   - HTTP 202 ile rollback işi kuyruğa alındı (Job ID: `5e0a4380-d8b9-49df-ba09-7c76ee0caa8d`).
   - İş başarıyla tamamlandı (`status: succeeded`).
   - Rollback sonucu doğrulandı:
     - `version: 1`
     - `restored: true`, `sideEffects: true`
     - `compensationBackupSha256: 94af540817af8e39b38c7ba1ad0c4192e16c818c2e372d8a78a2d8b11f9a50f2`
   - Hiçbir hassas bilginin log/public çıktıya sızmadığı teyit edildi.
7. **Post-Rollback State & Health**:
   - Rollback sonrası alan adı durumu incelendi: `status: enabled`, `revision: 4`.
   - Geri alma sırasında revizyon numarasının geriye düşürülmediği (monotonik artış / koruma) doğrulandı.
   - Tüm Postfix/Dovecot/Rspamd servisleri ve LMTP/submission soketleri sağlıklı durumda kaldı.

---

## 2. Giderilen Host Entegrasyon Sorunu

Postfix 3.8+ / Ubuntu 24.04 üzerinde:
- `postconf -M <service>/<type>` komutunun, `master.cf` içindeki servis tanımının yanı sıra servise ait `-o` parametre geçersiz kılmalarını da döndürdüğü;
- `postconf -P <service>/<type>/<param>` komutunun çıktısının `key = value` (eşittir etrafında boşluklu) biçiminde olduğu tespit edilmiştir.
`packages/host-runtime/src/mail-config-evidence-inspector.js` içindeki `postfixMasterServiceSatisfied` fonksiyonu, hem `-o` parçalarını ayırarak taban servis tanımını denetleyecek hem de parametre çıktısındaki eşittir çevresi boşlukları normalize edecek şekilde güncellenmiş ve birim testleri ile canlı ortamda doğrulanmıştır.
