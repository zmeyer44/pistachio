import type { Metadata } from "next";
import { Inter } from "next/font/google";
import { SessionBoundary } from "../components/session-boundary";
import "./globals.css";

const inter = Inter({
  subsets: ["latin"],
  display: "swap",
  variable: "--font-inter",
});

export const metadata: Metadata = {
  metadataBase: new URL("https://www.pistachio.run"),
  title: "Pistachio • A browser built for tomorrow",
  description:
    "A Mac browser with an agent that works inside the tabs you are already signed in to. Open source, local by default.",
  openGraph: {
    type: "website",
    title: "Pistachio • A browser built for tomorrow",
    description:
      "A Mac browser with an agent that works inside the tabs you are already signed in to. Open source, local by default.",
  },
  twitter: {
    card: "summary_large_image",
    title: "Pistachio • A browser built for tomorrow",
    description:
      "A Mac browser with an agent that works inside the tabs you are already signed in to. Open source, local by default.",
  },
};

export default function RootLayout({
  children,
}: Readonly<{ children: React.ReactNode }>) {
  return (
    <html lang="en" className={inter.variable}>
      <body>
        <SessionBoundary>{children}</SessionBoundary>
      </body>
    </html>
  );
}
