import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { Files, Folder, ImageIcon } from "lucide-react";
import { fileViewerKind, groupContextMediaTypeOf } from "@pistachio/shell-contracts/desk-agent";
import type { TabGroupInfo } from "@pistachio/shell-contracts/tab-groups";
import { nativeApi } from "../../api";
import { addContextFiles } from "../../lib/desk/group-context";
import { carriesFiles, useDeskFileDrag } from "../../lib/desk/file-drag";
import { documentShare, fileWindowId } from "../../lib/desk/windows";
import { useAppStore } from "../../store";
import type { DeskEngine, DeskView } from "./desk-engine";

/** A page said files are over it: the shell waits this long for the drag to come to it once the page gives way. */
const ARMED_MS = 1_500;
/** No drag event over the shell for this long: the drag has left the window (or was called off). */
const QUIET_MS = 450;
/** Each file dropped after the first comes out this much further along. */
const CASCADE = 28;

/**
 * The desk's drop target for files from outside the app (docs/desk-documents.md
 * §1): while files are dragged over the desk, the workspace itself is a
 * target — let go there, and each file joins the group's context (the
 * Stack) and comes out as a window where it was let go. The Bar stays the
 * target for attaching to the message, and the Stack for keeping a file
 * without opening it; each says so as the drag comes over it.
 *
 * The drag comes to the shell only where the shell is drawn: over a live
 * page it is the page's. A desk page tells main when files come over it
 * (DeskPageInput "fileDrag"), and the zone goes up then too — a cover, so
 * the pages under it give way to their stills and the drag comes here.
 */
export function DeskDropZone({ group, engine, view }: { group: TabGroupInfo; engine: DeskEngine; view: DeskView }) {
  const [state, setState] = useState<"idle" | "armed" | "over">("idle");
  const [inside, setInside] = useState(false);
  const setActive = useDeskFileDrag((store) => store.set);
  const quiet = useRef(0);
  const zoneRef = useRef<HTMLDivElement>(null);
  const insideDepth = useRef(0);
  const up = state !== "idle";
  const shown = up && view.clearCovers.has("file-drop");

  // Files over the shell's desk: its drag events, anywhere on the window.
  useEffect(() => {
    const stillOver = (): void => {
      window.clearTimeout(quiet.current);
      quiet.current = window.setTimeout(() => {
        setState("idle");
        insideDepth.current = 0;
        setInside(false);
      }, QUIET_MS);
    };
    const onEnter = (event: DragEvent): void => {
      if (!carriesFiles(event.dataTransfer)) return;
      setState("over");
      stillOver();
    };
    const onOver = (event: DragEvent): void => {
      if (!carriesFiles(event.dataTransfer)) return;
      setState("over");
      stillOver();
    };
    const onEnd = (): void => {
      window.clearTimeout(quiet.current);
      setState("idle");
      insideDepth.current = 0;
      setInside(false);
    };
    window.addEventListener("dragenter", onEnter, true);
    window.addEventListener("dragover", onOver, true);
    window.addEventListener("drop", onEnd, true);
    window.addEventListener("dragend", onEnd, true);
    // Files over a desk page: the zone goes up, the pages give way, and the drag comes here.
    const offPage = nativeApi()?.onDeskPageInput((input) => {
      if (input !== "fileDrag") return;
      setState((current) => (current === "idle" ? "armed" : current));
      window.clearTimeout(quiet.current);
      quiet.current = window.setTimeout(onEnd, ARMED_MS);
    });
    return () => {
      window.removeEventListener("dragenter", onEnter, true);
      window.removeEventListener("dragover", onOver, true);
      window.removeEventListener("drop", onEnd, true);
      window.removeEventListener("dragend", onEnd, true);
      window.clearTimeout(quiet.current);
      offPage?.();
    };
  }, []);

  useEffect(() => {
    setActive(up);
    return () => setActive(false);
  }, [setActive, up]);

  // Up, the whole stage is a cover: every live page gives way, so the drag is the shell's wherever it goes.
  useLayoutEffect(() => {
    const zone = zoneRef.current;
    const stage = zone?.parentElement ?? null;
    if (!up || stage === null) {
      engine.setCover("file-drop", null);
      return;
    }
    engine.setCover("file-drop", { x: 0, y: 0, w: stage.clientWidth, h: stage.clientHeight });
    return () => engine.setCover("file-drop", null);
  }, [engine, up]);

  const onDrop = (event: React.DragEvent): void => {
    if (!carriesFiles(event.dataTransfer)) return;
    event.preventDefault();
    const files = [...event.dataTransfer.files];
    const at = { x: event.clientX, y: event.clientY };
    insideDepth.current = 0;
    setInside(false);
    void addContextFiles(group.id, group.title, files).then(
      (result) => {
        const store = useAppStore.getState();
        if (result.rejected.length > 0) store.showNotice(result.rejected.map((entry) => `${entry.name}: ${entry.reason}`).join(" · "), { tone: "warning" });
        (result.added ?? []).forEach((added, index) => {
          const file = files.find((candidate) => candidate.name === added.name) ?? files[index];
          const mediaType = file === undefined ? null : groupContextMediaTypeOf(file.name, file.type);
          const viewer = mediaType === null ? null : fileViewerKind(mediaType);
          engine.openAt(fileWindowId(added.id), { x: at.x + index * CASCADE, y: at.y + index * CASCADE }, documentShare(viewer));
        });
      },
      () => useAppStore.getState().showNotice("Those files could not be added to the desk", { tone: "warning" }),
    );
  };

  return (
    <div
      ref={zoneRef}
      className="desk-drop-zone"
      data-testid="desk-drop-zone"
      data-up={up ? "" : undefined}
      data-shown={shown ? "" : undefined}
      data-inside={inside ? "" : undefined}
      aria-hidden={!up}
      onDragEnter={(event) => {
        if (!carriesFiles(event.dataTransfer)) return;
        event.preventDefault();
        insideDepth.current += 1;
        setInside(true);
      }}
      onDragOver={(event) => {
        if (!carriesFiles(event.dataTransfer)) return;
        event.preventDefault();
        event.dataTransfer.dropEffect = "copy";
      }}
      onDragLeave={() => {
        insideDepth.current = Math.max(0, insideDepth.current - 1);
        if (insideDepth.current === 0) setInside(false);
      }}
      onDrop={onDrop}
    >
      <div className="desk-drop-zone-frame" aria-hidden="true" />
      {/* A picture, the files and a folder rise out of the frosted workspace one after another, as claude.ai's do. */}
      <div className="desk-drop-zone-mark">
        <span className="desk-drop-zone-icons" aria-hidden="true">
          <ImageIcon data-icon="image" />
          <Files data-icon="files" />
          <Folder data-icon="folder" />
        </span>
        <span className="desk-drop-zone-title">Drop to open on the desk</span>
        <span className="desk-drop-zone-hint">It joins this space’s context — @mention it in the Bar</span>
      </div>
    </div>
  );
}
