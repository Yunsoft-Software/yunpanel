# New Website Local-DNS ve External-DNS Provisioning Politikaları Canlı Kabul Raporu (2026-09-21)

## Kapsam ve Amaç

Bu rapor, YunPanel'in yeni Website oluşturma (provisioning) sürecinde:
1. **Local-DNS modunda (`dns.mode: 'local'`)**:
   - Tepe (apex) `A`, `AAAA` (varsa), `NS` ve `SOA` kayıtlarının sunucu DNS kimliği ve şablonuna uygun olarak üretilmesi,
   - `wwwMode: 'alias'` seçildiğinde `www.<domain>` CNAME kaydının tepe alan adına yönlenecek şekilde eklenmesi; `wwwMode: 'none'` seçildiğinde hiçbir `www` kaydının oluşturulmaması (ölü uç nokta yayınlanmaması),
   - `mail.mode: 'local'` seçildiğinde planın `mail_dns_reapply` adımını içermesi ve canlı PowerDNS'te apex `MX`, apex `SPF` TXT (`v=spf1 mx -all`), `_dmarc.<domain>` TXT (`v=DMARC1; p=none`), `webmail.<domain>` A kaydı ve DKIM TXT kaydının eksiksiz oluşturulması; `mail.mode: 'none'` veya `'external'` olduğunda ise hiçbir yerel posta kaydının oluşturulmaması,
2. **External-DNS modunda (`dns.mode: 'external'`)**:
   - Provisioning planında `dns_zone` adımının tamamen atlanması (`steps.some(s => s.id === 'dns_zone') === false`),
   - PowerDNS hostu üzerinde bu domain için hiçbir yetkili alan (zone) oluşturulmaması (sıfır örtülü PowerDNS zone mutasyonu),
   - Yerel sunucuya yapılan sorgularda sunucunun yetkisiz olduğunu (`REFUSED`) bildirmesi,
3. **Temizlik ve Geri Alma (Compensation)**:
   - Test için geçici olarak açılan alanların `dnsZoneHandler.compensate` mekanizmasıyla eksiksiz silinmesi ve taban çizgisi alan adının (`webrich.news`) sağlıklı kalması

yeteneklerinin `.28` (`157.180.11.28`, test sunucusu, Ubuntu 24.04 LTS) üzerinde canlı PowerDNS sunucusu ve `dig` sorguları eşliğinde doğrulanmasını belgeler.

Kural gereği `.44` (Plesk) sunucusuna dokunulmamış, tüm işlemler `.28` test sunucusunda yürütülmüştür.

---

## Doğrulanan Bileşenler ve Fazlar

Test scripti `/root/acceptance-dns-provisioning-policy-live.mjs` olarak hazırlanmış ve `.28` sunucusunda doğrudan yürütülmüştür.

### Faz 1: `wwwMode='alias'` ve `mailMode='local'` ile Local-DNS Doğrulaması
- `siteCreateProvisioningPlan` ile `dnspolicy-alias.webrich.news` için plan oluşturuldu.
- `dns_zone` adımının plana eklendiği ve şu kayıtları içerdiği doğrulandı:
  - Apex `A`: `157.180.11.28`
  - Apex `NS`: `ns1.cryptoraichu.website`, `ns2.cryptoraichu.website`
  - `www` `CNAME`: `dnspolicy-alias.webrich.news` işaret eden takma ad
- `mail_dns_reapply` adımının plana eklendiği ve `webmail.dnspolicy-alias.webrich.news` hedeflediği teyit edildi.
- `dnsZoneHandler.apply` ile canlı PowerDNS üzerinde zone oluşturuldu (`created: true`).
- `pdnsutil list-zone` ve `dig @127.0.0.1` sorguları ile:
  - Apex `A` sorgusunun `NOERROR`, `flags: qr aa` ve `157.180.11.28` döndürdüğü,
  - `www` `CNAME` sorgusunun `NOERROR`, `flags: qr aa` ve tepe alan adını döndürdüğü kanıtlandı.
- `dnsZoneHandler.compensate` çağrılarak test zone'u PowerDNS'ten başarıyla temizlendi (`pdnsutil list-zone` zonun silindiğini doğruladı).

### Faz 2: `wwwMode='none'` ve `mailMode='none'` ile Local-DNS Doğrulaması
- `dnspolicy-none.webrich.news` için plan oluşturuldu.
- `dns_zone` adımında `www` kaydının ve `mail_dns_reapply` adımının tamamen bulunmadığı teyit edildi.
- Canlı PowerDNS'te zone oluşturuldu:
  - Apex `A` kaydı başarıyla oluşturuldu.
  - `www` sorgusu yapıldığında `NXDOMAIN` cevabı alındı (ölü adres yayınlanmadığı kanıtlandı).
  - `MX` sorgusu yapıldığında 0 cevap (`ANSWER: 0`) döndüğü kanıtlandı.
  - `webmail` sorgusu yapıldığında `NXDOMAIN` cevabı alındı.
- Test zone'u `compensate` çağrısı ile temizlendi.

### Faz 3: External-DNS Modunda Örtülü Zone Oluşturulmadığının Kanıtı
- `external-dns-test.example` domaini için `dns: { mode: 'external' }` planı oluşturuldu.
- Plan içinde `dns_zone` adımının kesinlikle yer almadığı (`undefined`) doğrulandı.
- Plan içinde `mail_dns_reapply` adımının yer almadığı teyit edildi.
- PowerDNS hostunda alan kontrol edildi (`pdnsutil list-zone external-dns-test.example` -> `Zone not found`).
- Yerel PowerDNS soketine (`127.0.0.1`) alan için yapılan sorgunun `status: REFUSED` döndürdüğü ve hiçbir örtülü zone kaydı oluşmadığı kanıtlandı.

### Faz 4: Canlı Yerel Posta Zone'unda Mail DNS Politikası
- Daha önce yerel posta ile oluşturulmuş canlı `mailtest.webrich.news` alanı incelendi:
  - `MX` kaydı: `10 cryptoraichu.website.` (`NOERROR`, `flags: qr aa`)
  - `SPF` TXT kaydı: `"v=spf1 mx -all"` (`NOERROR`)
  - `_dmarc` TXT kaydı: `"v=DMARC1; p=none"` (`NOERROR`)
  - `webmail` A kaydı: `157.180.11.28` (`NOERROR`)
  - `DKIM` TXT kaydı: `"v=DKIM1; k=rsa; p=..."` (`NOERROR`)
- Yerel posta politikasının tüm gerekli DNS kayıtlarını eksiksiz ve yetkili biçimde sağladığı doğrulandı.

### Faz 5: Taban Çizgisi ve Alan Sağlığı
- Test alanlarının PowerDNS'ten tamamen temizlendiği doğrulandı.
- `pdnsutil check-zone webrich.news` çalıştırılarak taban çizgisi alanın bütünlüğü doğrulandı.
- `dig @127.0.0.1 webrich.news A +norecurse` sorgusunun `NOERROR` ve `157.180.11.28` cevabı verdiği teyit edildi.

---

## Sonuç ve Kabul

Tüm 5 faz başarıyla geçmiş; `todo.md` üzerindeki `New Website local-DNS provisioning'i apex/www/mail/webmail kayıtlarını seçilen policy'ye göre oluştursun; external-DNS Website'e örtülü PowerDNS zone eklemesin` maddesi canlı ortamda doğrulanarak tamamlanmıştır.
