export function deterministicWebsiteMailDkimSelector(operationId) {
  if (typeof operationId !== 'string') {
    throw new Error('Website mail DKIM selector requires a valid provisioning operation identity');
  }
  const parts = operationId.toLowerCase().split('-');
  const compact = parts.join('');
  const valid = parts.length === 5
    && parts.map((part) => part.length).join(',') === '8,4,4,4,12'
    && /^[0-9a-f]{32}$/.test(compact)
    && /^[1-5]$/.test(parts[2][0] ?? '')
    && /^[89ab]$/.test(parts[3][0] ?? '');
  if (!valid) {
    throw new Error('Website mail DKIM selector requires a valid provisioning operation identity');
  }
  return `yp-${compact.slice(0, 24)}`;
}
