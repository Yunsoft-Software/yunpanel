#!/usr/bin/env bash
# Atomic file locks for parallel agents (mkdir-based).
# Usage:
#   orkestra/lock.sh acquire NAME AGENT   # waits up to 120 s, then fails
#   orkestra/lock.sh release NAME AGENT
#   orkestra/lock.sh break NAME           # only for locks older than 10 minutes, never a SENIOR/İNSAN lock
#   orkestra/lock.sh list
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
LOCKS="$ROOT/tasks/locks"
STALE_SECONDS=600
mkdir -p "$LOCKS"

cmd="${1:-}"
name="${2:-}"
agent="${3:-}"

lock_age() {
  local now mtime
  now=$(date +%s)
  mtime=$(stat -f %m "$LOCKS/$1" 2>/dev/null || stat -c %Y "$LOCKS/$1")
  echo $((now - mtime))
}

case "$cmd" in
  acquire)
    [[ -n "$name" && -n "$agent" ]] || { echo "usage: lock.sh acquire NAME AGENT" >&2; exit 2; }
    for _ in $(seq 1 60); do
      if mkdir "$LOCKS/$name" 2>/dev/null; then
        echo "$agent|$(date +%s)" > "$LOCKS/$name/owner"
        echo "locked $name by $agent"
        exit 0
      fi
      sleep 2
    done
    echo "timeout: $name held by $(cat "$LOCKS/$name/owner" 2>/dev/null || echo '?') for $(lock_age "$name") s" >&2
    exit 1
    ;;
  release)
    [[ -d "$LOCKS/$name" ]] || { echo "$name is not locked" >&2; exit 1; }
    owner=$(cut -d'|' -f1 < "$LOCKS/$name/owner")
    [[ "$owner" == "$agent" ]] || { echo "$name is held by $owner, not $agent" >&2; exit 1; }
    rm -f "$LOCKS/$name/owner"
    rmdir "$LOCKS/$name"
    echo "released $name"
    ;;
  break)
    [[ -d "$LOCKS/$name" ]] || { echo "$name is not locked" >&2; exit 1; }
    age=$(lock_age "$name")
    if (( age < STALE_SECONDS )); then
      echo "$name is only $age s old; refusing to break" >&2
      exit 1
    fi
    holder=$(cut -d'|' -f1 < "$LOCKS/$name/owner" 2>/dev/null || echo '?')
    # SENIOR/İNSAN may hold a lock for a long task (a deploy, a live test); only they release it.
    if python3 "$ROOT/orkestra/tasks.py" protected "$holder"; then
      echo "$name is held by protected owner $holder; refusing to break (ask them to release it)" >&2
      exit 1
    fi
    echo "breaking $name held by $(cat "$LOCKS/$name/owner" 2>/dev/null || echo '?') ($age s)"
    rm -f "$LOCKS/$name/owner"
    rmdir "$LOCKS/$name"
    ;;
  list)
    for d in "$LOCKS"/*/; do
      [[ -d "$d" ]] || continue
      n=$(basename "$d")
      echo "$n $(cat "$d/owner" 2>/dev/null || echo '?') age=$(lock_age "$n")s"
    done
    ;;
  *)
    sed -n '2,7p' "$0"
    exit 2
    ;;
esac
