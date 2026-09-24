"use client";
import { WsShellApi as SharedWsShellApi, ShellSocketError, type ShellSocketOptions as SharedOptions } from "@pistachio/browser-client/lib/shell-socket.js";
import { browserSessionTicket } from "@pistachio/web-account";
import { seal, shellProofSealAad, toBase64, utf8, type SpaceKeys } from "@pistachio/sync-protocol";
export * from "@pistachio/browser-client/lib/shell-socket.js";
export interface ShellSocketOptions extends Omit<SharedOptions, "ticket" | "prove"> {
  keys: SpaceKeys;
  getToken(): Promise<string | null>;
}
export class WsShellApi extends SharedWsShellApi {
  constructor(options: ShellSocketOptions) {
    super({
      ...options,
      ticket: async () => {
        const token = await options.getToken();
        if (token === null) throw new ShellSocketError("unauthorized", "This browser is not signed in.");
        return browserSessionTicket(token, options.sessionId);
      },
      prove: async (nonce) => toBase64(await seal(options.keys.sealKey, utf8(nonce), shellProofSealAad(options.sessionId, nonce))),
    });
  }
}
