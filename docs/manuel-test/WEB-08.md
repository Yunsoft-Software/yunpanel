# WEB-08 — Önizleme, geçici domain ve site açma bağlantıları
Sonuç: KISMİ
Ajan: AGENT_3 · Tarih: 2026-10-27 15:18 · Senaryo: `e2e/ozellik/web-08.spec.js` · Koşu: 4/4 geçti, 1 bilinen eksiklik (test.fail)

## Senaryolar
| Test adı | Sonuç (geçti/düştü/bilinen hata) | Fiziksel kanıt |
| mutlu yol: site oluştur, liste kartında ve site detayında Siteyi aç linkini doğrula, canlı HTTP 200 al | geçti | Kart ve detayda Siteyi aç (`target="_blank"`, `rel="noopener noreferrer"`), Nginx canlı HTTP 200 yanıtı |
| askıya alınmış site senaryosu: askıdayken vhost pasif yanıtı ve panelde yayını etkinleştir butonu | geçti | Panelde 'Yayını Etkinleştir' butonu, vhost pasife alındı (HTTP 301/503) |
| hatalı girdi ve güvenlik: geçersiz alan adında harici site linki üretilmemesi | geçti | Geçersiz alan adlarında `externalSiteUrl` null döner, script/XSS koruması |
| Plesk eşdeğeri DNS öncesi Site Önizleme (Site Preview / Geçici Domain) bağlantısı kontrolü | bilinen hata (test.fail) | DNS yönlenmeden önce önizleme sağlayan Plesk preview mekanizması UI'da yok |

## Hatalar
| Sınıf | Başlık | Bulgu görevi |
| NORMAL | Plesk Site Preview (DNS öncesi geçici URL ile site önizleme) işlevi ve UI bağlantısı henüz mevcut değil | — |

## Mevcut testler
| Dosya | Sınıf | Not |
| apps/web/test/website-task-cards.test.js | GEÇERLİ | Görev kartı üzerindeki buton ve dış bağlantı testleri |
| apps/web/test/workspace-model.test.js | GEÇERLİ | `externalSiteUrl` güvenlik, scheme ve XSS engelleme testleri |

## Panelde olmayan
- DNS öncesi Site Önizleme (Plesk Site Preview / Geçici Domain URL) düğmesi ve altyapısı panelde henüz yer almıyor.

## Temizlenemeyen kaynaklar
—
