import { joinEarlyAccess } from "../app/early-access/actions";
import { HeroDesktop } from "./hero-desktop";
import { ArrowRight } from "./primitives";
import { Button } from "./ui/button";

/**
 * listenlabs.ai A/B-tests its desktop hero: "split" puts the blurb and the
 * email form on one row, "stacked" keeps the phone/tablet column at all widths.
 */
const DESKTOP_HERO: "split" | "stacked" = "split";

export function Hero() {
  return (
    <section
      id="header"
      className="mx-auto flex w-full max-w-[1512px] flex-col gap-6 pt-[68px] pb-4 tab:gap-8 md:pt-[76px] desk:pb-6"
    >
      <div className="mt-4 flex flex-col gap-4 px-4 desk:px-6">
        <a
          href="https://github.com/zmeyer44/pistachio"
          className="w-fit rounded-[40px] bg-cream px-2.5 py-1 text-12 text-green ring-1 ring-green hover:bg-green hover:text-cream"
        >
          Early preview for macOS
        </a>

        <div className="flex flex-col gap-2 tab:gap-4">
          <h1 className="hero-headline text-ink">
            A browser built
            <br />
            for tomorrow
          </h1>

          {/*
            Phones and tablets always stack the blurb over the form. At desktop
            the live site A/B-tests two arrangements: the same stacked column,
            or one row with the blurb on the left and the form pinned right.
            We render the split variant; set DESKTOP_HERO to "stacked" for the
            other one.
          */}
          <div
            className={
              DESKTOP_HERO === "split"
                ? "flex flex-col gap-3 tab:gap-4 desk:flex-row desk:items-end"
                : "flex flex-col gap-3 tab:gap-4"
            }
          >
            <p className="w-full text-16 text-ink tab:w-1/2 desk:w-auto desk:flex-1 desk:text-20">
              Pistachio is a Mac browser with an agent built in. Ask for
              something in plain words and it gets it done.
            </p>

            <div
              className={
                DESKTOP_HERO === "split"
                  ? "w-full tab:w-1/2 desk:flex desk:w-auto desk:flex-1 desk:justify-end"
                  : "w-full tab:w-1/2"
              }
            >
              <form
                className={`flex h-11 w-full items-stretch overflow-hidden rounded-md ring-1 ring-green desk:h-12 ${DESKTOP_HERO === "split" ? "desk:w-[482px]" : "desk:max-w-[448px]"}`}
                action={joinEarlyAccess}
              >
                <label className="relative min-w-0 flex-1">
                  <span className="sr-only">Work email</span>
                  <input
                    name="email"
                    type="email"
                    required
                    placeholder="Your email"
                    className="size-full bg-paper px-4 text-16 text-ink outline-none"
                  />
                </label>
                <Button
                  type="submit"
                  className="h-full w-auto shrink-0 rounded-none px-5 text-16"
                >
                  Get early access
                  <ArrowRight size={16} />
                </Button>
              </form>
            </div>
          </div>
        </div>
      </div>

      {/* The browser itself, on a desk: components/hero-desktop.tsx. */}
      <HeroDesktop />
    </section>
  );
}
