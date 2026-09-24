"use client";
import SharedShellTree from "@pistachio/browser-client/components/shell-tree.js";
import type { WsShellApi } from "../lib/shell-socket";
export default function ShellTree({ api }: { api: WsShellApi }) {
  const site = (process.env["NEXT_PUBLIC_PISTACHIO_WWW_URL"]?.trim() || "https://www.pistachio.run").replace(/\/+$/u, "");
  return <SharedShellTree api={api} downloadUrl={process.env["NEXT_PUBLIC_PISTACHIO_DOWNLOAD_URL"]?.trim() || "https://www.pistachio.run/download"} accountUrl={`${site}/app`} />;
}
