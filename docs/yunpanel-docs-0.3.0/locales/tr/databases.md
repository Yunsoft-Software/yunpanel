# Veritabanı Yönetimi

> **Sürüm:** YunPanel `0.3.0` · **Doğrulanmış kaynak revizyonu:** `c1a84a51` (`c1a84a5159add2f2f87fd6e21725f7c657cf98ec`) · **Doğrulanmış Linux `.deb` paket tabanı:** `0.3.0-2026112301` (`f13b2b78`) · **Arayüz dili:** Türkçe (`tr`)

YunPanel, yerel MariaDB sunucusu üzerinde her web sitesi ve alt alan adı için yalıtılmış veritabanı ve özel veritabanı kullanıcıları yönetir. Sol menüdeki **Veritabanları** (`/databases`) ekranı tüm envanteri, site içindeki **Veritabanları** (`/websites/<id>/databases`) sekmesi ise yalnız ilgili siteye bağlı veritabanlarını gösterir.

## Veritabanı oluşturma ve siteye bağlama

1. **Veritabanı oluştur** düğmesine tıklayın ve hedef web sitesini veya alt alan adını seçin.
2. Veritabanı adı, kullanıcı adı ve güçlü parola belirleyin.
3. YunPanel veritabanını ve yalnızca o şemaya yetkili kullanıcıyı oluşturur; veritabanı kimlik bilgilerini `YUNPANEL_SECRET_MASTER_KEY` ile şifreleyerek kaydeder.
4. Müşteri hesapları için tanımlı veritabanı adet kotaları (`maxDatabases`) oluşturma sırasında otomatik denetlenir.

![Veritabanları yönetim ekranı](assets/tr/13-databases.png)

## Günlük veritabanı işlemleri

- **Parola yenileme ve kimlik bilgisi onarımı:** Site veritabanı kullanıcısının parolasını panelden döndürebilir veya eksik kayıt bağlarını onarabilirsiniz.
- **Kopyalama ve SQL yedek/aktarım:** Site veritabanı yedeği alma, dışa aktarım ve aynı sunucu içi güvenli veritabanı kopyalama desteklenir.
- **Silme koruması:** Veritabanı silme işlemleri açık onay gerektirir ve yalnızca seçilen şemayı kaldırır; kardeş veritabanları etkilenmez.

## Güvenli phpMyAdmin erişimi

YunPanel, phpMyAdmin arayüzünü doğrudan internete açık bırakmaz. Panel üzerinden phpMyAdmin açıldığında:

- Yalnızca aktif panel oturumuna ve ilgili sitenin yetki kapsamına bağlı kısa ömürlü bir tekil oturum açma (**sign-on**) geçidi kullanılır.
- phpMyAdmin ayrı yalıtılmış `yunpanel-phpmyadmin` sistem kullanıcısı altında çalışır; oturum kapatıldığında veya yetki değiştiğinde geçit erişimi hemen sonlanır.
- Site Yöneticisi ve Müşteri rolleri yalnızca kendilerine atanan sitelerin veritabanlarını görebilir.

## İlgili kılavuzlar

- WordPress veritabanı bağlama için [WordPress Yönetimi](doc:wordpress)
- Site yedekleme kapsamına veritabanı dahil etme için [Yedekleme ve Kurtarma](doc:backups-and-recovery)
