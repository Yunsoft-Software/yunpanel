#!/usr/bin/env bash
set -euo pipefail

version=${1:-}
output_directory=${2:-dist-packages}
if [[ ! $version =~ ^[0-9]+\.[0-9]+\.[0-9]+-[0-9]+$ ]]; then
  printf 'usage: %s <semver-debian-revision> [output-directory]\n' "$0" >&2
  exit 2
fi
if ! command -v dpkg-deb >/dev/null; then
  printf 'dpkg-deb is required to build the YunPanel package\n' >&2
  exit 1
fi
if ! command -v dpkg >/dev/null; then
  printf 'dpkg is required to resolve the YunPanel package architecture\n' >&2
  exit 1
fi
if [[ ! -f package-lock.json || ! -d node_modules || ! -d apps/web/dist ]]; then
  printf 'run npm ci and npm run build before building the package\n' >&2
  exit 1
fi
node_platform=$(node --print 'process.platform')
node_arch=$(node --print 'process.arch')
case "$node_arch" in
  x64) architecture=amd64 ;;
  arm64) architecture=arm64 ;;
  *)
    printf 'unsupported Node architecture for YunPanel package: %s\n' "$node_arch" >&2
    exit 1
    ;;
esac
if [[ "$node_platform" != linux || "$(dpkg --print-architecture)" != "$architecture" ]]; then
  printf 'build the native YunPanel package on matching Linux %s (current platform=%s dpkg=%s)\n' "$architecture" "$node_platform" "$(dpkg --print-architecture)" >&2
  exit 1
fi

repository_root=$(pwd)
elfinder_version=2.1.70
elfinder_commit=e7ea668fd569fc9903fb1c431d47d58f2daad2f2
elfinder_vendor_root=${ELFINDER_VENDOR_ROOT:-"$repository_root/.local/vendor/elfinder"}
if [[ ! -d "$elfinder_vendor_root/.git" ]]; then
  printf 'pinned elFinder vendor tree is missing; run scripts/fetch-elfinder-vendor.sh or set ELFINDER_VENDOR_ROOT\n' >&2
  exit 1
fi
if [[ "$(git -C "$elfinder_vendor_root" rev-parse HEAD 2>/dev/null || true)" != "$elfinder_commit" ]]; then
  printf 'elFinder vendor tree must be pinned to %s\n' "$elfinder_commit" >&2
  exit 1
fi
if [[ "$(git -C "$elfinder_vendor_root" rev-list -n 1 "$elfinder_version" 2>/dev/null || true)" != "$elfinder_commit" ]]; then
  printf 'elFinder vendor tag %s does not resolve to pinned commit\n' "$elfinder_version" >&2
  exit 1
fi
if [[ -n "$(git -C "$elfinder_vendor_root" status --porcelain --untracked-files=all)" ]]; then
  printf 'elFinder vendor tree must be clean before packaging\n' >&2
  exit 1
fi
elfinder_required=(
  LICENSE.md
  elfinder.html
  css/elfinder.min.css
  js/elfinder.min.js
  php/autoload.php
  php/elFinder.class.php
  php/elFinderConnector.class.php
  php/elFinderVolumeLocalFileSystem.class.php
)
for file in "${elfinder_required[@]}"; do
  if [[ ! -f "$elfinder_vendor_root/$file" ]]; then
    printf 'elFinder vendor tree is missing required file: %s\n' "$file" >&2
    exit 1
  fi
done
if [[ "$output_directory" = /* ]]; then
  package_directory=$output_directory
else
  package_directory="$repository_root/$output_directory"
fi
build_directory=$(mktemp -d)
package_root="$build_directory/yunpanel"
trap 'rm -rf -- "$build_directory"' EXIT

install -d "$package_root/DEBIAN"
install -d "$package_root/usr/lib/yunpanel/apps"
install -d "$package_root/usr/lib/yunpanel/packages"
install -d "$package_root/usr/lib/yunpanel/scripts"
install -d "$package_root/usr/lib/systemd/system"
install -d "$package_root/usr/lib/tmpfiles.d"
install -d "$package_root/usr/share/yunpanel/web"
install -d "$package_root/usr/share/yunpanel/elfinder/vendor/elfinder"
install -d "$package_root/usr/share/doc/yunpanel"

sed -e "s/@VERSION@/$version/" -e "s/@ARCHITECTURE@/$architecture/" packaging/debian/control >"$package_root/DEBIAN/control"
install -m 0755 packaging/debian/preinst "$package_root/DEBIAN/preinst"
install -m 0755 packaging/debian/postinst "$package_root/DEBIAN/postinst"
install -m 0755 packaging/debian/postrm "$package_root/DEBIAN/postrm"
install -m 0644 packaging/systemd/*.service "$package_root/usr/lib/systemd/system/"
install -m 0644 packaging/tmpfiles/yunpanel.conf "$package_root/usr/lib/tmpfiles.d/yunpanel.conf"
install -m 0644 scripts/auth.mjs "$package_root/usr/lib/yunpanel/scripts/auth.mjs"
install -m 0644 scripts/rotate-secret-master-key.mjs "$package_root/usr/lib/yunpanel/scripts/rotate-secret-master-key.mjs"
install -m 0755 scripts/local-runtime.mjs "$package_root/usr/lib/yunpanel/scripts/local-runtime.mjs"
install -m 0755 scripts/job-recovery.mjs "$package_root/usr/lib/yunpanel/scripts/job-recovery.mjs"
install -m 0755 scripts/local-migration-backup.mjs "$package_root/usr/lib/yunpanel/scripts/local-migration-backup.mjs"
install -m 0644 .env.example README.md \
  docs/authentication.md \
  docs/local-migration-backup.md \
  docs/local-runtime-migration.md \
  docs/mfa.md \
  docs/owner-mfa-policy.md \
  docs/secret-master-key-rotation.md \
  docs/site-files.md \
  docs/terminal.md \
  "$package_root/usr/share/doc/yunpanel/"

cp -a package.json "$package_root/usr/lib/yunpanel/"
cp -a apps/api apps/agent apps/web "$package_root/usr/lib/yunpanel/apps/"
cp -a packages/. "$package_root/usr/lib/yunpanel/packages/"
cp -a node_modules "$package_root/usr/lib/yunpanel/"
cp -a apps/web/dist/. "$package_root/usr/share/yunpanel/web/"
cp -a "$elfinder_vendor_root/." "$package_root/usr/share/yunpanel/elfinder/vendor/elfinder/"
rm -rf -- "$package_root/usr/share/yunpanel/elfinder/vendor/elfinder/.git"
node --input-type=module - <<'NODE' >"$package_root/usr/share/yunpanel/elfinder/connector.php"
import { renderElFinderConnector } from './packages/config-templates/src/index.js';
process.stdout.write(renderElFinderConnector());
NODE
node --input-type=module - <<'NODE' >"$package_root/usr/share/yunpanel/elfinder/index.html"
import { renderElFinderClientIndex } from './packages/config-templates/src/index.js';
process.stdout.write(renderElFinderClientIndex());
NODE
node --input-type=module - <<'NODE' >"$package_root/usr/share/yunpanel/elfinder/yunpanel-client.js"
import { renderElFinderClientScript } from './packages/config-templates/src/index.js';
process.stdout.write(renderElFinderClientScript());
NODE
chmod 0644 \
  "$package_root/usr/share/yunpanel/elfinder/connector.php" \
  "$package_root/usr/share/yunpanel/elfinder/index.html" \
  "$package_root/usr/share/yunpanel/elfinder/yunpanel-client.js"
printf '%s\n' "$elfinder_version $elfinder_commit" >"$package_root/usr/share/yunpanel/elfinder/VERSION"
chmod 0644 "$package_root/usr/share/yunpanel/elfinder/VERSION"
rm -rf -- "$package_root/usr/lib/yunpanel/apps/web/dist" "$package_root/usr/lib/yunpanel/apps/web/test"
find "$package_root/usr/lib/yunpanel" -type d -name test -prune -exec rm -rf -- {} +

install -d "$package_directory"
package_path="$package_directory/yunpanel_${version}_${architecture}.deb"
dpkg-deb --build --root-owner-group "$package_root" "$package_path" >/dev/null
printf '%s\n' "$package_path"
