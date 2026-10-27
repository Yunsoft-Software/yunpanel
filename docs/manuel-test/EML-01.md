# EML-01 — Mailbox oluşturma/düzenleme/silme, parola ve kota
Sonuç: ÇALIŞIYOR
Ajan: AGENT_1 · Tarih: 2026-10-27 13:49 · Senaryo: `e2e/ozellik/eml-01.spec.js` · Koşu: 2/2, test.fail 0

## Senaryolar
| Test adı | Sonuç (geçti/düştü/bilinen hata) | Fiziksel kanıt |
| mutlu yol: Mailbox CRUD, kota belirleme, parola güncelleme ve Dovecot fiziksel doğrulama | geçti | `virtual_mailboxes` SQLite, argon2id parola, 256 MiB quota_bytes, tam temizlik |
| hatalı girdi: geçersiz e-posta formatı reddedilir ve hesap oluşturulmaz | geçti | UI hata uyarısı, modal kapanmaz, DB'ye yazılmaz |

## Hatalar
| Sınıf | Başlık | Bulgu görevi |
| — | — | — |

## Mevcut testler
| Dosya | Sınıf | Not |
| `e2e/08-mail-webmail.spec.js` | GEÇERLİ | Temel mail domain ve posta kutusu akışını test ediyor |
| `apps/api/test/mailbox-http.test.js` | GEÇERLİ | Mailbox CRUD API birim/entegrasyon testleri |
| `apps/api/test/mailbox-quota-http.test.js` | GEÇERLİ | Mailbox kota politikası API testleri |

## Panelde olmayan
—

## Temizlenemeyen kaynaklar
—
