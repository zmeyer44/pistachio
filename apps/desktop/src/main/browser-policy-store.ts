import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import {
  BROWSER_PERMISSIONS,
  GUARDED_BROWSER_ACTIONS,
  browserOrigin,
  isActionDecision,
  isBrowserPermission,
  isGuardedBrowserAction,
  isPermissionDecision,
  type ActionDecision,
  type BrowserPermission,
  type BrowserPolicyVerdict,
  type EnterpriseBrowserPolicy,
  type EnterpriseSiteRule,
  type GuardedBrowserAction,
  type PermissionDecision,
} from "@pistachio/shell-contracts/browser-controls";

interface StoredSiteDecisions {
  version: 1;
  sites: Record<string, Partial<Record<BrowserPermission, PermissionDecision>>>;
  /**
   * Link schemes a site may hand to another app without asking: origin →
   * `["zoommtg"]`. Narrower than `sites[origin]["external-app"] = "allow"`,
   * and what the prompt's "Always allow" writes — a meeting page trusted to
   * open Zoom is not thereby trusted to open anything else.
   */
  externalApps?: Record<string, string[]>;
}

const EMPTY_USER_DECISIONS: StoredSiteDecisions = { version: 1, sites: {} };
const EMPTY_ENTERPRISE_POLICY: EnterpriseBrowserPolicy = {
  version: 1,
  rules: [],
};

export class BrowserPolicyStore {
  readonly #userPath: string;
  readonly #managedPath: string;
  #user: StoredSiteDecisions;
  #managed: EnterpriseBrowserPolicy;

  constructor(userDataDir: string) {
    this.#userPath = join(userDataDir, "site-permissions.json");
    this.#managedPath = process.env["PISTACHIO_ENTERPRISE_POLICY"] ?? join(userDataDir, "enterprise-policy.json");
    this.#user = readUserDecisions(this.#userPath);
    this.#managed = readEnterprisePolicy(this.#managedPath);
  }

  permission(url: string, permission: BrowserPermission): BrowserPolicyVerdict<PermissionDecision> {
    const origin = browserOrigin(url);
    const managed = managedDecision(this.#managed.rules, origin, "permissions", permission);
    if (managed !== null)
      return {
        decision: managed,
        source: "managed",
        reason: "organization site policy",
      };
    const user = this.#user.sites[origin]?.[permission];
    if (user !== undefined) return { decision: user, source: "user", reason: "saved site decision" };
    return defaultPermissionVerdict(permission);
  }

  /**
   * Whether `url`'s site may hand a `scheme:` link to another app. The
   * site-level `external-app` decision rules when it is anything but "ask"
   * (managed policy, or a choice made in Site controls); otherwise a scheme
   * the person already said "always allow" to opens without a prompt.
   */
  externalApp(url: string, scheme: string): BrowserPolicyVerdict<PermissionDecision> {
    const site = this.permission(url, "external-app");
    if (site.decision !== "ask") return site;
    const remembered = this.#user.externalApps?.[browserOrigin(url)] ?? [];
    if (remembered.includes(scheme.toLowerCase()))
      return { decision: "allow", source: "user", reason: `always allowed to open ${scheme} links` };
    return site;
  }

  /** Remember that `url`'s site may always open `scheme:` links. */
  allowExternalApp(url: string, scheme: string): void {
    const origin = browserOrigin(url);
    const normalized = scheme.toLowerCase();
    if (origin === "" || !EXTERNAL_SCHEME_RE.test(normalized)) return;
    if (this.permission(url, "external-app").source === "managed") return;
    const remembered = this.#user.externalApps?.[origin] ?? [];
    if (remembered.includes(normalized)) return;
    this.#user.externalApps = { ...this.#user.externalApps, [origin]: [...remembered, normalized] };
    this.#write();
  }

  /** The schemes `url`'s site may open without asking, for Site controls to name. */
  externalAppSchemes(url: string): string[] {
    return [...(this.#user.externalApps?.[browserOrigin(url)] ?? [])];
  }

  action(url: string, action: GuardedBrowserAction): BrowserPolicyVerdict<ActionDecision> {
    const managed = managedDecision(this.#managed.rules, browserOrigin(url), "actions", action);
    if (managed !== null)
      return {
        decision: managed,
        source: "managed",
        reason: "organization data-control policy",
      };
    return {
      decision: "allow",
      source: "default",
      reason: "not restricted for this site",
    };
  }

  setPermission(url: string, permission: BrowserPermission, decision: PermissionDecision): void {
    const origin = browserOrigin(url);
    if (origin === "" || this.permission(url, permission).source === "managed") return;
    // A site-level choice about opening apps replaces the per-scheme ones:
    // picking "Ask" in Site controls has to mean the next link asks.
    if (permission === "external-app") this.#forgetExternalApps(origin);
    const current = this.#user.sites[origin] ?? {};
    // The default needs no record; anything else does — including "ask" for
    // a capability that is allowed by default, or it would fall straight
    // back to allow.
    if (decision === defaultPermissionVerdict(permission).decision) delete current[permission];
    else current[permission] = decision;
    if (Object.keys(current).length === 0) delete this.#user.sites[origin];
    else this.#user.sites[origin] = current;
    this.#write();
  }

  clearPermissions(url: string): void {
    const origin = browserOrigin(url);
    if (origin === "") return;
    const hadSchemes = this.#forgetExternalApps(origin);
    if (this.#user.sites[origin] === undefined && !hadSchemes) return;
    delete this.#user.sites[origin];
    this.#write();
  }

  #forgetExternalApps(origin: string): boolean {
    if (this.#user.externalApps?.[origin] === undefined) return false;
    delete this.#user.externalApps[origin];
    return true;
  }

  reloadManagedPolicy(): void {
    this.#managed = readEnterprisePolicy(this.#managedPath);
  }

  #write(): void {
    try {
      mkdirSync(dirname(this.#userPath), { recursive: true });
      const temporary = `${this.#userPath}.tmp`;
      writeFileSync(temporary, JSON.stringify(this.#user, null, 2));
      renameSync(temporary, this.#userPath);
    } catch {
      // A read-only profile still gets safe in-memory enforcement this session.
    }
  }
}

export function sitePatternMatches(pattern: string, origin: string): boolean {
  if (pattern === "*") return origin !== "";
  if (pattern === origin) return true;
  let hostname = "";
  try {
    hostname = new URL(origin).hostname.toLowerCase();
  } catch {
    const match = /^[a-z][a-z\d+.-]*:\/\/([^/:]+)/i.exec(origin);
    hostname = match?.[1]?.toLowerCase() ?? "";
  }
  const normalized = pattern.toLowerCase();
  if (normalized.startsWith("*.")) {
    const root = normalized.slice(2);
    return hostname !== root && hostname.endsWith(`.${root}`);
  }
  return hostname === normalized;
}

export function sanitizeEnterprisePolicy(value: unknown): EnterpriseBrowserPolicy {
  if (typeof value !== "object" || value === null) return structuredClone(EMPTY_ENTERPRISE_POLICY);
  const raw = value as Record<string, unknown>;
  if (raw["version"] !== 1 || !Array.isArray(raw["rules"])) return structuredClone(EMPTY_ENTERPRISE_POLICY);
  const rules: EnterpriseSiteRule[] = [];
  for (const candidate of raw["rules"]) {
    if (typeof candidate !== "object" || candidate === null) continue;
    const rule = candidate as Record<string, unknown>;
    if (typeof rule["pattern"] !== "string" || rule["pattern"].trim() === "") continue;
    const permissions = sanitizeRecord(rule["permissions"], isBrowserPermission, isPermissionDecision);
    const actions = sanitizeRecord(rule["actions"], isGuardedBrowserAction, isActionDecision);
    rules.push({
      pattern: rule["pattern"].trim(),
      ...(permissions === undefined ? {} : { permissions }),
      ...(actions === undefined ? {} : { actions }),
    });
  }
  return { version: 1, rules };
}

function readEnterprisePolicy(path: string): EnterpriseBrowserPolicy {
  try {
    return sanitizeEnterprisePolicy(JSON.parse(readFileSync(path, "utf8")));
  } catch {
    return structuredClone(EMPTY_ENTERPRISE_POLICY);
  }
}

function readUserDecisions(path: string): StoredSiteDecisions {
  try {
    const value = JSON.parse(readFileSync(path, "utf8")) as unknown;
    if (typeof value !== "object" || value === null) return structuredClone(EMPTY_USER_DECISIONS);
    const raw = value as Record<string, unknown>;
    if (raw["version"] !== 1 || typeof raw["sites"] !== "object" || raw["sites"] === null) {
      return structuredClone(EMPTY_USER_DECISIONS);
    }
    const sites: StoredSiteDecisions["sites"] = {};
    for (const [origin, decisions] of Object.entries(raw["sites"] as Record<string, unknown>)) {
      const sanitized = sanitizeRecord(decisions, isBrowserPermission, isPermissionDecision);
      if (sanitized !== undefined) sites[origin] = sanitized;
    }
    const externalApps = sanitizeExternalApps(raw["externalApps"]);
    return { version: 1, sites, ...(externalApps === undefined ? {} : { externalApps }) };
  } catch {
    return structuredClone(EMPTY_USER_DECISIONS);
  }
}

const EXTERNAL_SCHEME_RE = /^[a-z][a-z\d+.-]*$/u;

function sanitizeExternalApps(value: unknown): Record<string, string[]> | undefined {
  if (typeof value !== "object" || value === null) return undefined;
  const result: Record<string, string[]> = {};
  for (const [origin, schemes] of Object.entries(value)) {
    if (!Array.isArray(schemes)) continue;
    const valid = [
      ...new Set(schemes.filter((scheme): scheme is string => typeof scheme === "string" && EXTERNAL_SCHEME_RE.test(scheme))),
    ];
    if (valid.length > 0) result[origin] = valid;
  }
  return Object.keys(result).length === 0 ? undefined : result;
}

function sanitizeRecord<K extends string, V extends string>(
  value: unknown,
  keyGuard: (candidate: unknown) => candidate is K,
  valueGuard: (candidate: unknown) => candidate is V,
): Partial<Record<K, V>> | undefined {
  if (typeof value !== "object" || value === null) return undefined;
  const result: Partial<Record<K, V>> = {};
  for (const [key, candidate] of Object.entries(value)) {
    if (keyGuard(key) && valueGuard(candidate)) result[key] = candidate;
  }
  return Object.keys(result).length === 0 ? undefined : result;
}

function managedDecision<
  Section extends "permissions" | "actions",
  Key extends Section extends "permissions" ? BrowserPermission : GuardedBrowserAction,
  Value extends Section extends "permissions" ? PermissionDecision : ActionDecision,
>(rules: EnterpriseSiteRule[], origin: string, section: Section, key: Key): Value | null {
  let decision: Value | null = null;
  for (const rule of rules) {
    if (!sitePatternMatches(rule.pattern, origin)) continue;
    const next = rule[section]?.[key as never] as Value | undefined;
    if (next !== undefined) decision = next;
  }
  return decision;
}

/**
 * What a site may do before anyone has decided. Device capabilities — the
 * camera, the microphone, location — ask first. The clipboard does not:
 * copying and pasting is how the web is used, every other browser grants it
 * to the page the person is interacting with, and a prompt on every copy is
 * a wall between the person and their own text. A site can still be told
 * "ask" or "block" for it, by the person or by managed policy, and the
 * data-movement actions (copy/paste) stay their own managed gate.
 */
export function defaultPermissionVerdict(permission: BrowserPermission): BrowserPolicyVerdict<PermissionDecision> {
  if (permission === "clipboard-read" || permission === "clipboard-write")
    return { decision: "allow", source: "default", reason: "clipboard access is allowed by default" };
  return { decision: "ask", source: "default", reason: "ask before exposing this capability" };
}

export function emptyPermissionMap(): Record<BrowserPermission, BrowserPolicyVerdict<PermissionDecision>> {
  return Object.fromEntries(
    BROWSER_PERMISSIONS.map((permission) => [permission, defaultPermissionVerdict(permission)]),
  ) as Record<BrowserPermission, BrowserPolicyVerdict<PermissionDecision>>;
}

export function emptyActionMap(): Record<GuardedBrowserAction, BrowserPolicyVerdict<ActionDecision>> {
  return Object.fromEntries(
    GUARDED_BROWSER_ACTIONS.map((action) => [
      action,
      {
        decision: "allow",
        source: "default",
        reason: "not restricted for this site",
      },
    ]),
  ) as Record<GuardedBrowserAction, BrowserPolicyVerdict<ActionDecision>>;
}
