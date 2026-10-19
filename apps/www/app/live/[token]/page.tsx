import { LiveGuest } from "../_guest/live-guest";

export default async function LiveSharePage({ params }: PageProps<"/live/[token]">) {
  const { token } = await params;
  return <LiveGuest token={token} />;
}
