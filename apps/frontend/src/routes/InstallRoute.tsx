import { Link } from "react-router-dom";
import { Smartphone, Share, Plus, Download, ShieldQuestion, Monitor } from "lucide-react";
import { isIOS } from "../lib/iosInstall";

/**
 * Install instructions.
 *
 * This page exists because of a specific, repeated failure: someone is sent the app, taps the link,
 * a browser opens, and they conclude it is broken — when the browser opening IS the download step.
 * The second wall is right behind it: Android only installs if the app doing the downloading holds
 * "install unknown apps", which Chrome does not by default, so the downloaded file appears to do
 * nothing when tapped.
 *
 * Both are completely normal and completely unexplained by a bare download link. The page is
 * ordered by what actually goes wrong rather than by platform importance, and it names the failure
 * before the fix — someone arrives here already stuck, and needs to recognise their situation
 * before they will read a numbered list.
 */
export function InstallRoute() {
  // Only reorders the page; both sets of instructions are always present, because the person
  // reading is often not the person installing.
  const iosFirst = isIOS();

  const android = (
    <Card icon={Smartphone} title="Android">
      <Step n={1}>
        Open{" "}
        <a href="/downloads/lumina.apk" className="text-accent hover:underline">
          lumina.apk
        </a>{" "}
        <strong>in Chrome</strong> and tap Download.
      </Step>
      <Step n={2}>
        Tap the file in your notifications. Android will say it can't install from this source —
        that's expected.
      </Step>
      <Step n={3}>
        Tap <em>Settings</em> on that prompt, turn on <strong>Allow from this source</strong>, then
        go back and tap the file again.
      </Step>

      <Note>
        Updates install themselves from then on — the app checks for a new version and offers it in
        one tap.
      </Note>
    </Card>
  );

  const ios = (
    <Card icon={Share} title="iPhone & iPad">
      <Step n={1}>
        Open <strong>lumina.badgerstudios.net</strong> in <strong>Safari</strong>. Chrome and
        Firefox on iPhone can't install apps.
      </Step>
      <Step n={2}>
        Tap the <Share className="inline h-4 w-4 align-text-bottom" aria-label="Share" /> Share
        button, then <strong>Add to Home Screen</strong>.
      </Step>
      <Step n={3}>Open it from your Home Screen — no browser bar, its own icon.</Step>

      <Note>
        Installing this way is also the only way an iPhone can send you notifications. Apple does not
        allow apps to be installed from a website, so there is no `.ipa` to download — this is the
        real app, not a shortcut.
      </Note>
    </Card>
  );

  return (
    <div className="min-h-app bg-base-900 text-signal">
      <header className="mx-auto flex max-w-3xl items-center justify-between px-6 py-5">
        <Link to="/" className="flex items-center gap-2.5">
          <img src="/icons/logo-128.png" alt="" aria-hidden className="h-8 w-8 rounded-xl" />
          <span className="font-display text-lg">Lumina</span>
        </Link>
        <Link to="/features" className="text-sm text-signal-dim hover:text-signal">
          Features
        </Link>
      </header>

      <main className="mx-auto max-w-3xl px-6 pb-20">
        <h1 className="font-display text-3xl">Installing Lumina</h1>

        {/* The reassurance goes first. Someone arriving here has usually already hit the wall and
            thinks something is broken; telling them it is normal is more useful than step 1. */}
        <div className="mt-5 flex items-start gap-3 rounded-xl border border-hairline bg-base-800 p-4">
          <ShieldQuestion className="mt-0.5 h-5 w-5 shrink-0 text-accent" />
          <div className="text-sm text-signal-dim">
            <p className="font-medium text-signal">“It just opened my browser and nothing happened”</p>
            <p className="mt-1.5">
              That's normal. Sending the file through a chat app usually delivers a{" "}
              <em>link</em> rather than the file, so tapping it opens a browser — and the browser
              downloading it is the first half of installing. The second half needs one permission,
              below.
            </p>
          </div>
        </div>

        <div className="mt-6 flex flex-col gap-5">
          {iosFirst ? (
            <>
              {ios}
              {android}
            </>
          ) : (
            <>
              {android}
              {ios}
            </>
          )}

          <Card icon={Monitor} title="Desktop (Linux)">
            <Step n={1}>
              Download the{" "}
              <a href="/downloads/lumina-desktop.AppImage" className="text-accent hover:underline">
                AppImage
              </a>
              .
            </Step>
            <Step n={2}>
              Make it executable — <code className="rounded bg-base-900 px-1">chmod +x</code> — then
              run it.
            </Step>
            <Note>It updates itself in the background from then on.</Note>
          </Card>
        </div>

        {/* Named plainly, because these are the three ways people most often get stuck and each one
            looks like a bug in the app rather than a property of the platform. */}
        <h2 className="mt-10 font-display text-xl">If it still won't install</h2>
        <ul className="mt-3 space-y-2.5 text-sm text-signal-dim">
          <li>
            <strong className="text-signal">Sent by email?</strong> Gmail blocks `.apk` files
            outright. Use a direct link instead.
          </li>
          <li>
            <strong className="text-signal">No browser available?</strong> Any app can be the
            installer. Send the file with Quick Share, or copy it over and open it from the{" "}
            <strong>Files</strong> app — the permission prompt appears there instead.
          </li>
          <li>
            <strong className="text-signal">Work or school phone?</strong> Managed devices often
            block installing outside the Play Store entirely. Nothing gets around that; use the
            website instead, which needs no install at all.
          </li>
        </ul>

        <div className="mt-10 flex flex-wrap gap-3">
          <a
            href="/downloads/lumina.apk"
            className="inline-flex items-center gap-2 rounded-lg bg-accent px-4 py-2.5 text-sm font-semibold text-white hover:bg-accent-hover"
          >
            <Download size={16} />
            Download for Android
          </a>
          <Link
            to="/app"
            className="inline-flex items-center gap-2 rounded-lg border border-base-500 px-4 py-2.5 text-sm font-semibold text-signal hover:bg-base-700"
          >
            <Plus size={16} />
            Just use the website
          </Link>
        </div>
      </main>
    </div>
  );
}

function Card({
  icon: Icon,
  title,
  children,
}: {
  icon: typeof Smartphone;
  title: string;
  children: React.ReactNode;
}) {
  return (
    <section className="rounded-xl border border-hairline bg-base-800 p-5">
      <h2 className="flex items-center gap-2 font-display text-lg">
        <Icon className="h-5 w-5 text-accent" />
        {title}
      </h2>
      <ol className="mt-3 space-y-2.5">{children}</ol>
    </section>
  );
}

function Step({ n, children }: { n: number; children: React.ReactNode }) {
  return (
    <li className="flex gap-3 text-sm text-signal-dim">
      <span className="flex h-5 w-5 shrink-0 items-center justify-center rounded-full bg-base-700 text-xs font-semibold text-signal">
        {n}
      </span>
      <span>{children}</span>
    </li>
  );
}

function Note({ children }: { children: React.ReactNode }) {
  return <p className="mt-3 border-l-2 border-hairline pl-3 text-xs text-signal-faint">{children}</p>;
}
