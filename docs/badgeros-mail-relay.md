# Letting Lumina send mail to real users

**This change is made on the BadgerOS mail box (15.204.252.37), not on the Lumina box.** Neither
Claude session can reach it — SSH refuses both `root` and `lucid` (publickey,password), port 80 is
a stock nginx page, and SMTP exposes no admin verbs. So this is a handover, not a task.

## What is already done, on the Lumina side

Nothing further is needed here. Verified live against `mx.badgerstudios.net`:

- Connection and EHLO succeed. The server advertises `SIZE` and `8BITMIME` — **no STARTTLS, no
  AUTH** — so Lumina connects plaintext with the auth block omitted.
- Mail **from** `Lumina <lumina@badgerstudios.net>` **to** `support@badgerstudios.net` is accepted
  with a queue id: `250 2.0.0 Accepted`.
- Mail to `michaelcoyle466@gmail.com` is refused: `550 5.7.1 Relay access denied`.

## The problem, stated precisely

The server accepts mail **for** the domains it hosts and refuses to forward mail **to** anywhere
else. That is correct and deliberate — a server that relays for anyone is found by spammers within
hours and the IP is blacklisted, which would take out badgerstudios.net's mail entirely.

The consequence is that verification email reaches `@badgerstudios.net` and
`@mailtest.badgerstudios.net`, and no one else. Every real Lumina user is on Gmail or similar.

## The fix — allowlist ONE client, do not open the relay

In `mailserver.py`, the RCPT handler currently accepts a recipient only when its domain is local.
It needs one more condition: **also accept when the connecting client is a known relay client.**

```python
# Hosts permitted to relay OUTBOUND mail through this server.
# Exactly one entry. This must never become a broad range or a wildcard: a server that relays for
# anyone is an open relay, and an open relay is found by spammers within hours — after which this
# IP is blacklisted and badgerstudios.net stops delivering mail anywhere at all.
RELAY_CLIENTS = {"15.204.81.153"}          # the Lumina box

async def handle_RCPT(self, server, session, envelope, address, rcpt_options):
    domain = address.rsplit("@", 1)[-1].lower()
    peer_ip = session.peer[0]

    if domain in LOCAL_DOMAINS or peer_ip in RELAY_CLIENTS:
        envelope.rcpt_tos.append(address)
        return "250 OK"

    return "550 5.7.1 Relay access denied"
```

Then restart the service.

### Better, if you would rather not pin an IP

Add SMTP AUTH and give Lumina a credential. An IP allowlist breaks silently if that box is ever
renumbered — mail simply stops, with the only evidence in a log nobody is watching. With AUTH, set
these on the Lumina side and it picks them up on the next `docker compose up -d backend`:

```
SMTP_USER=lumina
SMTP_PASS=<the password you issue>
```

`lib/mail.ts` already omits the auth block when `SMTP_USER` is empty and includes it when set, so no
code change is needed here either way.

## Two things to expect afterwards

**1. Gmail will probably spam-folder it at first.** SPF (`v=spf1 ip4:15.204.252.37 -all`), DKIM
(selector `badgeros`) and DMARC (`p=none`) are all present and correct. The weak point is reverse
DNS: `15.204.252.37` resolves to `vps-dcf7e251.vps.ovh.us`, which does not match
`mx.badgerstudios.net`. Gmail weighs PTR/HELO agreement heavily. Fix it in the OVH panel — set the
reverse DNS for that IP to `mx.badgerstudios.net`.

**2. The hop is plaintext.** The server advertises no STARTTLS, so mail crosses the internet
unencrypted — and verification links are single-use credentials. Both boxes are OVH so it likely
stays inside their network, but adding STARTTLS to `mailserver.py` closes it properly.

## Optional: a real mailbox for `lumina@`

Sending as `lumina@badgerstudios.net` works **without** a mailbox existing — SPF and DKIM authorise
the *domain*, not the address. So nothing below is required for verification mail to work.

It only matters for **receiving**. Until a `lumina@` mailbox exists, Lumina sets
`Reply-To: support@badgerstudios.net`, so anyone replying to a verification email reaches a human
rather than a black hole. Create the mailbox and drop `SMTP_REPLY_TO` from `.env` if you would
rather replies land in their own inbox.
