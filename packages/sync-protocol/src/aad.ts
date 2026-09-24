/**
 * Domain-separated AAD and signature layouts shared by every sealing site
 * (docs/cloud-sync-design.md §2, D3). The engine, the desktop workspace sync,
 * control, and the cloud browser all import these so the byte layouts cannot
 * drift between the sealer and the opener.
 */

import { lengthPrefixed } from "./encoding.js";
import { encodeHlc, type Hlc } from "./hlc.js";

/**
 * Workspace docs are account-global, so they seal under a dedicated account
 * workspace key: deriveSpaceKeys with this fixed pseudo-space id over the
 * per-account workspace secret. Control reserves the same id for wrappers.
 */
export const WORKSPACE_PSEUDO_SPACE_ID = "__workspace__";

const RECORD_SEAL_DOMAIN = "pistachio.sync.seal.v1";
const WORKSPACE_SEAL_DOMAIN = "pistachio.workspace.seal.v1";
const WORKSPACE_SIG_DOMAIN = "pistachio.workspacesig.v1";
const RUN_EVENT_SEAL_DOMAIN = "pistachio.runevent.seal.v1";
const RUN_THREAD_SEAL_DOMAIN = "pistachio.runthread.seal.v1";
const LIVE_PROOF_SEAL_DOMAIN = "pistachio.liveproof.seal.v1";
const SHELL_PROOF_SEAL_DOMAIN = "pistachio.shell.proof.v1";
const CREDENTIAL_CAPTURE_SEAL_DOMAIN = "pistachio.credentialcapture.seal.v1";
const VAULT_ENTRY_SEAL_DOMAIN = "pistachio.vault.seal.v1";
const INTEGRATION_CONNECTION_SEAL_DOMAIN = "pistachio.integration.seal.v1";

/** AAD binding a sealed cookie record to its space and pseudonymous record id. */
export function recordSealAad(spaceId: string, recordIdHex: string): Uint8Array {
  return lengthPrefixed([RECORD_SEAL_DOMAIN, spaceId, recordIdHex]);
}

/** AAD binding a sealed workspace value to its doc key. */
export function workspaceSealAad(key: string): Uint8Array {
  return lengthPrefixed([WORKSPACE_SEAL_DOMAIN, key]);
}

/** Canonical bytes covered by a workspace record's device signature. */
export function workspaceSigningBytes(
  key: string,
  sealedValue: string | null,
  hlc: Hlc,
): Uint8Array {
  return lengthPrefixed([WORKSPACE_SIG_DOMAIN, key, sealedValue ?? "", encodeHlc(hlc)]);
}

/**
 * AAD binding a sealed run content event to its run and the runner-minted
 * event id (§7.8: the id, not `seq`, because control allocates `seq` after
 * the runner has already sealed the event).
 */
export function runEventSealAad(runId: string, eventId: string): Uint8Array {
  return lengthPrefixed([RUN_EVENT_SEAL_DOMAIN, runId, eventId]);
}

/** AAD binding a sealed hosted-run thread snapshot to its run. */
export function runThreadSealAad(runId: string): Uint8Array {
  return lengthPrefixed([RUN_THREAD_SEAL_DOMAIN, runId]);
}

/**
 * AAD binding a live view's proof-of-possession to the run and the nonce it
 * answers (§8.5). Its own domain so a proof can never be replayed as a record
 * or an event, and the nonce so one cannot be replayed as another's.
 */
export function liveProofSealAad(runId: string, nonce: string): Uint8Array {
  return lengthPrefixed([LIVE_PROOF_SEAL_DOMAIN, runId, nonce]);
}

/**
 * AAD binding a shell socket's proof-of-possession to the browser session and
 * the nonce it answers (web-browser-design.md §5). The shell socket is the
 * session's equivalent of the live view's: a device token gets you a socket,
 * the Space key gets you the state. Its own domain, so a shell proof can
 * never be replayed as a live-view proof (or the reverse) even though both
 * seal a nonce under the same Space key, and the nonce so one challenge's
 * answer cannot stand in for another's.
 */
export function shellProofSealAad(sessionId: string, nonce: string): Uint8Array {
  return lengthPrefixed([SHELL_PROOF_SEAL_DOMAIN, sessionId, nonce]);
}

/** Bind a one-time credential payload to both its run and capture request. */
export function credentialCaptureSealAad(runId: string, captureId: string): Uint8Array {
  return lengthPrefixed([CREDENTIAL_CAPTURE_SEAL_DOMAIN, runId, captureId]);
}

/**
 * Bind a vault entry's sealed values to its Space and entry id. Sealed under
 * the Space seal key like run content, but in its own domain so an entry can
 * never be opened as an event, a thread, or a record, nor one entry's
 * ciphertext be re-filed under another's id.
 */
export function vaultEntrySealAad(spaceId: string, entryId: string): Uint8Array {
  return lengthPrefixed([VAULT_ENTRY_SEAL_DOMAIN, spaceId, entryId]);
}

/**
 * Bind an integration connection's sealed token to its Space and connection
 * id. Its own domain, like the vault's, so a Gmail refresh token can never
 * be opened as a vault entry or a record, nor one connection's ciphertext
 * be re-filed under another's id.
 */
export function integrationConnectionSealAad(spaceId: string, connectionId: string): Uint8Array {
  return lengthPrefixed([INTEGRATION_CONNECTION_SEAL_DOMAIN, spaceId, connectionId]);
}
