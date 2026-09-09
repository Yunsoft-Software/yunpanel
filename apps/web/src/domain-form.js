const labelPattern = /^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/;

export function domainCreatePayload(form, domains, servers) {
  const isSubdomain = form.mode === 'subdomain';
  const parent = isSubdomain ? domains.find((domain) => domain.id === form.parentDomainId) : null;
  if (isSubdomain && !parent) throw new Error('Select an existing parent domain.');
  const serverId = isSubdomain ? parent.serverId : (form.serverId || (servers.length === 1 ? servers[0].id : null));
  if (!serverId || !servers.some((server) => server.id === serverId)) throw new Error('Select an available server.');

  let primaryDomain = form.primaryDomain.trim().toLowerCase().replace(/\.$/, '');
  if (isSubdomain) {
    const prefix = form.prefix.trim().toLowerCase();
    if (!prefix || prefix.split('.').some((label) => label.length > 63 || !labelPattern.test(label))) {
      throw new Error('Enter a valid subdomain prefix, such as api or v2.api.');
    }
    primaryDomain = `${prefix}.${parent.primaryDomain}`;
  }
  if (!primaryDomain || primaryDomain.length > 253) throw new Error('Enter a domain containing at most 253 characters.');
  const target = form.targetType === 'proxy'
    ? { upstreamHost: '127.0.0.1', upstreamPort: Number(form.targetValue), websocket: true }
    : { root: form.targetValue.trim(), spaFallback: true };
  if (form.targetType === 'proxy' && (!Number.isInteger(target.upstreamPort) || target.upstreamPort < 1024 || target.upstreamPort > 65535)) {
    throw new Error('Upstream port must be between 1024 and 65535.');
  }
  return {
    serverId, primaryDomain, parentDomainId: parent?.id ?? null,
    aliases: form.aliases.split(',').map((value) => value.trim()).filter(Boolean),
    targetType: form.targetType, target, httpsMode: form.httpsMode,
  };
}
