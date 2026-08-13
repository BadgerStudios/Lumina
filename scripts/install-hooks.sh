#!/usr/bin/env bash
#
# Points git at .githooks/ so the pre-push check is live. Run once per clone — hooks are per-clone
# local config and cannot be committed into .git/hooks by the repository itself, which is the whole
# reason this script exists rather than "the hook is just there".

set -euo pipefail
cd "$(dirname "$0")/.."
git config core.hooksPath .githooks
echo "core.hooksPath -> .githooks"
echo "pre-push will now run scripts/ci.sh --quick. Bypass one push with: git push --no-verify"
