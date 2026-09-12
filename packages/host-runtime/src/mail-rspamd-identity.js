const PASSWD_FIELDS = 7;

export function parseManagedRspamdIdentity(value) {
  const output = String(value ?? '').trim();
  const fields = output.split(':');
  if (fields.length !== PASSWD_FIELDS || fields[0] !== '_rspamd'
    || !/^\d+$/.test(fields[2]) || !/^\d+$/.test(fields[3])) return null;
  const uid = Number.parseInt(fields[2], 10);
  const gid = Number.parseInt(fields[3], 10);
  if (!Number.isSafeInteger(uid) || uid < 1 || !Number.isSafeInteger(gid) || gid < 1) return null;
  return Object.freeze({ uid, gid });
}
