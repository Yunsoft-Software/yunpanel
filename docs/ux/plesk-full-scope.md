# Plesk görev düzeni — sade reseller kapsamı

2026-09-23; `development`. Kullanıcının son kararı önceki tam reseller/paket/abonelik zorunluluğunu daraltır. Plesk'e benzeyen kullanım düzeni, mevcut site araçları ve güvenlik sınırları korunur. Bu belge `plan.md` PAR-01/02/03 ve UX-PL-02 için güncel reseller sözleşmesidir; eski envanterin geniş reseller satırları ilk sürümün kabul şartı değildir.

## İlk sürümde kullanıcı ne yapacak?

| Hesap | Görünen işler | Sınır |
| --- | --- | --- |
| Owner | Mevcut sunucu/site araçları; bayiler ve müşteriler; basit adet limitleri | Tüm yetkili yerel kaynaklar; son aktif Owner korunur |
| Reseller | Müşterilerim, Sitelerim, Hesabım; müşteri ekleme/düzenleme, kendi kapsamındaki site araçları | Yalnız kendine bağlı müşteriler/siteler; sunucu ayarları, root terminal, başka bayi ve Owner hesapları yok |
| Customer | Web Siteleri ve Alan Adları, Posta, Dosyalar, Veritabanları ve diğer izinli mevcut site araçları | Yalnız kendi siteleri; başka müşteri veya kullanıcı yönetim yetkisi yok |

Ayrı bir reseller dashboard, tema, paket editörü veya abonelik ekranı gerekmez. Mevcut liste/form/site araçları kullanılır. Yönetici Service Provider/Power User ayrımı uzun vadeli UX referansıdır; sade reseller için iki yeni panel inşa etmek önkoşul değildir.

## Küçük veri modeli

**Owner → isteğe bağlı tek Reseller → Customer → mevcut Website.** Müşteri doğrudan Owner'a bağlı olabilir (`resellerId: null`). Reseller altında reseller kurulmaz. Reseller kendi sitesini yönetecekse normal müşteri kaydı üzerinden aynı akış kullanılır; ayrı bir hosting aboneliği türü açılmaz.

Mevcut auth kullanıcıları ve Website kimlikleri tekrar oluşturulmaz. Müşteri sahipliği, site erişim üyeliği ve login rolü farklı kavramlardır: mevcut `site_manager` otomatik olarak reseller veya müşteri sahibi sayılmaz. Veri bağlantısı açık, sürümlü ve geri alınabilir olmalıdır; Unix kullanıcıları aynı kalır. Girdide gelen actor rolü veya sahiplik alanı tek başına yetki değildir.

Kaynak politika sözleşmesi: trusted actor `{id, role, active}`; hesap profili `{id, kind, resellerId, active}`; Website sahiplik projeksiyonu `{id, customerId}`. Profil `id` mevcut auth kullanıcı kimliğiyle bağlanmalıdır; ayrı kopya login deposu kurulmaz. `kind` reseller/customer ayrımıdır; reseller'ın `resellerId` değeri açık `null` olur. Bunlar yeni HTTP body şeması veya uygulanmış DB migrasyonu değildir. Mevcut Website kaydı sadece bu yardımcı için yeniden oluşturulmaz; entegrasyon doğrulanmış mevcut kayıttan projeksiyon üretir.

**Basit limit:** Owner'ın belirlediği toplam müşteri ve Website adedi. `null` sınırsız, `0` yeni kayıt açılamaz; negatif, kesirli veya bilinmeyen kullanım geçersizdir. İki limit de açık verilmelidir; eksik limit otomatik sınırsız değildir. Askıdaki kayıtlar da adet tüketir. Sınır düşürmek mevcut veriyi silmez, yeni eklemeyi engeller. Site limiti bayinin tüm müşterileri toplamıdır. Kontrol ve kayıt aynı işlem/kilit içinde yapılır; salt önizleme kota enforcement değildir. Disk/trafik/CPU/RAM için ikinci bir reseller ölçüm veya rezervasyon motoru kurulmaz; mevcut site ölçüm/limit işleri PROD-15'te sürer.

## İlk sürümde yapılmayacaklar

Alt bayi, reseller hizmet paketleri, add-on, zorunlu Subscription, paket sync/lock/unsynced/customization, overselling, otomatik expiry/faturalama, marka özelleştirme, müşteri↔reseller dönüşümü, toplu transfer ve login-as sonraki fazdır. İlk sürümde sahiplik aktarımı API'den de kapalı tutulur; yalnız formdan kaldırmak yeterli değildir. Mevcut site askıya alma/silme motorları korunur; hesap askıya alma ile hosttaki siteyi kapatma aynı işlem gibi gösterilmez.

## Küçük uygulama dilimleri

- [x] **RS-00 — Kapsam sadeleştirildi.** `agents.md`, `plan.md`, `ui-plan.md`, bu sözleşme ve faz ayrımlı özellik envanteri güncel kararla uyumlu. Geniş envanterin tamamı ayrıca korundu. Doküman işidir, çalışan reseller değildir.
- [x] **RS-01 — Kaynak politika çekirdeği.** Saf ve durum tutmayan kapsam/sayım/adet kontrolleri yazıldı ve test edildi; HTTP/persistence yetkisi yerine geçmez.
  - [x] **RS-01a:** `apps/api/src/reseller-scope.js`, `cd89f8d8`. Tek bayi seviyesi, aktif actor/üst hesap, açık müşteri–Website bağı, Owner yönetimi/onarımı, başka bayi/müşteri reddi. `reseller-scope.test.js`: **41 geçti**. [Kaynak raporu](../history/reseller-scope-source-2026-09-23.md).
  - [x] **RS-01b:** `apps/api/src/reseller-limits.js`, `87a23c2a`. İki açık adet limiti; tam snapshot'tan askıdaki kayıtları da sayma; duplicate/orphan/bilinmeyen veriyi reddetme; ekleme kapasitesi. `reseller-limits.test.js`: **66 geçti**. İki dosya birlikte **107 geçti / 0 başarısız**, Node22.16.0; syntax kontrolleri geçti. [Limit raporu](../history/reseller-limits-source-2026-09-23.md).
- [ ] **RS-02 — Mevcut auth/state entegrasyonu.** Mevcut kullanıcı/Website depolarına küçük ve sürümlü ilişki katmanı; idempotent migration, rollback, eşzamanlı adet kontrolü. Rolü açmadan bütün API/list/job/AI/tool/gateway/WS hedeflerini canlı ilişki üzerinden doğrula. Askıya alma/ilişki değişiminde oturum ve açık erişimleri iptal et. Politika kayıtlarını request'ten değil güncel depodan üret.
- [ ] **RS-03 — Basit hesap API'si.** Owner bayi/müşteri oluşturur ve adet sınırı verir; bayi yalnız kendi müşterisini ekler/düzenler. Kimlik/parent/rol mass-assignment engeli, sunucu tarafında liste filtreleme, audit ve revizyon çakışması. Bağlı müşterisi/sitesi olan hesabı sessiz cascade-delete etme; açık engel ve çözüm göster.
- [ ] **RS-04 — Mevcut UI'yi bağla.** Owner için Bayiler/Müşteriler, bayi için Müşterilerim/Sitelerim; tek basit hesap formu, mevcut site araçları. Paket/abonelik seçtirme, boş buton ekleme, Files girişlerini kaldırma. Kullanıcıya yalnız gerçekten çalışan limitleri göster.
- [ ] **RS-05 — Gerçek kabul.** Owner, iki bayi, her bayide iki müşteri ve doğrudan Owner müşterisi. Başka tenant kimliğiyle API/job/Files/DB/AI/WS denemeleri; yetki iptali; paralel limit yarışları; restart ve migration rollback; gerçek tarayıcı. Hedef Node24/npm11 tam check ayrı çalıştırılır.

## Kapanış sınırı

İlk sürüm RS-01–05 ile kapanır; gelişmiş reseller özellikleri beklenmez. Reseller dışındaki site/OS/premium yol haritası iptal edilmez. **Bu tur yalnız RS-00 ve RS-01 tamamlandı; yeni API/UI/login açılmadı.** Kaynak testi geçti diye production-ready denmez. Gerçek ortam işleri `development-todo.md` ve kök `todo.md` içinde açık kalır.
