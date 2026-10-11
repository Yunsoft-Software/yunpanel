# Debian paketi dosya izinleri

YunPanel web servisi `yunpanel` Unix kullanıcısıyla çalışır. `/usr/lib/yunpanel` altındaki paket kodu ve `/usr/share/yunpanel` altındaki arayüz/araç dosyaları bu kullanıcı tarafından okunabilmelidir.

Paket derleyicisi bu iki değişmez payload içinde dizinleri `0755`, normal dosyaları `0644`, mevcut executable dosyalarını `0755` yapar. Kaynağın `cp -a` ile taşınan izinleri veya derleyicinin `umask 077` ayarı web servisini kilitlemez. Sahiplik paket oluşturulurken root olarak kaydedilir.

Debian yükseltmesi mevcut dizin izinlerini koruyabildiği için `postinst`, yalnız `dpkg-query -L yunpanel` listesinde bulunan kod/arayüz dizinlerini onarır. Symlink dizinleri, paket dışındaki üretilmiş araç dizinleri, `/etc/yunpanel` ve `/var/lib/yunpanel` bu işlemle değiştirilmez. Özel ayar ve auth dosyaları `0600`, özel dizinler `0700` kalır.

Doğrulama: kısıtlı umask ile native Linux paketi üret; daha önce kısıtlı dizinlerle kurulmuş paket üzerinde yükselt; `yunpanel` kullanıcısıyla web entry ve index dosyasını okuyabildiğini, private env/auth dosyalarını okuyamadığını kontrol et. API/web servisi, `dpkg --verify yunpanel`, Nginx configtest ve gerçek HTTPS/Owner oturumu birlikte doğrulanır.
