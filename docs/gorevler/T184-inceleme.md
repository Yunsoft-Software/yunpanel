# T184 İnceleme Notu (Review)

- **Tarih:** 2026-10-28
- **İnceleyen:** AGENT_1
- **İncelenen Görev:** T184 · Manuel test: EML-05 — Mailing list ve üyelik yönetimi; OS/eklenti matrisi
- **Yapan:** AGENT_3
- **Karar:** ONAY (ACCEPT)

---

## 1. İncelenen Değişiklikler ve Uyumluluk Denetimi

- `docs/manuel-test/EML-05.md`:
  - Satır sayısı kontrolü: 26 satır (kural: <= 40 satır).
  - Tablo formatı ve durumlar standartlara uygun: 1 mutlu yol (geçti), 1 hatalı girdi/sınır durumu (geçti), 1 Plesk Parity kontrolü (bilinen hata / test.fail).
- `e2e/ozellik/eml-05.spec.js`:
  - **Sıfır mock ilkesi:** `page.route` veya sahte API/veri cevabı kesinlikle kullanılmamıştır.
  - **Fiziksel doğrulama:**
    1. Mail arayüzü ve posta kutuları/webmail/takma adlar sekmeleri kontrol edildi; Postfix ve Dovecot servislerinin ana makinede aktif çalıştığı (`systemctl is-active postfix dovecot`), `EML-05` capability kaydının `deferred` durumunda ve `Mailman` motoru olarak tanımlı olduğu SSH komutlarıyla fiziksel olarak doğrulandı.
    2. Tanımlanmamış `/api/mail-domains/:id/mailing-lists` ve `/api/mailing-lists` uç noktalarına GET, POST ve DELETE çağrılarında 404 yanıtı doğrulandı.
    3. Sunucuda Mailman sistem servislerinin (`mailman`, `mailman3`) `inactive` olduğu, `mailman` ve `list_members` ikililerinin kurulu olmadığı ve `/var/lib/mailman*` dizinlerinin bulunmadığı fiziksel SSH kanıtlarıyla doğrulandı.
    4. Plesk eşdeğeri Mailman / Posta Listeleri (Mailing Lists) sekmesi, liste oluşturma/silme ve üye yönetimi arayüzü ve API desteği eksikliği `test.fail` ile belgelendi.
  - **Temizlik (afterAll):**
    - Olası test artıklarını önlemek için SQLite (`virtual_mailboxes`) ve JSON registry (`mailbox-registry.json`) üzerinde test ön eki (`teml05-...`) hedeflenerek 0 artık ilkesiyle temizlendi.

---

## 2. Bağımsız Test Koşusu (Reviewer Koşusu)

- Eşzamanlı test kilidi alındı: `python3 orkestra/locks.py acquire sunucu-28-1 AGENT_1`
- Test bağımsız olarak gerçek `.28` test sunucusunda çalıştırıldı:
  `AGENT_N=1 npx playwright test e2e/ozellik/eml-05.spec.js --output test-results/a1 --reporter=line`
  - Sonuç: **3 passed (25.6s)** (1 beklenen hata / test.fail, 2 başarılı gerçek akış).
- Kilit serbest bırakıldı: `python3 orkestra/locks.py release sunucu-28-1 AGENT_1`

---

## 3. Kalite Kapıları

- `python3 orkestra/tasks.py lint`: lint OK.
- `python3 orkestra/orchestrator.py verify --quick`: `doğrulama: ok; yeniden açılan: -; bulgu: -`

---

## 4. Karar Özeti

T184 görevi kapsamındaki EML-05 manuel test senaryosu ve raporu, projenin sıfır mock, fiziksel SSH doğrulaması, satır sayısı limitleri ve kaynak temizliği kurallarına eksiksiz uymaktadır. Görev ONAYLANMIŞTIR (`accept`).
