import { useCallback, useEffect, useState } from 'react';
import { Badge, Button, ErrorNotice, Section } from './PanelKit.jsx';
import {
  deleteAiProvider,
  getAiPolicy,
  getAiProviders,
  saveAiProvider,
  setActiveAiProvider,
  testAiProvider,
} from './ai-client.js';

export default function AiSettingsPanel() {
  const [providers, setProviders] = useState([]);
  const [policy, setPolicy] = useState(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState(null);
  const [success, setSuccess] = useState(null);

  // New provider form
  const [showAddForm, setShowAddForm] = useState(false);
  const [formId, setFormId] = useState('');
  const [formType, setFormType] = useState('anthropic');
  const [formKey, setFormKey] = useState('');
  const [formBaseUrl, setFormBaseUrl] = useState('');
  const [formModel, setFormModel] = useState('');
  const [formActive, setFormActive] = useState(true);
  const [saving, setSaving] = useState(false);
  const [testingId, setTestingId] = useState(null);
  const [testResult, setTestResult] = useState(null);

  const loadData = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const [provRes, polRes] = await Promise.all([
        getAiProviders().catch(() => []),
        getAiPolicy().catch(() => null),
      ]);
      setProviders(Array.isArray(provRes) ? provRes : (provRes?.data || []));
      setPolicy(polRes?.policy ?? (polRes?.data ?? polRes) ?? null);
    } catch (err) {
      setError(err.message || 'AI ayarları yüklenemedi');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    loadData();
  }, [loadData]);

  const handleSave = async (e) => {
    e.preventDefault();
    if (!formId.trim() || (!formKey.trim() && formType !== 'ollama')) {
      setError('Sağlayıcı kimliği ve API anahtarı gereklidir.');
      return;
    }

    setSaving(true);
    setError(null);
    setSuccess(null);
    try {
      await saveAiProvider({
        id: formId.trim(),
        type: formType,
        apiKey: formKey.trim() || undefined,
        baseUrl: formBaseUrl.trim() || undefined,
        defaultModel: formModel.trim() || undefined,
        makeActive: formActive,
      });
      setSuccess(`AI sağlayıcısı "${formId}" başarıyla kaydedildi.`);
      setShowAddForm(false);
      setFormId('');
      setFormKey('');
      setFormBaseUrl('');
      setFormModel('');
      await loadData();
    } catch (err) {
      setError(err.message || 'Sağlayıcı kaydedilemedi');
    } finally {
      setSaving(false);
    }
  };

  const handleSetActive = async (id) => {
    setError(null);
    try {
      await setActiveAiProvider(id);
      setSuccess(`"${id}" aktif sağlayıcı yapıldı.`);
      await loadData();
    } catch (err) {
      setError(err.message || 'Aktif sağlayıcı değiştirilemedi');
    }
  };

  const handleDelete = async (id) => {
    if (!window.confirm(`"${id}" sağlayıcısını silmek istediğinize emin misiniz?`)) return;
    setError(null);
    try {
      await deleteAiProvider(id);
      setSuccess(`"${id}" silindi.`);
      await loadData();
    } catch (err) {
      setError(err.message || 'Sağlayıcı silinemedi');
    }
  };

  const handleTest = async (id) => {
    setTestingId(id);
    setTestResult(null);
    setError(null);
    try {
      const res = await testAiProvider(id);
      if (res?.data?.success || res?.success) {
        setTestResult({ id, ok: true, message: 'Bağlantı başarılı! Sağlayıcı yanıt verdi.' });
      } else {
        setTestResult({ id, ok: false, message: 'Bağlantı testi başarısız oldu.' });
      }
    } catch (err) {
      setTestResult({ id, ok: false, message: err.message || 'Bağlantı hatası' });
    } finally {
      setTestingId(null);
    }
  };

  return (
    <Section title="AI Asistanı ve Model Sağlayıcıları" description="Sunucu ve site işlemlerini yönetmek için Anthropic Claude, OpenAI, Google Gemini veya yerel Ollama modellerini bağlayın.">
      <div className="ws-section-body" style={{ display: 'flex', flexDirection: 'column', gap: '16px' }}>
        {error && <ErrorNotice error={error} />}
        {success && (
          <div role="status" className="ws-notice ws-notice-good">
            <span>{success}</span>
          </div>
        )}

        {/* Provider List */}
        <div>
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '12px' }}>
            <h3 style={{ margin: 0, fontSize: '15px' }}>Yapılandırılmış AI Sağlayıcıları</h3>
            {!showAddForm && (
              <Button variant="primary" icon="plus" onClick={() => setShowAddForm(true)}>
                Yeni Sağlayıcı Ekle
              </Button>
            )}
          </div>

          {loading && <p className="ws-muted">Sağlayıcılar kontrol ediliyor…</p>}
          {!loading && providers.length === 0 && (
            <p className="ws-muted">Henüz yapılandırılmış AI sağlayıcısı bulunmuyor. Asistanı kullanabilmek için lütfen bir sağlayıcı ekleyin.</p>
          )}

          {providers.length > 0 && (
            <div style={{ display: 'flex', flexDirection: 'column', gap: '10px' }}>
              {providers.map((prov) => (
                <div
                  key={prov.id}
                  style={{
                    display: 'flex',
                    justifyContent: 'space-between',
                    alignItems: 'center',
                    padding: '12px 14px',
                    border: '1px solid var(--border-color, #e5e7eb)',
                    borderRadius: '8px',
                    background: prov.active ? 'var(--bg-highlight, #f0fdf4)' : 'var(--bg-card, #ffffff)',
                  }}
                >
                  <div>
                    <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
                      <strong>{prov.id}</strong>
                      <Badge state={prov.active ? 'active' : 'neutral'}>
                        {prov.active ? 'Aktif Sağlayıcı' : prov.type}
                      </Badge>
                      <span style={{ fontSize: '12px', color: 'var(--text-muted, #6b7280)' }}>
                        Model: {prov.defaultModel || 'varsayılan'}
                      </span>
                    </div>
                    <div style={{ fontSize: '12px', color: 'var(--text-muted, #6b7280)', marginTop: '4px' }}>
                      {prov.hasApiKey ? `Anahtar: ${prov.maskedApiKey}` : 'API Anahtarı yok (Yerel)'}
                      {prov.baseUrl && ` · URL: ${prov.baseUrl}`}
                    </div>
                    {testResult && testResult.id === prov.id && (
                      <div style={{ fontSize: '12px', marginTop: '4px', color: testResult.ok ? '#059669' : '#dc2626' }}>
                        {testResult.ok ? '✓ ' : '✕ '} {testResult.message}
                      </div>
                    )}
                  </div>

                  <div style={{ display: 'flex', gap: '6px', alignItems: 'center' }}>
                    <Button
                      variant="secondary"
                      disabled={testingId === prov.id}
                      onClick={() => handleTest(prov.id)}
                    >
                      {testingId === prov.id ? 'Test ediliyor…' : 'Test Et'}
                    </Button>
                    {!prov.active && (
                      <Button variant="secondary" onClick={() => handleSetActive(prov.id)}>
                        Aktif Yap
                      </Button>
                    )}
                    <Button variant="danger" onClick={() => handleDelete(prov.id)}>
                      Sil
                    </Button>
                  </div>
                </div>
              ))}
            </div>
          )}
        </div>

        {/* Add Provider Form */}
        {showAddForm && (
          <form
            onSubmit={handleSave}
            style={{
              padding: '16px',
              border: '1px solid var(--border-color, #d1d5db)',
              borderRadius: '8px',
              background: 'var(--bg-secondary, #f9fafb)',
              display: 'flex',
              flexDirection: 'column',
              gap: '12px',
            }}
          >
            <h4 style={{ margin: 0 }}>Yeni AI Sağlayıcısı Yapılandır</h4>

            <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '12px' }}>
              <label>
                Sağlayıcı Kimliği (ID):
                <input
                  type="text"
                  required
                  placeholder="örn: anthropic-main, openai-gpt4"
                  value={formId}
                  onChange={(e) => setFormId(e.target.value)}
                  style={{ width: '100%', padding: '8px', marginTop: '4px' }}
                />
              </label>

              <label>
                Sağlayıcı Türü:
                <select
                  value={formType}
                  onChange={(e) => setFormType(e.target.value)}
                  style={{ width: '100%', padding: '8px', marginTop: '4px' }}
                >
                  <option value="openrouter">OpenRouter (GLM 5.2, Claude, Llama vb.)</option>
                  <option value="anthropic">Anthropic (Claude 3.7 Sonnet)</option>
                  <option value="openai">OpenAI (GPT-4o, GPT-4o-mini)</option>
                  <option value="gemini">Google Gemini (Gemini 2.0 Flash)</option>
                  <option value="ollama">Ollama (Yerel / HTTP)</option>
                </select>
              </label>
            </div>

            <label>
              API Anahtarı {formType === 'ollama' ? '(Ollama için isteğe bağlı)' : '(Zorunlu)'}:
              <input
                type="password"
                required={formType !== 'ollama'}
                placeholder={formType === 'openrouter' ? 'sk-or-v1-...' : formType === 'anthropic' ? 'sk-ant-...' : formType === 'openai' ? 'sk-...' : 'AI API Key'}
                value={formKey}
                onChange={(e) => setFormKey(e.target.value)}
                style={{ width: '100%', padding: '8px', marginTop: '4px' }}
              />
            </label>

            <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '12px' }}>
              <label>
                Özel Base URL (İsteğe bağlı):
                <input
                  type="url"
                  placeholder={formType === 'openrouter' ? 'https://openrouter.ai/api/v1' : formType === 'ollama' ? 'http://127.0.0.1:11434' : 'Varsayılan endpoint kullanılır'}
                  value={formBaseUrl}
                  onChange={(e) => setFormBaseUrl(e.target.value)}
                  style={{ width: '100%', padding: '8px', marginTop: '4px' }}
                />
              </label>

              <label>
                Varsayılan Model (İsteğe bağlı):
                <input
                  type="text"
                  placeholder={formType === 'openrouter' ? 'z-ai/glm-5.2' : formType === 'anthropic' ? 'claude-3-7-sonnet-20250219' : formType === 'openai' ? 'gpt-4o' : formType === 'gemini' ? 'gemini-2.0-flash' : 'llama3.2'}
                  value={formModel}
                  onChange={(e) => setFormModel(e.target.value)}
                  style={{ width: '100%', padding: '8px', marginTop: '4px' }}
                />
              </label>
            </div>

            <label style={{ display: 'flex', alignItems: 'center', gap: '8px', marginTop: '4px' }}>
              <input
                type="checkbox"
                checked={formActive}
                onChange={(e) => setFormActive(e.target.checked)}
              />
              Bu sağlayıcıyı hemen aktif model olarak seç
            </label>

            <div style={{ display: 'flex', gap: '8px', marginTop: '8px' }}>
              <Button variant="primary" type="submit" disabled={saving}>
                {saving ? 'Kaydediliyor…' : 'Sağlayıcıyı Kaydet'}
              </Button>
              <Button variant="secondary" onClick={() => setShowAddForm(false)}>
                Vazgeç
              </Button>
            </div>
          </form>
        )}

        {/* Global Security Policy Info */}
        <div style={{ padding: '12px 14px', background: 'var(--bg-secondary, #f3f4f6)', borderRadius: '8px', fontSize: '13px' }}>
          <strong>🛡️ Güvenlik Sınırı ve İzolasyon Sözleşmesi:</strong>
          <p style={{ margin: '4px 0 0 0', color: 'var(--text-muted, #6b7280)' }}>
            AI Asistanı sunucuda ham terminal komutları veya kabuk scriptleri çalıştırmaz. Bütün eylemler şema kontrollü dahili adapterlar üzerinden yürütülür. Okuma işlemleri otomatik tamamlanırken, yeniden başlatma, dağıtım ve yedekleme gibi eylemler Onay Kartı üzerinden sizin açık onayınızla yürütülür.
          </p>
        </div>
      </div>
    </Section>
  );
}
