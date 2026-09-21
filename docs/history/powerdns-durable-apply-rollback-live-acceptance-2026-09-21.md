# PowerDNS Durable Apply, Explicit Rollback ve Failure Injection Canlı Kabul Raporu (2026-09-21)

## Kapsam ve Amaç

Bu rapor, YunPanel'in PowerDNS Authoritative Server üzerinde sunduğu dayanıklı (durable) konfigürasyon uygulama, kesinti kurtarma (interrupted apply boundary & inspect-first reconciliation), açık operatör yeniden denemesi (explicit operator retry), bayat digest korumalı rollback (explicit rollback), kök-yetkili (`0600`) ve dizin korumalı (`0700`) snapshot/compensation yönetimi, bozuk aday enjeksiyonuyla başarısız rollback simülasyonu ve telafi mekanizması (compensation recovery), karışık durum (mixed-state interrupted rollback) tamamlama ve yabancı sapma (foreign drift) durumunda fail-closed durma yeteneklerinin `.28` (`157.180.11.28`, test sunucusu, Ubuntu 24.04 LTS) üzerinde canlı olarak doğrulanmasını belgeler.

Kural gereği `.44` (Plesk) sunucusuna kesinlikle dokunulmamış, tüm testler `.28` test sunucusunda izole yürütülmüştür.

---

## Doğrulanan Bileşenler ve Fazlar

Test scripti `/root/acceptance-powerdns-durable-apply-rollback-live.mjs` olarak hazırlanmış ve canlı test sunucusunda doğrudan yürütülmüştür.

### Faz 1: İlk Mutasyon Öncesi Rollback Snapshot ve İzin Doğrulaması
- Hedef mutasyon intent'i (`secondaryDns: ['198.51.100.42']`) uygulandı.
- İlk mutasyon öncesinde `/var/lib/yunpanel/staging/powerdns/authoritative-rollback.json` snapshot'ı oluşturuldu.
- Snapshot dosyasının root sahipliğinde (`uid=0`), symlink olmayan düzenli dosya olduğu ve `0600` (`-rw-------`) erişim modunda saklandığı doğrulandı.
- Üst staging dizininin (`/var/lib/yunpanel/staging/powerdns`) `0700` (`drwx------`) olduğu kanıtlandı.
- Rollback snapshot içeriğinde `snapshotDigest` (64-karakter sha256), önceki konfigürasyon ve makbuz base64 içerikleri doğrulandı; ham API anahtarının maskelendiği teyit edildi.
- Operasyon günlüğü (`authoritative-operation.json`) `0600` modu ile `succeeded` durumuna geçti.

### Faz 2: Symlink ve Yetkisiz Değişiklik (Tamper) Reddi
- Rollback snapshot dosyası yerine `/etc/passwd` işaret eden sembolik link (symlink) yerleştirildi.
- Apply çağrısının mutasyona başlamadan fail-closed durarak `powerdns_rollback_snapshot_unsafe` hatası fırlattığı ve işlemi engellediği kanıtlandı.
- Gerçek snapshot geri yüklendi.

### Faz 3: Kesintiye Uğrayan Apply Sınırı ve İnceleme Öncelikli (Inspect-First) Mutabakat
- **Durum A (Hedef durum zaten sağlanmış):** Operasyon günlüğü sunucu çöküşünü simüle etmek üzere `applying` durumuna çekildi. Apply çağrıldığında sistem sunucu durumunu inceledi (`inspect-first`), hedef konfigürasyonun zaten sağlandığını görerek dosyaları yeniden yazmadan (`mtime` değişmeden) mükerrer mutasyon çalıştırmaksızın operasyonu `succeeded` durumuna bağladı.
- **Durum B (Hedef durum sağlanmamış / eksik mutasyon):** Konfigürasyona farklı bir IP enjekte edilip operasyon `applying` bırakıldı. Otomatik replay çalıştırılmadı; sistem operatör müdahalesi olmadan `powerdns_recovery_pending` hatası fırlatarak fail-closed durdu.

### Faz 4: Operatörün Açık Yeniden Denemesi (Explicit Operator Retry)
- Eksik kalan durumda operatör onaylı kurtarma çağrısı (`retryOnce`) yapıldı.
- Operasyon günlüğü güncellendi, mutasyon baştan hedeflenen konfigürasyonu (`198.51.100.42`) eksiksiz uygulayarak `succeeded` olarak tamamlandı.

### Faz 5: Önceki Topolojiye Açık Rollback ve Telafi (Compensation) Snapshot'ı
- Bayat snapshot digest ile yapılan rollback denemesinin `powerdns_rollback_snapshot_stale` ile reddedildiği doğrulandı.
- Doğru digest ile rollback çalıştırıldı:
  - Canlı konfigürasyon önceki topolojiye (`secondaryDns: []`) hatasız ve atomik geri döndü.
  - Operasyon günlüğü `rolled_back` durumuna geçti.
  - Rollback öncesinde doğrulanmış güncel durumu saklayan `authoritative-rollback-compensation.json` snapshot'ı oluşturuldu ve `0600` erişim modu doğrulandı.
  - Rollback sonrasında UDP 53, TCP 53 ve non-recursion soket sağlık kanıtları doğrulandı.
  - Tekrarlanan rollback çağrısının sistem stabilitesini bozmadan idempotent çalıştığı kanıtlandı.

### Faz 6: Rollback Hata Enjeksiyonu ve Telafi Kurtarması (Compensation Recovery)
- Snapshot içindeki önceki konfigürasyona sözdizimi hatası (`invalid_syntax_error_corrupt=true\n`) enjekte edildi.
- Rollback adayı etkinleştirilirken sözdizimi hatası nedeniyle aktivasyon başarısız oldu (`powerdns_rollback_config_invalid`).
- Günlük `rolled_back` yerine `rollback_failed` olarak kaydedildi (sahte başarı raporlanmadı).
- Telafi mekanizması otomatik devreye girerek compensation snapshot üzerinden güncel sağlıklı konfigürasyonu geri yükledi, PowerDNS yeniden başlatıldı ve soket sağlık testi başarıyla geçti.

### Faz 7: Karışık Durum (Mixed-State) ve Yabancı Sapma (Foreign Drift)
- **Sıra A (Config eski, Makbuz güncel):** Kesintiye uğrayan rollback simülasyonunda compensation doğrulanarak önceki hedefe tamamlama başarıyla sağlandı.
- **Sıra B (Makbuz eski, Config güncel):** Kesintiye uğrayan rollback simülasyonunda makbuz ve konfigürasyon önceki hedefe tamamlama başarıyla sağlandı.
- **Sıra C (Yabancı Sapma):** Konfigürasyona yönetilmeyen yabancı bir satır eklendiğinde, rollback fail-closed durarak `powerdns_rollback_current_state_unverified` hatası verdi ve bilinmeyen içeriği ezmeyi reddetti.

### Faz 8: Temiz Taban Çizgisi ve Sağlık Onayı (Guaranteed Baseline Restoration)
- `finally` bloğu garantisiyle sunucu konfigürasyonu, makbuzu ve operasyon günlüğü tertemiz taban çizgisine geri getirildi.
- `pdns_server --config=check` ve `systemctl restart pdns` çalıştırıldı.
- Yerel DNS sorgusu (`dig @127.0.0.1 webrich.news A +norecurse`) yapılarak `NOERROR` ve `157.180.11.28` cevabı alındığı canlı olarak doğrulandı.

---

## Canlı Test Çıktısı

```text
================================================================
  PowerDNS Durable Apply & Rollback Live Acceptance on .28      
  Server: 157.180.11.28 (hostname: test, OS: Linux)  
================================================================

✔ pdns.service is active
✔ PowerDNS API key materialized successfully
✔ Initial PowerDNS socket health verified (UDP 53, TCP 53, recursion refused)

--- Phase 1: Pre-Mutation Rollback Snapshot & Permissions ---
✔ Applied target intent with secondary DNS [198.51.100.42]
✔ Pre-mutation rollback snapshot verified root-owned 0600 in 0700 directory
✔ Rollback snapshot verified: digest=b4f52ccda42a6e4ff4f74700180e90e2de5f3f2c73aee2db24383ced9861994e, raw API key masked
✔ Operation journal status is succeeded with mode 0600

--- Phase 2: Symlink & Tamper Rejection ---
✔ Symlink rollback snapshot rejected with powerdns_rollback_snapshot_unsafe (fail-closed)

--- Phase 3: Interrupted Apply Boundary & Inspect-First Reconciliation ---
✔ Inspect-first reconciliation: interrupted applying operation closed as succeeded without duplicate replay
✔ Incomplete interrupted apply blocked fail-closed with powerdns_recovery_pending

--- Phase 4: Explicit Operator Retry ---
✔ Explicit operator retry succeeded and restored target state

--- Phase 5: Explicit Rollback & Verified Compensation Snapshot ---
✔ Rollback with stale snapshot digest rejected with powerdns_rollback_snapshot_stale
✔ Rollback succeeded: operation journal marked rolled_back
✔ Live config verified restored to exact previous topology (secondary DNS removed)
✔ Verified-current compensation snapshot persisted with mode 0600
✔ Repeated rollback is idempotent

--- Phase 6: Rollback Failure Injection & Compensation Recovery ---
✔ Rollback with invalid candidate rejected by config test
✔ Journal marked rollback_failed; does NOT report successful rollback
✔ Compensation mechanism successfully restored current config and verified socket health

--- Phase 7: Mixed-State Interrupted Rollback Completion ---
Testing Order A: Config is previous, receipt is current...
✔ Order A (config previous, receipt current) completed successfully to previous target
Testing Order B: Receipt is previous, config is current...
✔ Order B (receipt previous, config current) completed successfully to previous target
Testing Order C: Foreign drift rejection...
✔ Foreign drift during rollback rejected fail-closed

--- Phase 8: Final Restoration & Pristine Baseline ---
Loading '/usr/lib/x86_64-linux-gnu/pdns/libgsqlite3backend.so'
✔ PowerDNS restored to pristine baseline and confirmed healthy
✔ Authoritative DNS resolution for webrich.news verified (157.180.11.28)

================================================================
  🎉 ALL POWERDNS DURABLE APPLY & ROLLBACK TESTS PASSED!       
================================================================
```

---

## Sonuç

PowerDNS durable apply, kesinti kurtarma, explicit operator retry, explicit rollback, compensation snapshot ve fail-closed korumaları canlı ortamda eksiksiz kabul edilmiş, `todo.md` dosyasındaki ilgili iki kabul maddesi tamamlanmıştır.
