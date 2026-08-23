#!/usr/bin/env python3
"""
Rebuilds the Lumina brand marks from the one master that is actually intact.

WHY THIS EXISTS
---------------
`apps/frontend/public/icons/logo.png` is the app icon: the flame mark inside a rounded-square
tile, with a border stroke, an inner glow and a reflection shelf under the flame. It is opaque and
correct, and it is the only file here with no damage.

Everything derived from it by hand was wrong:

  * `logo-transparent.png` / `-256.png` were produced by a background knockout that applied a
    GLOBAL partial transparency instead of cutting the background out. Measured: 84.8% of pixels
    partially transparent, with the flame body itself sitting at alpha ~205 rather than 255. The
    rounded-square tile frame also survived the knockout as a ghost outline.
  * `apps/backend/assets/lumina-logo.png` — the source `writeLogoAvatar()` uses for EVERY official
    account's avatar — had exactly the same damage, so every official account wore it.

That damaged file was also being served directly as the Lumina account's avatar. Avatars render
`rounded-full` (see UserAvatar.tsx), so a square app icon in a circle lost its corners and showed
the tile's border and glow as clipped arcs inside the circle, around a washed-out semi-transparent
mark. That is the "the logo in my profile picture is a bit messed up" this script fixes.

WHAT IT PRODUCES
----------------
  apps/backend/assets/lumina-logo.png            512x512 opaque  — official-account avatars
  apps/frontend/public/icons/logo-transparent.png      1024 RGBA — a REAL cutout, mark only
  apps/frontend/public/icons/logo-transparent-256.png   256 RGBA

Run:  python3 scripts/build-brand-marks.py     (needs Pillow)
"""
from PIL import Image
import numpy as np
import os, sys

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
SRC  = os.path.join(ROOT, "apps/frontend/public/icons/logo.png")

# Measured off logo.png, not guessed:
#   tile border stroke  ~34px in, ~10px thick, with an inner glow reaching to roughly 120px
#   flame body          x 232-780, y 124-855
#   reflection shelf    y ~883-891  (a light streak the flame appears to stand on)
FRAME_SAFE = (120, 120, 904, 904)   # strictly inside the tile's border AND its inner glow
BODY       = (232, 124, 780, 855)   # the flame itself
SHELF_Y    = 862                    # everything below this is the shelf, not the mark

VOID   = (0x0a, 0x07, 0x14)   # --void
DISC_A = (0x17, 0x10, 0x2e)   # avatar disc, edge
DISC_B = (0x3b, 0x22, 0x6e)   # avatar disc, centre
FILL   = 0.68                 # flame body height as a fraction of the avatar diameter


def flame_rgba() -> Image.Image:
    """The mark cut off its tile, as straight RGBA."""
    a = np.asarray(Image.open(SRC).convert("RGB").crop(FRAME_SAFE)).astype(np.float32)
    lum = 0.2126 * a[:, :, 0] + 0.7152 * a[:, :, 1] + 0.0722 * a[:, :, 2]
    # The tile interior sits at luminance ~12-35; the mark and its glow run 60-255. A soft ramp
    # rather than a hard threshold keeps the glow as real partial alpha, which is what a glow is.
    alpha = np.clip((lum - 30.0) / 55.0, 0.0, 1.0)
    # Drop the reflection shelf: it implies a surface the mark stands on, and a round avatar
    # has no floor for it to stand on.
    cut = SHELF_Y - FRAME_SAFE[1]
    alpha[cut:, :] *= np.clip(np.linspace(1, 0, alpha.shape[0] - cut), 0, 1)[:, None]
    return Image.fromarray(np.dstack([a.astype(np.uint8), (alpha * 255).astype(np.uint8)]), "RGBA")


def disc(size: int) -> Image.Image:
    """Radial brand ground. Gives the mark somewhere to sit that reads as intentional on a light
    theme and still separates from a dark one — a near-black disc does neither."""
    g = Image.new("RGB", (size, size)); px = g.load(); c = (size - 1) / 2
    for y in range(size):
        for x in range(size):
            d = min(1.0, ((x - c) ** 2 + (y - c) ** 2) ** 0.5 / (size * 0.62))
            t = (1 - d) ** 1.7
            px[x, y] = tuple(int(DISC_A[i] + (DISC_B[i] - DISC_A[i]) * t) for i in range(3))
    return g


def avatar(size: int) -> Image.Image:
    f = flame_rgba()
    scale = (size * FILL) / (BODY[3] - BODY[1])
    s = f.resize((int(f.width * scale), int(f.height * scale)), Image.LANCZOS)
    # Centre the BODY, not the glow canvas — otherwise the glow's asymmetry decides the framing.
    bcx = (BODY[0] + BODY[2]) / 2 - FRAME_SAFE[0]
    bcy = (BODY[1] + BODY[3]) / 2 - FRAME_SAFE[1]
    out = disc(size)
    out.paste(s, (int(size / 2 - bcx * scale), int(size / 2 - bcy * scale)), s)
    return out


def cutout(size: int) -> Image.Image:
    """The mark alone on transparency — what logo-transparent.png always claimed to be."""
    f = flame_rgba()
    scale = (size * 0.86) / (BODY[3] - BODY[1])
    s = f.resize((int(f.width * scale), int(f.height * scale)), Image.LANCZOS)
    bcx = (BODY[0] + BODY[2]) / 2 - FRAME_SAFE[0]
    bcy = (BODY[1] + BODY[3]) / 2 - FRAME_SAFE[1]
    out = Image.new("RGBA", (size, size), (0, 0, 0, 0))
    out.paste(s, (int(size / 2 - bcx * scale), int(size / 2 - bcy * scale)), s)
    return out


if __name__ == "__main__":
    if not os.path.exists(SRC):
        sys.exit(f"missing master: {SRC}")
    targets = [
        (os.path.join(ROOT, "apps/backend/assets/lumina-logo.png"), avatar(512)),
        (os.path.join(ROOT, "apps/frontend/public/icons/logo-transparent.png"), cutout(1024)),
        (os.path.join(ROOT, "apps/frontend/public/icons/logo-transparent-256.png"), cutout(256)),
    ]
    for path, im in targets:
        im.save(path)
        print(f"  wrote {os.path.relpath(path, ROOT)}  {im.size}  {os.path.getsize(path)/1000:.0f}KB")
