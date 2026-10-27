# WEB-06 — Domain askıya alma, kapatma, etkinleştirme ve güvenli silme
Sonuç: KISMİ
Ajan: AGENT_4 · Tarih: 2026-10-27 10:55 · Senaryo: `e2e/ozellik/web-06.spec.js` · Koşu: 2/3 geçti, 1 bilinen hata (test.fail)

## Senaryolar
| Test adı | Sonuç (geçti/düştü/bilinen hata) | Fiziksel kanıt |
| mutlu yol: site oluştur, yayını doğrula, askıya al, fiziksel kontrol et ve yeniden etkinleştir | geçti | HTTP 200 -> askıya alınınca Nginx vhost pasif -> etkinleştirilince HTTP 200 |
| güvenli silme: siteyi güvenli işlem adımlarıyla sil | bilinen hata (test.fail) | website_cleanup_sftp_unverified nedeniyle silme işlemi blocked durumunda duruyor |
| hatalı girdi: onay metni koruması ve askıdaki sitenin barındırma ayarlarının kilitlenmesi | geçti | Yanlış onay metninde buton kilitli, askıdayken barındırma formu disabled |

## Hatalar
| Sınıf | Başlık | Bulgu görevi |
| NORMAL | Güvenli silmede website_cleanup_sftp_unverified engeli nedeniyle işlem blocked kalıyor | — |

## Mevcut testler
| Dosya | Sınıf | Not |
| apps/web/src/workspace/components/website-detail/WebsiteSuspensionPanel.test.jsx | GEÇERLİ | UI onay diyaloğu ve form durum testleri |
| apps/web/src/workspace/components/website-detail/WebsiteDangerZonePanel.test.jsx | GEÇERLİ | UI silme onay diyaloğu ve form durum testleri |
| apps/web/src/workspace/components/website-detail/DomainHostingPanel.test.jsx | GEÇERLİ | Barındırma ayarları ve durum kontrolleri |

## Panelde olmayan
—

## Temizlenemeyen kaynaklar
- Güvenli silme blocked kaldığı için oluşturulan `tweb06-del-...` test sitesi sunucuda duruyor.
