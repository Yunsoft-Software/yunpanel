const PASSWD_FIELDS = 7;
const IDENTITY_NAME_PATTERN = /^[a-z_][a-z0-9_-]{0,31}$/;

export function parseManagedSystemIdentity(value, expectedName) {
  if (typeof expectedName !== 'string' || !IDENTITY_NAME_PATTERN.test(expectedName)) return null;
  const output = String(value ?? '').trim();
  const fields = output.split(':');
  if (fields.length !== PASSWD_FIELDS || fields[0] !== expectedName
    || !/^\d+$/.test(fields[2]) || !/^\d+$/.test(fields[3])) return null;
  const uid = Number.parseInt(fields[2], 10);
  const gid = Number.parseInt(fields[3], 10);
  if (!Number.isSafeInteger(uid) || uid <= 0 || !Number.isSafeInteger(gid) || gid <= 0) return null;
  return Object.freeze({ uid, gid });
}

export function parseManagedVmailIdentity(value) {
  return parseManagedSystemIdentity(value, 'vmail');
}


export function parseManagedSystemGroup(value, expectedName) {
  if (typeof expectedName !== 'string' || !IDENTITY_NAME_PATTERN.test(expectedName)) return null;
  const output = String(value ?? '').trim();
  const fields = output.split(':');
  if (fields.length !== 4 || fields[0] !== expectedName || !/^\d+$/.test(fields[2])) return null;
  const gid = Number.parseInt(fields[2], 10);
  if (!Number.isSafeInteger(gid) || gid <= 0) return null;
  const members = fields[3] === ''
    ? Object.freeze([])
    : Object.freeze(fields[3].split(',').filter(Boolean).sort());
  if (new Set(members).size !== members.length
    || members.some((member) => !IDENTITY_NAME_PATTERN.test(member))) return null;
  return Object.freeze({ gid, members });
}
