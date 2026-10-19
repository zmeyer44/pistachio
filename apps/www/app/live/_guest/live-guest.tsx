"use client";

import dynamic from "next/dynamic";
import { useEffect } from "react";
import { prefetchJoinInfo } from "../../../lib/live/control";
import { LoadingScreen } from "./screens";

/**
 * The guest page is a browser program from end to end — WebRTC, the camera,
 * the room — so it is never prerendered and arrives as its own chunk; the
 * server sends only the quiet loading screen it starts on. The share the
 * link names is asked for as soon as this little part runs, alongside that
 * chunk rather than after it.
 */
const loadApp = () => import("./guest-app");
if (typeof window !== "undefined") void loadApp();
const GuestApp = dynamic(loadApp, { ssr: false, loading: () => <LoadingScreen /> });

export function LiveGuest({ token }: { token: string }) {
  useEffect(() => prefetchJoinInfo(token), [token]);
  return <GuestApp token={token} />;
}
