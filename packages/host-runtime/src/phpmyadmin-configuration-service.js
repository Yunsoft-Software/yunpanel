import { randomUUID } from 'node:crypto';
import { previewPhpMyAdminFpmPool, previewPhpMyAdminNginxConfig, previewPhpMyAdminSignonConfig, previewPhpMyAdminSignonBridge,
  renderPhpMyAdminFpmPool, renderPhpMyAdminNginxConfig, renderPhpMyAdminSignonConfig, renderPhpMyAdminSignonBridge } from '@yunpanel/config-templates';
import { createPhpMyAdminConfigManager } from './phpmyadmin-config-manager.js';
import { createPhpMyAdminConfigActivator } from './phpmyadmin-config-activator.js';

export function createPhpMyAdminConfigurationService({ configManager = createPhpMyAdminConfigManager(), activator = null } = {}) {
  const engine = activator ?? createPhpMyAdminConfigActivator({ configManager });
  async function configure({ transactionId = randomUUID() } = {}) {
    const preview = { version: 1, fpm: previewPhpMyAdminFpmPool(), nginx: previewPhpMyAdminNginxConfig(),
      signonConfig: previewPhpMyAdminSignonConfig(), signonBridge: previewPhpMyAdminSignonBridge() };
    await configManager.stageFpmPool(preview.fpm, renderPhpMyAdminFpmPool());
    await configManager.stageNginxConfig(preview.nginx, renderPhpMyAdminNginxConfig());
    await configManager.stageSignonConfig(preview.signonConfig, renderPhpMyAdminSignonConfig());
    await configManager.stageSignonBridge(preview.signonBridge, renderPhpMyAdminSignonBridge());
    const result = await engine.activateConfiguration(preview, { transactionId });
    if (result?.applied !== true || result.httpHealthy !== true || result.fpmSocketHealthy !== true || result.gatewaySocketHealthy !== true
      || result.fpmSha256 !== preview.fpm.sha256 || result.nginxSha256 !== preview.nginx.sha256
      || result.signonConfigSha256 !== preview.signonConfig.sha256 || result.signonBridgeSha256 !== preview.signonBridge.sha256) {
      throw Object.assign(new Error('phpMyAdmin yapılandırma sonucu doğrulanamadı'), { code: 'phpmyadmin_configuration_result_unverified' });
    }
    return Object.freeze({ ...result, transactionId });
  }
  return Object.freeze({ configure });
}
