export function deterministicWebsiteMailDkimSelector(operationId) {
  if (typeof operationId !== 'string' || !/^[0-9a-f-]{36}$/i.test(operationId)) {
    throw new Error('Website mail DKIM selector requires a valid provisioning operation identity');
  }
  return `yp-${operationId.toLowerCase().replaceAll('-', '').slice(0, 24)}`;
}
