#!/usr/bin/env bash
# Warns while there is still time to act.
#
# A full disk does not present as a disk problem: Postgres stops accepting writes, uploads fail
# mid-transfer, and the app looks broken for reasons that point nowhere near storage. The build
# cache took this box from 78% to 85% in a single day of deploys, so the margin is smaller than it
# looks.
#
# Exits non-zero past the threshold so the systemd unit records a failure rather than logging into
# a void nobody reads.
set -Eeuo pipefail
THRESHOLD=${1:-85}
USED=$(df --output=pcent / | tail -1 | tr -dc '0-9')
FREE=$(df -h --output=avail / | tail -1 | tr -d ' ')

if [ "$USED" -ge "$THRESHOLD" ]; then
  echo "DISK WARNING: / is ${USED}% full (${FREE} free, threshold ${THRESHOLD}%)"
  echo "Largest reclaimable item is usually the docker build cache:"
  docker system df 2>/dev/null | sed 's/^/  /'
  echo "  Reclaim with: docker builder prune -f --keep-storage 8GB"
  exit 1
fi
echo "disk ok: ${USED}% used, ${FREE} free"
