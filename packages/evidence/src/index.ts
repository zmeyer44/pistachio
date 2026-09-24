import {
  createHash,
  createPrivateKey,
  createPublicKey,
  generateKeyPairSync,
  randomUUID,
  sign as signBytes,
  verify as verifyBytes,
  type KeyObject,
} from "node:crypto";

export interface EvidenceEntry {
  id: string;
  sequence: number;
  runId: string;
  at: string;
  type: string;
  actor: {
    principal: string;
    sponsor: string;
    task: string;
  };
  payload: Record<string, unknown>;
  previousHash: string;
  signer: {
    algorithm: "Ed25519";
    keyId: string;
    publicKey: string;
  };
  hash: string;
  signature: string;
}

type UnsignedEvidenceEntry = Omit<EvidenceEntry, "hash" | "signature">;

function canonical(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  const record = value as Record<string, unknown>;
  return `{${Object.keys(record)
    .sort()
    .map((key) => `${JSON.stringify(key)}:${canonical(record[key])}`)
    .join(",")}}`;
}

export function hashEvidence(value: UnsignedEvidenceEntry): string {
  return createHash("sha256").update("pistachio.evidence.v1\0").update(canonical(value)).digest("hex");
}

export interface EvidenceVerificationExpectation {
  expectedRootHash?: string;
  expectedLength?: number;
  expectedRunId?: string;
  expectedSignerKeyId?: string;
}

export function verifyEvidenceEntries(
  entries: EvidenceEntry[],
  expectation: EvidenceVerificationExpectation = {},
): boolean {
  if (expectation.expectedLength !== undefined && entries.length !== expectation.expectedLength) {
    return false;
  }
  let previousHash = "0".repeat(64);
  let runId = expectation.expectedRunId;
  let signerKeyId = expectation.expectedSignerKeyId;
  let signerPublicKey: string | undefined;
  for (const [index, entry] of entries.entries()) {
    const { hash, signature, ...unsigned } = entry;
    if (entry.sequence !== index + 1) return false;
    runId ??= entry.runId;
    signerKeyId ??= entry.signer.keyId;
    signerPublicKey ??= entry.signer.publicKey;
    if (
      entry.runId !== runId ||
      entry.signer.keyId !== signerKeyId ||
      entry.signer.publicKey !== signerPublicKey
    ) {
      return false;
    }
    if (entry.previousHash !== previousHash || hashEvidence(unsigned) !== hash) return false;
    if (entry.signer.algorithm !== "Ed25519") return false;
    const publicKeyDer = Buffer.from(entry.signer.publicKey, "base64");
    const expectedKeyId = createHash("sha256").update(publicKeyDer).digest("hex");
    if (entry.signer.keyId !== expectedKeyId) return false;
    try {
      const publicKey = createPublicKey({ key: publicKeyDer, type: "spki", format: "der" });
      if (!verifyBytes(null, Buffer.from(hash, "hex"), publicKey, Buffer.from(signature, "base64"))) {
        return false;
      }
    } catch {
      return false;
    }
    previousHash = hash;
  }
  return expectation.expectedRootHash === undefined || previousHash === expectation.expectedRootHash;
}

export class EvidenceChain {
  readonly #runId: string;
  readonly #actor: EvidenceEntry["actor"];
  readonly #entries: EvidenceEntry[] = [];
  readonly #privateKey: KeyObject;
  readonly #signer: EvidenceEntry["signer"];

  /**
   * A chain continues from `entries` when given: they must verify as one
   * run signed by `signingKey`, and new entries extend them. Otherwise
   * the chain starts empty, with a fresh key unless one is supplied.
   */
  constructor(runId: string, actor: EvidenceEntry["actor"], signingKey?: KeyObject, entries: EvidenceEntry[] = []) {
    this.#runId = runId;
    this.#actor = structuredClone(actor);
    this.#privateKey = signingKey ?? generateKeyPairSync("ed25519").privateKey;
    const publicKeyDer = createPublicKey(this.#privateKey).export({ type: "spki", format: "der" });
    this.#signer = {
      algorithm: "Ed25519",
      keyId: createHash("sha256").update(publicKeyDer).digest("hex"),
      publicKey: publicKeyDer.toString("base64"),
    };
    if (entries.length > 0) {
      if (!verifyEvidenceEntries(entries, { expectedRunId: runId, expectedSignerKeyId: this.#signer.keyId })) {
        throw new Error("evidence entries do not continue this run under this key");
      }
      this.#entries.push(...structuredClone(entries));
    }
  }

  /** The signing key as PEM, for a chain that must continue after a restart. */
  exportSigningKey(): string {
    return this.#privateKey.export({ type: "pkcs8", format: "pem" }).toString();
  }

  /** A key exported by `exportSigningKey`. */
  static importSigningKey(pem: string): KeyObject {
    return createPrivateKey({ key: pem, format: "pem" });
  }

  append(type: string, payload: Record<string, unknown>, at = new Date().toISOString()): EvidenceEntry {
    const unsigned: UnsignedEvidenceEntry = {
      id: randomUUID(),
      sequence: this.#entries.length + 1,
      runId: this.#runId,
      at,
      type,
      actor: structuredClone(this.#actor),
      payload: structuredClone(payload),
      previousHash: this.rootHash(),
      signer: structuredClone(this.#signer),
    };
    const hash = hashEvidence(unsigned);
    const entry: EvidenceEntry = {
      ...unsigned,
      hash,
      signature: signBytes(null, Buffer.from(hash, "hex"), this.#privateKey).toString("base64"),
    };
    this.#entries.push(entry);
    return entry;
  }

  entries(): EvidenceEntry[] {
    return structuredClone(this.#entries);
  }

  rootHash(): string {
    return this.#entries.at(-1)?.hash ?? "0".repeat(64);
  }

  verify(): boolean {
    return verifyEvidenceEntries(this.#entries, {
      expectedRootHash: this.rootHash(),
      expectedLength: this.#entries.length,
      expectedRunId: this.#runId,
      expectedSignerKeyId: this.#signer.keyId,
    });
  }
}
