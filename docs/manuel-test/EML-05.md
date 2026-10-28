# EML-05 — Mailing list ve üyelik yönetimi; OS/eklenti matrisi
Sonuç: ÇALIŞMIYOR
Ajan: AGENT_3 · Tarih: 2026-10-28 11:47 · Senaryo: `e2e/ozellik/eml-05.spec.js` · Koşu: 3/3, test.fail 1

## Senaryolar
| Test adı | Sonuç (geçti/düştü/bilinen hata) | Fiziksel kanıt |
| mutlu yol: Mail arayüzü ve mevcut posta servislerinin çalışırlığı doğrulanır, EML-05 sistem capability durumu incelenir | geçti | Postfix/Dovecot active, EML-05 status=deferred serviceAdapters=Mailman |
| hatalı girdi ve sınır durumları: Olmayan posta listesi API uç noktaları 404 döner, Mailman servisi ve ikilileri host üzerinde mevcut değildir | geçti | GET/POST /api/mailing-lists 404, mailman servisi inactive, ikililer ve dizinler yok |
| Plesk Parity kontrolü: E-posta altında Posta Listeleri (Mailing Lists / Mailman) sekmesi, liste CRUD ve üyelik yönetimi arayüzü | bilinen hata (test.fail) | Plesk eşdeğeri Posta Listeleri sekmesi, liste oluşturma ve üyelik formu yok |

## Hatalar
| Sınıf | Başlık | Bulgu görevi |
| NORMAL | Plesk Mailman / Mailing Lists (Posta listesi) ve üyelik yönetimi arayüzü ve API uç noktası eksik | — |

## Mevcut testler
| Dosya | Sınıf | Not |
| `apps/api/test/par-04-non-reseller-capabilities.test.js` | YÜZEYSEL | EML-05 capability kaydını kontrol eder; uç nokta veya UI testi yok |

## Panelde olmayan
- Alan adı bazında Posta Listeleri (Mailing Lists / Mailman) sekmesi ve yönetimi
- Posta listesi oluşturma (liste adı, yönetici e-posta, parola) ve silme
- Liste aboneleri / üyeleri yönetimi (üye ekleme, çıkarma, liste görünümü)
- GNU Mailman web yönetim arayüzü entegrasyonu ve OS/eklenti matrisi

## Temizlenemeyen kaynaklar
—
