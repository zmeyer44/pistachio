/**
 * What Settings → Identity egress says about the gateway, its credential,
 * and each Space's policy (docs/cloud-sync-design.md §10.3).
 *
 * Pure: `egress:status` in, sentences out. The page never decides anything
 * itself — fail-closed, the temporary direct override, and the
 * restart-required flag are all main's answers — so everything here is a
 * rendering of one published object.
 */

import type { EgressStatus, EgressGatewayInfo, SpaceEgressStatus } from "@pistachio/shell-contracts/ipc";
import type { SpaceEgressPolicy } from "@pistachio/shell-contracts/spaces";

export type EgressTone = "green" | "amber" | "gray" | "red";

export interface EgressView {
  label: string;
  note: string;
  tone: EgressTone;
}

/** The gateway's health, and what it means for the Spaces that use it. */
export function egressHealthView(status: EgressStatus): EgressView {
  if (!status.enabled) {
    return {
      label: "Off",
      note: "No Space uses identity egress, or this Mac is not enrolled. Every request goes out directly.",
      tone: "gray",
    };
  }
  switch (status.health) {
    case "up":
      return { label: "Up", note: "The gateway answered its last health probe.", tone: "green" };
    case "down":
      return {
        label: "Down",
        note: "The gateway did not answer. Identity Spaces are blocked until it does, or until you browse direct for now.",
        tone: "red",
      };
    default:
      return { label: "Unknown", note: "No health probe has answered yet.", tone: "amber" };
  }
}

/** "198.51.100.12 · fra · gateway.example.com:8443", or what is known of it. */
export function gatewayLabel(gateway: EgressGatewayInfo | null): string {
  if (gateway === null) return "No gateway assigned";
  const address = `${gateway.host}:${String(gateway.port)}`;
  return [gateway.egressIp, gateway.region, address].filter((part): part is string => part !== null && part !== "").join(" · ");
}

/** The gateway's own words for its lifecycle, when it has any. */
export function gatewayStateLabel(gateway: EgressGatewayInfo | null): string {
  if (gateway === null || gateway.state === null || gateway.state === "") return "unknown";
  return gateway.state;
}

export interface CredentialExpiry {
  label: string;
  /** Gone already, or inside the hour: the page says so rather than only showing a time. */
  expired: boolean;
  soon: boolean;
}

const HOUR_MS = 60 * 60 * 1000;

/** "in 11h" / "in 42m" / "expired" — the credential the gateway checks. */
export function credentialExpiry(expiresAt: string | null, now: number = Date.now()): CredentialExpiry {
  if (expiresAt === null) return { label: "no credential yet", expired: false, soon: false };
  const time = Date.parse(expiresAt);
  if (Number.isNaN(time)) return { label: "no credential yet", expired: false, soon: false };
  const remaining = time - now;
  if (remaining <= 0) return { label: "expired", expired: true, soon: true };
  if (remaining < HOUR_MS) {
    const minutes = Math.max(1, Math.round(remaining / 60_000));
    return { label: `in ${String(minutes)}m`, expired: false, soon: true };
  }
  const hours = Math.round(remaining / HOUR_MS);
  return { label: `in ${String(hours)}h`, expired: false, soon: false };
}

export function spaceEgressStatus(status: EgressStatus, spaceId: string): SpaceEgressStatus | null {
  return status.spaces.find((row) => row.spaceId === spaceId) ?? null;
}

/**
 * Where one Space's traffic actually goes right now — which is not always
 * what its policy says: an identity Space with the gateway down is blocked
 * (D13), unless someone chose to browse direct for now, and a Space switched
 * to identity mid-session still browses direct until Pistachio is relaunched
 * (QUIC was not disabled at startup).
 */
export function spaceEgressView(row: SpaceEgressStatus | null, status: EgressStatus): EgressView {
  if (row === null || row.policy === "direct") {
    return { label: "Direct", note: "Requests go out from this Mac's own address.", tone: "gray" };
  }
  if (row.restartRequired) {
    return {
      label: "Direct until relaunch",
      note: RESTART_REQUIRED_NOTE,
      tone: "amber",
    };
  }
  if (row.temporaryDirectOverride) {
    return {
      label: "Direct for now",
      note: "You chose to browse direct while the gateway is down. Sites see this Mac's real IP address until it comes back.",
      tone: "amber",
    };
  }
  if (row.failClosed) {
    return {
      label: "Blocked",
      note: "The gateway is unreachable and this Space fails closed, so nothing loads rather than leaking your address.",
      tone: "red",
    };
  }
  if (status.health === "up") {
    return { label: "Through the gateway", note: "Requests leave from the gateway's address, not this Mac's.", tone: "green" };
  }
  return { label: "Waiting for the gateway", note: "No health probe has answered yet; requests wait rather than go out directly.", tone: "amber" };
}

/**
 * The one thing this Mac cannot fix without a relaunch: Chromium's QUIC is
 * switched off with a command-line flag, so a Space that became an identity
 * Space after startup would still have a UDP path around the proxy.
 */
export const RESTART_REQUIRED_NOTE =
  "QUIC was still on when Pistachio started, so this Space browses direct until you relaunch. Chromium only takes that switch at launch.";

/** Whether any Space needs the relaunch the note describes. */
export function restartRequired(status: EgressStatus): boolean {
  return status.spaces.some((row) => row.restartRequired);
}

/** The Spaces whose traffic is blocked right now, by id. */
export function blockedSpaceIds(status: EgressStatus): string[] {
  return status.spaces.filter((row) => row.failClosed).map((row) => row.spaceId);
}

/** Whether "Browse direct for now" is worth offering for this Space. */
export function canBrowseDirect(row: SpaceEgressStatus | null): boolean {
  return row !== null && row.policy === "identity" && row.failClosed && !row.temporaryDirectOverride;
}

export const EGRESS_POLICY_ITEMS: ReadonlyArray<{ value: SpaceEgressPolicy; label: string }> = [
  { value: "direct", label: "Direct" },
  { value: "identity", label: "Identity gateway" },
];
