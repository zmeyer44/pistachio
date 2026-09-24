/** Public form metadata. Field values travel only in an encrypted payload. */
export interface CredentialCapture {
  id: string;
  runId: string;
  siteName: string;
  siteOrigin: string;
  /** Base64 raw X25519 key for the cloud browser assigned to this run. */
  encryptionPublicKey: string;
  fields: Array<{
    id: string;
    label: string;
    type: "text" | "email" | "password" | "otp";
    autocomplete?: string;
  }>;
  expiresAt: string;
  status: "pending" | "submitted" | "consumed" | "expired";
}

/** Errors stay typed across Electron IPC, which otherwise loses Error properties. */
export type CredentialCaptureReply<T> = { ok: true; value: T } | { ok: false; status: number; code: string };
