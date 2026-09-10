// Transport mapping is separate from validation and persistence so parent/Website
// references and error propagation can be tested without a network listener.
export function createDomainHandler(domainRegistry) {
  return async (request, response, next) => {
    try {
      const domain = await domainRegistry.createDomain({
        serverId: request.body?.serverId,
        websiteId: request.body?.websiteId ?? null,
        primaryDomain: request.body?.primaryDomain,
        parentDomainId: request.body?.parentDomainId ?? null,
        aliases: request.body?.aliases ?? [],
        targetType: request.body?.targetType,
        target: request.body?.target,
        httpsMode: request.body?.httpsMode ?? 'off',
      });
      return response.status(201).json({ data: domain });
    } catch (error) {
      return next(error);
    }
  };
}
