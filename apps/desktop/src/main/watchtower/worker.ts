import { Archive } from "@pistachio/watchtower";
import {
  watchtowerEligible,
  watchtowerRequestSchema,
  type WatchtowerCapture,
  type WatchtowerRegionRule,
  type WatchtowerResponse,
  type WatchtowerVisit,
} from "@pistachio/shell-contracts/watchtower";

interface Message {
  id: number;
  epoch: number;
  type:
    | "visit"
    | "title"
    | "ingest"
    | "request"
    | "epoch"
    | "shutdown"
    | "rules"
    | "learn";
  host?: string;
  rules?: WatchtowerRegionRule[];
  visit?: WatchtowerVisit;
  observationId?: string;
  at?: number;
  capture?: WatchtowerCapture;
  spaceId?: string;
  request?: unknown;
}
const port = process.parentPort;
if (!port) throw new Error("Watchtower must run in its utility process.");
if (process.argv[3] === "export") {
  const reader = new Archive(process.argv[2]!, { readOnly: true });
  try {
    const spaceId = process.argv[4]!;
    const exportPath = reader.export(spaceId, process.argv[5]!);
    port.postMessage({
      value: {
        exportPath,
        settings: reader.settings(),
        stats: reader.stats(spaceId),
      },
    });
  } catch (error) {
    port.postMessage({
      error: error instanceof Error ? error.message : "Export failed.",
    });
  } finally {
    reader.close();
  }
  process.exit(0);
}
const archive = new Archive(process.argv[2] ?? ":memory:");
archive.prune(archive.settings().retentionDays);
// Retention also advances on idle days with no new content captures.
setInterval(() => {
  try {
    archive.prune(archive.settings().retentionDays);
    port.postMessage({ full: !archive.hasRoom(), spaces: archive.spaces() });
  } catch {
    /* A request can report storage failures; browsing stays independent. */
  }
}, 3600000).unref();
let epoch = 0;
port.on("message", ({ data }: { data: Message }) => {
  const message = data;
  try {
    if (message.type === "shutdown") {
      archive.close();
      process.exit(0);
    }
    if (message.type === "epoch") {
      epoch = message.epoch;
      port.postMessage({ id: message.id, value: null });
      return;
    }
    // Layout verdicts: which regions of a site's pages are content. No page text.
    if (message.type === "rules" || message.type === "learn") {
      if (message.epoch !== epoch || !message.host) {
        port.postMessage({ id: message.id, value: { rules: [] } });
        return;
      }
      if (message.type === "learn") archive.learn(message.host, message.rules ?? []);
      port.postMessage({
        id: message.id,
        value: {
          rules: message.type === "rules" ? archive.rules(message.host) : [],
        },
      });
      return;
    }
    if (
      message.type === "visit" ||
      message.type === "title" ||
      message.type === "ingest"
    ) {
      if (
        message.epoch !== epoch ||
        !message.visit ||
        !watchtowerEligible(
          message.visit.url,
          message.visit.spaceId,
          archive.settings(),
        )
      ) {
        port.postMessage({ id: message.id, value: null });
        return;
      }
      if (message.type === "visit") archive.visit(message.visit);
      else if (message.type === "title") archive.updateTitle(message.visit);
      else if (message.capture && message.observationId && message.at)
        archive.ingest(
          message.visit,
          message.observationId,
          message.at,
          message.capture,
        );
      port.postMessage({
        id: message.id,
        value: null,
        full: !archive.hasRoom(),
        spaces: archive.spaces(),
      });
      return;
    }
    const spaceId = message.spaceId;
    if (!spaceId) throw new Error("A Space is required.");
    let result: Partial<WatchtowerResponse> = {};
    const request = watchtowerRequestSchema.parse(message.request);
    switch (request.type) {
      case "status":
        break;
      case "settings":
        archive.configure(request.patch);
        break;
      case "search":
        result.results = archive.search(
          spaceId,
          request.query,
          request.offset,
          request.enhance,
          request.limit,
        );
        break;
      case "read":
        result.document = archive.read(spaceId, request.observationId);
        break;
      case "diff":
        result.diff = archive.diff(spaceId, request.beforeId, request.afterId);
        break;
      case "forget":
        archive.forget(spaceId, request);
        break;
      case "export":
        throw new Error("Export needs a destination.");
    }
    result = {
      ...result,
      settings: archive.settings(),
      stats: archive.stats(spaceId),
    };
    port.postMessage({
      id: message.id,
      value: result,
      spaces: archive.spaces(),
    });
  } catch (error) {
    port.postMessage({
      id: message.id,
      code:
        error && typeof error === "object" && "code" in error
          ? error.code
          : undefined,
      error:
        error instanceof Error ? error.message : "Watchtower operation failed.",
    });
  }
});
port.postMessage({ ready: true });
