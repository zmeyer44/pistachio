import type { Metadata } from "next";

import { SiteFooter } from "../../components/site-footer";
import { SiteNav } from "../../components/site-nav";
import { ArrowRight, SectionLabel } from "../../components/primitives";
import { Button } from "../../components/ui/button";
import { downloadUrl, formatBytes, release } from "../../lib/release";

const title = "Download Pistachio for macOS";
const description = `Pistachio ${release.version} for Apple silicon Macs. Signed and notarized, open source, local by default.`;

/**
 * `openGraph` and `twitter` are restated so the card text matches the image
 * from `./opengraph-image.tsx` — nested metadata objects replace the layout's
 * wholesale rather than merging, so without these the share card would carry
 * the landing page's title over this page's picture.
 */
export const metadata: Metadata = {
  title,
  description,
  openGraph: { type: "website", title, description },
  twitter: { card: "summary_large_image", title, description },
};

const STEPS = [
  {
    title: "Open the disk image",
    body: `Double-click ${release.file} and drag Pistachio into Applications.`,
  },
  {
    title: "Launch it",
    body: "Pistachio is signed and notarized by Apple, so it opens without a Gatekeeper warning.",
  },
  {
    title: "Add a model",
    body: "Bring your own API key in Settings, or keep everything local. The agent only works inside tabs you open.",
  },
] as const;

const FACTS = [
  { label: "Version", value: release.version },
  { label: "Released", value: release.publishedAt },
  { label: "Chip", value: release.arch },
  { label: "Size", value: formatBytes(release.bytes) },
] as const;

export default function DownloadPage() {
  return (
    <>
      <SiteNav />
      <main className="flex flex-col items-center bg-cream">
        <section className="shell flex flex-col gap-10 pt-[108px] pb-20 md:pt-[124px] desk:gap-14 desk:pb-28">
          <SectionLabel>Download</SectionLabel>

          <div className="grid gap-10 desk:grid-cols-[minmax(0,7fr)_minmax(0,5fr)] desk:gap-16">
            {/* ------------------------------ headline ------------------------------ */}
            <div className="flex flex-col gap-6">
              <span className="w-fit rounded-[40px] bg-cream px-2.5 py-1 text-12 text-ink ring-1 ring-green">
                {release.channel} · {release.version}
              </span>

              <h1 className="text-40 text-ink tab:text-48">
                Pistachio for macOS
              </h1>
              <p className="max-w-[520px] text-16 text-ink tab:text-20">
                A browser with an agent that works inside the tabs you are
                already signed in to. Runs on your Mac, keeps your data there.
              </p>

              <div className="flex flex-col gap-3 sm:flex-row sm:items-center">
                <Button asChild size="lg" className="w-full sm:w-auto">
                  <a href={downloadUrl} download>
                    Download for Apple silicon
                    <ArrowRight size={16} />
                  </a>
                </Button>
                <p className="text-12 text-ink">
                  {release.file} · {formatBytes(release.bytes)}
                </p>
              </div>

              <p className="text-12 text-ink">
                Intel Macs are not supported yet. Windows and Linux builds are
                not planned for the preview.
              </p>
            </div>

            {/* ------------------------------ facts ------------------------------- */}
            <dl className="grid h-fit grid-cols-2 gap-px overflow-hidden rounded-lg border border-track bg-track">
              {FACTS.map((f) => (
                <div key={f.label} className="flex flex-col gap-1 bg-paper p-4">
                  <dt className="text-12 text-sage">{f.label}</dt>
                  <dd className="text-16 text-ink">{f.value}</dd>
                </div>
              ))}
              <div className="col-span-2 flex flex-col gap-1 bg-paper p-4">
                <dt className="text-12 text-sage">SHA-256</dt>
                <dd className="font-mono text-12 wrap-anywhere text-ink">
                  {release.sha256}
                </dd>
              </div>
            </dl>
          </div>

          {/* ---------------------------- install steps ---------------------------- */}
          <ol className="grid gap-6 border-t border-track pt-10 tab:grid-cols-3">
            {STEPS.map((s, i) => (
              <li key={s.title} className="flex flex-col gap-2">
                <span className="text-24 text-ink">{i + 1}</span>
                <h2 className="text-20 text-ink">{s.title}</h2>
                <p className="text-14 text-ink">{s.body}</p>
              </li>
            ))}
          </ol>

          <p className="text-12 text-ink">
            Verify the download with{" "}
            <code className="rounded bg-tile px-1 py-0.5 font-mono">
              shasum -a 256 ~/Downloads/{release.file}
            </code>{" "}
            and compare it to the hash above. Source code and release notes are
            on{" "}
            <a
              href="https://github.com/zmeyer44/pistachio"
              className="underline hover:text-green"
            >
              GitHub
            </a>
            .
          </p>
        </section>
      </main>
      <SiteFooter />
    </>
  );
}
