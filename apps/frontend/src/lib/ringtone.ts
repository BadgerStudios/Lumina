// A synthesized, looping ring for an incoming call — the same asset-free Web Audio approach as
// notificationSound.ts (nothing to source/license/ship). startRingtone() plays a repeating
// two-tone pattern until stopRingtone(); calling start twice is a no-op.
let audioCtx: AudioContext | null = null;
let loop: ReturnType<typeof setInterval> | null = null;

function tone(ctx: AudioContext, at: number, freq: number, dur: number): void {
  const osc = ctx.createOscillator();
  const gain = ctx.createGain();
  osc.type = "sine";
  osc.frequency.setValueAtTime(freq, at);
  // Short attack/decay envelope so each tone is a soft blip rather than a click.
  gain.gain.setValueAtTime(0.0001, at);
  gain.gain.exponentialRampToValueAtTime(0.12, at + 0.04);
  gain.gain.exponentialRampToValueAtTime(0.0001, at + dur);
  osc.connect(gain);
  gain.connect(ctx.destination);
  osc.start(at);
  osc.stop(at + dur + 0.02);
}

function ringOnce(ctx: AudioContext): void {
  const t = ctx.currentTime;
  tone(ctx, t, 480, 0.35);
  tone(ctx, t + 0.42, 620, 0.35);
}

export function startRingtone(): void {
  if (typeof window === "undefined" || loop) return;
  try {
    audioCtx ??= new AudioContext();
    const ctx = audioCtx;
    // Resume if the autoplay policy suspended it — the user is inside the app, so a prior gesture
    // usually lets this succeed; if it doesn't, the banner still shows silently.
    void ctx.resume?.();
    ringOnce(ctx);
    loop = setInterval(() => ringOnce(ctx), 2500);
  } catch {
    // AudioContext can throw before any user gesture — a silent ring banner is still shown.
  }
}

export function stopRingtone(): void {
  if (loop) {
    clearInterval(loop);
    loop = null;
  }
}
