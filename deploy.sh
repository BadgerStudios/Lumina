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

if [[ "$WEB_ONLY" == true ]]; then
  # A web-only deploy still ships a new frontend bundle, so open tabs are still stale and still
  # need telling. Same call as the full path below.
  if grep -q '^OPS_AGENT_SECRET=.\+' .env; then
    curl -s -X POST http://127.0.0.1:4000/api/meta/announce-update \
      -H "x-lumina-agent-secret: $(grep -oP '^OPS_AGENT_SECRET=\K.*' .env)" --max-time 15 >/dev/null || true
  fi
  echo "== --web-only: skipping Android + desktop builds =="
  echo "Deploy complete: https://lumina.luxffa.com"
  exit 0
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

npm run build:mobile --workspace=apps/frontend
npx cap sync android --project apps/mobile 2>/dev/null || (cd apps/mobile && npx cap sync android)
(
  cd apps/mobile/android
  export JAVA_HOME="$JDK21"
  export ANDROID_HOME="$ANDROID_SDK"
  export PATH="$JAVA_HOME/bin:$PATH"
  ./gradlew assembleDebug --no-daemon
)

echo "== 4/5: publishing APK to /downloads/ =="
cp apps/mobile/android/app/build/outputs/apk/debug/app-debug.apk downloads/lumina.apk
echo "Published: https://lumina.luxffa.com/downloads/lumina.apk"

# Owner console APK — a separate app (com.luxffa.lumina.owner) built from the `dist-owner` bundle,
# which contains only the owner dashboard and none of the chat app. Installs alongside the normal
# app rather than replacing it. Grants nothing by itself: every route it calls is enforced by
# requireOwner server-side, so on a non-owner account it is an inert login screen.
echo "== 4b/5: building + publishing owner console APK =="
npm run build:owner --workspace=apps/frontend
(cd apps/owner-mobile && npx cap sync android)
(
  cd apps/owner-mobile/android
  export JAVA_HOME="$JDK21"
  export ANDROID_HOME="$ANDROID_SDK"
  export PATH="$JAVA_HOME/bin:$PATH"
  ./gradlew assembleDebug --no-daemon
)
cp apps/owner-mobile/android/app/build/outputs/apk/debug/app-debug.apk downloads/lumina-owner.apk
echo "Published: https://lumina.luxffa.com/downloads/lumina-owner.apk"

echo "== 5/5: building + publishing Linux desktop AppImage =="
# Only the Linux target actually builds/runs on this box — win/nsis and mac/dmg in
# apps/desktop/electron-builder.yml are config-only until run on a Windows/Mac machine or CI.
#
# The version is bumped from the same counter as the APK rather than a second one of its own.
# electron-updater compares semver against latest-linux.yml, so a build that ships with the same
# version as the one already installed is invisible to it — a desktop version that never moved
# would mean the auto-updater silently never fired.
DESKTOP_VERSION="1.0.${NEW_ANDROID_VERSION}"
npm --prefix apps/desktop version "$DESKTOP_VERSION" --no-git-tag-version --allow-same-version >/dev/null
echo "Desktop version set to ${DESKTOP_VERSION}"
(cd apps/desktop && npm run package)

# Two publishing paths, deliberately:
#  - downloads/lumina-desktop.AppImage is the stable first-install link handed out on the site.
#  - downloads/desktop/ is the update *feed* electron-updater reads. It needs the versioned
#    filename exactly as recorded in latest-linux.yml, so it cannot be the renamed copy above.
mkdir -p downloads/desktop
cp apps/desktop/release/Lumina-"${DESKTOP_VERSION}".AppImage downloads/desktop/
cp apps/desktop/release/latest-linux.yml downloads/desktop/
cp apps/desktop/release/Lumina-"${DESKTOP_VERSION}".AppImage downloads/lumina-desktop.AppImage
chmod +x downloads/lumina-desktop.AppImage downloads/desktop/*.AppImage

# Keep only the newest few builds in the feed. An AppImage is ~130MB and a client mid-download
# during a deploy is still fetching the previous one, so the current build is never the only one
# kept. Sorted by mtime and deleted by exact name — never a glob passed straight to rm.
ls -1t downloads/desktop/Lumina-*.AppImage 2>/dev/null | tail -n +4 | while read -r stale; do
  echo "Removing superseded desktop build: $(basename "$stale")"
  rm -f -- "$stale"
done

echo "Published: https://lumina.luxffa.com/downloads/lumina-desktop.AppImage"
echo "Update feed: https://lumina.badgerstudios.net/downloads/desktop/latest-linux.yml"

# Mirror every built artifact to R2 and write downloads/releases.json.
#
# Deliberately AFTER the origin copies are in place and deliberately non-fatal: the app is already
# live and serving downloads by this point, so a network blip at Cloudflare must not fail a deploy
# that otherwise succeeded. Skips silently when R2 isn't configured.
echo "== publishing releases to R2 =="
node scripts/publish-release.mjs

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
