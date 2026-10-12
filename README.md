# Lumina

my self made replacement to discord that doesnt sell user data.

Lumina is a hosted community platform: servers, channels, voice, video and a short-video feed, run and
operated by Badger Studios.

- Website: <https://lumina.badgerstudios.net>
- Privacy policy: <https://lumina.badgerstudios.net/privacy>
- Terms: <https://lumina.badgerstudios.net/terms>

This repository holds **built releases only**. It contains no source code; Lumina is proprietary
software (see [LICENSE](LICENSE)).

## Downloads

Get the newest build from the [latest release](https://github.com/BadgerStudios/Lumina/releases/latest).

| Platform | File |
|---|---|
| Android (sideload APK) | `lumina-<build>.apk` |
| Windows installer | `Lumina-Setup-<version>.exe` |
| Windows (zip, no install) | `Lumina-<version>-win.zip` |
| Linux | `Lumina-<version>.AppImage` |

Lumina also runs in any modern browser and can be installed from the website as a home-screen app,
which is the way to use it on iPhone. Android users can alternatively use the build served from the
website's downloads page.

## Checksums

Every release carries a `SHA256SUMS.txt` listing the SHA-256 of each file in that release.

Current release, v1.0.143 (build 143):

```
8e7df3d9bb486e35c9cd68c930fd2933fcb8b2b78e448a3c65350a20d7540031  Lumina-1.0.143-win.zip
96ff705b79cb3e68798e6ead45569ea8e94330595b1ef55892bc760e2ae1066a  Lumina-1.0.143.AppImage
f34fdd12c31cb30d053e9f95276d5cd7ba09cffa08828a6d6f6bd4997b295100  Lumina-Setup-1.0.143.exe
f22454f694d936b778cba0fb66d63585cf7b36798deb5c0e308430c0fab65b63  lumina-1.143.apk
```

## How to verify a download

Put the downloaded file and `SHA256SUMS.txt` in one folder, then:

```sh
# Linux / macOS (only checks the files you actually downloaded)
sha256sum --ignore-missing -c SHA256SUMS.txt
```

```powershell
# Windows PowerShell
Get-FileHash .\Lumina-Setup-1.0.143.exe -Algorithm SHA256
```

The hash printed must match the line for that file. If it does not, do not install it. Releases here
are immutable: once published, a release's files and tag cannot be changed or replaced.

## Privacy

Lumina does not sell user data. What is collected and why is set out in the
[privacy policy](https://lumina.badgerstudios.net/privacy). Questions: use the contact details on the
website.

&copy; 2026 Badger Studios. All rights reserved.
