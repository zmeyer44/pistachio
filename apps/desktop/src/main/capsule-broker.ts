import { createCipheriv, createDecipheriv, randomBytes, randomUUID } from "node:crypto";
import type { Cookie, CookiesSetDetails, Session } from "electron";
import type { CapsuleGrant, CapturedTab, TaskCapsule } from "@pistachio/protocol";
import { normalizeOrigin, validateCapsule } from "@pistachio/protocol";
import type { BrowserTabInfo } from "@pistachio/shell-contracts/ipc";
import type { CapturedPageContext } from "./browser-controller";

interface CapsuleEnvelope {
  nonce: Buffer;
  ciphertext: Buffer;
  tag: Buffer;
}

interface CapsuleRecord {
  capsule: TaskCapsule;
  key: Buffer;
  envelope: CapsuleEnvelope;
  expiryTimer: NodeJS.Timeout;
}

interface SealedCapsulePayload {
  cookies: Cookie[];
  context: CapturedPageContext;
}

export class CapsuleBroker {
  readonly #records = new Map<string, CapsuleRecord>();
  readonly #expirationListeners = new Set<(capsuleId: string) => void>();

  onExpired(listener: (capsuleId: string) => void): () => void {
    this.#expirationListeners.add(listener);
    return () => this.#expirationListeners.delete(listener);
  }

  async capture(options: {
    taskId: string;
    sponsorId: string;
    purpose: string;
    tab: BrowserTabInfo;
    context: CapturedPageContext;
    sourceSession: Session;
    now?: Date;
    ttlMs?: number;
    /** Ceiling overrides from settings; origins are always the forked tab's. */
    grant?: Partial<Omit<CapsuleGrant, "origins">>;
  }): Promise<TaskCapsule> {
    const now = options.now ?? new Date();
    const ttlMs = options.ttlMs ?? 30 * 60_000;
    if (!Number.isSafeInteger(ttlMs) || ttlMs <= 0) throw new Error("capsule TTL must be positive");
    const origin = normalizeOrigin(options.tab.url);
    const cookies = await this.#cookiesFor(options.sourceSession, options.tab.url);
    const capturedTab: CapturedTab = {
      id: options.tab.id,
      title: options.tab.title,
      url: options.tab.url,
    };
    const capsule: TaskCapsule = {
      version: 1,
      id: randomUUID(),
      taskId: options.taskId,
      sponsorId: options.sponsorId,
      purpose: options.purpose,
      createdAt: now.toISOString(),
      expiresAt: new Date(now.getTime() + ttlMs).toISOString(),
      policyVersion: "local-demo-policy-v1",
      keyId: randomUUID(),
      tabs: [capturedTab],
      grant: {
        methods: ["GET", "HEAD", "OPTIONS", "POST"],
        allowUploads: false,
        allowDownloads: false,
        allowClipboard: false,
        maxInteractions: 20,
        ...options.grant,
        origins: [origin],
      },
    };
    validateCapsule(capsule, now.getTime());
    const key = randomBytes(32);
    const nonce = randomBytes(12);
    const cipher = createCipheriv("aes-256-gcm", key, nonce);
    cipher.setAAD(Buffer.from(`pistachio.capsule.v1\0${capsule.id}`));
    const sealedPayload: SealedCapsulePayload = {
      cookies,
      context: structuredClone(options.context),
    };
    const ciphertext = Buffer.concat([
      cipher.update(JSON.stringify(sealedPayload), "utf8"),
      cipher.final(),
    ]);
    const expiryTimer = setTimeout(() => this.#expire(capsule.id), ttlMs);
    expiryTimer.unref();
    this.#records.set(capsule.id, {
      capsule,
      key,
      envelope: { nonce, ciphertext, tag: cipher.getAuthTag() },
      expiryTimer,
    });
    return structuredClone(capsule);
  }

  async hydrate(capsuleId: string, target: Session, now = Date.now()): Promise<CapturedPageContext> {
    const record = this.#require(capsuleId);
    if (new Date(record.capsule.expiresAt).getTime() <= now) {
      this.#expire(capsuleId);
      throw new Error("capsule expired");
    }
    validateCapsule(record.capsule, now);
    const decipher = createDecipheriv("aes-256-gcm", record.key, record.envelope.nonce);
    decipher.setAAD(Buffer.from(`pistachio.capsule.v1\0${capsuleId}`));
    decipher.setAuthTag(record.envelope.tag);
    const plaintext = Buffer.concat([decipher.update(record.envelope.ciphertext), decipher.final()]);
    const payload = JSON.parse(plaintext.toString("utf8")) as SealedCapsulePayload;
    plaintext.fill(0);
    for (const cookie of payload.cookies) {
      if (cookie.domain === undefined || cookie.path === undefined) continue;
      const host = cookie.domain.replace(/^\./u, "");
      const details: CookiesSetDetails = {
        url: `${cookie.secure === true ? "https" : "http"}://${host}${cookie.path}`,
        name: cookie.name,
        value: cookie.value,
        path: cookie.path,
        secure: cookie.secure,
        httpOnly: cookie.httpOnly,
        expirationDate: cookie.session === true ? undefined : cookie.expirationDate,
        sameSite: cookie.sameSite,
      };
      // Supplying domain converts a host-only cookie into a domain cookie.
      // Preserve the source identity tuple by omitting it for host-only rows.
      if (cookie.hostOnly !== true) details.domain = cookie.domain;
      await target.cookies.set(details);
    }
    return structuredClone(payload.context);
  }

  revoke(capsuleId: string): boolean {
    return this.#destroy(capsuleId);
  }

  isLive(capsuleId: string): boolean {
    return this.#records.has(capsuleId);
  }

  async #cookiesFor(source: Session, url: string): Promise<Cookie[]> {
    const parsed = new URL(url);
    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") return [];
    return source.cookies.get({ url });
  }

  #expire(capsuleId: string): void {
    if (!this.#destroy(capsuleId)) return;
    for (const listener of this.#expirationListeners) listener(capsuleId);
  }

  #destroy(capsuleId: string): boolean {
    const record = this.#records.get(capsuleId);
    if (record === undefined) return false;
    clearTimeout(record.expiryTimer);
    record.key.fill(0);
    record.envelope.ciphertext.fill(0);
    record.envelope.tag.fill(0);
    this.#records.delete(capsuleId);
    return true;
  }

  #require(capsuleId: string): CapsuleRecord {
    const record = this.#records.get(capsuleId);
    if (record === undefined) throw new Error("capsule is revoked, expired, or unknown");
    return record;
  }
}
