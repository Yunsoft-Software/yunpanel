# Pre-Existing Local Zone Re-Apply, Rollback ve Failure Injection Canlı Kabul Raporu (2026-09-21)

## Kapsam ve Amaç

Bu rapor, YunPanel'in daha önceden var olan yerel DNS zoneları (pre-existing local zones) için sunduğu:
- Dayanıklı yeniden uygulama (durable zone re-apply),
- Mutasyon öncesi exact normalized before snapshot ile beklenen after snapshot/digest'in kök-yetkili (`0600`) operasyon günlüğüne (`dns-zone-reapply-operations.json`) kaydedilmesi,
- Var olan manuel RRset/content/comment/kind/DNSSEC kanıtlarının (`mailtest.webrich.news` gibi) eksiksiz korunması,
- PATCH cevabı öncesi/sonrası kesintiye uğrayan durumlarda inceleme öncelikli (`inspect-first`) mutabakat ile mükerrer mutasyon replay edilmeden `succeeded` durumuna bağlanması,
- Yalnızca journaled before/after parçalarından oluşan karışık durumda `dns_zone_reapply_partial_apply_detected` ile failed-but-rollbackable kalması,
- Yabancı/yönetilmeyen üçüncü durum (foreign drift) varlığında rollback'in fail-closed durarak bilinmeyen veriyi ezmesinin engellenmesi,
- Tip korumalı (typed) rollback'in operation ID, monoton `updatedAt` ve digest doğrulamasıyla zone silme/yeniden oluşturma yapmadan yalnızca operasyona ait RRset'leri geri alması ve manuel kayıtları koruması,
- `rolling_back` sırasında sürecin kesilmesi halinde yeniden başlatmada inceleme öncelikli (`inspect-first`) çalışıp hedef durum kanıtlanırsa `rolled_back` kapanması, aksi halde otomatik replay yapmayıp `rollback_failed` ile açık operatör yeniden denemesi (`explicit operator retry`) gerektirmesi

yeteneklerinin `.28` (`157.180.11.28`, test sunucusu, Ubuntu 24.04 LTS) üzerinde ve canlı `webrich.news` zone'unda failure-injection ile doğrulanmasını belgeler.

Kural gereği `.44` (Plesk) sunucusuna dokunulmamış, tüm testler `.28` test sunucusunda yürütülmüştür.

---

## Doğrulanan Bileşenler ve Fazlar

Test scripti `/root/acceptance-dns-zone-reapply-rollback-live.mjs` olarak hazırlanmış ve `.28` sunucusunda doğrudan yürütülmüştür.

### Faz 1: Mutasyon Öncesi Snapshot'lar, Manuel Kayıt Koruması ve Kök-Yetkili Günlük (0600)
- Sistem `dnsZoneTemplateRegistry` üzerinde template sürümünü v1'den v2'ye güncelledi (`reapply-test` TXT kaydı eklendi).
- `reapplyService.preview` çalıştırılarak manuel kayıt koruma sayısı (`preservedManualRrsetCount: 1`, `mailtest.webrich.news`) doğrulandı.
- `captureRollbackSnapshot` çağrısı ile `sourceZoneSnapshot` ve `appliedZoneSnapshot` (ve ilgili sha256 özetleri) oluşturuldu; her iki snapshot'ta da `mailtest.webrich.news` NS kaydının korunduğu kanıtlandı.
- Operasyon günlüğü (`/var/lib/yunpanel/control-plane/dns-zone-reapply-operations.json`) `0600` modunda root sahipliğinde oluşturuldu (`status: 'pending'`).

### Faz 2: PATCH Kesinti Sınırı ve İnceleme Öncelikli (Inspect-First) Mutabakat
- Operasyon `markApplying` ile `applying` durumuna alındı.
- PowerDNS hostuna `apply` çağrısı ile değişiklikler uygulandı (`reapply-test.webrich.news` eklendi, SOA seri numarası arttı).
- Sunucu çöküşünü simüle etmek üzere operasyon `applying` durumundayken `reapplyRuntime.run(operation.id)` çağrıldı.
- Sistem canlı zonu inceleyerek hedef durumun zaten oluştuğunu tespit etti, PowerDNS'e mükerrer PATCH göndermeden (SOA seri numarası değişmeden) operasyonu `succeeded` durumuna mutabık kıldı.

### Faz 3: Karışık Durum (Mixed State) ve `dns_zone_reapply_partial_apply_detected`
- Şablon v3'e yükseltildi (`reapply-test-2` eklendi) ve yeni operasyon oluşturuldu.
- Değişiklikler canlı zona uygulandı; ardından kesintiye uğramış kısmi mutasyonu simüle etmek amacıyla yalnızca `reapply-test-2` kaydı silinerek before ve after parçalarından oluşan operasyon sahipliğinde bir karma durum üretildi.
- `inspectRollback` çağrısı zone'un `repairCandidate: true` olduğunu teyit etti.
- `reapplyRuntime.run` bu durumu algılayarak operasyonu `dns_zone_reapply_partial_apply_detected` hata koduyla `failed` olarak işaretledi; operasyonun geri alınabilirliği (`rollback.available: true`) korundu.

### Faz 4: Yabancı / Yönetilmeyen Üçüncü Durumda (Foreign Drift) Fail-Closed Koruma
- Canlı zona bilinmeyen ve yönetilmeyen bir TXT kaydı (`unmanaged-foreign-drift`) enjekte edildi.
- `rollbackPreview` çağrısının yabancı sapmayı tespit ederek `powerdns_zone_restore_drift` (409) hatasıyla fail-closed durduğu kanıtlandı.
- `rollback` yürütme çağrısının fail-closed durarak yabancı kaydı silmeyi veya ezmeyi kesinlikle reddettiği doğrulandı.
- Yabancı kayıt temizlendi.

### Faz 5: Tip Korumalı Rollback Yürütümü ve Manuel Kayıt Koruması
- Bayat snapshot digest ile yapılan rollback isteğinin `dns_zone_reapply_rollback_stale` ile reddedildiği doğrulandı.
- Doğru operasyon ID'si, monoton `updatedAt` ve digest onaylarıyla rollback yürütüldü:
  - Operasyon durumu `rolled_back`, rollback durumu `succeeded` olarak güncellendi.
  - PowerDNS canlı zone'unda operasyonun eklediği `reapply-test-2` kaydının kaldırıldığı doğrulandı.
  - Pre-existing manuel `mailtest.webrich.news` NS kayıtlarının ve tepe A kaydının (`157.180.11.28`) eksiksiz korunduğu kanıtlandı.

### Faz 6: Kesintiye Uğrayan Rollback İnceleme ve Açık Operatör Yeniden Denemesi
- **Durum A (Geri alma zaten tamamlanmış, günlük `rolling_back` kalmış):**
  - Live zone before-state ile eşleştiğinde `rollbackPreview` zonu inceledi, mutasyon çalıştırmadan günlüğü güvenle `rolled_back` durumuna bağladı.
- **Durum B (Geri alma tamamlanmamış, zone henüz after-state'te, günlük `rolling_back` kalmış):**
  - `rollbackPreview` sunucuda geri almanın tamamlanmadığını tespit etti.
  - Otomatik host mutasyonu replay edilmedi; operasyon `rollback_failed` ve `dns_zone_reapply_rollback_interrupted` ile işaretlendi.
  - Açık operatör müdahalesi (`rollback.available: true`) için güncel confirmation üretildi.
  - Operatörün açık onayıyla çağrılan rollback retry çağrısı başarıyla çalıştı ve zonu `rolled_back` durumuna getirdi.

### Faz 7: Taban Çizgisi Temizliği ve Canlı Çözümleme Doğrulaması
- Testte kullanılan geçici TXT kayıtları temizlendi.
- Zone şablonu ve operasyon günlükleri orijinal taban çizgisine geri yüklendi.
- `pdnsutil check-zone webrich.news` hatasız tamamlandı.
- `dig @127.0.0.1 webrich.news A +norecurse` sorgusu ile `NOERROR` ve `157.180.11.28` doğrulaması yapıldı.

---

## Sonuç ve Kabul

Tüm 7 faz başarıyla tamamlanmış; `todo.md` üzerindeki pre-existing zone re-apply ve rollback maddesinin tüm kabul kriterleri canlı test ortamında failure injection eşliğinde eksiksiz olarak doğrulanmıştır.
