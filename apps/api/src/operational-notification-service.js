import { randomUUID } from 'node:crypto';
import {
  NOTIFICATION_EVENT_TYPES,
  NOTIFICATION_SEVERITY,
  SEVERITY_LEVELS,
  NOTIFICATION_CATEGORIES,
  NOTIFICATION_CHANNELS,
  DELIVERY_STATUS,
  DEFAULT_NOTIFICATION_PREFERENCES,
  mapEventToCategory,
} from './operational-notification-types.js';
import { maskSecrets } from './secret-masker.js';
import { extractActorTenant } from './tenant-boundary.js';

export class OperationalNotificationError extends Error {
  constructor(code, message, status = 400) {
    super(message);
    this.name = 'OperationalNotificationError';
    this.code = code;
    this.status = status;
  }
}

const MAX_DELIVERY_LOG_SIZE = 500;
const MAX_FEED_SIZE = 100;
const DEFAULT_THROTTLE_WINDOW_MS = 60 * 60 * 1000; // 60 minutes
const DEFAULT_DISK_WARNING_PERCENT = 85;
const DEFAULT_DISK_CRITICAL_PERCENT = 95;
const DEFAULT_INODE_WARNING_PERCENT = 85;
const DEFAULT_INODE_CRITICAL_PERCENT = 95;

export function createOperationalNotificationService({
  authMailer = null,
  certificateRegistry = null,
  domainRegistry = null,
  websiteRegistry = null,
  jobRegistry = null,
  userAdminStore = null,
  hostingAccountStore = null,
  customerLookup = null,
  localServerId = null,
  now = () => Date.now(),
  fetchFn = (typeof globalThis.fetch === 'function' ? globalThis.fetch : null),
  defaultThrottleWindowMs = DEFAULT_THROTTLE_WINDOW_MS,
  diskWarningThresholdPercent = DEFAULT_DISK_WARNING_PERCENT,
  diskCriticalThresholdPercent = DEFAULT_DISK_CRITICAL_PERCENT,
  inodeWarningThresholdPercent = DEFAULT_INODE_WARNING_PERCENT,
  inodeCriticalThresholdPercent = DEFAULT_INODE_CRITICAL_PERCENT,
  defaultOwnerEmail = 'admin@yunpanel.local',
  logger = console,
} = {}) {
  const preferencesMap = new Map();
  const deliveryLog = [];
  const inPanelFeeds = new Map();
  const suppressionState = new Map();

  function getPreferences(actorId = 'global') {
    const key = actorId || 'global';
    const stored = preferencesMap.get(key);
    if (!stored) {
      return JSON.parse(JSON.stringify(DEFAULT_NOTIFICATION_PREFERENCES));
    }
    return JSON.parse(JSON.stringify(stored));
  }

  function updatePreferences(actorId, patch = {}) {
    if (!patch || typeof patch !== 'object' || Array.isArray(patch)) {
      throw new OperationalNotificationError('invalid_preferences_patch', 'Preferences patch must be an object', 400);
    }
    const key = actorId || 'global';
    const current = getPreferences(key);

    const updated = {
      enabled: patch.enabled !== undefined ? Boolean(patch.enabled) : current.enabled,
      minSeverity: current.minSeverity,
      categories: { ...current.categories },
      channels: {
        email: { ...current.channels.email },
        webhook: { ...current.channels.webhook },
        panel: { ...current.channels.panel },
      },
      throttling: { ...current.throttling },
    };

    if (patch.minSeverity !== undefined) {
      if (!Object.values(NOTIFICATION_SEVERITY).includes(patch.minSeverity)) {
        throw new OperationalNotificationError('invalid_min_severity', 'minSeverity must be info, warning, or critical', 400);
      }
      updated.minSeverity = patch.minSeverity;
    }

    if (patch.categories && typeof patch.categories === 'object' && !Array.isArray(patch.categories)) {
      for (const [cat, val] of Object.entries(patch.categories)) {
        updated.categories[cat] = Boolean(val);
      }
    }

    if (patch.channels && typeof patch.channels === 'object' && !Array.isArray(patch.channels)) {
      if (patch.channels.email && typeof patch.channels.email === 'object') {
        if (patch.channels.email.enabled !== undefined) {
          updated.channels.email.enabled = Boolean(patch.channels.email.enabled);
        }
        if (patch.channels.email.address !== undefined) {
          const addr = patch.channels.email.address;
          if (addr !== null && (typeof addr !== 'string' || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(addr.trim()))) {
            throw new OperationalNotificationError('invalid_email_address', 'Email address is invalid', 400);
          }
          updated.channels.email.address = addr ? addr.trim().toLowerCase() : null;
        }
      }
      if (patch.channels.webhook && typeof patch.channels.webhook === 'object') {
        if (patch.channels.webhook.enabled !== undefined) {
          updated.channels.webhook.enabled = Boolean(patch.channels.webhook.enabled);
        }
        if (patch.channels.webhook.url !== undefined) {
          const url = patch.channels.webhook.url;
          if (url !== null && (typeof url !== 'string' || !/^https?:\/\//.test(url.trim()))) {
            throw new OperationalNotificationError('invalid_webhook_url', 'Webhook URL must start with http:// or https://', 400);
          }
          updated.channels.webhook.url = url ? url.trim() : null;
        }
      }
      if (patch.channels.panel && typeof patch.channels.panel === 'object') {
        if (patch.channels.panel.enabled !== undefined) {
          updated.channels.panel.enabled = Boolean(patch.channels.panel.enabled);
        }
      }
    }

    if (patch.throttling && typeof patch.throttling === 'object') {
      if (patch.throttling.windowMinutes !== undefined) {
        const mins = Number(patch.throttling.windowMinutes);
        if (!Number.isInteger(mins) || mins < 1 || mins > 1440) {
          throw new OperationalNotificationError('invalid_throttling_window', 'windowMinutes must be between 1 and 1440', 400);
        }
        updated.throttling.windowMinutes = mins;
      }
    }

    preferencesMap.set(key, updated);
    return JSON.parse(JSON.stringify(updated));
  }

  function recordDelivery(deliveryRecord) {
    const entry = Object.freeze({
      ...maskSecrets(deliveryRecord),
      id: deliveryRecord.id || `del-${randomUUID()}`,
      timestamp: deliveryRecord.timestamp || new Date(now()).toISOString(),
    });
    deliveryLog.push(entry);
    if (deliveryLog.length > MAX_DELIVERY_LOG_SIZE) {
      deliveryLog.shift();
    }
    return entry;
  }

  async function resolveEligibleRecipients(event) {
    const recipients = [];
    const ownerRecipient = {
      id: 'usr-owner',
      role: 'owner',
      email: defaultOwnerEmail,
      isGlobal: true,
      active: true,
    };

    if (userAdminStore && typeof userAdminStore.listUsers === 'function') {
      try {
        const users = await userAdminStore.listUsers();
        const liveOwner = users.find((u) => u.role === 'owner' && u.active !== false);
        if (liveOwner) {
          ownerRecipient.id = liveOwner.id;
          ownerRecipient.email = liveOwner.email || defaultOwnerEmail;
        }
      } catch {}
    }

    recipients.push(ownerRecipient);

    // If event is scoped to a specific website
    if (event.websiteId) {
      let site = null;
      if (websiteRegistry && typeof websiteRegistry.getWebsite === 'function') {
        try {
          site = await websiteRegistry.getWebsite(event.websiteId);
        } catch {}
      }

      const customerId = event.customerId || site?.customerId || null;
      let resellerId = event.resellerId || site?.resellerId || null;

      if (customerId) {
        let customerUser = null;
        if (typeof customerLookup === 'function') {
          try {
            customerUser = await customerLookup(customerId);
          } catch {}
        }
        if (!customerUser && hostingAccountStore && typeof hostingAccountStore.getCustomer === 'function') {
          try {
            customerUser = await hostingAccountStore.getCustomer(customerId);
          } catch {}
        }

        if (customerUser && customerUser.active !== false) {
          if (!resellerId && customerUser.resellerId) {
            resellerId = customerUser.resellerId;
          }
          recipients.push({
            id: customerUser.id || customerId,
            role: 'customer',
            email: customerUser.email || `${customerUser.username || customerId}@yunpanel.local`,
            websiteIds: [event.websiteId],
            customerId: customerUser.id || customerId,
            resellerId,
            isGlobal: false,
            active: true,
          });
        }
      }

      if (resellerId) {
        let resellerUser = null;
        if (hostingAccountStore && typeof hostingAccountStore.getReseller === 'function') {
          try {
            resellerUser = await hostingAccountStore.getReseller(resellerId);
          } catch {}
        }
        if (resellerUser && resellerUser.active !== false) {
          recipients.push({
            id: resellerUser.id || resellerId,
            role: 'reseller',
            email: resellerUser.email || `${resellerUser.username || resellerId}@yunpanel.local`,
            websiteIds: [event.websiteId],
            resellerId,
            isGlobal: false,
            active: true,
          });
        }
      }
    }

    return recipients;
  }

  function isRecipientAuthorizedForEvent(recipient, event) {
    if (recipient.isGlobal || recipient.role === 'owner') {
      return true;
    }

    // System-wide events without website/tenant scope are Owner-only
    if (!event.websiteId && !event.customerId) {
      return false;
    }

    if (recipient.role === 'customer') {
      if (event.customerId && event.customerId !== recipient.id) {
        return false;
      }
      if (event.websiteId && Array.isArray(recipient.websiteIds) && !recipient.websiteIds.includes(event.websiteId)) {
        return false;
      }
      return true;
    }

    if (recipient.role === 'reseller') {
      if (event.resellerId && event.resellerId !== recipient.id) {
        return false;
      }
      if (event.websiteId && Array.isArray(recipient.websiteIds) && !recipient.websiteIds.includes(event.websiteId)) {
        return false;
      }
      return true;
    }

    if (recipient.role === 'site_manager') {
      if (event.websiteId && Array.isArray(recipient.websiteIds) && recipient.websiteIds.includes(event.websiteId)) {
        return true;
      }
      return false;
    }

    return false;
  }

  async function sendEmailDelivery({ recipient, event, prefs, maskedTitle, maskedMessage, maskedDetails }) {
    const toAddress = recipient.email || prefs.channels.email?.address;
    if (!toAddress) {
      return {
        status: DELIVERY_STATUS.FAILED,
        error: { code: 'recipient_email_missing', message: 'No email address configured for recipient' },
      };
    }

    if (!authMailer || typeof authMailer.sendMail !== 'function') {
      return {
        status: DELIVERY_STATUS.FAILED,
        error: { code: 'smtp_unavailable', message: 'Auth mailer is not configured or unavailable' },
      };
    }

    try {
      let emailText = maskedMessage;
      if (maskedDetails?.error) {
        const errCode = maskedDetails.error.code ? `[${maskedDetails.error.code}] ` : '';
        const errMsg = maskedDetails.error.message || '';
        emailText += `\n\nHata: ${errCode}${errMsg}`.trimEnd();
      }
      if (maskedDetails && typeof maskedDetails === 'object' && Object.keys(maskedDetails).length > 0) {
        emailText += `\n\nAyrıntılar:\n${JSON.stringify(maskedDetails, null, 2)}`;
      }

      const mailRes = await authMailer.sendMail({
        to: toAddress,
        subject: `[YunPanel ${event.severity.toUpperCase()}] ${maskedTitle}`,
        text: emailText,
      });
      return {
        status: DELIVERY_STATUS.DELIVERED,
        messageId: mailRes?.messageId || `<${randomUUID()}@yunpanel.local>`,
        recipientAddress: toAddress,
      };
    } catch (err) {
      return {
        status: DELIVERY_STATUS.FAILED,
        error: {
          code: err.code || 'smtp_delivery_failed',
          message: maskSecrets(err.message || String(err)),
        },
        recipientAddress: toAddress,
      };
    }
  }

  async function sendWebhookDelivery({ recipient, event, prefs, maskedTitle, maskedMessage, maskedDetails }) {
    const webhookUrl = prefs.channels.webhook?.url || event.details?.targetUrl;
    if (!webhookUrl) {
      return {
        status: DELIVERY_STATUS.FAILED,
        error: { code: 'webhook_url_missing', message: 'Webhook URL is not configured' },
      };
    }

    if (!fetchFn) {
      return {
        status: DELIVERY_STATUS.FAILED,
        error: { code: 'fetch_unavailable', message: 'HTTP client is unavailable' },
      };
    }

    const payload = {
      id: event.id,
      timestamp: event.timestamp,
      event: event.eventType,
      eventType: event.eventType,
      severity: event.severity,
      category: event.category,
      title: maskedTitle,
      message: maskedMessage,
      details: maskedDetails,
      websiteId: event.websiteId ?? null,
      domainId: event.domainId ?? null,
      recipient: { id: recipient.id, role: recipient.role },
    };

    try {
      const response = await fetchFn(webhookUrl, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(payload),
      });

      if (!response.ok) {
        return {
          status: DELIVERY_STATUS.FAILED,
          error: {
            code: 'webhook_status_error',
            message: `Webhook endpoint returned HTTP ${response.status} ${response.statusText || ''}`.trim(),
          },
          targetUrl: webhookUrl,
        };
      }

      return {
        status: DELIVERY_STATUS.DELIVERED,
        messageId: `wh-${randomUUID()}`,
        targetUrl: webhookUrl,
      };
    } catch (err) {
      return {
        status: DELIVERY_STATUS.FAILED,
        error: {
          code: err.code || 'webhook_network_error',
          message: maskSecrets(err.message || String(err)),
        },
        targetUrl: webhookUrl,
      };
    }
  }

  function sendPanelDelivery({ recipient, event, maskedTitle, maskedMessage, maskedDetails }) {
    const recipientKey = recipient.id;
    const feed = inPanelFeeds.get(recipientKey) ?? [];
    const feedItem = Object.freeze({
      id: `feed-${randomUUID()}`,
      eventId: event.id,
      timestamp: event.timestamp,
      eventType: event.eventType,
      severity: event.severity,
      category: event.category,
      title: maskedTitle,
      message: maskedMessage,
      details: maskedDetails,
      websiteId: event.websiteId ?? null,
      read: false,
    });
    feed.unshift(feedItem);
    if (feed.length > MAX_FEED_SIZE) {
      feed.pop();
    }
    inPanelFeeds.set(recipientKey, feed);

    return {
      status: DELIVERY_STATUS.DELIVERED,
      feedItemId: feedItem.id,
    };
  }

  async function dispatch(eventInput) {
    if (!eventInput || typeof eventInput !== 'object') {
      throw new OperationalNotificationError('invalid_event', 'Notification event must be an object', 400);
    }

    const currentTime = now();
    const eventId = eventInput.id || `evt-${randomUUID()}`;
    const eventType = eventInput.eventType;
    const severity = eventInput.severity || NOTIFICATION_SEVERITY.INFO;
    const category = eventInput.category || mapEventToCategory(eventType);
    const title = eventInput.title || `Operational Alert: ${eventType}`;
    const message = eventInput.message || title;
    const details = eventInput.details || {};
    const websiteId = eventInput.websiteId || details.websiteId || null;
    const domainId = eventInput.domainId || details.domainId || null;
    const serverId = eventInput.serverId || details.serverId || localServerId;
    const customerId = eventInput.customerId || details.customerId || null;
    const resellerId = eventInput.resellerId || details.resellerId || null;
    const targetKey = eventInput.targetKey || (websiteId ? `website:${websiteId}` : domainId ? `domain:${domainId}` : details.serviceId ? `service:${details.serviceId}` : details.mountPoint ? `mount:${details.mountPoint}` : 'global');
    const bypassThrottling = Boolean(eventInput.bypassThrottling);
    const bypassPreferences = Boolean(eventInput.bypassPreferences || eventInput.isTest || eventType === NOTIFICATION_EVENT_TYPES.TEST_NOTIFICATION);

    const event = Object.freeze({
      id: eventId,
      timestamp: new Date(currentTime).toISOString(),
      eventType,
      severity,
      category,
      title,
      message,
      details,
      websiteId,
      domainId,
      serverId,
      customerId,
      resellerId,
      targetKey,
      bypassThrottling,
    });

    const maskedTitle = maskSecrets(event.title);
    const maskedMessage = maskSecrets(event.message);
    const maskedDetails = maskSecrets(event.details);
    const baseDetails = {
      ...(maskedDetails && typeof maskedDetails === 'object' && !Array.isArray(maskedDetails) ? maskedDetails : {}),
      websiteId: websiteId || maskedDetails?.websiteId || null,
    };

    const candidates = eventInput.recipients && Array.isArray(eventInput.recipients)
      ? eventInput.recipients
      : await resolveEligibleRecipients(event);

    const deliveryResults = [];

    for (const recipient of candidates) {
      // 1. Enforce tenant boundary
      if (!isRecipientAuthorizedForEvent(recipient, event)) {
        const record = recordDelivery({
          eventId,
          eventType,
          severity,
          category,
          recipient: { id: recipient.id, role: recipient.role, email: recipient.email },
          channel: 'boundary',
          status: DELIVERY_STATUS.SKIPPED_TENANT,
          title: maskedTitle,
          message: maskedMessage,
          details: { ...baseDetails, reason: 'outside_recipient_tenant_boundary' },
        });
        deliveryResults.push(record);
        continue;
      }

      // 2. Load preferences
      const prefs = getPreferences(recipient.id);
      if (!bypassPreferences && !prefs.enabled) {
        const record = recordDelivery({
          eventId,
          eventType,
          severity,
          category,
          recipient: { id: recipient.id, role: recipient.role, email: recipient.email },
          channel: 'preferences',
          status: DELIVERY_STATUS.SKIPPED_PREFERENCE,
          title: maskedTitle,
          message: maskedMessage,
          details: { ...baseDetails, reason: 'notifications_disabled' },
        });
        deliveryResults.push(record);
        continue;
      }

      // Category filter
      if (!bypassPreferences && prefs.categories && prefs.categories[category] === false) {
        const record = recordDelivery({
          eventId,
          eventType,
          severity,
          category,
          recipient: { id: recipient.id, role: recipient.role, email: recipient.email },
          channel: 'preferences',
          status: DELIVERY_STATUS.SKIPPED_PREFERENCE,
          title: maskedTitle,
          message: maskedMessage,
          details: { ...baseDetails, reason: `category_${category}_disabled` },
        });
        deliveryResults.push(record);
        continue;
      }

      // Severity filter
      const prefSeverityWeight = SEVERITY_LEVELS[prefs.minSeverity] ?? SEVERITY_LEVELS.warning;
      const eventSeverityWeight = SEVERITY_LEVELS[severity] ?? SEVERITY_LEVELS.info;
      if (!bypassPreferences && eventSeverityWeight < prefSeverityWeight) {
        const record = recordDelivery({
          eventId,
          eventType,
          severity,
          category,
          recipient: { id: recipient.id, role: recipient.role, email: recipient.email },
          channel: 'preferences',
          status: DELIVERY_STATUS.SKIPPED_PREFERENCE,
          title: maskedTitle,
          message: maskedMessage,
          details: { ...baseDetails, reason: `severity_${severity}_below_min_${prefs.minSeverity}` },
        });
        deliveryResults.push(record);
        continue;
      }

      // 3. Alert Repeat Suppression (Throttling / Deduplication)
      const throttleWindowMs = (prefs.throttling?.windowMinutes ?? (defaultThrottleWindowMs / 60000)) * 60 * 1000;
      const throttleKey = `${recipient.id}:${eventType}:${targetKey}`;
      const lastSuppression = suppressionState.get(throttleKey);

      if (!bypassThrottling && lastSuppression) {
        const elapsed = currentTime - lastSuppression.lastSentAt;
        const lastWeight = SEVERITY_LEVELS[lastSuppression.lastSeverity] ?? 0;
        const currentWeight = SEVERITY_LEVELS[severity] ?? 0;

        // Escalation check: if severity increased, allow immediate delivery
        if (currentWeight > lastWeight) {
          suppressionState.set(throttleKey, {
            lastSentAt: currentTime,
            lastSeverity: severity,
            suppressionCount: 0,
          });
        } else if (elapsed < throttleWindowMs) {
          // Throttled / Repeated alert suppressed!
          lastSuppression.suppressionCount += 1;
          const record = recordDelivery({
            eventId,
            eventType,
            severity,
            category,
            recipient: { id: recipient.id, role: recipient.role, email: recipient.email },
            channel: 'throttle',
            status: DELIVERY_STATUS.SUPPRESSED,
            title: maskedTitle,
            message: maskedMessage,
            details: {
              ...baseDetails,
              targetKey,
              throttleWindowMs,
              suppressionCount: lastSuppression.suppressionCount,
              reason: 'throttled_within_window',
            },
          });
          deliveryResults.push(record);
          continue;
        } else {
          // Window expired, update suppression state
          suppressionState.set(throttleKey, {
            lastSentAt: currentTime,
            lastSeverity: severity,
            suppressionCount: 0,
          });
        }
      } else if (!bypassThrottling) {
        suppressionState.set(throttleKey, {
          lastSentAt: currentTime,
          lastSeverity: severity,
          suppressionCount: 0,
        });
      }

      // 4. Dispatch through active channels
      // A. Panel Feed
      const shouldSendPanel = eventInput.isTest
        ? eventInput.testChannel === NOTIFICATION_CHANNELS.PANEL
        : prefs.channels.panel?.enabled !== false;
      if (shouldSendPanel) {
        const panelOutcome = sendPanelDelivery({
          recipient,
          event,
          maskedTitle,
          maskedMessage,
          maskedDetails,
        });
        const record = recordDelivery({
          eventId,
          eventType,
          severity,
          category,
          recipient: { id: recipient.id, role: recipient.role, email: recipient.email },
          channel: NOTIFICATION_CHANNELS.PANEL,
          status: panelOutcome.status,
          title: maskedTitle,
          message: maskedMessage,
          details: { ...baseDetails, feedItemId: panelOutcome.feedItemId },
        });
        deliveryResults.push(record);
      }

      // B. Email
      const shouldSendEmail = eventInput.isTest
        ? eventInput.testChannel === NOTIFICATION_CHANNELS.EMAIL
        : prefs.channels.email?.enabled !== false;
      if (shouldSendEmail) {
        const emailOutcome = await sendEmailDelivery({
          recipient,
          event,
          prefs,
          maskedTitle,
          maskedMessage,
          maskedDetails,
        });
        const record = recordDelivery({
          eventId,
          eventType,
          severity,
          category,
          recipient: { id: recipient.id, role: recipient.role, email: emailOutcome.recipientAddress || recipient.email },
          channel: NOTIFICATION_CHANNELS.EMAIL,
          status: emailOutcome.status,
          messageId: emailOutcome.messageId ?? null,
          error: emailOutcome.error ?? null,
          title: maskedTitle,
          message: maskedMessage,
          details: { ...baseDetails },
        });
        deliveryResults.push(record);
      }

      // C. Webhook
      const shouldSendWebhook = eventInput.isTest
        ? eventInput.testChannel === NOTIFICATION_CHANNELS.WEBHOOK
        : (prefs.channels.webhook?.enabled === true && Boolean(prefs.channels.webhook?.url || event.details?.targetUrl));
      if (shouldSendWebhook) {
        const webhookOutcome = await sendWebhookDelivery({
          recipient,
          event,
          prefs,
          maskedTitle,
          maskedMessage,
          maskedDetails,
        });
        const record = recordDelivery({
          eventId,
          eventType,
          severity,
          category,
          recipient: { id: recipient.id, role: recipient.role },
          channel: NOTIFICATION_CHANNELS.WEBHOOK,
          status: webhookOutcome.status,
          messageId: webhookOutcome.messageId ?? null,
          error: webhookOutcome.error ?? null,
          title: maskedTitle,
          message: maskedMessage,
          details: { ...baseDetails, targetUrl: webhookOutcome.targetUrl },
        });
        deliveryResults.push(record);
      }
    }

    return {
      eventId,
      eventType,
      severity,
      category,
      deliveries: deliveryResults,
    };
  }

  async function dispatchTestNotification({
    actor,
    channel = NOTIFICATION_CHANNELS.EMAIL,
    target = null,
    message = null,
  } = {}) {
    const actorTenant = actor ? extractActorTenant(actor) : { id: 'usr-admin', role: 'owner', email: defaultOwnerEmail };

    const testEvent = {
      eventType: NOTIFICATION_EVENT_TYPES.TEST_NOTIFICATION,
      severity: NOTIFICATION_SEVERITY.INFO,
      category: NOTIFICATION_CATEGORIES.SYSTEM,
      title: 'YunPanel — Test Bildirimi',
      message: message || 'Bu bir teslim doğrulama test bildirimidir.',
      bypassThrottling: true,
      bypassPreferences: true,
      isTest: true,
      testChannel: channel,
      recipients: [
        {
          id: actorTenant.id,
          role: actorTenant.role,
          email: channel === 'email' ? (target || actorTenant.email || defaultOwnerEmail) : (actorTenant.email || defaultOwnerEmail),
          isGlobal: actorTenant.isGlobal ?? true,
          active: true,
        },
      ],
      details: {
        channel,
        testMode: true,
        targetUrl: channel === 'webhook' ? target : null,
      },
    };

    if (channel === NOTIFICATION_CHANNELS.EMAIL) {
      testEvent.category = NOTIFICATION_CATEGORIES.SYSTEM;
    }

    const res = await dispatch(testEvent);
    const channelDelivery = res.deliveries.find((d) => d.channel === channel) || res.deliveries[0];

    return {
      delivered: channelDelivery?.status === DELIVERY_STATUS.DELIVERED,
      status: channelDelivery?.status || DELIVERY_STATUS.FAILED,
      channel,
      recipient: channelDelivery?.recipient?.email || target || actorTenant.email,
      messageId: channelDelivery?.messageId || null,
      error: channelDelivery?.error || null,
      timestamp: channelDelivery?.timestamp || new Date(now()).toISOString(),
    };
  }

  async function checkCertificateExpirations({ now: checkNow = now(), daysWarning = 30, daysCritical = 7 } = {}) {
    if (!certificateRegistry || typeof certificateRegistry.listCertificates !== 'function') {
      return { checked: 0, dispatched: [] };
    }

    const certificates = await certificateRegistry.listCertificates();
    const dispatched = [];
    const currentTime = typeof checkNow === 'function' ? checkNow() : checkNow;

    for (const cert of certificates) {
      if (cert.state === 'error') {
        const res = await dispatch({
          eventType: NOTIFICATION_EVENT_TYPES.SSL_RENEWAL_FAILED,
          severity: NOTIFICATION_SEVERITY.CRITICAL,
          title: `SSL Yenileme Hatası: ${cert.certName || cert.id}`,
          message: `Sertifika yenileme işlemi başarısız oldu: ${cert.lastError || 'Bilinmeyen hata'}`,
          targetKey: `cert:${cert.id}`,
          details: {
            certificateId: cert.id,
            certName: cert.certName,
            domains: cert.domains,
            error: cert.lastError,
          },
        });
        dispatched.push(res);
        continue;
      }

      if (cert.lastReloadOutcome && cert.lastReloadOutcome.status !== 'succeeded') {
        const isPartial = cert.lastReloadOutcome.status === 'partial';
        const res = await dispatch({
          eventType: NOTIFICATION_EVENT_TYPES.SSL_RENEWAL_FAILED,
          severity: isPartial ? NOTIFICATION_SEVERITY.WARNING : NOTIFICATION_SEVERITY.CRITICAL,
          title: `SSL Servis Yeniden Yükleme Uyarısı: ${cert.certName || cert.id}`,
          message: `Sertifika uygulandı ancak servis yeniden yükleme kısmi veya hatalı: ${cert.lastReloadOutcome.service}`,
          targetKey: `cert:${cert.id}`,
          details: {
            certificateId: cert.id,
            service: cert.lastReloadOutcome.service,
            status: cert.lastReloadOutcome.status,
            error: cert.lastReloadOutcome.error,
          },
        });
        dispatched.push(res);
      }

      if (!cert.validTo) continue;

      const expiresAt = Date.parse(cert.validTo);
      if (!Number.isFinite(expiresAt)) continue;

      const msRemaining = expiresAt - currentTime;
      const daysRemaining = Math.floor(msRemaining / (24 * 60 * 60 * 1000));

      if (daysRemaining <= 0) {
        const res = await dispatch({
          eventType: NOTIFICATION_EVENT_TYPES.SSL_CERTIFICATE_EXPIRED,
          severity: NOTIFICATION_SEVERITY.CRITICAL,
          title: `SSL Sertifikası Süresi Doldu: ${cert.certName || cert.id}`,
          message: `${cert.certName || cert.id} sertifikasının geçerlilik süresi dolmuştur. Web siteniz güvensiz görünebilir!`,
          targetKey: `cert:${cert.id}`,
          details: {
            certificateId: cert.id,
            certName: cert.certName,
            domains: cert.domains,
            validTo: cert.validTo,
            daysRemaining: 0,
          },
        });
        dispatched.push(res);
      } else if (daysRemaining <= daysCritical) {
        const res = await dispatch({
          eventType: NOTIFICATION_EVENT_TYPES.SSL_CERTIFICATE_CRITICAL,
          severity: NOTIFICATION_SEVERITY.CRITICAL,
          title: `Kritik SSL Süre Sonu: ${cert.certName || cert.id} (${daysRemaining} gün kaldı)`,
          message: `${cert.certName || cert.id} sertifikasının süresi ${daysRemaining} gün içinde dolacaktır.`,
          targetKey: `cert:${cert.id}`,
          details: {
            certificateId: cert.id,
            certName: cert.certName,
            domains: cert.domains,
            validTo: cert.validTo,
            daysRemaining,
          },
        });
        dispatched.push(res);
      } else if (daysRemaining <= daysWarning) {
        const res = await dispatch({
          eventType: NOTIFICATION_EVENT_TYPES.SSL_CERTIFICATE_EXPIRING,
          severity: NOTIFICATION_SEVERITY.WARNING,
          title: `SSL Sertifikası Süre Sonu Yaklaşıyor: ${cert.certName || cert.id} (${daysRemaining} gün kaldı)`,
          message: `${cert.certName || cert.id} sertifikasının süresi ${daysRemaining} gün içinde dolacaktır.`,
          targetKey: `cert:${cert.id}`,
          details: {
            certificateId: cert.id,
            certName: cert.certName,
            domains: cert.domains,
            validTo: cert.validTo,
            daysRemaining,
          },
        });
        dispatched.push(res);
      }
    }

    return {
      checked: certificates.length,
      dispatched,
    };
  }

  async function checkDiskAndInodeThresholds({ disks = [], serverId = localServerId, now: checkNow = now() } = {}) {
    const dispatched = [];
    if (!Array.isArray(disks)) return { checked: 0, dispatched };

    for (const disk of disks) {
      const mount = disk.mountPoint || disk.path || '/';
      const diskPercent = disk.usagePercent ?? (disk.totalBytes ? Math.round((disk.usedBytes / disk.totalBytes) * 100) : 0);
      const inodePercent = disk.inodeUsagePercent ?? (disk.totalInodes ? Math.round((disk.usedInodes / disk.totalInodes) * 100) : 0);

      // Disk usage check
      if (diskPercent >= diskCriticalThresholdPercent) {
        const res = await dispatch({
          eventType: NOTIFICATION_EVENT_TYPES.DISK_THRESHOLD_CRITICAL,
          severity: NOTIFICATION_SEVERITY.CRITICAL,
          title: `Kritik Disk Alanı Uyarısı: ${mount} (${diskPercent}%)`,
          message: `${mount} bağlama noktasındaki disk kullanımı %${diskPercent} kritik seviyesine ulaştı!`,
          targetKey: `disk:${mount}`,
          serverId,
          details: {
            mountPoint: mount,
            usagePercent: diskPercent,
            usedBytes: disk.usedBytes,
            totalBytes: disk.totalBytes,
          },
        });
        dispatched.push(res);
      } else if (diskPercent >= diskWarningThresholdPercent) {
        const res = await dispatch({
          eventType: NOTIFICATION_EVENT_TYPES.DISK_THRESHOLD_WARNING,
          severity: NOTIFICATION_SEVERITY.WARNING,
          title: `Yüksek Disk Alanı Uyarısı: ${mount} (${diskPercent}%)`,
          message: `${mount} bağlama noktasındaki disk kullanımı %${diskPercent} eşiğini aştı.`,
          targetKey: `disk:${mount}`,
          serverId,
          details: {
            mountPoint: mount,
            usagePercent: diskPercent,
            usedBytes: disk.usedBytes,
            totalBytes: disk.totalBytes,
          },
        });
        dispatched.push(res);
      }

      // Inode usage check
      if (inodePercent >= inodeCriticalThresholdPercent) {
        const res = await dispatch({
          eventType: NOTIFICATION_EVENT_TYPES.INODE_THRESHOLD_CRITICAL,
          severity: NOTIFICATION_SEVERITY.CRITICAL,
          title: `Kritik Inode Kullanımı Uyarısı: ${mount} (${inodePercent}%)`,
          message: `${mount} bağlama noktasındaki inode kullanımı %${inodePercent} kritik seviyesine ulaştı! Dosya oluşturma kilitlenebilir.`,
          targetKey: `inode:${mount}`,
          serverId,
          details: {
            mountPoint: mount,
            inodeUsagePercent: inodePercent,
            usedInodes: disk.usedInodes,
            totalInodes: disk.totalInodes,
          },
        });
        dispatched.push(res);
      } else if (inodePercent >= inodeWarningThresholdPercent) {
        const res = await dispatch({
          eventType: NOTIFICATION_EVENT_TYPES.INODE_THRESHOLD_WARNING,
          severity: NOTIFICATION_SEVERITY.WARNING,
          title: `Yüksek Inode Kullanımı Uyarısı: ${mount} (${inodePercent}%)`,
          message: `${mount} bağlama noktasındaki inode kullanımı %${inodePercent} eşiğini aştı.`,
          targetKey: `inode:${mount}`,
          serverId,
          details: {
            mountPoint: mount,
            inodeUsagePercent: inodePercent,
            usedInodes: disk.usedInodes,
            totalInodes: disk.totalInodes,
          },
        });
        dispatched.push(res);
      }
    }

    return {
      checked: disks.length,
      dispatched,
    };
  }

  async function notifyBackupFailure({
    websiteId,
    repositoryId = null,
    operationId = null,
    operationType = 'backup',
    error = null,
    actor = null,
  } = {}) {
    const isRestore = operationType === 'restore';
    const eventType = isRestore
      ? NOTIFICATION_EVENT_TYPES.RESTORE_FAILED
      : NOTIFICATION_EVENT_TYPES.BACKUP_FAILED;
    const actionName = isRestore ? 'Geri yükleme' : 'Yedekleme';

    const errCode = error?.code || `${operationType}_failed`;
    const errMsg = error?.message || 'Operation failed unexpectedly';

    return dispatch({
      eventType,
      severity: NOTIFICATION_SEVERITY.CRITICAL,
      title: `${actionName} Başarısız: Site ${websiteId}`,
      message: `${websiteId} sitesi için ${actionName.toLowerCase()} işlemi başarısız oldu: ${errMsg}`,
      websiteId,
      targetKey: `backup:${websiteId}`,
      details: {
        websiteId,
        repositoryId,
        operationId,
        operationType,
        error: { code: errCode, message: errMsg },
      },
    });
  }

  async function notifyServiceOutage({
    serviceId,
    status = 'inactive',
    critical = true,
    message = null,
    error = null,
    serverId = localServerId,
  } = {}) {
    const errorDetails = error ? (error.code ? ` (${error.code}: ${error.message || ''})` : `: ${error.message || ''}`) : '';
    const defaultMsg = `${serviceId} servisi durdu veya yanıt vermiyor (durum: ${status})${errorDetails}.`;
    return dispatch({
      eventType: NOTIFICATION_EVENT_TYPES.SERVICE_OUTAGE,
      severity: critical ? NOTIFICATION_SEVERITY.CRITICAL : NOTIFICATION_SEVERITY.WARNING,
      title: `Servis Kesintisi: ${serviceId}`,
      message: message ? (error?.code && !message.includes(error.code) ? `${message} (${error.code})` : message) : defaultMsg,
      targetKey: `service:${serviceId}`,
      serverId,
      details: {
        serviceId,
        status,
        critical,
        error: error ? { code: error.code, message: error.message } : null,
      },
    });
  }

  function getDeliveryHistory({ actor = null, filter = {}, limit = 100 } = {}) {
    const actorTenant = actor ? extractActorTenant(actor) : { isGlobal: true, isOwner: true };
    const maxEntries = Math.min(Math.max(1, Number(limit) || 100), 500);

    const filtered = deliveryLog.filter((entry) => {
      // 1. Tenant boundary filtering
      if (!actorTenant.isGlobal && !actorTenant.isOwner) {
        if (actorTenant.isCustomer) {
          const isOwnRecipient = entry.recipient?.id === actorTenant.id;
          const isOwnSite = entry.details?.websiteId && Array.isArray(actorTenant.websiteIds) && actorTenant.websiteIds.includes(entry.details.websiteId);
          if (!isOwnRecipient && !isOwnSite) return false;
        } else if (actorTenant.isReseller) {
          const isOwnRecipient = entry.recipient?.id === actorTenant.id;
          const isOwnSite = entry.details?.websiteId && Array.isArray(actorTenant.websiteIds) && actorTenant.websiteIds.includes(entry.details.websiteId);
          if (!isOwnRecipient && !isOwnSite) return false;
        } else if (actorTenant.isLegacySiteManager) {
          const isOwnSite = entry.details?.websiteId && Array.isArray(actorTenant.websiteIds) && actorTenant.websiteIds.includes(entry.details.websiteId);
          if (!isOwnSite) return false;
        }
      }

      // 2. Query filters
      if (filter.eventType && entry.eventType !== filter.eventType) return false;
      if (filter.severity && entry.severity !== filter.severity) return false;
      if (filter.channel && entry.channel !== filter.channel) return false;
      if (filter.status && entry.status !== filter.status) return false;
      if (filter.websiteId && entry.details?.websiteId !== filter.websiteId) return false;

      return true;
    });

    return filtered.slice(-maxEntries).reverse();
  }

  function clearThrottling() {
    suppressionState.clear();
  }

  function getStatus() {
    return {
      status: 'active',
      channels: {
        email: { available: Boolean(authMailer) },
        webhook: { available: Boolean(fetchFn) },
        panel: { available: true },
      },
      stats: {
        totalLoggedDeliveries: deliveryLog.length,
        activeThrottledKeys: suppressionState.size,
      },
    };
  }

  return {
    dispatch,
    dispatchTestNotification,
    checkCertificateExpirations,
    checkDiskAndInodeThresholds,
    notifyBackupFailure,
    notifyServiceOutage,
    getPreferences,
    updatePreferences,
    getDeliveryHistory,
    clearThrottling,
    getStatus,
  };
}

export const operationalNotificationInternals = Object.freeze({
  DEFAULT_THROTTLE_WINDOW_MS,
  DEFAULT_DISK_WARNING_PERCENT,
  DEFAULT_DISK_CRITICAL_PERCENT,
  DEFAULT_INODE_WARNING_PERCENT,
  DEFAULT_INODE_CRITICAL_PERCENT,
});
