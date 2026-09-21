import { useCallback, useEffect, useRef, useState } from 'react';
import { useLocation } from 'react-router';
import { Badge, Button, ErrorNotice, Icon, Modal } from './PanelKit.jsx';
import {
  createAiConversation,
  deleteAiConversation,
  executeAiTool,
  getAiConversation,
  listAiConversations,
  sendAiMessage,
} from './ai-client.js';

export default function AiDrawer({ open, onClose }) {
  const location = useLocation();
  const [conversations, setConversations] = useState([]);
  const [activeConvId, setActiveConvId] = useState(null);
  const [activeConversation, setActiveConversation] = useState(null);
  const [loading, setLoading] = useState(false);
  const [sending, setSending] = useState(false);
  const [inputVal, setInputVal] = useState('');
  const [error, setError] = useState(null);
  const messagesEndRef = useRef(null);

  // Detect active websiteId from URL e.g. /websites/:websiteId/...
  const websiteMatch = location.pathname.match(/\/websites\/([^/]+)/);
  const currentWebsiteId = websiteMatch && websiteMatch[1] !== 'new' ? websiteMatch[1] : null;

  const loadConversations = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const res = await listAiConversations(currentWebsiteId);
      const items = res?.data || [];
      setConversations(items);
      if (items.length > 0 && !activeConvId) {
        setActiveConvId(items[0].id);
      }
    } catch (err) {
      setError(err.message || 'Sohbetler yüklenemedi');
    } finally {
      setLoading(false);
    }
  }, [currentWebsiteId, activeConvId]);

  const loadActiveConversation = useCallback(async (id) => {
    if (!id) return;
    try {
      const res = await getAiConversation(id);
      setActiveConversation(res?.data || null);
    } catch (err) {
      setError(err.message || 'Sohbet detayları yüklenemedi');
    }
  }, []);

  useEffect(() => {
    if (open) {
      loadConversations();
    }
  }, [open, loadConversations]);

  useEffect(() => {
    if (activeConvId) {
      loadActiveConversation(activeConvId);
    } else {
      setActiveConversation(null);
    }
  }, [activeConvId, loadActiveConversation]);

  useEffect(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [activeConversation?.messages, sending]);

  const handleNewChat = async () => {
    setError(null);
    try {
      const res = await createAiConversation({
        title: 'Yeni Sohbet',
        websiteId: currentWebsiteId,
      });
      const created = res?.data;
      if (created) {
        setConversations((prev) => [created, ...prev]);
        setActiveConvId(created.id);
      }
    } catch (err) {
      setError(err.message || 'Yeni sohbet oluşturulamadı');
    }
  };

  const handleDeleteChat = async (id, e) => {
    e.stopPropagation();
    try {
      await deleteAiConversation(id);
      setConversations((prev) => prev.filter((c) => c.id !== id));
      if (activeConvId === id) {
        const remaining = conversations.filter((c) => c.id !== id);
        setActiveConvId(remaining[0]?.id || null);
      }
    } catch (err) {
      setError(err.message || 'Sohbet silinemedi');
    }
  };

  const handleSend = async (textToSend) => {
    const query = (textToSend || inputVal).trim();
    if (!query || sending) return;

    setInputVal('');
    setError(null);
    setSending(true);

    let targetConvId = activeConvId;
    if (!targetConvId) {
      try {
        const res = await createAiConversation({
          title: query.slice(0, 30),
          websiteId: currentWebsiteId,
        });
        targetConvId = res?.data?.id;
        setActiveConvId(targetConvId);
        setConversations((prev) => [res.data, ...prev]);
      } catch (err) {
        setError(err.message || 'Sohbet başlatılamadı');
        setSending(false);
        return;
      }
    }

    try {
      const res = await sendAiMessage({ conversationId: targetConvId, text: query });
      if (res?.data) {
        await loadActiveConversation(targetConvId);
      }
    } catch (err) {
      setError(err.message || 'İstek işlenirken hata oluştu');
    } finally {
      setSending(false);
    }
  };

  if (!open) return null;

  return (
    <Modal title="YunPanel AI Yönetim Asistanı" onClose={onClose} wide>
      <div className="ws-ai-layout" style={{ display: 'grid', gridTemplateColumns: '240px 1fr', gap: '16px', minHeight: '520px' }}>
        {/* Sidebar: Conversation history */}
        <aside style={{ borderRight: '1px solid var(--border-color, #e5e7eb)', paddingRight: '12px', display: 'flex', flexDirection: 'column', gap: '8px' }}>
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
            <span style={{ fontSize: '13px', fontWeight: 600, color: 'var(--text-muted, #6b7280)' }}>SOHBETLER</span>
            <Button variant="primary" icon="plus" style={{ padding: '4px 8px', fontSize: '12px' }} onClick={handleNewChat}>
              Yeni
            </Button>
          </div>

          {currentWebsiteId && (
            <div style={{ fontSize: '12px', padding: '6px 8px', background: 'var(--bg-secondary, #f3f4f6)', borderRadius: '6px' }}>
              📍 Site bağlamı aktif
            </div>
          )}

          <div style={{ flex: 1, overflowY: 'auto', display: 'flex', flexDirection: 'column', gap: '4px' }}>
            {loading && <p style={{ fontSize: '12px', color: 'var(--text-muted, #6b7280)' }}>Yükleniyor…</p>}
            {!loading && conversations.length === 0 && (
              <p style={{ fontSize: '12px', color: 'var(--text-muted, #6b7280)' }}>Kayıtlı sohbet bulunamadı.</p>
            )}
            {conversations.map((conv) => (
              <div
                key={conv.id}
                onClick={() => setActiveConvId(conv.id)}
                style={{
                  padding: '8px 10px',
                  borderRadius: '6px',
                  cursor: 'pointer',
                  fontSize: '13px',
                  display: 'flex',
                  justifyContent: 'space-between',
                  alignItems: 'center',
                  background: conv.id === activeConvId ? 'var(--bg-highlight, #e0e7ff)' : 'transparent',
                  color: conv.id === activeConvId ? 'var(--text-highlight, #4338ca)' : 'inherit',
                  fontWeight: conv.id === activeConvId ? 600 : 400,
                }}
              >
                <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', maxWidth: '160px' }}>
                  {conv.title || 'Yeni Sohbet'}
                </span>
                <button
                  type="button"
                  style={{ background: 'none', border: 'none', cursor: 'pointer', opacity: 0.6 }}
                  title="Sohbeti sil"
                  onClick={(e) => handleDeleteChat(conv.id, e)}
                >
                  ✕
                </button>
              </div>
            ))}
          </div>
        </aside>

        {/* Chat area */}
        <div style={{ display: 'flex', flexDirection: 'column', height: '100%' }}>
          {error && <ErrorNotice error={error} />}

          {/* Messages list */}
          <div style={{ flex: 1, overflowY: 'auto', display: 'flex', flexDirection: 'column', gap: '14px', paddingBottom: '16px', maxHeight: '420px' }}>
            {(!activeConversation || activeConversation.messages.length === 0) && (
              <div style={{ textAlign: 'center', padding: '40px 20px', color: 'var(--text-muted, #6b7280)' }}>
                <Icon name="terminal" size={32} />
                <h3 style={{ margin: '12px 0 6px 0', fontSize: '16px', color: 'inherit' }}>Nasıl yardımcı olabilirim?</h3>
                <p style={{ fontSize: '13px', maxWidth: '420px', margin: '0 auto 16px auto' }}>
                  Sunucu sağlığı, Website logları, DNS, sertifika durumu veya yedekleri güvenle kontrol edebilir; onaylayacağınız yönetim işlemlerini başlatabilirsiniz.
                </p>
                <div style={{ display: 'flex', flexWrap: 'wrap', gap: '8px', justifyContent: 'center' }}>
                  <Button variant="secondary" onClick={() => handleSend('Sunucu sağlığını kontrol et')}>
                    ⚡ Sunucu sağlığı
                  </Button>
                  {currentWebsiteId && (
                    <Button variant="secondary" onClick={() => handleSend('Bu sitenin loglarını incele')}>
                      📄 Site logları
                    </Button>
                  )}
                  <Button variant="secondary" onClick={() => handleSend('Yedek durumunu incele')}>
                    💾 Yedek durumu
                  </Button>
                </div>
              </div>
            )}

            {activeConversation?.messages.map((msg) => (
              <div
                key={msg.id}
                style={{
                  display: 'flex',
                  flexDirection: 'column',
                  alignSelf: msg.role === 'user' ? 'flex-end' : 'flex-start',
                  maxWidth: '85%',
                }}
              >
                <div
                  style={{
                    padding: '10px 14px',
                    borderRadius: '10px',
                    fontSize: '14px',
                    lineHeight: '1.5',
                    whiteSpace: 'pre-wrap',
                    background: msg.role === 'user' ? 'var(--primary-color, #2563eb)' : 'var(--bg-secondary, #f3f4f6)',
                    color: msg.role === 'user' ? '#ffffff' : 'inherit',
                  }}
                >
                  {msg.text}
                </div>

                {/* Executed read tools details */}
                {Array.isArray(msg.toolExecutions) && msg.toolExecutions.length > 0 && (
                  <div style={{ marginTop: '6px', display: 'flex', flexDirection: 'column', gap: '4px' }}>
                    {msg.toolExecutions.map((tool, idx) => (
                      <div key={idx} style={{ fontSize: '12px', color: 'var(--text-muted, #6b7280)', display: 'flex', alignItems: 'center', gap: '4px' }}>
                        <span style={{ color: '#10b981' }}>✓</span>
                        <code>{tool.name}</code> çalıştırıldı
                      </div>
                    ))}
                  </div>
                )}

                {/* Action proposal cards */}
                {Array.isArray(msg.proposals) && msg.proposals.length > 0 && (
                  <div style={{ marginTop: '8px', display: 'flex', flexDirection: 'column', gap: '8px' }}>
                    {msg.proposals.map((prop) => (
                      <ActionProposalCard key={prop.id || prop.callId} proposal={prop} onExecuted={() => loadActiveConversation(activeConvId)} />
                    ))}
                  </div>
                )}
              </div>
            ))}

            {sending && (
              <div style={{ alignSelf: 'flex-start', padding: '8px 12px', background: 'var(--bg-secondary, #f3f4f6)', borderRadius: '8px', fontSize: '13px', color: 'var(--text-muted, #6b7280)' }}>
                <span className="ws-spinner" style={{ marginRight: '6px' }} /> AI düşünüyor ve araçları değerlendiriyor…
              </div>
            )}
            <div ref={messagesEndRef} />
          </div>

          {/* Input form */}
          <form
            onSubmit={(e) => {
              e.preventDefault();
              handleSend();
            }}
            style={{ display: 'flex', gap: '8px', marginTop: 'auto', paddingTop: '12px', borderTop: '1px solid var(--border-color, #e5e7eb)' }}
          >
            <input
              type="text"
              className="ws-input"
              style={{ flex: 1, padding: '10px 12px', borderRadius: '6px', border: '1px solid var(--border-color, #d1d5db)' }}
              placeholder={currentWebsiteId ? 'Site veya sunucu hakkında bir soru sorun ya da işlem isteyin…' : 'Sunucu hakkında bir soru sorun ya da işlem isteyin…'}
              value={inputVal}
              disabled={sending}
              onChange={(e) => setInputVal(e.target.value)}
            />
            <Button variant="primary" type="submit" disabled={sending || !inputVal.trim()}>
              {sending ? 'Gönderiliyor…' : 'Gönder'}
            </Button>
          </form>
        </div>
      </div>
    </Modal>
  );
}

function ActionProposalCard({ proposal, onExecuted }) {
  const [busy, setBusy] = useState(false);
  const [confirmInput, setConfirmInput] = useState('');
  const [executed, setExecuted] = useState(false);
  const [error, setError] = useState(null);

  const plan = proposal.plan || {};
  const requiresExactConfirmation = plan.decision === 'confirm' && plan.confirmation;

  const handleExecute = async () => {
    if (requiresExactConfirmation && confirmInput !== plan.confirmation) {
      setError(`Onaylamak için tam olarak "${plan.confirmation}" yazmalısınız.`);
      return;
    }

    setBusy(true);
    setError(null);
    try {
      await executeAiTool({
        toolName: proposal.toolName,
        input: proposal.input,
        previewDigest: plan.previewDigest || null,
        confirmation: plan.confirmation || null,
      });
      setExecuted(true);
      if (onExecuted) onExecuted();
    } catch (err) {
      setError(err.message || 'İşlem yürütülemedi');
    } finally {
      setBusy(false);
    }
  };

  return (
    <div
      style={{
        border: '1px solid #f59e0b',
        background: '#fffbeb',
        borderRadius: '8px',
        padding: '12px 14px',
        color: '#92400e',
      }}
    >
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '6px' }}>
        <strong>⚠️ Eylem Onayı Gerekiyor</strong>
        <Badge state={executed ? 'succeeded' : 'warning'}>
          {executed ? 'Yürütüldü' : proposal.toolName}
        </Badge>
      </div>

      <p style={{ fontSize: '13px', margin: '0 0 8px 0', color: '#78350f' }}>
        AI bu işlemi gerçekleştirmek için yetki istiyor. Lütfen parametreleri kontrol edin.
      </p>

      <div style={{ background: '#fef3c7', padding: '8px', borderRadius: '4px', fontSize: '12px', fontFamily: 'monospace', marginBottom: '10px' }}>
        {JSON.stringify(proposal.input, null, 2)}
      </div>

      {error && <div style={{ color: '#b91c1c', fontSize: '12px', marginBottom: '8px' }}>{error}</div>}

      {executed ? (
        <div style={{ color: '#047857', fontWeight: 600, fontSize: '13px' }}>
          ✓ İşlem başarıyla kuyruğa alındı.
        </div>
      ) : (
        <div style={{ display: 'flex', flexDirection: 'column', gap: '8px' }}>
          {requiresExactConfirmation && (
            <label style={{ fontSize: '12px' }}>
              Onaylamak için <strong>{plan.confirmation}</strong> yazın:
              <input
                type="text"
                value={confirmInput}
                onChange={(e) => setConfirmInput(e.target.value)}
                style={{ width: '100%', marginTop: '4px', padding: '6px', fontSize: '13px' }}
                placeholder={plan.confirmation}
              />
            </label>
          )}

          <Button
            variant="primary"
            disabled={busy || (requiresExactConfirmation && confirmInput !== plan.confirmation)}
            onClick={handleExecute}
            style={{ alignSelf: 'flex-start' }}
          >
            {busy ? 'Yürütülüyor…' : 'Onayla ve Çalıştır'}
          </Button>
        </div>
      )}
    </div>
  );
}
