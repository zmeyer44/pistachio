/**
 * The groups' context as the shell sees it (docs/desk-agent.md §3): main's
 * list, kept current while any desk is up, and the commands the Stack sends.
 * Apart from the app store: only a desk reads it.
 */

import { useEffect } from "react";
import { create } from "zustand";
import { MAX_GROUP_FILE_BYTES, type GroupContextResult, type GroupContextView } from "@pistachio/shell-contracts/desk-agent";
import { nativeApi } from "../../api";

const useContexts = create<{ contexts: readonly GroupContextView[]; loaded: boolean }>(() => ({ contexts: [], loaded: false }));

let watchers = 0;
let unwatch: (() => void) | null = null;

/** Every group's context, current for as long as the calling component is mounted. */
export function useGroupContexts(): readonly GroupContextView[] {
  useEffect(() => {
    watchers += 1;
    if (watchers === 1) {
      const api = nativeApi();
      unwatch = api?.onGroupContexts((contexts) => useContexts.setState({ contexts, loaded: true })) ?? null;
      api
        ?.getGroupContexts()
        .then((contexts) => useContexts.setState({ contexts, loaded: true }))
        .catch(() => undefined);
    }
    return () => {
      watchers -= 1;
      if (watchers > 0) return;
      unwatch?.();
      unwatch = null;
    };
  }, []);
  return useContexts((state) => state.contexts);
}

/** Whether main has said what the contexts hold yet (until then, a desk's saved documents are not known to be gone). */
export function useGroupContextsLoaded(): boolean {
  return useContexts((state) => state.loaded);
}

/** Files, as the Stack sends them: base64, at most 20 to a command, each within the context's limit. */
export async function addContextFiles(groupId: string, title: string, list: readonly File[]): Promise<GroupContextResult> {
  const api = nativeApi();
  if (api === null) return { rejected: [] };
  const rejected: GroupContextResult["rejected"] = [];
  const files: Array<{ name: string; mediaType: string; data: string }> = [];
  for (const file of list.slice(0, 20)) {
    if (file.size > MAX_GROUP_FILE_BYTES) {
      rejected.push({ name: file.name, reason: `larger than ${String(MAX_GROUP_FILE_BYTES / 1024 / 1024)} MB` });
      continue;
    }
    files.push({ name: file.name, mediaType: file.type, data: await base64Of(file) });
  }
  if (list.length > 20) rejected.push({ name: `${String(list.length - 20)} more`, reason: "at most 20 files at a time" });
  if (files.length === 0) return { rejected };
  const result = await api.groupContext({ type: "addFiles", groupId, title, files });
  return { rejected: [...rejected, ...result.rejected], ...(result.added === undefined ? {} : { added: result.added }) };
}

async function base64Of(file: File): Promise<string> {
  const bytes = new Uint8Array(await file.arrayBuffer());
  let binary = "";
  // In slices: String.fromCharCode takes its arguments on the stack.
  for (let at = 0; at < bytes.length; at += 0x8000) binary += String.fromCharCode(...bytes.subarray(at, at + 0x8000));
  return btoa(binary);
}

/**
 * What a drop onto the Stack carries besides files: a link dragged out of a
 * page, or text. Null when it carries neither.
 */
export function droppedText(data: DataTransfer): { kind: "link" | "snippet"; text: string; url?: string } | null {
  const uri = data
    .getData("text/uri-list")
    .split(/\r?\n/)
    .find((line) => line.trim() !== "" && !line.startsWith("#"));
  const plain = data.getData("text/plain").trim();
  if (uri !== undefined && /^https?:\/\//i.test(uri.trim())) {
    const url = uri.trim();
    return { kind: "link", text: plain !== "" && plain !== url ? plain : url, url };
  }
  if (plain === "") return null;
  if (/^https?:\/\/\S+$/i.test(plain)) return { kind: "link", text: plain, url: plain };
  return { kind: "snippet", text: plain };
}

/** A file's size, as the Stack writes it. */
export function fileSize(bytes: number): string {
  if (bytes < 1024) return `${String(bytes)} B`;
  if (bytes < 1024 * 1024) return `${String(Math.max(1, Math.round(bytes / 1024)))} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}
