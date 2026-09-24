import type { Metadata } from "next";
import { IMessageOnboarding } from "../../../components/imessage-onboarding";

export const metadata: Metadata = {
  title: "Connect iMessage · Pistachio",
  description:
    "Connect this phone number to Pistachio and start sending agent tasks from Messages.",
  referrer: "no-referrer",
  robots: { index: false, follow: false, noarchive: true },
};

export default function IMessageOnboardingPage() {
  return <IMessageOnboarding />;
}
