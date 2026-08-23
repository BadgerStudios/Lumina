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
    for path, key, ctype in (
        (appimage, f"desktop/Lumina-{version}.AppImage", "application/octet-stream"),
        (manifest, "desktop/latest-linux.yml", "text/yaml"),
    ):
        s3.upload_file(str(path), BUCKET, key, ExtraArgs={"ContentType": ctype}, Config=cfg)
        size = s3.head_object(Bucket=BUCKET, Key=key)["ContentLength"]
        print(f"R2: {key} ({size:,} bytes)")

    if s3.head_object(Bucket=BUCKET, Key=f"desktop/Lumina-{version}.AppImage")["ContentLength"] != appimage.stat().st_size:
        print("uploaded size does not match the local file", file=sys.stderr)
        return 1
    return 0


if __name__ == "__main__":
    if len(sys.argv) != 2:
        print(__doc__, file=sys.stderr)
        raise SystemExit(2)
    raise SystemExit(main(sys.argv[1]))
