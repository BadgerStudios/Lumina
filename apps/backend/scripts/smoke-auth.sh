#!/usr/bin/env bash
# Auth + permissions + audit-log smoke test against a running dev backend.
# Usage: BASE=http://localhost:4000 bash scripts/smoke-auth.sh
set -uo pipefail

BASE="${BASE:-http://localhost:4000}"
JAR_A=$(mktemp)
JAR_B=$(mktemp)
PASS=0
FAIL=0

check() {
  local desc="$1" expected="$2" actual="$3"
  if [ "$expected" = "$actual" ]; then
    echo "PASS: $desc (got $actual)"
    PASS=$((PASS+1))
  else
    echo "FAIL: $desc (expected $expected, got $actual)"
    FAIL=$((FAIL+1))
  fi
}

rand=$RANDOM$RANDOM

echo "== register user A =="
REG_A=$(curl -s -o /tmp/reg_a.json -w '%{http_code}' -X POST "$BASE/api/auth/register" \
  -H 'Content-Type: application/json' \
  -d "{\"username\":\"alice_$rand\",\"email\":\"alice_$rand@example.com\",\"password\":\"password123\"}")
check "register A -> 201" 201 "$REG_A"
cat /tmp/reg_a.json

echo "== login A (web, cookie) =="
LOGIN_A=$(curl -s -c "$JAR_A" -o /tmp/login_a.json -w '%{http_code}' -X POST "$BASE/api/auth/login" \
  -H 'Content-Type: application/json' \
  -d "{\"emailOrUsername\":\"alice_$rand\",\"password\":\"password123\"}")
check "login A -> 200" 200 "$LOGIN_A"
ACCESS_A=$(node -e "console.log(require('/tmp/login_a.json').accessToken)")
echo "access token A: ${ACCESS_A:0:20}..."
grep lumina_refresh "$JAR_A" && echo "cookie jar A has lumina_refresh" || echo "MISSING refresh cookie for A"

echo "== GET /api/auth/me as A =="
ME_A=$(curl -s -o /tmp/me_a.json -w '%{http_code}' "$BASE/api/auth/me" -H "Authorization: Bearer $ACCESS_A")
check "GET /me -> 200" 200 "$ME_A"
cat /tmp/me_a.json

echo "== refresh A =="
OLD_REFRESH_LINE=$(grep lumina_refresh "$JAR_A")
REFRESH_A1=$(curl -s -c "$JAR_A" -b "$JAR_A" -o /tmp/refresh_a1.json -w '%{http_code}' -X POST "$BASE/api/auth/refresh")
check "refresh A -> 200" 200 "$REFRESH_A1"
NEW_ACCESS_A=$(node -e "console.log(require('/tmp/refresh_a1.json').accessToken)")
NEW_REFRESH_LINE=$(grep lumina_refresh "$JAR_A")
if [ "$OLD_REFRESH_LINE" != "$NEW_REFRESH_LINE" ]; then
  echo "PASS: refresh token rotated (cookie changed)"
  PASS=$((PASS+1))
else
  echo "FAIL: refresh token NOT rotated"
  FAIL=$((FAIL+1))
fi

echo "== confirm OLD refresh token no longer works =="
OLD_TOKEN_VALUE=$(echo "$OLD_REFRESH_LINE" | awk '{print $NF}')
REUSE=$(curl -s -o /tmp/reuse.json -w '%{http_code}' -X POST "$BASE/api/auth/refresh" \
  -H "Cookie: lumina_refresh=$OLD_TOKEN_VALUE")
check "reuse of rotated-out refresh token -> 401" 401 "$REUSE"

echo "== logout A then refresh -> 401 =="
LOGOUT_A=$(curl -s -c "$JAR_A" -b "$JAR_A" -o /dev/null -w '%{http_code}' -X POST "$BASE/api/auth/logout")
check "logout -> 204" 204 "$LOGOUT_A"
REFRESH_AFTER_LOGOUT=$(curl -s -b "$JAR_A" -o /dev/null -w '%{http_code}' -X POST "$BASE/api/auth/refresh")
check "refresh after logout -> 401" 401 "$REFRESH_AFTER_LOGOUT"

echo "== re-login A for the rest of the test (logout burned the session) =="
curl -s -c "$JAR_A" -o /tmp/login_a2.json -X POST "$BASE/api/auth/login" \
  -H 'Content-Type: application/json' \
  -d "{\"emailOrUsername\":\"alice_$rand\",\"password\":\"password123\"}" >/dev/null
ACCESS_A=$(node -e "console.log(require('/tmp/login_a2.json').accessToken)")

echo "== register + login user B =="
curl -s -o /tmp/reg_b.json -X POST "$BASE/api/auth/register" \
  -H 'Content-Type: application/json' \
  -d "{\"username\":\"bob_$rand\",\"email\":\"bob_$rand@example.com\",\"password\":\"password123\"}" >/dev/null
LOGIN_B=$(curl -s -c "$JAR_B" -o /tmp/login_b.json -w '%{http_code}' -X POST "$BASE/api/auth/login" \
  -H 'Content-Type: application/json' \
  -d "{\"emailOrUsername\":\"bob_$rand\",\"password\":\"password123\"}")
check "login B -> 200" 200 "$LOGIN_B"
ACCESS_B=$(node -e "console.log(require('/tmp/login_b.json').accessToken)")
USER_B_ID=$(node -e "console.log(require('/tmp/login_b.json').user.id)")
echo "user B id: $USER_B_ID"

echo "== A creates a server =="
CREATE_SRV=$(curl -s -o /tmp/server.json -w '%{http_code}' -X POST "$BASE/api/servers" \
  -H "Authorization: Bearer $ACCESS_A" -H 'Content-Type: application/json' \
  -d '{"name":"Smoke Test Server"}')
check "create server -> 201" 201 "$CREATE_SRV"
cat /tmp/server.json
SERVER_ID=$(node -e "console.log(require('/tmp/server.json').id)")
SYSTEM_CHANNEL_ID=$(node -e "console.log(require('/tmp/server.json').systemChannelId)")
echo "server id: $SERVER_ID, general channel: $SYSTEM_CHANNEL_ID"

echo "== A creates an invite =="
CREATE_INV=$(curl -s -o /tmp/invite.json -w '%{http_code}' -X POST "$BASE/api/servers/$SERVER_ID/invites" \
  -H "Authorization: Bearer $ACCESS_A" -H 'Content-Type: application/json' -d '{}')
check "create invite -> 201" 201 "$CREATE_INV"
INVITE_CODE=$(node -e "console.log(require('/tmp/invite.json').code)")
echo "invite code: $INVITE_CODE"

echo "== B joins via invite =="
JOIN_B=$(curl -s -o /tmp/join_b.json -w '%{http_code}' -X POST "$BASE/api/invites/$INVITE_CODE/join" \
  -H "Authorization: Bearer $ACCESS_B")
check "B joins -> 201" 201 "$JOIN_B"

echo "== B attempts to delete the general channel (should be 403, default role lacks MANAGE_CHANNELS) =="
DEL_ATTEMPT=$(curl -s -o /tmp/del_attempt.json -w '%{http_code}' -X DELETE "$BASE/api/channels/$SYSTEM_CHANNEL_ID" \
  -H "Authorization: Bearer $ACCESS_B")
check "B delete channel before role grant -> 403" 403 "$DEL_ATTEMPT"

echo "== A creates a role with MANAGE_CHANNELS and grants it to B =="
# MANAGE_CHANNELS bit is 1<<3 = 8
CREATE_ROLE=$(curl -s -o /tmp/role.json -w '%{http_code}' -X POST "$BASE/api/servers/$SERVER_ID/roles" \
  -H "Authorization: Bearer $ACCESS_A" -H 'Content-Type: application/json' \
  -d '{"name":"Channel Manager","permissions":"8"}')
check "create role -> 201" 201 "$CREATE_ROLE"
ROLE_ID=$(node -e "console.log(require('/tmp/role.json').id)")
echo "role id: $ROLE_ID"

GRANT_ROLE=$(curl -s -o /tmp/grant.json -w '%{http_code}' -X POST "$BASE/api/servers/$SERVER_ID/members/$USER_B_ID/roles/$ROLE_ID" \
  -H "Authorization: Bearer $ACCESS_A")
check "grant role to B -> 200" 200 "$GRANT_ROLE"

echo "== B retries deleting the general... wait, delete a NEW channel instead so we don't lose systemChannelId =="
CREATE_CH=$(curl -s -o /tmp/ch2.json -w '%{http_code}' -X POST "$BASE/api/servers/$SERVER_ID/channels" \
  -H "Authorization: Bearer $ACCESS_A" -H 'Content-Type: application/json' -d '{"name":"scratch"}')
check "A creates scratch channel -> 201" 201 "$CREATE_CH"
CH2_ID=$(node -e "console.log(require('/tmp/ch2.json').id)")

DEL_RETRY=$(curl -s -o /tmp/del_retry.json -w '%{http_code}' -X DELETE "$BASE/api/channels/$CH2_ID" \
  -H "Authorization: Bearer $ACCESS_B")
check "B delete channel AFTER role grant -> 204" 204 "$DEL_RETRY"

echo "== A checks audit log for role grant + channel delete =="
AUDIT=$(curl -s -o /tmp/audit.json -w '%{http_code}' "$BASE/api/servers/$SERVER_ID/audit-log" \
  -H "Authorization: Bearer $ACCESS_A")
check "GET audit-log -> 200" 200 "$AUDIT"
cat /tmp/audit.json
HAS_GRANT=$(node -e "const a=require('/tmp/audit.json'); console.log(a.some(e=>e.actionType==='member.role.grant')?'yes':'no')")
HAS_DELETE=$(node -e "const a=require('/tmp/audit.json'); console.log(a.some(e=>e.actionType==='channel.delete')?'yes':'no')")
check "audit log has member.role.grant" "yes" "$HAS_GRANT"
check "audit log has channel.delete" "yes" "$HAS_DELETE"

echo ""
echo "===================="
echo "PASS: $PASS  FAIL: $FAIL"
echo "SERVER_ID=$SERVER_ID"
echo "SYSTEM_CHANNEL_ID=$SYSTEM_CHANNEL_ID"
echo "USER_A_TOKEN=$ACCESS_A"
echo "USER_B_TOKEN=$ACCESS_B"
echo "===================="

rm -f "$JAR_A" "$JAR_B"

if [ "$FAIL" -gt 0 ]; then
  exit 1
fi
