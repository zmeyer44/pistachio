import type { Metadata } from "next";
import "../app/app.css";
import "./credential-capture.css";

export const metadata: Metadata = {
  title: "Secure information handoff · Pistachio",
  description: "Privately send sign-in details to an active Pistachio run.",
  robots: { index: false, follow: false, noarchive: true },
};

export default function CredentialCaptureLayout(
  props: LayoutProps<"/credential-capture">,
) {
  return <div className="pa">{props.children}</div>;
}
