#!/usr/bin/env bash
# Turn on DKIM signing for Lumina's outbound mail.
#
# Everything this needs already existed: the 2048-bit key at secrets/dkim.key, the mount into the
# backend, DKIM_SELECTOR=lumina, and the signing code in apps/backend/src/lib/mail.ts. The one thing
# missing was DKIM_DOMAIN, which mail.ts requires as well as the key:
#
#     dkim: dkimKey && process.env.DKIM_DOMAIN?.trim() ? {...} : undefined
#
# Empty DKIM_DOMAIN means that ternary picks `undefined` and every message goes out UNSIGNED, with
# no error and no log line. That is why this was invisible.
#
# Guarded because publishing DNS and enabling signing must happen in that order: signing with no
# published selector is worse than not signing, since a receiver that finds no key for d= treats the
# signature as a permanent failure rather than as absent.
set -euo pipefail

cd "$HOME/lumina"

DOMAIN="badgerstudios.net"
SELECTOR="$(grep -E '^DKIM_SELECTOR=' .env | cut -d= -f2-)"
SELECTOR="${SELECTOR:-lumina}"
KEY="secrets/dkim.key"

say() { printf '\n== %s\n' "$*"; }
die() { printf '\nREFUSING: %s\n' "$*" >&2; exit 1; }

say "1/6 preconditions"
[ -f "$KEY" ] || die "$KEY does not exist"
PRIV_PUB="$(sudo openssl rsa -in "$KEY" -pubout -outform PEM 2>/dev/null | grep -v '^-----' | tr -d '\n')"
[ -n "$PRIV_PUB" ] || die "could not derive a public key from $KEY"
echo "   private key OK, selector=$SELECTOR domain=$DOMAIN"

say "2/6 the published selector must exist and match the private key"
# Never read this through the local stub resolver mid-change — see the rDNS notes. Ask a public
# resolver directly.
if command -v dig >/dev/null 2>&1; then
  PUBLISHED="$(dig +short TXT "${SELECTOR}._domainkey.${DOMAIN}" @1.1.1.1 | tr -d '" \n' | sed 's/.*p=//')"
else
  PUBLISHED="$(python3 - "$SELECTOR" "$DOMAIN" <<'PY'
import subprocess, sys
sel, dom = sys.argv[1], sys.argv[2]
try:
    out = subprocess.run(["nslookup", "-type=TXT", f"{sel}._domainkey.{dom}", "1.1.1.1"],
                         capture_output=True, text=True, timeout=15).stdout
except Exception:
    out = ""
txt = "".join(ch for ch in out if ch not in '" \n')
print(txt.split("p=")[-1].split("\t")[0] if "p=" in txt else "")
PY
)"
fi
[ -n "$PUBLISHED" ] || die "no TXT at ${SELECTOR}._domainkey.${DOMAIN} — publish the record first"
[ "$PUBLISHED" = "$PRIV_PUB" ] || die "published key does not match ${KEY}; signing now would fail verification"
echo "   published key matches the private half (${#PUBLISHED} chars)"

say "3/6 current state"
CURRENT="$(grep -E '^DKIM_DOMAIN=' .env | cut -d= -f2- || true)"
if [ "$CURRENT" = "$DOMAIN" ]; then
  echo "   DKIM_DOMAIN already $DOMAIN in .env — nothing to edit"
  CHANGED=0
else
  echo "   DKIM_DOMAIN is '${CURRENT}' — setting to $DOMAIN"
  CHANGED=1
fi

if [ "$CHANGED" = "1" ]; then
  say "4/6 editing .env (the value lives in .env, NOT compose.yml — compose only interpolates it)"
  cp -a .env ".env.bak.$(date +%Y%m%d-%H%M%S)"
  if grep -qE '^DKIM_DOMAIN=' .env; then
    sed -i "s|^DKIM_DOMAIN=.*|DKIM_DOMAIN=${DOMAIN}|" .env
  else
    printf 'DKIM_DOMAIN=%s\n' "$DOMAIN" >> .env
  fi
  grep -E '^DKIM_DOMAIN=' .env | sed 's/^/   now: /'

  say "5/6 recreating backend only (worker sends no mail; nothing else reads DKIM_*)"
  docker compose up -d --force-recreate backend
else
  say "4/6 skipped"; say "5/6 skipped (no change to apply)"
fi

say "6/6 asserting the RUNNING container, not the file"
for i in $(seq 1 30); do
  if docker compose exec -T backend true >/dev/null 2>&1; then break; fi
  sleep 2
done
RUNTIME="$(docker compose exec -T backend printenv DKIM_DOMAIN 2>/dev/null | tr -d '\r\n' || true)"
[ "$RUNTIME" = "$DOMAIN" ] || die "container env DKIM_DOMAIN='${RUNTIME}', expected '${DOMAIN}'"
echo "   container DKIM_DOMAIN=$RUNTIME"
docker compose exec -T backend sh -c 'head -c 32 /run/secrets/dkim.key >/dev/null 2>&1' \
  && echo "   container can read /run/secrets/dkim.key" \
  || die "container cannot read the mounted key — it would send UNSIGNED"
if docker compose logs --since 3m backend 2>&1 | grep -q "sending UNSIGNED"; then
  die "backend logged 'sending UNSIGNED' — the key is set but unreadable"
fi
echo "   no 'sending UNSIGNED' in recent logs"

printf '\nDONE — signing as d=%s s=%s\n' "$DOMAIN" "$SELECTOR"
