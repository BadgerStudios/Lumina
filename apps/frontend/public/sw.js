// Minimal service worker whose only job is Web Push delivery + click routing — no offline
// caching/precaching strategy here (deliberately not building a PWA cache layer, just the push
// plumbing this needs to exist for at all). Registered from src/lib/push.ts.

self.addEventListener("install", () => {
  self.skipWaiting();
});

self.addEventListener("activate", (event) => {
  event.waitUntil(self.clients.claim());
});

self.addEventListener("push", (event) => {
  if (!event.data) return;
  let payload;
  try {
    payload = event.data.json();
  } catch {
    return;
  }
  const { title, body, url, tag, urgent } = payload;
  event.waitUntil(
    self.registration.showNotification(title || "Lumina", {
      body,
      tag,
      icon: "/icons/pwa-192.png",
      badge: "/icons/pwa-192.png",
      data: { url: url || "/" },
      // --- wearable behaviour ------------------------------------------------------------------
      // A phone notification is glanced at; a watch notification is felt. These four fields are
      // what decide whether a watch is useful or gets muted within a day.
      //
      // `tag` already collapses a conversation into one notification instead of forty. `renotify`
      // says the replacement should still alert — without it, a collapsed notification updates
      // silently and a second message never reaches the wrist at all. Together they give exactly
      // one buzz per new message per conversation, which is the behaviour people actually want.
      renotify: Boolean(tag),
      // Short and distinct. A long pattern on a watch is unpleasant rather than more noticeable.
      vibrate: urgent ? [90, 60, 90] : [60],
      // Never sticky. A notification a watch refuses to dismiss on its own is the single fastest
      // way to get notifications turned off entirely.
      requireInteraction: false,
      // Watches surface actions as taps. "Open" is what a bare tap already does, so the only one
      // worth adding is the dismissal — it lets someone clear a message from the wrist without
      // waking the phone.
      actions: [{ action: "dismiss", title: "Dismiss" }],
      timestamp: Date.now(),
    }),
  );
});

self.addEventListener("notificationclick", (event) => {
  event.notification.close();
  // The dismiss action is handled entirely on the device: closing above is the whole behaviour.
  // Deliberately NOT a "mark as read" action — the service worker holds no access token, so it
  // could not actually mark anything read, and an action that silently does nothing is worse than
  // one that isn't offered.
  if (event.action === "dismiss") return;
  const url = new URL(event.notification.data?.url || "/", self.location.origin).href;
  event.waitUntil(
    (async () => {
      const clientsList = await self.clients.matchAll({ type: "window", includeUncontrolled: true });
      for (const client of clientsList) {
        if (client.url === url && "focus" in client) return client.focus();
      }
      // Same-origin client already open (any route) — focus it and navigate rather than
      // opening a duplicate tab.
      for (const client of clientsList) {
        if ("focus" in client && "navigate" in client) {
          await client.focus();
          return client.navigate(url);
        }
      }
      return self.clients.openWindow(url);
    })(),
  );
});
