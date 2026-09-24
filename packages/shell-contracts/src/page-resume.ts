/** Portable page state; never a JavaScript heap or a serialized document. */
export interface PageResumeState {
  url: string;
  scrollX: number;
  scrollY: number;
  /** Only explicitly identified textareas, never passwords or autofill fields. */
  drafts: Array<{ id: string; name: string; value: string }>;
}

export function sanitizePageResume(value: unknown, url: string): PageResumeState | undefined {
  if (!value || typeof value !== "object") return undefined;
  const raw = value as Record<string, unknown>;
  if (raw["url"] !== url || !/^https?:\/\//u.test(url) || url.length > 2048) return undefined;
  const coordinate = (v: unknown): number => typeof v === "number" && Number.isFinite(v) ? Math.max(0, Math.min(v, 10_000_000)) : 0;
  const drafts: PageResumeState["drafts"] = [];
  let remaining = 8192;
  if (Array.isArray(raw["drafts"])) for (const field of raw["drafts"].slice(0, 8)) {
    if (!field || typeof field !== "object" || typeof field.value !== "string") continue;
    if ((typeof field.id === "string" && field.id.length > 128) || (typeof field.name === "string" && field.name.length > 128)) continue;
    const id = typeof field.id === "string" ? field.id : "";
    const name = typeof field.name === "string" ? field.name : "";
    if ((!id && !name) || /password|secret|token|credit|card|ssn|otp/iu.test(`${id} ${name}`)) continue;
    const text = field.value.slice(0, Math.min(2048, remaining));
    remaining -= text.length;
    drafts.push({ id, name, value: text });
  }
  return { url, scrollX: coordinate(raw["scrollX"]), scrollY: coordinate(raw["scrollY"]), drafts };
}

/** Self-contained so both Electron's isolated preload and Playwright can run it. */
export function capturePageResume(): PageResumeState {
  const drafts: PageResumeState["drafts"] = [];
  let remaining = 8192;
  for (const field of Array.from(document.querySelectorAll("textarea")).slice(0, 32)) {
    if (drafts.length >= 8 || remaining <= 0) break;
    if (field.id.length > 128 || field.name.length > 128 || (!field.id && !field.name) || field.disabled || field.readOnly || field.autocomplete === "off" ||
      field.closest('[autocomplete="off"]') || /password|secret|token|credit|card|ssn|otp/iu.test(`${field.id} ${field.name}`)) continue;
    const value = field.value.slice(0, Math.min(2048, remaining));
    remaining -= value.length;
    drafts.push({ id: field.id.slice(0, 128), name: field.name.slice(0, 128), value });
  }
  return { url: location.href, scrollX, scrollY, drafts };
}

/** Restore only this exact document and empty fields; never submit a form. */
export function restorePageResume(state: PageResumeState): void {
  if (location.href !== state.url) return;
  for (const draft of state.drafts) {
    const fields = Array.from(document.querySelectorAll("textarea")).filter(field =>
      (draft.id ? field.id === draft.id : field.name === draft.name));
    if (fields.length !== 1) continue;
    const field = fields[0]!;
    if (field.value !== "" || field.disabled || field.readOnly || field.autocomplete === "off" || field.closest('[autocomplete="off"]')) continue;
    const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")?.set;
    setter?.call(field, draft.value);
    field.dispatchEvent(new Event("input", { bubbles: true }));
  }
  window.scrollTo({ left: state.scrollX, top: state.scrollY, behavior: "instant" });
}

/** Reserve a bounded share of the encrypted session record for page details. */
export function boundPageResumes<T extends { id: string; resume?: PageResumeState }>(tabs: T[], activeTabId: string | null): T[] {
  let remaining = 128_000;
  const kept = new Set<string>();
  const prioritized = [...tabs].sort((a, b) => Number(b.id === activeTabId) - Number(a.id === activeTabId));
  for (const tab of prioritized) {
    if (!tab.resume) continue;
    const bytes = new TextEncoder().encode(JSON.stringify(tab.resume)).byteLength;
    if (bytes > remaining) continue;
    remaining -= bytes;
    kept.add(tab.id);
  }
  return tabs.map(tab => {
    if (!tab.resume || kept.has(tab.id)) return tab;
    const { resume: _resume, ...rest } = tab;
    return rest as T;
  });
}
