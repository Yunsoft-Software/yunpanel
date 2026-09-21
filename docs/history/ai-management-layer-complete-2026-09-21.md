# AI Yönetim Katmanı (P1) Tamamlama ve Canlı Test Sunucusu Doğrulaması

Bu belge 2026-09-21 tarihinde YunPanel AI Yönetim Katmanı'nın (P1.1 - P1.4) uygulanmasını, yerel ve canlı test sunucusu (`157.180.11.28`) üzerindeki paketleme/yükleme ve doğrulama süreçlerini belgeler.

## 1. Mimari ve Güvenlik Sınırları

- **Yetki ve Güvenlik**: AI için ayrı bir arka kapı, raw shell veya ikinci bir root transport açılmamıştır. Bütün AI tool'ları mevcut bounded controller, durable job registry ve transaction altyapısına bağlanmıştır.
- **Provider Registry**: AI sağlayıcı anahtarları (`anthropic`, `openai`, `gemini`, `ollama`) `YUNPANEL_SECRET_MASTER_KEY` kullanılarak AES-256-GCM ile şifreli olarak `/var/lib/yunpanel/control-plane/ai-providers.json` dosyasında saklanır (0600 dosya modu). API yanıtlarında ve loglarda anahtarlar maskelenir.
- **Tool Kataloğu ve İzolasyon**: 20 adet katı şemalı operasyon tanımlanmıştır. Okuma (`read`) operasyonları güvenli otomatik yürütülürken, yazma ve yıkıcı (`destructive`) mutasyonlar SHA-256 digest-bound eylem önerisi kartı (`Action Proposal Card`) üreterek kullanıcı onayı gerektirir.
- **Agentic Döngü ve Streaming**: Çok turlu sohbet servisi (`AiConversationService`), sunucu ve web sitesi bağlamını modele iletir, tool çağrılarını ayrıştırır ve SSE üzerinden anlık token akışı sunar.

## 2. Yapılan Değişiklikler

### Backend
- `apps/api/src/ai-provider-registry.js`: AES-256-GCM şifreli sağlayıcı deposu, atomik dosya yazımı, aktif sağlayıcı seçimi.
- `apps/api/src/ai-provider-adapters.js`: Anthropic, OpenAI, Gemini ve Ollama için adaptörler.
- `apps/api/src/ai-tool-runtime.js`: `application.deploy`, `application.rollback`, `logs.query` (en fazla 200 satır), `dns.update`, `certificate.issue`, `certificate.renew`, `backup.inspect`, `backup.create`, `backup.restore` tool binding'leri.
- `apps/api/src/ai-conversation-service.js`: Çok turlu sohbet, bağlam oluşturucu, write/destructive operasyonlar için proposal durdurma ve SSE akışı.
- `apps/api/src/ai-http.js`: `/api/ai/providers`, `/api/ai/conversations`, `/api/ai/tools`, `/api/ai/policy` HTTP uç noktaları.
- `apps/api/src/dns-provider-credential-registry.js`: Bölge silindiğinde yetim kalan kimlik bilgilerinin başlangıçta budanması ve API'nin çökmesinin engellenmesi düzeltmesi.

### Frontend
- `apps/web/src/workspace/ai-client.js`: Sağlayıcı, politika, sohbet ve tool yürütme API istemcisi (`panelRequest` tabanlı).
- `apps/web/src/workspace/AiDrawer.jsx`: Sağdan açılan AI asistan çekmecesi; sohbet geçmişi, anlık mesajlaşma, eylem öneri kartları ve hızlı işlem çipleri.
- `apps/web/src/workspace/AiSettingsPanel.jsx`: `/settings` altında AI sağlayıcı yönetimi, aktif model seçimi ve güvenlik politikası görünümü.
- `apps/web/src/workspace/OperationsPages.jsx`: Ayarlar sayfasına AI yönetim panelinin entegrasyonu.
- `apps/web/src/workspace/WorkspaceLayout.jsx`: Üst araç çubuğuna "AI Asistan" butonu ve `Ctrl+Shift+A` klavye kısayolu.
- `apps/web/server.js`: `/api/ai/` rotalarının reverse proxy ile `yunpanel-api`'ye güvenli aktarımı.

## 3. Doğrulama ve Canlı Test Kanıtları

- **Yerel Testler**:
  - `apps/api/test/ai*.test.js`: 49 adet AI birim ve entegrasyon testi eksiksiz geçti.
  - `apps/api/test/dns-provider-credential-registry.test.js`: 3 test geçti.
  - `@yunpanel/web build`: Vite derlemesi başarıyla tamamlandı.
- **Canlı Test Sunucusu (`157.180.11.28`)**:
  - Debian paketi `yunpanel_0.3.0-2026092103_amd64.deb` derlendi ve `dpkg -i` ile başarıyla kuruldu.
  - `yunpanel-api` ve `yunpanel-web` systemd servisleri aktif ve sağlıklı çalıştı.
  - Canlı Nginx HTTPS üzerinden testler çalıştırıldı:
    - Kimlik doğrulama (`yunsoft-owner`) ve CSRF token alımı: Başarılı.
    - `GET /api/ai/tools`: 20 tool eksiksiz listelendi.
    - `POST /api/ai/providers`: Ollama sağlayıcısı başarıyla kaydedildi.
    - `GET /api/ai/policy`: Versiyon 1 politika başarıyla getirildi.
    - `POST /api/ai/conversations`: Çok turlu oturum açıldı, listelendi ve silindi.
