import { CalendarDays, FileImage, FileJson, FileSpreadsheet, FileText, FileType2, Sheet } from "lucide-react";
import { DOC_MEDIA_TYPE, DOCX_MEDIA_TYPE, XLSX_MEDIA_TYPE } from "@pistachio/shell-contracts/desk-agent";
import { cn } from "../../../lib/cn";

/** What a file is, as its glyph tells it (its tint in shell.css: `.desk-file-glyph[data-kind]`). */
export function fileKindOf(mediaType: string): "pdf" | "image" | "word" | "sheet" | "markdown" | "calendar" | "json" | "text" {
  if (mediaType === "application/pdf") return "pdf";
  if (mediaType.startsWith("image/")) return "image";
  if (mediaType === DOCX_MEDIA_TYPE || mediaType === DOC_MEDIA_TYPE) return "word";
  if (mediaType === XLSX_MEDIA_TYPE || mediaType === "text/csv") return "sheet";
  if (mediaType === "text/markdown") return "markdown";
  if (mediaType === "text/calendar") return "calendar";
  if (mediaType === "application/json") return "json";
  return "text";
}

/** A file's kind in a word, for its window's frame and the Stack. */
export function fileKindLabel(mediaType: string, name: string): string {
  switch (fileKindOf(mediaType)) {
    case "pdf":
      return "PDF";
    case "image":
      return `${(name.split(".").pop() ?? "").toUpperCase() || "Picture"} image`;
    case "word":
      return mediaType === DOC_MEDIA_TYPE ? "Word 97–2004 document" : "Word document";
    case "sheet":
      return mediaType === "text/csv" ? "CSV" : "Excel workbook";
    case "markdown":
      return "Markdown";
    case "calendar":
      return "Calendar";
    case "json":
      return "JSON";
    default:
      return "Text";
  }
}

/** A file's glyph, tinted by its kind. */
export function FileGlyph({ mediaType, className }: { mediaType: string; className?: string }) {
  const kind = fileKindOf(mediaType);
  const Glyph =
    kind === "image"
      ? FileImage
      : kind === "sheet"
        ? mediaType === "text/csv"
          ? FileSpreadsheet
          : Sheet
        : kind === "calendar"
          ? CalendarDays
          : kind === "json"
            ? FileJson
            : kind === "word"
              ? FileType2
              : FileText;
  return (
    <span className={cn("desk-file-glyph", className)} data-kind={kind}>
      <Glyph aria-hidden="true" />
    </span>
  );
}
