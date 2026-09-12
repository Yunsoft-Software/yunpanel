const PASSWD_FIELDS = 7;

export function parseManagedVmailIdentity(value) {
  const output = String(value ?? '').trim();
  const fields = output.split(':');
  if (fields.length !== PASSWD_FIELDS || fields[0] !== 'vmail'
    || !/^\d+$/.test(fields[2]) || !/^\d+$/.test(fields[3])) return null;
  const uid = Number.parseInt(fields[2], 10);
  const gid = Number.parseInt(fields[3], 10);
  if (!Number.isSafeInteger(uid) || uid < 0 || !Number.isSafeInteger(gid) || gid < 0) return null;
  return Object.freeze({ uid, gid });
}
