# DEV-03 — Deploy anahtarı/webhook/ek komut ve işlem sonucu
Sonuç: KISMİ
Ajan: AGENT_1 · Tarih: 2026-10-27 16:01 · Senaryo: `e2e/ozellik/dev-03.spec.js` · Koşu: 5/5, test.fail 3

## Senaryolar
| Test adı | Sonuç (geçti/düştü/bilinen hata) | Fiziksel kanıt |
| --- | --- | --- |
| mutlu yol: Git tabanlı site oluştur, Git ve yayın sekmesinde Webhook/Deploy bileşenlerini incele, deploy tetikle ve fiziksel sonucu doğrula | geçti | HTTP 200/502, SSH ile Nginx sites-enabled konfigürasyonu ve release dizini |
| hatalı girdi / güvenlik: GitHub Webhook endpointine geçersiz veya imzasız istek atıldığında backend 400 ile reddeder | geçti | HTTP 400 Bad Request, github_webhook_headers_invalid cevabı |
| eksiklik: Plesk Git eşdeğeri SSH Deploy Anahtarı (SSH Public Key) üretimi ve kopyalama arayüzü bulunmuyor | bilinen hata | test.fail: Arayüzde SSH Deploy key üretim/kopyalama alanı yok |
| eksiklik: Dağıtım sonrası ek işlemler ve komutlar (Post-deployment build/install script) tanımlama arayüzü bulunmuyor | bilinen hata | test.fail: Deploy sekmesinde post-deploy komut tanımlama alanı yok |
| eksiklik / hata: Arayüzdeki Webhook URL uygulama kimliğini içermemekte ve Webhook Secret arayüzde sunulmamaktadır | bilinen hata | test.fail: Webhook URL /api/webhooks/github UUID içermiyor, secret yok |

## Hatalar
| Sınıf | Başlık | Bulgu görevi |
| --- | --- | --- |
| NORMAL | Webhook URL'inde Application ID parametresi eksik ve Secret yapılandırması sunulmuyor | — |
| NORMAL | SSH Deploy Anahtarı üretimi ve depoya ekleme talimatı arayüzde bulunmuyor | — |
| NORMAL | Dağıtım sonrası ek işlemler/komutlar (Post-deployment scripts) alanı bulunmuyor | — |

## Mevcut testler
| Dosya | Sınıf | Not |
| --- | --- | --- |
| `apps/api/test/github-webhook-http.test.js` | GEÇERLİ | GitHub webhook imza, gövde boyutu ve event filtreleme testleri |
| `apps/web/test/scenarios-websites-nginx-jamstack.test.js` | GEÇERLİ | Webhook endpoint hesaplama ve CI/CD özet senaryoları |

## Panelde olmayan
Plesk Git uzantısındaki SSH Deploy Key oluşturma/kopyalama, Dağıtım Sonrası Ek Komutlar (Additional deployment actions) ve Webhook URL'inde uygulama UUID/Secret yönetimi bulunmamaktadır.

## Temizlenemeyen kaynaklar
—
