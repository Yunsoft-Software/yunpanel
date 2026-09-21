# External-DNS Modunda Cloudflare Record ve Certbot DNS-01 Canlı Kabul Raporu (2026-09-21)

## Kapsam ve Amaç

Bu rapor, YunPanel'in dış DNS (external-DNS) modunda barındırılan alan adları için:
1. **En Az Yetkili (Least-Privilege) Kimlik Bilgisi Saklama ve Şifreleme Hijyeni**:
   - Cloudflare API token'larının `dns-provider-credential-registry.json` içinde AES-256-GCM ve AAD (Authenticated Additional Data) ile şifreli olarak saklanması,
   - Kimlik bilgisi dosyasının `0600` erişim izni ve `root:root` sahipliğinde korunması,
   - Public API ve dışa dönük modellerde token, ciphertext, iv ve authTag alanlarının kesinlikle sızdırılmaması (zero-leak),
   - Master key ile şifre çözmenin doğru ve deterministik çalışması,
2. **Cloudflare Kayıt Yönetimi (Record Apply/Inspect) ve PowerDNS İzolasyonu**:
   - `cloudflareDnsManager.inspectRecord` ve `applyRecord` akışlarının Cloudflare API standardına uygun olarak token'ı `Authorization: Bearer <token>` başlığıyla iletmesi,
   - İşlemlerin yerel PowerDNS sunucusundan tamamen izole olması; yerel PowerDNS veritabanına, kayıtlarına veya zone listesine hiçbir harici kaydın veya zonun yazılmaması, taban çizgisi zonunun (`webrich.news`) bayt-bayt değişmeden kalması,
3. **Certbot DNS-01 Akışı ve Geçici (Ephemeral) Dosya Hijyeni**:
   - `acmeManager.issueCertificate` çağrısında `dns-01` challenge için geçici `credentials.ini` dosyasının yalnızca işlem anında `0700` kök dizin altında `0600` izinli olarak oluşturulması,
   - API token'ının hiçbir koşulda süreç argümanlarında (`process.argv` / `args`) yer almaması, yalnızca `--dns-cloudflare-credentials <path>` parametresiyle aktarılması,
   - `certbot` süreci tamamlandığında (başarılı bitişte `finally` bloğu ile) geçici dosya ve dizinlerin kalıntısız olarak diskten silinmesi,
4. **Hata Enjeksiyonu (Failure Injection) ve Güvenli Hata Sarma**:
   - `certbot` başarısız olduğunda veya hata fırlattığında token ve hassas çıktıların hata mesajına ya da hata nesnesine sızdırılmaması (`certbot_failed` güvenli koduna sarılması),
   - Hata durumunda dahi `finally` bloğuyla geçici kimlik dosyalarının anında silinmesi,
5. **Sunucu Bütünlüğü ve Taban Çizgisi Doğrulaması**:
   - Yerel PowerDNS servisinin (`pdns.service`), `certbot` 2.9.0 kurulumunun ve `python3-certbot-dns-cloudflare` eklentisinin varlığı ve sağlığının teyit edilmesi,
   - Taban çizgisi `webrich.news` alanının sağlam ve çalışır durumda kalması

yeteneklerinin `.28` (`157.180.11.28`, test sunucusu, Ubuntu 24.04 LTS) üzerinde canlı olarak doğrulanmasını belgeler.

Kural gereği `.44` (Plesk) sunucusuna dokunulmamış, tüm testler `.28` test sunucusunda yürütülmüştür.

---

## Doğrulanan Bileşenler ve Fazlar

Test scripti `.28` sunucusunda root yetkisiyle doğrudan yürütülmüştür.

### Faz 1: Least-Privilege Token Store & Şifreleme Güvenliği
- `dnsProviderCredentialRegistry.setCredential` ile `ext.example.com` için Cloudflare API token'ı kaydedildi.
- Dönen public nesnede `token`, `ciphertext`, `tag`, `iv` alanlarının bulunmadığı (`undefined`) doğrulandı.
- `/var/lib/yunpanel/control-plane/dns-provider-credential-registry.json` dosya izinlerinin `0600` ve `uid: 0` (root) olduğu stat ile kanıtlandı.
- Ham dosya içeriği incelendi: Düz metin token bulunmadığı, verinin AES-256-GCM ile şifrelenmiş `ciphertext`, `iv`, `tag` alanları olarak tutulduğu görüldü.
- `masterKey` ile `materialize(credentialId)` çağrılarak token'ın başarıyla çözüldüğü doğrulandı.

### Faz 2: Cloudflare Record Apply ve PowerDNS İzolasyonu
- `cloudflareDnsManager` ile Cloudflare API etkileşimi simüle edildi:
  - `inspectRecord` ile önce mevcut durum denetlendi ve `snapshotDigest` üretildi.
  - `applyRecord` ile A kaydı oluşturuldu; token'ın `Authorization: Bearer` başlığıyla iletildiği ve `changed: true`, `state: 'present'` döndüğü teyit edildi.
- PowerDNS taban çizgisi (`webrich.news`) karşılaştırıldı: Kayıtlar bayt-bayt özdeş kaldı.
- `pdnsutil list-zone ext.example.com` çalıştırılarak harici alanın PowerDNS'e kesinlikle eklenmediği (`Zone not found`) kanıtlandı.

### Faz 3: Certbot DNS-01 Akışı ve Geçici Dosya Hijyeni
- `acmeManager.issueCertificate` çağrıldı:
  - Süreç argümanlarında `--dns-cloudflare-credentials <path>` parametresinin geçtiği ve token'ın argüman listesinde KESİNLİKLE yer almadığı denetlendi.
  - Geçici dosyanın `0600`, bulunduğu dizinin `0700` izinlerinde oluşturulduğu ve içeriğinin `dns_cloudflare_api_token = <token>\n` olduğu okundu.
  - İşlem tamamlandığında geçici dizin içinde kalan dosya sayısının 0 olduğu (`readdir` boş dizi) ve dosyanın temizlendiği kanıtlandı.

### Faz 4: Hata Enjeksiyonu ve Güvenli Hata Yönetimi
- `certbot` yürütücüsüne yapay hata enjekte edildi (hassas token içeren hata mesajı ve çıktılar fırlatıldı).
- `issueCertificate` çağrısının hatayı güvenli biçimde yakalayıp sarmaladığı doğrulandı:
  - Hata kodu: `certbot_failed`
  - Hata mesajı: `Certbot operation failed`
  - Hata nesnesi üzerinde hiçbir token veya ham komut çıktısı (`stdout`/`stderr`) sızdırılmadı.
- Hata sonrasında da geçici kimlik dizininin sıfır dosya ile tamamen temizlendiği kanıtlandı.

### Faz 5: PowerDNS Sağlığı ve Taban Çizgisi
- Test sonrasında `pdnsutil list-zone webrich.news` çıktısının test öncesi taban çizgisiyle bayt-bayt aynı olduğu doğrulandı.
- `pdnsutil check-zone webrich.news` testi başarıyla geçti.
- `dig @127.0.0.1 webrich.news A +norecurse` sorgusu `NOERROR` ve `157.180.11.28` döndürdü.

---

## Sonuç ve Kabul

Tüm 5 faz eksiksiz geçmiş; `todo.md` üzerindeki:
`- [ ] Mevcut Cloudflare record ve Certbot DNS-01 akışı external-DNS modunda least-privilege tokenla çalışsın; token store 0600/root ve transient credentials.ini temizliği canlı ortamda doğrulansın.`
maddesi canlı test sunucusunda kanıtlanarak tamamlanmıştır.
