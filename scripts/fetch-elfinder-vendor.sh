#!/usr/bin/env bash
set -euo pipefail

version=2.1.70
commit=e7ea668fd569fc9903fb1c431d47d58f2daad2f2
repository=https://github.com/Studio-42/elFinder.git
target=${1:-.local/vendor/elfinder}

if ! command -v git >/dev/null; then
  printf '%s\n' 'git is required to fetch the pinned elFinder vendor tree' >&2
  exit 1
fi

target_parent=$(dirname -- "$target")
mkdir -p -- "$target_parent"

if [[ -e "$target" ]]; then
  if [[ ! -d "$target/.git" ]]; then
    printf 'refusing to replace non-git elFinder vendor path: %s\n' "$target" >&2
    exit 1
  fi
  current_remote=$(git -C "$target" remote get-url origin 2>/dev/null || true)
  if [[ "$current_remote" != "$repository" ]]; then
    printf 'elFinder vendor origin mismatch: %s\n' "$current_remote" >&2
    exit 1
  fi
  if [[ -n "$(git -C "$target" status --porcelain --untracked-files=all)" ]]; then
    printf 'elFinder vendor tree has local changes: %s\n' "$target" >&2
    exit 1
  fi
  git -C "$target" fetch --depth=1 origin "refs/tags/$version:refs/tags/$version"
else
  git clone --filter=blob:none --no-checkout "$repository" "$target"
  git -C "$target" fetch --depth=1 origin "refs/tags/$version:refs/tags/$version"
fi

git -C "$target" checkout --detach "$commit" >/dev/null
actual=$(git -C "$target" rev-parse HEAD)
if [[ "$actual" != "$commit" ]]; then
  printf 'elFinder commit mismatch: expected %s got %s\n' "$commit" "$actual" >&2
  exit 1
fi
tag_commit=$(git -C "$target" rev-list -n 1 "$version")
if [[ "$tag_commit" != "$commit" ]]; then
  printf 'elFinder tag %s no longer resolves to pinned commit %s\n' "$version" "$commit" >&2
  exit 1
fi
if [[ -n "$(git -C "$target" status --porcelain --untracked-files=all)" ]]; then
  printf 'elFinder vendor tree is not clean after checkout\n' >&2
  exit 1
fi

required=(
  LICENSE.md
  elfinder.html
  css/elfinder.min.css
  js/elfinder.min.js
  php/autoload.php
  php/elFinder.class.php
  php/elFinderConnector.class.php
  php/elFinderVolumeLocalFileSystem.class.php
)
for file in "${required[@]}"; do
  if [[ ! -f "$target/$file" ]]; then
    printf 'pinned elFinder tree is missing required file: %s\n' "$file" >&2
    exit 1
  fi
done

printf 'elFinder %s pinned at %s in %s\n' "$version" "$commit" "$target"
