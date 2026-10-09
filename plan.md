# YunPanel — Kalan Ürün / Kod Planı

## Son kullanıcı teyidi ve UX ilerlemesi — 2026-09-23

**Güncel sıra: Plesk görev yerleşimi ve site araçlarının kullanım akışları önce gelir.** Aşağıdaki eski “bu tur önce reseller” sırası bu son teyitle değiştirilmiştir. Ayrı reseller/cleanup backend genişlemesi günlük site araçlarının önüne geçmez; güvenlik ve üretim kabulü gevşetilmez. Mevcut Ember görsel dili ve çalışan motorlar korunur.

Bu bölüm, `ui-plan.md` ve önceki navigasyon raporundaki “kart/liste kaynak işi henüz yapılmadı” notunun güncel karşılığıdır. Sonraki dilim yeni bir dashboard veya reseller paket motoru değil, mevcut site araçlarının oluşturma/düzenleme/sonuç/geri dönüş akışıdır.

## Son kapsam kararı — 2026-09-23: development, sade reseller

Aktif dal **`development`**, başlangıç **`main@1a45ded8697d640b87c149143613454fac1fa94d`**. Bu çalışma main'e yazılmaz. Kullanıcının son isteğiyle reseller kapsamı küçültüldü: **Owner → isteğe bağlı tek Reseller → Customer → mevcut Website**. İlk sürüm müşteri/site yönetimi ve iki basit adet sınırıdır; zorunlu paket veya abonelik katmanı yoktur. [Güncel rol/ekran ve RS-00–05 sözleşmesi](docs/ux/plesk-full-scope.md) uygulanır. [Tam özellik envanteri](docs/plesk-feature-parity.md) uzun vadeli karşılaştırma kaydıdır; geniş reseller satırları ilk sürümün yayın engeli değildir.

**Sonraki faz:** alt bayi, reseller paket motoru, add-on, abonelik sync/lock/customization, overselling, otomatik expiry/fatura, bayi markalama, dönüşüm, toplu transfer ve login-as. Ertelendi demek tamamlandı demek değildir. Reseller dışındaki Plesk görev düzeni, site araçları, Windows ve premium/harici yol haritası iptal edilmedi. Güvenlik, tenant izolasyonu ve mevcut site düzeyindeki limitler azaltılmaz.

Tamamlanan maddeler gerekli kontroller ve Git birleştirmesi sonrasında bu plandan çıkarılır; ayrıntılı kanıtlar Code Factory görev geçmişinde, önceki raporlar Git geçmişinde kalır. `done.md` yalnız kısa bir geçmiş açıklamasıdır. Canlı kabulü tamamlanmamış üst özellik açık kalır. Açık kaynak paneli taban alma araştırması uygulanmış mimari kararı değildir; izinsiz panel/stack değiştirilmez.

## Bağlayıcı karar — 2026-09-23: Plesk UX, mevcut görsel dil korunur

İlk UX işi Dosyalar erişiminin geri kazanılması ve kullanım/bilgi mimarisinin Plesk görev düzenine taşınmasıdır. Eski backend-first/UX-sonra ve özel workspace düzeni talimatları bu konuda geçersizdir. Bu tur önce reseller doküman sadeleştirmesi, sonra küçük kaynak dilimleri yapılır. Production güvenlik engelleri kaldırılmaz; bütün yayın kapıları geçmeden production-ready denmez.

**Korunacak:** mevcut Ember renkleri, fontlar, radius/element şekilleri, ortak tokenlar, açık/koyu tema tercihleri ve erişilebilir bileşenler. **Değişecek:** menü hiyerarşisi, ekranların yeri, site araçlarına giriş, sayfa geçişleri ve işlemlerin kullanım biçimi. Plesk'in rengi/logosu kopyalanmaz; doğrulanmış görev yerleşimi referans alınır. UI güzelleştirme gerekçesiyle özellik veya erişim yolu silinmez.

UX girişi `ui-plan.md`; ayrıntılı sözleşme `docs/ux/plesk-ux-spec.md`; atlas `docs/ux/plesk-reference-atlas.md`; rota/kabul matrisi `docs/ux/plesk-route-matrix.md`. Reseller kapsamı bakımından bu belgeler ve eski tam-parity ifadeleri yerine yukarıdaki son karar ve `docs/ux/plesk-full-scope.md` geçerlidir.

Önceki planın eksiksiz kopyası [karar öncesi arşiv](docs/history/plan-before-plesk-ux-80f3d1c4.md) içindedir. A–E işleri korunur. Teknik/güvenlik sınırları `agents.md` ve `docs/architecture.md`; gerçek host/tarayıcı kabulü `todo.md` ve `docs/ux/development-todo.md` içindedir. `.44` Plesk sunucusu hiçbir amaçla kullanılmaz. Küçük commit, güncel `development`, force-push yok, GitHub Actions yok; commitlerde `[skip ci]`.

## C — ONAYLANDI: production araştırmasındaki güvenlik ve işlem bütünlüğü işleri

Bu bölüm kullanıcı tarafından 2026-09-23'te onaylandı. Kaynak bulguları başlangıç `e57f76f6` / doküman sonrası `80f3d1c4` sürümüne aittir; uygulayıcı güncel kodda yeniden doğrular. Önceki `.28` kabul raporları bugünün canlı durumunu kanıtlamaz.

## D — ONAYLANDI: özellik derinliği, Plesk UX içinde

Yeni bağımsız dashboard/modül icat edilmez. Mevcut API/adapter kapasitesi önce matrise çıkarılır; görevler ilgili site/sunucu ekranında tamamlanır. Bir alanın tümü yok varsayılmaz, bitmiş motor yeniden yazılmaz.

## E — Önceki açık işler: korunur, yeni UX kararıyla uygulanır

- **SSL süre ve fingerprint senkronizasyonu (BUG-20260923-06 / UX-PL-06/07 / SR-01–04):**
  - **Kaynak ve kabul ayrımı izleme:** SSL süre/fingerprint senkronizasyonunun güncel kaynak ve kabul ayrımı kök `plan.md` içinde izlenir.
  - **Kaynak durumu:** `certificate-registry.js` markActive ve `job-reconciliation.js` gerçek validFrom/validTo/fingerprint değerlerini kaydeder; `ssl-renewal.js` job sonucu ile aktif kalıcı sertifika kaydı arasındaki fingerprint ve tarih eşleşmesini doğrular; `ssl-job-refresh.js` terminal iş durumunda koleksiyon yenilemesini tetikler.
  - **Kabul ayrımı:** Paneldeki kalıcı metadata ile job kanıtı eşitliği, gerçek TLS bağlantısında sunulan sertifikanın veya Nginx/mail reload etkisinin canlı kanıtı değildir. Canlı TLS bağlantısı, dışarıdan sunulan fingerprint ve süre doğrulaması Code Factory staging/host kanıtları kaydedilene kadar açık tutulur.

## F — Sade reseller uygulaması ve korunmuş Plesk yol haritası

- **PAR-02 / RS-03–05 — Basit Customer/Reseller yönetiminde kalan kabul:**
- **PAR-03 — Sonraki faz, MVP engeli değil:** hosting/reseller paket motoru, add-on, Subscription lifecycle/expiry, overselling, sync/lock/customization ve kapsamlı sahiplik transferi. Yeni kullanıcı kararı olmadan ilk sürüme geri taşınmaz; tamamlandı işareti verilmez. Site seviyesindeki gerçek limitler PROD-15'te kalır.
- [x] **PAR-04 — Reseller dışındaki kalan işlevler (2026-10-04):** DNS/mail/DB/runtime/Docker/Git/WP/Laravel/backup/security/API/CLI/migration görevleri envanter ID'leriyle korundu; B-E görev bağlantıları ve non-reseller yetenek kataloğu bağlandı; reseller markalama sonraki faza ertelendi; kiracı sınırları fail-closed doğrulandı.
- [x] **PAR-05 — OS ve premium/harici eşdeğerlik hatları (2026-10-04):** Windows/IIS/.NET/MSSQL/NTFS adaptör sözleşmeleri ve işletim sistemi sınırları Linux tenant izolasyonunu koruyacak şekilde fail-closed tanımlandı; ticari sertifika, Sitejet, premium güvenlik/yedekleme/araç kiti ve domain registrar harici yaşam döngüsü sözleşmeleri bağlandı; yapılandırılmamış/desteklenmeyen hatlar fail-closed kapatıldı; reseller faturalama ve abonelik otomasyonu ilk sürüm MVP engeli olmaksızın sonraki faza ertelendi.

## Uygulama ve kapanış

1. RS-02e ve RS-05 üst kabulü açık. Sıradaki iş, gerçek Node24/npm11 ve Owner/reseller/customer host/browser matrisiyle long-running job/gateway/WS suspend/removal/logout/session-rotation davranışını doğrulamak; görülen yeni kaynak boşluklarını dar commitlerle kapatmak.
2. Dosya yöneticisinin gerçek tarayıcı kabulü açık. T-DEV-FILES ve kök `todo.md` korunur; kalan UX-PL ve B regresyonları mevcut Plesk görev düzeninde ilerler.
3. C grubu güvenlik/bütünlük işleri ve YP-04/YP-11 yayın engelidir; sadeleştirme bunları kaldırmaz.
4. D ve F işleri mevcut motorlarla ilerler; panel tabanı değiştirmek ayrı onay ister. MCP/migration temizliği kabul sonradır.
5. Kaynak testi ve gerçek ortam kabulü ayrılır. Biten alt adım gerekli kapılar ve Git birleştirmesi sonrasında plandan çıkarılır; bitmeyen üst özellik açık kalır. Ayrıntılı RS kabulü `docs/ux/plesk-full-scope.md`; gerçek ortam notları `docs/ux/development-todo.md`.
