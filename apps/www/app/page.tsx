import { SiteNav } from "../components/site-nav";
import { Hero } from "../components/hero";
import { HowItWorks } from "../components/how-it-works";
import { UseCases } from "../components/use-cases";
import { DownloadCta } from "../components/download-cta";
import { SiteFooter } from "../components/site-footer";
import { LiveBrowser } from "../components/live-browser";

export default function Home() {
  return (
    <>
      <SiteNav />
      {/* `relative`: the live browser's layer spans <main> and flies between the hero and the steps. */}
      <main className="relative flex flex-col items-center bg-cream">
        <Hero />
        {/* <TrustedPartners /> */}
        <HowItWorks />
        {/* <CaseStudies /> */}
        {/* <UseCases /> */}
        {/* <SeeInAction /> */}
        {/* <ResearchPartners /> */}
        <DownloadCta />
        <LiveBrowser />
      </main>
      <SiteFooter />
    </>
  );
}
