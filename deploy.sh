#!/usr/bin/env bash
# Rebuilds and redeploys the whole Lumina stack from current source, then rebuilds the Android
# debug APK + Linux desktop AppImage and republishes both to the /downloads/ endpoint. Run this
# after making code changes.
#
# Usage: ./deploy.sh            full deploy: web stack + Android APK + desktop AppImage
#        ./deploy.sh --web-only skip the native builds (faster iteration on backend/frontend only;
#                               escalates to a full deploy by itself if the frontend changed — see
#                               the hash check below)
#        JDK21=… ANDROID_SDK=… ./deploy.sh   point the native builds at a toolchain elsewhere
set -Eeuo pipefail
cd "$(dirname "$0")"

# Never as root. One root-run deploy (24 Aug) left root-owned files scattered through
# apps/frontend/dist*, apps/desktop/renderer and both android/ trees; every build as the normal user
# after that died on EACCES in vite's emptyDir / capacitor's `update android`, and the way out was a
# chown -R of the whole repo. Nothing here needs root — docker is reached through group membership.
if [[ "$EUID" -eq 0 ]]; then
  echo "ERROR: deploy.sh must run as the normal user, not root (sudo) — a root-owned build tree breaks every later deploy." >&2
  exit 1
fi

# Native toolchain. Overridable from the environment so this script isn't tied to one machine's
# paths; the defaults are where this box keeps them (the JDK path is a symlink to
# ~ubuntu/tools/jdk-21.0.12.1+1, the SDK is the 19 Aug install with platforms;android-36 and
# build-tools 35/36). Verified by require_native_toolchain before anything is bumped or built.
JDK21="${JDK21:-/home/lucid/tools/jdk-21.0.12+8}"
ANDROID_SDK="${ANDROID_SDK:-/home/lucid/android-sdk}"
# Per-user, because a root-owned /tmp/lumina-native-build-logs left by that same root run made
# every later deploy fail on "Permission denied" writing its own logs.
BUILD_LOGS="/tmp/lumina-native-build-logs-$(id -un)"
WEB_ONLY=false
[[ "${1:-}" == "--web-only" ]] && WEB_ONLY=true

# Mounted secrets keep the modes compose.yml documents: secrets/ is 0700 (no other host user can
# traverse it) and the files the backend mounts are 0604, because the backend runs as uid 100 and
# cannot read a 0600 file owned by uid 1000. The DKIM key had drifted to 0600, and the backend
# quietly sent every verification and reset email UNSIGNED until this was put back.
if [[ -d secrets ]]; then
  chmod 0700 secrets
  for f in secrets/dkim.key secrets/vm-east-submission.pem; do
    [[ -f "$f" ]] && chmod 0604 "$f"
  done
fi

# coturn's config file, carrying the TURN shared secret that used to sit on its command line (see
# the coturn service in compose.yml). Rewritten from .env on every deploy so a rotated secret reaches
# coturn and the backend together. Written even without a secret: a bind mount of a missing file
# makes Docker create a directory in its place and coturn then refuses to start.
python3 - <<'TURNCONF'
import os, re
secret = ""
if os.path.exists(".env"):
    for line in open(".env", encoding="utf-8"):
        m = re.match(r"\s*(?:export\s+)?TURN_SECRET\s*=\s*(.*?)\s*$", line)
        if not m:
            continue
        v = m.group(1)
        if len(v) >= 2 and v[0] == v[-1] and v[0] in "\"'":
            v = v[1:-1]
        else:
            v = re.sub(r"\s+#.*$", "", v)
        secret = v
os.makedirs("secrets", mode=0o700, exist_ok=True)
tmp = "secrets/turnserver.conf.tmp"
fd = os.open(tmp, os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o600)
with os.fdopen(fd, "w") as f:
    f.write("# Written by deploy.sh from .env. Do not edit here.\n")
    if secret:
        f.write(f"static-auth-secret={secret}\n")
os.chmod(tmp, 0o604)
os.replace(tmp, "secrets/turnserver.conf")
TURNCONF

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

BUILD_NATIVE=true
if [[ "$WEB_ONLY" == true ]]; then
  if [[ "$(frontend_hash)" != "$(cat "$NATIVE_WEB_HASH_FILE" 2>/dev/null)" ]]; then
    echo "== --web-only requested, but the frontend changed since the last native build =="
    echo "== escalating to a FULL deploy so installed Android/desktop apps update too =="
  else
    BUILD_NATIVE=false
  fi
fi

# Decided up front, before the web stack is touched. A full deploy whose native half cannot even
# start would leave the web UI ahead of every installed app — the exact state the escalation above
# exists to prevent — and it used to bump the version counters first and only then discover there
# was no JDK on the box.
require_native_toolchain() {
  local ok=true
  if ! "$JDK21/bin/java" -version >/dev/null 2>&1; then
    echo "ERROR: no usable JDK at JDK21=$JDK21" >&2
    ok=false
  fi
  if [[ ! -d "$ANDROID_SDK/platforms" || ! -d "$ANDROID_SDK/build-tools" ]]; then
    echo "ERROR: no Android SDK at ANDROID_SDK=$ANDROID_SDK (expected platforms/ and build-tools/ inside it)" >&2
    ok=false
  fi
  if ! mkdir -p "$BUILD_LOGS" 2>/dev/null || [[ ! -w "$BUILD_LOGS" ]]; then
    echo "ERROR: cannot write native build logs under $BUILD_LOGS" >&2
    ok=false
  fi
  if [[ "$ok" != true ]]; then
    echo "Nothing was deployed. Install the toolchain or point JDK21= / ANDROID_SDK= at it and re-run." >&2
    exit 1
  fi
}
[[ "$BUILD_NATIVE" == true ]] && require_native_toolchain

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

if [[ "$BUILD_NATIVE" == false ]]; then
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

echo "== 3/5: building Android debug APK =="
# Bump the version the installed app checks itself against (see queries/meta.ts's
# useAndroidUpdateAvailable + UpdateBanner.tsx) — only here, not in the --web-only path above,
# since that path never actually rebuilds/republishes the APK this number is meant to describe.
PREV_ANDROID_VERSION=$(grep -oP 'ANDROID_VERSION_CODE=\K.*' .env)
NEW_ANDROID_VERSION=$(( PREV_ANDROID_VERSION + 1 ))

# From here until the first artifact is published, a failure has to put the tree back. Five
# tracked files plus the untracked .env carry the new build number, and the backend is restarted
# below advertising it — left like that, every installed app is told an update exists that was
# never published, and the next deploy bumps again on top of a phantom. Reversed by undoing each
# substitution exactly (not `git checkout`, which would also throw away any real edit sitting in
# those files). Once publishing has begun the opposite holds: a half-published release needs a
# person, not an automatic rewind.
PUBLISHING=false
revert_version_bumps() {
  echo "== deploy failed before publishing anything: undoing the bump ${PREV_ANDROID_VERSION} -> ${NEW_ANDROID_VERSION} =="
  sed -i "s/versionCode ${NEW_ANDROID_VERSION}\b/versionCode ${PREV_ANDROID_VERSION}/" \
    apps/mobile/android/app/build.gradle apps/owner-mobile/android/app/build.gradle
  sed -i "s/versionName \"1\.${NEW_ANDROID_VERSION}\"/versionName \"1.${PREV_ANDROID_VERSION}\"/" \
    apps/mobile/android/app/build.gradle apps/owner-mobile/android/app/build.gradle
  sed -i "s/^VITE_APP_BUILD=${NEW_ANDROID_VERSION}$/VITE_APP_BUILD=${PREV_ANDROID_VERSION}/" \
    apps/frontend/.env.mobile apps/frontend/.env.owner
  sed -i "s/^ANDROID_VERSION_CODE=${NEW_ANDROID_VERSION}$/ANDROID_VERSION_CODE=${PREV_ANDROID_VERSION}/" .env
  npm --prefix apps/desktop version "1.0.${PREV_ANDROID_VERSION}" --no-git-tag-version --allow-same-version >/dev/null 2>&1 || true
  # Re-bake the old number into /api/meta/version, or the running backend keeps advertising it.
  docker compose up -d backend >/dev/null 2>&1 || true
  echo "== tree restored to build ${PREV_ANDROID_VERSION}; the web stack deployed above stays up =="
}
on_exit() {
  local rc=$?
  [[ "$rc" -eq 0 ]] && return
  set +e  # the rewind must run to the end even if one of its own steps fails
  if [[ "$PUBLISHING" == true ]]; then
    echo "!! deploy failed DURING publishing: build ${NEW_ANDROID_VERSION} may be half-published. Check downloads/, downloads/desktop/ and R2 by hand before re-running." >&2
  else
    revert_version_bumps
  fi
}
trap on_exit EXIT

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
#
# -Dorg.gradle.java.home pins Gradle itself to $JDK21 (Capacitor 8 needs 21) without relying on the
# shell's JAVA_HOME — the pin used to live in apps/mobile/android/gradle.properties as a hardcoded
# path, which is one machine's path and broke the build on every other one.
build_chat_apk() {
  npm run build:mobile --workspace=apps/frontend
  npx cap sync android --project apps/mobile 2>/dev/null || (cd apps/mobile && npx cap sync android)
  (
    cd apps/mobile/android
    export JAVA_HOME="$JDK21"
    export ANDROID_HOME="$ANDROID_SDK"
    export PATH="$JAVA_HOME/bin:$PATH"
    ./gradlew -Dorg.gradle.java.home="$JDK21" assembleDebug --build-cache
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
    ./gradlew -Dorg.gradle.java.home="$JDK21" assembleDebug --build-cache
  )
}

build_desktop() {
  # Builds the Linux AppImage, the Windows installer and the portable Windows zip in one
  # electron-builder run. The installer needs wine, which IS on this box (wine-10.0) — the note
  # that used to say otherwise predated it, and its absence is why Windows had no update feed and
  # the site linked an installer from August. The
  # Windows *installer* (nsis) needs wine, which isn't on this box — but the `zip` target packages
  # the Windows electron binaries with no wine at all (electron-builder 26 bundles its own
  # signtool/rcedit). Passing --win zip overrides the config's nsis target for exactly this reason.
  (cd apps/desktop && npm run build && npm run build:renderer && npx electron-builder --linux AppImage --win nsis zip)
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

# Past this line a failure is no longer rewound (see on_exit) — artifacts start reaching users.
PUBLISHING=true
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
# The INSTALLER and its feed, published exactly like the AppImage: versioned binary to R2 first
# (via publish-desktop-r2.py above, which uploads it when the build produced one), manifest last,
# from origin disk. Until latest.yml exists there, an installed Windows client has no feed to read
# at all — which is why every Windows install sat on whatever version it was first given.
echo "== publishing Windows installer =="
if [[ -f "apps/desktop/release/Lumina-Setup-${DESKTOP_VERSION}.exe" ]]; then
  cp "apps/desktop/release/Lumina-Setup-${DESKTOP_VERSION}.exe" downloads/desktop/
  [[ -f "apps/desktop/release/Lumina-Setup-${DESKTOP_VERSION}.exe.blockmap" ]] &&
    cp "apps/desktop/release/Lumina-Setup-${DESKTOP_VERSION}.exe.blockmap" downloads/desktop/
  # A stable name for the site to link, so the download page can never again point at a version
  # that stopped being built months ago.
  cp "apps/desktop/release/Lumina-Setup-${DESKTOP_VERSION}.exe" downloads/lumina-windows-setup.exe
  cp apps/desktop/release/latest.yml downloads/desktop/
  echo "Published: https://lumina.luxffa.com/downloads/lumina-windows-setup.exe"
  echo "Update feed: https://lumina.badgerstudios.net/downloads/desktop/latest.yml"
  # Same trim as the AppImages, and for the same reason: a client mid-download during a deploy is
  # still fetching the previous one. Sorted by mtime, deleted by exact name.
  ls -1t downloads/desktop/Lumina-Setup-*.exe 2>/dev/null | tail -n +4 | while read -r stale; do
    echo "Removing superseded Windows build: $(basename "$stale")"
    rm -f -- "$stale" "$stale.blockmap"
  done
  ls -1t apps/desktop/release/Lumina-Setup-*.exe 2>/dev/null | tail -n +3 | while read -r stale; do
    rm -f -- "$stale" "$stale.blockmap"
  done
else
  echo "WARN: Windows installer not found — skipping (the rest of the publish already succeeded)."
fi

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

# Checksums for everything served at /downloads/.
#
# This file used to be written by hand, once, and then drifted. By build 100 every Lumina hash in
# it was wrong and it still named Lumina-Setup-1.0.45.exe, a file that had not been built for
# fifty-five releases. That is worse than publishing no checksums at all: the download page tells
# people to verify against it, so everyone who actually did got a mismatch on every Lumina file —
# which is precisely the signal of a tampered binary.
#
# Runs after publish-release.mjs because that step writes downloads/releases.json, and hashing
# before it would leave exactly one line in here wrong on every single deploy.
#
# Generated from the files being served rather than maintained alongside them, so the two cannot
# disagree again. Written to a temp name and moved, because this runs while the directory is public
# and a half-written checksum file is worse than a stale one. Everything at the top level is
# included, which means a new artifact is covered the day it is first published without anyone
# remembering to add it; downloads/desktop/ is left out, since that is electron-updater's feed and
# carries its own sha512 inside latest*.yml.
echo "== writing downloads/SHA256SUMS.txt =="
(
  cd downloads
  find . -maxdepth 1 -type f ! -name 'SHA256SUMS.txt*' -printf '%P\n' \
    | sort \
    | xargs -r sha256sum > SHA256SUMS.txt.tmp
  mv SHA256SUMS.txt.tmp SHA256SUMS.txt
)
echo "Published: https://lumina.badgerstudios.net/downloads/SHA256SUMS.txt"


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

# ── snapshot what was just published ─────────────────────────────────────────
# After the deploy rather than before it, so the archive always holds the last three builds that
# actually shipped — which is what you want to roll back TO. A failure here must not fail a deploy
# that already succeeded (the site is live either way), but it is reported loudly rather than
# swallowed: backups that quietly stop happening are only discovered when one is needed.
if ! ./scripts/release-backup.sh "$NEW_ANDROID_VERSION"; then
  echo
  echo "WARNING: the deploy succeeded but the release backup FAILED." >&2
  echo "         Run ./scripts/release-backup.sh $NEW_ANDROID_VERSION by hand before deploying again," >&2
  echo "         or this build will have no restore point." >&2
fi

echo
echo "Deploy complete."
echo "  Build ${NEW_ANDROID_VERSION} is published, but its version bumps are NOT committed (this script never commits):"
echo "    git commit -am 'Release build ${NEW_ANDROID_VERSION}: chat + owner APKs 1.${NEW_ANDROID_VERSION}, desktop 1.0.${NEW_ANDROID_VERSION}'"
echo "  Web:     https://lumina.luxffa.com"
echo "  Android: https://lumina.luxffa.com/downloads/lumina.apk"
echo "  Owner:   https://lumina.luxffa.com/downloads/lumina-owner.apk"
echo "  Desktop: https://lumina.luxffa.com/downloads/lumina-desktop.AppImage"
echo "  Windows: https://lumina.luxffa.com/downloads/lumina-windows.zip"
