/**
 * SSRF guard for the cloud browser (D26): the initial URL and every
 * subrequest the page makes pass through `assertAllowed` before Chromium may
 * fetch them. Ported from harbor's `browser/network-policy.ts`.
 */

import { lookup } from "node:dns/promises";
import { isIP } from "node:net";
import { ipIsPrivate, parseIpAddress, unbracketHost } from "@pistachio/egress-policy";

export interface BrowserNetworkPolicy {
  assertAllowed(url: string): Promise<void>;
}

export interface SafeBrowserNetworkPolicyOptions {
  /** Exact origins that bypass the private-address rules (local fixtures in tests). */
  allowedOrigins?: readonly string[];
}

/** Blocks browser-driven SSRF on the initial URL and every subrequest. */
export class SafeBrowserNetworkPolicy implements BrowserNetworkPolicy {
  readonly #allowedOrigins: Set<string>;
  readonly #leasedOrigins = new Map<string, number>();

  constructor(options: SafeBrowserNetworkPolicyOptions = {}) {
    this.#allowedOrigins = new Set(
      (options.allowedOrigins ?? []).map((origin) => new URL(origin).origin),
    );
  }

  /**
   * Temporarily trust one host-created origin. Ref-counting keeps concurrent
   * leases from revoking each other.
   */
  leaseOrigin(rawOrigin: string): () => void {
    const origin = new URL(rawOrigin).origin;
    this.#leasedOrigins.set(origin, (this.#leasedOrigins.get(origin) ?? 0) + 1);
    let active = true;
    return () => {
      if (!active) return;
      active = false;
      const remaining = (this.#leasedOrigins.get(origin) ?? 1) - 1;
      if (remaining <= 0) this.#leasedOrigins.delete(origin);
      else this.#leasedOrigins.set(origin, remaining);
    };
  }

  async assertAllowed(rawUrl: string): Promise<void> {
    const url = new URL(rawUrl);
    if (url.protocol !== "http:" && url.protocol !== "https:") {
      throw new Error(`browser network policy blocks ${url.protocol} URLs`);
    }
    if (url.username !== "" || url.password !== "") {
      throw new Error("credentials in browser URLs are not allowed");
    }
    if (this.#allowedOrigins.has(url.origin) || this.#leasedOrigins.has(url.origin)) {
      return;
    }

    const hostname = unbracketHost(url.hostname).toLowerCase().replace(/\.$/u, "");
    if (
      hostname === "localhost" ||
      hostname.endsWith(".localhost") ||
      hostname.endsWith(".local") ||
      hostname.endsWith(".internal") ||
      hostname === "metadata.google.internal"
    ) {
      throw new Error(`browser network policy blocks host ${hostname}`);
    }

    if (isIP(hostname) !== 0) {
      if (isBlockedAddress(hostname)) {
        throw new Error(`browser network policy blocks address ${hostname}`);
      }
      return;
    }

    const addresses = await lookup(hostname, { all: true, verbatim: true });
    if (addresses.length === 0) {
      throw new Error(`browser host ${hostname} did not resolve`);
    }
    for (const { address } of addresses) {
      if (isBlockedAddress(address)) {
        throw new Error(`browser network policy blocks ${hostname} because it resolves to ${address}`);
      }
    }
  }
}

/**
 * Refuses every address on the shared private/unroutable list, and anything
 * that does not parse strictly (zone ids, leading-zero octets): a literal
 * Chromium might interpret differently from this guard is not worth the risk.
 */
export function isBlockedAddress(address: string): boolean {
  const ip = parseIpAddress(unbracketHost(address).toLowerCase());
  return ip === null || ipIsPrivate(ip);
}
