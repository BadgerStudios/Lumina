#!/usr/bin/env bash
# New-box half of the Lumina stop-copy-start cutover.
# Expects the FINAL dumps already transferred to ./migdata/db-cutover.sql.gz and
# ./migdata/uploads-cutover.tar.gz (taken from the old box AFTER its writers were stopped).
set -euo pipefail
cd "$(dirname "$0")"
DB=migdata/db-cutover.sql.gz
UP=migdata/uploads-cutover.tar.gz
[ -f "$DB" ] || { echo "FATAL: $DB missing"; exit 1; }
[ -f "$UP" ] || { echo "FATAL: $UP missing"; exit 1; }
gzip -t "$DB" && gzip -t "$UP" || { echo "FATAL: dump failed gzip integrity"; exit 1; }

echo "== wipe any validation state, start db+redis =="
docker compose down -v
docker compose up -d postgres redis
for i in $(seq 1 40); do
  [ "$(docker inspect -f '{{.State.Health.Status}}' lumina-postgres 2>/dev/null)" = healthy ] && break; sleep 2
done

echo "== restore database =="
zcat "$DB" | docker compose exec -T postgres psql -q -U lumina -d lumina >/tmp/cutover-restore.log 2>&1 || true
grep -iE 'error' /tmp/cutover-restore.log | grep -viE 'does not exist, skipping' | head && echo "(review any errors above)" || true
echo -n "User rows: "; docker compose exec -T postgres psql -tA -U lumina -d lumina -c 'select count(*) from "User";'

echo "== start full stack =="
docker compose up -d
for i in $(seq 1 45); do
  [ "$(docker inspect -f '{{.State.Health.Status}}' lumina-backend 2>/dev/null)" = healthy ] && break; sleep 2
done

echo "== load uploads =="
docker compose exec -T backend tar -xzf - -C /data < "$UP"
echo -n "uploads entries: "; docker compose exec -T backend sh -c 'find /data/uploads -type f | wc -l'

echo "== health =="
curl -s -o /dev/null -w 'healthz=%{http_code}\n' http://127.0.0.1:4000/healthz
curl -s -o /dev/null -w 'frontend=%{http_code}\n' http://127.0.0.1:5174/

echo "== start Lumina Cloudflare tunnel connector =="
sudo systemctl enable --now cloudflared-lumina.service
sleep 4
systemctl is-active cloudflared-lumina.service
echo "== DONE. Now stop the OLD box's connector, then verify https://lumina.badgerstudios.net =="
