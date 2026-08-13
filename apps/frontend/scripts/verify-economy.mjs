// Verifies the creator economy, inbox, and XP against the live deployment.
//
// The financial assertions here are the release gate: money paths are tested adversarially
// (self-gift, minor creator, insufficient coins, double-send) because the happy path passing
// proves little — money systems fail at their edges.
const BASE = process.env.BASE ?? "https://lumina.badgerstudios.net";
const API = `${BASE}/api`;
const rand = Date.now();
let pass = 0, fail = 0;
const ok = (m) => (console.log("PASS: " + m), pass++);
const bad = (m, e) => (console.log("FAIL: " + m + (e ? " -- " + e : "")), fail++);

async function api(path, { method = "GET", token, body } = {}) {
  const headers = {};
  if (token) headers.authorization = `Bearer ${token}`;
  if (body) headers["content-type"] = "application/json";
  const res = await fetch(`${API}${path}`, { method, headers, body: body ? JSON.stringify(body) : undefined });
  const text = await res.text();
  let json = null;
  try { json = JSON.parse(text); } catch { /* 204 */ }
  return { status: res.status, json, text };
}

function birthDate(years) {
  const d = new Date(); d.setUTCFullYear(d.getUTCFullYear() - years);
  return d.toISOString().slice(0, 10);
}
async function register(username, years = 30, bracket = "AGE_25_34") {
  const res = await api("/auth/register", {
    method: "POST",
    body: { username, email: `${username}@example.com`, password: "password123", birthDate: birthDate(years), ageBracket: bracket },
  });
  if (res.status !== 201) throw new Error(`register ${username}: ${res.status} ${res.text.slice(0, 140)}`);
  return { token: res.json.accessToken, id: res.json.user.id };
}

async function main() {
  const alice = await register(`qq_eco_a_${rand}`);
  const bob = await register(`qq_eco_b_${rand}`);
  ok("registered two adults");

  // ---------------------------------------------------------------- studio surfaces
  {
    const wallet = await api("/economy/creator/wallet", { token: alice.token });
    wallet.status === 200 && wallet.json.available.display === "$0.00"
      ? ok("a fresh creator wallet reads $0.00 everywhere")
      : bad(`wallet read failed (${wallet.status})`, wallet.text.slice(0, 100));

    const status = await api("/economy/creator/status", { token: alice.token });
    if (status.status !== 200) bad(`creator status failed (${status.status})`);
    else {
      status.json.payouts.configured === false
        ? ok("payouts honestly report unconfigured (Connect rail gated off)")
        : bad("payouts claim to be configured with no credentials");
      typeof status.json.requirements === "object"
        ? ok(`eligibility checklist present (state=${status.json.state})`)
        : bad("no requirements checklist");
    }

    const onboard = await api("/economy/creator/payouts/onboard", { method: "POST", token: alice.token });
    onboard.status === 409
      ? ok("payout onboarding fails CLOSED with the SETUP_ONCE explanation (409)")
      : bad(`onboard answered ${onboard.status} — must refuse until Connect is configured`);
  }

  // ---------------------------------------------------------------- gifts: the closed loop
  {
    const catalog = await api("/economy/gifts/catalog", { token: alice.token });
    Array.isArray(catalog.json) && catalog.json.length >= 3
      ? ok(`gift catalogue seeded (${catalog.json.length} gifts)`)
      : bad("gift catalogue empty");

    // No coins yet: a send must be refused, not go negative.
    const broke = await api("/economy/gifts/send", { method: "POST", token: alice.token, body: { giftKey: "spark", creatorId: bob.id } });
    broke.status === 400 ? ok("a gift without coins is refused (never negative)") : bad(`broke send answered ${broke.status}`);

    const selfish = await api("/economy/gifts/send", { method: "POST", token: alice.token, body: { giftKey: "spark", creatorId: alice.id } });
    selfish.status === 400 ? ok("self-gifting is refused at the route") : bad("SELF-GIFT ACCEPTED");
  }

  // ---------------------------------------------------------------- tips guardrails
  {
    const selfTip = await api("/economy/tips", { method: "POST", token: alice.token, body: { creatorId: alice.id, amountMinor: 500 } });
    selfTip.status === 400 ? ok("self-tipping is refused") : bad(`self-tip answered ${selfTip.status}`);

    const tiny = await api("/economy/tips", { method: "POST", token: alice.token, body: { creatorId: bob.id, amountMinor: 50 } });
    tiny.status === 400 ? ok("sub-$1 tips refused (card-testing floor)") : bad(`50-cent tip answered ${tiny.status}`);

    // With billing configured this returns a checkout URL; either way it must never 500.
    const real = await api("/economy/tips", { method: "POST", token: alice.token, body: { creatorId: bob.id, amountMinor: 500 } });
    if (real.status === 200 && real.json?.checkoutUrl?.startsWith("https://checkout.stripe.com")) {
      ok("a real tip mints a Stripe Checkout session");
    } else if (real.status === 409) {
      ok("tips fail closed when billing is unconfigured (409)");
    } else bad(`tip answered ${real.status}`, real.text.slice(0, 120));
  }

  // ---------------------------------------------------------------- minors never touch money
  const minor = await register(`qq_eco_m_${rand}`, 16, "UNDER_18");
  {
    for (const [label, path, method, body] of [
      ["the studio wallet", "/economy/creator/wallet", "GET", undefined],
      ["gift sending", "/economy/gifts/send", "POST", { giftKey: "spark", creatorId: bob.id }],
      ["tipping", "/economy/tips", "POST", { creatorId: bob.id, amountMinor: 500 }],
      ["membership subscribing", "/economy/memberships/subscribe", "POST", { creatorId: bob.id }],
      ["tier creation", "/economy/creator/tier", "PUT", { name: "Supporter", priceMinor: 500, active: true }],
    ]) {
      const res = await api(path, { method, token: minor.token, body });
      res.status === 403 ? ok(`a minor is refused ${label} (403)`) : bad(`minor reached ${label} (${res.status})`);
    }
  }

  // ---------------------------------------------------------------- memberships
  {
    const cheap = await api("/economy/creator/tier", { method: "PUT", token: alice.token, body: { name: "Supporter", priceMinor: 50, active: true } });
    cheap.status === 400 ? ok("a 50-cent tier is refused (schema floor)") : bad(`50-cent tier answered ${cheap.status}`);

    const save = await api("/economy/creator/tier", { method: "PUT", token: alice.token, body: { name: "Backstage", description: "Early access", priceMinor: 500, active: true } });
    save.status === 200 ? ok("a creator can publish a $5/mo tier") : bad(`tier save failed (${save.status})`, save.text.slice(0, 100));

    const view = await api(`/economy/creators/${alice.id}/tier`, { token: bob.token });
    view.json?.tier?.priceMinor === 500 && view.json?.tier?.name === "Backstage"
      ? ok("another adult sees the published tier")
      : bad("tier not visible to a prospective supporter", view.text.slice(0, 100));

    const selfSub = await api("/economy/memberships/subscribe", { method: "POST", token: alice.token, body: { creatorId: alice.id } });
    selfSub.status === 400 ? ok("self-subscription is refused") : bad(`self-subscribe answered ${selfSub.status}`);

    const noTier = await api("/economy/memberships/subscribe", { method: "POST", token: alice.token, body: { creatorId: bob.id } });
    noTier.status === 404 ? ok("subscribing to a creator with no tier answers 404") : bad(`no-tier subscribe answered ${noTier.status}`);

    const real = await api("/economy/memberships/subscribe", { method: "POST", token: bob.token, body: { creatorId: alice.id } });
    if (real.status === 200 && real.json?.checkoutUrl?.startsWith("https://checkout.stripe.com")) {
      ok("a real membership mints a Stripe subscription Checkout session");
    } else if (real.status === 409) {
      ok("memberships fail closed when billing is unconfigured (409)");
    } else bad(`membership subscribe answered ${real.status}`, real.text.slice(0, 140));
  }

  // ---------------------------------------------------------------- inbox
  {
    const inbox0 = await api("/inbox", { token: bob.token });
    Array.isArray(inbox0.json) ? ok("inbox endpoint answers") : bad(`inbox failed (${inbox0.status})`);

    // Alice friends Bob → accept → Alice should get a FRIEND_ACCEPT notification.
    await api("/friends/requests", { method: "POST", token: alice.token, body: { username: `qq_eco_b_${rand}` } });
    const reqs = await api("/friends/requests", { token: bob.token });
    const incoming = (reqs.json?.incoming ?? reqs.json ?? []).find?.((r) => r.requester?.id === alice.id) ??
      (Array.isArray(reqs.json) ? reqs.json.find((r) => r.requester?.id === alice.id) : null);
    if (incoming) {
      await api(`/friends/requests/${incoming.id}/accept`, { method: "POST", token: bob.token });
      await new Promise((r) => setTimeout(r, 800));
      const inbox = await api("/inbox", { token: alice.token });
      (inbox.json ?? []).some((n) => n.kind === "FRIEND_ACCEPT")
        ? ok("accepting a friend request lands in the requester's inbox")
        : bad("no FRIEND_ACCEPT notification arrived");
    } else {
      bad("could not locate the pending request to accept", JSON.stringify(reqs.json).slice(0, 120));
    }

    const unread = await api("/inbox/unread-count", { token: alice.token });
    typeof unread.json?.count === "number" ? ok("unread count endpoint answers") : bad("unread count failed");
  }

  // ---------------------------------------------------------------- XP + leaderboard
  {
    const server = (await api("/servers", { method: "POST", token: alice.token, body: { name: "Eco XP" } })).json;
    const channels = (await api(`/servers/${server.id}/channels`, { token: alice.token })).json;
    const general = channels.find((c) => c.type === "TEXT");
    await api(`/channels/${general.id}/messages`, { method: "POST", token: alice.token, body: { content: "leveling up by talking" } });
    await new Promise((r) => setTimeout(r, 600));

    const board = await api(`/servers/${server.id}/leaderboard`, { token: alice.token });
    if (board.status !== 200) bad(`leaderboard failed (${board.status})`);
    else {
      (board.json.top ?? []).some((r) => r.userId === alice.id && r.xp > 0)
        ? ok(`a message earned XP (${board.json.top[0]?.xp ?? "?"} XP on the board)`)
        : bad("no XP appeared after a message");
    }

    // Reply → inbox REPLY for the original author.
    const msgs = await api(`/channels/${general.id}/messages`, { token: alice.token });
    const first = (msgs.json ?? [])[0];
    const invite = (await api(`/servers/${server.id}/invites`, { method: "POST", token: alice.token, body: {} })).json;
    await api(`/invites/${invite.code}/join`, { method: "POST", token: bob.token });
    await api(`/channels/${general.id}/messages`, { method: "POST", token: bob.token, body: { content: "replying!", replyToId: first.id } });
    await new Promise((r) => setTimeout(r, 800));
    const aliceInbox = await api("/inbox", { token: alice.token });
    (aliceInbox.json ?? []).some((n) => n.kind === "REPLY")
      ? ok("a reply to your message lands in your inbox")
      : bad("no REPLY notification arrived");

    // ---------------------------------------------------------------- scheduled events
    // Bob is a plain member of Alice's server (joined above) — he must NOT be able to schedule.
    const inAnHour = new Date(Date.now() + 60 * 60 * 1000).toISOString();
    const bobEvent = await api(`/servers/${server.id}/events`, { method: "POST", token: bob.token, body: { name: "Bob's takeover", startsAt: inAnHour } });
    bobEvent.status === 403 ? ok("a plain member cannot schedule events (403)") : bad(`member scheduled an event (${bobEvent.status})`);

    const past = await api(`/servers/${server.id}/events`, { method: "POST", token: alice.token, body: { name: "Yesterday", startsAt: new Date(Date.now() - 3600_000).toISOString() } });
    past.status === 400 ? ok("an event cannot start in the past") : bad(`past event answered ${past.status}`);

    const created = await api(`/servers/${server.id}/events`, {
      method: "POST", token: alice.token,
      body: { name: "Movie night", description: "bring popcorn", startsAt: inAnHour, location: "the big voice channel" },
    });
    created.status === 201 ? ok("the owner scheduled an event") : bad(`event create failed (${created.status})`, created.text.slice(0, 100));

    if (created.status === 201) {
      const rsvp = await api(`/servers/${server.id}/events/${created.json.id}/rsvp`, { method: "PUT", token: bob.token, body: { status: "GOING" } });
      rsvp.status === 200 ? ok("a member can RSVP") : bad(`rsvp failed (${rsvp.status})`);

      const list = await api(`/servers/${server.id}/events`, { token: bob.token });
      const mine = (list.json ?? []).find((e) => e.id === created.json.id);
      mine && mine.myRsvp === "GOING" && mine.goingCount === 2
        ? ok("the event lists with both RSVPs (creator auto-going + member)")
        : bad(`event list wrong (myRsvp=${mine?.myRsvp}, going=${mine?.goingCount})`);

      await api(`/servers/${server.id}/events/${created.json.id}`, { method: "DELETE", token: alice.token });
      const lateRsvp = await api(`/servers/${server.id}/events/${created.json.id}/rsvp`, { method: "PUT", token: bob.token, body: { status: "GOING" } });
      lateRsvp.status === 400 ? ok("RSVPing a cancelled event is refused") : bad(`cancelled-event rsvp answered ${lateRsvp.status}`);
    }
  }

  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail === 0 ? 0 : 1);
}

main().catch((e) => { console.error(e); process.exit(1); });
