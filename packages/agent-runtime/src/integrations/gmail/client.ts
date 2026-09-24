/**
 * The slice of the Gmail REST API the agent's tools use, over an injected
 * `fetch` and an access-token provider. Every method maps to one documented
 * endpoint under `users/me`; the client adds the bearer, retries once with a
 * fresh token after a 401, and turns Google's error envelope into an
 * `Error` whose message the model can act on.
 */

import type { FetchLike } from "../oauth.js";
import type { GmailMessageResource, GmailThreadResource } from "./mime.js";

export const GMAIL_API_BASE = "https://gmail.googleapis.com/gmail/v1/users/me";

export interface GmailClientOptions {
  /** A live access token; `fresh` asks for one minted anew. */
  accessToken: (options?: { fresh?: boolean }) => Promise<string>;
  fetch?: FetchLike;
  baseUrl?: string;
}

export class GmailApiError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
    this.name = "GmailApiError";
  }
}

export interface GmailProfile {
  emailAddress: string;
  messagesTotal: number;
  threadsTotal: number;
}

export interface GmailMessageListPage {
  messages: Array<{ id: string; threadId: string }>;
  nextPageToken: string | null;
  resultSizeEstimate: number;
}

export interface GmailDraftResource {
  id: string;
  message: { id: string; threadId: string; labelIds?: string[] };
}

export interface GmailLabel {
  id: string;
  name: string;
  type?: string;
}

interface GoogleErrorEnvelope {
  error?: { code?: number; message?: string; status?: string };
}

export class GmailClient {
  readonly #token: GmailClientOptions["accessToken"];
  readonly #fetch: FetchLike;
  readonly #base: string;

  constructor(options: GmailClientOptions) {
    this.#token = options.accessToken;
    this.#fetch = options.fetch ?? fetch;
    this.#base = (options.baseUrl ?? GMAIL_API_BASE).replace(/\/+$/u, "");
  }

  profile(): Promise<GmailProfile> {
    return this.#call<GmailProfile>("GET", "/profile");
  }

  listMessages(input: { query: string; maxResults: number; pageToken?: string | null; labelIds?: string[] }): Promise<GmailMessageListPage> {
    const params = new URLSearchParams({ maxResults: String(input.maxResults) });
    if (input.query !== "") params.set("q", input.query);
    if (input.pageToken !== undefined && input.pageToken !== null) params.set("pageToken", input.pageToken);
    for (const label of input.labelIds ?? []) params.append("labelIds", label);
    return this.#call<{ messages?: Array<{ id: string; threadId: string }>; nextPageToken?: string; resultSizeEstimate?: number }>(
      "GET",
      `/messages?${params.toString()}`,
    ).then((page) => ({
      messages: page.messages ?? [],
      nextPageToken: page.nextPageToken ?? null,
      resultSizeEstimate: page.resultSizeEstimate ?? 0,
    }));
  }

  /** `format=metadata` carries headers only; `full` carries the body parts too. */
  getMessage(id: string, format: "metadata" | "full" = "full"): Promise<GmailMessageResource> {
    const params = new URLSearchParams({ format });
    if (format === "metadata") {
      for (const name of ["From", "To", "Cc", "Subject", "Date", "Message-ID", "Reply-To", "References"]) params.append("metadataHeaders", name);
    }
    return this.#call<GmailMessageResource>("GET", `/messages/${encodeURIComponent(id)}?${params.toString()}`);
  }

  getThread(id: string): Promise<GmailThreadResource> {
    return this.#call<GmailThreadResource>("GET", `/threads/${encodeURIComponent(id)}?format=full`);
  }

  createDraft(raw: string, threadId: string | null): Promise<GmailDraftResource> {
    return this.#call<GmailDraftResource>("POST", "/drafts", { message: { raw, ...(threadId === null ? {} : { threadId }) } });
  }

  sendMessage(raw: string, threadId: string | null): Promise<{ id: string; threadId: string; labelIds?: string[] }> {
    return this.#call("POST", "/messages/send", { raw, ...(threadId === null ? {} : { threadId }) });
  }

  sendDraft(draftId: string): Promise<{ id: string; threadId: string; labelIds?: string[] }> {
    return this.#call("POST", "/drafts/send", { id: draftId });
  }

  modifyMessage(id: string, change: { addLabelIds: string[]; removeLabelIds: string[] }): Promise<GmailMessageResource> {
    return this.#call<GmailMessageResource>("POST", `/messages/${encodeURIComponent(id)}/modify`, change);
  }

  trashMessage(id: string): Promise<GmailMessageResource> {
    return this.#call<GmailMessageResource>("POST", `/messages/${encodeURIComponent(id)}/trash`);
  }

  untrashMessage(id: string): Promise<GmailMessageResource> {
    return this.#call<GmailMessageResource>("POST", `/messages/${encodeURIComponent(id)}/untrash`);
  }

  listLabels(): Promise<GmailLabel[]> {
    return this.#call<{ labels?: GmailLabel[] }>("GET", "/labels").then((page) => page.labels ?? []);
  }

  async #call<T>(method: string, path: string, body?: unknown, retried = false): Promise<T> {
    const token = await this.#token(retried ? { fresh: true } : undefined);
    const response = await this.#fetch(`${this.#base}${path}`, {
      method,
      headers: {
        authorization: `Bearer ${token}`,
        accept: "application/json",
        ...(body === undefined ? {} : { "content-type": "application/json" }),
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    if (response.status === 401 && !retried) return this.#call<T>(method, path, body, true);
    if (!response.ok) {
      let detail = `Gmail answered ${String(response.status)}`;
      try {
        const envelope = (await response.json()) as GoogleErrorEnvelope;
        const message = envelope.error?.message;
        if (typeof message === "string" && message !== "") detail = message;
      } catch {
        // The status is all there is.
      }
      throw new GmailApiError(response.status, detail);
    }
    if (response.status === 204) return undefined as T;
    return (await response.json()) as T;
  }
}
