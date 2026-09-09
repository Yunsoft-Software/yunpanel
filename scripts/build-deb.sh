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
if [[ ! -d node_modules || ! -d apps/web/dist ]]; then
  printf 'run npm install and npm run build before building the package\n' >&2
  exit 1
fi

repository_root=$(pwd)
build_directory=$(mktemp -d)
package_root="$build_directory/yunpanel"
trap 'rm -rf -- "$build_directory"' EXIT

install -d "$package_root/DEBIAN"
install -d "$package_root/usr/lib/yunpanel/apps"
install -d "$package_root/usr/lib/yunpanel/packages"
install -d "$package_root/usr/lib/systemd/system"
install -d "$package_root/usr/share/yunpanel/web"

sed "s/@VERSION@/$version/" packaging/debian/control >"$package_root/DEBIAN/control"
install -m 0755 packaging/debian/preinst "$package_root/DEBIAN/preinst"
install -m 0755 packaging/debian/postinst "$package_root/DEBIAN/postinst"
install -m 0755 packaging/debian/postrm "$package_root/DEBIAN/postrm"
install -m 0644 packaging/systemd/*.service "$package_root/usr/lib/systemd/system/"

cp -a package.json "$package_root/usr/lib/yunpanel/"
cp -a apps/api apps/agent apps/web "$package_root/usr/lib/yunpanel/apps/"
cp -a packages/. "$package_root/usr/lib/yunpanel/packages/"
cp -a node_modules "$package_root/usr/lib/yunpanel/"
cp -a apps/web/dist/. "$package_root/usr/share/yunpanel/web/"
rm -rf -- "$package_root/usr/lib/yunpanel/apps/web/dist" "$package_root/usr/lib/yunpanel/apps/web/test"
find "$package_root/usr/lib/yunpanel" -type d -name test -prune -exec rm -rf -- {} +

install -d "$repository_root/$output_directory"
dpkg-deb --build --root-owner-group "$package_root" "$repository_root/$output_directory/yunpanel_${version}_all.deb" >/dev/null
printf '%s\n' "$repository_root/$output_directory/yunpanel_${version}_all.deb"
