# BUG-20260923-01 / UX-PL-07 — İşlem durumu ve güvenli ilerletme

Başlangıç: `development@68372c27`, 2026-09-23. Kapsam önce `58ddc238` ile yazıldı. Mevcut İşlem geçmişi, JobDrawer ve site oluşturma/provisioning motoru korunur. Yeni job/retry endpoint'i, tema veya backend motoru eklenmedi.

## Kaynakta doğrulanan sorunlar

Önceki `jobLifecycle()` kuyruk/çalışıyor/terminal durumlarını sabit 1/3, 2/3, 3/3 diye sunuyordu; başarısız ve iptal işi de 3/3 görünüyordu. Bu bir ölçüm veya deneme sayısı değildi. JobDrawer ayrıca negatif deneme sayısını kabul ediyordu.

Önceki `autoAdvanceWebsiteProvisioning()` her POST hatasını üç kez deniyor ve başarısız her adımı hata sınıfını ayırmadan yeniden sıraya alıyordu. Cevabın kaybı işin sunucuda gerçekleşmediğini kanıtlamaz. Backend `website-provisioning-http.js` public projection ve `website-provisioning-orchestrator.js` sonuçları incelendi: `canRetry` manuel izin bilgisidir, güvenli geçici-hata otomatik retry politikası değildir. Bu ayrım korunur.

## Tamamlanan dar kaynak dilimi

- [x] **JOB-UX-01 / BUG-01a:** `job-presentation.js`, `47fbd830`; durumdan uydurma oran üretilmez. Geriye uyumlu progress alanı bilinmeyen işaretidir, UI'da sayısal ilerleme gibi kullanılmaz. `jobAttemptCount` yalnız negatif olmayan güvenli tam sayıyı kabul eder; gerçek 0 korunur, null/eksik/string/bozuk değer 0 yapılmaz ve max=3 varsayılmaz.
- [x] **JOB-UX-02:** `JobDrawer.jsx` (`e7f304b6`) ve `JobsTable.jsx` (`6dd4c17d`); sabit oranlar kaldırıldı, bildirilen deneme sayısı ayrı gösterilir. Hata, kaynak, tanılama, mevcut izleme, deploy logları ve kuyruktaki işi iptal etme erişimi korunur. Yeni genel retry düğmesi veya bypass yoktur.
- [x] **JOB-UX-03 / BUG-01b:** `provisioning-advance.js` (`7b73dcb5`) ve mevcut `provisioning-client.js` bağlantısı (`6c5ca00f`). Önce aynı operationId'nin güncel kaydı okunur; zaten hazır işlem tekrar POST edilmez. Yalnız doğrulanmış başarılı progressed/reconciled adım sonrası ilerlenir. Operation/Website kimliği, tekil adımlar, gereklilikler ve tamamlanmış adımların geriye düşmemesi kontrol edilir. Boş/yanlış/çelişkili/tekrarlanan cevap yayınlanmadan ve yeni POST'tan önce durulur.
- [x] **JOB-UX-03 oturum/tekrar sınırı:** otomatik zincir tek oturum nesline bağlıdır; geçiş, abort ve geç gelen sonuç yeni oturumla devam etmez. Hatalı POST, başarısız/bloke/kesintili veya geri alınmış adım kör tekrar üretmez; hata yutulmaz. Normal bekleyen adımlar otomatik ilerler, ancak önceden durmuş/in-flight iş yeniden otomatik başlatılmaz. Mevcut yazılı onaylı manuel continue/retry/compensate işlevleri aynı API ve payload ile korunur. Varsayılan 30, doğrulanan en fazla 100 başarılı adımlık ilerletme sınırı hata denemesi bütçesi değildir; istemci ready/retryExhausted uydurmaz.
- [x] **JOB-UX-04:** `a701c628`, `e9a32ae1`, `c2de65b8`; aşağıdaki seçili testler çalıştırıldı. Sekiz kaynak/test dosyasının Git blob SHA'sı test edilen yerel dosyalarla birebir eşleşti.

## Çalıştırılan kontroller ve sınır

Node **22.16.0**, npm **10.9.2**. **74 geçti / 0 başarısız / 0 atlandı**: 58 ilerletme davranışı, 11 sunum/regresyon, 5 kaynak bağlantısı testi. 58 testte read/advance ve public projection kontrollü fixture'dır; gerçek API listener/auth/host adaptörü çalıştırılmadı. Beş wiring testi kaynak metnini denetler, React render değildir.

```sh
node --test apps/web/test/job-presentation.test.js apps/web/test/provisioning-advance.test.js apps/web/test/job-progress-wiring.test.js
```

İki JSX dosyası ortamın hazır ayrıştırıcı/dönüştürücüsüyle kontrol edildi; üretilen JavaScript ve üç kaynak JS dosyası `node --check` ile geçti. Gerçek React/Vite import çözümlemesi, tarayıcı veya görsel kabul yapılmadı. Repo diline/paketlerine/lockfile'a dokunulmadı. GitHub DNS çözümleme hatası nedeniyle tam checkout alınamadı; Node24/npm11 tam lint/test/build yapılmadı.

Önceki Files, hosting, alias, SSL ve backend test sayıları bu 74'e eklenmedi; bu tur yeniden çalıştırılmış sayılmaz. Önceki SSL formu `36a46185` / `96db8b9b` ve `docs/ux/ssl-form-flow.md` içinde zaten kaynak tamamdır; `SiteOperations.jsx` bağlantısı yeniden okundu, yeniden yazılmadı. Ana planın kaynak işaretleri buna göre eşitlenir; üst BUG-04/05 kabulü açık kalır.

## Bilerek kapanmayan kaynak işleri

Güvensiz otomatik hata tekrarı kaldırıldı; backend kanıtlı güvenli otomatik retry henüz tamamlanmadı. Geçici-hata sınıflandırması, sağlayıcı bekleme süresi, kalıcı bütçe ve süreçler arası kilit ortak backend politikasına bağlanmalıdır. `canRetry: true` tek başına otomatik yeniden yürütme yetkisi olarak kullanılmaz.

NewWebsitePage'de site kaydı yaratıldıktan sonraki ilerletme hatasında mevcut site sonucunu/geri dönüş yolunu koruma ve manuel recovery panelinin stale kayıt, çift tıklama, actor/site değişimi sınırları ayrıca ele alınmalıdır. Bu istemci koruması backend tenant izolasyonunu, dağıtık kilidi veya host işinin iptalini tamamlamaz. Kaybedilen POST cevabında önce gerçek durum yeniden okunur; kaynaklar silinerek veya site yeniden oluşturularak uzlaştırma yapılmaz.

## T-DEV-JOB-UX — Codex gerçek ortam kabulü (açık)

- [ ] Hedef Node24/npm11 tam checkout, lint/test/build; gerçek React/Vite ile İşlem geçmişi, JobDrawer, site içi işler ve mevcut job/provisioning/session testleri. Kuyruk/çalışıyor/başarılı/başarısız/iptal/unknown ve 0/eksik/bozuk deneme sayısı doğrulansın.
- [ ] Başarılı gerçek kurulumun adımları bir kez ilerlesin; son başarılı işlem yeniden POST edilmesin. Yanlış operationId/Website, bozuk/tekrar cevap, ağ kopması/yanıt kaybı, 401/403/409/429/5xx ve sayfadan ayrılmada istemci kör POST tekrarlamasın. Gerçek requestJson/CSRF/session generation sınırı doğrulansın.
- [ ] Sunucu durumunu yeniden okuyup mevcut Site → Genel Bakış recovery akışıyla kontrollü devam/retry yap. Sonuç belirsizken siteyi yeniden oluşturma veya cleanup başlatma. Manuel retry sonrasında idempotency, ortak kaynak kilidi, yetki iptali ve restart doğrulansın.
- [ ] Backend sınıflandırmalı güvenli otomatik retry/backoff/kalıcı bütçe tamamlandığında limit sonrası yetkili manuel retry kabulü yapılsın. İstemcinin başarılı adım sınırıyla hata denemesi bütçesi karıştırılmasın. Kullanıcının bildirdiği diğer 0/3 sağlık/aşama sayaçları ayrıca izlenmeli; yalnız bu sabit job oranı giderildi diye hepsi kapatılmamalı.
- [ ] Owner/Site A/Site B, gerçek router/tarayıcı, klavye, mobil ve koyu tema; log/kaynak/iptal erişimi korunsun. `.44` Plesk hostuna dokunma; yalnız doğrulanmış izinli test hostunu kullan. Commit/asset/API kimliğiyle kanıtla.

Kök `todo.md`, `docs/ux/development-todo.md`, BUG-01 ve UX-PL-07 üst kapıları kapanmaz. Files/hosting/alias motorları, tema, main, GitHub Actions ve canlı host değiştirilmedi; deploy yapılmadı.
