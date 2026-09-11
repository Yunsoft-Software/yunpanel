const FALLBACKS = Object.freeze({
  nginx: Object.freeze({
    code: 'nginx_operation_failed',
    message: 'The Nginx operation failed.',
    action: 'Inspect the protected Nginx job and host diagnostics before retrying.',
  }),
  dns: Object.freeze({
    code: 'dns_operation_failed',
    message: 'The DNS provider operation failed.',
    action: 'Inspect the protected DNS job diagnostics and refresh provider state before retrying.',
  }),
  certificate: Object.freeze({
    code: 'certificate_operation_failed',
    message: 'The certificate operation failed.',
    action: 'Inspect the protected certificate job and host diagnostics before retrying.',
  }),
});

const ENTRIES = Object.freeze({
  nginx: Object.freeze({
    invalid_domain_spec: Object.freeze({ message: 'The Domain configuration is invalid.', action: 'Review the Domain target and Nginx settings, then stage a new revision.' }),
    invalid_target_type: Object.freeze({ message: 'The Domain target type is invalid.', action: 'Select a supported static or proxy target, then stage a new revision.' }),
    invalid_nginx_target_type: Object.freeze({ message: 'The Nginx settings do not match the Domain target.', action: 'Review the target-specific Nginx settings, then stage a new revision.' }),
    invalid_nginx_settings: Object.freeze({ message: 'The Nginx settings are invalid.', action: 'Review the generated settings and stage a new revision.' }),
    invalid_nginx_setting: Object.freeze({ message: 'An Nginx setting is outside the supported range.', action: 'Correct the bounded setting and stage a new revision.' }),
    invalid_nginx_headers: Object.freeze({ message: 'The Nginx response-header list is invalid.', action: 'Correct the response headers and stage a new revision.' }),
    invalid_nginx_header: Object.freeze({ message: 'An Nginx response header is invalid.', action: 'Correct the response header and stage a new revision.' }),
    blocked_nginx_header: Object.freeze({ message: 'An Nginx response header is managed by YunPanel or the protocol.', action: 'Remove the protected header and stage a new revision.' }),
    duplicate_nginx_header: Object.freeze({ message: 'Nginx response-header names must be unique.', action: 'Remove the duplicate header and stage a new revision.' }),
    invalid_checksum: Object.freeze({ message: 'The Nginx configuration checksum is invalid.', action: 'Stage the current Domain revision again.' }),
    staged_config_missing: Object.freeze({ message: 'The staged Nginx configuration is missing.', action: 'Stage the current Domain revision again.' }),
    staged_config_changed: Object.freeze({ message: 'The staged Nginx configuration changed before activation.', action: 'Stage the current Domain revision again; do not reuse the old checksum.' }),
    staged_config_inspection_failed: Object.freeze({ message: 'The staged Nginx configuration could not be inspected.', action: 'Inspect protected filesystem diagnostics, then stage the current revision again.' }),
    active_config_inspection_failed: Object.freeze({ message: 'The active Nginx configuration could not be inspected.', action: 'Inspect protected filesystem diagnostics before changing live traffic.' }),
    nginx_config_invalid: Object.freeze({ message: 'Nginx rejected the staged configuration.', action: 'Review the generated settings, stage a new revision, then activate it.' }),
    nginx_activation_prepare_failed: Object.freeze({ message: 'Nginx could not replace the active configuration.', action: 'Inspect protected filesystem diagnostics and active configuration permissions before retrying.' }),
    nginx_reload_failed: Object.freeze({ message: 'Nginx reload failed and the previous configuration was restored.', action: 'Inspect protected Nginx service logs, then retry activation.' }),
    nginx_rollback_failed: Object.freeze({ message: 'Nginx reload failed and rollback could not be confirmed.', action: 'Inspect Nginx configuration and service health on the Server before any retry.' }),
  }),
  dns: Object.freeze({
    invalid_dns_record_operation: Object.freeze({ message: 'The DNS record operation is invalid.', action: 'Review the requested record action and request a new preview.' }),
    invalid_dns_record_inspection: Object.freeze({ message: 'The DNS record inspection is invalid.', action: 'Review the record identity and request a new preview.' }),
    invalid_dns_record: Object.freeze({ message: 'The DNS record fields are invalid.', action: 'Correct the bounded record fields and request a new preview.' }),
    invalid_dns_record_name: Object.freeze({ message: 'The DNS record name is invalid.', action: 'Use a canonical hostname inside the selected DNS zone.' }),
    invalid_dns_record_content: Object.freeze({ message: 'The DNS record content is invalid.', action: 'Correct the record target and request a new preview.' }),
    invalid_dns_zone_name: Object.freeze({ message: 'The DNS zone name is invalid.', action: 'Select the canonical DNS zone and request a new preview.' }),
    dns_record_outside_zone: Object.freeze({ message: 'The DNS record is outside the selected zone.', action: 'Select the owning zone or change the record hostname.' }),
    dns_provider_credential_invalid: Object.freeze({ message: 'The DNS provider credential does not match the selected zone.', action: 'Reconfigure the zone credential before retrying.' }),
    dns_provider_credential_unavailable: Object.freeze({ message: 'The DNS provider credential is unavailable.', action: 'Inspect the protected credential store before retrying.' }),
    dns_provider_credential_not_found: Object.freeze({ message: 'The DNS provider credential no longer exists.', action: 'Configure a new least-privilege credential for the zone.' }),
    dns_provider_unauthorized: Object.freeze({ message: 'The DNS provider rejected the configured credential.', action: 'Verify token validity and zone DNS-edit permission.' }),
    dns_provider_rate_limited: Object.freeze({ message: 'The DNS provider rate limit was reached.', action: 'Wait for the provider limit to recover, then request a fresh preview.' }),
    dns_provider_unavailable: Object.freeze({ message: 'The DNS provider is temporarily unavailable.', action: 'Verify network/provider health, then request a fresh preview.' }),
    dns_provider_request_failed: Object.freeze({ message: 'The DNS provider rejected the record operation.', action: 'Inspect the protected provider diagnosis and request a fresh preview.' }),
    dns_provider_response_invalid: Object.freeze({ message: 'The DNS provider returned an invalid response.', action: 'Inspect provider health and retry with a fresh preview.' }),
    dns_provider_zone_not_found: Object.freeze({ message: 'The configured DNS provider zone was not found.', action: 'Verify the zone identity and credential scope.' }),
    dns_provider_zone_ambiguous: Object.freeze({ message: 'The DNS provider zone identity is ambiguous.', action: 'Remove duplicate provider zones or select an exact zone identity.' }),
    dns_provider_snapshot_stale: Object.freeze({ message: 'DNS provider state changed after preview.', action: 'Request a fresh record preview before applying again.' }),
    dns_provider_record_ambiguous: Object.freeze({ message: 'The DNS provider has multiple matching records.', action: 'Resolve duplicate records at the provider, then request a fresh preview.' }),
    dns_provider_record_mismatch: Object.freeze({ message: 'The DNS provider record no longer matches the requested deletion.', action: 'Inspect current provider state and request a fresh preview.' }),
    dns_provider_mutation_unconfirmed: Object.freeze({ message: 'The DNS provider did not confirm the requested record state.', action: 'Inspect current provider state before deciding whether to retry.' }),
  }),
  certificate: Object.freeze({
    certbot_not_installed: Object.freeze({ message: 'Certbot is not installed on the managed Server.', action: 'Install the packaged certificate dependencies before retrying.' }),
    certbot_failed: Object.freeze({ message: 'The Certbot operation failed.', action: 'Check DNS readiness and protected Certbot diagnostics before retrying.' }),
    invalid_certificate_file: Object.freeze({ message: 'The issued certificate file is invalid.', action: 'Inspect the protected certificate material and issue a replacement.' }),
    invalid_private_key_file: Object.freeze({ message: 'The issued private-key file is invalid.', action: 'Inspect protected certificate material and issue a replacement.' }),
    certificate_private_key_mismatch: Object.freeze({ message: 'The certificate and private key do not match.', action: 'Select matching material or issue a replacement certificate.' }),
    certificate_material_unavailable: Object.freeze({ message: 'Certificate material is unavailable.', action: 'Inspect protected certificate storage and permissions before retrying.' }),
    certificate_metadata_mismatch: Object.freeze({ message: 'Stored certificate metadata does not match its material.', action: 'Do not activate it; inspect protected material and import or issue a replacement.' }),
    invalid_acme_challenge: Object.freeze({ message: 'The ACME challenge configuration is invalid.', action: 'Review the selected HTTP-01 or DNS-01 challenge before retrying.' }),
    invalid_dns_provider_credential: Object.freeze({ message: 'The DNS provider credential does not match the certificate request.', action: 'Configure the correct zone credential before retrying.' }),
    dns_provider_credential_unavailable: Object.freeze({ message: 'The DNS provider credential is unavailable.', action: 'Inspect the protected credential store before retrying.' }),
    dns_provider_credential_not_found: Object.freeze({ message: 'The DNS provider credential no longer exists.', action: 'Configure a new least-privilege credential before retrying.' }),
    dns_provider_credential_invalid: Object.freeze({ message: 'The DNS provider credential does not match the requested zone.', action: 'Configure the correct zone credential before retrying.' }),
    dns_provider_unauthorized: Object.freeze({ message: 'The DNS provider rejected the configured credential.', action: 'Verify token validity and zone DNS-edit permission.' }),
    dns_provider_rate_limited: Object.freeze({ message: 'The DNS provider rate limit was reached.', action: 'Wait for the provider limit to recover before retrying.' }),
    dns_provider_unavailable: Object.freeze({ message: 'The DNS provider is temporarily unavailable.', action: 'Verify network/provider health before retrying.' }),
    dns_provider_request_failed: Object.freeze({ message: 'The DNS provider rejected the certificate challenge operation.', action: 'Inspect protected provider diagnostics before retrying.' }),
    dns_provider_response_invalid: Object.freeze({ message: 'The DNS provider returned an invalid response.', action: 'Inspect provider health before retrying.' }),
    dns_provider_zone_not_found: Object.freeze({ message: 'The configured DNS provider zone was not found.', action: 'Verify the zone identity and credential scope.' }),
    dns_provider_zone_ambiguous: Object.freeze({ message: 'The DNS provider zone identity is ambiguous.', action: 'Resolve duplicate provider zones before retrying.' }),
    local_operation_failed: Object.freeze({ message: 'The local certificate operation failed.', action: 'Inspect protected certificate job and host diagnostics before retrying.' }),
    legacy_operation_failed: Object.freeze({ message: 'The legacy certificate operation failed.', action: 'Inspect protected certificate job and host diagnostics before retrying.' }),
  }),
});

export function operationErrorDiagnosis(scope, code) {
  const fallback = FALLBACKS[scope];
  if (!fallback) return null;
  const entry = typeof code === 'string' ? ENTRIES[scope]?.[code] : null;
  const diagnosis = entry ? { code, ...entry } : fallback;
  return Object.freeze({ severity: 'error', ...diagnosis });
}

export const operationDiagnosisInternals = Object.freeze({ entries: ENTRIES, fallbacks: FALLBACKS });
