# EML-03 — Otomatik yanıt ve tatil mesajları
Sonuç: ÇALIŞMIYOR
Ajan: AGENT_3 · Tarih: 2026-10-28 11:37 · Senaryo: `e2e/ozellik/eml-03.spec.js` · Koşu: 3/3, test.fail 1

## Senaryolar
| Test adı | Sonuç (geçti/düştü/bilinen hata) | Fiziksel kanıt |
| mutlu yol: Mail arayüzü ve posta kutusu işlemleri doğrulanır; mevcut posta kutusu kontrolleri aktiftir | geçti | Mailbox kota/yönlendirme UI aktif, Dovecot Sieve LMTP aktif, postfix/dovecot aktif |
| hatalı girdi ve sınır durumları: Var olmayan veya tanımlanmamış autoresponder API uç noktası 404 döner | geçti | GET/POST /api/mailboxes/:id/autoresponder 404 Not Found, autoresponder registry yok |
| Plesk Parity kontrolü: E-posta hesabı için Otomatik Yanıtlayıcı formu ve Sieve vacation kuralı | bilinen hata (test.fail) | UI üzerinde Otomatik yanıt/Tatil mesajı butonu, konu, mesaj ve bitiş tarihi alanı yok |

## Hatalar
| Sınıf | Başlık | Bulgu görevi |
| NORMAL | Plesk eşdeğeri Mail Autoresponder (otomatik yanıt/tatil mesajı) arayüzü ve API uç noktası eksik | — |

## Mevcut testler
| Dosya | Sınıf | Not |
| `apps/api/src/non-reseller-capabilities.js` | YÜZEYSEL | EML-03 partial yetenek olarak tanımlı; API route ve UI bileşeni yok |

## Panelde olmayan
- E-posta hesabı bazında Otomatik Yanıtlayıcı (Autoresponder / Out of Office / Vacation) açma/kapatma
- Otomatik yanıt konusu (subject), mesaj gövdesi (body) ve formatı (düz metin/HTML) belirleme
- Başlangıç ve bitiş tarihi (start/end date) tanımlama ve zamanlı otomatik devre dışı bırakma
- Fiziksel Dovecot Sieve `vacation` betiği oluşturma ve teslimat zamanı tetikleme

## Temizlenemeyen kaynaklar
—
