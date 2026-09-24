import { randomUUID } from 'node:crypto';
import { chmod, mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { createAiOrchestrator } from './ai-orchestrator.js';
import { createProviderFromConfig } from './ai-provider-adapters.js';
import { conversationScope, conversationVisible, conversationSummary, createConversationPager } from './ai-conversation-history.js';

const STORE_VERSION = 2;
const MAX_TURNS = 5;
const MAX_CONVERSATIONS = 100;
const MAX_MESSAGES_PER_CONVERSATION = 50;

export class AiConversationError extends Error {
  constructor(code, message, status = 400) {
    super(message);
    this.name = 'AiConversationError';
    this.code = code;
    this.status = status;
  }
}

function buildSystemPrompt({ website = null, domains = [], application = null } = {}) {
  let prompt = `You are YunPanel AI, an intelligent hosting and infrastructure management assistant integrated directly into YunPanel.
You help server administrators and website owners inspect, diagnose, deploy, and maintain their servers and websites safely.

Core Operating Principles:
1. Site Isolation & Least Privilege: Always respect website boundaries. Operations only affect the targeted website/server.
2. Read Operations Run Automatically: Inspections (health, website, database, dns, logs, backups) are executed automatically to gather facts.
3. Write & Destructive Operations Require Explicit Confirmation: Whenever you want to restart a service, trigger a deployment, perform a rollback, update DNS, issue a certificate, create a backup, or restore a snapshot, you must invoke the corresponding tool. YunPanel will intercept the tool call, create a verifiable action plan, and present an Action Card for the user to confirm in the UI.
4. Accuracy & Honesty: Base your answers on real tool inspection output. If a resource or metric is unknown, state so clearly. Never invent URLs, passwords, or mock results.`;

  if (website) {
    prompt += `\n\nActive Website Context:
- Website ID: ${website.id}
- Primary Hostname: ${website.domain || 'unknown'}
- Associated Domains: ${domains.map((d) => d.domainName).join(', ') || 'none'}`;
    if (application) {
      prompt += `\n- Application Type: ${application.type}
- Runtime: ${application.activeRuntime || application.runtime || 'default'}
- Current Release: ${application.currentReleaseId || 'none'}
- Active Deployment: ${application.activeDeploymentId ? 'in progress' : 'idle'}`;
    }
  }

  return prompt;
}

export function createAiConversationService({
  filePath = '/etc/yunpanel/control-plane/ai-conversations.json',
  providerRegistry,
  providerAdapter = null,
  toolRegistry,
  policyStore = null,
  policyOverrides = {},
  websiteRegistry = null,
  domainRegistry = null,
  applicationRegistry = null,
  now = () => new Date().toISOString(),
} = {}) {
  const conversations = new Map();
  let initialization = null;
  let writes = Promise.resolve();
  let storageFailed = false;
  let legacySource = null;
  const page = createConversationPager();

  async function init() {
    if (!initialization) initialization = (async () => {
      try {
        const raw = await readFile(filePath, 'utf8');
        const data = JSON.parse(raw);
        if (!data || ![1, STORE_VERSION].includes(data.version) || !Array.isArray(data.conversations)) throw new Error('Invalid store');
        const loaded = new Map();
        for (const item of data.conversations) {
          if (!item || typeof item.id !== 'string' || loaded.has(item.id)
            || typeof item.title !== 'string' || !Array.isArray(item.messages)
            || !Number.isFinite(Date.parse(item.createdAt)) || !Number.isFinite(Date.parse(item.updatedAt))
            || (item.actorId != null && typeof item.actorId !== 'string')) throw new Error('Invalid record');
          // Preserve legacy records and all their fields; never guess an owner.
          loaded.set(item.id, { ...item, actorId: item.actorId ?? null, websiteId: item.websiteId ?? null });
        }
        for (const [id, item] of loaded) conversations.set(id, item);
        if (data.version === 1) legacySource = raw;
      } catch (error) {
        if (error.code !== 'ENOENT') throw new AiConversationError('ai_history_store_unavailable', 'Conversation history could not be read safely.', 503);
      }
    })();
    await initialization;
    await writes;
    if (storageFailed) throw new AiConversationError('ai_history_store_unavailable', 'Conversation storage needs recovery.', 503);
  }

  async function persist() {
    const task = writes.then(async () => {
      if (storageFailed) throw new Error('Storage unavailable');
      const dir = path.dirname(filePath);
      await mkdir(dir, { recursive: true, mode: 0o700 });
      if (legacySource !== null) {
        const backup = `${filePath}.v1-backup`;
        try { await writeFile(backup, legacySource, { encoding: 'utf8', mode: 0o600, flag: 'wx' }); }
        catch (error) {
          if (error.code !== 'EEXIST' || await readFile(backup, 'utf8') !== legacySource) throw error;
        }
        await chmod(backup, 0o600);
        legacySource = null;
      }
      const payload = JSON.stringify({ version: STORE_VERSION, conversations: Array.from(conversations.values()) }, null, 2);
      const tempPath = `${filePath}.${randomUUID().slice(0, 8)}.tmp`;
      await writeFile(tempPath, payload, { encoding: 'utf8', mode: 0o600 });
      await chmod(tempPath, 0o600);
      await rename(tempPath, filePath);
    });
    writes = task.catch(() => { storageFailed = true; });
    try { await task; }
    catch { throw new AiConversationError('ai_history_store_unavailable', 'Conversation changes could not be stored.', 503); }
  }

  async function listConversations({ websiteId = null, auth } = {}) {
    const scope = conversationScope(auth, websiteId);
    await init();
    return Array.from(conversations.values()).filter((conv) => conversationVisible(conv, scope))
      .sort((a, b) => Date.parse(b.updatedAt) - Date.parse(a.updatedAt)).map(conversationSummary);
  }

  async function listConversationPage({ websiteId = null, auth, limit = 20, cursor = null } = {}) {
    const scope = conversationScope(auth, websiteId);
    await init();
    return page(Array.from(conversations.values()), scope, { limit, cursor });
  }

  function publicConversation(conv) {
    return Object.freeze({ ...conversationSummary(conv), messages: Object.freeze(structuredClone(conv.messages)) });
  }

  async function getConversation(id, { auth } = {}) {
    const scope = conversationScope(auth);
    await init();
    const conv = conversations.get(id);
    return conversationVisible(conv, scope) ? publicConversation(conv) : null;
  }

  async function createConversation({ title = 'New Conversation', websiteId = null, auth } = {}) {
    const scope = conversationScope(auth, websiteId);
    if (!scope.owner && websiteId === null) throw new AiConversationError('forbidden', 'A permitted Website is required.', 403);
    if (typeof title !== 'string') throw new AiConversationError('invalid_conversation_title', 'Conversation title must be text.');
    await init();
    if (websiteId !== null && (!websiteRegistry || !(await websiteRegistry.getWebsite(websiteId)))) {
      throw new AiConversationError('conversation_not_found', 'Website not found.', 404);
    }
    conversationScope(auth, websiteId);
    if (Array.from(conversations.values()).filter((conv) => conv.actorId === scope.actorId).length >= MAX_CONVERSATIONS) {
      throw new AiConversationError('ai_conversation_limit', '100 sohbet sınırına ulaşıldı. Yeni sohbet için eski bir sohbeti açıkça silin.', 409);
    }
    const id = randomUUID();
    const timestamp = new Date(now()).toISOString();
    const record = { id, actorId: scope.actorId, title: (title || 'New Conversation').slice(0, 100),
      websiteId, messages: [], createdAt: timestamp, updatedAt: timestamp };
    conversations.set(id, record);
    await persist();
    return publicConversation(record);
  }

  async function deleteConversation(id, { auth } = {}) {
    const scope = conversationScope(auth);
    await init();
    if (!conversationVisible(conversations.get(id), scope)) return false;
    conversations.delete(id);
    await persist();
    return true;
  }

  async function resolveContext(websiteId) {
    if (!websiteId || !websiteRegistry) return { website: null, domains: [], application: null };
    try {
      const website = await websiteRegistry.getWebsite(websiteId);
      if (!website) return { website: null, domains: [], application: null };
      const domains = domainRegistry ? (await domainRegistry.listDomains()).filter((d) => d.websiteId === website.id) : [];
      const application = (website.applicationId && applicationRegistry)
        ? await applicationRegistry.getApplication(website.applicationId)
        : null;
      return { website, domains, application };
    } catch {
      return { website: null, domains: [], application: null };
    }
  }

  async function currentOverrides() {
    if (!policyStore) return policyOverrides;
    try {
      const snapshot = await policyStore.getSnapshot();
      return snapshot?.overrides || policyOverrides;
    } catch {
      return policyOverrides;
    }
  }

  async function sendMessage({
    conversationId,
    text,
    auth,
    onEvent = null,
    signal = null,
  }) {
    const scope = conversationScope(auth);
    await init();
    const conv = conversations.get(conversationId);
    if (!conversationVisible(conv, scope)) {
      throw new AiConversationError('conversation_not_found', 'Conversation not found', 404);
    }
    if (!text || typeof text !== 'string' || text.trim().length === 0) {
      throw new AiConversationError('invalid_message_text', 'Message text cannot be empty', 400);
    }

    let adapter = providerAdapter;
    let selectedModel = providerAdapter?.defaultModel || 'gpt-4o';

    if (!adapter) {
      const decryptedProvider = await providerRegistry?.getDecryptedActiveProvider();
      if (!decryptedProvider) {
        throw new AiConversationError('ai_provider_not_configured', 'No active AI provider is configured. Please configure an AI provider in Settings > AI Management.', 503);
      }
      adapter = createProviderFromConfig(decryptedProvider);
      selectedModel = decryptedProvider.defaultModel;
    }

    const overrides = await currentOverrides();
    const orchestrator = createAiOrchestrator({
      provider: adapter,
      registry: toolRegistry,
      policyOverrides: overrides,
    });

    const context = await resolveContext(conv.websiteId);
    const systemPrompt = buildSystemPrompt(context);

    // Append user message
    const userMsg = {
      id: randomUUID(),
      role: 'user',
      text: text.trim(),
      createdAt: now(),
    };
    conv.messages.push(userMsg);
    if (conv.title === 'New Conversation') {
      conv.title = text.trim().slice(0, 40) + (text.trim().length > 40 ? '...' : '');
    }

    // Build messages list for provider
    const workingMessages = [
      { role: 'system', text: systemPrompt },
    ];

    for (const msg of conv.messages.slice(-MAX_MESSAGES_PER_CONVERSATION)) {
      if (msg.role === 'user' || msg.role === 'assistant') {
        workingMessages.push({ role: msg.role, text: msg.text || '' });
      }
    }

    let turnCount = 0;
    let finalAssistantText = '';
    let finalProposals = [];
    const toolExecutions = [];

    while (turnCount < MAX_TURNS) {
      turnCount += 1;
      if (onEvent) onEvent({ type: 'thinking', turn: turnCount });

      const turn = await orchestrator.proposeTurn({
        model: selectedModel,
        messages: workingMessages,
        auth,
        signal,
      });

      if (turn.type === 'message') {
        finalAssistantText = turn.message.text;
        if (onEvent) onEvent({ type: 'text', text: finalAssistantText });
        break;
      }

      if (turn.type === 'tool_proposals') {
        const hasActionProposal = turn.proposals.some((p) => p.plan?.tool?.risk !== 'read' || !p.autoExecutable);

        if (hasActionProposal) {
          // Write, mutation or non-auto-executable proposals require explicit human confirmation
          finalProposals = turn.proposals.map((p) => ({
            id: randomUUID(),
            callId: p.callId,
            toolName: p.name,
            input: p.input,
            plan: p.plan,
            autoExecutable: p.autoExecutable,
          }));

          finalAssistantText = finalAssistantText
            || 'I have prepared the following action for your review and confirmation:';

          if (onEvent) {
            onEvent({ type: 'proposals', proposals: finalProposals, text: finalAssistantText });
          }
          break;
        }

        // All proposals are auto-executable (read tools)
        for (const proposal of turn.proposals) {
          if (onEvent) onEvent({ type: 'tool_call', name: proposal.name, input: proposal.input });

          let result;
          try {
            result = await toolRegistry.execute({
              name: proposal.name,
              input: proposal.input,
              context: { actorId: auth.user.id, role: auth.user.role },
            });
          } catch (err) {
            result = { error: err.message, code: err.code || 'tool_execution_failed' };
          }

          toolExecutions.push({ name: proposal.name, input: proposal.input, result });
          if (onEvent) onEvent({ type: 'tool_result', name: proposal.name, result });

          workingMessages.push({
            role: 'tool',
            callId: proposal.callId,
            name: proposal.name,
            result,
          });
        }
      }
    }

    const assistantMsg = {
      id: randomUUID(),
      role: 'assistant',
      text: finalAssistantText,
      proposals: finalProposals.length > 0 ? finalProposals : undefined,
      toolExecutions: toolExecutions.length > 0 ? toolExecutions : undefined,
      createdAt: now(),
    };

    conv.messages.push(assistantMsg);
    conv.updatedAt = now();
    await persist();

    if (onEvent) onEvent({ type: 'done', message: assistantMsg });
    return Object.freeze(assistantMsg);
  }

  return Object.freeze({
    init,
    listConversations,
    listConversationPage,
    getConversation,
    createConversation,
    deleteConversation,
    sendMessage,
    buildSystemPrompt,
  });
}
