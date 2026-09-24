import assert from 'node:assert/strict';
import test from 'node:test';
import { createWebsitePhpToolsService } from '../src/website-php-tools-service.js';
import { phpToolsStatus } from '../../web/src/workspace/php-tools-model.js';
const websiteId = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', applicationId = '11111111-1111-4111-8111-111111111111';
const scope = { websiteId, applicationId, serverId: '22222222-2222-4222-8222-222222222222', unixUser: 'yunapp-0123456789ab' };
for (const scenario of ['ready', 'missing-tool', 'failed-command', 'malformed-list', 'missing-project']) {
  test(`real service response fits UI contract: ${scenario}`, async () => {
    const tool = async () => ({ available: scenario !== 'missing-tool', version: scenario === 'missing-tool' ? null : '2.8.1' });
    const command = async ({ command, args }) => scenario === 'failed-command' ? { success: false, exitCode: 1 } : {
      success: true, exitCode: 0, stdout: args?.[0] === 'version' ? '6.4.2' : ['plugin', 'theme'].includes(command) ? (scenario === 'malformed-list' ? '{}' : '[]') : '',
    };
    const service = createWebsitePhpToolsService({
      websiteRegistry: { getWebsite: async () => ({ ...scope, id: websiteId, runtimeType: 'php' }) },
      applicationRegistry: { getApplication: async () => ({ id: applicationId, serverId: scope.serverId, unixUser: scope.unixUser, type: 'php' }) },
      phpCliToolManager: { inspectWpCli: tool, inspectComposer: tool, runWpCli: command, runComposer: command },
      lstatFn: async (path) => {
        if (scenario === 'missing-project' && path.endsWith('composer.json')) throw Object.assign(new Error(), { code: 'ENOENT' });
        return { isDirectory: () => path.endsWith('/public'), isFile: () => !path.endsWith('/public') };
      },
    });
    for (const [toolName, method] of [['wordpress', 'getWpCliStatus'], ['composer', 'getComposerStatus']]) {
      const result = await service[method](websiteId);
      const projected = phpToolsStatus(toolName, result, scope);
      assert.equal(projected.websiteId, websiteId); assert.equal(projected.serverId, scope.serverId);
    }
  });
}
