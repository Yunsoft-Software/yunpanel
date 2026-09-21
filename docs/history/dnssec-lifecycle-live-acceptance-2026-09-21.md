# DNSSEC Enable, Parent DS Durumları, Güvenli Kapatma, Restart Kurtarma ve Key Rollover Canlı Kabul Raporu (2026-09-21)

## Kapsam ve Amaç

Bu rapor, YunPanel'in Authoritative DNS altyapısında:
1. **Gerçek PowerDNS DNSSEC Etkinleştirme (Enable) ve Kriptografik Anahtar Üretimi**:
   - Güvenli rastgele ECDSA P-256 (algoritma 13) CSK anahtarlarının ve SHA-256 digest'lerinin üretilmesi,
   - `pdnsutil show-zone` ile canlı zone imzalamasının (RRSIG, DNSKEY) doğrulanması,
   - Özel anahtar (private key) malzemesinin API ve bellek katmanında kesinlikle sızdırılmaması,
2. **Üst Alan (Parent) DS Durum Geçişleri**:
   - Üst alan DS kaydı eksik olduğunda `pending_parent_ds` durumu ve açık registrar talimatlarının üretilmesi,
   - Üst alan DS kaydı eşleştiğinde `secure_ready` durumuna geçilmesi,
   - Uyuşmayan DS kaydında `parent_ds_mismatch` durumunun bildirilmesi,
   - İmzalama malzemesi eksikliğinde `signing_material_incomplete` durumunun verilmesi,
   - Üst alan sorgusu zaman aşımına uğradığında veya SERVFAIL döndüğünde sessizce "yok" sayılmayıp `parent_ds_unverifiable` olarak kilitlenmesi,
3. **Güvenli Kapatma (Disable) Koruyucuları ve Yeniden Eklenme Yarış Durumu (Race Condition)**:
   - Üst alanda DS mevcutken kapatma önizlemesinin `parent_ds_must_be_removed` ile engellenmesi,
   - Üst alan durumu doğrulanamazken kapatmanın `parent_ds_unverifiable` ile engellenmesi,
   - Üst alan DS kaydı kaldırıldığında kapatmaya izin verilmesi,
   - Önizleme onaylandıktan sonra üst alan DS kaydı yeniden eklenirse mutasyon anında yakalanıp `dnssec_preview_stale` ile reddedilmesi,
4. **Kalıcı İşlem (Durable Operation) ve Servis Restart Sonrası Kurtarma**:
   - `applying` durumunda sunucu yeniden başladığında işlemin mükerrer mutasyon yapmadan (`0 duplicate mutations`) başarıyla tamamlanması,
   - Kapatma esnasında restart sonrası üst alan DS geri gelirse işlemin `dnssec_disable_parent_regressed` hatasıyla başarısız olarak işaretlenmesi,
   - Üst alan doğrulanamaz hale gelirse işlemin `applying` durumunda güvenle bekletilmesi,
5. **Eksiksiz DNSSEC Key Rollover Yaşam Döngüsü**:
   - Aşama 1: `create_new_key` (yeni inaktif anahtar oluşturma, `keytype: 'csk'`),
   - Aşama 2: `publish_new_key` (yeni anahtarın DNSKEY olarak yayınlanması),
   - Aşama 3: `activate_new_key` (yeni anahtar ile zone imzalamasının başlatılması),
   - Aşama 4: `deactivate_old_key` (eski anahtarın inaktif edilmesi),
   - Aşama 5: `delete_old_key` (eski anahtarın temizlenmesi),
   - Devam önizlemesi (continuation preview) ve bayat onayların (`dnssec_rollover_continue_stale`) reddedilmesi

yeteneklerinin `.28` (`157.180.11.28`, test sunucusu, Ubuntu 24.04 LTS) üzerinde canlı olarak doğrulanmasını belgeler.

Kural gereği `.44` (Plesk) sunucusuna dokunulmamış, tüm testler `.28` test sunucusunda yürütülmüştür.

---

## Doğrulanan Bileşenler ve Fazlar

Test scripti `.28` test sunucusunda root yetkisiyle izole geçici zone (`dnssec-<hash>.webrich.news`) üzerinde yürütülmüştür.

### Faz 1: Gerçek PowerDNS DNSSEC Enable & Cryptokey Üretimi
- Canlı PowerDNS 4.8 üzerinde izole test zone'u oluşturuldu ve başlangıç durumu (`dnssec: false`, `keys: []`) doğrulandı.
- `manager.enableDnssec(...)` çağrısı ile gerçek CSK anahtarı üretildi:
  - Anahtar ID: 1
  - Algoritma: `ECDSAP256SHA256` (13), 256 bits
  - 3 farklı digest formatında DS üretimi doğrulandı (SHA-1, SHA-256, SHA-384).
- Host üzerinde doğrudan `/usr/bin/pdnsutil show-zone` çalıştırıldı:
  - Zone'un imzalandığı, RRSIG ve DNSKEY kayıtlarının üretildiği canlı olarak kanıtlandı.
  - Özel anahtarların (`content`, `privatekey`) API çıktılarına sızmadığı doğrulandı.

### Faz 2: Parent DS Durumları ve Geçişler
- Üst alan DS durumu mock resolver ile simüle edildi:
  - DS yokken: `status: 'pending_parent_ds'`, `secureReady: false`, `registrarInstructions` içinde eklenecek DS kayıtları eksiksiz listelendi.
  - DS eşleştiğinde: `status: 'secure_ready'`, `secureReady: true`.
  - DS uyuşmadığında: `status: 'parent_ds_mismatch'`, `secureReady: false`.
  - Yerel imzalama anahtarı eksik olduğunda: `status: 'signing_material_incomplete'`.
  - Üst alan zaman aşımı (ETIMEDOUT) / doğrulanamaz olduğunda: `status: 'parent_ds_unverifiable'`, sessizce DS yok varsayılmadı.

### Faz 3: Disable Güvenlik Koruyucuları ve Yarış Durumu Koruması
- Üst alanda DS mevcutken DNSSEC kapatma önizlemesi istendi:
  - `applyAllowed: false`, engelleyici hata kodu: `parent_ds_must_be_removed`.
- Üst alan doğrulanamazken kapatma önizlemesi istendi:
  - `applyAllowed: false`, engelleyici hata kodu: `parent_ds_unverifiable`.
- Üst alan DS kaydı kaldırıldığında:
  - `applyAllowed: true`, işlem onayı üretildi.
- Onay alındıktan sonra mutasyon öncesi üst alanda DS yeniden belirirse:
  - İşlem fail-closed olarak durduruldu ve `dnssec_preview_stale` hatası fırlatıldı.

### Faz 4: Durable İşlem ve Restart Sonrası Kurtarma
- `DnsZoneDnssecOperationRegistry` ile kalıcı işlem günlüğü test edildi:
  - `applying` durumunda kesilen enable işlemi, restart sonrası `init()` ile incelendi ve PowerDNS üzerinde mükerrer anahtar üretmeden başarıyla `succeeded` durumuna ulaştı (`0 duplicate mutations`).
  - Kapatma işlemi sırasında üst alanda DS geri geldiyse: restart sonrası işlem `dnssec_disable_parent_regressed` hatasıyla başarısız olarak işaretlendi.
  - Kapatma işlemi sırasında üst alan sorgulanamaz duruma geldiyse: işlem `dnssec_recovery_parent_unverifiable` ile `applying` durumunda beklemeyi sürdürdü.

### Faz 5: PowerDNS Canlı Key Rollover Yaşam Döngüsü
- Aşama 1 (`create_new_key`): İkinci CSK anahtarı inaktif olarak başarıyla üretildi (`id: 2`, `active: false`, `published: false`).
- Aşama 2 (`publish_new_key`): İkinci anahtar yayınlandı (`published: true`, `active: false`).
- Aşama 3 (`activate_new_key`): İkinci anahtar etkinleştirildi (`active: true`).
- Aşama 4 (`deactivate_old_key`): İlk anahtar pasifleştirildi (`id: 1`, `active: false`).
- Aşama 5 (`delete_old_key`): İlk anahtar PowerDNS'ten silindi (`id: 1`).
- Rollover sonucunda canlı zone'da yalnızca tek bir etkin CSK anahtarı (`id: 2`) kaldı.
- `previewContinue` ile üretilen devam önizlemesi ve bayat onay denemesinde `dnssec_rollover_continue_stale` fırlatıldığı doğrulandı.

---

## Temizlik ve Taban Çizgisi Doğrulaması

- Geçici test zone'u (`dnssec-<hash>.webrich.news`) PowerDNS üzerinden tamamen silindi.
- `pdnsutil check-zone webrich.news` kontrolü yapıldı; 0 hata ile geçti.
- Canlı sunucu adresi (`157.180.11.28`) üzerinden `webrich.news` DNS çözümlemesi doğrulandı.
