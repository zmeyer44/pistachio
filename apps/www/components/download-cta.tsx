import { downloadUrl, formatBytes, release } from "../lib/release";
import { DockLaunch } from "./dock-launch";
import { ArrowRight } from "./primitives";
import { Button } from "./ui/button";

/**
 * The download card: BookDemo's sibling, the same section over the same
 * retro-office image, with the current build in place of the early-access
 * form. The button downloads the DMG directly; the details and install steps
 * are /download's to give.
 */
export function DownloadCta() {
  return (
    <section className="mx-auto w-full max-w-[1512px] p-4 desk:p-6">
      <div className="relative flex items-center justify-center px-4 py-24 desk:px-0 desk:py-32">
        <img
          src="/img/early-access-agent-desk.webp"
          alt=""
          className="absolute inset-0 size-full object-cover"
        />

        <div className="relative flex w-full max-w-[400px] flex-col gap-8 bg-cream p-8 desk:p-10">
          <DockLaunch />

          <div className="flex flex-col gap-2">
            <h2 className="text-32 text-ink">Are you ready yet?</h2>
            <p className="text-16 text-ink">
              Download Pistachio for Macs with Apple silicon.
            </p>
          </div>

          <div className="flex flex-col gap-3">
            <Button asChild size="lg" className="w-full">
              <a href={downloadUrl} download>
                Download
                <ArrowRight size={16} />
              </a>
            </Button>
            <p className="text-12 text-ink/60">
              {release.version} · {formatBytes(release.bytes)} ·{" "}
              <a href="/download" className="underline hover:text-green">
                Details
              </a>
            </p>
          </div>
        </div>
      </div>
    </section>
  );
}
