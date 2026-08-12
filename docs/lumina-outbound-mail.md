# Lumina outbound mail

Lumina sends through the **BadgerOS submission relay** on vm-east (15.204.252.37), authenticated
over pinned TLS. A local direct-to-MX relay also exists on this box as a fallback; both are
described below.

## Primary path — authenticated submission via vm-east

```
lib/mail.ts ──TLS:465, AUTH──> mx.badgerstudios.net ──> recipient's MX
                                signs DKIM, owns the SPF authorisation
```

This is the better path and the one in use, because vm-east already *is* what
badgerstudios.net's DNS points at: `v=spf1 ip4:15.204.252.37 -all` authorises it, it DKIM-signs
with its own selector, and its IP has real sending history. **No DNS change is required for this to
work** — that is the whole appeal.

Config lives in `.env` (`SMTP_HOST`/`SMTP_PORT`/`SMTP_USER`/`SMTP_PASS`/`SMTP_SECURE`). Lumina does
*not* DKIM-sign on this path: vm-east signs, and adding a second signature under a selector with no
published record would attach a signature that fails to verify — harmless for DMARC, but noise in
every receiver's authentication results.

### The certificate is pinned, not ignored

The relay presents a self-signed certificate. The operator offered either pinning it or connecting
with verification disabled. **We pin it** (`SMTP_TLS_CA_FILE` → `secrets/vm-east-submission.pem`,
with `servername` set to the relay hostname): an AUTH password crosses this connection, and
`rejectUnauthorized: false` accepts *any* certificate, which is exactly what a
machine-in-the-middle needs in order to collect it. Pinning encrypts just as well and additionally
proves we reached the right host.

### Rotating the password

The relay's operator regenerates it on request and republishes it. Update `SMTP_PASS` in `.env` and
`docker compose up -d backend`. It is worth doing: the current value was transmitted in plaintext
over a coordination channel.

---

## Fallback path — direct MX delivery from this box


```
lib/mail.ts  ──SMTP──>  lumina-mail (services/mail-relay)  ──port 25──>  recipient's MX
  signs DKIM             resolves MX, opportunistic STARTTLS
```

The relay publishes **no ports**. It listens on 2525 on the Docker network only, so nothing outside
this stack can reach it, and `MAIL FROM` is additionally restricted to
`RELAY_ALLOWED_SENDER_DOMAINS`. Both restrictions matter: the first is a network control, and
network controls get widened by accident. **Adding a `ports:` entry to the `mail` service turns
this into an open relay for the whole internet.**

## Why the envelope sender is a different domain from the From: header

badgerstudios.net publishes `v=spf1 ip4:15.204.252.37 -all` — a **hard fail** for anything sent from
this host. Widening it would mean editing a record shared with the BadgerOS mail server, risking its
deliverability for a change it gets nothing from.

Instead, `_dmarc.badgerstudios.net` publishes `adkim=r; aspf=r` — **relaxed** alignment, under which
a subdomain aligns with its parent. So:

| | value | checked against |
|---|---|---|
| `From:` header | `Lumina <lumina@badgerstudios.net>` | what the recipient sees |
| envelope `MAIL FROM` | `bounce@lumina.badgerstudios.net` | **SPF** — its own record, below |
| DKIM `d=` | `badgerstudios.net` | **DKIM** — its own selector, below |

Both align with the visible From: under relaxed alignment, so DMARC passes on either. The existing
SPF record is never touched.

## Required DNS — both records are ADDITIVE, neither modifies anything existing

**1. SPF for the envelope domain**

```
Type:  TXT
Name:  lumina.badgerstudios.net
Value: v=spf1 ip4:15.204.81.153 -all
```

Safe alongside the existing web record at that name — SPF is a TXT record and does not affect the
A/CNAME that serves the site.

**2. DKIM public key**

```
Type:  TXT
Name:  lumina._domainkey.badgerstudios.net
Value: v=DKIM1; k=rsa; p=MIIBIjANBgkqhkiG9w0BAQEFAAOCAQ8AMIIBCgKCAQEAiRgtB1uJkdbo37yEycXBtlrrTqZGcRNMHexbJfw39ZsdUPyThR6H6+pcAeOznLBR9S/RpGxpurcEjdDyCGpqsM3kSmVbhil9OFokayp6826O734fHeTT0ZY0V+duGu3rx1dTBwFSdUbEhwXN/HPJ65Uxy80+LvBJg/8KR3k75k69+2e9IjIYAQaQg6suXyfIsPZ/2ze7o37tOZjOg/5/2sVWq1P7HCnJ0+9BRdPBRDGvcHtRk177kTA6Kx69qVCD1f6vLDvbWzur9WhY6PtxF7SCz7q+RXkmH19e17qzGeQSG9o1WtwQZ+qpw4rg/b7NHJbt26pmg9cITFxbKEjpJwIDAQAB
```

The private half is `secrets/dkim.key` (gitignored, 0604 inside a 0700 directory — see the comment
in `compose.yml` for why those two numbers go together). It is mounted into the backend, not baked
into the image and not passed as an env var.

Until both records exist, Gmail rejects with
`550 5.7.26 ... requires all senders to authenticate with either SPF or DKIM`. That rejection is the
correct behaviour and confirms the delivery path itself works — it means we reached Google's MX.

## Optional: reverse DNS

`15.204.81.153` currently reverses to `vps-cb3aedf3.vps.ovh.us`, which **forward-confirms** (that
name resolves back to this IP), so the HELO name agrees with the PTR — the check receivers actually
weigh. It is unbranded but correct, and correct matters far more than branded.

To brand it, in the OVH panel: create `mail.lumina.badgerstudios.net` A → 15.204.81.153 as
**DNS-only (grey cloud — a proxied record would resolve to Cloudflare and break the match)**, set the
reverse DNS for the IP to that name, then set `RELAY_HELO_HOSTNAME` to match. Do all three or none;
a HELO that disagrees with the PTR is worse than the unbranded name that agrees.

## Reputation

This IP has no sending history. Expect early mail to land in spam even once authentication passes.
That improves with volume and time, and is the honest cost of sending from a new IP — the BadgerOS
box, which has been sending for longer, would not have this problem, which is why that handover is
still worth completing.
