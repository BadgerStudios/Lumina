// A short synthesized "ping" via the Web Audio API — deliberately not a bundled audio file, so
// there's no asset to source/license/ship. Respects uiStore's notificationSoundEnabled toggle
// (checked by the caller, see socket/useSocketEvents.ts) — this module just knows how to make
// the sound, not whether it should.
let audioCtx: AudioContext | null = null;

export function playNotificationSound(): void {
  if (typeof window === "undefined") return;
  try {
    audioCtx ??= new AudioContext();
    const ctx = audioCtx;
    const osc = ctx.createOscillator();
    const gain = ctx.createGain();
    osc.type = "sine";
    osc.frequency.setValueAtTime(880, ctx.currentTime);
    osc.frequency.exponentialRampToValueAtTime(660, ctx.currentTime + 0.12);
    gain.gain.setValueAtTime(0.15, ctx.currentTime);
    gain.gain.exponentialRampToValueAtTime(0.001, ctx.currentTime + 0.25);
    osc.connect(gain);
    gain.connect(ctx.destination);
    osc.start();
    osc.stop(ctx.currentTime + 0.25);
  } catch {
    // AudioContext can throw if the browser blocks autoplay before any user gesture —
    // a missed notification sound is not worth surfacing an error for.
  }
}
