// View projection only; server authorization independently checks these identities.
export function siteMailDomains(mailDomains, domains, websiteId) {
  if (!websiteId || !Array.isArray(domains) || !Array.isArray(mailDomains)) return [];
  const allowed = new Set(domains.filter((item) => item?.websiteId === websiteId).map((item) => item.id));
  return mailDomains.filter((item) => item?.webDomainId && allowed.has(item.webDomainId));
}
export function mailSection(value, isOwner) {
  const allowed = isOwner ? ['mailboxes', 'aliases', 'webmail', 'dns', 'configuration'] : ['mailboxes', 'aliases', 'webmail', 'configuration'];
  return allowed.includes(value) ? value : 'mailboxes';
}
export function webmailMappingUrl(mapping) {
  if (mapping?.state !== 'active' || typeof mapping.hostname !== 'string' || mapping.hostname.length > 253) return null;
  const host = mapping.hostname;
  if (!/^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]*[a-z0-9])?)+$/i.test(host)) return null;
  if (host.split('.').some((label) => label.length > 63)) return null;
  return `https://${host}/`;
}
