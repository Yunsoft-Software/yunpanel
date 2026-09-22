# Plesk Resmî Ekran ve Görev Atlası

**Araştırma tarihi:** 2026-09-23. **Hedef:** YunPanel kullanım düzenini Plesk'e eşlemek; Plesk'in markasını veya renklerini taşımak değil.

Görseller doğrudan Plesk'in resmî doküman sunucusundan Markdown içinde gösterilir. **Yerel bitmap kopyası bu repoya eklenmedi; görüntülerin açılması internet erişimi gerektirir.** Her şeklin kaynak sayfası ayrıca verilmiştir. Resmî belgelerin bazı ekranları eski Obsidian sürümleridir; belge güncelliği görsel sürümünün güncelliği anlamına gelmez. Bu ayrım aşağıda açıkça yazılır. Hiçbir görsel canlı YunPanel ekranı, test sunucusu veya uygulanmış tasarım diye sunulmaz.

## A1 — Owner bağlamı: Power User

![Plesk Power User — global Files ve site File Manager ilişkisi](https://docs.plesk.com/en-US/obsidian/administrator-guide/images/75255.png)

**Kaynak:** [The Plesk GUI, Power User](https://docs.plesk.com/en-US/obsidian/administrator-guide/70562/). Görsel kimliği `75255.png`. Tam görsel incelendi. Ekranın kendi sürüm/tarih alanı Obsidian 18.0.20 / 2019 gösterir.

**Alınan ilişki:** sol ana menüde Files; domain araçlarında File Manager; Owner sunucu ayarları Tools & Settings altında. Domain başlığının altındaki içerik araçları aynı kaynağın bağlamını korur. Sağ yardımcı alandaki Backup Manager/DB/Scheduled Tasks, araçların yalnız debug ekranında saklanmadığını gösterir.

**Alınmayan:** Plesk mavi/gri teması, marka, eski sistem sürümü, 2019'un birebir ikon yerleşimi ve YunPanel'de olmayan eklenti reklamları. Güncel domain sekmeleri için A4 ve R03/R11 esas alınır.

## A2 — Kısıtlı kullanıcının görev bağlamı: Customer Panel

![Plesk Customer Panel — Files, Mail ve Databases aynı site bağlamında](https://docs.plesk.com/en-US/obsidian/administrator-guide/images/75102.png)

**Kaynak:** [The Plesk GUI, Customer Panel](https://docs.plesk.com/en-US/obsidian/administrator-guide/70562/). Görsel kimliği `75102.png`. Tam görsel incelendi; tarihsel GUI illüstrasyonudur, en son build kanıtı değildir.

**Alınan ilişki:** site yönetimi, mail, dosya, DB ve kullanıcı hesabı alanları; Owner'ın sunucu yönetim alanı ile karıştırılmaması. YunPanel site hesabına bütün sunucu dosya ağacı/DB envanteri verilmez. Giriş konumunun korunması, erişim kapsamının aynı kalmasını gerektirir.

**Uygulama notu:** mevcut site_manager'ın yalnız Websites menüsü görmesi Files'ı bulma problemini büyütüyor. Yetkili site görevleri Plesk'teki açık girişlerden erişecek; yeni yetki verilmesi gerekiyorsa backend sınırı ayrı test edilir.

## A3 — Karıştırılmayacak ekran: Service Provider

![Plesk Service Provider — bu ürün kapsamına karıştırılmayacak reseller ve subscription görünümü](https://docs.plesk.com/en-US/obsidian/administrator-guide/images/75260.png)

**Kaynak:** [The Plesk GUI, Service Provider](https://docs.plesk.com/en-US/obsidian/administrator-guide/70562/). Görsel kimliği `75260.png`; tam görsel incelendi. Obsidian 18.0.20 / 2019 bilgisi görünür.

**Neden var?** 'Plesk gibi' denilince bu ekranın Customers/Subscriptions/Service Plans alanlarıyla A1/A2'nin site araçlarını karıştırmayı önlemek için. YunPanel bu turda bayi/faturalama/hosting paketi ürünü hâline getirilmiyor. Kullanıcının günlük Files işi müşteri → abonelik → servis paketi gibi yeni katmanlara taşınmıyor.

## A4 — Güncel domain kartı görev grupları

![Plesk domain kartında Dashboard, Hosting and DNS, Mail ve dosya-veritabanı araç grubu](https://docs.plesk.com/de-DE/obsidian/quick-start-guide/images/75586.webp)

**Kaynak:** [Managing Web Hosting](https://docs.plesk.com/en-US/obsidian/quick-start-guide/plesk-functionality-explained/managing-web-hosting.74401/) ve [aynı belgenin Almanca sürümü](https://docs.plesk.com/de-DE/obsidian/quick-start-guide/plesk-funktionalit%C3%A4t-erkl%C3%A4rt/verwalten-des-webhostings.74401/). Görsel kimliği `75586.webp`.

**İnceleme sınırı:** indekslenmiş resmî görsel önizlemesi incelendi; tam çözünürlük varlığı bu ortamda ayrıca indirilemedi. Önizleme genişleyen domain kartındaki Dashboard / Hosting & DNS / Mail düzenini destekliyor. Tam görüntüdeki küçük yazılardan ek özellik veya exact ölçü çıkarmadık. Güncel R03 metni DNS için Hosting & DNS → DNS, yedek için Dashboard → Backup & Restore yolunu açıkça doğrular.

**Alınan karar:** yeni YunPanel domain yüzeyi bu görev aileleriyle düzenlenir. Eski özel altı-kategorili Kaynaklar/Operasyon düzeni varsayılan değildir. Mevcut renkler, fontlar ve yumuşak element şekilleri değişmez.

## A5 — Dosya yöneticisinin çalışma alanı

![Plesk File Manager — klasör ağacı, dosya tablosu, copy move archive remove araçları](https://docs.plesk.com/en-US/obsidian/quick-start-guide/images/77081.webp)

**Kaynak:** [Uploading Content](https://docs.plesk.com/en-US/obsidian/quick-start-guide/plesk-functionality-explained/uploading-content.74402/). Görsel kimliği `77081.webp`.

**İnceleme sınırı:** indekslenmiş resmî görsel önizlemesinde sol klasör ağacı, seçimli dosya listesi ve + / Copy / Move / Archive / More / Remove araç çubuğu incelendi; tam asset indirmesi yapılamadı. İşlem ayrıntıları görselde okunamayan yazılardan değil R05/R06 resmî açıklamalarından alındı.

**Alınan çalışma biçimi:** ağaç + breadcrumb + liste + seçim sonrası araçlar. Dosya görüntüleme/düzenleme, upload, yeni dosya/klasör ve silme bulunabilir kalır. Gelişmiş arşiv, taşıma, izinler mevcut adapter kapasitesi ile eşlenir. Global Files veya domain File Manager aynı gerçek Website köküne gider; yeni, ayrı file browser yazılmaz.

## Görsel ile uygulama arasındaki izlenebilirlik

| Şekil | Belgedeki karar | Plan/kabul |
| --- | --- | --- |
| A1 | Owner Power User, görünür global Files, Tools & Settings | UX-PL-02/03; T-PL-01/02 |
| A2 | Site kullanıcısının görevleri, sunucu yetkilerinden ayrılır | UX-PL-02/08; T-PL-02/12 |
| A3 | Service Provider modelini bu kapsamla karıştırma | UX-PL-02; T-PL-01 |
| A4 | Domain kartı Dashboard / Hosting & DNS / Mail görevleri | UX-PL-04/06; T-PL-03 |
| A5 | Dosya ağacı, liste, araç çubuğu ve iki giriş yolu | UX-PL-01/05; T-PL-04/05 |

**Henüz bulunmayan kanıt:** aynı Plesk build'inden bütün araçların uçtan uca etkileşim kaydı; YunPanel üretim build'inin yeni yerleşimi; izinli hostta gerçek Files regresyonu. Bunlar yapılmış gösterilmez. Yeni live screenshot eklendiğinde `ürün / commit-build / rol / ekran-boyutu / senaryo / beklenen-gerçek sonuç` yazılır; parola/cookie/anahtar görünmez. `.44` Plesk sunucusuna araştırma için de bağlanılmaz.

## Resmi kaynak kaydi

Kaynaklar Plesk Obsidian resmî belgeleridir. Etiketlerin İngilizcesi UI eşlemesi için tutulmuştur; metinler kopyalanmadı, görevler YunPanel'e eşlendi. Plesk'te sürüm/edition/extension/rol görünümü değiştirebilir; screenshot'tan feature complete çıkarılmaz.

- **R01 — The Plesk GUI:** https://docs.plesk.com/en-US/obsidian/administrator-guide/70562/ — panel/persona ve Power User/Customer ayrımı.
- **R02 — Adding and Removing Domains:** https://docs.plesk.com/en-US/obsidian/administrator-guide/website-management/websites-and-domains/domains-and-dns/adding-and-removing-domains.65150/ — domain ekleme/silme ve expanded-row/separate-page görünümü.
- **R03 — Plesk Tutorial:** https://docs.plesk.com/en-US/obsidian/quick-start-guide/plesk-tutorial.74376/ — Files, DB, Mail, DNS, Backup & Restore ve profil görev yolları.
- **R04 — Website Management:** https://doc.plesk.com/en-US/obsidian/administrator-guide/website-management.70741/ — seçili webspace ve global/site kapsamı.
- **R05 — Uploading Content:** https://docs.plesk.com/en-US/obsidian/quick-start-guide/plesk-functionality-explained/uploading-content.74402/ — global Files ve dosya araçları.
- **R06 — Uploading Content with File Manager:** https://docs.plesk.com/en-US/obsidian/administrator-guide/website-management/websites-and-domains/website-content/uploading-content-with-file-manager.74105/ — yükleme, arşiv, düzenleme ve dosya işlemleri.
- **R07 — Adding Mail Accounts:** https://docs.plesk.com/en-US/obsidian/customer-guide/mail-settings/adding-mail-accounts.65700/ — Mail → Create Email Address ve hesap alanları.
- **R08 — Creating Databases:** https://docs.plesk.com/en-US/obsidian/customer-guide/website-databases/creating-databases.65157/ — DB/site/kullanıcı ilişkisi.
- **R09 — SSL It:** https://docs.plesk.com/en-US/obsidian/customer-guide/websites-and-domains/securing-connections-with-ssltls-certificates/securing-connections-with-the-ssl-it!-extension.65160/ — SSL/TLS Certificates yönetimi.
- **R10 — Domain DNS:** https://docs.plesk.com/en-US/obsidian/customer-guide/websites-and-domains/domains-and-dns/configuring-dns-for-a-domain/plesk-as-a-master-dns-server.65185/ — domain record yönetimi. Sunucu DNS ayarı: https://docs.plesk.com/en-US/obsidian/administrator-guide/dns/dns-settings.72226/ .
- **R11 — Managing Web Hosting:** https://docs.plesk.com/en-US/obsidian/quick-start-guide/plesk-functionality-explained/managing-web-hosting.74401/ — Hosting & DNS/Hosting ve runtime görev yerleri.
- **R12 — Node.js Support:** https://docs.plesk.com/en-US/obsidian/administrator-guide/website-management/nodejs-support.76652/ — site runtime, dependency/script/environment görevleri.
- **R13 — Deploying Content Using Git:** https://docs.plesk.com/en-US/obsidian/customer-guide/websites-and-domains/website-content/deploying-content-using-git.75877/ — repo ve deployment iş akışı.
- **R14 — Scheduling Tasks:** https://docs.plesk.com/en-US/obsidian/customer-guide/scheduling-tasks.65207/ — list/add/run ve site görev kapsamı.
- **R15 — Backing Up Data:** https://docs.plesk.com/en-US/obsidian/reseller-guide/website-management/backing-up-and-restoring-websites/backing-up-data.65198/ — website backup kapsam/seçenekleri; reseller ana navigasyonu bu kaynaktan taşınmaz.
- **R16 — Plesk Firewall:** https://docs.plesk.com/en-US/obsidian/administrator-guide/72046/ — Tools & Settings güvenlik konumu, apply ve bağlantı teyidi. YunPanel nftables adapter'ı korunur.
- **R17 — Obsidian Change Log:** https://docs.plesk.com/release-notes/obsidian/change-log/ — güncel araçların sürüme/eklentiye bağlı gelişimi; eski screenshot'ı current build diye etiketlememe kontrolü.
