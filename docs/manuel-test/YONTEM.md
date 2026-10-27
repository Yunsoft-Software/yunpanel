# Özellik testi yöntemi (1. dalga, 2026-10-27 sürümü)

> Senior yazar. Her `Manuel test: <ID>` görevi bu belgeye göre yürür. Kararlar: `docs/orkestra/DECISIONS.md` (2026-10-26 ve 2026-10-27).
>
> **27 Ekim değişikliği:** Ajan tarayıcıda elle tıklamaz. Özelliği gerçek panele karşı çalışan bir **Playwright senaryosu** olarak yazar ve koşturur. Yine gerçek tarayıcı, gerçek panel, gerçek API ve gerçek host kullanılır; mock yoktur. Yazılan dosya 2. dalganın gerçek testidir, yani 1. ve 2. dalga birleşti. Bu tarihten önce elle yapılmış raporlar geçerli kalır.

## Amaç
`docs/plesk-feature-parity.md` içindeki özelliğin bugün `.28` üzerinde gerçek bir kullanıcı için çalışıp çalışmadığını ölçmek ve bunu tekrar koşturulabilir bir testle kanıtlamak. Kaynak kodu (uygulama) **değiştirilmez**; yalnız test dosyası ve rapor yazılır. Kritik olmayan hata düzeltilmez.

## 1. Mevcut testlere kısa bakış (kilit gerekmez, en fazla 10 dakika)
- `grep -rl` ile özelliğin rotası/API yolu/bileşen adıyla `e2e/` ve `apps/*/test` içinde ara.
- **En ilgili en fazla 3 dosyayı** oku ve çalıştır: birim için `node --test --test-timeout=120000 <dosya>`; e2e dosyası ise yalnız aşağıdaki kilitle.
- Sınıflandır: **GEÇERLİ** (gerçek davranışı doğru ölçüyor), **YÜZEYSEL** (kaynak metni/regex, yalnız "200 döndü"), **MOCK** (sahte servis/stub/sahte veri), **YANLIŞ** (bozuk akışı doğru sayıyor), **KIRMIZI** (düşüyor/takılıyor).
- Var olan bir GEÇERLİ e2e senaryosu bu özelliği zaten tam ölçüyorsa yeni dosyada aynı şeyi tekrar yazma; onu çalıştır ve rapora sonucunu yaz. Yeni dosyaya yalnız eksik senaryoları koy.

## 2. Senaryo dosyası: `e2e/ozellik/<id-küçük>.spec.js`
Örnek: WEB-02 için `e2e/ozellik/web-02.spec.js`.
```js
import { test, expect } from '@playwright/test';
import { OWNER_USERNAME, OWNER_PASSWORD, loginAs } from '../helpers.js';

test.describe('WEB-02 Subdomain ve ayrı document root', () => {
  const prefix = `tweb02-a${process.env.AGENT_N || 'x'}-${Date.now().toString(36)}`;
  test.beforeEach(async ({ page }) => { await loginAs(page, OWNER_USERNAME, OWNER_PASSWORD); });
  test.afterAll(async ({ browser }) => { /* oluşturulan her kaynağı panel arayüzünden sil */ });

  test('mutlu yol: subdomain oluştur ve gerçek HTTP cevabı al', async ({ page, request }) => {
    // arayüzden oluştur → ekranda sonucu doğrula → fiziksel sonuç: request.get(`https://${host}/`)
  });
  test('hatalı girdi: geçersiz subdomain adı reddedilir', async ({ page }) => { /* ... */ });
});
```
Kurallar:
- **Arayüz üzerinden** kullan (tıkla, doldur, gönder). API'yi doğrudan çağırmak yalnız fiziksel sonucu doğrulamak içindir (ör. sitenin HTTP cevabı).
- **Senaryolar:** her özellikte 1 mutlu yol ve 1 hatalı girdi. Rol senaryosu (Reseller/Customer başkasının kaynağını göremez ya da değiştiremez) **yalnız** yetki, hesap veya kiracı içeren özelliklerde.
- **Fiziksel sonuç** en az bir senaryoda doğrulanır: HTTP cevabı, indirilen dosya, DNS cevabı, oluşan kayıt. "Başarılı" mesajı yetmez.
- **Önek ve temizlik:** Her kaynak `t<id>-a<n>-<zaman>` önekiyle açılır ve `afterAll` içinde arayüzden silinir. Mevcut veriye (webrich.news dahil) dokunulmaz.
- **Bulunan gerçek hata:** Testi gevşetme, beklentiyi değiştirme, silme. Doğru beklentiyi yaz ve `test.fail(true, 'BULGU <ID>: <kısa açıklama>')` ile işaretle. Hata düzelince test "beklenmedik başarı" verir ve fark edilir.
- Mock, `page.route` ile sahte cevap, sabit sahte veri ve `waitForTimeout` ile bekleme yasak; `expect(...).toBeVisible()` gibi bekleyen doğrulamalar kullanılır.
- Parola, cookie ve token dosyaya, rapora ya da loga yazılmaz; giriş bilgisi `helpers.js` üzerinden `.local`'den gelir.

## 3. Koşturma (kilitle)
- `sunucu-28-1/2/3` kilitlerinden boş olanı al (PROJE.md). Sunucu geneli ayar değiştiren senaryoda ayrıca `sunucu-28-genel`.
- `AGENT_N=<n> npx playwright test e2e/ozellik/<id>.spec.js --reporter=line`
- Geçen, düşen ve `test.fail` sayısını not et, sonra kilidi bırak.
- Ekran görüntüsü yalnız beklenmeyen bir hata için alınır, `.local/manuel-test/<ID>/` altına.

## Hata sınıfı
- **KRİTİK:** Testi tamamen engelleyen, veri kaybeden/bozan, başka kullanıcının/sitenin verisini gösteren veya değiştiren, servisi çökerten ya da paneli açılmaz yapan hata. Hemen `python3 orkestra/orchestrator.py finding "KRİTİK <ID>: <kısa başlık>" "<tekrar üretme + beklenen/gerçek>" <ilgili kaynak dosyaları>` (yalnız sıralı argümanlar; `--title` gibi bayrak yok). Yazarken `bash orkestra/lock.sh acquire bulgular AGENT_n` … `release`.
- **NORMAL:** Diğer her şey; yalnız raporda ve `test.fail` açıklamasında kalır.

## Rapor: `docs/manuel-test/<ID>.md` (en fazla 40 satır)
Kanıt senaryo dosyasıdır, rapor kısa tutulur. Yalnız tablolar; uzun açıklama, kod ya da log dökümü yok.
```markdown
# <ID> — <özellik>
Sonuç: ÇALIŞIYOR | KISMİ | ÇALIŞMIYOR | TEST EDİLEMEDİ
Ajan: AGENT_n · Tarih: YYYY-MM-DD HH:MM · Senaryo: `e2e/ozellik/<id>.spec.js` · Koşu: <geçen>/<toplam>, test.fail <n>

## Senaryolar
| Test adı | Sonuç (geçti/düştü/bilinen hata) | Fiziksel kanıt |

## Hatalar
| Sınıf | Başlık | Bulgu görevi |

## Mevcut testler
| Dosya | Sınıf | Not |

## Panelde olmayan
(Plesk'teki karşılığı olup bulunamayan alt işlevler; yoksa —)

## Temizlenemeyen kaynaklar
(yoksa —)
```
"TEST EDİLEMEDİ" ise tek satırda sebebi yazılır (ör. DNS delegasyonu yok).

## Teslim
`npm run lint` + senaryo dosyasının bir kez yeşil koşması: `test.fail` işaretli olanlar dahil hiç beklenmeyen düşüş olmamalı. Uygulama kodu değişmediği için `npm test` gerekmez. Commit: `git add e2e/ozellik/<id>.spec.js docs/manuel-test/<ID>.md tasks/review/<T>.md`.

## İnceleme (başka ajan, 10 dakikanın altında)
1. Senaryo dosyasını oku: mock, `page.route`, sahte veri, gevşek beklenti (ör. yalnız `toBeTruthy`), fiziksel sonuç kontrolünün eksikliği, temizlik eksikliği var mı?
2. Kilitle senaryoyu **kendin bir kez koştur**; sonuç rapordakiyle aynı olmalı.
3. Uygunsa `accept`, değilse `reject`; 1–3 satır not.

## Önceki yöntem
26 Ekim'de elle yapılan testlerin raporları (ör. TLS-01, DB-01, WEB-01) geçerli kalır; o özellikler için senaryo dosyası 2. dalgada eklenir.
