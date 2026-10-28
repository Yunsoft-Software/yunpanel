# T183 İnceleme Notu (Review)

- **Tarih:** 2026-10-28
- **İnceleyen:** AGENT_1
- **İncelenen Görev:** T183 · Manuel test: EML-04 — Spam filtre, allow/deny list ve antivirüs politikası
- **Yapan:** AGENT_4
- **Karar:** ONAY (ACCEPT)

---

## 1. İncelenen Değişiklikler ve Uyumluluk Denetimi

- `docs/manuel-test/EML-04.md`:
  - Satır sayısı kontrolü: 28 satır (kural: <= 40 satır).
  - Tablo formatı ve durumlar standartlara uygun: 1 mutlu yol (geçti), 1 hatalı girdi/sınır durumu (geçti), 1 Plesk Parity kontrolü (bilinen hata / test.fail).
- `e2e/ozellik/eml-04.spec.js`:
  - **Sıfır mock ilkesi:** `page.route` veya sahte API/veri cevabı kesinlikle kullanılmamıştır.
  - **Fiziksel doğrulama:**
    1. Sunucuda Rspamd servisinin aktifliği (`systemctl is-active rspamd`), Postfix smtpd_milters yapılandırmasında Rspamd soketinin aktifliği (`postconf -h smtpd_milters` -> `127.0.0.1:11332`) ve worker proxy'nin milter modunda çalışması (`cat /etc/rspamd/local.d/worker-proxy.inc` -> `milter = yes`, `self_scan = yes`) SSH üzerinden fiziksel olarak doğrulandı.
    2. Tanımlanmamış `/api/mail/spam-filter` ve `/api/mail/antivirus` uç noktalarına GET/POST isteklerinde 404 yanıtı doğrulandı.
    3. Sunucuda allow/deny list (`multimap.conf`) ve antivirüs (`antivirus.conf`) yapılandırmalarının bulunmadığı, ClamAV servisinin (`clamav-daemon`) sistemde varsayılan olarak `inactive` olduğu fiziksel kanıtlarla doğrulandı.
    4. Plesk eşdeğeri SpamFilter (duyarlılık eşiği, konu etiketleme, silme/karantina), allow/deny list (beyaz/kara liste) ve Antivirüs (ClamAV) gelen/giden tarama arayüzü ve API uç noktası eksikliği `test.fail` ile belgelendi.
  - **Temizlik (afterAll):**
    - SQLite (`virtual_mailboxes`) ve JSON registry (`mailbox-registry.json`) üzerinde test ön eki (`teml04-...`) hedeflenerek 0 artık ilkesiyle temizlendi.

---

## 2. Bağımsız Test Koşusu (Reviewer Koşusu)

- Eşzamanlı test kilidi alındı: `python3 orkestra/locks.py acquire sunucu-28-1 AGENT_1`
- Test bağımsız olarak gerçek `.28` test sunucusunda çalıştırıldı:
  `AGENT_N=1 npx playwright test e2e/ozellik/eml-04.spec.js`
  - Sonuç: **3 passed (28.5s)** (1 beklenen hata / test.fail, 2 başarılı gerçek akış).
- Kilit serbest bırakıldı: `python3 orkestra/locks.py release sunucu-28-1 AGENT_1`

---

## 3. Kalite Kapıları

- `python3 orkestra/tasks.py lint`: 143 tasks, lint OK.
- `python3 orkestra/orchestrator.py verify --quick`: `doğrulama: ok; yeniden açılan: -; bulgu: -`

---

## 4. Karar Özeti

T183 görevi kapsamındaki EML-04 manuel test senaryosu ve raporu, projenin sıfır mock, fiziksel doğrulama, satır sayısı ve kaynak temizliği kurallarına eksiksiz uymaktadır. Görev ONAYLANMIŞTIR (`accept`).
