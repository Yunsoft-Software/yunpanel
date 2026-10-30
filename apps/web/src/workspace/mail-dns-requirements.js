// The delivery diagnostics API returns the inspector's `state` per record.
const VALID_STATES = new Set(['present', 'ready']);

export function mailDnsRequirementStatus(entry) {
  if (VALID_STATES.has(entry?.state)) return 'valid';
  if (entry?.state === 'not_configured') return 'unconfigured';
  return 'invalid';
}

export function dmarcPolicy(entry) {
  if (mailDnsRequirementStatus(entry) !== 'valid') return null;
  const record = Array.isArray(entry.current) ? entry.current[0] : null;
  return typeof record === 'string' ? record.match(/(?:^|;)\s*p=([a-z]+)/i)?.[1]?.toLowerCase() ?? null : null;
}
