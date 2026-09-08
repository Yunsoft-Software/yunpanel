import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import path from 'node:path';

function validateIdentity(identity) {
  if (!identity || typeof identity !== 'object') throw new Error('Agent identity is invalid');
  if (typeof identity.serverId !== 'string' || identity.serverId.length < 1) throw new Error('Agent serverId is invalid');
  if (typeof identity.agentToken !== 'string' || identity.agentToken.length < 20) throw new Error('Agent token is invalid');
  if (typeof identity.controlPlaneUrl !== 'string' || identity.controlPlaneUrl.length < 1) {
    throw new Error('Agent control plane URL is invalid');
  }
  return identity;
}

export async function loadAgentIdentity(filePath) {
  try {
    const raw = await readFile(filePath, 'utf8');
    return validateIdentity(JSON.parse(raw));
  } catch (error) {
    if (error?.code === 'ENOENT') return null;
    throw error;
  }
}

export async function saveAgentIdentity(filePath, identity) {
  validateIdentity(identity);

  const directory = path.dirname(filePath);
  const temporaryPath = `${filePath}.${process.pid}.tmp`;
  await mkdir(directory, { recursive: true });
  await writeFile(temporaryPath, `${JSON.stringify(identity, null, 2)}\n`, {
    encoding: 'utf8',
    mode: 0o600,
  });
  await rename(temporaryPath, filePath);
}
