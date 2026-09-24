import { z } from "zod";

export const mediaStateSchema = z.object({
  id: z.number().int().positive(), source: z.string().max(16384), kind: z.enum(["video", "audio"]),
  visible: z.boolean(), mse: z.boolean(), unsupported: z.boolean(), paused: z.boolean(), time: z.number().nonnegative(),
  duration: z.number().nonnegative().nullable(), volume: z.number().min(0).max(1), muted: z.boolean(), rate: z.number().positive().max(16),
});
export type MediaState = z.infer<typeof mediaStateSchema>;
export const mediaActionSchema = z.discriminatedUnion("action", [
  z.object({ action: z.literal("play") }), z.object({ action: z.literal("pause") }),
  z.object({ action: z.literal("seek"), value: z.number().min(0).max(1e9) }),
  z.object({ action: z.literal("volume"), value: z.number().min(0).max(1) }),
  z.object({ action: z.literal("muted"), value: z.boolean() }),
  z.object({ action: z.literal("rate"), value: z.number().min(0.25).max(4) }),
]);
export type MediaAction = z.infer<typeof mediaActionSchema>;

export const mediaChunkSchema = z.object({
  seq: z.number().int().positive(), track: z.number().int().min(0).max(15),
  op: z.enum(["add", "append", "remove", "type", "end", "abort", "drop"]), mime: z.string().max(256).optional(),
  data: z.string().max(350000).optional(), end: z.boolean().optional(),
  mode: z.enum(["segments", "sequence"]).optional(), offset: z.number().optional(),
  start: z.number().nonnegative().optional(), stop: z.number().nonnegative().nullable().optional(),
});
export type MediaChunk = z.infer<typeof mediaChunkSchema>;
export const mediaBatchSchema = z.object({ source: z.string().max(128), failed: z.boolean(), chunks: z.array(mediaChunkSchema).max(8) });
export type MediaBatch = z.infer<typeof mediaBatchSchema>;
