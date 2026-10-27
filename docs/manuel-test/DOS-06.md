# DOS-06 — Kopyalama ve taşıma; çakışma/onay davranışı
Sonuç: ÇALIŞIYOR
Ajan: AGENT_2 · Tarih: 2026-10-27 15:35 · Senaryo: `e2e/ozellik/dos-06.spec.js` · Koşu: 2/2, test.fail 0

## Senaryolar
| Test adı | Sonuç (geçti/düştü/bilinen hata) | Fiziksel kanıt |
| mutlu yol: dosya kopyalama ve taşıma, hedef dizine yerleşme ve fiziksel sunucu doğrulaması | geçti | Kopyalanan dosya hem kökte hem hedefte (2 adet), taşınan dosya yalnız hedefte (1 adet) SSH find ile doğrulandı |
| çakışma ve hatalı girdi: geçersiz hedef yolu, kendi içine kopyalama engeli ve taşımada dosya çakışması | geçti | Path traversal (`../../`) ve klasörün kendi içine kopyalanması UI'da engellendi; hedefte aynı dosya varken taşımada 409 çakışma hatasıyla veri korundu |

## Hatalar
| Sınıf | Başlık | Bulgu görevi |
| — | — | — |

## Mevcut testler
| Dosya | Sınıf | Not |
| `e2e/ozellik/dos-03.spec.js` | GEÇERLİ | Dosya/klasör oluşturma, yeniden adlandırma ve silme |
| `e2e/ozellik/dos-05.spec.js` | GEÇERLİ | Dosya indirme ve URL'den içe aktarma; SSRF koruması |
| `e2e/ozellik/dos-07.spec.js` | GEÇERLİ | Arşiv oluşturma/açma ve güvenli overwrite |

## Panelde olmayan
Plesk'te kopyalama ve taşıma sırasında hedefte aynı adlı dosya varsa interaktif "Üzerine yazılsın mı?" (Replace/Skip/Cancel) modalı sorulur. YunPanel'de taşıma çakışmada 409 hatasıyla engellenir, kopyalama doğrudan yazar.

## Temizlenemeyen kaynaklar
—
