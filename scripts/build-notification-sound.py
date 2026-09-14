#!/usr/bin/env python3
"""
Renders the Lumina notification tones to WAV, for Android to play at the OS level.

WHY A FILE AT ALL
-----------------
In the web app these are synthesized at runtime (apps/frontend/src/lib/notificationSound.ts) — no
asset to ship, nothing to download before the first one plays. Android cannot do that: a
notification channel is handed a Uri to a sound resource, and the system plays it while the app is
not running. So the same motif has to exist as an actual file, and this is what keeps the two in
step — the frequencies, timings and envelope below are the same numbers as the TypeScript.

WHAT IT PRODUCES
----------------
  apps/mobile/android/app/src/main/res/raw/notify_message.wav   a rising fifth  (E5 -> B5)
  apps/mobile/android/app/src/main/res/raw/notify_mention.wav   carried to the octave (E5 -> B5 -> E6)

WAV rather than OGG because there is no encoder on the build host, and at this length it does not
matter: ~0.4s of 44.1kHz mono 16-bit is about 35KB, against an APK measured in megabytes.

Run:  python3 scripts/build-notification-sound.py     (standard library only)
"""
import math
import os
import struct
import wave

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
DEST_DIR = os.path.join(ROOT, "apps/mobile/android/app/src/main/res/raw")
OWNER_DEST_DIR = os.path.join(ROOT, "apps/owner-mobile/android/app/src/main/res/raw")

RATE = 44_100
# Equal temperament, named so the intervals read as music rather than numbers.
E5, B5, E6 = 659.25, 987.77, 1318.51

# Matches scheduleNote() in notificationSound.ts: a sine fundamental plus a quiet octave above it.
# A bare sine reads as equipment; the octave makes it an instrument without the harshness a square
# or sawtooth brings immediately at these pitches.
HARMONICS = ((1.0, 1.0), (2.0, 0.18))
ATTACK_S = 0.008  # anything shorter is an audible click rather than a chime


def render(notes):
    """notes: (frequency, start_seconds, duration_seconds, peak) -> list of float samples."""
    total = max(start + dur for _, start, dur, _ in notes) + 0.05
    buf = [0.0] * int(total * RATE)

    for freq, start, dur, peak in notes:
        first = int(start * RATE)
        count = int(dur * RATE)
        for i in range(count):
            t = i / RATE
            # Linear attack into an exponential decay — the same shape the Web Audio version gets
            # from setValueAtTime + two exponential ramps.
            if t < ATTACK_S:
                env = t / ATTACK_S
            else:
                env = math.exp(-5.0 * (t - ATTACK_S) / max(dur - ATTACK_S, 1e-6))
            sample = sum(
                level * math.sin(2 * math.pi * freq * ratio * t) for ratio, level in HARMONICS
            )
            index = first + i
            if index < len(buf):
                buf[index] += sample * env * peak
    return buf


def write_wav(path, samples):
    # Normalise to a fixed headroom rather than to whatever the peak happens to be: two files that
    # normalise independently end up at different apparent loudness, and a mention that is quieter
    # than a message would be exactly backwards.
    peak = max(abs(s) for s in samples) or 1.0
    scale = (0.7 / peak) * 32767

    os.makedirs(os.path.dirname(path), exist_ok=True)
    with wave.open(path, "wb") as w:
        w.setnchannels(1)
        w.setsampwidth(2)
        w.setframerate(RATE)
        w.writeframes(b"".join(struct.pack("<h", int(max(-32768, min(32767, s * scale)))) for s in samples))
    return os.path.getsize(path)


TONES = {
    # (freq, start, duration, peak) — the same four numbers per note as the TypeScript.
    "notify_message": [(E5, 0.0, 0.16, 0.22), (B5, 0.075, 0.26, 0.20)],
    "notify_mention": [(E5, 0.0, 0.14, 0.20), (B5, 0.07, 0.16, 0.20), (E6, 0.15, 0.30, 0.22)],
}

for name, notes in TONES.items():
    samples = render(notes)
    for directory in (DEST_DIR, OWNER_DEST_DIR):
        path = os.path.join(directory, f"{name}.wav")
        size = write_wav(path, samples)
        print(f"wrote {os.path.relpath(path, ROOT)} — {len(samples)/RATE:.2f}s, {size/1024:.0f}KB")
