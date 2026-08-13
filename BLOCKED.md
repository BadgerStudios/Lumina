# What I need from you

Rewritten 12 August 2026, after a full pre-launch sweep. Several items that used to be here are
done and have been removed — Stripe is configured and verified, offsite backups work, email sends,
and there is now a Terms of Service page. What is left is genuinely yours: a decision, a credential,
or an account only you can create.

Kept as a file in the repo rather than a shared page on purpose: it names which of your live keys is
compromised and how your infrastructure is reached, which isn't something to put behind a URL.

---

## 1. Rotate three credentials that have been exposed

None of these is theoretical — each one left your control at some point, and a key that has left
your control is spent whatever happened to it afterwards.

| What | Why | Where |
|---|---|---|
| Stripe **live secret key** (`sk_live_…`) | Pasted into a chat log. Never written to disk here, but roll it anyway. | Dashboard → Developers → API keys → Roll key, expiry *now* |
| Stripe **restricted key** (`rk_live_…`) currently in `.env` | Same: it crossed chat. Working today, so roll it when you can rather than urgently. | Same page |
| **R2 access key / secret** | Disclosed in an earlier transcript. These are what protect your offsite backups. | Cloudflare → R2 → Manage API tokens |
| **SMTP relay password** | Crossed `~/for-vm-east.md` in plaintext. | Wherever the BadgerOS submission relay's credentials live |
| **Cloudflare tunnel token** | Exposed. Anyone holding it can serve traffic as your hostname. | Zero Trust → Networks → Tunnels → Configure → Refresh token |

After rotating Stripe or R2, put the new values in `/home/lucid/lumina/.env` and tell me — I'll
redeploy and re-verify a real payment and a real restore.

---

## 2. Samba is exposed to the internet — my recommendation is to turn it off

`smbd` and `nmbd` have been listening on **0.0.0.0:445 and :139 since 19 July**, running as root,
with the stock Ubuntu config. It serves no shares of yours — only the default `printers` and
`print$` entries — so nothing of yours is being handed out. But it is a root-privileged network
service on the same box as your production database, exposed for no reason, and SMB is among the
most heavily scanned ports on the internet.

I did not disable it myself: it is a host-level service outside Lumina, and switching off something
you did not ask me to touch is your call, not mine.

```bash
sudo systemctl disable --now smbd nmbd
```

Reversible with `sudo systemctl enable --now smbd nmbd` if you did want it. If you need SMB on the
LAN only, set `bind interfaces only = yes` and an `interfaces = lo <your-lan-if>` line in
`/etc/samba/smb.conf` instead.

Port 22 (SSH) and 3478 (coturn) are also public and both are supposed to be. Port 80 is the host's
own nginx, which correctly 404s for Lumina's hostname — I checked specifically, because a second
path to the origin would let someone bypass Cloudflare and forge their client IP, defeating every
IP-based ban and rate limit. It doesn't.

---

## 3. Legal review of the Terms and Privacy pages

Both pages now exist at `/terms` and `/privacy`, and registration links to both. They describe what
the software actually enforces, clause by clause, so nothing in them is a promise the code doesn't
keep.

They are **not legal advice and have not been reviewed by a lawyer.** Before this instance takes
real users at scale, someone qualified should read them — particularly:

- **Liability and governing law.** Deliberately not guessed at; there is no jurisdiction clause.
- **Payments and refunds.** Sparks are described as non-transferable in-app currency with no cash
  value, and forfeited on a rules ban. Whether that survives consumer-protection law where your
  users live is exactly the question I can't answer.
- **The content licence.** Written narrowly (host, transcode, thumbnail, show to chosen audience).
  Confirm that covers everything you actually intend to do.

---

## 4. Decisions I still need for the ad platform

The mechanics are built and verified: prepaid campaigns, staff review before delivery, spend
accrued per impression, delivery stops at budget. What is not decided is commercial:

- **Minimum spend.** Currently $5 (`MIN_BUDGET_CENTS`), floor CPM $1.
- **Self-serve or approval-gated advertisers?** Today anyone over 18 who passes the risk check can
  create a campaign; a human only reviews the creative.
- **Refund policy** for a campaign cancelled part-way. Right now the unspent budget just stops
  delivering; nothing returns money.

---

## 5. Android push still needs a Firebase project

Web Push works everywhere it can (including installed iPhone home-screen apps). Native Android
notifications need an FCM sender id and a `google-services.json` from a Firebase project you own.
Nothing else is blocking it.

---

## 6. The iOS app needs a Mac

`apps/ios/LuminaKit` — models, HTTP client, session handling, the hand-written Socket.IO protocol —
builds and passes 19 tests on Linux, and its probe passes 12/12 against the live API. The SwiftUI
views and the Xcode project cannot be written honestly here: SwiftUI does not exist off Apple
platforms, so anything I produced would be thousands of lines that have never been near a compiler.
See `docs/ios-build.md`.

---

## 7. Two things to think about before a real launch

Not blockers, and not mine to decide.

**Registration is rate-limited to 10/minute per IP.** That is the right defence against signup
floods, but mobile carriers put thousands of real users behind one address. On a launch day, a
burst from one carrier could be refused. Say the word and I'll raise the burst allowance while
keeping a tighter hourly cap.

**Cloudflare injects an analytics beacon** that the new Content-Security-Policy partly blocks — the
external script is allowed, its inline half is not. That leaves one console warning per page load.
The fix is to turn Web Analytics off for this zone, not to weaken the policy: allowing it needs
`'unsafe-inline'` on `script-src`, which would undo the main protection the policy provides.

---

## Already handled — recorded so it isn't asked for twice

- **Stripe webhook** — Lumina has its own endpoint on the primary host with the six events the
  handler processes, verified with signed requests (accepted, forged rejected, replay rejected).
  The pre-existing endpoint on `badgerstudios.net` belongs to BadgerOS and was left untouched.
- **Offsite backups** — encrypted, uploading nightly, and *proven restorable*: pulled from R2,
  decrypted, loaded into a scratch database with row counts matching production.
- **Email** — sending over the BadgerOS submission relay with DKIM and pinned TLS.
- **Security headers** — HSTS, CSP, nosniff, frame-deny and referrer policy on every page.

---

## 8. Two things worth knowing about the newest features

Added 13 August 2026 alongside stickers, polls, soundboard, link previews, slash commands and
server templates. Neither is a blocker; both are decisions you may want to revisit.

**Link previews make this server fetch URLs that your users choose.** That is unavoidable for the
feature — an unfurl is, definitionally, an outbound request to somewhere a stranger named. The
defence is in `apps/backend/src/lib/safeFetch.ts`: the address is validated at connect time rather
than before it (so DNS rebinding cannot slip between the check and the socket), every redirect hop
is re-validated, private/loopback/link-local/metadata ranges are refused, and the response is capped
and timed out. There are 12 unit tests on the address predicate alone, and `verify-expressions.mjs`
confirms live that `169.254.169.254`, `127.0.0.1` and `postgres:5432` produce no preview while a
public URL does. If you would rather this instance never made outbound requests at all, say so and
I will gate it behind an env flag that defaults to off.

**Bots can now hold a realtime socket.** Slash commands need it — a bot has three seconds to answer
an interaction, which polling cannot meet without hammering the API. A bot connects with its
existing bot token and gets a socket whose identity is its own User row, so it is treated exactly
like any other member, with no separate permission path. That is the same property the HTTP side
already had, but it does mean a leaked bot token is now also a live connection rather than only an
API key.
