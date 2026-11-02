/**
 * The editor's variants of the shared schema nodes: the same parse and
 * render rules, plus interactive node views. Swapped in by name through
 * `noteExtensions({ overrides })`.
 */

import { Callout, CODE_BLOCK_OPTIONS, CodeBlock, Embed, HtmlBlock, Image, Toggle, ToggleContent } from "@pistachio/notes";
import type { AnyExtension } from "@tiptap/core";
import { ReactNodeViewRenderer } from "@tiptap/react";
import { ImageView } from "./ImageView";
import { CalloutView } from "./CalloutView";
import { CodeBlockView } from "./CodeBlockView";
import { EmbedView } from "./EmbedView";
import { HtmlBlockView } from "./HtmlBlockView";
import { ToggleView } from "./ToggleView";

export const nodeViewOverrides: AnyExtension[] = [
  CodeBlock.extend({ addNodeView: () => ReactNodeViewRenderer(CodeBlockView) }).configure(CODE_BLOCK_OPTIONS),
  Callout.extend({ addNodeView: () => ReactNodeViewRenderer(CalloutView) }),
  Embed.extend({ addNodeView: () => ReactNodeViewRenderer(EmbedView) }),
  HtmlBlock.extend({ addNodeView: () => ReactNodeViewRenderer(HtmlBlockView) }),
  Toggle.extend({ addNodeView: () => ReactNodeViewRenderer(ToggleView) }),
  // Visibility is CSS-driven from the toggle's open state, so the stock
  // content node view (which flips `hidden` imperatively) is dropped.
  ToggleContent.extend({ addNodeView: () => null }),
  // A note's own picture is `note-blob:<id>` (N3), resolved through the host; a web address is shown from where it is.
  Image.extend({ addNodeView: () => ReactNodeViewRenderer(ImageView) }).configure({ inline: false, allowBase64: false }),
];
