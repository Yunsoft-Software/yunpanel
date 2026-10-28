# EML-04 — Spam filtre, allow/deny list ve antivirüs politikası
Sonuç: KISMİ
Ajan: AGENT_4 · Tarih: 2026-10-28 11:43 · Senaryo: `e2e/ozellik/eml-04.spec.js` · Koşu: 3/3, test.fail 1

## Senaryolar
| Test adı | Sonuç (geçti/düştü/bilinen hata) | Fiziksel kanıt |
| mutlu yol: Mail arayüzü ve Rspamd spam filtre motorunun fiziksel aktifliği doğrulanır | geçti | Mail domain ve posta kutusu UI aktif, Rspamd active, Postfix milter 127.0.0.1:11332 bağlı |
| hatalı girdi ve sınır durumları: Tanımlanmamış spam filtresi ve antivirüs API uç noktaları 404 döner | geçti | GET/POST /api/mail/spam-filter ve /antivirus 404, multimap.conf/antivirus.conf yok, ClamAV inactive |
| Plesk Parity kontrolü: E-posta hesabı veya alan adı için Spam Filtresi, Beyaz/Kara Liste ve Antivirüs politikası | bilinen hata (test.fail) | UI üzerinde Spam filtresi anahtarı, duyarlılık puanı, beyaz/kara liste ve antivirüs alanı yok |

## Hatalar
| Sınıf | Başlık | Bulgu görevi |
| NORMAL | Plesk eşdeğeri Spam Filtresi (eşik/aksiyon), Allow/Deny List ve Antivirüs politikası arayüzü/API'si eksik | — |

## Mevcut testler
| Dosya | Sınıf | Not |
| `apps/api/test/panel-settings-service.test.js` | GEÇERLİ | Sistem ayarlarında spam engine Rspamd ve ClamAV health kontrolünü test ediyor |
| `apps/api/test/mail-diagnostics-http.test.js` | GEÇERLİ | ClamAV sağlık durumunu ve servis uyarısını test ediyor |
| `apps/api/src/non-reseller-capabilities.js` | YÜZEYSEL | EML-04 partial yetenek olarak tanımlı; API route ve UI bileşeni yok |

## Panelde olmayan
- E-posta hesabı veya alan adı bazında Spam Filtresi açma/kapatma ve spam puanı/eşiği belirleme
- Spam e-postalar için konu başlığı değiştirme ([SPAM]), karantinaya alma veya silme aksiyonları
- Beyaz liste (Allowlist / Whitelist) ve kara liste (Denylist / Blacklist) e-posta/alan adı listesi yönetimi
- Antivirüs politikası (ClamAV ile gelen/giden e-posta tarama) etkinleştirme arayüzü ve backend bağlayıcısı

## Temizlenemeyen kaynaklar
—
