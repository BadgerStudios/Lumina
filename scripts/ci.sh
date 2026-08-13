#!/usr/bin/env bash
#
# The CI checks, runnable here.
#
# .github/workflows/ci.yml has existed for a while and has never once executed: this repository has
# no git remote, so there is no forge to run it. That is not a small gap — it means every commit's
# typecheck, unit tests and production build were only ever verified when somebody remembered to run
# them by hand, which is exactly the thing CI exists to stop relying on.
#
# So the checks live here, in one script, and both callers use it:
#
#   - the GitHub workflow runs `scripts/ci.sh`, so what CI does and what you can run locally cannot
#     drift apart the way two hand-maintained lists always eventually do;
#   - .githooks/pre-push runs it before any push, so the checks are enforced today, with no remote,
#     no forge account and no secrets.
#
# Deliberately does NOT run the verify-*.mjs suites. Those drive a real deployment with a database,
# Redis and a live domain — a different tier, and one that cannot honestly run from a hook.
#
# Usage:  scripts/ci.sh [--quick]
#           --quick   skip the production build and the Swift job (the two slow steps), for a
#                     pre-push check that stays under a few seconds.

set -euo pipefail

cd "$(dirname "$0")/.."

QUICK=0
[ "${1:-}" = "--quick" ] && QUICK=1

failures=()

step() {
  local name="$1"
  shift
  printf '\n\033[1m▸ %s\033[0m\n' "$name"
  if "$@"; then
    printf '\033[32m  ✓ %s\033[0m\n' "$name"
  else
    printf '\033[31m  ✗ %s\033[0m\n' "$name"
    failures+=("$name")
  fi
}

# Prisma's generated client is imported by the backend's own types, so nothing typechecks without
# it. Generation needs no database connection.
step "prisma generate" npx prisma generate --schema apps/backend/prisma/schema.prisma

step "typecheck backend" npx tsc --noEmit -p apps/backend
step "typecheck frontend" npx tsc --noEmit -p apps/frontend
step "unit tests" npx vitest run --root apps/backend --passWithNoTests

if [ "$QUICK" -eq 0 ]; then
  step "frontend build" npm run build --workspace=apps/frontend

  # LuminaKit is deliberately Foundation-only so it builds off an Apple platform. This is what keeps
  # that property honest — importing SwiftUI into it turns this red. Skipped rather than failed when
  # swift is not installed, because that is an environment fact, not a code defect.
  if command -v swift >/dev/null 2>&1; then
    step "swift test" swift test --package-path apps/ios/LuminaKit
  else
    printf '\n\033[33m▸ swift test — skipped (no swift toolchain here)\033[0m\n'
  fi
fi

printf '\n'
if [ ${#failures[@]} -gt 0 ]; then
  printf '\033[31mFAILED: %s\033[0m\n' "${failures[*]}"
  exit 1
fi
printf '\033[32mAll CI checks passed.\033[0m\n'
