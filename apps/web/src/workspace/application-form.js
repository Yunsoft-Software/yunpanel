export function applicationCreatePayload(form, servers) {
  if (servers.length !== 1) throw new Error('Yerel sunucu kullanılamıyor.');
  const serverId = servers[0].id;
  if (form.serverId && form.serverId !== serverId) throw new Error('Yalnızca bu panel sunucusu yönetilebilir.');
  if (!['static', 'node'].includes(form.type)) throw new Error('Uygulama türü geçersiz.');
  const name = form.name.trim();
  if (!name || name.length > 80) throw new Error('Uygulama adı 1–80 karakter olmalıdır.');
  const body = { serverId, type: form.type, name, repositoryUrl: form.repositoryUrl.trim(), branch: form.branch.trim(), retention: 5 };
  if (form.type === 'static') body.build = { mode: 'npm', installMode: 'ci', buildScript: 'build', outputDir: form.outputDir.trim(), healthFile: 'index.html' };
  else {
    const port = Number(form.port);
    if (!Number.isInteger(port) || port < 1024 || port > 65535) throw new Error('Port 1024–65535 aralığında olmalıdır.');
    body.runtime = { nodeMajor: 24, installMode: 'ci', buildScript: null, startMode: 'node', entryFile: form.entryFile.trim(), port, healthPath: form.healthPath.trim(), healthTimeoutSeconds: 30, restartPolicy: 'on-failure' };
  }
  return body;
}
