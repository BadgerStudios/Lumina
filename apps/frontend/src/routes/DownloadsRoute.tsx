import { Link } from "react-router-dom";
import { Download, Smartphone, Monitor, Package, Shield } from "lucide-react";

/**
 * Public downloads for everything Badger Studios ships.
 *
 * Two things this page has to get right beyond listing files:
 *
 *  - **Ownership is stated on every item**, not once in a footer where nobody reads it. Someone
 *    who arrives from a direct link to one section should still see whose software it is.
 *  - **AMC Theatres is NOT marked as Badger Studios property**, because it is not. It is a fork of
 *    LOOHP's ImageFrame under GPL-3.0, so it carries its own notice, and distributing it here is
 *    what makes the source-availability obligation bite — hence the explicit link to the licence
 *    and upstream project rather than a quiet omission.
 */

interface Item {
  name: string;
  detail: string;
  href: string;
  size: string;
  icon: typeof Download;
}

function DownloadRow({ item }: { item: Item }) {
  const Icon = item.icon;
  return (
    <a
      href={item.href}
      className="flex items-center gap-3 rounded-lg bg-base-800 px-4 py-3 transition hover:bg-base-700"
    >
      <Icon size={18} className="shrink-0 text-accent" />
      <span className="min-w-0 flex-1">
        <span className="block text-sm font-medium text-signal">{item.name}</span>
        <span className="block text-xs text-signal-faint">{item.detail}</span>
      </span>
      <span className="shrink-0 text-xs tabular-nums text-signal-faint">{item.size}</span>
      <Download size={15} className="shrink-0 text-signal-dim" />
    </a>
  );
}

function Section({
  title,
  blurb,
  items,
  notice,
}: {
  title: string;
  blurb: string;
  items: Item[];
  notice: React.ReactNode;
}) {
  return (
    <section className="mb-10">
      <h2 className="mb-1 text-lg font-bold text-signal">{title}</h2>
      <p className="mb-4 text-sm text-signal-dim">{blurb}</p>
      <div className="space-y-2">
        {items.map((it) => (
          <DownloadRow key={it.href} item={it} />
        ))}
      </div>
      <p className="mt-3 flex items-start gap-2 text-xs text-signal-faint">
        <Shield size={13} className="mt-0.5 shrink-0" />
        <span>{notice}</span>
      </p>
    </section>
  );
}

const PROPRIETARY = (
  <>
    © 2026 Badger Studios. All rights reserved. This software is the intellectual property of
    Badger Studios and is provided for use as distributed — it may not be copied, modified,
    redistributed, resold or reverse engineered without written permission.
  </>
);

export function DownloadsRoute() {
  return (
    <div className="min-h-app bg-base-900 px-6 py-12">
      <div className="mx-auto max-w-2xl">
        <img src="/icons/logo-128.png" alt="" className="mb-4 h-14 w-14" />
        <h1 className="mb-2 text-2xl font-bold text-signal">Downloads</h1>
        <p className="mb-10 text-sm text-signal-dim">
          Everything Badger Studios ships, in one place. Every file below is published by us —{" "}
          <Link to="/install" className="text-accent hover:underline">
            installation help
          </Link>{" "}
          if a download does not open, and checksums for all of them in{" "}
          <a href="/downloads/SHA256SUMS.txt" className="text-accent hover:underline">
            SHA256SUMS.txt
          </a>
          .
        </p>

        <Section
          title="Lumina"
          blurb="The chat and community platform. Sign in with the same account everywhere."
          notice={PROPRIETARY}
          items={[
            { name: "Lumina for Android", detail: "APK · install from unknown sources", href: "/downloads/lumina.apk", size: "~9 MB", icon: Smartphone },
            { name: "Lumina for Linux", detail: "AppImage · chmod +x and run", href: "/downloads/lumina-desktop.AppImage", size: "158 MB", icon: Monitor },
            { name: "Lumina for Windows", detail: "Installer · run it and follow the prompts", href: "/downloads/Lumina-Setup-1.0.45.exe", size: "130 MB", icon: Monitor },
            { name: "Lumina for Windows (portable)", detail: "Zip · extract and run Lumina.exe, no install", href: "/downloads/lumina-windows.zip", size: "169 MB", icon: Monitor },
          ]}
        />

        <Section
          title="BadgerOS"
          blurb="The companion app for the Badger Studios control panel — server status and controls on your phone."
          notice={PROPRIETARY}
          items={[
            { name: "BadgerOS for Android", detail: "APK · the standard app", href: "/downloads/badgeros.apk", size: "157 KB", icon: Smartphone },
            { name: "BadgerOS for Android (push)", detail: "APK · same app with push notifications", href: "/downloads/badgeros-fcm.apk", size: "508 KB", icon: Smartphone },
            { name: "BadgerOS app icon", detail: "PNG · 512×512", href: "/downloads/badgeros-icon-512.png", size: "141 KB", icon: Package },
          ]}
        />

        <Section
          title="Minecraft plugins"
          blurb="Server plugins built by Badger Studios. Drop the jar into your server's plugins folder and restart."
          notice={PROPRIETARY}
          items={[
            { name: "AnotherLife Settlement AI 0.11.0", detail: "Autonomous villager society — economy, politics, law, nations", href: "/downloads/anotherlife-settlement-0.11.0.jar", size: "695 KB", icon: Package },
            { name: "AnotherLife Sync 0.2.0", detail: "Cross-server player profile sync", href: "/downloads/anotherlife-sync-0.2.0.jar", size: "14.7 MB", icon: Package },
          ]}
        />

        <Section
          title="AMC Theatres"
          blurb="In-game video and image playback, with a web upload pipeline."
          notice={
            <>
              <strong className="text-signal-dim">Not Badger Studios property.</strong> AMC Theatres
              is a fork of{" "}
              <a href="https://github.com/LOOHP/ImageFrame" className="text-accent hover:underline" rel="noreferrer" target="_blank">
                ImageFrame by LOOHP
              </a>
              , licensed under the{" "}
              <a href="https://www.gnu.org/licenses/gpl-3.0.html" className="text-accent hover:underline" rel="noreferrer" target="_blank">
                GNU GPL v3
              </a>
              . Badger Studios holds copyright in its own modifications only, which are released
              under the same licence. Because this is GPL software, anyone who receives this build
              is entitled to the corresponding source under GPL-3.0 — ask us and we will provide it.
            </>
          }
          items={[
            { name: "AMC Theatres 1.1.0", detail: "Paper plugin · GPL-3.0", href: "/downloads/AMCTheatres-1.1.0.jar", size: "4.2 MB", icon: Package },
          ]}
        />

        <div className="rounded-lg border border-base-600 bg-base-800 p-4">
          <p className="flex items-start gap-2 text-xs text-signal-dim">
            <Shield size={14} className="mt-0.5 shrink-0 text-accent" />
            <span>
              Except where a different licence is stated above, everything on this page is the
              intellectual property of <strong className="text-signal">Badger Studios</strong>,
              © 2026, all rights reserved. Downloading a build grants you permission to run it —
              it does not transfer any ownership, and does not permit redistribution or derivative
              works. Questions about licensing or commercial use: get in touch before you rely on
              it.
            </span>
          </p>
        </div>
      </div>
    </div>
  );
}
