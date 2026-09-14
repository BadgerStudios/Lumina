#!/usr/bin/env python3
"""Publish a versioned desktop build to the R2 bucket that actually serves it.

apps/frontend/nginx.conf intercepts `^/downloads/(desktop/Lumina-[^/]+\\.AppImage)$` and proxies it
to https://dl.badgerstudios.net/$1 (bucket `lumina-releases`) — versioned builds are immutable, so
they are cached at the edge forever and that is where the auto-update bandwidth goes. Only the
stable, overwritten names (latest-linux.yml, lumina.apk, lumina-desktop.AppImage) come off origin
disk.

deploy.sh used to only copy the versioned AppImage into downloads/desktop/, where nginx never reads
it: the manifest would advertise a version whose binary 404s, and every desktop client would fail
to auto-update. Uploading here is what makes the copy on disk more than a local archive.

The Windows installer rides the same path: versioned, immutable, ~130MB per auto-update. It is
optional — a build that produced no installer (no wine, or a targets change) publishes Linux and
says so, rather than failing the deploy.

Usage: publish-desktop-r2.py <version>          e.g. publish-desktop-r2.py 1.0.45
"""
import base64
import hashlib
import pathlib
import re
import sys

import boto3
from boto3.s3.transfer import TransferConfig

BUCKET = "lumina-releases"
ROOT = pathlib.Path(__file__).resolve().parents[1]


def main(version: str) -> int:
    env = dict(re.findall(r"^([A-Z0-9_]+)=(.*)$", (ROOT / ".env").read_text(), re.M))
    release = ROOT / "apps/desktop/release"
    appimage = release / f"Lumina-{version}.AppImage"
    manifest = release / "latest-linux.yml"
    for f in (appimage, manifest):
        if not f.is_file():
            print(f"missing build artifact: {f}", file=sys.stderr)
            return 1

    # The manifest must describe the binary being uploaded; publishing a mismatched pair puts
    # every client into a download-then-checksum-fail loop.
    want = re.search(r"^sha512: (.+)$", manifest.read_text(), re.M).group(1)
    h = hashlib.sha512(appimage.read_bytes())
    got = base64.b64encode(h.digest()).decode()
    if got != want:
        print(f"manifest sha512 does not match the AppImage\n  manifest {want}\n  file     {got}", file=sys.stderr)
        return 1

    s3 = boto3.client(
        "s3",
        endpoint_url=env["BACKUP_S3_ENDPOINT"],
        aws_access_key_id=env["BACKUP_S3_KEY_ID"],
        aws_secret_access_key=env["BACKUP_S3_SECRET"],
        region_name="auto",
    )
    cfg = TransferConfig(multipart_threshold=64 * 1024 * 1024, multipart_chunksize=32 * 1024 * 1024)
    uploads = [
        (appimage, f"desktop/Lumina-{version}.AppImage", "application/octet-stream"),
        (manifest, "desktop/latest-linux.yml", "text/yaml"),
    ]

    # Windows, when this build produced it. Same manifest/binary cross-check as above: an installer
    # that does not match the sha512 in its own feed puts every Windows client into a
    # download-then-checksum-fail loop, which is worse than having no feed at all.
    setup = release / f"Lumina-Setup-{version}.exe"
    win_manifest = release / "latest.yml"
    if setup.is_file() and win_manifest.is_file():
        want_win = re.search(r"^sha512: (.+)$", win_manifest.read_text(), re.M).group(1)
        got_win = base64.b64encode(hashlib.sha512(setup.read_bytes()).digest()).decode()
        if got_win != want_win:
            print(f"latest.yml sha512 does not match the installer\n  manifest {want_win}\n  file     {got_win}", file=sys.stderr)
            return 1
        uploads += [
            (setup, f"desktop/Lumina-Setup-{version}.exe", "application/octet-stream"),
            (win_manifest, "desktop/latest.yml", "text/yaml"),
        ]
        blockmap = release / f"Lumina-Setup-{version}.exe.blockmap"
        if blockmap.is_file():
            # electron-updater fetches this to work out which parts of the installer it already has;
            # unlike the AppImage, whose block map lives in the file's own tail, NSIS publishes it
            # as a sidecar and a missing one costs a full 130MB download every time.
            uploads.append((blockmap, f"desktop/Lumina-Setup-{version}.exe.blockmap", "application/octet-stream"))
    else:
        print("no Windows installer in this build — publishing Linux only")

    for path, key, ctype in uploads:
        s3.upload_file(str(path), BUCKET, key, ExtraArgs={"ContentType": ctype}, Config=cfg)
        size = s3.head_object(Bucket=BUCKET, Key=key)["ContentLength"]
        # Every artifact, not just the AppImage: a truncated upload is discovered by the client as a
        # sha512 failure with nothing on the server to explain it, and that is a bad way to find out.
        if size != path.stat().st_size:
            print(f"uploaded size does not match the local file: {key} ({size:,} vs {path.stat().st_size:,})", file=sys.stderr)
            return 1
        print(f"R2: {key} ({size:,} bytes)")

    return 0


if __name__ == "__main__":
    if len(sys.argv) != 2:
        print(__doc__, file=sys.stderr)
        raise SystemExit(2)
    raise SystemExit(main(sys.argv[1]))
