import { Archive } from "@pistachio/watchtower";
import {
  watchtowerEligible,
  watchtowerRequestSchema,
  type WatchtowerCapture,
  type WatchtowerEntityDecision,
  type WatchtowerFactKind,
  type WatchtowerIndexJob,
  type WatchtowerRegionRule,
  type WatchtowerResponse,
  type WatchtowerSavedEntity,
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
    | "learn"
    | "index-next"
    | "index"
    | "keep"
    | "file-prepare"
    | "kept";
  host?: string;
  /** `index`: the job `index-next` handed out, and what was decided about it. */
  job?: WatchtowerIndexJob;
  decisions?: (WatchtowerEntityDecision | null)[];
  facts?: (WatchtowerFactKind | null)[];
  /** `index` at level 3: a deliberate save's reading, merged in. */
  level?: 2 | 3;
  keptKey?: string;
  keptKeys?: string[];
  snapshotId?: number;
  entities?: WatchtowerSavedEntity[];
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
// Versions saved before the index existed are filed locally, a few at a
// time, whether or not the decision model is ever allowed to read them.
const backlog = setInterval(() => {
  try {
    if (archive.index.backlog() === 0) clearInterval(backlog);
  } catch {
    /* the index is derived; the archive keeps working without it */
  }
}, 5000);
backlog.unref();
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
    // The index: which saved version the decision model reads next, and
    // what it decided. A job from before a policy change is not applied.
    if (message.type === "index-next" || message.type === "index") {
      let job: WatchtowerIndexJob | null = null;
      let about: ReturnType<typeof archive.index.about> | undefined;
      if (message.epoch === epoch) {
        if (message.type === "index-next") job = archive.index.next();
        else if (message.job) {
          const saved = message.level === 3;
          archive.index.apply(message.job, message.decisions ?? [], message.facts ?? [], saved ? 3 : 2, { merge: saved });
          if (saved) about = archive.index.about(message.job.snapshotId);
        }
      }
      port.postMessage({ id: message.id, value: { job, about } });
      return;
    }
    // A deliberate save (shift, shift): this page, now, whatever passive
    // capture is set to — but never an excluded site or Space.
    if (message.type === "keep") {
      const settings = archive.settings();
      const visit = message.visit;
      const kept =
        message.epoch === epoch &&
        visit &&
        message.capture &&
        message.observationId &&
        message.at &&
        message.keptKey &&
        watchtowerEligible(visit.url, visit.spaceId, { ...settings, enabled: true, paused: false })
          ? archive.keep(visit, message.observationId, message.at, message.capture, message.keptKey)
          : null;
      port.postMessage({ id: message.id, value: { kept }, full: !archive.hasRoom(), spaces: archive.spaces() });
      return;
    }
    if (message.type === "file-prepare") {
      const prepared =
        message.epoch === epoch && message.snapshotId !== undefined && message.observationId && message.spaceId
          ? archive.index.prepareSaved(message.snapshotId, message.entities ?? [], {
              observationId: message.observationId,
              spaceId: message.spaceId,
            })
          : null;
      port.postMessage({ id: message.id, value: { prepared } });
      return;
    }
    if (message.type === "kept") {
      if (message.observationId && message.keptKey) archive.rekeep(message.observationId, message.keptKey);
      else archive.setKept(message.keptKeys ?? []);
      port.postMessage({ id: message.id, value: null });
      return;
    }
    const spaceId = message.spaceId;
    if (!spaceId) throw new Error("A Profile is required.");
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
      case "entities":
        result.index = archive.index.list(spaceId, request);
        break;
      case "entity":
        result.entity = archive.index.read(spaceId, request.entityId);
        break;
      case "about":
        result.about = archive.about(spaceId, request.url);
        break;
      case "entity-edit": {
        const kept = archive.index.edit(spaceId, request);
        if (kept !== null) result.entity = archive.index.read(spaceId, kept);
        break;
      }
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
