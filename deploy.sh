#!/usr/bin/env bash
# Rebuilds and redeploys the whole Lumina stack from current source, then rebuilds the Android
# debug APK + Linux desktop AppImage and republishes both to the /downloads/ endpoint. Run this
# after making code changes.
#
# Usage: ./deploy.sh            full deploy: web stack + Android APK + desktop AppImage
#        ./deploy.sh --web-only skip the native builds (faster iteration on backend/frontend only)
set -Eeuo pipefail
cd "$(dirname "$0")"

JDK21="/home/lucid/tools/jdk-21.0.12+8"
ANDROID_SDK="/home/lucid/android-sdk"
WEB_ONLY=false
[[ "${1:-}" == "--web-only" ]] && WEB_ONLY=true

# Cap the Docker build cache before building.
#
# Every deploy leaves a new set of layers behind, and nothing ever collected them: sixteen deploys
# in one day grew the cache to 106GB and took the disk from 78% to 85% on a box whose remaining
# headroom is also where uploads and backups live. Reaching 100% would have stopped Postgres
# accepting writes — a full disk takes the whole platform down, and the cause looks like nothing to
# do with the app.
#
# `--keep-storage 8GB` rather than a full prune: keeping the recent layers is what makes the NEXT
# build fast, and an unbounded cache and no cache are both wrong. Trimmed BEFORE the build so the
# space is available to it, and non-fatal because a failed cleanup must never block a deploy.
echo "== 0/4: trimming the docker build cache =="
docker builder prune -f --keep-storage 8GB 2>&1 | tail -1 || true

echo "== 1/4: building web images =="
docker compose build

echo "== 2/4: deploying web stack (postgres/redis/backend/frontend) =="
docker compose up -d
echo "waiting for all services to report healthy..."
for i in $(seq 1 30); do
  # Services with no HEALTHCHECK defined (e.g. coturn) report an empty .Health field, which is
  # NOT the same as unhealthy — filter those out too (a line that's just a name + whitespace,
  # no health word) or this loop spins for the full 30 tries and aborts the whole deploy on
  # every run, never reaching the Android/desktop build steps below.
  unhealthy=$(docker compose ps --format '{{.Name}} {{.Health}}' | grep -v 'healthy' | grep -vE '^\S+[[:space:]]*$' || true)

  # A service with its healthcheck disabled reports an empty .Health field and so is skipped by the
  # filter above — which is correct for coturn, and was NOT correct for the worker. The transcoder
  # crash-looped 28 times behind a "all services healthy" line, because "no healthcheck" and "dead"
  # were indistinguishable here. .State catches what .Health cannot: a container that is restarting
  # or has exited is a failed deploy no matter what its healthcheck says.
  crashed=$(docker compose ps -a --format '{{.Name}} {{.State}}' | grep -E ' (restarting|exited|dead)$' || true)
  if [[ -n "$crashed" ]]; then
    echo "ERROR: a service is not staying up:"
    echo "$crashed"
    # The reason is almost always in the first lines after a restart, which `--tail` on the whole
    # stack would bury under the healthy services' output.
    while read -r name _; do docker logs --tail 20 "$name" 2>&1 | sed "s/^/[$name] /"; done <<< "$crashed"
    exit 1
  fi

  if [[ -z "$unhealthy" ]]; then
    echo "all services healthy"
    break
  fi
  if [[ "$i" -eq 30 ]]; then
    echo "ERROR: services did not become healthy in time:"
    echo "$unhealthy"
    docker compose logs --tail 40
    exit 1
  fi
  sleep 2
done

# The native apps BUNDLE the frontend (capacitor webDir / electron renderer), so any deploy that
# changes the UI but skips the native builds strands every installed app on the old interface
# until someone remembers to run a full deploy. --web-only therefore only actually stays web-only
# when the frontend is UNCHANGED since the last native publish — otherwise it escalates itself.
# The operator asked for exactly this: "when we deploy updates, the apps update too."
NATIVE_WEB_HASH_FILE=".last-native-frontend-hash"
frontend_hash() {
  find apps/frontend/src apps/frontend/public apps/frontend/index.html packages/shared/src -type f -print0 \
    | sort -z | xargs -0 sha256sum | sha256sum | cut -d' ' -f1
}

if [[ "$WEB_ONLY" == true ]]; then
  if [[ "$(frontend_hash)" != "$(cat "$NATIVE_WEB_HASH_FILE" 2>/dev/null)" ]]; then
    echo "== --web-only requested, but the frontend changed since the last native build =="
    echo "== escalating to a FULL deploy so installed Android/desktop apps update too =="
    WEB_ONLY=false
  else
    # Backend-only change: the bundled app UI is identical, so natives genuinely need nothing.
    # Open tabs still get told about the new backend.
    if grep -q '^OPS_AGENT_SECRET=.\+' .env; then
      curl -s -X POST http://127.0.0.1:4000/api/meta/announce-update \
        -H "x-lumina-agent-secret: $(grep -oP '^OPS_AGENT_SECRET=\K.*' .env)" --max-time 15 >/dev/null || true
    fi
    echo "== --web-only: frontend unchanged since last native build — skipping Android + desktop =="
    echo "Deploy complete: https://lumina.luxffa.com"
    exit 0
  fi
fi

echo "== 3/5: building Android debug APK =="
# Bump the version the installed app checks itself against (see queries/meta.ts's
# useAndroidUpdateAvailable + UpdateBanner.tsx) — only here, not in the --web-only path above,
# since that path never actually rebuilds/republishes the APK this number is meant to describe.
NEW_ANDROID_VERSION=$(( $(grep -oP 'ANDROID_VERSION_CODE=\K.*' .env) + 1 ))
sed -i "s/^ANDROID_VERSION_CODE=.*/ANDROID_VERSION_CODE=${NEW_ANDROID_VERSION}/" .env
sed -i "s/versionCode [0-9]\+/versionCode ${NEW_ANDROID_VERSION}/" apps/mobile/android/app/build.gradle
sed -i "s/versionName \"[^\"]*\"/versionName \"1.${NEW_ANDROID_VERSION}\"/" apps/mobile/android/app/build.gradle
sed -i "s/^VITE_APP_BUILD=.*/VITE_APP_BUILD=${NEW_ANDROID_VERSION}/" apps/frontend/.env.mobile
# The owner console app rides the SAME counter rather than getting one of its own. It sat at
# versionCode 1 from the day it was created through every rebuild since, which means Android saw
# each new owner APK as the same build as the installed one — no upgrade prompt, and nothing for a
# future updater to compare against. It's a separate applicationId, so sharing the number costs
# nothing and one monotonic counter is easier to reason about than two that drift.
sed -i "s/versionCode [0-9]\+/versionCode ${NEW_ANDROID_VERSION}/" apps/owner-mobile/android/app/build.gradle
sed -i "s/versionName \"[^\"]*\"/versionName \"1.${NEW_ANDROID_VERSION}\"/" apps/owner-mobile/android/app/build.gradle
# The number the owner console's own updater compares against. The Gradle versionCode above is what
# Android enforces at install time; THIS is what the running app knows about itself. If only the
# Gradle one moved, every owner build would ship believing it was version 1 and would offer an
# update to itself forever.
sed -i "s/^VITE_APP_BUILD=.*/VITE_APP_BUILD=${NEW_ANDROID_VERSION}/" apps/frontend/.env.owner
echo "Android version bumped to build ${NEW_ANDROID_VERSION} (chat + owner)"
# The backend container built in step 1 already baked in the OLD ANDROID_VERSION_CODE (.env
# didn't have the new value yet at that point) — restart it now so /api/meta/version reflects
# the version actually being published below.
docker compose up -d backend

# The three native builds (chat APK, owner APK, desktop AppImage) are INDEPENDENT: their web
# bundles go to distinct dirs (dist / dist-owner / dist-desktop) and their packagers touch
# disjoint trees. Running them sequentially made every full deploy pay ~3x the wall time of the
# slowest branch for no correctness gain — so they run concurrently, each logging to its own
# file, and the deploy fails loudly if ANY branch fails. Gradle keeps its daemon + build cache
# (two cold no-daemon JVM starts per deploy were pure waste; the daemon survives between deploys
# and makes incremental APK builds dramatically cheaper).
BUILD_LOGS="/tmp/lumina-native-build-logs"
mkdir -p "$BUILD_LOGS"

build_chat_apk() {
  npm run build:mobile --workspace=apps/frontend
  npx cap sync android --project apps/mobile 2>/dev/null || (cd apps/mobile && npx cap sync android)
  (
    cd apps/mobile/android
    export JAVA_HOME="$JDK21"
    export ANDROID_HOME="$ANDROID_SDK"
    export PATH="$JAVA_HOME/bin:$PATH"
    ./gradlew assembleDebug --build-cache
  )
}

build_owner_apk() {
  npm run build:owner --workspace=apps/frontend
  (cd apps/owner-mobile && npx cap sync android)
  (
    cd apps/owner-mobile/android
    export JAVA_HOME="$JDK21"
    export ANDROID_HOME="$ANDROID_SDK"
    export PATH="$JAVA_HOME/bin:$PATH"
    ./gradlew assembleDebug --build-cache
  )
}

build_desktop() {
  # Builds BOTH the Linux AppImage and a portable Windows zip in one electron-builder run. The
  # Windows *installer* (nsis) needs wine, which isn't on this box — but the `zip` target packages
  # the Windows electron binaries with no wine at all (electron-builder 26 bundles its own
  # signtool/rcedit). Passing --win zip overrides the config's nsis target for exactly this reason.
  (cd apps/desktop && npm run build && npm run build:renderer && npx electron-builder --linux AppImage --win zip)
}

echo "== 3+4+5: building chat APK, owner APK and desktop AppImage IN PARALLEL =="
DESKTOP_VERSION="1.0.${NEW_ANDROID_VERSION}"
npm --prefix apps/desktop version "$DESKTOP_VERSION" --no-git-tag-version --allow-same-version >/dev/null
echo "Desktop version set to ${DESKTOP_VERSION}"

build_chat_apk  > "$BUILD_LOGS/chat-apk.log" 2>&1 &
CHAT_PID=$!
build_owner_apk > "$BUILD_LOGS/owner-apk.log" 2>&1 &
OWNER_PID=$!
build_desktop   > "$BUILD_LOGS/desktop.log" 2>&1 &
DESKTOP_PID=$!

FAILED=""
wait "$CHAT_PID"    || FAILED="$FAILED chat-apk"
wait "$OWNER_PID"   || FAILED="$FAILED owner-apk"
wait "$DESKTOP_PID" || FAILED="$FAILED desktop"
if [[ -n "$FAILED" ]]; then
  for f in $FAILED; do
    echo "==== FAILED BRANCH: $f (last 30 lines) ===="
    tail -30 "$BUILD_LOGS/$f.log"
  done
  exit 1
fi
echo "All three native builds succeeded."

echo "== publishing chat APK to /downloads/ =="
cp apps/mobile/android/app/build/outputs/apk/debug/app-debug.apk downloads/lumina.apk
echo "Published: https://lumina.luxffa.com/downloads/lumina.apk"

# Owner console APK — a separate app (com.luxffa.lumina.owner) built from the `dist-owner` bundle,
# which contains only the owner dashboard and none of the chat app. Installs alongside the normal
# app rather than replacing it. Grants nothing by itself: every route it calls is enforced by
# requireOwner server-side, so on a non-owner account it is an inert login screen.
echo "== publishing owner console APK =="
cp apps/owner-mobile/android/app/build/outputs/apk/debug/app-debug.apk downloads/lumina-owner.apk
echo "Published: https://lumina.luxffa.com/downloads/lumina-owner.apk"

echo "== publishing Linux desktop AppImage =="
# Only the Linux target actually builds/runs on this box — win/nsis and mac/dmg in
# apps/desktop/electron-builder.yml are config-only until run on a Windows/Mac machine or CI.
#
# The version is bumped from the same counter as the APK rather than a second one of its own.
# electron-updater compares semver against latest-linux.yml, so a build that ships with the same
# version as the one already installed is invisible to it — a desktop version that never moved
# would mean the auto-updater silently never fired. (Version is set BEFORE the parallel build
# launch above; the AppImage was built there.)
#
# Two publishing paths, deliberately:
#  - downloads/lumina-desktop.AppImage is the stable first-install link handed out on the site.
#  - downloads/desktop/ is the update *feed* electron-updater reads. It needs the versioned
#    filename exactly as recorded in latest-linux.yml, so it cannot be the renamed copy above.
mkdir -p downloads/desktop
cp apps/desktop/release/Lumina-"${DESKTOP_VERSION}".AppImage downloads/desktop/
cp apps/desktop/release/Lumina-"${DESKTOP_VERSION}".AppImage downloads/lumina-desktop.AppImage
chmod +x downloads/lumina-desktop.AppImage downloads/desktop/*.AppImage

# The versioned AppImage is NOT served from the disk copy above. apps/frontend/nginx.conf matches
# ^/downloads/(desktop/Lumina-[^/]+\.AppImage)$ and proxies it to https://dl.badgerstudios.net
# (R2 bucket lumina-releases) — immutable names, cached at the edge, and that is where the
# auto-update bandwidth lives. Without this upload the manifest below advertises a version whose
# binary 404s and every desktop client fails to update, so it runs BEFORE the manifest is flipped
# and a failure aborts the deploy (set -e) with the old manifest still in place.
scripts/publish-desktop-r2.py "${DESKTOP_VERSION}"

# Manifest LAST and from origin disk (a stable, overwritten name — see the nginx comment on why
# those must not go through the CDN). Until this flips, clients keep resolving the previous
# version and never see a half-published release.
cp apps/desktop/release/latest-linux.yml downloads/desktop/

# Keep only the newest few builds in the feed. An AppImage is ~130MB and a client mid-download
# during a deploy is still fetching the previous one, so the current build is never the only one
# kept. Sorted by mtime and deleted by exact name — never a glob passed straight to rm.
ls -1t downloads/desktop/Lumina-*.AppImage 2>/dev/null | tail -n +4 | while read -r stale; do
  echo "Removing superseded desktop build: $(basename "$stale")"
  rm -f -- "$stale"
done

# The same trim for electron-builder's own output directory, which nothing was collecting: it had
# grown to 15 AppImages and 2.2GB. Only the copies under downloads/ are ever served, so this is
# purely build residue — two are kept so a bisect between the last two builds is still possible.
# Sorted by mtime and deleted by exact name, never a glob passed straight to rm.
ls -1t apps/desktop/release/Lumina-*.AppImage 2>/dev/null | tail -n +3 | while read -r stale; do
  rm -f -- "$stale"
done

echo "Published: https://lumina.luxffa.com/downloads/lumina-desktop.AppImage"
echo "Update feed: https://lumina.badgerstudios.net/downloads/desktop/latest-linux.yml"

# Windows: a PORTABLE build (extract the zip, run Lumina.exe) — not an .exe installer, because the
# nsis installer needs wine, which isn't on this box. The zip is built by build_desktop above with
# no wine at all. Published under a stable name so the site link never changes across versions.
echo "== publishing Windows portable zip =="
if [[ -f "apps/desktop/release/Lumina-${DESKTOP_VERSION}-win.zip" ]]; then
  cp "apps/desktop/release/Lumina-${DESKTOP_VERSION}-win.zip" downloads/lumina-windows.zip
  echo "Published: https://lumina.luxffa.com/downloads/lumina-windows.zip"
  # Trim build residue (a win-unpacked tree + old zips are ~150MB each), keeping the two newest.
  ls -1t apps/desktop/release/Lumina-*-win.zip 2>/dev/null | tail -n +3 | while read -r stale; do
    rm -f -- "$stale"
  done
else
  echo "WARN: Windows zip not found — skipping (Linux/Android publish already succeeded)."
fi

# Mirror every built artifact to R2 and write downloads/releases.json.
#
# Deliberately AFTER the origin copies are in place and deliberately non-fatal: the app is already
# live and serving downloads by this point, so a network blip at Cloudflare must not fail a deploy
# that otherwise succeeded. Skips silently when R2 isn't configured.
echo "== publishing releases to R2 =="
node scripts/publish-release.mjs

# Record what the natives were built from, so a later --web-only can prove the UI is unchanged
# (and escalate itself when it isn't — see the check at the top).
frontend_hash > "$NATIVE_WEB_HASH_FILE"

# Tell every connected client to re-check, now that the new artifacts are actually downloadable.
#
# Deliberately the LAST step. Announcing earlier would point clients at a version whose files
# aren't published yet, and announcing at backend boot would reach nobody — the restart is what
# disconnected them in the first place. Non-fatal: a missed announcement just means clients fall
# back to their own 15-30 minute timers.
if grep -q '^OPS_AGENT_SECRET=.\+' .env; then
  echo "== announcing the update to connected clients =="
  curl -s -X POST http://127.0.0.1:4000/api/meta/announce-update \
    -H "x-lumina-agent-secret: $(grep -oP '^OPS_AGENT_SECRET=\K.*' .env)" \
    --max-time 15 || echo "(announcement failed — clients will pick it up on their own timer)"
  echo
fi

echo
echo "Deploy complete."
echo "  Web:     https://lumina.luxffa.com"
echo "  Android: https://lumina.luxffa.com/downloads/lumina.apk"
echo "  Owner:   https://lumina.luxffa.com/downloads/lumina-owner.apk"
echo "  Desktop: https://lumina.luxffa.com/downloads/lumina-desktop.AppImage"
echo "  Windows: https://lumina.luxffa.com/downloads/lumina-windows.zip"
