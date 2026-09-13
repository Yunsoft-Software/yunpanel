const ENV_KEY = /^[A-Za-z_][A-Za-z0-9_]{0,127}$/;

export function parseDockerEnvironmentText(value) {
  if (typeof value !== 'string') throw new Error('Environment content is required');
  const variables = {};
  for (const [index, raw] of value.split(/\r?\n/).entries()) {
    if (!raw.trim()) continue;
    const separator = raw.indexOf('=');
    if (separator <= 0) throw new Error(`Satır ${index + 1}: KEY=value biçimi gerekli.`);
    const key = raw.slice(0, separator).trim();
    const variableValue = raw.slice(separator + 1);
    if (!ENV_KEY.test(key)) throw new Error(`Satır ${index + 1}: geçersiz environment anahtarı.`);
    if (Object.hasOwn(variables, key)) throw new Error(`Satır ${index + 1}: ${key} birden fazla tanımlandı.`);
    variables[key] = variableValue;
  }
  return variables;
}

export const dockerComposeModelInternals = Object.freeze({ environmentKeyPattern: ENV_KEY });
