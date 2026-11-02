/**
 * `@pistachio/notes`: a note's document, shared by everything that touches
 * one (docs/notes.md §2). HTML is the canonical body; this package is the
 * schema that says what that HTML may hold, the conversions in and out of
 * markdown and JSON that run with or without a browser, the one structural
 * edit the agent makes, a note's plain text, and the self-contained page a
 * note is published as.
 */

export {
  CodeBlock,
  CODE_BLOCK_OPTIONS,
  DEFAULT_PLACEHOLDER,
  noteExtensions,
  noteSchema,
  type NoteExtensionOptions,
} from "./schema.js";
// The image node the schema configures, for the editor to hang a node view on.
export { Image } from "@tiptap/extension-image";
export { Callout, CALLOUT_EMOJI_PRESETS, DEFAULT_CALLOUT_EMOJI } from "./nodes/callout.js";
export { Toggle, ToggleContent, ToggleSummary } from "./nodes/toggle.js";
export { Embed, EMBED_ALLOW, EMBED_SANDBOX, resolveEmbed, sanitizeEmbedSrc, type EmbedProvider, type EmbedTarget } from "./nodes/embed.js";
export {
  buildHtmlBlockDocument,
  fence,
  HTML_BLOCK_HEIGHT_MESSAGE,
  HTML_BLOCK_SANDBOX,
  HTML_BLOCK_TOKENS,
  HtmlBlock,
  isLiveHtmlFence,
  LIVE_HTML_FENCE_INFO,
} from "./nodes/html-block.js";
export { NotePlaceholder, placeholderFor } from "./placeholder.js";
export { BlockShortcuts, duplicateBlock, HeadingBackspace, KeepTabInEditor, movableDepth, moveBlock, NoteListKeymap } from "./keymap.js";
export { PastePolicy } from "./paste.js";
export { docToHtml, htmlToDoc, htmlToJson, jsonToDoc, jsonToHtml, normalizeNoteHtml } from "./dom.js";
export { htmlToMarkdown, jsonToMarkdown, looksLikeMarkdown, markdownToDoc, markdownToHtml, markdownToJson } from "./markdown.js";
export { applyNoteEdit, type NoteEdit, type NoteEditMode, type NoteEditResult } from "./edit.js";
export { jsonToPlainText, noteToPlainText, noteWordCount } from "./text.js";
export { completeNote, completeNoteBody, type NoteBody } from "./complete.js";
export { NOTE_PAGE_SCRIPT, renderNoteBody, renderNoteHtml, type RenderableBlob, type RenderableNote, type RenderNoteOptions } from "./publish.js";
export { NOTE_STYLESHEET } from "./styles.js";
export { HTML_BLOCK_FRAME_CSP, NOTE_PAGE_CSP, NOTE_PAGE_META_CSP } from "./csp.js";
