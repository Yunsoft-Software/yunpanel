# OpenSSH SFTP Public Key Lifecycle & Credential İzolasyonu Gerçek Ortam Kabulü (2026-09-20)

Bu doküman, `.28` test sunucusunda (`157.180.11.28`, Ubuntu 24.04 LTS) OpenSSH SFTP yetkilendirme anahtarları yaşam döngüsü, root-owned dosya izinleri ve siteler arası erişim izolasyonunun gerçek ortam kabul testlerini belgeler.

---

## 1. Test Kapsamı ve Hedefler

- `POST /api/websites/:websiteId/sftp/keys`:
  - Özel anahtar (private key) gönderiminin fail-closed olarak `sftp_private_key_rejected` (HTTP 400) ile reddedildiğinin doğrulanması.
  - Açık anahtar eklendiğinde ham anahtar verisinin API yanıtında sızdırılmadığının (`publicKey` alanı yok) teyit edilmesi.
  - `/etc/ssh/yunpanel-authorized-keys` dizininin `0755` (`drwxr-xr-x`, root:root), site anahtar dosyasının `0644` (`-rw-r--r--`, root:root) olarak oluşturulduğunun ve `# Managed by YunPanel SFTP public keys v1\n` başlığı taşıdığının doğrulanması.
  - İlgili site kullanıcısının (`yunapp-*`) bu yetkili anahtarlar dosyasına veya üst dizinine yazma/değiştirme yetkisinin bulunmadığının teyit edilmesi.
- Gerçek OpenSSH SFTP Bağlantı İzolasyonu:
  - Site A (`webrich.news`, `yunapp-a404896cf12e`) anahtarı ile Site A SFTP bağlantısının başarılı olması (`sftp` exit code 0).
  - Site A anahtarı ile Site B (`mailtest.webrich.news`, `yunapp-71355c1cda8a`) SFTP bağlantısının reddedilmesi (`Permission denied (publickey)`).
  - Site B anahtarı ile Site B SFTP bağlantısının başarılı olması.
  - Site B anahtarı ile Site A SFTP bağlantısının reddedilmesi.
- Anahtar Rotasyonu (Rotate):
  - `POST /api/websites/:websiteId/sftp/keys/:keyId/rotate` ile anahtar rotasyonu yapıldığında eski anahtarın revizyonunun artırılarak `revoked` yapılması, yeni anahtarın aktifleşmesi.
  - Eski anahtarla SFTP bağlantısının anında kesilip reddedilmesi (`Permission denied`).
  - Yeni anahtarla SFTP bağlantısının başarıyla çalışması.
- Anahtar İptali (Revoke):
  - `POST /api/websites/:websiteId/sftp/keys/:keyId/revoke` ile aktif anahtarın iptal edilmesi.
  - Aktif anahtar sayısı sıfıra düştüğünde parolasız ve anahtarsız SFTP bağlantısının tamamen reddedilmesi.
  - Dosyada yalnızca managed header'ın kalması.
- Manuel Drift Tespiti ve Reconcile:
  - Site anahtar dosyasına harici/yetkisiz anahtar satırı eklendiğinde API denetiminde `satisfied: false, reason: "sftp_authorized_keys_outdated"` olarak yakalanması.
  - `POST /api/websites/:websiteId/sftp/keys/reconcile` çağrıldığında desired state'e idempotent olarak geri döndürülmesi (`satisfied: true`).
- Yönetilmeyen Dosya Çakışması (Unmanaged Conflict):
  - Dosya YunPanel header'ı taşımayan yabancı bir içerikle değiştirildiğinde `sftp_authorized_keys_unmanaged_conflict` (HTTP 409) ile fail-closed kalması ve üzerine yazılmasının reddedilmesi.
  - Header düzeltildikten sonra reconcile'ın başarıyla tamamlanması.
- API Restart ve Kalıcılık (Persistence):
  - `systemctl restart yunpanel-api` sonrasında kayıtların ve host üzerindeki yetkili anahtarların eksiksiz korunması, mükerrer anahtar oluşmaması.

---

## 2. Yürütülen Test Adımları ve Doğrulama Kanıtları

Tüm adımlar `node /tmp/test-sftp-lifecycle.mjs` otomasyonu ile `.28` test sunucusunda çalıştırılmış ve çıktılar doğrulanmıştır:

```text
=== Starting SFTP Public Key Lifecycle & Isolation Test ===
✔ Logged in successfully

[Step 1] Verifying private key submission is rejected fail-closed...
✔ Private key rejected with sftp_private_key_rejected (400)

[Step 2] Adding Key A to Site A...
✔ Key A added (id: aa39ad47-5fd0-423f-ae54-886dbec95184 ) without leaking raw public key
✔ Root directory (0755, root:root) and Site A file (0644, root:root) verified

[Step 3] Adding Key B to Site B...
✔ Key B added (id: 5e671012-ec87-4b8d-ba41-9793b089dca4 )

[Step 4] Testing real OpenSSH SFTP credential isolation...
✔ Key A -> Site A: Connection SUCCEEDED
✔ Key A -> Site B: Connection REJECTED (Permission denied)
✔ Key B -> Site B: Connection SUCCEEDED
✔ Key B -> Site A: Connection REJECTED (Permission denied)

[Step 5] Verifying site user cannot modify /etc/ssh/yunpanel-authorized-keys...
✔ Site user write to authorized_keys file REJECTED (Permission denied)

[Step 6] Testing Key Rotation on Site A (Key A -> Key A2)...
✔ Key rotated successfully (old revoked at rev 2, new active at rev 1)
✔ Old Key A -> Site A: REJECTED after rotation
✔ New Key A2 -> Site A: SUCCEEDED after rotation

[Step 7] Testing Key Revocation on Site A...
✔ Key revoked (status: revoked)
✔ Revoked Key A2 -> Site A: REJECTED (0 active keys, password disabled)

[Step 8] Testing Manual Drift Detection & Reconcile on Site B...
✔ Manual drift detected: satisfied=false, reason=sftp_authorized_keys_outdated
✔ Reconcile restored desired state: satisfied=true

[Step 9] Testing Unmanaged File Conflict (Fail-closed)...
✔ Unmanaged file conflict rejected fail-closed (HTTP 409, sftp_authorized_keys_unmanaged_conflict)
✔ Clean reconcile restored after conflict resolution

[Step 10] Testing API Restart & Persistence...
✔ Logged in successfully
✔ Registry and materialization verified intact after API restart without duplicates
✔ Cleaned up Site B test key

========================================================
🎉 ALL SFTP PUBLIC KEY LIFECYCLE & ISOLATION TESTS PASSED!
========================================================
```

---

## 3. Sonuç

- `todo.md` kapsamındaki:
  - SFTP public-key lifecycle'ı OpenSSH ile doğrulandı.
  - `/etc/ssh/yunpanel-authorized-keys` (0755, root:root) ve dosya izinleri (0644, root:root) doğrulandı.
  - Raw public key sızdırmama ve private key reddi doğrulandı.
  - İki site ve iki anahtar ile çapraz SFTP erişim izolasyonu, rotasyon, iptal, drift ve conflict kontrolleri başarıyla tamamlandı.
