// The app's notification sounds, synthesized rather than bundled — there is no asset to source,
// license or ship, and nothing to download before the first one can play.
//
// Two sounds, not one. A message and a mention used to be indistinguishable, which wastes the one
// advantage sound has over a badge: you can tell what happened without looking at the screen. The
// two share an opening interval so they are recognisably the same app, and differ in where they
// end, which is the part you actually notice.
//
// Both respect uiStore's notificationSoundEnabled — checked by the caller (see
// socket/useSocketEvents.ts). This module knows how to make the sound, not whether it should.

let audioCtx: AudioContext | null = null;

/** Equal-tempered pitches, named so the intervals below are readable as music rather than numbers. */
const E5 = 659.25;
const B5 = 987.77;
const E6 = 1318.51;

/**
 * One note: a sine fundamental with a quiet octave above it.
 *
 * The octave is what stops it sounding like a test tone. A bare sine reads as equipment; a sine
 * with a little of its own octave in it reads as an instrument, at no cost in harshness — which a
 * square or sawtooth would bring immediately at these frequencies.
 */
function scheduleNote(
  ctx: AudioContext,
  destination: AudioNode,
  frequency: number,
  startAt: number,
  duration: number,
  peak: number,
): void {
  for (const [ratio, level] of [
    [1, peak],
    [2, peak * 0.18],
  ] as const) {
    const osc = ctx.createOscillator();
    const gain = ctx.createGain();
    osc.type = "sine";
    osc.frequency.setValueAtTime(frequency * ratio, startAt);

    // An 8ms attack rather than an instant one. Starting a gain at full level produces a click —
    // an audible edge that is the difference between a chime and a pop.
    gain.gain.setValueAtTime(0.0001, startAt);
    gain.gain.exponentialRampToValueAtTime(level, startAt + 0.008);
    gain.gain.exponentialRampToValueAtTime(0.0001, startAt + duration);

    osc.connect(gain);
    gain.connect(destination);
    osc.start(startAt);
    osc.stop(startAt + duration + 0.02);
  }
}

function play(notes: Array<{ freq: number; at: number; dur: number; peak: number }>): void {
  if (typeof window === "undefined") return;
  try {
    audioCtx ??= new AudioContext();
    const ctx = audioCtx;
    // A context created before any user gesture starts suspended and every note is silently
    // dropped. Resuming is a no-op once it is already running, and the promise is ignored on
    // purpose — if the browser still refuses, a missing notification sound is not worth an error.
    if (ctx.state === "suspended") void ctx.resume();

    // One shared output, so the whole motif can be kept at a sensible level in one place rather
    // than each note having to be quiet enough on its own.
    const master = ctx.createGain();
    master.gain.setValueAtTime(0.5, ctx.currentTime);
    master.connect(ctx.destination);

    const now = ctx.currentTime;
    for (const note of notes) {
      scheduleNote(ctx, master, note.freq, now + note.at, note.dur, note.peak);
    }
  } catch {
    // AudioContext can throw outright where autoplay is blocked. Nothing here is worth surfacing.
  }
}

/**
 * A message arrived. A rising fifth — two notes, slightly overlapped so it reads as one gesture
 * rather than two beeps.
 */
export function playNotificationSound(): void {
  play([
    { freq: E5, at: 0, dur: 0.16, peak: 0.22 },
    { freq: B5, at: 0.075, dur: 0.26, peak: 0.2 },
  ]);
}

/**
 * Someone mentioned you. The same opening interval, carried one step further to the octave, so it
 * is recognisably the same app saying something more pointed — and distinguishable from an ordinary
 * message without looking at the phone, which is the entire reason for having two.
 */
export function playMentionSound(): void {
  play([
    { freq: E5, at: 0, dur: 0.14, peak: 0.2 },
    { freq: B5, at: 0.07, dur: 0.16, peak: 0.2 },
    { freq: E6, at: 0.15, dur: 0.3, peak: 0.22 },
  ]);
}
