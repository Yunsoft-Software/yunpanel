# PowerDNS Soket Sağlığı, Yetkili Sorgular, Non-Recursion ve Konfigürasyon İzolasyonu Canlı Kabulü (2026-09-20)

## Kapsam ve Amaç

Bu test, `todo.md` altındaki `T-DNS` (P0 PowerDNS ve nameserver) gereksinimlerinin `.28` test sunucusu (`157.180.11.28`) üzerinde canlı olarak doğrulanmasını kapsar:
1. Yerel loopback UDP/53 ve TCP/53 soket sağlık denetimi (`createPowerDnsSocketHealthInspector`).
2. Dış ağdan genel (public) UDP/53 ve TCP/53 erişimi ve çözünürlük doğrulaması.
3. Özyinelemeli (recursive) sorguların PowerDNS Authoritative tarafından açıkça reddedilmesi (`RA=false`, `RCODE=5 (REFUSED)`).
4. Yetkili (authoritative) sorgu bayrakları (`flags: qr aa`) ve A/SOA/NS/MX kayıt yanıtları.
5. Konfigürasyon güvenliği ve sır koruması (`/etc/powerdns/pdns.d/yunpanel.conf` izinleri `0640`, grup `pdns`, API anahtarının yalnız `pdnsutil hash-password` scrypt çıktısı olarak tutulması).
6. Geçersiz konfigürasyon enjeksiyonu ve güvenli geri dönüş (config check rejection, byte-for-byte ve permission-for-permission korunma).

## Gerçekleştirilen Doğrulamalar ve Sonuçlar

### 1. Yerel Soket Sağlık Denetimi (Socket Health Inspector)
- `createPowerDnsSocketHealthInspector().inspect()` çalıştırıldı.
- Sonuç:
  - `satisfied: true`
  - `udp53: true`
  - `tcp53: true`
  - `recursive: false`
  - `recursion: { rcode: 5, available: false }`
- Yerel PowerDNS Authoritative soketlerinin hem UDP hem TCP üzerinden sağlıklı çalıştığı ve özyineleme sağlamadığı doğrulandı.

### 2. Dış Ağ ve Loopback Yetkili DNS Sorguları
- **UDP/53**: `dig @127.0.0.1 webrich.news A +norecurse` -> `status: NOERROR`, `flags: qr aa`, IP `157.180.11.28`.
- **TCP/53**: `dig @127.0.0.1 webrich.news A +tcp +norecurse` -> `status: NOERROR`, `flags: qr aa`, IP `157.180.11.28`.
- **Public Erişim**: Dış istemciden (Mac terminali üzerinden) doğrudan `dig @157.180.11.28 webrich.news +short` ve `+tcp +short` ile sorgulandı; her iki protokolde de `157.180.11.28` yanıtı alındı. Güvenlik duvarı veya NAT engeli olmadığı kanıtlandı.

### 3. Özyineleme (Recursion) Reddi
- Hem loopback hem de dış istemci üzerinden yapılan `+recurse` sorguları (`dig @... google.com +recurse`):
  - `status: REFUSED`
  - `flags: qr rd` (Recursion Available - `ra` bayrağı kesinlikle dönmedi).
  - PowerDNS Authoritative sunucusunun açık bir resolver gibi davranmadığı (open resolver olmadığı) ve özyineleme taleplerini fail-closed reddettiği doğrulandı.

### 4. Konfigürasyon Hijyeni ve Sır Koruması
- Dosya: `/etc/powerdns/pdns.d/yunpanel.conf`.
- İzinler: `0640`, sahip `root`, grup `pdns` (gid: 126).
- Sır Saklama: `api-key` parametresi `$scrypt$ln=10,p=1,r=8$...` şeklinde hash'lenmiş olarak saklanmaktadır; ham API anahtarı konfigürasyonda yer almamaktadır.
- Sentaks Kontrolü: `/usr/sbin/pdns_server --config=check` başarıyla geçti.

### 5. Geçersiz Konfigürasyon Enjeksiyonu ve Güvenli Durumun Korunması
- Geçersiz bir direktif içeren konfigürasyon adayı test edildiğinde `pdns_server --config=check` tarafından reddedildi.
- Orijinal çalışan konfigürasyonun byte-for-byte ve `0640` izinleriyle eksiksiz korunduğu doğrulandı.

### 6. Canlı Bölge Kayıtları (Zone Records)
- `webrich.news` SOA ve NS kayıtları yetkili (`flags: qr aa`) olarak doğrulandı.
- `mailtest.webrich.news` MX kaydı yetkili (`flags: qr aa`) olarak doğrulandı.

## Sonuç
`T-DNS` kapsamındaki PowerDNS Authoritative soket sağlığı, TCP/UDP loopback ve public yetkili sorgular, non-recursion politikası, scrypt API anahtarı gizleme ve geçersiz konfigürasyon reddi `.28` test sunucusunda başarıyla doğrulanmıştır.
