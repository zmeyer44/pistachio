/**
 * Both server-side gateways can carry Gmail/Calendar data. Apply the
 * no-training routing restriction at the transport, including requests
 * made by older desktop clients, rather than relying on each AI feature.
 * A gateway with no eligible provider must refuse the call; never retry
 * without this restriction. This is not a zero-retention guarantee.
 */
export function gatewayPrivacyFetch(fetchImpl: typeof fetch = fetch): typeof fetch {
  return async (input, init) => {
    const request = new Request(input, init);
    if (request.method !== "POST") return fetchImpl(request);

    if (!request.headers.get("content-type")?.toLowerCase().includes("application/json")) {
      throw new Error("AI Gateway requests must use JSON to enforce the data policy.");
    }
    let body: unknown;
    try {
      body = await request.json();
    } catch {
      // JSON parser errors can quote the request's contents. Keep those
      // out of proxy errors and logs, which may contain Google user data.
      throw new Error("Invalid AI Gateway request body.");
    }
    if (!isRecord(body)) throw new Error("Invalid AI Gateway request body.");
    const options = body["providerOptions"] ?? {};
    if (!isRecord(options)) throw new Error("Invalid AI Gateway provider options.");
    const gateway = options["gateway"] ?? {};
    if (!isRecord(gateway)) throw new Error("Invalid AI Gateway routing options.");

    const headers = new Headers(request.headers);
    headers.delete("content-length");
    return fetchImpl(new Request(request, {
      headers,
      body: JSON.stringify({
        ...body,
        providerOptions: {
          ...options,
          gateway: { ...gateway, disallowPromptTraining: true },
        },
      }),
    }));
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
