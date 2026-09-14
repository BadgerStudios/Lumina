#!/usr/bin/env bash
# Put a backed-up build back.
#
# Usage: ./scripts/release-restore.sh <build-number> [--db] [--uploads] [--artifacts] [--yes]
#
# Nothing is restored unless you name it. That is deliberate: the three parts fail in different
# ways and are almost never all wanted at once.
#
#   --db         Replaces the ENTIRE database with the snapshot. Everything since — accounts,
#                messages, tickets, payments — is gone. This is the destructive one.
#   --uploads    Extracts the archived media OVER the current volume. Additive: a file that
#                exists now and did not exist then is left alone, because wiping first would
#                delete every upload made since for no reason.
#   --artifacts  Republishes the exact APKs/AppImage that build shipped, so installed apps get
#                the bytes they already trust rather than a rebuild with a new timestamp.
#
# The code is NOT restored automatically. Rolling back source is a git operation you should make
# deliberately with the history in front of you:
#
#   git log --oneline            find the commit named in manifest.json
#   git checkout -b rollback <commit>
#
# and the bundle is there if the repository itself is what was lost:
#
#   git clone backups/releases/build-NNN/repo.bundle lumina-restored
set -Eeuo pipefail
cd "$(dirname "$0")/.."

if [[ "$EUID" -eq 0 ]]; then
  echo "ERROR: release-restore.sh must run as the normal user, not root." >&2
  exit 1
fi

VERSION="${1:-}"
[[ -z "$VERSION" ]] && { echo "Usage: $0 <build-number> [--db] [--uploads] [--artifacts] [--yes]" >&2; exit 1; }
shift

DIR="backups/releases/build-$(printf '%03d' "$VERSION")"
[[ -d "$DIR" ]] || { echo "ERROR: no backup at $DIR" >&2; ls -1 backups/releases 2>/dev/null >&2; exit 1; }

DO_DB=0; DO_UPLOADS=0; DO_ARTIFACTS=0; ASSUME_YES=0
for arg in "$@"; do
  case "$arg" in
    --db) DO_DB=1 ;;
    --uploads) DO_UPLOADS=1 ;;
    --artifacts) DO_ARTIFACTS=1 ;;
    --yes) ASSUME_YES=1 ;;
    *) echo "Unknown option: $arg" >&2; exit 1 ;;
  esac
done

echo "== backup $DIR"
grep -E '"(version|commit|branch|createdAt)"' "$DIR/manifest.json" | sed 's/^/   /'

# Integrity before anything is touched: a truncated dump discovered halfway through a restore
# leaves no database at all.
echo "== verifying checksums"
python3 - "$DIR" <<'PY'
import hashlib, json, pathlib, sys
d = pathlib.Path(sys.argv[1])
man = json.loads((d / "manifest.json").read_text())
bad = []
for rel, meta in man["files"].items():
    p = d / rel
    if not p.exists():
        bad.append(f"{rel}: missing"); continue
    h = hashlib.sha256()
    with p.open("rb") as fh:
        for chunk in iter(lambda: fh.read(1 << 20), b""):
            h.update(chunk)
    if h.hexdigest() != meta["sha256"]:
        bad.append(f"{rel}: checksum mismatch")
if bad:
    print("   CORRUPT:"); [print("    " + b) for b in bad]; sys.exit(1)
print(f"   {len(man['files'])} file(s) intact")
PY

if (( DO_DB + DO_UPLOADS + DO_ARTIFACTS == 0 )); then
  echo
  echo "Nothing selected, so nothing was changed. Add --db, --uploads and/or --artifacts."
  exit 0
fi

if (( DO_DB )) && (( ! ASSUME_YES )); then
  echo
  echo "--db REPLACES the entire live database with the $(date -d "$(grep -oP '"createdAt": "\K[^"]+' "$DIR/manifest.json")" '+%d %b %H:%M' 2>/dev/null || echo 'archived') snapshot."
  echo "Everything created since then is permanently lost."
  read -r -p "Type the build number ($VERSION) to confirm: " typed
  [[ "$typed" == "$VERSION" ]] || { echo "Not confirmed; nothing changed." >&2; exit 1; }
fi

if (( DO_DB )); then
  echo "== restoring database"
  # The dump carries --clean --if-exists, so it drops and recreates rather than colliding with
  # what is already there. Backend is stopped first: restoring under a live connection pool gives
  # you half-applied state and a backend holding handles to dropped tables.
  docker compose stop backend worker >/dev/null
  gunzip -c "$DIR/db.sql.gz" | docker compose exec -T postgres psql -U lumina -d lumina >/dev/null
  docker compose start backend worker >/dev/null
  echo "   done (backend restarted)"
fi

if (( DO_UPLOADS )); then
  echo "== restoring uploads (additive)"
  docker run --rm -v lumina_lumina-uploads:/data -v "$(pwd)/$DIR:/in:ro" alpine \
    tar xzf /in/uploads.tar.gz -C /data
  echo "   done"
fi

if (( DO_ARTIFACTS )); then
  echo "== republishing artifacts"
  for f in "$DIR"/artifacts/*; do
    [[ -e "$f" ]] || continue
    cp "$f" "downloads/$(basename "$f")"
    echo "   $(basename "$f")"
  done
  echo "   NOTE: /api/meta/version still reports the version in .env — set ANDROID_VERSION_CODE"
  echo "         back to $VERSION and restart the backend, or clients will not offer the rollback."
fi

echo "== restore complete"
