import { AdapterRegistry, type SemanticAction } from "@pistachio/adapters";
import type { CapsuleGrant, HttpMethod } from "@pistachio/protocol";
import { normalizeOrigin } from "@pistachio/protocol";

const HTTP_METHODS = new Set<HttpMethod>([
  "GET",
  "HEAD",
  "OPTIONS",
  "POST",
  "PUT",
  "PATCH",
  "DELETE",
]);
const READ_METHODS = new Set<HttpMethod>(["GET", "HEAD", "OPTIONS"]);
const SENSITIVE_SEGMENTS = new Set([
  "admin",
  "auth",
  "login",
  "oauth",
  "password",
  "permissions",
  "security",
  "settings",
  "signin",
]);

export type PolicyOutcome = "allow" | "deny" | "require_approval";

/** Raw facts observed at the browser/network enforcement point. */
export interface InterceptedRequest {
  url: string;
  method: string;
  resourceType?: string;
  hasFileUpload?: boolean;
}

export interface ApprovalScope {
  origin: string;
  method: HttpMethod;
  adapterId: string;
  adapterVersion: string;
  actionId: string;
  pathPattern: string;
}

export interface RequestClassification {
  url: string;
  origin: string | null;
  method: HttpMethod | null;
  interactionNumber: number;
  sensitivePage: boolean;
  hasFileUpload: boolean;
  semanticAction: SemanticAction | null;
  approvalScope: ApprovalScope | null;
}

export interface PolicyDecision {
  outcome: PolicyOutcome;
  reason: string;
  rule: string;
  classification: RequestClassification;
  holdId: string | null;
}

interface OneTimeApproval {
  id: string;
  scope: ApprovalScope;
  expiresAt: string;
}

export class PolicyEnforcer {
  readonly #grant: CapsuleGrant;
  readonly #adapters: AdapterRegistry;
  readonly #approvals = new Map<string, OneTimeApproval>();
  readonly #heldScopes = new Map<string, ApprovalScope>();
  #interactions = 0;
  #revoked = false;

  constructor(grant: CapsuleGrant, adapters: AdapterRegistry) {
    this.#grant = structuredClone(grant);
    this.#adapters = adapters;
  }

  authorize(request: InterceptedRequest, now = Date.now()): PolicyDecision {
    this.#interactions += 1;
    const classification = this.#classify(request);
    if (this.#revoked) return decision("deny", "task authority has ended", "authority.revoked", classification);
    if (classification.origin === null || classification.method === null) {
      return decision("deny", "request URL or method is unsupported", "request.unsupported", classification);
    }
    const allowedOrigins = new Set(this.#grant.origins.map(normalizeOrigin));
    if (!allowedOrigins.has(classification.origin)) {
      return decision("deny", `${classification.origin} is outside the capsule`, "origin.allowlist", classification);
    }
    if (classification.interactionNumber > this.#grant.maxInteractions) {
      return decision("deny", "interaction budget exhausted", "budget.interactions", classification);
    }
    if (classification.sensitivePage) {
      return decision("deny", "authentication and settings pages are blocked", "page.sensitive", classification);
    }
    if (classification.hasFileUpload && !this.#grant.allowUploads) {
      return decision("deny", "file uploads are not granted", "transfer.upload", classification);
    }
    if (!this.#grant.methods.includes(classification.method)) {
      return decision("deny", `${classification.method} is not granted`, "http.method", classification);
    }
    if (READ_METHODS.has(classification.method)) {
      return decision("allow", "within deterministic grant", "grant.read", classification);
    }
    if (classification.semanticAction === null || classification.approvalScope === null) {
      return decision(
        "deny",
        "write request has no versioned semantic adapter",
        "action.unclassified",
        classification,
      );
    }
    const approval = [...this.#approvals.values()].find(
      (candidate) =>
        sameScope(candidate.scope, classification.approvalScope!) &&
        new Date(candidate.expiresAt).getTime() > now,
    );
    if (approval !== undefined) {
      this.#approvals.delete(approval.id);
      return decision(
        "allow",
        `one-time approval ${approval.id} consumed`,
        "approval.once",
        classification,
      );
    }
    const holdId = `hold-${this.#interactions}`;
    this.#heldScopes.set(holdId, structuredClone(classification.approvalScope));
    return decision(
      "require_approval",
      `${classification.semanticAction.label} changes remote state`,
      "action.consequential",
      classification,
      holdId,
    );
  }

  grantOnce(
    heldDecision: PolicyDecision,
    approval: { id: string; expiresAt: string },
    now = Date.now(),
  ): void {
    if (this.#revoked) throw new Error("task authority has ended");
    if (heldDecision.outcome !== "require_approval") throw new Error("decision is not approvable");
    if (heldDecision.holdId === null) throw new Error("decision has no held request");
    const heldScope = this.#heldScopes.get(heldDecision.holdId);
    if (heldScope === undefined) throw new Error("held request is unknown or already consumed");
    if (new Date(approval.expiresAt).getTime() <= now) throw new Error("approval expired");
    this.#heldScopes.delete(heldDecision.holdId);
    this.#approvals.set(approval.id, {
      id: approval.id,
      scope: structuredClone(heldScope),
      expiresAt: approval.expiresAt,
    });
  }

  isNavigationAllowed(url: string): boolean {
    if (this.#revoked) return false;
    try {
      const origin = normalizeOrigin(url);
      const allowedOrigins = new Set(this.#grant.origins.map(normalizeOrigin));
      return allowedOrigins.has(origin) && !isSensitivePath(new URL(url).pathname);
    } catch {
      return false;
    }
  }

  allowsDownloads(): boolean {
    return !this.#revoked && this.#grant.allowDownloads;
  }

  allowsUploads(): boolean {
    return !this.#revoked && this.#grant.allowUploads;
  }

  allowsClipboard(): boolean {
    return !this.#revoked && this.#grant.allowClipboard;
  }

  revoke(): void {
    this.#revoked = true;
    this.#approvals.clear();
    this.#heldScopes.clear();
  }

  #classify(request: InterceptedRequest): RequestClassification {
    const method = normalizeMethod(request.method);
    let origin: string | null = null;
    let sensitivePage = true;
    let semanticAction: SemanticAction | null = null;
    try {
      const url = new URL(request.url);
      origin = normalizeOrigin(url.toString());
      sensitivePage = isSensitivePath(url.pathname);
      if (method !== null) semanticAction = this.#adapters.resolve({ url: url.toString(), method });
    } catch {
      // Invalid URLs remain unclassified and fail closed in authorize().
    }
    const approvalScope =
      origin !== null && method !== null && semanticAction !== null
        ? {
            origin,
            method,
            adapterId: semanticAction.adapterId,
            adapterVersion: semanticAction.adapterVersion,
            actionId: semanticAction.id,
            pathPattern: semanticAction.path,
          }
        : null;
    return {
      url: request.url,
      origin,
      method,
      interactionNumber: this.#interactions,
      sensitivePage,
      hasFileUpload: request.hasFileUpload === true,
      semanticAction,
      approvalScope,
    };
  }
}

function normalizeMethod(value: string): HttpMethod | null {
  const method = value.toUpperCase() as HttpMethod;
  return HTTP_METHODS.has(method) ? method : null;
}

function isSensitivePath(pathname: string): boolean {
  return pathname
    .split("/")
    .filter(Boolean)
    .some((segment) => SENSITIVE_SEGMENTS.has(segment.toLowerCase()));
}

function sameScope(left: ApprovalScope, right: ApprovalScope): boolean {
  return (
    left.origin === right.origin &&
    left.method === right.method &&
    left.adapterId === right.adapterId &&
    left.adapterVersion === right.adapterVersion &&
    left.actionId === right.actionId &&
    left.pathPattern === right.pathPattern
  );
}

function decision(
  outcome: PolicyOutcome,
  reason: string,
  rule: string,
  classification: RequestClassification,
  holdId: string | null = null,
): PolicyDecision {
  return { outcome, reason, rule, classification, holdId };
}
