# RS-02e / BUG-20260923-02 — Silme hedefi ve temizlik kanıtı

2026-09-23; `development`, başlangıç `c19ead60`. İlk sözleşme `862ca7c3`; kaynak düzeltmeleri `1e59771e` ve `d3e16942`. Mevcut Website removal runtime ve HTTP yolu kullanıldı. Yeni silme motoru, rol, tenant yetkisi veya kontenjan bırakma API'si eklenmedi.

## Tamamlanan kaynak alt işleri

- [x] **RS-02e.1 / BUG-20260923-02a — `1e59771e`:** başlangıçta explicit URL Website, güncel previewDigest ve confirmation birlikte doğrulanır. İşlem ayrıntısında başka Website kimliği 404 verir; tamamlanmış/stale devam güvenli 409 olur. Aynı registry nesnesini paylaşan runtime'larda örtüşen silme çağrısı reddedilir; bekletilip eski destructive onay sonradan çalıştırılmaz. Girdi await öncesi kopyalanır. Bu koruma aynı süreç/registry içindir, bütün Website yazıcıları için ortak kilit değildir.
- [x] **RS-02e.2 / BUG-20260923-02b — `d3e16942`:** eksik cleanup metodu önizlemede görünür blocker ve null confirmation üretir; eski kayıtların devamında da kontrol edilir. Dosya ve Unix cleanup sonucu hedef kimliğini ve true tamamlanma alanını taşımalıdır; dosyada korunan yedek kümesi eşleşir. Metadata delete hatası yutulmaz; Website registry yeniden okunup null doğrulanmadan finalization başarılı sayılmaz. Geçersiz envanter boş listeye çevrilmez. SFTP gerçek object imzasıyla bir kez çağrılır; hata sonrası farklı imzayla tekrar yoktur. Başarısız silmenin yerine ikinci removal operation açılmaz. Harici hata mesajı ve rastgele adapter alanları genel işlem sonucuna kopyalanmaz.
- [x] **Seçili kaynak regresyonları:** 3 mevcut runtime testi + 25 hedef/örtüşme/route testi + 42 cleanup testi. Mevcut pozitif fixture'lar artık eksik servislerle sahte başarıya dayanmaz; gerekli adapter ve doğru sonuç verisini sağlar.
- [ ] **Üst kabul açık:** gerçek host cleanup adaptörleri, bütün create/provisioning/removal yazıcılarının ortak kilidi ve canlı yetkisi, güvenli quota release, veri içeren migration/rollback ve uçtan uca tarayıcı kabulü.

## Çalıştırılan kontroller

Ortam: **Node v22.16.0 / npm 10.9.2**.

```sh
node --test apps/api/test/website-removal-runtime.test.js apps/api/test/website-removal-target.test.js apps/api/test/website-removal-cleanup.test.js
```

**70 geçti / 0 başarısız / 0 atlandı.** Son kaynak haline karşı tekrar çalıştırıldı. İki değişen JS kaynak dosyası, yeni test helper'ı ve üç test dosyası `node --check` ile geçti. Önceki reseller/UI/API test toplamları bu sayıya eklenmedi ve bu tur yeniden çalıştırılmış sayılmaz.

Gerçek mevcut plan üreticisi, removal operation registry ve runtime çalıştırıldı; bir test gerçek geçici JSON dosyasını yeniden açıp blokajın korunduğunu doğruladı. Host cleanup ve Website registry adaptörleri kontrollü fixture'dır. HTTP testleri gerçek route callback'ini çağırır; Express listener, cookie/CSRF/MFA veya browser kabulü değildir. Tam checkout/bağımlılıklar, hedef Node24/npm11 `npm run check`, native Argon2, gerçek dosya/Unix/DB/mail servisleri ve canlı deployment çalıştırılmadı.

## Önemli mevcut kurulum sınırı

`apps/api/src/index.js` Website removal composition'ı halen fileCleanupHandler ve unixIdentityCleanupHandler vermiyor. Cron kaydı `deleteTask` sunarken removal host-adaptörü `removeTask` bekliyor; salt metadata silmeyi host crontab temizliği diye yeniden adlandırmadık. Bu kurulum artık ilgili eksik adaptörleri önizlemede gösterir ve kısmi silmeye başlamaz. Bu değişiklik gerçek host temizliğinin tamamlandığı iddiası değildir.

Dosya/Unix receipt'i güvenilir host adaptöründen gelmelidir; HTTP body kanıt sayılamaz. SFTP/DB/runtime metadata sonucu host erişiminin kapandığını tek başına kanıtlamaz. Registry yeniden okuması da soğuk disk yeniden açılışı ve yazma-hatası kabulünün yerine geçmez: cache/persist hata durumları ayrıca sınanmalıdır. Eski removed kayıtları geriye dönük güvenilir temizlik kanıtına dönüşmez.

Same-registry WeakMap yalnız örtüşen removal çağrılarını önler. Ayrı API/CLI süreçleri, site create, provisioning, child domain işleri ve diğer yazarlar için kalıcı ortak kilit/yeniden yetkilendirme hâlâ gereklidir. Eski yürütücünün tekrar yazamayacağı ve gerçek kaynak temizliği kanıtlanmadan hiçbir rezervasyon bırakılmaz; bu tur release API'si açılmadı.

## Gerçek ortam devri

`docs/ux/development-todo.md` içindeki T-DEV-REMOVAL-SAFETY ve mevcut T-DEV-RESELLER birlikte geçmelidir. Owner/Site A/Site B URL/onay/operationId sınırı, işlem sırasında logout/izin kaybı, gerçek adapter sonuçları, korunmuş yedekler, restart/yarım temizlik ve bağımsız yazıcı yarışları kabul edilir. BUG-20260923-02 ve RS-02e üst kutuları açık kalır. GitHub Actions, main değişikliği, Files/UI/tema değişikliği veya canlı sunucu işlemi yapılmadı; `.44` Plesk hostuna dokunulmadı.
