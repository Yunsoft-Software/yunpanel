# WEB-07 — Domain kartı/liste, arama, filtre ve doğru araç grupları
Sonuç: KISMİ
Ajan: AGENT_3 · Tarih: 2026-11-04 12:10 · Senaryo: `e2e/ozellik/web-07.spec.js` · Koşu: 7/7 (4 bilinen hata test.fail)

## Senaryolar
| Test adı | Sonuç | Fiziksel kanıt |
|---|---|---|
| Mutlu yol: domain kartı, kök/alt ağaç, arama, filtre | GEÇTİ | `https://webrich.news` → HTTP 200 |
| Hatalı girdi & sınır: geçersiz arama, müşteri ID, page=999 | GEÇTİ | Eşleşmeyen aramada .ws-empty ve fail-closed 0 kart |
| Rol senaryosu: Müşteri hesabı, rol izolasyonu ve yetki sınırları | GEÇTİ | Müşteri Owner sitelerini göremiyor (0 webrich kartı) |
| Bilinen hata H1: Tür (proxy) PHP/Node siteleri eşleştirmiyor | BİLİNEN HATA (test.fail) | `/websites?type=proxy` 0 sonuç dönüyor |
| Bilinen hata H2: Durum filtresinde Askıda (suspended) seçeneği yok | BİLİNEN HATA (test.fail) | `option[value="suspended"]` eksik |
| Bilinen hata H3: Customer ekranında Veritabanları kota paydası boş | BİLİNEN HATA (test.fail) | DOM renderında `— / ` boş kalıyor |
| Bilinen hata H4: Statik sitede Uygulama (/node) aracı gösteriliyor | BİLİNEN HATA (test.fail) | webrich.news kartında `/node` butonu açık |

## Hatalar
| Sınıf | Başlık | Bulgu görevi |
|---|---|---|
| NORMAL | H1: Tür (proxy) PHP ve Node siteleri eşleştirmiyor | — |
| NORMAL | H2: Durum filtresinde Askıda (suspended) seçeneği yok | — |
| NORMAL | H3: Customer ekranında Veritabanları kota paydası `— / ` boş | — |
| NORMAL | H4: Statik sitede Uygulama (/node) aracı gösteriliyor | — |

## Mevcut testler
| Dosya | Sınıf | Not |
|---|---|---|
| `e2e/ozellik/web-07.spec.js` | GEÇERLİ | 7 senaryo .28'de 2 kez art arda yeşil |
| `apps/web/test/domain-tree.test.js` | GEÇERLİ | Ağaç, arama ve hiyerarşi modeli |
| `apps/web/test/site-list-model.test.js` | GEÇERLİ | Sayfalama ve filtre modeli |

## Panelde olmayan
- Site kartı çekmecesinde 3 görev ailesi ayrımı, Terminal bağlantısı ve tüketim özeti (`ui-plan.md` §2).

## Temizlenemeyen kaynaklar
- Yok (Test sonrasında `tweb07-a3-*` önekli tüm hesaplar API üzerinden silindi; `0` test hesabı kaldı).
