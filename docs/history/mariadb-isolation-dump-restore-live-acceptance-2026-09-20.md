# MariaDB Güvenlik, Canlı Envanter, Site İzolasyonu ve Dump/Restore Canlı Kabulü (2026-09-20)

## Kapsam ve Amaç

Bu test, `todo.md` altındaki `T-DATABASE` (P0 site ownership ve canlı envanter) gereksinimlerinin `.28` test sunucusu (`157.180.11.28`) üzerinde canlı olarak doğrulanmasını kapsar:
1. MariaDB güvenlik temeli ve yerel Unix soket tabanlı yönetici kimlik doğrulaması (`inspectSecurityBaseline`).
2. Canlı veritabanı envanteri ve dinamik şema oluşturma (`createDatabase`, `inspect`).
3. Website başına izole kimlik bilgisi (credential) oluşturma (`applyCredential`).
4. Siteler arası erişim kısıtlaması (Site A kullanıcısının Site B veritabanına, Site B kullanıcısının Site A veritabanına erişiminin donanımsal olarak reddedilmesi).
5. Scoped veritabanı yedeği (dump) alma (`createDatabaseDumpManager`).
6. Veritabanı geri yükleme (restore) işlemi ve SHA-256 kanıt doğrulaması (`createDatabaseRestoreManager`).
7. Temiz telafi ve silme (credential revocation, schema drop, backup cleanup).

## Gerçekleştirilen Doğrulamalar ve Sonuçlar

### 1. MariaDB Güvenlik Temeli (Security Baseline)
- `createDatabaseManager().inspectSecurityBaseline()` çalıştırıldı.
- Motor: `mariadb`, Sürüm: `10.11.14-MariaDB-0ubuntu0.24.04.1`.
- Bağlantı: Protokol `socket`, Yönetici `root@localhost`, Kimlik doğrulama eklentisi `unix_socket`, `nativeSocketAuth: true`.
- Hijyen Kontrolleri:
  - Anonim hesaplar: Yok (`anonymousAccountsAbsent: true`).
  - Uzak root hesapları: Yok (`remoteRootAccountsAbsent: true`).
  - Test şeması: Yok (`testSchemaAbsent: true`).
- Sonuç: `ready: true`, `reason: null`.

### 2. Şema Oluşturma ve Canlı Envanter
- `createDatabase('test_live_db_a')` ve `createDatabase('test_live_db_b')` ile iki şema oluşturuldu.
- `dbManager.inspect().databases` üzerinden her iki şemanın canlı envanterde yer aldığı doğrulandı.

### 3. Website Başına Kimlik Bilgisi (Credential) Oluşturma
- `createDatabaseCredentialManager().applyCredential(...)` ile:
  - Site A için `ydb_17a310f00a82568ac092ec39` kullanıcısı `test_live_db_a` şemasına yetkilendirildi.
  - Site B için `ydb_47cf5202398a9fab5e71a0d1` kullanıcısı `test_live_db_b` şemasına yetkilendirildi.
- Her iki kullanıcının sadece kendi şeması üzerinde `SELECT`, `INSERT`, `UPDATE`, `DELETE`, `CREATE`, `DROP` yetkilerine sahip olduğu doğrulandı.

### 4. Siteler Arası İzolasyon (Cross-Site Access Control)
- **Site A Kendi Verisine Erişim**: Site A kullanıcısı `test_live_db_a` üzerinde `notes` tablosu oluşturdu, veri yazdı ve okudu (`Secret data from Site A`).
- **Site A -> DB B Engeli**: Site A kullanıcısı `test_live_db_b` şemasına erişmeyi denedi; MariaDB `Access denied for user 'ydb_17a310f00a82568ac092ec39'@'localhost' to database 'test_live_db_b'` hatasıyla işlemi engelledi.
- **Site B -> DB A Engeli**: Site B kullanıcısı `test_live_db_a` şemasındaki verileri okumayı denedi; MariaDB `Access denied for user 'ydb_47cf5202398a9fab5e71a0d1'@'localhost' to database 'test_live_db_a'` hatasıyla işlemi engelledi.

### 5. Veritabanı Yedeği (Dump) ve Geri Yükleme (Restore)
- `createDatabaseDumpManager().backup(...)` ile `test_live_db_a` şemasının yedeği alındı.
  - Yedek kimliği: `test-backup-1789933773947`.
  - SHA-256 Özeti: `ee7dbb991a4d61590d0c02337083ddeb5f4c069703ad2fe0446ad52e6d0309bb` (2.306 bayt).
- Yedek alındıktan sonra şemaya 2. bir satır eklendi ve satır sayısının 2 olduğu doğrulandı.
- `createDatabaseRestoreManager().restore(...)` ile yedek geri yüklendi:
  - İşlem öncesi otomatik pre-restore yedeği alındı (`pre-restore:test-tx-...`).
  - Şema sıfırlandı ve dump içeriği yüklendi.
  - Canlı dump alınarak SHA-256 özetinin orijinal yedekle birebir eşleştiği (`verified: true`) kanıtlandı.
- Geri yükleme sonrası satır sayısının tekrar 1 olduğu ve yalnızca orijinal verinin (`Secret data from Site A`) kaldığı doğrulandı.

### 6. Temizlik ve Telafi (Cleanup)
- `deleteCredential` ile her iki kullanıcının hesabı ve yetkileri MariaDB'den kaldırıldı.
- `dropDatabase` ile test veritabanları silindi.
- Yedek ve işlem dizinleri temizlendi.

## Sonuç
`T-DATABASE` kapsamındaki MariaDB güvenlik temeli, şema yönetimi, kullanıcı/yetki izolasyonu, siteler arası veri kalkanı, scoped yedekleme ve özet doğrulamalı geri yükleme akışları `.28` test sunucusunda eksiksiz çalışmaktadır.
