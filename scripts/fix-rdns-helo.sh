#!/usr/bin/env bash
# Flip the mail relay's HELO to mail.badgerstudios.net.
#
# ONLY run this AFTER both halves of the rDNS change are live, because it is the last step:
#
#   1. Cloudflare: A  mail.badgerstudios.net -> 15.204.122.19, DNS only (grey cloud, NOT proxied)
#   2. OVH panel:  reverse DNS for 15.204.122.19 -> mail.badgerstudios.net
#
# Order matters. Right now HELO and PTR agree with each other (both vps-4dc5465d.vps.ovh.us) —
# generic, but consistent. Changing HELO first would break that agreement and make a receiver's
# HELO/PTR check fail where today it passes, so this refuses to run until forward-confirmed
# reverse DNS actually resolves both ways.
set -Eeuo pipefail

IP=15.204.122.19
NAME=mail.badgerstudios.net

echo "== checking forward-confirmed reverse DNS =="
ptr=$(dig +short -x "$IP" | sed 's/\.$//')
fwd=$(dig +short A "$NAME" | tr '\n' ' ')

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

cd ~/lumina
cp compose.yml "compose.yml.bak-$(date +%Y%m%d-%H%M%S)"
sed -i "s#RELAY_HELO_HOSTNAME=.*#RELAY_HELO_HOSTNAME=$NAME#" compose.yml
grep -n "RELAY_HELO_HOSTNAME" compose.yml

echo "== restarting the relay =="
docker compose up -d mail
sleep 5
docker compose ps mail --format '{{.Status}}'
echo "DONE — send a test message and confirm the receiving end sees HELO $NAME."
