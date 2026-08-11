# What I need from you

Everything else is built. These are the items where no amount of engineering gets past the gap —
each one needs a decision, a credential, or an account that only you can create.

Kept as a file in the repo rather than a shared page on purpose: it names which of your live keys
is compromised and how your infrastructure is reached, which isn't something to put behind a URL.

---

## 1. Stripe keys — blocks #69 (billing), #85 (ad platform), #86 (advertiser payments)

**This is the only item that is also a live security issue, so it's first.**

Your live secret key (`sk_live_…`) was pasted into a chat and must be treated as compromised. It
was never written to disk or into this repo, but it has to be rolled regardless — a key that has
left your control is spent, whatever happened to it afterwards.

**What to do:**

1. Go to Stripe Dashboard → Developers → API keys.
2. **Roll the live secret key.** Use "Roll key" with an expiry of *now*, not "reveal and reuse".
3. Copy the new values into `/home/lucid/lumina/.env`:
   - `STRIPE_SECRET_KEY=sk_live_…`
   - `STRIPE_PUBLISHABLE_KEY=pk_live_…`
4. Stripe Dashboard → Developers → Webhooks → your endpoint → **Signing secret**. Copy that into
   `STRIPE_WEBHOOK_SECRET=whsec_…`. The webhook endpoint should be
   `https://lumina.badgerstudios.net/api/billing/webhook`.
5. Create the products/prices you want to sell, and put the price id in
   `STRIPE_PRICE_PREMIUM_MONTHLY=price_…`.
6. Tell me, and I'll run `./deploy.sh --web-only` and verify a real checkout end to end.

**Do not paste the keys into chat.** Edit `.env` directly — `nano /home/lucid/lumina/.env` — or run
the edit yourself with a `!` command. I never need to see the value; the app reads it from the
environment and I verify by making Stripe answer, not by reading the secret.

**Decisions I also need before #85 (the ad platform) is more than plumbing:**

- What is actually being sold? Feed placements (a promoted video every N cards), banner slots, or
  server-level sponsorships?
- Priced how — CPM, CPC, or flat per day?
- Who approves an advertiser's creative before it runs? Right now the only review queue is the
  staff video queue; ads either reuse it or need their own.
- Minimum spend, and do you want self-serve signup or approval-gated advertiser accounts?

---

## 2. Cloudflare tunnel token — rotate

Same reasoning as the Stripe key: it was exposed. Anyone holding it can stand up a tunnel that
serves traffic as your hostname.

**What to do:** Cloudflare Zero Trust → Networks → Tunnels → your tunnel → Configure → **Refresh
token**, then update wherever the connector reads it and restart the connector. Nothing in this
repo needs to change.

---

## 3. UI redesign direction — blocks #65

I have three complete directions ready to build. I need you to pick one; I won't guess, because
this is taste and it touches every screen.

| | **Aurora** | **Console** | **Atlas** |
|---|---|---|---|
| Feel | Soft, luminous, gradient-lit | Dense, technical, high-contrast | Calm, editorial, spacious |
| Density | Comfortable | Tight — more on screen | Generous |
| Colour | Deep base + accent glow | Near-black + one signal colour | Warm neutrals + restrained accent |
| Best if | Lumina should feel like a *place* | You live in it all day | It should feel trustworthy and adult |
| Risk | Can read as "gamer app" | Can read as cold | Wastes space on phones |

Reply with a single word — Aurora, Console, or Atlas — and I'll build it across every surface. If
you'd rather see them first, say so and I'll mock the same three screens in each.

---

## 4. Smartwatch target — blocks #87

"Smartwatch" is three different products. Pick the one you actually want:

- **Wear OS (Android watches)** — a real companion app. Reuses the existing Android project and
  push plumbing. Most work, most capability: notifications, quick replies, voice-to-text.
- **Apple Watch** — needs an iOS app first, which needs a Mac and a paid Apple Developer account
  ($99/yr). I can't build or test this on this box at all. Flagging honestly rather than starting.
- **Notification-only, both platforms** — no watch app; the phone's notifications simply mirror to
  the watch and quick-reply works through the existing notification actions. Small, and covers
  most of what people actually use a watch for.

**My recommendation: notification-only first**, then Wear OS if you still want more. It's a
fraction of the work and delivers most of the value.

Also tell me what else "expanded device compatibility" means to you — TV? Tablet layouts? A CLI
client? Those are all real and all different.

---

## 5. Offsite backups — small, but needs a bucket

Nightly backups run and are verified, but they're on the **same disk** as the thing they're backing
up. That protects against a mistake; it does not protect against the disk dying.

**What I need:** any S3-compatible bucket — Cloudflare R2, Backblaze B2, Wasabi, or AWS S3. Create
one, then create credentials **scoped to that bucket only** (not account-wide), and put them in
`.env` as `BACKUP_S3_ENDPOINT`, `BACKUP_S3_BUCKET`, `BACKUP_S3_KEY_ID`, `BACKUP_S3_SECRET`. R2 is
the cheapest for this shape of data (no egress fees).

I'll wire the upload into `scripts/backup.sh` and verify a restore from the remote copy — an
untested backup isn't a backup.

---

## 6. Email — blocks account verification and password reset

Registration accepts any email and never checks it, and there is no password reset at all. Both are
built up to the point where they need to actually send a message.

**What I need:** either SMTP details (host, port, username, password) or an API key from a
transactional provider — Resend, Postmark, Mailgun and SES all work. You'll also need to verify
your sending domain with them, which is a DNS record or two on `badgerstudios.net`.

---

## 7. Android push — still open from earlier

Native Android notifications need a Firebase project and a `google-services.json`. Web Push already
works everywhere else, so this only affects the installed APK when it isn't running.

**What I need:** create a Firebase project, add an Android app with package name
`com.luxffa.lumina`, download `google-services.json`, and drop it at
`apps/mobile/android/app/google-services.json`. The Gradle build already picks it up if present.

---

## 8. Legal text — blocks a real ToS/Privacy policy

The pages exist and are linked from registration, but the content is honest placeholder. Real text
needs you or a lawyer — I can draft, but I shouldn't be the source of the terms a real platform
handling real users' age data operates under.

Relevant because you now collect dates of birth, IP-based upload provenance, and (soon) payment
information. Those specifically need to be named in a privacy policy.

---

## Not blocked — I've decided these myself, as asked

- **#88 Lumina Control** — building it as a host-side agent that *pushes* to the app, never an
  inbound path from the internet to Docker. See the note in `lumina_roadmap.md`.
- **#89 Addon system** — building it declarative: an addon is a manifest, not code. "Any CLI can
  deploy an addon" would be remote code execution as a feature.
