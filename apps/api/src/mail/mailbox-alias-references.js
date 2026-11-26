// Deletion must consider inbound aliases outside the mailbox's own mail domain.
// Keep their identities private: callers only need the blocker count.
export async function mailboxAliasReferences(registry, mailbox) {
  const [local, all] = await Promise.all([
    registry.listAliases({ mailDomainId: mailbox.mailDomainId }),
    registry.listAliases(),
  ]);
  if (!Array.isArray(local) || !Array.isArray(all)) throw new Error('Mail alias state is unavailable');
  const references = new Map();
  for (const [entries, owned] of [[local, true], [all, false]]) {
    for (const alias of entries) {
      if (!alias || typeof alias.id !== 'string' || !alias.id || !Array.isArray(alias.destinations)
        || alias.destinations.some((address) => typeof address !== 'string')) throw new Error('Mail alias state is invalid');
      if (!alias.destinations.includes(mailbox.address)) continue;
      // The local registry query establishes scope; never expose a foreign ID.
      if (!references.has(alias.id)) references.set(alias.id, Object.freeze({ id: owned ? alias.id : null }));
    }
  }
  return Object.freeze([...references.values()]);
}
