#!/usr/bin/env bash
set -euo pipefail

package_file=${1:-}
repository_root=${2:-/var/lib/yunpanel/apt}
if [[ ! -f $package_file || $package_file != *.deb ]]; then
  printf 'usage: %s <yunpanel.deb> [repository-root]\n' "$0" >&2
  exit 2
fi
if [[ $repository_root != /* ]]; then
  printf 'repository root must be absolute\n' >&2
  exit 2
fi

pool_directory="$repository_root/pool/main/y/yunpanel"
packages_directory="$repository_root/dists/stable/main/binary-amd64"
install -d -o root -g root -m 0755 "$pool_directory" "$packages_directory"
install -o root -g root -m 0644 "$package_file" "$pool_directory/$(basename "$package_file")"

cd "$repository_root"
dpkg-scanpackages --arch amd64 pool >"$packages_directory/Packages"
gzip -9 -c "$packages_directory/Packages" >"$packages_directory/Packages.gz"
chmod 0644 "$packages_directory/Packages" "$packages_directory/Packages.gz"
