import type { Metadata } from "next";
import Link from "next/link";

import { ArrowRight, SectionLabel } from "../components/primitives";
import { SiteFooter } from "../components/site-footer";
import { SiteNav } from "../components/site-nav";
import { Button } from "../components/ui/button";

export const metadata: Metadata = {
  title: "Page not found · Pistachio",
};

/** The site's own 404, with the nav still in place and a way back. */
export default function NotFound() {
  return (
    <>
      <SiteNav />
      <main className="flex flex-col items-center bg-cream">
        <section className="shell flex flex-col gap-10 pt-[108px] pb-20 md:pt-[124px] desk:gap-14 desk:pb-28">
          <SectionLabel>Not found</SectionLabel>
          <div className="flex max-w-[560px] flex-col gap-6">
            <h1 className="text-40 text-ink tab:text-48">There is no page here</h1>
            <p className="text-16 text-ink tab:text-20">
              The address may be out of date, or the page may not exist yet in the preview.
            </p>
            <div className="flex flex-col gap-3 sm:flex-row sm:items-center">
              <Button asChild size="lg" className="w-full sm:w-auto">
                <Link href="/">
                  Back to the homepage
                  <ArrowRight size={16} />
                </Link>
              </Button>
              <Link href="/docs" className="text-14 text-ink underline hover:text-green">
                Docs
              </Link>
              <Link href="/download" className="text-14 text-ink underline hover:text-green">
                Download
              </Link>
            </div>
          </div>
        </section>
      </main>
      <SiteFooter />
    </>
  );
}
