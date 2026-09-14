#!/usr/bin/env bash
# Snapshot one published build so it can be restored if the next one is a mistake.
#
# Usage: ./scripts/release-backup.sh [build-number]     (defaults to the current ANDROID_VERSION_CODE)
#
# Keeps the THREE most recent builds and deletes the rest. Three because the common case is
# "the build we just shipped is broken, go back one" and the uncommon case is "that one was
# broken too" — beyond that the database has moved far enough that restoring it loses more
# than it saves.
#
# What is captured, and why each part is here:
#
#   repo.bundle    The git history, as a bundle. THIS REPOSITORY HAS NO REMOTE — the working
#                  tree on this box is the only copy of the source that exists. A dump of the
#                  database with no code to run against it is not a restorable system.
#   db.sql.gz      pg_dump of the whole database, schema and data.
#   uploads.tar.gz Avatars, attachments and video media, from the docker volume.
#   artifacts/     The APKs, AppImage and Windows build that were actually published, so a
#                  rollback can republish the exact bytes people already installed rather than
#                  a rebuild that would carry a different signature timestamp.
#   manifest.json  Version, commit, timestamp and a checksum per file, so a restore can tell
#                  whether what it is reading is intact before it starts overwriting anything.
#
# Never run as root: a root-owned backup tree is one the deploy user cannot rotate, and the
# rotation silently becoming a no-op is how a disk fills up.
set -Eeuo pipefail
cd "$(dirname "$0")/.."

if [[ "$EUID" -eq 0 ]]; then
  echo "ERROR: release-backup.sh must run as the normal user, not root." >&2
  exit 1
fi

KEEP=3
ROOT="$(pwd)"
BACKUP_ROOT="$ROOT/backups/releases"

VERSION="${1:-$(grep -oP '^ANDROID_VERSION_CODE=\K[0-9]+' .env 2>/dev/null || true)}"
if [[ -z "$VERSION" ]]; then
  VERSION="$(grep -oP 'versionCode \K[0-9]+' apps/mobile/android/app/build.gradle | head -1)"
fi
if [[ -z "$VERSION" ]]; then
  echo "ERROR: could not work out which build this is." >&2
  exit 1
fi

DEST="$BACKUP_ROOT/build-$(printf '%03d' "$VERSION")"
STAMP="$(date -u +%Y-%m-%dT%H:%M:%SZ)"
echo "== backing up build $VERSION to ${DEST#$ROOT/} =="

# A partial backup that looks complete is worse than none, so it is built beside the real
# directory and moved into place only once every part has been written.
TMP="$DEST.partial"
rm -rf "$TMP"
mkdir -p "$TMP/artifacts"

# ── the source ───────────────────────────────────────────────────────────────
COMMIT="$(git rev-parse HEAD)"
BRANCH="$(git rev-parse --abbrev-ref HEAD)"
echo "   repo     $BRANCH @ ${COMMIT:0:8}"
# --all rather than the branch alone: tags and any other branch are part of what would be lost.
git bundle create "$TMP/repo.bundle" --all >/dev/null 2>&1

# Uncommitted work is not in the bundle. Capturing it separately is what makes this honest about
# the difference between "what is committed" and "what is actually running".
if ! git diff --quiet HEAD 2>/dev/null; then
  git diff HEAD > "$TMP/uncommitted.patch"
  echo "   note     working tree had uncommitted changes; saved as uncommitted.patch"
fi

# ── the database ─────────────────────────────────────────────────────────────
echo "   database dumping…"
docker compose exec -T postgres pg_dump -U lumina --clean --if-exists lumina | gzip -9 > "$TMP/db.sql.gz"

# ── user media ───────────────────────────────────────────────────────────────
# Read through a throwaway container rather than reaching into /var/lib/docker, which needs root
# and hardcodes docker's storage layout.
echo "   uploads  archiving…"
# Written to stdout and redirected by the SHELL, not by the container into a mounted directory.
# A container writes as root, which would leave a root-owned file inside a backup the deploy user
# has to be able to rotate — the same class of mistake as a root-run deploy, and it only shows up
# later as a rotation that silently stops reclaiming space.
docker run --rm -v lumina_lumina-uploads:/data:ro alpine \
  tar czf - -C /data . 2>/dev/null > "$TMP/uploads.tar.gz"

# ── what was published ───────────────────────────────────────────────────────
for f in lumina.apk lumina-owner.apk lumina-desktop.AppImage lumina-windows.zip; do
  [[ -f "downloads/$f" ]] && cp "downloads/$f" "$TMP/artifacts/$f"
done
echo "   published $(ls -1 "$TMP/artifacts" | wc -l) artifact(s)"

# ── the manifest ─────────────────────────────────────────────────────────────
{
  echo "{"
  echo "  \"version\": $VERSION,"
  echo "  \"commit\": \"$COMMIT\","
  echo "  \"branch\": \"$BRANCH\","
  echo "  \"createdAt\": \"$STAMP\","
  echo "  \"files\": {"
  first=1
  while IFS= read -r -d '' file; do
    rel="${file#$TMP/}"
    [[ "$rel" == "manifest.json" ]] && continue
    sum="$(sha256sum "$file" | cut -d' ' -f1)"
    size="$(stat -c%s "$file")"
    [[ $first -eq 0 ]] && echo ","
    first=0
    printf '    "%s": { "sha256": "%s", "bytes": %s }' "$rel" "$sum" "$size"
  done < <(find "$TMP" -type f -print0 | sort -z)
  echo ""
  echo "  }"
  echo "}"
} > "$TMP/manifest.json"

rm -rf "$DEST"
mv "$TMP" "$DEST"
echo "   size     $(du -sh "$DEST" | cut -f1)"

# ── rotation ─────────────────────────────────────────────────────────────────
# Sorted by name, which is why the directory is zero-padded — build-9 must not sort after
# build-100. Anything left over after the newest $KEEP is removed.
mapfile -t all < <(find "$BACKUP_ROOT" -maxdepth 1 -name 'build-*' -type d | sort -r)
if (( ${#all[@]} > KEEP )); then
  for old in "${all[@]:KEEP}"; do
    echo "   rotate   removing $(basename "$old")"
    rm -rf "$old"
  done
fi

echo "== kept: $(find "$BACKUP_ROOT" -maxdepth 1 -name 'build-*' -type d | sort -r | xargs -n1 basename | tr '\n' ' ')"
echo "== total $(du -sh "$BACKUP_ROOT" | cut -f1)"
