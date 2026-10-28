# T185 İnceleme Notu (Review)

- **Tarih:** 2026-10-28
- **İnceleyen:** AGENT_2
- **İncelenen Görev:** T185 · Manuel test: EML-06 — Domain mail aç/kapat, harici mail ve bulunmayan alıcı politikası
- **Yapan:** AGENT_4
- **Karar:** ONAY (ACCEPT)

---

## 1. İncelenen Değişiklikler ve Uyumluluk Denetimi

- `docs/manuel-test/EML-06.md`:
  - Satır sayısı kontrolü: 27 satır (kural: <= 40 satır, `wc -l` ile doğrulandı).
  - Tablo formatı ve durumlar standartlara uygun: 2 mutlu yol (geçti), 1 hatalı girdi/sınır durumu (geçti), 1 Plesk Parity kontrolü (bilinen hata / test.fail).
- `e2e/ozellik/eml-06.spec.js`:
  - **Sıfır mock ilkesi:** `page.route` veya sahte API/veri cevabı kesinlikle kullanılmamıştır.
  - **Fiziksel doğrulama:**
    1. Harici posta sağlayıcısı (`managementMode: 'external'`) ile alan adı oluşturulmuş, UI'da "Harici sağlayıcı" rozeti ve yerel mailbox sekmelerinin kapatıldığı teyit edilmiş, SQLite `virtual_domains` tablosunda kaydın yer almadığı (`count: 0`) SSH ile doğrulanmıştır.
    2. Yerel alan adında posta servisi kapatıldığında (`status: 'disabled'`) durable job sonrası SQLite `virtual_domains` tablosunda `enabled=1` kaydının silindiği (`count: 0`), servis tekrar açıldığında (`status: 'enabled'`) tablonun `enabled=1` (`count: 1`) olarak güncellendiği kanıtlanmıştır.
    3. Harici alan adı için yerel config preview çağrısında 409 `mail_domain_not_locally_managed`, sahte ID ile 404 `mail_domain_not_found` ve UI graceful uyarıları test edilmiştir.
    4. Plesk eşdeğeri alan adı bazında "Mail for non-existent users" politikası (Catch-all / Bounce / Reject) eksikliği `test.fail` ile belgelenmiştir.
  - **Temizlik (afterAll):**
    - Harici mail domain kaydı registry'den silinmiş, API servisi yeniden senkronize edilmiş ve yerel alan adı `virtual_domains` üzerinde `enabled=1` durumuna geri getirilmiştir.
    - Fiziksel incelemede test sonrasında sunucuda `external_count: 0` ve `virtual_domains: yp-form.webrich.news|1` olarak 0 artık teyit edilmiştir.

---

## 2. Bağımsız Test Koşusu (Reviewer Koşusu)

- Test bağımsız olarak gerçek `.28` test sunucusunda çalıştırıldı:
  `AGENT_N=2 npx playwright test e2e/ozellik/eml-06.spec.js --reporter=line`
  - Sonuç: **4 passed (55.3s)** (1 beklenen hata / test.fail, 3 başarılı gerçek akış).

---

## 3. Kalite Kapıları

- `npm run lint`: Repository policy validation passed.
- Satır sayısı: `docs/manuel-test/EML-06.md` (27 satır <= 40).
- Fiziksel artık kaynak kontrolü: 0 artık, `external_count: 0`.

---

## 4. Karar Özeti

T185 görevi kapsamındaki EML-06 manuel test senaryosu ve raporu, projenin sıfır mock, fiziksel SSH doğrulaması, satır sayısı limitleri ve kaynak temizliği kurallarına eksiksiz uymaktadır. Görev ONAYLANMIŞTIR (`accept`).
