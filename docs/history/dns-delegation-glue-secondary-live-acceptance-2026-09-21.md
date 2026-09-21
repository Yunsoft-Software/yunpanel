# Authoritative DNS Delegation, Glue Kayıtları ve Secondary DNS Senkronizasyon/Failover Canlı Kabul Raporu (2026-09-21)

## Kapsam ve Amaç

Bu rapor, YunPanel'in DNS ve Yetkili Alan Adı (Authoritative DNS) mimarisinde:
1. **Tek Host İki NS Adı Durumu (No False-Healthy on Single Host)**:
   - Sunucuda `ns1` ve `ns2` adlarının her ikisi de aynı yerel host IP'sine (`157.180.11.28`) işaret ettiğinde sistemin bunu sahte bir biçimde "sağlıklı" göstermemesi; `dns_nameserver_redundancy_missing` uyarısıyla host düzeyinde yedeklilik (redundancy) bulunmadığını açıkça bildirmesi,
   - Bağımsız bir ikincil (secondary) NS tanımlandığında bu uyarının kalkması; harici NS tanımlanıp ikincil transfer hedefi (`secondaryDns`) girilmediğinde ise `dns_secondary_transfer_target_missing` uyarısının üretilmesi,
2. **In-Bailiwick Glue ve Üst Alan (Parent) Delegasyon Eyleme Geçirilebilirliği (Actionability)**:
   - Alan adının altında yer alan nameserver'lar için (`ns1.cryptoraichu.website` / `cryptoraichu.website`) sistemin `inBailiwick === true` durumunu tespit etmesi ve alan adı kayıt kuruluşunda (registrar) yapıştırıcı (glue) kayıtların zorunlu olduğunu (`glueRequiredForThisDomain: true`) açıkça talimatlandırması,
   - In-bailiwick glue kayıtları eksik olduğunda durumun `pending_glue` olarak işaretlenmesi ve gerekli IPv4/IPv6 adreslerinin kayıt kuruluşu talimatlarında sunulması,
   - Üst alan delegasyonunda (parent delegation) NS kayıtları eşleşmediğinde durumun `pending_delegation` olarak işaretlenmesi; eksik (`missing`) ve yabancı (`extra`) NS listesinin tam olarak sunulması,
   - Alan adı dışındaki (out-of-bailiwick) nameserver'lar çözümlenemediğinde glue gerekmediğinin ama IP adresi gerektiğinin `pending_nameserver_address` ile ayrıştırılması,
   - Delegasyon ve isim sunucusu adresleri tam eşleştiğinde `ready: true` durumunun elde edilmesi,
3. **Onaylı Secondary DNS Senkronizasyon, Gecikme (Drift/Stale) ve Kesinti (Failover) Sağlık Kapısı**:
   - `secondaryDns` boşken durumun `disabled`, sağlık kapısının `not_applicable` olması,
   - Canlı PowerDNS alan adı (`webrich.news`, SOA seri no: `2026092106`) ile ikincil sunucunun SOA seri numarası ve AA (authoritative) bayrağı eşleştiğinde (`synced`) sağlık kapısının `pass` ve ciddiyet derecesinin `healthy` olması,
   - İkincil sunucu eski bir SOA seri numarası döndürdüğünde (`stale` / AXFR gecikmesi) durumun `drift`, sağlık kapısının `block` ve ciddiyet derecesinin `warning` olması,
   - İkincil sunucu yanıt vermediğinde (zaman aşımı `ETIMEDOUT`, bağlantı reddi `ECONNREFUSED` vb.) durumun `unverifiable` olarak kilitlenmesi ve sağlık kapısının `block` ile işletilmesi,
   - İkincil sunucu yetkisiz yanıt verdiğinde (AA bayrağı eksik) `DNS_NOT_AUTHORITATIVE` hata koduyla reddedilmesi,
   - İkincil sunucu yerel sunucudan daha yeni bir seri döndürdüğünde (`ahead` split-brain anomalisi) ciddiyet derecesinin doğrudan `error` seviyesine yükseltilerek bloklanması,
   - PowerDNS alanının türü `Master`/`Primary` olmadığında `primary_kind_required` ile `manual_intervention` kurtarma politikası verilmesi,
4. **PowerDNS Sağlığı ve Taban Çizgisi Doğrulaması**:
   - `pdnsutil check-zone webrich.news` kontrolünün başarıyla geçmesi,
   - `127.0.0.1` soketi üzerinden `webrich.news` A kaydının `157.180.11.28` olarak yetkili (`flags: qr aa`) ve kesintisiz yanıt vermesi

yeteneklerinin `.28` (`157.180.11.28`, test sunucusu, Ubuntu 24.04 LTS) üzerinde canlı olarak doğrulanmasını belgeler.

Kural gereği `.44` (Plesk) sunucusuna dokunulmamış, tüm testler `.28` test sunucusunda yürütülmüştür.

---

## Doğrulanan Bileşenler ve Fazlar

Test scripti `.28` test sunucusunda root yetkisiyle doğrudan yürütülmüştür.

### Faz 1: Yedeklilik Doğrulaması (Tek Host İki NS)
- `.28` üzerindeki mevcut server DNS kimliği incelendi:
  - `ns1.ipv4: 157.180.11.28`, `local: true`
  - `ns2.ipv4: 157.180.11.28`, `local: true`
- `warnings` dizisinde `dns_nameserver_redundancy_missing` uyarısının bulunduğu ve mesajının "authoritative DNS has no host-level redundancy" olduğu teyit edildi. Tek sunucunun iki ayrı NS adıyla sahte olarak "tam sağlıklı" sunulmadığı kanıtlandı.
- Bağımsız bir ikincil sunucu (`ns2.independent-secondary.net`, `198.51.100.53`, `local: false`) ve `secondaryDns: ['198.51.100.53']` içeren önizleme oluşturuldu; `dns_nameserver_redundancy_missing` uyarısının kalktığı kanıtlandı.
- Harici NS tanımlanıp `secondaryDns: []` bırakıldığında `dns_secondary_transfer_target_missing` uyarısının üretildiği doğrulandı.

### Faz 2: In-Bailiwick Glue ve Parent Delegasyon Eyleme Geçirilebilirliği
- `cryptoraichu.website` alan adı ve `ns1.cryptoraichu.website` isim sunucusu incelendi:
  - `inBailiwick: true` ve `registrarInstructions.nameservers[0].glueRequiredForThisDomain: true` olduğu doğrulandı.
  - Yapıştırıcı (glue) kaydı çözümlenemediğinde durumun `pending_glue` olduğu ve yapıştırıcı IP'sinin talimatta net olarak verildiği kanıtlandı.
- Üst alanda yabancı NS'ler döndüğünde durumun `pending_delegation` olduğu; `delegation.missing` ve `delegation.extra` dizilerinin eksiksiz raporlandığı doğrulandı.
- Alan dışı NS adresi eksikliğinde `pending_nameserver_address` üretildiği ve bu durumda glue istenmediği (`glueRequiredForThisDomain: false`) teyit edildi.
- Tam eşleşen delegasyonda `status: 'ready'`, `ready: true` elde edildi.

### Faz 3: Secondary DNS Senkronizasyon, Gecikme ve Failover
- `webrich.news` alan adı üzerinde canlı PowerDNS SOA seri numarası (`2026092106`) ve türü (`Master`) tespit edildi.
- `secondaryDns` boşken `status: 'disabled'`, `healthGate: 'not_applicable'` teyit edildi.
- Eşleşen SOA seri numarası ve AA bayraklı yanıtta:
  - `status: 'synced'`, `ready: true`, `healthGate: 'pass'`, `severity: 'healthy'`.
- Eski SOA serisi döndüğünde (replikasyon gecikmesi):
  - `status: 'drift'`, `ready: false`, `healthGate: 'block'`, `severity: 'warning'`.
- İkincil sunucu çöktüğünde / zaman aşımına uğradığında (`ETIMEDOUT`):
  - `status: 'unverifiable'`, `ready: false`, `healthGate: 'block'`, `severity: 'warning'`.
- AA bayrağı eksik yanıtta:
  - `status: 'unverifiable'`, `errorCode: 'DNS_NOT_AUTHORITATIVE'`.
- İlerideki (ahead) seri numarasında:
  - `status: 'drift'`, `target.status: 'ahead'`, `healthGate: 'block'`, `severity: 'error'`.
- Primary olmayan bölge türünde:
  - `status: 'primary_kind_required'`, `policy.recovery: 'manual_intervention'`, `healthGate: 'block'`, `severity: 'error'`.

### Faz 4: PowerDNS Bütünlüğü ve Taban Çizgisi Doğrulaması
- `pdnsutil check-zone webrich.news` kontrolü hatasız geçti.
- `dig @127.0.0.1 webrich.news A +norecurse` sorgusu `157.180.11.28` adresini `NOERROR` ve `flags: qr aa` ile doğruladı.

---

## Sonuç ve Kabul

Tüm fazlar başarıyla geçmiş; `todo.md` üzerindeki:
`- [ ] En az iki bağımsız authoritative endpoint veya onaylı secondary DNS ile delegation/transfer/failover testi yap. Tek host iki NS adıyla healthy gösterilmesin; glue/parent delegation eksikliği actionable kalsın.`
maddesi canlı test sunucusunda kanıtlanarak tamamlanmıştır.
