/**
 * Live share of a space (docs/live-share.md): the pure parts both ends and
 * Electron main share — the protocol, the desk geometry, input mapping, ink,
 * cursor smoothing and rate limiting. Nothing here touches livekit-client,
 * React or the DOM at import time; the room is `@pistachio/live-share/room`,
 * camera effects `@pistachio/live-share/effects`.
 */

export * from "./protocol.js";
export * from "./geometry.js";
export * from "./input.js";
export * from "./ink.js";
export * from "./cursor.js";
export * from "./rate.js";
