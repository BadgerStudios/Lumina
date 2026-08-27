#!/usr/bin/env bash
# Flip the mail relay's HELO to mail.badgerstudios.net.
#
# ONLY run this AFTER both halves of the rDNS change are live:
#   1. Cloudflare: A  mail.badgerstudios.net -> 15.204.122.19, DNS only (grey cloud, NOT proxied)
#   2. OVH panel:  reverse DNS for 15.204.122.19 -> mail.badgerstudios.net
#
# Order matters. Before the PTR is set, HELO and PTR agree with each other (both the OVH default) —
# generic, but consistent, and receivers comparing the two currently pass us. Changing HELO first
# would break an agreement that holds today, so this refuses until forward-confirmed reverse DNS
# resolves both ways.
set -Eeuo pipefail

IP=15.204.122.19
NAME=mail.badgerstudios.net
cd ~/lumina

echo "== checking forward-confirmed reverse DNS =="
# Ask the authoritative nameserver, not a cache. A local stub resolver or a Cloudflare PoP can hold
# the previous PTR for the remainder of its TTL (~1h here) long after the change is live, which
# would make this refuse for an hour for no reason.
auth=$(dig +short NS "$(echo "$IP" | awk -F. '{print $3"."$2"."$1".in-addr.arpa"}')" @8.8.8.8 | head -1)
ptr=$(dig +short -x "$IP" ${auth:+@"$auth"} | sed 's/\.$//')
fwd=$(dig +short A "$NAME" @8.8.8.8 | tr '\n' ' ')

echo "   authority  ${auth:-<none>}"
echo "   PTR  $IP -> ${ptr:-<none>}"
echo "   A    $NAME -> ${fwd:-<none>}"

if [ "$ptr" != "$NAME" ]; then
  echo "REFUSING: PTR is '${ptr:-<none>}', expected '$NAME'. Set reverse DNS in the OVH panel first." >&2
  exit 1
fi
if ! echo "$fwd" | grep -qw "$IP"; then
  echo "REFUSING: $NAME does not resolve to $IP (got '${fwd:-<none>}')." >&2
  echo "          If it returns Cloudflare IPs, the record is proxied — switch it to DNS only." >&2
  exit 1
fi
echo "   forward-confirmed: OK"

# The value lives in .env; compose.yml only interpolates it (RELAY_HELO_HOSTNAME: ${...}).
# Editing compose.yml does nothing, which is exactly how an earlier version of this script
# reported success while changing nothing at all.
if ! grep -q '^RELAY_HELO_HOSTNAME=' .env; then
  echo "REFUSING: no RELAY_HELO_HOSTNAME line in .env to update." >&2
  exit 1
fi
cp .env ".env.bak-$(date +%Y%m%d-%H%M%S)"
sed -i "s#^RELAY_HELO_HOSTNAME=.*#RELAY_HELO_HOSTNAME=$NAME#" .env
echo "== .env now says =="; grep -n '^RELAY_HELO_HOSTNAME=' .env

echo "== recreating the relay so it picks the value up =="
docker compose up -d --force-recreate mail
sleep 6

# Assert the RUNNING container actually carries the new value. Without this the script can and did
# claim DONE while the container kept the old HELO.
running=$(docker inspect lumina-mail --format '{{range .Config.Env}}{{println .}}{{end}}' | grep '^RELAY_HELO_HOSTNAME=' | cut -d= -f2-)
echo "   container HELO: ${running:-<unset>}"
if [ "$running" != "$NAME" ]; then
  echo "FAILED: the container is still announcing '${running:-<unset>}'." >&2
  exit 1
fi
docker compose ps mail --format '{{.Status}}'
echo "DONE — HELO is now $NAME, matching the PTR."
