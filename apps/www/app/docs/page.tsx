import type { Metadata } from "next";
import Link from "next/link";

import { SectionLabel } from "../../components/primitives";
import { SiteFooter } from "../../components/site-footer";
import { SiteNav } from "../../components/site-nav";
import { Prose, ProseLayout } from "../../components/site-prose";
import { shortcuts } from "../../lib/site-data";

export const metadata: Metadata = {
  title: "Pistachio docs",
  description:
    "How to install Pistachio, what the agent can and cannot touch, and where memory, reminders, permissions, shortcuts, and imported browser data live.",
};

const REPO = "https://github.com/zmeyer44/pistachio";

/** In reading order; ids are the site-wide `/docs#section` targets. */
const SECTIONS = [
  { id: "getting-started", title: "Getting started" },
  { id: "agent", title: "The agent" },
  { id: "spaces", title: "Tabs and Spaces" },
  { id: "memory", title: "Memory and reminders" },
  { id: "privacy", title: "Privacy and permissions" },
  { id: "shortcuts", title: "Keyboard shortcuts" },
  { id: "import", title: "Import from another browser" },
  { id: "policy", title: "Managed policy" },
  { id: "help", title: "Help and source" },
] as const;

const IMPORT_BROWSERS = ["Chrome", "Arc", "Brave", "Edge", "Chromium", "Vivaldi", "Opera", "Firefox", "Safari"];

export default function DocsPage() {
  return (
    <>
      <SiteNav />
      <main className="flex flex-col items-center bg-cream">
        <section className="shell flex flex-col gap-10 pt-[108px] pb-20 md:pt-[124px] desk:gap-14 desk:pb-28">
          <SectionLabel>Docs</SectionLabel>

          <div className="flex flex-col gap-4">
            <h1 className="text-40 text-ink tab:text-48">Using Pistachio</h1>
            <p className="max-w-[640px] text-16 text-ink tab:text-20">
              Pistachio is a Mac browser with an agent that works inside the tabs you are already signed in to. This
              page covers what ships in the preview today. Anything deeper lives in the{" "}
              <a href={`${REPO}/tree/main/docs`} className="underline hover:text-green">
                repository docs
              </a>
              .
            </p>
          </div>

          <ProseLayout sections={SECTIONS}>
            <Prose id="getting-started" title="Getting started">
              <p>
                Pistachio runs on Apple silicon Macs. Get the disk image from the{" "}
                <Link href="/download">download page</Link>, drag Pistachio into Applications, and open it. The build
                is signed and notarized.
              </p>
              <p>
                The first run is a short guided setup: introduce yourself in a sentence or two (typed or spoken) so the
                agent has a starting memory, optionally import sessions and bookmarks from another browser, pick a few
                favorites, and choose an appearance. You can replay it later from Settings → About.
              </p>
              <p>
                The agent needs a model. Add your own API key in Settings, or run without one and use Pistachio as a
                plain browser.
              </p>
            </Prose>

            <Prose id="agent" title="The agent">
              <p>
                Open the chat with <code>⌘I</code> and ask for work in plain language. The agent can read, navigate,
                click, type, and scroll inside your existing tabs, so it uses the sessions you are already signed in to
                rather than logging in again. Every tool call shows up inline in the conversation as it happens.
              </p>
              <ul>
                <li>It asks before anything consequential, and a paused approval waits for you.</li>
                <li>You can interrupt, steer with a follow-up, or take the tab over at any time and hand it back.</li>
                <li>Each run leaves a signed activity record you can replay from the conversation.</li>
              </ul>
              <p>
                With an account, a Space you have explicitly enabled for cloud runs can also run when your Mac is
                asleep, in a hosted browser that shares your private egress address. Nothing runs in the cloud for a
                Space you have not turned that on for.
              </p>
            </Prose>

            <Prose id="spaces" title="Tabs and Spaces">
              <p>
                Tabs live in a sidebar (or a top strip, from Settings → General). The sidebar has a favorites grid,
                pinned pages in collapsible folders, then today&apos;s tabs, all drag-and-drop. A Space is a separate set
                of tabs and sessions; forking one lets you carry chosen tabs and logins into it.
              </p>
              <ul>
                <li>Split the window into up to four panes with <code>⌘\</code>, and drag a tab onto a page to split.</li>
                <li>Hold Option and click a link to glance at it in a preview without leaving the page.</li>
                <li>Playing audio and video follows you into a small card when you switch tabs.</li>
                <li>Reader view strips a page down to the article; the command bar (<code>⌘L</code>) opens tabs, pins, Spaces, and settings.</li>
              </ul>
            </Prose>

            <Prose id="memory" title="Memory and reminders">
              <p>
                Say &ldquo;remember I prefer window seats&rdquo; or &ldquo;forget my old address&rdquo; and the agent
                updates one local file, <code>memory.json</code>, kept on your Mac. Facts are versioned when they change
                rather than overwritten, can expire on a date, and can be reviewed, edited, restored, or erased in
                Settings → Memory. The quick fields there (name, time zone, locations, projects) are entries in the
                same file, not a second store.
              </p>
              <p>
                Reminders work the same way: &ldquo;remind me in 20 minutes&rdquo; or &ldquo;every Sunday at 8am send me
                a summary of my week&rdquo; become entries in a local <code>reminders.json</code>. A reminder fires
                either a fixed message or an agent task, shows up as a card in the chat and a desktop notification, and{" "}
                <code>⌘⇧R</code> opens a calendar of what fired and what is next. Reminders fire while Pistachio is
                running on your Mac.
              </p>
            </Prose>

            <Prose id="privacy" title="Privacy and permissions">
              <p>
                Pistachio is local by default. Browsing data, memory, reminders, appearance, and shortcuts stay on your
                Mac unless you sign in and turn on sync or the cloud browser. The{" "}
                <Link href="/privacy">privacy policy</Link> describes what an account stores.
              </p>
              <ul>
                <li>
                  <strong>Per-site permissions.</strong> Camera, microphone, location, notifications, clipboard,
                  screen capture, MIDI, and idle detection are decided in the app, not by the page. Site controls in the
                  address bar show the current decision, where it came from, and let you change or reset it.
                </li>
                <li>
                  <strong>Site data.</strong> Settings → Privacy &amp; security can sign you out of every site and
                  clear cookies, storage, and cache for the active Space, and clear recent history.
                </li>
                <li>
                  <strong>Agent access.</strong> The agent works in your live tabs with your signed-in sessions. It
                  does not see saved passwords; a value the vault types for it is filled directly into the page and
                  the model learns only that the field was filled.
                </li>
                <li>
                  <strong>Passkeys and Touch ID.</strong> Sign-in with passkeys uses the operating system&apos;s
                  authenticator. The site never receives a fingerprint or face scan, and agent tabs cannot use
                  passkeys at all.
                </li>
                <li>
                  <strong>Bring your own model.</strong> Prompts go to the model provider you configured with your own
                  key. Memory facts that bear on a task are included in the prompt for that task.
                </li>
              </ul>
            </Prose>

            <Prose id="shortcuts" title="Keyboard shortcuts">
              <p>
                Every shortcut can be rebound in Settings → Shortcuts, and they keep working while your cursor is inside
                a web page. A few of the defaults:
              </p>
              <dl className="grid grid-cols-[auto_minmax(0,1fr)] gap-x-6 gap-y-2">
                {shortcuts.map((s) => (
                  <div key={s.keys} className="contents">
                    <dt className="font-mono text-14 text-ink">{s.keys}</dt>
                    <dd className="text-14">
                      {s.action}
                      <span className="text-sage"> · {s.detail.join(", ")}</span>
                    </dd>
                  </div>
                ))}
              </dl>
            </Prose>

            <Prose id="import" title="Import from another browser">
              <p>
                During first run (which you can replay from Settings → About), Pistachio can import one profile at a
                time from {IMPORT_BROWSERS.join(", ")}.
              </p>
              <ul>
                <li>
                  <strong>Sessions</strong> (cookies) go into the active Space, so you arrive already signed in.
                  Chromium-based browsers keep their cookie key in the login keychain, which is why macOS asks you to
                  allow Pistachio to read it. Safari&apos;s cookies belong to the OS and are not imported.
                </li>
                <li>
                  <strong>Bookmarks</strong> become pins in the sidebar, in folders named for the browser and each
                  bookmark folder.
                </li>
              </ul>
              <p>
                Each database is copied to a temporary folder and opened read-only; the other browser&apos;s own files
                are never opened, and nothing leaves your Mac.
              </p>
            </Prose>

            <Prose id="policy" title="Managed policy">
              <p>
                An organization can pin permission and data-movement decisions for its people. Place{" "}
                <code>enterprise-policy.json</code> in the app&apos;s user-data directory, or point{" "}
                <code>PISTACHIO_ENTERPRISE_POLICY</code> at one. Rules match an origin, hostname, or wildcard
                subdomain and can allow or block permissions (camera, notifications, and so on) and actions
                (download, upload, copy, paste, print). Managed decisions always win over a person&apos;s own site
                decisions, and Site controls show when a decision is managed. The full schema is in the{" "}
                <a href={`${REPO}/blob/main/docs/enterprise-browser-controls.md`}>enterprise browser controls</a>{" "}
                document.
              </p>
            </Prose>

            <Prose id="help" title="Help and source">
              <p>
                Pistachio is open source under the GNU General Public License v3.0. The code, design documents, and release notes are on{" "}
                <a href={REPO}>GitHub</a>; file bugs and requests as{" "}
                <a href={`${REPO}/issues`}>issues</a> there. The preview is early: if something here does not match
                what you see in the app, the app is right and this page is behind.
              </p>
            </Prose>
          </ProseLayout>
        </section>
      </main>
      <SiteFooter />
    </>
  );
}
