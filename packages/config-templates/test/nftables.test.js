import assert from 'node:assert/strict';
import test from 'node:test';
import {
  renderNftablesConfig,
  previewNftablesConfiguration,
  NftablesTemplateError,
  nftablesTemplatePolicy,
} from '../src/nftables.js';

test('renderNftablesConfig renders default ports including SSH, Web, DNS, Mail', () => {
  const config = renderNftablesConfig();
  assert.match(config, /^#!\/usr\/sbin\/nft -f/);
  assert.match(config, /table inet yunpanel/);
  assert.match(config, /set crowdsec-blacklists/);
  assert.match(config, /set crowdsec6-blacklists/);
  assert.match(config, /ip saddr @crowdsec-blacklists drop/);
  assert.match(config, /ct state established,related accept/);
  assert.match(config, /iif "lo" accept/);
  assert.match(config, /tcp dport \{ 22, 25, 53, 80, 143, 443, 465, 587, 993 \} accept/);
  assert.match(config, /udp dport \{ 53 \} accept/);
  assert.match(config, /chain forward \{[\s\S]*policy drop;[\s\S]*\}/);
  assert.match(config, /chain output \{[\s\S]*policy accept;[\s\S]*\}/);
});

test('renderNftablesConfig allows custom SSH port and additional ports', () => {
  const config = renderNftablesConfig({
    sshPorts: [2222],
    additionalTcpPorts: [8080],
    additionalUdpPorts: [51820],
  });
  assert.match(config, /tcp dport \{ 25, 53, 80, 143, 443, 465, 587, 993, 2222, 8080 \} accept/);
  assert.match(config, /udp dport \{ 53, 51820 \} accept/);
});

test('renderNftablesConfig rejects empty SSH ports to prevent lockout', () => {
  assert.throws(
    () => renderNftablesConfig({ sshPorts: [] }),
    (err) => err instanceof NftablesTemplateError && err.code === 'nftables_ssh_port_required',
  );
});

test('renderNftablesConfig rejects invalid port numbers', () => {
  assert.throws(
    () => renderNftablesConfig({ sshPorts: [0] }),
    (err) => err instanceof NftablesTemplateError && err.code === 'nftables_port_invalid',
  );
  assert.throws(
    () => renderNftablesConfig({ sshPorts: [70000] }),
    (err) => err instanceof NftablesTemplateError && err.code === 'nftables_port_invalid',
  );
});

test('previewNftablesConfiguration returns deterministic preview object', () => {
  const preview = previewNftablesConfiguration();
  assert.equal(preview.version, 1);
  assert.match(preview.sha256, /^[a-f0-9]{64}$/);
  assert.equal(preview.artifact.path, nftablesTemplatePolicy.configPath);
  assert.equal(preview.artifact.mode, 0o644);
  assert.equal(preview.artifact.sensitive, false);
});
