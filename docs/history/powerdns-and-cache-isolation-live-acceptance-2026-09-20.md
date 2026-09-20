# PowerDNS Service & Redis/Memcached Cache Isolation Gerçek Ortam Kabulü (2026-09-20)

Bu doküman, `.28` test sunucusunda (`157.180.11.28`, Ubuntu 24.04 LTS) PowerDNS servis dayanıklılığı ile Redis ACL ve Memcached izolasyon politikalarının gerçek ortam kabul testlerini belgeler.

---

## 1. PowerDNS Service Restart & State Dayanıklılığı (T-DNS)

### Test Kapsamı ve Hedef:
- PowerDNS servisinin (`pdns.service`) bağımsız restart sonrasında `webrich.news` alan adı zonunu, loopback API'sini, dış UDP/TCP 53 portlarını ve root-private gsqlite3 veritabanını koruyarak sağlıklı çalışmaya devam ettiğinin doğrulanması.

### Yürütülen Adımlar ve Doğrulama Kanıtları:
1. **Servis Restart & Durumu**:
   - `systemctl restart pdns` başarıyla tamamlandı.
   - `systemctl is-active pdns` -> `active`.

2. **DNS Sorguları (UDP ve TCP, Loopback ve Public)**:
   - `dig @127.0.0.1 webrich.news SOA +short` -> `ns1.cryptoraichu.website. hostmaster.cryptoraichu.website. 2026092001 3600 900 1209600 300`
   - `dig +tcp @127.0.0.1 webrich.news SOA +short` -> `ns1.cryptoraichu.website. hostmaster.cryptoraichu.website. 2026092001 3600 900 1209600 300`
   - `dig @157.180.11.28 webrich.news SOA +short` -> `ns1.cryptoraichu.website. hostmaster.cryptoraichu.website. 2026092001 3600 900 1209600 300`
   - `dig +tcp @157.180.11.28 webrich.news SOA +short` -> `ns1.cryptoraichu.website. hostmaster.cryptoraichu.website. 2026092001 3600 900 1209600 300`
   - `pdnsutil list-zone webrich.news` çıktısında SOA, A (`157.180.11.28`) ve NS (`ns1`, `ns2.cryptoraichu.website.`) kayıtlarının eksiksiz korunduğu teyit edildi.

3. **Root-Private gsqlite3 İzinleri**:
   - Veritabanı dosyası: `/var/lib/powerdns/pdns.sqlite3` -> `mode: 0640`, `uid: 121 (pdns)`, `gid: 126 (pdns)`.
   - Dizin: `/var/lib/powerdns` -> `mode: 0750`, `uid: 121 (pdns)`, `gid: 126 (pdns)`.
   - World-accessible bitlerinin kesinlikle kapalı olduğu teyit edildi (`mode & 0o007 === 0`).

4. **PowerDNS Loopback API**:
   - Master key ile şifresi çözülen API anahtarı kullanılarak `http://127.0.0.1:8081/api/v1/servers/localhost` sorgulandı:
     - HTTP 200 OK.
     - `daemon_type`: `authoritative`, `version`: `4.8.3`.
   - `http://127.0.0.1:8081/api/v1/servers/localhost/zones/webrich.news.` sorgulandı:
     - HTTP 200 OK.
     - `serial`: `2026092001`, `rrsets`: 4 adet kayıt seti.

5. **YunPanel Yönetim API'si**:
   - `GET /api/servers/99bc760a-d508-4ae6-92be-efdedee9658d/dns/authoritative` sorgulandı:
     - HTTP 200 OK.
     - `ready: true`, `localReady: true`.
     - `host.satisfied: true`, `host.sockets.satisfied: true`, `udp53: true`, `tcp53: true`.
     - `operation.status: "succeeded"`.

---

## 2. Redis ACL & Memcached Cache İzolasyonu (T-SITE-FEATURES-SETTINGS)

### Test Kapsamı ve Hedef:
- `redis-server` ve `memcached` servislerinin Ubuntu 24.04 üzerinde çalıştırılması.
- YunPanel API üzerinden siteye özel Redis ACL ve Memcached politikalarının atanması.
- Key prefix kısıtlaması, yetkisiz anahtar ve tehlikeli komutların engellenmesi, iki site arasında çapraz izolasyon, parola rotasyonu ve temizleme adımlarının uçtan uca kanıtlanması.

### Yürütülen Adımlar ve Doğrulama Kanıtları:
1. **Paket ve Servis Kurulumu**:
   - `redis-server` (v7.0.15) ve `memcached` (v1.6.24) paketleri kuruldu ve systemd servisleri aktif hale getirildi (`systemctl is-active` -> `active`).

2. **Redis ACL Uygulaması (Site 1 - webrich.news)**:
   - `POST /api/websites/2689cb56-55a4-50c0-a3a4-258c7f2d48dd/cache/redis/enable` çağrıldı:
     - `username: 'yunapp-a404896cf12e'`, `keyPrefix: 'yunapp-a404896cf12e:'`, güçlü parola tek seferlik döndürüldü.
   - Redis ACL kuralları: `on resetpass >password resetkeys ~yunapp-a404896cf12e:* +@read +@write +@connection +select|0 -@dangerous -@admin -FLUSHALL -FLUSHDB -CONFIG -SHUTDOWN`.

3. **İzolasyon ve Güvenlik Komut Testleri**:
   - **Kendi key'ine yazma/okuma**: `SET yunapp-a404896cf12e:mykey site1_val` -> `OK`. `GET` -> `site1_val`.
   - **Yabancı key'e yazma**: `SET other:key blocked` -> `NOPERM this user has no permissions to access one of the keys used as arguments`.
   - **Tehlikeli komutlar**:
     - `FLUSHALL` -> `NOPERM this user has no permissions to run the 'flushall' command`.
     - `FLUSHDB` -> `NOPERM this user has no permissions to run the 'flushdb' command`.
     - `CONFIG GET dir` -> `NOPERM this user has no permissions to run the 'config|get' command`.
     - `SHUTDOWN` -> `NOPERM this user has no permissions to run the 'shutdown' command`.

4. **Çapraz Site İzolasyonu (Site 1 vs Site 2 - mailtest.webrich.news)**:
   - `POST /api/websites/2c4ba551-df97-58e6-9bff-36a0e79c7b4e/cache/redis/enable` ile Site 2 için `yunapp-71355c1cda8a` kullanıcısı oluşturuldu.
   - Site 2'nin `yunapp-a404896cf12e:mykey` okuma denemesi: `NOPERM`.
   - Site 2'nin `yunapp-a404896cf12e:otherkey` yazma denemesi: `NOPERM`.

5. **Parola Rotasyonu**:
   - `POST /api/websites/2689cb56-55a4-50c0-a3a4-258c7f2d48dd/cache/redis/rotate-password` çağrıldı.
   - Yeni parola oluşturuldu ve `resetpass` ile eski parola tamamen geçersiz kılındı.
   - Eski parola ile `PING` denemesi: `AUTH failed: WRONGPASS invalid username-password pair or user is disabled.` (Reddedildi).
   - Yeni parola ile `PING` denemesi: `PONG` (Başarılı).

6. **Memcached Politikası & Bağlantı**:
   - `POST /api/websites/2689cb56-55a4-50c0-a3a4-258c7f2d48dd/cache/memcached/enable` çağrıldı.
   - Dönen politika: `keyPrefix: 'yunapp-a404896cf12e:'`, `socketPath: '/run/memcached/yunapp-a404896cf12e.sock'`, `defaultHost: '127.0.0.1'`, `defaultPort: 11211`.
   - `127.0.0.1:11211` TCP soketi üzerinden prefix'li `set yunapp-a404896cf12e:testkey` ve `get` komutları çalıştırıldı: `STORED` ve `VALUE` alındı.

7. **Temizleme (Disable Cache)**:
   - `DELETE /api/websites/:websiteId/cache` her iki site için çağrıldı.
   - `redis-cli ACL GETUSER` her iki kullanıcı için `(nil)` döndürdü; Redis hafızasından ve registry'den kullanıcılar tamamen kaldırıldı.
   - API `GET /api/websites/:websiteId/cache` -> `enabled: false, type: 'none'`.
