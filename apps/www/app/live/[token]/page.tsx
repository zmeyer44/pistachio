import type { Metadata } from "next";
import { linkPreview, previewText } from "../../../lib/live/preview";
import { LiveGuest } from "../_guest/live-guest";

/** What the link says where it is pasted (lib/live/preview.ts); the card beside it is `opengraph-image.tsx`. */
export async function generateMetadata({ params }: PageProps<"/live/[token]">): Promise<Metadata> {
  const { token } = await params;
  const text = previewText(await linkPreview(token));
  return {
    title: text.page,
    description: text.description,
    openGraph: { type: "website", siteName: "Pistachio", title: text.title, description: text.description },
    twitter: { card: "summary_large_image", title: text.title, description: text.description },
  };
}

export default async function LiveSharePage({ params }: PageProps<"/live/[token]">) {
  const { token } = await params;
  return <LiveGuest token={token} />;
}
