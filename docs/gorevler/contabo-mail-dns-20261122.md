# 22 Kasım 2026 · Contabo posta ve ikinci DNS kabulü

Kabul Debian 12 `217.216.33.14` ve Ubuntu 24.04 `46.250.231.212` üzerinde YunPanel `0.3.0-2026112104` ile yürütüldü. Ağ ve posta denemeleri geçici `.test` alanlarını kullandı.

## PowerDNS ikincil sunucusu

- Debian’daki PowerDNS 4.7.3 birincil, Ubuntu’daki PowerDNS 4.8.3 ikincil olarak çalıştı. İki sunucu gerçek TCP/UDP 53 üzerinden birbirine erişti ve test bölgesi erişimi belirli sunucu adresleri ve geçici TSIG anahtarıyla yapılandırıldı.
- `2026112201` ilk SOA serisi alındı. Birincilde TXT değişip seri `2026112202` olduğunda ikincil normal NOTIFY ve AXFR akışıyla **1,4 saniyede** aynı SOA ve TXT’yi sundu. Bu adımda elle transfer tetiklenmedi.
- Birincilin PowerDNS servisi durdurulunca birincilden ağ yolu üzerinden cevap alınmadığı görüldü. İkincil güncel SOA ve TXT’yi yetkili olarak sunmayı sürdürdü. Ubuntu’nun mevcut `systemd-resolved` servisi korundu.
- Geçici bölge, SQLite veri dizini, yapılandırma ve TSIG anahtarı kaldırıldı. Bu kabul iki PowerDNS kurulumunun operatör yönetimindeki çoğaltmasını kapsar. YunPanel arayüzünden ikincil sunucu kurma akışı ayrıca değerlendirilir.

## Posta ve spam politikası

- Her iki sunucuda Postfix gerçek SMTP STARTTLS ile TLS 1.3, geçici sertifika parmak izi ve SASL doğrulamasından geçti. Hatalı parola 535 döndü. İletiler LMTP ile Dovecot’a teslim edildi ve IMAP üzerinden okundu.
- Rspamd temiz iletiyi teslim etti ve GTUBE örneğini SMTP 554 ile reddetti. Teslim edilen iletilerde RSA-SHA256 DKIM imzası doğrulandı. Gövdesi değiştirilen kopya reddedildi.
- Dovecot Sieve Türkçe tek otomatik yanıt gönderdi. Ardışık iki iletide yanıt sayısı bir kaldı. Otomatik yanıt kuralı bulunmayan kardeş posta kutusu iletisini aldı ve yanıt üretmedi.
- Paketteki gerçek YunPanel Multimap şablonu Debian’da Rspamd 3.4 ve Ubuntu’da 3.8.1 ile çalıştı. Engelli gönderen yalnız ilgili kutuda `+5` aldı. Kardeş ve çoklu alıcılar bu puanı almadı. Kimliği doğrulanmış gönderen muaf kaldı. İzin listesindeki gönderen, gerçek PowerDNS SPF ve DMARC kayıtlarıyla doğrulanınca `−1` aldı. DMARC olumsuz olduğunda izin puanı uygulanmadı.
- Test posta kutuları, politika dosyaları, DKIM anahtarları ve geçici erişim bilgileri kaldırıldı. İki sunucuda YunPanel sağlık kontrolü HTTP 200 döndü.

İlk DNS denemesinde 4.7’nin yapılandırma çıktısında SQLite seçeneğinin görünmemesi ve kontrol soketindeki komut adı, test betiğinin doğrulamayı erken kesmesine neden oldu. Test, etkin bölge yapılandırmasını ve `pdns_control rping` sonucunu doğrulayacak biçimde güncellendi. Posta testinde Dovecot’un `auto-replied (vacation)` başlığı ve RFC başlık katlama boşluğu doğru okunacak biçimde düzeltildi. Kaynak değişikliği gerektirmeyen test betiği düzeltmelerinin ardından gerçek koşular geçti.

Kayıt dizini `.local/contabo-cross-restore/next-20261122/evidence/`. DNS için `dns-ubu24-verify-sync.json` ve `dns-ubu24-verify-primary-down.json`, posta için `mail-*-verify.json`, `mail-*-multimap.json` ve `mail-*-sibling.json` kullanılır.
