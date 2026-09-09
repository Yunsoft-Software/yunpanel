// Public diagnostics must be authored here, not copied from child-process,
// filesystem or application exceptions. Even an error.code may contain a secret.
const messages = Object.freeze({
  apt_failed: 'The APT operation failed.',
  apt_inspection_failed: 'Unable to inspect the YunPanel APT package.',
  apt_update_failed: 'APT package indexes could not be refreshed.',
  yunpanel_not_packaged: 'YunPanel is not installed as an APT package.',
  yunpanel_upgrade_failed: 'APT could not upgrade the YunPanel package.',
  yunpanel_upgrade_incomplete: 'The expected YunPanel package update could not be confirmed.',
  upgrade_in_progress: 'A YunPanel package upgrade is already running.',
  restart_schedule_failed: 'YunPanel was upgraded but its service restart could not be scheduled.',
  invalid_domain_spec: 'The domain configuration is invalid.',
  invalid_target_type: 'The domain target type is invalid.',
  invalid_checksum: 'A valid staging checksum is required.',
  staged_config_missing: 'Staged Nginx configuration was not found.',
  staged_config_changed: 'Staged Nginx configuration changed before activation.',
  nginx_config_invalid: 'Nginx rejected the staged configuration.',
  nginx_reload_failed: 'Nginx reload failed; the manager reported restoring the previous configuration.',
  nginx_rollback_failed: 'Nginx reload failed and rollback could not be confirmed.',
  invalid_certificate_domains: 'The certificate hostname list is invalid.',
  wildcard_not_supported: 'Wildcard certificates require an implemented DNS-01 adapter.',
  invalid_acme_email: 'The ACME account email is invalid.',
  certificate_not_found: 'Issued certificate metadata could not be read.',
  invalid_certificate_file: 'The issued certificate file is invalid.',
  certbot_not_installed: 'Certbot is not installed on the managed server.',
  certbot_failed: 'The Certbot operation failed. Check DNS and the protected host diagnostics.',
  invalid_node_status: 'The Node status specification is invalid.',
  node_status_current_missing: 'The Node application does not have a valid active release.',
  node_status_release_drift: 'The active Node release does not match the stored application state.',
  systemd_not_available: 'systemctl is not available on the managed server.',
  local_operation_not_migrated: 'This operation has not been migrated to the local runtime.',
  invalid_local_operation_payload: 'The local operation payload is invalid.',
  EACCES: 'The host denied access to a required resource.',
  EPERM: 'The host rejected a required operation.',
  ENOSPC: 'The host has insufficient storage for this operation.',
  EROFS: 'A required filesystem is read-only.',
  ENOENT: 'A required host file or executable was not found.',
});

export function safeLocalOperationError(error) {
  let code;
  try { code = error?.code; } catch { /* Never invoke message/stack serialization. */ }
  return typeof code === 'string' && Object.hasOwn(messages, code)
    ? { code, message: messages[code] }
    : { code: 'local_operation_failed', message: 'Local host operation failed. Inspect protected host diagnostics before retrying.' };
}
