import type { Metadata } from "next";
import Link from "next/link";

import { EarlyAccessForm } from "../../components/early-access-form";
import { ArrowRight } from "../../components/primitives";
import { SiteFooter } from "../../components/site-footer";
import { SiteNav } from "../../components/site-nav";
import { Button } from "../../components/ui/button";

export const metadata: Metadata = {
  title: "Get early access to Pistachio",
  description:
    "Join the list for the Pistachio early preview and we will email you a download link when a build is ready for you.",
};

/**
 * Signup page, and where every early-access form lands afterward:
 * ?joined=1 swaps the form for a confirmation, ?error=email re-renders it
 * with a nudge.
 */
export default async function EarlyAccessPage({
  searchParams,
}: {
  searchParams: Promise<{ joined?: string; error?: string }>;
}) {
  const { joined, error } = await searchParams;

  return (
    <>
      <SiteNav />
      <main className="flex flex-col items-center bg-cream">
        <section className="mx-auto w-full max-w-[1512px] p-4 pt-[84px] md:pt-[92px] desk:p-6 desk:pt-[92px]">
          <div className="relative flex items-center justify-center px-4 py-20 desk:px-0 desk:py-28">
            <img
              src="/img/early-access-agent-desk.webp"
              alt=""
              className="absolute inset-0 size-full object-cover"
            />

            {joined === "1" ? (
              <div className="relative flex w-full max-w-[440px] flex-col gap-4 bg-cream p-[22px]">
                <h1 className="text-24 text-ink">You&apos;re on the list</h1>
                <p className="text-16 text-ink">
                  Thanks for your interest in Pistachio. We will email you a
                  download link when a build is ready for you.
                </p>
                <Button asChild size="lg" className="w-fit">
                  <Link href="/">
                    Back to the site
                    <ArrowRight size={16} />
                  </Link>
                </Button>
              </div>
            ) : (
              <EarlyAccessForm error={error === "email"} />
            )}
          </div>
        </section>
      </main>
      <SiteFooter />
    </>
  );
}
