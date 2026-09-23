# CREATE-RESULT — Site kaydı ve kurulum sonucu sürekliliği

Başlangıç `development@e37f2cfb`, 2026-09-23. Kapsam önce `ea6ccbea` ile yazıldı. BUG-20260923-01 / UX-PL-06/07/08 alt dilimi. Mevcut site-create preview/apply, autoAdvance ve Site → Genel Bakış recovery motoru korundu. Yeni endpoint, tema, bağımlılık veya host işlemi eklenmedi.

## Tamamlanan kaynak işleri

- [x] **CREATE-RESULT-01:** `dc395784`; `site-create-submission.js` preview, create ve sonraki provisioning aşamalarını ayırır. Doğrulanmış Domain/Website kaydı create cevabından hemen sonra sonuçta kalır; sonraki hata bunu silmez. Preview digest/onayı, operationId, Domain/Website, hostname, parent ve sunucu bağı denetlenir. Provisioning cevabı doğrulanamasa bile önceden doğrulanmış site kaydı korunur.
- [x] **CREATE-RESULT-02:** aynı controller aynı formda çift gönderimi engeller. Create POST gönderildikten sonra hata/yanıt kaybında aynı controller yeniden create yapmaz. Preview hatası, henüz create gönderilmediği için düzeltme/yeniden denemeye açıktır. Input snapshot'ı preview/apply boyunca değişmez; geç yanıt, abort, dispose ve oturum değişimi yeni ekrana yayınlanmaz. UI durumuna yalnız dar kimlik/adım alanları alınır; parola, ham sunucu cevabı, step intent ve ham hata kopyalanmaz.
- [x] **CREATE-RESULT-03:** `dfb375af`, `2500b1a0`; mevcut `NewWebsitePage` ve yeni dar `SiteCreateResult` bileşeni. Site oluşturulduktan sonra form yerine kayıt kartı gösterilir. Gerçek adım durumları, kısmi/belirsiz sonuç ve Genel Bakış/Dosyalar bağlantıları görünür kalır; bağlantılar Domain ID kullanır. Kayıt oluştu diye SSL/mail/Unix/çalışır site başarısı iddia edilmez. Belirsiz create sonucu kullanıcıyı site listesine yönlendirir; yanlış hedef için tahmini deep link üretmez.
- [x] **CREATE-RESULT-03 kapsam:** form kullanıcı/rol/oturum nesli ve parent bağlamına anahtarlıdır. Effect kendi controller'ını kurar ve yalnız onu kapatır. Formdaki parola doğrulanmış kayıt veya belirsiz create sonrasında temizlenir; kalıcı taslak deposu yoktur. Shared-site açık onayı ve `/domains` API'si, bütün yayın kaynağı/form seçenekleri korunur; shared-site için yalnız mevcut kayıt bağlantısı başarısı söylenir.
- [x] **CREATE-RESULT-04:** `be05ca7a`, `4bae66df`; Node22.16.0/npm10.9.2 ortamında **62 geçti / 0 başarısız / 0 atlandı**. 55 controller davranışı + 7 kaynak bağlantısı testi. İki JSX dosyası hazır parser/dönüştürücüyle kontrol edildi; üretilen JS ve controller `node --check` ile geçti. Parser kullanımı repo dilini veya bağımlılıklarını değiştirmedi.

## Kanıt ve test sınırı

```sh
node --test apps/web/test/site-create-submission.test.js apps/web/test/site-create-result-wiring.test.js
```

Beş test edilen kaynak/test dosyasının yerel Git blob SHA'ları GitHub ile birebir eşleşti:

| Dosya | Git blob SHA |
| --- | --- |
| `NewWebsitePage.jsx` | `24b65dd7490549c8e2f6e85ee15698fe24ec0595` |
| `SiteCreateResult.jsx` | `e8848f5614a2989f57f4d67466cc12911d71a8e9` |
| `site-create-submission.js` | `8c9a97d220534199a6e06c4a9fd005b716a3023f` |
| `site-create-submission.test.js` | `e2778f52f7f785558295828b25667bdaf61903c7` |
| `site-create-result-wiring.test.js` | `836d57695fef066d13d421202f229dc4523856bf` |

Davranış testleri kontrollü request/advance fixture'ları kullanır; gerçek API listener, auth/CSRF veya host adaptörü değildir. Yedi wiring testi kaynak metnini kontrol eder; React render testi değildir. JSX parse/dönüşüm import çözümleme, Vite build veya tarayıcı kabulü değildir. Önceki 74 job/provisioning testi, Files/hosting/alias/SSL ve mevcut form testleri bu tur yeniden çalıştırılmış sayılmaz; sayılar toplanmaz.

Kaynak incelemesi mevcut `site-create-http.js`, `site-create-base.js`, `website-provisioning-plan.js` ve `new-website-form.js` kontratlarına göre yapıldı. Tam checkout denemesi GitHub DNS hatasıyla; npm registry erişimi `EAI_AGAIN` ile başarısız oldu. Hedef Node24/npm11/React/Vite kurulumu yapılmadı, paket pinleri/lockfile değişmedi.

## Bilerek açık bırakılan işler

Manuel recovery panelinin stale kayıt/çift tıklama/yetki sınırları, backend güvenli otomatik retry, süreçler arası kilit ve gerçek host sonucu açıktır. `/sites` POST sonucunun belirsiz olması kaydın yok olduğu anlamına gelmez; otomatik create tekrarı veya cleanup yapılmaz. Bu ekrandan ayrılıp geri gelmek yeni form bağlamıdır; kalıcı işlem kurtarma güncel Site Genel Bakış/backend durumundan yürütülür, tarayıcıda parola veya tam sonuç saklanmaz.

`site-create-http.js` içindeki site-admin oluşturma hatasının yutulması ayrıca açık backend bütünlük sorunudur. Bu arayüz onu düzeltmez ve yönetici hesabının hazır olduğunu kanıtlamaz. Shared-site POST yanıt kaybı/yeniden gönderim ve stale onay hedefinin tam uzlaştırılması da bu bağımsız site-create controller'ının kapsamı değildir; mevcut akış korunmuştur, tamamlanmış kabul edilmez.

## T-DEV-CREATE-RESULT — Codex gerçek kabulü

- [ ] Node24/npm11 tam checkout, npm ci, lint/test/build ve mevcut create/provisioning/session/form regresyonları. Yukarıdaki 62 test gerçek React/router/API/host kabulünü kapatmaz.
- [ ] Gerçek create 201/200 sonrası provisioning GET/POST 401/403/409/429/5xx/timeout: kayıt kartı ve doğru Genel Bakış bağlantısı kalsın; yeni create POST gönderilmesin. Yanlış Domain/Website/server/operation cevabı başarı göstermesin.
- [ ] Create POST cevabı kaybolursa mevcut sitelerden durum uzlaştırılsın; otomatik tekrar/cleanup yapılmasın. Preview hatasında yerel form düzeltilebilsin. Aynı anda iki gönderim yalnız bir oluşturma denemesi başlatsın. Yeni sayfa bağlamında eski işlemin devamı backend kayıtlarından doğrulansın.
- [ ] Logout/login, yetki değişimi, unmount, gerçek StrictMode ve abort sırasında geç cevaplar başka hesaba taşınmasın; host işinin iptal edilmediği açık olsun. Parola alanı başarı veya belirsiz sonuç sonrasında temizlensin; tarayıcı profili/autofill davranışı ayrıca denetlensin.
- [ ] Ready/partial/blocked/failed/interrupted, sıfır/eksik adım ve hatalı cevap; gerçek ilerleme görünürlüğü, Genel Bakış recovery, Dosyalar, mobil/klavye/koyu tema ve shared-site mevcut onay yolu doğrulansın. Sonuç kartına geçerken klavye/ekran okuyucu odağı kontrol edilsin. Yalnız izinli test hostu; `.44` kullanılmaz.

Üst BUG-01, UX-PL ve T-DEV-JOB-UX kabulleri kapanmaz. Files/hosting/alias motorları, backend API, main ve canlı host değiştirilmedi. GitHub Actions ve canlı deploy yapılmadı.
