# Lumina outbound mail

Lumina delivers **direct to each recipient's MX** from this box (15.204.122.19), signing DKIM as
`badgerstudios.net`. SPF, DKIM, DMARC alignment and rDNS all pass as of 2026-08-28.

```
lib/mail.ts ──SMTP──> lumina-mail (services/mail-relay) ──port 25──> recipient's MX
  signs DKIM           resolves MX, opportunistic STARTTLS
                       HELO mail.badgerstudios.net
```

`SMTP_HOST=mail`, `SMTP_PORT=2525` — the relay container, on the Docker network only.

## Authentication: what passes, and why

| | value | checked by | result |
|---|---|---|---|
| `From:` header | `Lumina <noreply@lumina.badgerstudios.net>` | what the recipient sees | — |
| envelope `MAIL FROM` | `lumina@badgerstudios.net` | **SPF** | pass — the record lists this IP |
| DKIM `d=` / `s=` | `badgerstudios.net` / `lumina` | **DKIM** | pass — verified end to end |
| PTR / HELO | `mail.badgerstudios.net` | FCrDNS | forward-confirmed both ways |

`_dmarc.badgerstudios.net` publishes `adkim=r; aspf=r` (relaxed), under which a subdomain aligns
with its parent — so the `From:` on `lumina.badgerstudios.net` aligns with both the SPF domain and
the DKIM `d=`. **DMARC passes on either independently**, which is the point: SPF breaks on any forwarding hop
that does not rewrite the envelope (mailing lists, `.forward` rules), while the DKIM signature
survives it. Signing turns a single point of failure into two.

## Live DNS — do not re-derive these, they are published

```
badgerstudios.net              TXT   v=spf1 ip4:15.204.122.19 ip4:15.204.252.37 -all
lumina._domainkey…             TXT   v=DKIM1; k=rsa; p=MIIBIjANBgkq…IDAQAB   (2048-bit)
_dmarc.badgerstudios.net       TXT   v=DMARC1; p=quarantine; adkim=r; aspf=r; fo=1
mail.badgerstudios.net         A     15.204.122.19        (DNS-only — proxying breaks FCrDNS)
15.204.122.19                  PTR   mail.badgerstudios.net   (OVH panel)
```

Selectors `badgeros` and `cf2024-1` on the same zone belong to the BadgerOS mail server and
Cloudflare Email Routing. **Do not reuse them**; Lumina's selector is `lumina`.

## The trap that kept this unsigned

Every piece of DKIM existed for weeks — the key at `secrets/dkim.key`, the mount, the signing code,
`DKIM_SELECTOR=lumina` — but `DKIM_DOMAIN` was **empty**, and `lib/mail.ts` requires both:

```ts
dkim: dkimKey && process.env.DKIM_DOMAIN?.trim() ? { … } : undefined
```

An empty `DKIM_DOMAIN` selects `undefined`, so every message went out unsigned with **no error and
no log line**. Nothing observable distinguished it from working. `scripts/enable-dkim.sh` is the
guarded fix and re-asserts the invariant; it refuses to enable signing unless the published key
matches the private half, because signing under a selector with no published record is *worse* than
not signing — a receiver that finds no key treats the signature as a permanent failure rather than
as absent.

`DKIM_DOMAIN`, like `RELAY_HELO_HOSTNAME`, lives in **`.env`, not `compose.yml`** — compose only
interpolates it (`DKIM_DOMAIN: ${DKIM_DOMAIN:-}`). A `sed` against `compose.yml` matches nothing,
the container is never recreated, and a naive script reports success having changed nothing. Always
assert the **running container's** env after a change, never the file.

## The key file's permissions

`secrets/dkim.key` is `0600` owned by **uid 100:101** — the container's `lumina` user, not `ubuntu`.
The directory is `0700` owned by `ubuntu`, which is what keeps other host users out; the bind mount
does not need that traversal because the Docker daemon resolves the path as root at mount time.
(The comment in `compose.yml` says `0604`/uid 1000, which is stale — chowning to the container uid
achieves the same thing without a world-read bit.) The key is mounted, never baked into the image
and never passed through `environment:`, which is visible to anyone who can run `docker inspect`.

## Why this is not an open relay

The relay publishes **no ports**. It listens on 2525 on the Docker network only, so nothing outside
this stack can reach it, and `MAIL FROM` is additionally restricted to
`RELAY_ALLOWED_SENDER_DOMAINS`. Both restrictions matter: the first is a network control, and
network controls get widened by accident. **Adding a `ports:` entry to the `mail` service turns this
into an open relay for the whole internet.**

## Port 25 on this host is NOT ours

There is an iptables rule `PREROUTING -d 15.204.122.19 -p tcp --dport 25 -j REDIRECT --to-ports
2525`, and `15.204.122.19:25` answers `220 mx.badgerstudios.net BadgerOS ESMTP ready`. **Inbound
mail for badgerstudios.net is served from this box by BadgerOS.** Do not bind port 25, and do not
assume a listener there is Lumina's. Lumina's relay is outbound-only and is reached at `mail:2525`
inside Docker.

## Verifying a change to any of this

Do not trust "it looks signed". Generate a message through the running container's real config and
verify it cryptographically against **live DNS** — the same computation a receiver performs:

```bash
# in the backend container: nodemailer streamTransport with the real key + env, dump raw MIME
# on any host with dkimpy: dkim.verify(raw, dnsfunc=<live TXT lookup>)  ->  must be True
```

To also prove the signature survives the relay hop (where signatures usually die — header
rewriting, `smtplib`'s CRLF normalisation and dot-stuffing), run a throwaway capture container on
the `lumina_default` network with `--network-alias dkimsink` listening on 25, and send to
`probe@dkimsink`. `_resolve_mx` finds no MX, falls back to the A record, and Docker's embedded DNS
resolves the alias — so the message traverses the real relay with **no host port and no DNS change**.
Both checks returned `True` on 2026-08-28.

## Not in use: authenticated submission via vm-east

An alternative path submits through the BadgerOS relay on vm-east (15.204.252.37) over pinned TLS,
letting that box's older IP reputation and its own DKIM selector do the work. `SMTP_USER`/`SMTP_PASS`
are **unset**, so this path is not configured and not running. `secrets/vm-east-submission.pem` is
the pinned certificate kept for it. If it is ever adopted, Lumina should stop signing (`DKIM_DOMAIN=`)
so there is exactly one signature, and `SMTP_TLS_CA_FILE` must point at that PEM — the relay is
self-signed, and `rejectUnauthorized: false` would accept *any* certificate while an AUTH password
crosses the link.

## Reputation

This IP has limited sending history. Authentication passing is necessary, not sufficient: expect
some early mail to land in spam and improve with volume and consistency. Watch the DMARC `rua`
reports at support@badgerstudios.net.
