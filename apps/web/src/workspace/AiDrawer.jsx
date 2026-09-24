import { useEffect, useRef, useState } from 'react';
import { useLocation } from 'react-router';
import { panelRequest } from '../api.js';
import { usePanelSession } from '../panel-session.jsx';
import { sessionVersion, sessionTransitionPending } from '../session-client.js';
import { Badge, Button, ErrorNotice, Icon, Modal } from './PanelKit.jsx';
import { createAiConversation, deleteAiConversation, executeAiTool, getAiConversation, listAiConversationPage, sendAiMessage } from './ai-client.js';
import { createAiHistory, createAiConversationReader, EMPTY_AI_HISTORY, resolveAiWebsiteContext } from './ai-history.js';
import './ai-history.css';

export default function AiDrawer({ open, onClose }) {
  const location = useLocation();
  const { session } = usePanelSession();
  const match = location.pathname.match(/^\/websites\/([^/]+)/);
  const domainId = match && match[1] !== 'new' ? match[1] : null;
  const identity = JSON.stringify([domainId, session?.user?.id, session?.user?.role, session?.user?.websiteIds, sessionVersion()]);
  if (!open || !session?.user?.id) return null;
  return <AiScope key={identity} domainId={domainId} actorId={session.user.id} onClose={onClose} />;
}

function AiScope({ domainId, actorId, onClose }) {
  const [context, setContext] = useState({ ready: !domainId, websiteId: null, error: null });
  const [attempt, setAttempt] = useState(0);
  useEffect(() => {
    if (!domainId) return undefined;
    const controller = new AbortController(), version = sessionVersion();
    const current = () => !controller.signal.aborted && version === sessionVersion() && !sessionTransitionPending();
    setContext({ ready: false, websiteId: null, error: null });
    resolveAiWebsiteContext(domainId, panelRequest, { signal: controller.signal }).then((websiteId) => {
      if (current()) setContext({ ready: true, websiteId, error: null });
    }).catch(() => {
      if (current()) setContext({ ready: false, websiteId: null, error: 'Sitenin Website bağı doğrulanamadı. Başka site veya genel bağlam kullanılmadı.' });
    });
    return () => controller.abort();
  }, [domainId, attempt]);
  if (!context.ready) return <Modal title="YunPanel AI Yönetim Asistanı" onClose={onClose} wide>
    {context.error ? <><ErrorNotice error={context.error} /><Button onClick={() => setAttempt((n) => n + 1)}>Yeniden kontrol et</Button></>
      : <p role="status">Site bağlamı doğrulanıyor…</p>}
  </Modal>;
  return <ConversationPanel actorId={actorId} websiteId={context.websiteId} onClose={onClose} />;
}

function ConversationPanel({ actorId, websiteId, onClose }) {
  const [history, setHistory] = useState(EMPTY_AI_HISTORY);
  const [activeConvId, setActiveConvId] = useState(null);
  const [detail, setDetail] = useState({ id: null, status: 'idle', conversation: null, error: null });
  const [sending, setSending] = useState(false);
  const [inputVal, setInputVal] = useState('');
  const [error, setError] = useState(null);
  const scope = useRef(null), active = useRef(null), pending = useRef(false), drafts = useRef(new Map());
  const messagesRef = useRef(null);
  function select(id) {
    active.current = id; setActiveConvId(id); setInputVal(drafts.current.get(id ?? 'new') ?? '');
  }
  useEffect(() => {
    const life = new AbortController(), version = sessionVersion();
    const current = () => !life.signal.aborted && version === sessionVersion() && !sessionTransitionPending();
    let list, reader;
    function denied() {
      life.abort(); list.dispose(); reader.dispose();
      setHistory({ ...EMPTY_AI_HISTORY, status: 'forbidden', error: 'Sohbet erişiminiz değişti. Pencereyi güncel oturumla yeniden açın.' });
      setDetail({ id: null, status: 'forbidden', conversation: null, error: null });
      setInputVal(''); drafts.current.clear();
    }
    list = createAiHistory({ actorId, websiteId, isCurrent: current,
      read: (options) => listAiConversationPage(websiteId, options),
      onState: (value) => {
        if (value.status === 'forbidden') { denied(); return; }
        setHistory(value);
        if (value.status === 'ready' && !active.current && value.items.length) select(value.items[0].id);
      },
    });
    reader = createAiConversationReader({ websiteId, isCurrent: current, read: getAiConversation,
      onState: (value) => {
        if (value.status === 'forbidden') { denied(); return; }
        setDetail(value);
        if (value.conversation) list.upsert(value.conversation);
      },
    });
    scope.current = { list, reader, current, signal: life.signal };
    void list.load();
    return () => { life.abort(); list.dispose(); reader.dispose(); scope.current = null; };
  }, [actorId, websiteId]);
  useEffect(() => { void scope.current?.reader.load(activeConvId); }, [activeConvId]);
  const activeConversation = detail.id === activeConvId ? detail.conversation : null;
  useEffect(() => {
    // Do not scroll the modal or the background document with scrollIntoView.
    const element = messagesRef.current;
    if (element) element.scrollTop = element.scrollHeight;
  }, [activeConversation?.messages, sending]);
  async function mutate(action) {
    const client = scope.current;
    if (pending.current || !client?.current()) return;
    pending.current = true; setSending(true); setError(null);
    try { await action(client); }
    catch (failure) {
      if (client.current()) setError(failure?.code === 'ai_conversation_limit'
        ? '100 sohbet sınırına ulaşıldı. Yeni sohbet için eski bir sohbeti silin.'
        : 'İşlem sonucu doğrulanamadı. Tekrar göndermeden önce geçmişi yenileyin.');
    } finally { pending.current = false; if (client.current()) setSending(false); }
  }
  async function newConversation(client, title) {
    const created = await createAiConversation({ title, websiteId }, { signal: client.signal });
    if (!client.current()) return null;
    client.list.upsert(created); select(created.id); return created.id;
  }
  const handleNewChat = () => mutate((client) => newConversation(client, 'Yeni Sohbet'));
  const handleDeleteChat = (id) => mutate(async (client) => {
    const result = await deleteAiConversation(id, { signal: client.signal });
    if (!client.current()) return;
    if (result?.success !== true) throw new Error('Unverified deletion');
    client.list.remove(id); drafts.current.delete(id);
    if (active.current === id) select(client.list.getState().items[0]?.id ?? null);
  });
  const handleSend = (textToSend) => {
    const query = (textToSend || inputVal).trim();
    if (!query) return;
    return mutate(async (client) => {
      const id = active.current || await newConversation(client, query.slice(0, 30));
      if (!id || !client.current()) return;
      await sendAiMessage({ conversationId: id, text: query }, { signal: client.signal });
      if (!client.current()) return;
      drafts.current.delete(id); drafts.current.delete('new');
      if (active.current === id) { setInputVal(''); await client.reader.load(id); }
    });
  };
  const loading = ['loading', 'loadingMore'].includes(history.status);
  const denied = history.status === 'forbidden' || detail.status === 'forbidden';
  const loadMore = () => scope.current?.list.more();
  return <Modal title="YunPanel AI Yönetim Asistanı" onClose={onClose} wide>
    <div className="ws-ai-layout ws-ai-history-layout">
      <aside className="ws-ai-sidebar" aria-label="Sohbet geçmişi">
        <div className="ws-actions"><strong>SOHBETLER</strong><Button variant="primary" icon="plus" disabled={sending || denied} onClick={handleNewChat}>Yeni</Button><Button disabled={loading || denied} icon="refresh" aria-label="Geçmişi yenile" title="Geçmişi yenile" onClick={() => scope.current?.list.load()} /></div>
        <small>{websiteId ? 'Site bağlamı · ' : ''}En yeni oluşturulanlar önce</small>
        <div className="ws-ai-history-list" tabIndex={0} aria-label="Kaydırılabilir sohbet listesi" aria-busy={loading}
          onScroll={(event) => {
            const node = event.currentTarget;
            if (!loading && !history.error && history.hasMore && node.scrollHeight - node.clientHeight - node.scrollTop < 64) void loadMore();
          }}>
          {history.items.map((conv) => <div key={conv.id} className="ws-ai-history-row">
            <Button className="ws-ai-conversation-select" variant={conv.id === activeConvId ? 'primary' : 'secondary'}
              aria-current={conv.id === activeConvId ? 'true' : undefined} disabled={sending || denied} title={conv.title}
              onClick={() => select(conv.id)}><span>{conv.title || 'Yeni Sohbet'}</span></Button>
            <Button disabled={sending || denied} aria-label={`${conv.title || 'Sohbet'} sohbetini sil`} title="Sohbeti sil" onClick={() => handleDeleteChat(conv.id)}>✕</Button>
          </div>)}
          {loading && <p role="status">Sohbetler yükleniyor…</p>}
          {!loading && !history.items.length && !history.error && <p>Kayıtlı sohbet bulunamadı.</p>}
          {history.error && <ErrorNotice error={history.error} />}
          {history.hasMore && !history.reloadRequired && <Button disabled={loading || denied} onClick={loadMore}>{history.error ? 'Eski sayfayı yeniden dene' : 'Daha eski sohbetler'}</Button>}
          {!history.hasMore && history.items.length > 0 && <p className="ws-muted">Geçmişin sonuna ulaşıldı.</p>}
          {history.legacyUnassigned && <p className="ws-muted">Eski sohbetler dosyada korundu. Sahiplik bilgisi olmayan kayıtlar güvenli eşleştirme yapılana kadar burada gösterilmez.</p>}
        </div>
      </aside>
      <div className="ws-ai-chat">
        {error && <ErrorNotice error={error} />}
        {detail.error && <div><ErrorNotice error={detail.error} /><Button onClick={() => scope.current?.reader.load(activeConvId)}>Sohbeti yeniden oku</Button></div>}
        <div className="ws-ai-messages" ref={messagesRef} role="log" aria-label="Sohbet mesajları" aria-live="polite">
          {detail.status === 'loading' && <p role="status">Sohbet açılıyor…</p>}
          {!denied && detail.status !== 'loading' && (!activeConversation || !activeConversation.messages.length) && <div style={{ textAlign: 'center', padding: '40px 20px', color: 'var(--text-muted, #6b7280)' }}>
            <Icon name="terminal" size={32} /><h3 style={{ margin: '12px 0 6px 0', fontSize: '16px', color: 'inherit' }}>Nasıl yardımcı olabilirim?</h3>
            <p style={{ fontSize: '13px', maxWidth: '420px', margin: '0 auto 16px auto' }}>Sunucu sağlığı, Website logları, DNS, sertifika durumu veya yedekleri güvenle kontrol edebilir; onaylayacağınız yönetim işlemlerini başlatabilirsiniz.</p>
            <div className="ws-actions"><Button disabled={sending} onClick={() => handleSend('Sunucu sağlığını kontrol et')}>⚡ Sunucu sağlığı</Button>
              {websiteId && <Button disabled={sending} onClick={() => handleSend('Bu sitenin loglarını incele')}>📄 Site logları</Button>}
              <Button disabled={sending} onClick={() => handleSend('Yedek durumunu incele')}>💾 Yedek durumu</Button></div>
          </div>}
          {!denied && activeConversation?.messages.map((msg) => <div key={msg.id} style={{ display: 'flex', flexDirection: 'column', alignSelf: msg.role === 'user' ? 'flex-end' : 'flex-start', maxWidth: '85%' }}>
            <div style={{ padding: '10px 14px', borderRadius: '10px', fontSize: '14px', lineHeight: '1.5', whiteSpace: 'pre-wrap',
              background: msg.role === 'user' ? 'var(--primary-color, #2563eb)' : 'var(--bg-secondary, #f3f4f6)', color: msg.role === 'user' ? '#ffffff' : 'inherit' }}>{msg.text}</div>
            {Array.isArray(msg.toolExecutions) && msg.toolExecutions.length > 0 && <div style={{ marginTop: '6px', display: 'flex', flexDirection: 'column', gap: '4px' }}>
              {msg.toolExecutions.map((tool, idx) => <div key={idx} style={{ fontSize: '12px', color: 'var(--text-muted, #6b7280)', display: 'flex', alignItems: 'center', gap: '4px' }}><span style={{ color: '#10b981' }}>✓</span><code>{tool.name}</code> çalıştırıldı</div>)}
            </div>}
            {Array.isArray(msg.proposals) && msg.proposals.length > 0 && <div style={{ marginTop: '8px', display: 'flex', flexDirection: 'column', gap: '8px' }}>
              {msg.proposals.map((prop) => <ActionProposalCard key={prop.id || prop.callId} proposal={prop} onExecuted={() => scope.current?.reader.load(active.current)} />)}
            </div>}
          </div>)}
          {sending && <p role="status"><span className="ws-spinner" /> İstek işleniyor…</p>}
        </div>
        <form className="ws-ai-composer" onSubmit={(event) => { event.preventDefault(); void handleSend(); }}>
          <input type="text" className="ws-input" aria-label="AI mesajınız" placeholder={websiteId ? 'Site veya sunucu hakkında sorun…' : 'Sunucu hakkında sorun…'} value={inputVal}
            disabled={sending || denied} onChange={(event) => { setInputVal(event.target.value); drafts.current.set(activeConvId ?? 'new', event.target.value); }} />
          <Button variant="primary" type="submit" disabled={sending || denied || !inputVal.trim()}>{sending ? 'Gönderiliyor…' : 'Gönder'}</Button>
        </form>
      </div>
    </div>
  </Modal>;
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
