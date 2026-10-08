export const mockDomains = [];
for (let i = 1; i <= 12; i++) {
  const name = i === 1 ? 'şirket-ana.com' : i === 2 ? 'istanbul-ticaret.com' : `yerel-domain-${i}.com`;
  mockDomains.push({
    id: `local-${i}`,
    domainName: name,
    managementMode: 'local',
    status: 'enabled',
    revision: 2,
    updatedAt: '2026-10-01T00:00:00Z',
    lastObservedAt: '2026-10-01T00:00:00Z',
  });
}
for (let i = 1; i <= 8; i++) {
  mockDomains.push({
    id: `ext-${i}`,
    domainName: `harici-mail-${i}.net`,
    managementMode: 'external',
    status: 'ready',
    revision: 1,
    updatedAt: '2026-10-01T00:00:00Z',
    lastObservedAt: '2026-10-01T00:00:00Z',
  });
}

export const mockMailboxes = [
  { id: 'mb-1', mailDomainId: 'local-1', address: 'admin@şirket-ana.com', enabled: true, revision: 1 },
  { id: 'mb-2', mailDomainId: 'local-1', address: 'info@şirket-ana.com', enabled: true, revision: 1 },
];

export const mockAliases = [
  { id: 'al-1', mailDomainId: 'local-1', source: 'iletisim@şirket-ana.com', destinations: ['admin@şirket-ana.com'], enabled: true, revision: 1 },
];

export const mockWebmailMapping = {
  hostname: 'webmail.şirket-ana.com',
  state: 'active',
  certificateId: 'cert-1',
  revision: 1,
  updatedAt: '2026-10-01T00:00:00Z',
};

export const mockCertificates = [
  { id: 'cert-1', primaryDomain: 'webmail.şirket-ana.com', domains: ['webmail.şirket-ana.com'] },
];

export const mockDkim = {
  selector: 'mail',
  algorithm: 'rsa2048',
  revision: 1,
  publicKey: 'MIIBIjANBgkqhkiG9w0BAQEFAAOCAQ8AMIIBCgKCAQEA0',
  dnsRecord: { type: 'TXT', name: 'mail._domainkey.şirket-ana.com', content: 'v=DKIM1; k=rsa;' },
};

export const mockDeliveryDiagnostics = {
  connectionSettings: {
    hostname: 'mail.şirket-ana.com',
    imap: { host: 'mail.şirket-ana.com', ports: [993, 143], tls: 'SSL/TLS (Port 993)' },
    smtp: { host: 'mail.şirket-ana.com', ports: [465, 587], tls: 'SSL/TLS (Port 465)' },
    authentication: 'PLAIN / LOGIN',
  },
  reception: { canReceive: true, quota: { quotaBytes: 5368709120 } },
  dnsRequirements: {
    mx: { status: 'matched' },
    spf: { status: 'valid' },
    dkim: { status: 'valid' },
    dmarc: { status: 'valid', policy: 'reject' },
    ptr: { status: 'valid' },
  },
};

export const mockServerDiagnostics = {
  connectionSettings: {
    hostname: 'srv-1.cryptoraichu.website',
    imap: { ports: [993, 143], tls: 'SSL/TLS' },
    smtp: { ports: [465, 587, 25], tls: 'SSL/TLS' },
    authentication: 'PLAIN',
  },
  protocols: {
    protocols: [
      { id: 'smtp', port: 25, satisfied: true },
      { id: 'submissions', port: 465, satisfied: true },
      { id: 'submission', port: 587, satisfied: true },
      { id: 'imaps', port: 993, satisfied: true },
    ],
  },
};

export function createMockFetchRouter({ customHandler } = {}) {
  const apiCalls = [];
  const fetchMock = async (url, options = {}) => {
    const u = String(url);
    const method = options.method || 'GET';
    const body = options.body ? JSON.parse(options.body) : null;
    apiCalls.push({ url: u, method, body });

    if (customHandler) {
      const customResponse = await customHandler(u, method, body, options);
      if (customResponse !== undefined) return customResponse;
    }

    if (u.includes('/mail-domains/local-1/webmail')) {
      return new Response(JSON.stringify({ data: { mapping: mockWebmailMapping, job: null } }), { status: 200, headers: { 'content-type': 'application/json' } });
    }
    if (u.includes('/certificates')) {
      return new Response(JSON.stringify({ data: mockCertificates }), { status: 200, headers: { 'content-type': 'application/json' } });
    }
    if (u.includes('/mail-domains/local-1/dkim')) {
      return new Response(JSON.stringify({ data: mockDkim }), { status: 200, headers: { 'content-type': 'application/json' } });
    }
    if (u.includes('/mail-domains/local-1/diagnostics/delivery')) {
      return new Response(JSON.stringify({ data: mockDeliveryDiagnostics }), { status: 200, headers: { 'content-type': 'application/json' } });
    }
    if (u.includes('/mail-domains/local-1/diagnostics')) {
      return new Response(JSON.stringify({ data: { attentionRequired: false, diagnostics: { dkim: { state: 'ready' } } } }), { status: 200, headers: { 'content-type': 'application/json' } });
    }
    if (u.includes('/mail-domains/local-1')) {
      return new Response(JSON.stringify({ data: mockDomains[0] }), { status: 200, headers: { 'content-type': 'application/json' } });
    }
    if (u.includes('/mailboxes/mb-1/diagnostics/delivery')) {
      return new Response(JSON.stringify({ data: mockDeliveryDiagnostics }), { status: 200, headers: { 'content-type': 'application/json' } });
    }
    if (u.includes('/mailboxes')) {
      return new Response(JSON.stringify({ data: mockMailboxes }), { status: 200, headers: { 'content-type': 'application/json' } });
    }
    if (u.includes('/mail-aliases')) {
      return new Response(JSON.stringify({ data: mockAliases }), { status: 200, headers: { 'content-type': 'application/json' } });
    }
    if (u.includes('/roundcube/config-preview')) {
      return new Response(JSON.stringify({
        data: {
          readyToApply: true,
          webEndpoint: 'https://webmail.şirket-ana.com',
          sha256: 'rc-sha-321',
          configuration: { sha256: 'rc-cfg-321' },
          fpm: { sha256: 'rc-fpm-321' },
        },
      }), { status: 200, headers: { 'content-type': 'application/json' } });
    }
    if (u.includes('/servers/srv-1/mail/diagnostics/delivery')) {
      return new Response(JSON.stringify({ data: mockServerDiagnostics }), { status: 200, headers: { 'content-type': 'application/json' } });
    }
    if (u.includes('/servers/srv-1/mail/queue')) {
      return new Response(JSON.stringify({ data: { items: [] } }), { status: 200, headers: { 'content-type': 'application/json' } });
    }
    if (u.includes('/servers/srv-1/logs/')) {
      return new Response(JSON.stringify({ data: { entries: [] } }), { status: 200, headers: { 'content-type': 'application/json' } });
    }
    if (u.includes('/mail-domains')) {
      return new Response(JSON.stringify({ data: mockDomains }), { status: 200, headers: { 'content-type': 'application/json' } });
    }
    return new Response(JSON.stringify({ data: null }), { status: 200, headers: { 'content-type': 'application/json' } });
  };

  return { fetchMock, apiCalls };
}
