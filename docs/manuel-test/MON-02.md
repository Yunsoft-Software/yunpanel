# MON-02 — Eşik/teslim alıcısı/bildirim tercihleri ve teslim kanıtı
Sonuç: KISMİ
Ajan: AGENT_2 · Tarih: 2026-10-28 12:40 · Senaryo: `e2e/ozellik/mon-02.spec.js` · Koşu: 4/4 geçti (1 test.fail beklenen)

## Senaryolar
| Test adı | Sonuç (geçti/düştü/bilinen hata) | Fiziksel kanıt |
| --- | --- | --- |
| mutlu yol: Bildirim merkezi çekmecesi ve Tercih/Eşik API yönetimi | geçti | UI çekmece sekmeleri açıldı; PATCH `/api/panel/notifications/preferences` ve POST test bildirimi 200 ile teslim edildi |
| hatalı girdi: Geçersiz minSeverity ve hatalı gövde 400 ile reddi | geçti | Geçersiz minSeverity `invalid_min_severity` (400) ve geçersiz gövde `invalid_preferences_patch` (400) döndü |
| fiziksel kanıt: Teslimat geçmişi ve motor durumu teyidi | geçti | `/api/panel/notifications/deliveries` test_notification teslim kaydı (status: delivered) ve `/status` (active) doğrulandı |
| Plesk eşdeğeri eksikliği: Olay bazlı alıcı şablonları ve eşik UI ekranı | bilinen hata (test.fail) | BULGU MON-02: Olay bazlı alıcı şablonları ve eşik yapılandırma UI ekranı henüz mevcut değil |

## Hatalar
| Sınıf | Başlık | Bulgu görevi |
| --- | --- | --- |
| NORMAL | Plesk Tools & Settings -> Notifications eşdeğeri olay bazlı alıcı şablonları ve eşik yapılandırma UI ekranı eksik | — |

## Mevcut testler
| Dosya | Sınıf | Not |
| --- | --- | --- |
| `apps/api/test/operational-notifications.test.js` | GEÇERLİ | 27 adet birim/entegrasyon testi: eşik alarmları, throttling, alıcı kanalları, HTTP rotaları |
| `apps/web/src/workspace/NotificationCenterDrawer.jsx` | GEÇERLİ | aaPanel tarzı sağ çekmece görev kuyruğu, uyarılar ve bildirimler |

## Panelde olmayan
- Plesk "Tools & Settings -> Notifications" eşdeğeri olay bazlı (SSL, Disk, Yedek vb.) e-posta ve webhook alıcı yapılandırma ekranı
- CPU/RAM/Disk uyarı ve kritik eşik yüzdelerinin arayüzden düzenlenebildiği form

## Temizlenemeyen kaynaklar
—
