# Posta Yönetimi

> **Sürüm:** YunPanel `0.3.0` · **Doğrulanmış kaynak revizyonu:** `c1a84a51` (`c1a84a5159add2f2f87fd6e21725f7c657cf98ec`) · **Doğrulanmış Linux `.deb` paket tabanı:** `0.3.0-2026112301` (`f13b2b78`) · **Arayüz dili:** Türkçe (`tr`)

YunPanel, Postfix, Dovecot (Pigeonhole Sieve), Rspamd ve Roundcube bileşenlerini yerel Linux sunucusu üzerinde tek yönetim akışında birleştirir. Sol menüdeki **Posta** (`/mail`) sayfasından tüm posta alan adlarını, site içindeki **E-posta** (`/websites/<id>/mail`) sekmesinden ise ilgili sitenin posta servislerini yönetebilirsiniz.

## Posta alan adları ve yönetim kipleri

**Mail alan adı ekle** işlemiyle her alan adı için iki yönetim kipinden birini seçebilirsiniz:

- **Bu sunucuda (Yerel):** Posta kutuları, takma adlar (alias), yönlendirmeler, DKIM imzalama ve Webmail yerel sunucuda yönetilir.
- **Harici mail sağlayıcısı:** Alan adı e-postaları harici bir sağlayıcıda (ör. bulut posta) tutuluyorsa panel yerel teslimatı kapatarak çakışmayı önler.

![Posta alan adları yönetim ekranı](assets/tr/14-mail-domains.png)

## Posta kutuları, kotalar ve takma adlar

Bir yerel posta alan adını (**Yönet**) açtığınızda şu işlemleri gerçekleştirebilirsiniz:

- **E-posta hesabı oluşturma ve parola değiştirme:** Şifreli kimlik doğrulama kayıtları `yunpanel-mailauth` grubuyla yalnız Postfix/Dovecot erişimine açılır.
- **Kota ve yönlendirme politikaları:** Posta kutusu disk kotası belirleyebilir, gelen iletileri kopyalı (yerel teslimatı koruyarak) veya yalnız yönlendirme olarak başka adreslere aktarabilirsiniz.
- **Takma adlar (Aliases):** Mevcut posta kutularına birden fazla ek adres bağlayabilirsiniz.
- **İstemci bağlantı ayarları:** IMAP/IMAPS, SMTP/Submission (STARTTLS) sunucu ve port bilgileri posta kutusu ekranında hazır sunulur.

## Otomatik yanıt ve spam politikaları

Owner yetkisiyle her posta kutusu için teslimat politikaları tanımlanabilir:

- **Otomatik yanıt (Vacation / Dovecot Sieve):** Konu ve gövde metniyle Türkçe UTF-8 uyumlu tatil/otomatik yanıt kuralları tanımlanır; mevcut yönlendirme kurallarıyla uyumlu çalışır ve döngü önleme kurallarına uyar.
- **Spam izin / engelleme listeleri (Rspamd Multimap):** Belirli gönderen veya alan adları için izin/engelleme kuralları yapılandırma önizlemesi, configtest doğrulaması ve hata durumunda otomatik geri dönüş ile uygulanır.

## DKIM, SPF/DMARC, Smarthost ve Roundcube Webmail

- **DKIM ve DNS tanılama:** Alan adı için RSA DKIM anahtarı üretilir, anahtar döndürme (rotation) desteklenir ve gereken MX/SPF/DKIM/DMARC DNS kayıtları tanılama panelinde gösterilir.
- **SRS ve Smarthost:** Yönlendirilen iletiler için SRS gizli anahtarı korunur; harici SMTP rölesi (Smarthost) ve teslimat takibi desteklenir.
- **Roundcube Webmail:** Yalıtılmış `yunpanel-roundcube` sistem kullanıcısı altında alan adına bağlı Webmail erişimi sağlanır.

## İlgili kılavuzlar

- Posta DNS kayıtları ve TLS SNI sertifikası için [Alan Adı, DNS ve SSL](doc:domains-and-ssl)
- Posta verilerinin yedeklenmesi için [Yedekleme ve Kurtarma](doc:backups-and-recovery)
