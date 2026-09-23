# YunPanel için açık kaynak panel tabanı — karar ön incelemesi

Tarih: 2026-09-23. Durum: **araştırma ve öneri; mimari değişiklik onaylanmadı ve uygulanmadı.** YunPanel `development` üzerinde korunur. Hiçbir alternatif panel kurulmadı, üçüncü taraf repo Yunsoft adına çatallanmadı ve canlı site taşınmadı.

## Sonuç

Yeni hedef yalnız Yunsoft'un kendi sitelerini yönetmek değil, Plesk'in reseller/customer/subscription/plan kapsamı dahil eşdeğerliği olduğundan, benim mühendislik önerim **hazır hosting çekirdeğini kullanmayı ilk sırada değerlendirmek; ilk aday ISPConfig**. Sıfırdan aynı hesap ve servis yaşam döngülerini yazmak yerine geliştirme emeği YunPanel'in Plesk görev düzenine, mevcut Ember tasarımına, AI ve eksik ürün akışlarına ayrılabilir. Bu bir ölçülmüş süre/maliyet sonucu değildir; örnek kurulum ve API testleriyle doğrulanması gereken tercih önerisidir.

## Adaylar ve lisans sınırları

| Aday | Doğrulanan dayanak | Hedefe ilişkin değerlendirme |
| --- | --- | --- |
| **ISPConfig** | Resmî site BSD lisansı, administrator/reseller/client seviyeleri ve Nginx/Apache, Postfix, Dovecot, DNS, DB, firewall/kota yönetimini listeliyor. [K1] | Tam hosting-provider kapsamı ve ticari ürün esnekliği için ilk aday. Plesk abonelik/paket davranışının tamamını birebir sağladığı varsayılmaz. |
| **Froxlor** | Resmî sitede GPL; belgelerde admin/reseller/customer ve API görevleri var. Güncel GitHub `main` README'si yeni nesli LGPL-2.1-only, erken geliştirme ve production dışı diye tanımlıyor. [K4–K6] | İkinci değerlendirme adayı. Stabil sürüm ile yeni `main` karıştırılmaz; seçilen release'in lisans dosyası ve paketleri ayrıca incelenmelidir. v2.3 ref'i bu oturumda GitHub connector ile getirilemedi; release düzeyinde lisans onayı verilmedi. |
| **HestiaCP** | Resmî repo GPLv3, web/mail/DNS/DB/SSL/firewall işlevlerini belgeliyor. İsim/logo kullanımına ayrı marka kısıtları var. [K7] | Standart Linux hosting için aday; Plesk'in tam reseller/abonelik zinciri incelenen kaynaklarda doğrulanmadı. Bu kapsam hazırmış gibi kabul edilmez. |
| **Virtualmin GPL** | Ücretsiz açık sürüm mevcut; resmî Pro→GPL belgesi reseller yönetiminin Pro'ya ait olduğunu ve downgrade'de bu hesapların kilitlendiğini açıkça söylüyor. [K8] | Ücretsiz çekirdek tam reseller hedefini tek başına karşılamıyor. Ücretli Pro kodu açık sürümün dağıtım hakkına dahil sayılamaz. |
| **CyberPanel** | Resmî repo GPLv3; OpenLiteSpeed tabanı, hosting araçları ve ACL yönetimi listeleniyor. [K9] | Değerlendirilebilir; YunPanel'in mevcut Nginx/Passenger düzenine geçiş maliyeti ayrıca hesaplanmalı. Hazır Plesk eşdeğeri diye önerilmez. |
| **CloudPanel** | Yayımlanan License Terms 5/6, değişiklik ve yeniden dağıtımı sınırlıyor; açık bileşenler için ayrı istisnalar var. [K10] | Genel paneli çatallayıp kendi ürünümüz olarak geliştirme amacı için uygun lisanslı taban diye önerilmiyor. Ücretsiz kullanım veya ayrı bir yardımcı projenin MIT lisansı, panelin tamamını MIT yapmaz. |

### ISPConfig için kritik ticari ayrım

Çekirdek ile Billing Module aynı lisans değildir. Billing Module şartları tek panel sunucusunda kullanıma izin veriyor; kendi kullanımına yönelik değişiklik serbest, fakat kaynak kodu üçüncü taraflarla paylaşma/yayımlama yasak. Bu modül fork'un içine konulup müşterilere serbestçe dağıtılamaz. [K2]

### “Lisans sıkıntısız” ne anlama gelmeli?

İzin veren açık kaynak lisansı seçmek, yükümlülük olmaması demek değildir. BSD-3-Clause örneğinde kaynak/binary dağıtımında ilgili telif, koşul ve sorumluluk reddi bildirimleri korunur; isimle izinsiz onay izlenimi verilemez. ISPConfig'in resmî lisans beyanı BSD'dir; seçilecek release'in tam lisans/bağımlılık dökümü henüz yapılmadı. [K1, K11]

GPL ticari kullanım veya ücretli dağıtımı yasaklamaz. GPL kapsamındaki türev yazılımın dağıtımında ilgili kaynak kodu ve lisans yükümlülükleri sürer; bağımsız ürünlerin kapsamı teknik birleşim biçimine bağlı ayrıca incelenir. GPL ile AGPL veya ticari Pro lisansı aynı şey değildir. [K12] Dağıtım öncesinde seçilen commit/release, bağımlılıklar, ikon/font/marka ve eklentiler için ayrı lisans denetimi gerekir. Bu çalışma hukuki garanti değildir.

## Uygulama biçimi önerisi

**YunPanel arayüzü ve görev akışları → server-side yetki/entegrasyon katmanı → ISPConfig'in desteklenen API/işlem yolu → servisler.** ISPConfig Remote API belgeleniyor; bütün hedef endpointlerin izin, hata ve tamamlanma davranışı bu araştırmada çalıştırılarak doğrulanmadı. [K3]

API anahtarı tarayıcıya verilmez. Her kullanıcı eylemi güncel reseller/customer/subscription sahipliğiyle kontrol edilir. Başarılı API kabul cevabı, host üzerinde işlemin bitmesi sayılmaz. Her kaynak türünde tek konfigürasyon yazarı bulunur: aynı Nginx/mail/DNS dosyasını YunPanel'in eski motoru ve alternatif panel birlikte yönetmez. API eksikse sınırları belirli adapter veya upstream'e geri taşınabilir küçük patch değerlendirilir; doğrudan DB yazmak varsayılan entegrasyon değildir.

Geniş bir fork ile bütün dosyaları değiştirip upstream güvenlik güncellemelerini alamaz hâle gelmek yerine küçük değişiklik yüzeyi tercih edilir. Plesk UX ve YunPanel renkleri korunurken ISPConfig'in mevcut arayüzünü aynen kullanmak zorunlu değildir; yeni UX'in geliştirme maliyeti yine vardır.

## Karar vermeden geçmesi önerilen kanıt kapısı

Bu kapı yeni panel kurma yetkisi değildir; taban seçimi onaylandığında uygulanır.

1. Sabit release/commit, gerçek LICENSE dosyaları, third-party bildirimleri ve ticari modüllerin dağıtım sınırları.
2. Temiz izinli hedefte admin→reseller→customer, kaynak sınırları, plan/abonelik eşleme; Site A/B API ve filesystem izolasyonu.
3. Site→dosya→SSL→mail→DB→yedek/restore→silme zinciri; başarısız iş/retry/restart ve gerçek durum kanıtı.
4. Mevcut YunPanel Website/Domain ID, Unix kullanıcı, mail parolası/hash, DB grant, DNS ve sertifika ilişkilerinin kayıpsız taşınabilirliği; uygulanabilir geri dönüş.
5. `docs/plesk-feature-parity.md` satırlarının aday panelde hazır/entegrasyon gerekli/yeni geliştirme/lisans bağımlı olarak ölçülmesi. Windows ve üçüncü taraf Marketplace davranışları ayrıca kalır; Linux tabanı tam Plesk demek değildir.

**Karar önerisi:** tam Plesk kapsamını sıfırdan büyütmeye devam etmeden ISPConfig'i bu kanıt kapısından geçirmek daha rasyonel. Geçerse hosting çekirdeğinde onu kullanmak, YunPanel'i ürün/UX/AI katmanı olarak geliştirmek; geçmezse ölçülen eksiğe göre Froxlor veya mevcut YunPanel yolu arasında karar vermek. Önceden harcanmış emek tek başına seçim gerekçesi değildir; henüz doğrulanmamış bir panel de otomatik kurtuluş değildir.

## Birincil kaynaklar

- K1: https://www.ispconfig.org/ispconfig/services-and-functions/
- K2: https://www.ispconfig.org/add-ons/billing-module/
- K3: https://docs.ispconfig.org/development/remote-api/
- K4: https://froxlor.org/
- K5: https://docs.froxlor.org/latest/admin-guide/resources/admins-resellers/
- K6: https://github.com/froxlor/froxlor
- K7: https://github.com/hestiacp/hestiacp
- K8: https://www.virtualmin.com/docs/development/api-programs/downgrade-license/
- K9: https://github.com/usmannasir/cyberpanel
- K10: https://www.cloudpanel.io/license-terms/
- K11: https://opensource.org/license/bsd-3-clause
- K12: https://opensource.org/license/gpl-3.0
