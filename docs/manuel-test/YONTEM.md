# Manuel test yöntemi (1. dalga)

> Senior yazar. Her `Manuel test: <ID>` görevi bu belgeye göre yürür. Kararlar: `docs/orkestra/DECISIONS.md` 2026-10-26.

## Amaç
`docs/plesk-feature-parity.md` içindeki özelliğin **bugün `.28` üzerinde gerçek bir kullanıcı için çalışıp çalışmadığını** ölçmek. Kod okuyup "çalışmalı" demek, API'yi doğrudan çağırmak ya da birim testine bakmak test sayılmaz. Bu dalgada test **kodu yazılmaz** (2. dalganın işi) ve kritik olmayan hata **düzeltilmez**.

## Önce mevcut testler (kilit gerekmez)
Bu özelliğe ait testleri bul: `apps/api/test`, `apps/web/test`, `packages/*/test` ve `e2e/`. Özelliğin rotası, API yolu, servis ve bileşen adıyla `grep -rl` ile ara. Bulduğun her dosyayı oku ve çalıştır:
- Birim/API testleri: `node --test --test-timeout=120000 <dosya>`.
- `e2e/` Playwright: yalnız manuel test sırasında, aldığın `sunucu-28-n` kilidiyle `npx playwright test <dosya>`. Mutasyon yapan dosyalar kendi verisini oluşturur; mevcut veriye dokunuyorsa çalıştırma ve rapora yaz.

Her dosyayı tek bir sınıfa koy:
- **GEÇERLİ:** Gerçek davranışı gerçek bileşenlerle ölçüyor, doğru şeyi doğruluyor ve manuel testte gördüğün davranışla tutarlı.
- **YÜZEYSEL:** Kaynak dosyasını okuyup metin/regex arıyor, yalnız "200 döndü" diyor ya da fiziksel sonucu kontrol etmiyor.
- **MOCK:** Sahte servis, stub HTTP cevabı, hazır sahte veri veya `mock*` nesnesi kullanıyor (agents.md 24 Ekim §1'e aykırı).
- **YANLIŞ:** Yanlış davranışı doğru diye kabul ediyor. Örnek: manuel testte bozuk çıkan bir akış için test yeşil geçiyor.
- **KIRMIZI:** Çalıştırınca düşüyor ya da takılıyor.

Ayrıca hiç testi olmayan senaryoları **EKSİK** olarak listele. Bu dalgada test dosyasını değiştirme. Sonuç 2. dalganın girdisidir: GEÇERLİ olan korunur ve yalnız çalıştırılır; diğerleri düzeltilir ya da eksik olan yazılır.

## Nasıl test edilir
1. **Kilit:** `sunucu-28-1/2/3` kilitlerinden birini al (PROJE.md §İzinli test hedefleri). Sunucu geneli bir ayar değiştireceksen ayrıca `sunucu-28-genel`.
2. **Giriş:** Tarayıcıda panel adresini aç ve `.local/yunpanel-owner-password-only.json` bilgileriyle giriş yap. Hiçbir gizli bilgiyi rapora yazma.
3. **Hazırlık:** Gereken kaynakları panelden kendin oluştur ve önek kullan: `t<id-küçük>-a<n>`. Örnek: AGENT_3 için WEB-01 → `tweb01-a3.webrich.news`, kullanıcı `tweb01-a3-cust`. Kullanıcının mevcut verisine (webrich.news ana içeriği dahil) dokunma.
4. **Senaryolar** (ilgili olanların hepsi):
   - Mutlu yol: özelliği baştan sona bir kullanıcı gibi kullan.
   - Hatalı girdi: boş alan, geçersiz değer, çok uzun değer, var olan isim.
   - Sınır: Türkçe karakter, büyük/küçük harf, çok sayıda kayıt, sayfa yenileme, geri/ileri.
   - Yetki: Owner'ın yanında ilgiliyse Reseller ve Customer hesabıyla da dene; başkasının kaynağını görememeli ve değiştirememeli.
   - Fiziksel sonuç: Ekran "başarılı" demesi yetmez. Gerçek sonucu doğrula: HTTP cevabı (`curl -sk https://<alan>/`), indirilebilen dosya, oluşan DB'ye bağlantı, DNS kaydı (`dig @<ns>`), gelen e-posta. SSH ile sunucuda dosya, servis veya kullanıcı kontrolü yalnız okumak içindir.
   - Geri alma: Silme, askıya alma ve ayar geri dönüşünü dene; kardeş kaynağın etkilenmediğini kontrol et.
5. **Temizlik:** Oluşturduğun her şeyi panelin normal akışıyla sil. Silinmediyse raporda "temizlenemedi" olarak listele.
6. **Kanıt:** Ekran görüntüleri `.local/manuel-test/<ID>/` altına (gitignore'da). Raporda yalnız dosya adını, komut çıktısının özetini ve HTTP kodunu yaz.

## Hata sınıfı
- **KRİTİK:** Testi tamamen engelleyen, veri kaybeden veya bozan, başka kullanıcının/sitenin verisini gösteren veya değiştiren, servisi çökerten ya da paneli açılmaz hale getiren hata.
  - Hemen `python3 orkestra/orchestrator.py finding "KRİTİK <ID>: <kısa başlık>" "<tekrar üretme adımları + beklenen/gerçek + ilgili log>" <ilgili kaynak dosyaları>` çalıştır.
  - Bulgu dosyasına yazarken `bash orkestra/lock.sh acquire bulgular AGENT_n` … `release` kullan.
  - Bu bulgu düzeltme görevi olur ve diğer ajanlar düzeltir. Sen testine devam et.
- **NORMAL:** Diğer her şey (yanlış metin, eksik doğrulama, kötü UX, yavaşlık, kısmen çalışan akış). Bunlar yalnız rapora yazılır.

## Rapor: `docs/manuel-test/<ID>.md`
```markdown
# <ID> — <özellik>
Sonuç: ÇALIŞIYOR | KISMİ | ÇALIŞMIYOR | TEST EDİLEMEDİ
Ajan: AGENT_n · Tarih: YYYY-MM-DD HH:MM · Panel sürümü: <ayarlar/footer'daki sürüm>

## Özet
İki üç cümle: ne çalışıyor, ne çalışmıyor.

## Senaryolar
| # | Senaryo | Rol | Adımlar | Beklenen | Gerçek | Sonuç | Kanıt |
|---|---|---|---|---|---|---|---|

## Hatalar
| Sınıf | Başlık | Tekrar üretme | Bulgu görevi |
|---|---|---|---|
(KRİTİK satırlarda bulgu görevi kimliği, ör. T812; NORMAL satırlarda —)

## Mevcut testler
| Dosya | Ne ölçüyor | Çalıştırma sonucu | Sınıf | Not |
|---|---|---|---|---|
Testi olmayan senaryolar (EKSİK): …

## Panelde olmayan / bulunamayan
Plesk'teki karşılığı olup YunPanel'de hiç bulunamayan alt işlevler (3. dalga için girdi).

## Oluşturulan ve temizlenen kaynaklar
| Kaynak | Temizlendi mi |
|---|---|
```
"TEST EDİLEMEDİ" ise sebebi ve neyin eksik olduğu (ör. DNS delegasyonu yok, dış servis anahtarı yok) yazılır.

## Teslim
Manuel test görevleri yalnız rapor yazar ve kaynak kodu değiştirmez. Bu yüzden teslimde `npm test` gerekmez; `python3 orkestra/tasks.py lint` yeterlidir. Kilidi bırakmadan teslim etme. Bulgu (KRİTİK) düzeltme görevleri ise normal kurala tabidir: PROJE.md §Doğrulama ve gerçek tekrar üretme.

## İnceleme (başka ajan)
İnceleyen ajan raporun eksiksiz olduğunu kontrol eder ve **en az bir senaryoyu** (tercihen sonucu ÇALIŞIYOR olanlardan birini) aynı kilit kurallarıyla tarayıcıda kendisi tekrar eder. Sonuç tutmuyorsa `reject` eder.
