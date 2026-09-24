/**
 * A Space is a durable, local browsing context inside an Organization. Each
 * Space owns a persistent Electron partition and its own sidebar shelf. A
 * fork creates an independent child and records where it came from; there is
 * deliberately no live synchronization between parent and child afterward.
 */

export const DEFAULT_SPACE_ID = "work";
export const MAX_SPACE_NAME = 48;
export const MAX_SPACE_PURPOSE = 280;

/**
 * How a Space's traffic leaves this machine (docs/cloud-sync-design.md §10.3):
 * `direct` uses the network as it is; `identity` tunnels every request through
 * the account's static-IP egress gateway and fails closed when it is down.
 */
export type SpaceEgressPolicy = "direct" | "identity";

export interface SpaceInfo {
  id: string;
  name: string;
  color: string;
  parentSpaceId: string | null;
  purpose: string;
  createdAt: number;
  /** Origins whose sign-in cookies were copied at fork time. */
  carriedOrigins: string[];
  /** Egress routing for the Space's sessions; `direct` unless the person opts in. */
  egressPolicy: SpaceEgressPolicy;
  /** Whether the hosted cloud browser holds this Space's keys and may run in it. */
  cloudEnabled: boolean;
}

export function isSpaceEgressPolicy(value: unknown): value is SpaceEgressPolicy {
  return value === "direct" || value === "identity";
}

export type ForkTabScope = "active" | "all";

export interface ForkSpaceRequest {
  name: string;
  purpose: string;
  tabs: ForkTabScope;
  includeShelf: boolean;
  includeSession: boolean;
}

export interface ForkSpaceResult {
  spaceId: string;
  parentSpaceId: string;
  copiedTabs: number;
  copiedOrigins: string[];
  /** Explicitly names browser state Electron cannot safely clone live. */
  limitations: string[];
}

export const DEFAULT_SPACE: SpaceInfo = {
  id: DEFAULT_SPACE_ID,
  name: "Operations",
  color: "#b8e98f",
  parentSpaceId: null,
  purpose: "",
  createdAt: 0,
  carriedOrigins: [],
  egressPolicy: "direct",
  cloudEnabled: false,
};

export const SPACE_COLORS = ["#b8e98f", "#9fd8ff", "#d7b5ff", "#ffc68f", "#f5a9bb", "#95dfcf"] as const;

export function spacePartition(spaceId: string): string {
  return `persist:pistachio-space-${spaceId}`;
}

export function sanitizeSpaceInfo(value: unknown): SpaceInfo | null {
  if (typeof value !== "object" || value === null) return null;
  const raw = value as Record<string, unknown>;
  const id = typeof raw["id"] === "string" && /^[a-z0-9][a-z0-9-]{0,63}$/.test(raw["id"]) ? raw["id"] : "";
  const name = typeof raw["name"] === "string" ? raw["name"].trim().slice(0, MAX_SPACE_NAME) : "";
  if (id === "" || name === "") return null;
  const parentSpaceId =
    raw["parentSpaceId"] === null || raw["parentSpaceId"] === undefined
      ? null
      : typeof raw["parentSpaceId"] === "string" && /^[a-z0-9][a-z0-9-]{0,63}$/.test(raw["parentSpaceId"])
        ? raw["parentSpaceId"]
        : null;
  const origins = Array.isArray(raw["carriedOrigins"])
    ? raw["carriedOrigins"].filter((item): item is string => typeof item === "string" && isWebOrigin(item)).slice(0, 128)
    : [];
  return {
    id,
    name,
    color: typeof raw["color"] === "string" && /^#[0-9a-f]{6}$/i.test(raw["color"]) ? raw["color"] : SPACE_COLORS[0],
    parentSpaceId,
    purpose: typeof raw["purpose"] === "string" ? raw["purpose"].trim().slice(0, MAX_SPACE_PURPOSE) : "",
    createdAt: typeof raw["createdAt"] === "number" && Number.isFinite(raw["createdAt"]) && raw["createdAt"] >= 0 ? raw["createdAt"] : 0,
    carriedOrigins: [...new Set(origins)],
    egressPolicy: isSpaceEgressPolicy(raw["egressPolicy"]) ? raw["egressPolicy"] : "direct",
    cloudEnabled: raw["cloudEnabled"] === true,
  };
}

export function sanitizeForkSpaceRequest(value: unknown): ForkSpaceRequest | null {
  if (typeof value !== "object" || value === null) return null;
  const raw = value as Record<string, unknown>;
  const name = typeof raw["name"] === "string" ? raw["name"].trim().slice(0, MAX_SPACE_NAME) : "";
  if (name === "") return null;
  return {
    name,
    purpose: typeof raw["purpose"] === "string" ? raw["purpose"].trim().slice(0, MAX_SPACE_PURPOSE) : "",
    tabs: raw["tabs"] === "all" ? "all" : "active",
    includeShelf: raw["includeShelf"] !== false,
    includeSession: raw["includeSession"] !== false,
  };
}

function isWebOrigin(value: string): boolean {
  try {
    const url = new URL(value);
    return (url.protocol === "http:" || url.protocol === "https:") && url.origin === value;
  } catch {
    return false;
  }
}
