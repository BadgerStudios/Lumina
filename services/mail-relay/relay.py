"""Outbound-only SMTP relay for Lumina.

## Why this exists

`lib/mail.ts` speaks SMTP to a relay; it cannot deliver mail by itself, because delivering means
looking up the recipient's MX and connecting to it, and nodemailer is a client, not an MTA. The
original plan was to relay through the BadgerOS mail box (15.204.252.37), which refuses us with
`550 5.7.1 Relay access denied` — correctly, since it is not an open relay. That handover is still
open (see docs/badgeros-mail-relay.md) and is still the better long-term shape, because that IP is
the one badgerstudios.net's SPF record authorises.

This service is the path that does not depend on somebody else's box: **this host can reach port 25
outbound** (verified against gmail-smtp-in, alt1.aspmx.l.google.com and mx.badgerstudios.net), so
mail can go straight to each recipient's MX from here.

## Why this is not an open relay

An open relay is found by scanners within hours, and the consequence is the IP being blacklisted —
which would take out Lumina's mail entirely, and is exactly the failure the BadgerOS box is
protecting itself against by refusing us. Two independent restrictions:

1. **Reachability.** No port is published to the host. It listens only on the Docker network, so
   the only things that can open a connection are the other Lumina containers. This is the same
   trust boundary postgres and redis already sit behind.
2. **Sender domain.** `MAIL FROM` must be a domain in `ALLOWED_SENDER_DOMAINS`. Even something that
   got onto the Docker network could only forge our own domains, not use this as a general relay.

The second matters because the first is a network control, and network controls get widened by
accident. A published port would otherwise silently turn this into a relay for the whole internet.

## Delivery is inline, not queued

`handle_DATA` delivers before returning a status, so nodemailer learns whether the mail actually
went. The alternative — accept, return 250, deliver in the background — reports success for mail
that later bounces, and the failure then exists only in this container's logs where nobody looks.

The cost is that `sendMail` blocks for the length of a real SMTP conversation. That is affordable
because every caller in `lib/mail.ts` already fires and forgets: no request path waits on this.
`DELIVER_TIMEOUT` stays under nodemailer's 20s `socketTimeout` so a stalled MX surfaces as a clean
timeout on our side rather than the client giving up on a connection we still think is live.

## Attribution

`_resolve_mx` and `send_message` are adapted from the BadgerOS mail server on this host
(`~/.local/share/badgeros/app/src/badgeros/mailserver.py`), which already solved direct MX delivery
including the opportunistic-STARTTLS handling. They are **copied rather than imported**: that is a
different project's internals, on a path this repo does not own, and an import would make Lumina's
mail break the day it is refactored. Both depend only on the standard library plus `dig`.
"""

from __future__ import annotations

import asyncio
import logging
import os
import smtplib
import ssl
import subprocess
import sys
import threading
from typing import Dict, List, Sequence

from aiosmtpd.controller import Controller

LOG = logging.getLogger("lumina-mail-relay")

LISTEN_HOST = os.environ.get("RELAY_LISTEN_HOST", "0.0.0.0")
LISTEN_PORT = int(os.environ.get("RELAY_LISTEN_PORT", "2525"))

# HELO name we announce to receiving servers. This should be a name whose forward lookup returns
# this host's IP and whose PTR returns that same name (forward-confirmed reverse DNS) — Gmail weighs
# that agreement heavily. `vps-cb3aedf3.vps.ovh.us` currently satisfies it; a branded name would be
# better for reputation but needs the PTR changed in the OVH panel first, and a HELO that disagrees
# with the PTR is worse than an unbranded one that agrees.
HELO_HOSTNAME = os.environ.get("RELAY_HELO_HOSTNAME", "").strip()

# See "Why this is not an open relay" above. Empty means refuse everything, deliberately: a
# misconfiguration should stop mail, never widen who we send for.
ALLOWED_SENDER_DOMAINS = {
    d.strip().lower()
    for d in os.environ.get("RELAY_ALLOWED_SENDER_DOMAINS", "").split(",")
    if d.strip()
}

DELIVER_TIMEOUT = int(os.environ.get("RELAY_DELIVER_TIMEOUT", "15"))


def _resolve_mx(domain: str) -> List[str]:
    """MX hosts for a domain, best first, falling back to the domain itself.

    Resolved by shelling out to the system resolver rather than adding a DNS library: there is
    exactly one query shape needed here, and every machine that can run a mail server already has a
    resolver. (`bind-tools` is installed in the image for exactly this.)
    """
    try:
        completed = subprocess.run(
            ["dig", "+short", "MX", domain], capture_output=True, text=True, timeout=15
        )
        hosts = []
        for line in completed.stdout.splitlines():
            parts = line.split()
            if len(parts) == 2 and parts[1].endswith("."):
                hosts.append((int(parts[0]), parts[1].rstrip(".")))
        if hosts:
            return [host for _, host in sorted(hosts)]
    except (OSError, ValueError, subprocess.SubprocessError):
        pass
    # No MX is legitimate: RFC 5321 says fall back to the A record.
    return [domain]


def send_message(
    raw: bytes, *, sender: str, recipients: Sequence[str], timeout: int = DELIVER_TIMEOUT
) -> Dict[str, object]:
    """Deliver directly to each recipient's MX.

    No smarthost: this host can reach port 25, so mail goes straight to the destination. That also
    means this IP's reputation is the only thing vouching for the message — the honest limitation of
    running your own mail server, and not something more code fixes. SPF and DKIM are what actually
    carry the domain's authorisation; see docs/lumina-outbound-mail.md for the records involved.

    Recipients are grouped by domain so one connection serves all the addresses at that domain, and
    a failure for one domain does not stop the others.
    """
    by_domain: Dict[str, List[str]] = {}
    for address in recipients:
        if "@" not in address:
            continue
        by_domain.setdefault(address.rsplit("@", 1)[-1].lower(), []).append(address)

    delivered: List[str] = []
    failures: Dict[str, str] = {}
    for domain, addresses in by_domain.items():
        last_error = "no MX host answered"
        for host in _resolve_mx(domain):
            try:
                with smtplib.SMTP(host, 25, timeout=timeout) as client:
                    if HELO_HOSTNAME:
                        client.ehlo(HELO_HOSTNAME)
                    # Opportunistic TLS: many receivers offer it, and mail in the clear across the
                    # internet is worse than mail that is merely unauthenticated. A receiver that
                    # does not offer STARTTLS still gets the message.
                    try:
                        if client.has_extn("starttls"):
                            client.starttls(context=ssl.create_default_context())
                            client.ehlo(HELO_HOSTNAME or None)
                    except (smtplib.SMTPException, ssl.SSLError) as exc:
                        LOG.info(
                            "STARTTLS to %s failed, continuing in the clear: %s", host, exc
                        )
                    client.sendmail(sender, addresses, raw)
                delivered.extend(addresses)
                last_error = ""
                break
            except (OSError, smtplib.SMTPException, TimeoutError) as exc:
                last_error = f"{host}: {exc}"
                continue
        if last_error:
            failures[domain] = last_error

    return {"ok": not failures, "delivered": delivered, "failures": failures}


class LuminaRelayHandler:
    """aiosmtpd handler. Accepts submission from inside the Docker network and delivers outbound."""

    async def handle_MAIL(self, server, session, envelope, address, mail_options):
        domain = address.rsplit("@", 1)[-1].lower() if "@" in address else ""
        if domain not in ALLOWED_SENDER_DOMAINS:
            LOG.warning(
                "refused MAIL FROM <%s> from %s — domain not in RELAY_ALLOWED_SENDER_DOMAINS",
                address,
                session.peer[0] if session.peer else "?",
            )
            return "550 5.7.1 Sender domain not permitted"
        envelope.mail_from = address
        envelope.mail_options.extend(mail_options)
        return "250 OK"

    async def handle_RCPT(self, server, session, envelope, address, rcpt_options):
        # Deliberately unrestricted: the whole point is delivering to real users' inboxes, wherever
        # those are. The sender-domain check in handle_MAIL is what keeps this from being an open
        # relay — restricting recipients here instead would break the feature and secure nothing.
        envelope.rcpt_tos.append(address)
        return "250 OK"

    async def handle_DATA(self, server, session, envelope):
        loop = asyncio.get_running_loop()
        # smtplib is blocking, and blocking the event loop would stall every other in-flight
        # delivery behind whichever MX is slowest to answer.
        result = await loop.run_in_executor(
            None,
            lambda: send_message(
                envelope.original_content,
                sender=envelope.mail_from,
                recipients=envelope.rcpt_tos,
            ),
        )
        if result["ok"]:
            LOG.info("delivered %s -> %s", envelope.mail_from, result["delivered"])
            return "250 Message accepted for delivery"

        LOG.error("delivery failed %s -> %s", envelope.mail_from, result["failures"])
        # 451 (transient), not 550: the common causes here are a greylisting receiver or a momentary
        # network problem, and reporting those as permanent would tell the caller to give up on mail
        # that would succeed on a retry.
        return "451 4.4.1 Delivery to recipient MX failed"


def main() -> None:
    logging.basicConfig(
        level=logging.INFO, format="%(asctime)s %(levelname)s %(name)s: %(message)s"
    )

    if not ALLOWED_SENDER_DOMAINS:
        LOG.error(
            "RELAY_ALLOWED_SENDER_DOMAINS is empty — refusing to start. Set it to the domains "
            "Lumina sends as, e.g. 'lumina.badgerstudios.net,badgerstudios.net'."
        )
        sys.exit(1)

    LOG.info(
        "listening on %s:%s, HELO=%s, senders=%s",
        LISTEN_HOST,
        LISTEN_PORT,
        HELO_HOSTNAME or "(default)",
        sorted(ALLOWED_SENDER_DOMAINS),
    )

    controller = Controller(
        LuminaRelayHandler(),
        hostname=LISTEN_HOST,
        port=LISTEN_PORT,
        # Verification mail carries a signed token and a QR-adjacent link; a generous cap costs
        # nothing and avoids a silent truncation the day a template grows.
        data_size_limit=10 * 1024 * 1024,
    )
    controller.start()

    # `Controller.start()` runs the server on its own thread with its own event loop, so the main
    # thread only has to stay alive. Blocking on an Event rather than `get_event_loop().run_forever()`:
    # that call is deprecated from 3.12 when no loop is already current, and would compete with the
    # loop the controller just created.
    try:
        threading.Event().wait()
    except KeyboardInterrupt:
        controller.stop()


if __name__ == "__main__":
    main()
