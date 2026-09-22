# Plesk tam kapsamı — rol, sahiplik ve ekran sözleşmesi

2026-09-23; `development`. Bu belge `plesk-ux-spec.md`, `plesk-route-matrix.md`, `plesk-reference-atlas.md` ve mimari belgenin eski reseller/abonelik dışlama kararlarını yalnız ürün kapsamı bakımından geçersiz kılar. Teknik güvenlik/veri koruma değişmez. Ana envanter: [tam özellik listesi](../plesk-feature-parity.md).

## Dört ayrı çalışma bağlamı

| Bağlam | Plesk'e eşlenecek ana işler | Yetki sınırı |
| --- | --- | --- |
| Service Provider yönetici | Customers, Resellers, Domains, Subscriptions, Service Plans, Tools & Settings; eklentiler ve sistem | Yerel kurulumdaki tüm yetkili kaynaklar; son Owner korunur |
| Power User yönetici | Websites & Domains, Mail, Files, Databases, Statistics, Users, sunucu araçları | Aynı yönetici hesabının site odaklı görünümü; reseller verisi silinmez |
| Reseller | Kendi müşterileri, abonelikleri, hosting paketleri, kendi siteleri, kullanım ve hesap | Yalnız kendine tahsisli kaynaklar/izinler; üst yönetici veya başka bayi kaynakları yok |
| Customer | Websites & Domains, Mail, Files, Databases, Statistics, izinli kullanıcılar ve hesap | Yetkili abonelik/site kümesi; sunucu root ve başka müşteri verisi yok |

Resmî rol ayrımı: https://docs.plesk.com/en-US/obsidian/administrator-guide/70562/ ; müşteri/reseller: https://docs.plesk.com/en-US/obsidian/administrator-guide/customers-and-resellers.70622/ ; abonelik yönetimi: https://docs.plesk.com/en-US/obsidian/reseller-guide/managing-subscriptions.65732/ . Görünüm ve edition/extension koşulları uygulama matrisi içinde doğrulanır.

## Sahiplik ve model

Yönetici → opsiyonel Reseller → Customer → Subscription → Website/Domain → kaynaklar. Ek kullanıcılar üyelik/rol ile bağlanır; oturum actor kimliğini korur. Reseller kendi sitesi için de açık müşteri/abonelik bağı taşır. Plan bir kaynak değildir: aboneliğe aktarılan izin/limit/default sözleşmesidir. Add-on ve özelleştirme farkı, plan sync/lock/unsynced, expiry/suspend, overuse/overselling ve ownership transferi ayrı durumdur.

Bu bir hedef modeldir; bu tur reseller API veya veritabanı migrasyonu uygulanmadı. Mevcut site_manager'ı yeniden adlandırmak eşdeğer değildir. Her API/list/job/tool/backup/log/AI eylemi yeni kapsamda yeniden yetkilendirilir. Unix kimlikleri açık veri migrasyonu olmadan birleştirilmez.

## Yeni görev akışları

- [ ] Müşteri: Liste → ekle/ayrıntı → iletişim/giriş/abonelikler → suspend/transfer/delete etki onayı → doğrulanmış sonuç.
- [ ] Reseller: Liste → paket/limit/izin tahsisi → kendi müşteri/abonelikleri → kullanım → güvenli yönetim bağlamı ve yöneticiye dönüş.
- [ ] Service Plans: hosting ve reseller planlarını ayrı listele → limit/izin/hosting/mail/DNS tercihleri → etkilenen abonelikler → sync/lock/customization farkı ve sonuç.
- [ ] Subscriptions: müşteri/paket/alan adı → oluşturma → kaynak/limit/expiry → paket değiştirme/add-on/ownership → suspend/restore/delete.
- [ ] Customer site işleri: mevcut doğrudan Files/Mail/DB/DNS/SSL yolları korunur. Aktif abonelik veya bütün izinli abonelikler filtrelenir; seçimin query veya eski cookie değeri olması yetki değildir.
- [ ] Admin login-as: explicit izin, audit actor/subject, süre ve görünür geri dönüş; gerçek müşteri parolasını öğrenme/kopyalama yok.

## Test kapıları

İki reseller, her birinde iki müşteri ve farklı abonelikler; doğrudan API kimliği değiştirme, plan limitleri, quota race, transfer sırasında açık oturum/AI/job, eski backup erişimi, silme bağımlılıkları ve suspend etkileri test edilir. Üst yöneticinin global işi ile reseller/customer işi aynı güçlü root backend'de çalışsa da hedef yetkisi hiçbir yoldan genişletilmez.

Windows ve üçüncü taraf premium eklentilerin eşdeğerliği envanterde ayrı satırlardır. Bunlar tamamlanmadan tüm Plesk birebir tamamlandı denmez. Açık kaynak taban kararı verilirse bu görev kabulü karşılaştırma kriteri olarak korunur; kullanıcıya görünür yeni bir özel düzen icat edilmez.
