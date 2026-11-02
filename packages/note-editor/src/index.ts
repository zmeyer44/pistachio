/**
 * `@pistachio/note-editor`: the editor's surface, free of any host
 * (docs/notes.md §5). A note is written the same way on the desktop, in the
 * web shell and on the account site because all three mount
 * `NoteBlockEditor` and answer the same `NoteEditorHost`.
 */

export { NoteBlockEditor, NOTE_EDITOR_PLACEHOLDER, type NoteBlockEditorHandle, type NoteBlockEditorProps } from "./NoteBlockEditor";
export { NoteTitle } from "./NoteTitle";
export { NoteHostProvider, openLinkElsewhere, useNoteHost, type NoteEditorHost } from "./host";
export { HtmlFrame, type HtmlFrameProps } from "./nodes/HtmlFrame";
/** The live node views, for another editor on the note schema (the desk's markdown file viewer). */
export { nodeViewOverrides as noteNodeViews } from "./nodes";
export { blobIdOf } from "./nodes/ImageView";
export { safeImageSrc } from "./image-src";
export { normalizeHref } from "./LinkPopover";
export { activeBlockType, BLOCK_TYPES, type BlockType } from "./block-types";
export {
  filterSlashCommands,
  SLASH_COMMANDS,
  SLASH_GROUPS,
  slashOpensMenu,
  slashQueryShowsMenu,
  type SlashCommand,
  type SlashCommandId,
  type SlashGroup,
  type SlashIcon,
} from "./slash";
export { FOCUS, NOTE_PANEL_CLASS } from "./parts";
