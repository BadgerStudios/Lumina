#!/usr/bin/env bash
# Sets a secret in .env without it ever appearing on screen, in shell history, or in a transcript.
#
#   ./scripts/set-secret.sh BACKUP_S3_KEY_ID
#   ./scripts/set-secret.sh BACKUP_S3_SECRET
#   ./scripts/set-secret.sh STRIPE_SECRET_KEY
#
# Why this exists: the natural way to hand a key over is to paste it, and anything pasted into a
# chat window is disclosed the moment it is sent — no matter what happens afterwards. `read -s`
# keeps the value between your terminal and this file.
set -Eeuo pipefail
cd "$(dirname "$0")/.."

KEY="${1:-}"
if [[ -z "$KEY" ]]; then
  echo "usage: $0 <ENV_VAR_NAME>" >&2
  exit 1
fi
if [[ ! "$KEY" =~ ^[A-Z0-9_]+$ ]]; then
  echo "error: '$KEY' doesn't look like an environment variable name" >&2
  exit 1
fi

# -s: no echo. -r: don't mangle backslashes, which appear in plenty of real keys.
read -rs -p "Value for ${KEY} (input hidden): " VALUE
echo

if [[ -z "$VALUE" ]]; then
  echo "error: nothing entered, .env unchanged" >&2
  exit 1
fi

touch .env
# A backup before an in-place edit, because .env holds every credential this instance has and a
# botched sed on it is a genuinely bad afternoon. Kept 0600 like the original.
cp .env .env.bak
chmod 600 .env.bak

if grep -q "^${KEY}=" .env; then
  # Written with awk rather than sed so the value is passed as data — a secret containing & or /
  # would otherwise be silently mangled by sed's replacement syntax.
  awk -v k="$KEY" -v v="$VALUE" 'BEGIN{FS=OFS="="} $1==k {print k "=" v; found=1; next} {print} END{if(!found) print k "=" v}' .env > .env.tmp
  mv .env.tmp .env
else
  printf '%s=%s\n' "$KEY" "$VALUE" >> .env
fi
chmod 600 .env

# Confirms the write without printing the secret: length and last four only, which is enough to
# tell a successful paste from a truncated one.
LEN=${#VALUE}
echo "${KEY} set (${LEN} chars, ends …${VALUE: -4})"
echo "Backup of the previous .env is at .env.bak"
