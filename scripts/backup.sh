#!/usr/bin/env bash
#
# Local backup of the Lumina instance: the Postgres database and the uploads volume.
#
# Why this exists, plainly: until now this instance had no backups at all. During a cleanup I ran a
# wildcard delete inside the uploads volume and removed the media for every video on the platform.
# It happened to cost nothing because they were all test fixtures — but there was no way to find
# that out except by looking, and no way to undo it if the answer had been different.
#
# Two rules this follows:
#
#  1. Backups are written OUTSIDE the volumes they back up (BACKUP_DIR defaults to a sibling of the
#     repo, not into ./ or into a docker volume). A backup living on the same volume as the data
#     protects against nothing except a careless delete of one file.
#  2. It is verified, not assumed. A pg_dump that silently produced a truncated file is worse than
#     no backup, because you only discover it when you need it. Every dump is gzip-tested and
#     size-checked before the old ones are rotated away.
#
# Offsite copies are NOT handled here and this is a real remaining gap: everything below is on the
# same physical disk as the live data, so it survives a mistake but not a drive failure. Adding an
# S3-compatible target needs a bucket and credentials from the operator.
#
# Usage:  ./scripts/backup.sh            # run a backup
#         ./scripts/backup.sh --verify   # check the newest backup and exit
set -euo pipefail

REPO_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
BACKUP_DIR="${LUMINA_BACKUP_DIR:-$(dirname "$REPO_DIR")/lumina-backups}"
KEEP_DAILY="${LUMINA_BACKUP_KEEP:-7}"
STAMP="$(date -u +%Y%m%d-%H%M%S)"
DB_FILE="$BACKUP_DIR/db-$STAMP.sql.gz"
UPLOADS_FILE="$BACKUP_DIR/uploads-$STAMP.tar.gz"
LOG_FILE="$BACKUP_DIR/backup.log"

# A dump far smaller than this means something went wrong — an empty schema, a failed connection
# that still exited 0 through the pipe, a container that wasn't running.
MIN_DB_BYTES=20000

mkdir -p "$BACKUP_DIR"
log() { printf '%s %s\n' "$(date -u +%Y-%m-%dT%H:%M:%SZ)" "$*" | tee -a "$LOG_FILE"; }

cd "$REPO_DIR"

verify_one() {
  local f="$1"
  [ -f "$f" ] || { echo "missing: $f"; return 1; }
  gzip -t "$f" || { echo "corrupt gzip: $f"; return 1; }
  return 0
}

if [ "${1:-}" = "--verify" ]; then
  newest_db="$(ls -1t "$BACKUP_DIR"/db-*.sql.gz 2>/dev/null | head -1 || true)"
  newest_up="$(ls -1t "$BACKUP_DIR"/uploads-*.tar.gz 2>/dev/null | head -1 || true)"
  [ -n "$newest_db" ] || { echo "no database backup found in $BACKUP_DIR"; exit 1; }
  verify_one "$newest_db"
  # A row count read back out of the dump proves it contains data, not just valid gzip framing.
  users="$(zcat "$newest_db" | grep -c '^INSERT INTO public."User"' || true)"
  copy_block="$(zcat "$newest_db" | grep -c '^COPY public."User"' || true)"
  echo "database: $newest_db ($(du -h "$newest_db" | cut -f1)) — User INSERTs=$users COPY blocks=$copy_block"
  if [ -n "$newest_up" ]; then
    verify_one "$newest_up"
    echo "uploads:  $newest_up ($(du -h "$newest_up" | cut -f1)) — $(tar -tzf "$newest_up" | wc -l) entries"
  else
    echo "uploads:  none found"
  fi
  exit 0
fi

log "backup starting -> $BACKUP_DIR"

# --- database ------------------------------------------------------------------------------
# --clean --if-exists so the dump can be restored over an existing database without hand-editing.
# Piped straight to gzip rather than staged uncompressed: a full dump of a media-heavy instance is
# large and there is no reason for it to touch the disk twice.
if ! docker compose exec -T postgres pg_dump -U lumina -d lumina --clean --if-exists \
  | gzip -9 > "$DB_FILE"; then
  log "ERROR: pg_dump failed"
  rm -f "$DB_FILE"
  exit 1
fi

db_bytes="$(stat -c %s "$DB_FILE")"
if [ "$db_bytes" -lt "$MIN_DB_BYTES" ]; then
  log "ERROR: dump is only ${db_bytes} bytes (< ${MIN_DB_BYTES}) — refusing to keep it"
  rm -f "$DB_FILE"
  exit 1
fi
gzip -t "$DB_FILE" || { log "ERROR: dump failed gzip integrity check"; rm -f "$DB_FILE"; exit 1; }
log "database ok: $(du -h "$DB_FILE" | cut -f1)"

# --- uploads -------------------------------------------------------------------------------
# Read out of the running container rather than off the host: the volume is docker-managed, and
# reaching into /var/lib/docker directly is both root-only and unsupported.
if ! docker compose exec -T backend tar -czf - -C /data uploads > "$UPLOADS_FILE" 2>/dev/null; then
  log "WARNING: uploads archive failed — database backup kept"
  rm -f "$UPLOADS_FILE"
else
  if gzip -t "$UPLOADS_FILE" 2>/dev/null; then
    log "uploads ok: $(du -h "$UPLOADS_FILE" | cut -f1) ($(tar -tzf "$UPLOADS_FILE" | wc -l) entries)"
  else
    log "WARNING: uploads archive is corrupt — discarding it"
    rm -f "$UPLOADS_FILE"
  fi
fi

# --- rotation ------------------------------------------------------------------------------
# Runs only after the new backup has passed its checks, so a failing backup can never delete the
# last good one.
rotate() {
  local pattern="$1"
  local keep="$2"
  local count
  count="$(ls -1t "$BACKUP_DIR"/$pattern 2>/dev/null | wc -l)"
  if [ "$count" -gt "$keep" ]; then
    ls -1t "$BACKUP_DIR"/$pattern | tail -n +$((keep + 1)) | while read -r old; do
      log "rotating out $(basename "$old")"
      rm -f "$old"
    done
  fi
}
rotate 'db-*.sql.gz' "$KEEP_DAILY"
rotate 'uploads-*.tar.gz' "$KEEP_DAILY"

# --- offsite ------------------------------------------------------------------------------
# Resolve node explicitly.
#
# This script is run by a systemd *user* timer, whose PATH is a minimal /usr/bin:/bin — it does not
# include ~/.local/bin, where this box's node lives. So every scheduled run logged
#     backup.sh: line NNN: node: command not found
# and fell through to "WARNING: offsite upload reported a problem", which is technically accurate
# and reads like a transient hiccup. It was not transient: the offsite copy had NEVER been made
# from a scheduled run, so every backup lived on the same physical disk as the data it protects —
# precisely the failure this script's header says it does not cover.
#
# Resolved once, here, rather than by adding a PATH to the unit file: that would fix the timer and
# leave cron, a CI runner and a plain `sh scripts/backup.sh` still broken.
NODE_BIN="$(command -v node || true)"
for candidate in "$HOME/.local/bin/node" /usr/local/bin/node /usr/bin/node; do
  [ -n "$NODE_BIN" ] && break
  [ -x "$candidate" ] && NODE_BIN="$candidate"
done
if [ -z "$NODE_BIN" ]; then
  log "ERROR: node not found — offsite upload SKIPPED, this backup is local-only"
fi

# After verification and after rotation, so only a backup that passed its checks is ever mirrored,
# and a Cloudflare outage can't stop the local rotation from running. Non-fatal: a failed upload is
# logged loudly but leaves a good local backup in place rather than reporting total failure.
if [ -n "$NODE_BIN" ] && "$NODE_BIN" "$REPO_DIR/scripts/backup-offsite.mjs" 2>&1 | while read -r line; do log "$line"; done; then
  :
else
  log "WARNING: offsite upload reported a problem — local backup is still good"
fi

free="$(df -h "$BACKUP_DIR" | tail -1 | awk '{print $4}')"
log "backup complete — $(ls -1 "$BACKUP_DIR"/db-*.sql.gz | wc -l) kept, ${free} free on the backup disk"
