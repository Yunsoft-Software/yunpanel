#!/usr/bin/env bash
set -Eeuo pipefail
version=2.12.0
expected=ce34ddd838f7351d6759068d09793f26755463b4a4610a5a5c0a97b68220d85c
destination=${1:-.local/vendor/wp-cli}
mkdir -p "$destination"
digest() {
  if command -v sha256sum >/dev/null; then sha256sum "$1" | cut -d ' ' -f1;
  else shasum -a 256 "$1" | cut -d ' ' -f1; fi
}
if [[ ! -f "$destination/wp-cli.phar" ]] || [[ $(digest "$destination/wp-cli.phar") != "$expected" ]]; then
  temporary=$(mktemp "$destination/.download.XXXXXX")
  trap 'rm -f -- "$temporary"' EXIT
  curl --fail --silent --show-error --location --proto '=https' --tlsv1.2 --max-time 120 \
    --output "$temporary" "https://github.com/wp-cli/wp-cli/releases/download/v$version/wp-cli-$version.phar"
  [[ $(digest "$temporary") == "$expected" ]] || { printf 'WP-CLI release checksum mismatch\n' >&2; exit 1; }
  chmod 0755 "$temporary"
  mv -- "$temporary" "$destination/wp-cli.phar"
  trap - EXIT
fi
printf '%s\n' "$version $expected" >"$destination/VERSION"
printf 'WP-CLI %s verified\n' "$version"
