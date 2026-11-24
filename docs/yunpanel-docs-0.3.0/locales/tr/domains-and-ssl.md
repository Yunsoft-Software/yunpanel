# Alan Adı, DNS ve SSL

> **Sürüm:** YunPanel `0.3.0` · **Doğrulanmış kaynak revizyonu:** `f30fd779` (`f30fd779293ad96f83e7a76846fa70e71562730b`) · **Doğrulanmış Linux `.deb` paket tabanı:** `0.3.0-2026112301` (`f13b2b78`) · **Arayüz dili:** Türkçe (`tr`)

YunPanel alan adı yaşam döngüsünü, yetkili veya harici DNS kayıtlarını, Let's Encrypt SSL/TLS sertifikalarını ve Nginx barındırma kurallarını site bağlamında yönetir.

## Alan adları, alt alan adları ve yönlendirmeler

- **Ana alan adı ve alt alan adları:** Bir ana alan adına bağlı alt alan adları oluşturabilir, alias (ek alan adı) ekleyebilir ve `www` yönlendirme davranışını belirleyebilirsiniz.
- **Yönlendirme alan adları:** Barındırma içeriği olmadan başka bir adrese `301` veya `302` HTTP yönlendirmesi (yol koruma seçeneğiyle) tanımlayabilirsiniz.
- **Web Sunucusu & Nginx ayarları (`/websites/<id>/hosting`):** CORS başlıkları, güvenlik başlıkları, statik önbellek (immutable cache) ön-ayarları, alt yol (`/api` gibi) reverse proxy kuralları ve Next.js, Astro, Vite, Nuxt, Remix, Node.js, Python çalışma zamanı şablonları doğrudan site ayarlarından yönetilir.
- **Gelişmiş alan adı araçları (`/domains`):** Tüm alan adı ve sertifika envanterini sunucu düzeyinde incelemek için Araçlar ve Ayarlar altından erişilebilir.

## DNS yönetimi

Site içindeki **DNS** (`/websites/<id>/dns`) ve **Ayarlar → DNS ve SSL** (`/settings?section=dns`) ekranları iki kullanım modelini destekler:

1. **Yerel Yetkili DNS (PowerDNS):** Sunucu genel DNS kimliği (IPv4/IPv6, `ns1`/`ns2`, SOA ve isteğe bağlı ikincil DNS AXFR/NOTIFY ayarları) yapılandırıldığında yerel yetkili bölge oluşturulabilir; A, AAAA, CNAME, MX, TXT, CAA ve SRV kayıtları ile DNSSEC yönetimi yapılabilir.
2. **Harici DNS (Cloudflare API veya manuel kayıtlar):** Alan adı DNS kayıtları harici bir sağlayıcıda tutuluyorsa panel bunu açıkça gösterir ve Cloudflare API entegrasyonu üzerinden DNS-01 doğrulaması ile kayıt eşitlemesini destekler.

![Site DNS bölge ve kayıt ekranı](assets/tr/09-site-dns.png)

## SSL/TLS sertifikaları ve otomatik yenileme

Site detayındaki **SSL/TLS Sertifikaları** (`/websites/<id>/ssl`) ekranından Let's Encrypt sertifikası alabilir ve yönetebilirsiniz:

- **Korunacak alan adları:** Ana alan adı, `www`, `webmail`, `mail` alt alan adları, posta sunucusu (Postfix/Dovecot TLS SNI) ataması ve Cloudflare DNS-01 ile Joker (Wildcard `*.alanadi`) sertifika desteği.
- **ACME doğrulama testi:** Gerçek sertifika isteğinden önce DNS ve ACME erişilebilirliğini test edebilirsiniz.
- **Otomatik yenileme:** Arka plan zamanlayıcısı varsayılan olarak 6 saatte bir (`YUNPANEL_CERTIFICATE_RENEWAL_INTERVAL_MS`) kontrol yapar ve bitişine 30 gün kalan (`YUNPANEL_CERTIFICATE_RENEW_BEFORE_MS`) sertifikaları otomatik yeniler.
- **Sertifika bildirimleri:** Üst bardaki **Bildirimler** çekmecesi süresi yaklaşan veya eksik SSL sertifikalarını listeler.

![Site SSL/TLS sertifika yönetimi](assets/tr/08-site-ssl.png)

## İlgili kılavuzlar

- Yeni site ekleme akışı için [Temel Site ve Rol İşlemleri](doc:sites-and-roles)
- Posta alan adı DKIM/SPF/DMARC kayıtları için [Posta Yönetimi](doc:mail)
