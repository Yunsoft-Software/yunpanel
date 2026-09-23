# RS-02e / BUG-20260923-02 — Silme hedefi ve temizlik kanıtı

2026-09-23; `development`, başlangıç `c19ead60`. Sade reseller kapsamı değişmez. Mevcut Website silme runtime'ı ve HTTP yolları düzeltilir; yeni silme motoru, rol veya otomatik kontenjan bırakma eklenmez.

## İnceleme ve bu dilimin sırası

`website-removal-http.js`, başlangıçta URL Website kimliği ve previewDigest'i runtime'a gönderiyor; mevcut `start` bunları kullanmayıp hedefi yalnız confirmation'dan çıkarıyor. İşlem ayrıntısı GET yolu da dönen operation'ın Website bağını doğrulamıyor. `continueStep` tamamlanmış işte null step üzerinden confirmation üretmeye çalışıyor.

`website-removal-runtime.js` bazı cleanup bağımlılıkları yokken başarı yazıyor; metadata silme hatasını yutuyor. Bu sonuçlar güvenli reseller kontenjanı bırakma kanıtı olamaz. Önce bu somut silme engelleri düzeltilir; bütün Website yazıcılarının süreçler arası ortak kilidi ve canlı yetki entegrasyonu RS-02e'de açık kalır.

## Kaynak alt işleri

- [ ] **RS-02e.1 / BUG-20260923-02a:** URL Website, güncel previewDigest ve confirmation aynı hedefe bağlanır. İşlem GET/continue yanlış Website ve tamamlanmış/stale adımda güvenli hata verir; hiçbir cleanup yan etkisi oluşmaz.
- [ ] **RS-02e.2 / BUG-20260923-02b:** Dosya/Unix temizliği eksik handler veya doğrulanmamış sonuçla tamamlanmaz. Metadata silme hatası yutulmaz; Website gerçekten kaldırılmadan işlem removed sayılmaz. Diğer cleanup adımlarında eksik bağımlılık başarı değildir. Mevcut adapter sözleşmeleri korunur; exception sonrası farklı imzayla kör tekrar yapılmaz.
- [ ] **Kaynak regresyonu:** Gerçek mevcut silme runtime'ı, registry ve HTTP route bağlantısı; yanlış hedef, eksik bağımlılık, hata/kısmi sonuç ve devam senaryoları yerelde sınanır. Native auth, gerçek host temizliği ve tarayıcı ayrıca kabul edilir.

## Açık kalan yayın kapıları

Ortak create/provisioning/removal kilidi, bütün API/job/AI/tool/gateway/WS yollarında canlı yetki, güvenli compensation/release ve veri içeren migration açık kalır. Bu değişiklik eski removed kayıtlarını geriye dönük doğrulamaz. Eski yürütücünün tekrar yazamayacağı ve gerçek kaynak temizliği kanıtlanmadan rezervasyon bırakılmaz. Yeni reseller erişimi veya site create HTTP yolu açılmaz.

Node24/npm11 tam check; yalnız izinli hedefte gerçek disk/Unix/DB/mail/runtime/silme-restart kabulü; Owner/Site A/Site B tarayıcı ve doğrudan API testleri yapılmadan production-ready denmez. `.44` Plesk hostuna dokunulmaz. GitHub Actions ve main değişikliği yok.
