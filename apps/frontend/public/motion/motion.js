/*
 * Lumina auth motion — comparison harness.
 *
 *   restrained  what ships today
 *   expressive  trend-forward: odometer digits, spring easing, conic focus ring, morphing submit
 *   cinematic   real spring physics, pointer-reactive depth, and a choreographed success sequence
 *
 * No library. The site CSP is script-src 'self', so GSAP / Framer / Motion One from a CDN would be
 * blocked outright — the spring integrator below is ~30 lines and does the job.
 */

const ACCEPTED = "123456";
const reduced = window.matchMedia("(prefers-reduced-motion: reduce)");

const stage = document.getElementById("stage");
const boxes = Array.from(document.querySelectorAll(".otp-box"));
const hidden = document.getElementById("code");
const rail = document.getElementById("rail");
const codeWrap = document.getElementById("codeWrap");
const codeMsg = document.getElementById("codeMsg");
const codeBtn = document.getElementById("codeBtn");
const codeForm = document.getElementById("codeForm");
const resendBtn = document.getElementById("resendBtn");
const loginForm = document.getElementById("loginForm");
const loginBtn = document.getElementById("loginBtn");
const topbar = document.getElementById("topbar");
const codeScreen = document.getElementById("screenCode");

let settled = false;
let busy = false;

const treatment = () => stage.dataset.treatment;
const cinematic = () => treatment() === "cinematic" && !reduced.matches;

/* ============================================================== spring physics
 *
 * A critically-ish damped spring integrated per frame, rather than a cubic-bezier.
 *
 * The difference only shows when you interrupt it — type a digit before the last one has settled
 * and the strip carries its existing velocity into the new target instead of restarting from zero.
 * A CSS transition cannot do that; it always restarts, which is the small wrongness that makes
 * fast typing feel mechanical.
 */
function makeSpring(onFrame, { stiffness = 210, damping = 24, mass = 1, precision = 0.002 } = {}) {
  let value = 0;
  let target = 0;
  let velocity = 0;
  let raf = 0;

  function step() {
    // Fixed 1/60 sub-steps: a variable dt from rAF makes a stiff spring explode on a dropped frame.
    for (let i = 0; i < 2; i++) {
      const force = -stiffness * (value - target);
      const drag = -damping * velocity;
      velocity += ((force + drag) / mass) * (1 / 120);
      value += velocity * (1 / 120);
    }
    onFrame(value);
    if (Math.abs(value - target) > precision || Math.abs(velocity) > precision) {
      raf = requestAnimationFrame(step);
    } else {
      value = target;
      velocity = 0;
      onFrame(value);
      raf = 0;
    }
  }

  return {
    to(next) {
      target = next;
      if (!raf) raf = requestAnimationFrame(step);
    },
    set(next) {
      cancelAnimationFrame(raf);
      raf = 0;
      value = target = next;
      velocity = 0;
      onFrame(value);
    },
  };
}

// One spring per digit box, driving the strip's vertical offset in em.
const strips = boxes.map((box) => {
  const el = box.querySelector(".otp-strip");
  return { el, spring: makeSpring((v) => { el.style.setProperty("--y", `${v}em`); }) };
});

/* ==================================================================== OTP field */

function paint(previous) {
  const value = hidden.value;
  rail.style.setProperty("--lm-fill", String(value.length / 6));
  codeBtn.disabled = value.length !== 6 || settled || busy;

  boxes.forEach((box, i) => {
    const digit = value[i];
    const strip = strips[i];
    box.classList.toggle("filled", Boolean(digit));
    box.classList.toggle("cursor", !settled && i === value.length);

    // Row 0 is blank, digit d sits at row d+1.
    const row = digit === undefined ? 0 : Number(digit) + 1;

    if (cinematic()) {
      strip.el.style.setProperty("--d", "0"); // CSS transform yields to the spring
      strip.spring.to(-row);
    } else {
      strip.el.style.removeProperty("--y");
      strip.el.style.setProperty("--d", String(row - 1));
    }

    if (previous && previous[i] === undefined && digit !== undefined && treatment() !== "restrained") {
      box.classList.remove("land");
      void box.offsetWidth;
      box.classList.add("land");
    }
  });
}

function setCode(next) {
  const previous = hidden.value;
  hidden.value = next.replace(/\D/g, "").slice(0, 6);
  if (!settled) {
    rail.removeAttribute("data-state");
    codeMsg.textContent = "";
    codeMsg.className = "msg";
    for (const box of boxes) box.classList.remove("bad", "ok");
  }
  paint(previous);
}

// The six boxes are presentational; one real transparent input sits over them so paste, autofill
// and the one-time-code keyboard all keep working — the thing custom OTP fields usually break.
hidden.addEventListener("input", () => setCode(hidden.value));
for (const box of boxes) box.addEventListener("click", () => hidden.focus());
hidden.addEventListener("focus", () => codeWrap.classList.add("focused"));
hidden.addEventListener("blur", () => codeWrap.classList.remove("focused"));

codeWrap.addEventListener("animationend", (e) => {
  if (e.animationName.startsWith("lm-shake")) codeWrap.classList.remove("lm-shake", "lm-shake-hard");
});

/* ==================================================================== outcomes */

/*
 * Success is a sequence, not a state change.
 *
 * Four beats, each waiting on the one before: the rail completes, the confirmation travels across
 * the boxes, the card lifts and blooms, the tick draws. Played simultaneously it reads as noise;
 * played in order it reads as the system finishing something.
 */
function succeed() {
  settled = true;
  codeBtn.disabled = true;
  codeMsg.textContent = "Email confirmed. In the app this holds, then navigates.";
  codeMsg.className = "msg good";
  rail.dataset.state = "ok";

  const step = reduced.matches ? 0 : 1;
  const wave = treatment() === "restrained" ? 0 : 55 * step;

  boxes.forEach((box, i) => window.setTimeout(() => box.classList.add("ok"), i * wave));

  const after = boxes.length * wave;
  window.setTimeout(() => {
    if (cinematic()) {
      codeScreen.classList.add("bloom");
      window.setTimeout(() => codeScreen.classList.remove("bloom"), 1200);
    }
    codeBtn.classList.add("done");
    codeBtn.innerHTML = treatment() === "restrained"
      ? "Confirmed"
      : '<svg class="tick" viewBox="0 0 24 24" aria-hidden="true"><path d="M4 12.5l5 5L20 6.5"/></svg><span>Confirmed</span>';
  }, after);

  paint();
}

function refuse() {
  rail.dataset.state = "bad";
  codeWrap.classList.add(treatment() === "restrained" ? "lm-shake" : "lm-shake-hard");
  for (const box of boxes) box.classList.add("bad");
  codeMsg.textContent = "That code isn't right.";
  codeMsg.className = "msg bad";
  codeBtn.textContent = "Confirm email";
  codeBtn.classList.remove("working");

  // Cinematic only: knock the springs sideways so the digits physically recoil, then settle back.
  if (cinematic()) {
    strips.forEach((s, i) => {
      const row = hidden.value[i] === undefined ? 0 : Number(hidden.value[i]) + 1;
      s.spring.to(-row + 0.22);
      window.setTimeout(() => s.spring.to(-row), 90);
    });
  }
  paint();
}

codeForm.addEventListener("submit", (e) => {
  e.preventDefault();
  if (settled || busy) return;
  busy = true;
  codeBtn.disabled = true;
  codeBtn.classList.add("working");
  codeBtn.innerHTML = '<span class="lm-spinner"></span><span>Checking…</span>';
  window.setTimeout(() => {
    busy = false;
    if (hidden.value === ACCEPTED) succeed();
    else refuse();
  }, 780);
});

resendBtn.addEventListener("click", () => {
  resendBtn.disabled = true;
  resendBtn.innerHTML = '<span class="lm-spinner"></span>Sending…';
  window.setTimeout(() => {
    resendBtn.disabled = false;
    resendBtn.textContent = "Send a new code";
    codeMsg.textContent = "A new code is on its way.";
    codeMsg.className = "msg";
  }, 1100);
});

/* ======================================================================= login */

loginForm.addEventListener("submit", (e) => {
  e.preventDefault();
  if (loginBtn.classList.contains("working") || loginBtn.classList.contains("done")) return;
  loginBtn.classList.add("working");
  loginBtn.disabled = true;
  loginBtn.innerHTML = '<span class="lm-spinner"></span><span class="label">Logging in…</span>';
  window.setTimeout(() => {
    loginBtn.classList.remove("working");
    loginBtn.classList.add("done");
    loginBtn.innerHTML = '<svg class="tick" viewBox="0 0 24 24" aria-hidden="true"><path d="M4 12.5l5 5L20 6.5"/></svg><span class="label">Signed in</span>';
    window.setTimeout(() => {
      loginBtn.classList.remove("done");
      loginBtn.disabled = false;
      loginBtn.innerHTML = "Log In";
    }, 1900);
  }, 1500);
});

/* ====================================================== pointer-reactive depth
 *
 * Cinematic only, and pointer only. A card that tilts under a finger is a card that fights
 * scrolling, so this binds to a fine pointer and nothing else.
 */
const finePointer = window.matchMedia("(hover: hover) and (pointer: fine)");

function bindTilt(card) {
  let raf = 0;
  function move(e) {
    if (!cinematic() || !finePointer.matches) return;
    if (raf) return;
    raf = requestAnimationFrame(() => {
      raf = 0;
      const r = card.getBoundingClientRect();
      const px = (e.clientX - r.left) / r.width - 0.5;
      const py = (e.clientY - r.top) / r.height - 0.5;
      card.style.setProperty("--rx", `${(-py * 5).toFixed(2)}deg`);
      card.style.setProperty("--ry", `${(px * 6).toFixed(2)}deg`);
      card.style.setProperty("--gx", `${((px + 0.5) * 100).toFixed(1)}%`);
      card.style.setProperty("--gy", `${((py + 0.5) * 100).toFixed(1)}%`);
    });
  }
  function leave() {
    card.style.setProperty("--rx", "0deg");
    card.style.setProperty("--ry", "0deg");
  }
  card.addEventListener("pointermove", move);
  card.addEventListener("pointerleave", leave);
}
document.querySelectorAll(".screen").forEach(bindTilt);

/* ============================================================ heading reveal
 *
 * Split once at load, never re-split: re-splitting on every replay would strip the characters back
 * out of the DOM mid-animation and drop screen-reader text on the floor. The original string stays
 * on an aria-label so assistive tech reads a word, not 18 letters.
 */
document.querySelectorAll("[data-split]").forEach((el) => {
  const text = el.textContent.trim();
  el.setAttribute("aria-label", text);
  el.textContent = "";
  [...text].forEach((ch, i) => {
    const span = document.createElement("span");
    span.className = "ch";
    span.setAttribute("aria-hidden", "true");
    span.style.setProperty("--i", String(i));
    span.textContent = ch === " " ? " " : ch;
    el.appendChild(span);
  });
});

/* ==================================================================== controls */

function reset() {
  settled = false;
  busy = false;
  hidden.value = "";
  rail.removeAttribute("data-state");
  codeMsg.textContent = "";
  codeMsg.className = "msg";
  codeBtn.className = "confirm";
  codeBtn.textContent = "Confirm email";
  codeScreen.classList.remove("bloom");
  for (const box of boxes) box.classList.remove("ok", "bad", "land");
  for (const s of strips) s.spring.set(0);
  paint();
}

function typeCode(value, then) {
  reset();
  hidden.focus();
  let i = 0;
  const tick = window.setInterval(() => {
    setCode(value.slice(0, ++i));
    if (i >= value.length) {
      window.clearInterval(tick);
      if (then) window.setTimeout(then, 340);
    }
  }, 150);
}

function replayEntrance() {
  for (const el of document.querySelectorAll(".screen, .reveal")) {
    el.classList.remove("lm-route");
    void el.offsetWidth;
    el.classList.add("lm-route");
  }
}

for (const tab of document.querySelectorAll(".seg button")) {
  tab.addEventListener("click", () => {
    for (const other of document.querySelectorAll(".seg button")) {
      other.setAttribute("aria-selected", String(other === tab));
    }
    const apply = () => {
      stage.dataset.treatment = tab.dataset.treatment;
      document.documentElement.dataset.treatment = tab.dataset.treatment;
      reset();
      replayEntrance();
    };
    // Cross-fades the whole switch where supported; a plain swap everywhere else.
    if (document.startViewTransition && !reduced.matches) document.startViewTransition(apply);
    else apply();
  });
}

document.getElementById("btnGood").addEventListener("click", () =>
  typeCode(ACCEPTED, () => codeForm.requestSubmit()));
document.getElementById("btnBad").addEventListener("click", () =>
  typeCode("408215", () => codeForm.requestSubmit()));
document.getElementById("btnLogin").addEventListener("click", () => loginForm.requestSubmit());
document.getElementById("btnReplay").addEventListener("click", replayEntrance);
document.getElementById("btnTop").addEventListener("click", () => {
  topbar.hidden = false;
  window.setTimeout(() => { topbar.hidden = true; }, 2600);
});

paint();
