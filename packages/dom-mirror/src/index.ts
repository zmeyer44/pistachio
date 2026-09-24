export * from "./protocol.js";
export * from "./rewrite.js";
export * from "./assets.js";
export { createMirrorRenderer, mirrorDocumentSource, MIRROR_DOCUMENT_CSP } from "./renderer.js";
export type { MirrorRenderer, MirrorRendererOptions, MirrorSnapshotMessage, MirrorPatchMessage } from "./renderer.js";
export { installMirrorRecorder, mirrorRecorderSource } from "./recorder.js";
export type { RecorderConfig, RecorderControl } from "./recorder.js";

export { mirrorSurfaceSource, installMirrorSurface } from "./surface.js";
export type { HostToSurface, SurfaceToHost } from "./surface.js";

export { audioSurfaceSource } from "./audio-surface.js";
export type { AudioSurfaceReport } from "./audio-surface.js";
