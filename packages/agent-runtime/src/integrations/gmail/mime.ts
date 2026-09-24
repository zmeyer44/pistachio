/**
 * Gmail's wire shapes, read and written: a `Message` resource unpacked into
 * the headers and text the agent reads, and an RFC 5322 message assembled
 * for a draft or a send. Pure functions over JSON and strings.
 */

/* ------------------------------ the resource ----------------------------- */

export interface GmailHeader {
  name: string;
  value: string;
}

export interface GmailMessagePart {
  partId?: string;
  mimeType?: string;
  filename?: string;
  headers?: GmailHeader[];
  body?: { size?: number; data?: string; attachmentId?: string };
  parts?: GmailMessagePart[];
}

/** `users.messages.get` with `format=full` (or `metadata`, when `payload.body` and `parts` are absent). */
export interface GmailMessageResource {
  id: string;
  threadId: string;
  labelIds?: string[];
  snippet?: string;
  /** Epoch milliseconds as a string. */
  internalDate?: string;
  sizeEstimate?: number;
  payload?: GmailMessagePart;
}

export interface GmailThreadResource {
  id: string;
  messages?: GmailMessageResource[];
}

/* ------------------------------ reading ---------------------------------- */

export interface GmailAttachmentInfo {
  filename: string;
  mimeType: string;
  size: number;
}

/** A message as the agent sees it: addresses, subject, labels, and readable text. */
export interface GmailMessageView {
  id: string;
  threadId: string;
  /** ISO instant, from Gmail's own receipt time. */
  date: string | null;
  from: string;
  to: string;
  cc: string;
  subject: string;
  snippet: string;
  labels: string[];
  unread: boolean;
  /** The message body as plain text; empty when the message has no readable part. */
  body: string;
  /** Whether `body` was cut to the cap. */
  truncated: boolean;
  attachments: GmailAttachmentInfo[];
  /** Where to open it in Gmail. */
  webUrl: string;
}

export const MAX_MESSAGE_BODY_CHARS = 16_000;

export function gmailMessageUrl(id: string): string {
  return `https://mail.google.com/mail/u/0/#all/${encodeURIComponent(id)}`;
}

export function gmailDraftUrl(messageId: string): string {
  return `https://mail.google.com/mail/u/0/#drafts/${encodeURIComponent(messageId)}`;
}

export function header(part: GmailMessagePart | undefined, name: string): string {
  const wanted = name.toLowerCase();
  return part?.headers?.find((entry) => entry.name.toLowerCase() === wanted)?.value ?? "";
}

export function decodeBase64Url(data: string): string {
  return Buffer.from(data, "base64url").toString("utf8");
}

/** The named entities mail actually uses; numeric references cover the rest. */
const ENTITIES: Record<string, string> = {
  amp: "&",
  lt: "<",
  gt: ">",
  quot: '"',
  apos: "'",
  nbsp: " ",
  copy: "©",
  reg: "®",
  trade: "™",
  mdash: "—",
  ndash: "–",
  hellip: "…",
  lsquo: "‘",
  rsquo: "’",
  ldquo: "“",
  rdquo: "”",
  bull: "•",
  middot: "·",
  euro: "€",
  pound: "£",
  yen: "¥",
  deg: "°",
  times: "×",
  laquo: "«",
  raquo: "»",
  zwnj: "",
  zwj: "",
  shy: "",
};

function decodeEntities(text: string): string {
  return text.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/giu, (whole, entity: string) => {
    const lower = entity.toLowerCase();
    if (lower.startsWith("#x")) {
      const code = Number.parseInt(lower.slice(2), 16);
      return Number.isFinite(code) ? String.fromCodePoint(code) : whole;
    }
    if (lower.startsWith("#")) {
      const code = Number.parseInt(lower.slice(1), 10);
      return Number.isFinite(code) ? String.fromCodePoint(code) : whole;
    }
    return ENTITIES[lower] ?? whole;
  });
}

/**
 * HTML mail as text: block elements become line breaks, links keep their
 * address in brackets, everything else loses its tags. Good enough to read
 * a newsletter or a reply chain; never rendered back to a page.
 */
export function htmlToText(html: string): string {
  let text = html
    .replace(/<!--[\s\S]*?-->/gu, "")
    .replace(/<(script|style|head|title)\b[^>]*>[\s\S]*?<\/\1>/giu, "")
    .replace(/<br\s*\/?>/giu, "\n")
    .replace(/<\/(p|div|tr|li|h[1-6]|blockquote|pre|table|section|article|header|footer)>/giu, "\n")
    .replace(/<(li)\b[^>]*>/giu, "• ")
    .replace(/<a\b[^>]*href\s*=\s*"([^"]*)"[^>]*>([\s\S]*?)<\/a>/giu, (_whole, href: string, label: string) => {
      const inner = label.replace(/<[^>]+>/gu, "").trim();
      if (inner === "" || href === "" || href.startsWith("#")) return inner;
      return inner === href ? inner : `${inner} [${href}]`;
    })
    .replace(/<[^>]+>/gu, "");
  text = decodeEntities(text);
  return text
    .replace(/\r/gu, "")
    .replace(/[ \t]+\n/gu, "\n")
    .replace(/\n{3,}/gu, "\n\n")
    .replace(/[ \t]{2,}/gu, " ")
    .trim();
}

function walk(part: GmailMessagePart | undefined, visit: (part: GmailMessagePart) => void): void {
  if (part === undefined) return;
  visit(part);
  for (const child of part.parts ?? []) walk(child, visit);
}

/** The readable text of a message: its first text/plain part, else its HTML rendered as text. */
export function messageText(payload: GmailMessagePart | undefined): string {
  let plain: string | null = null;
  let html: string | null = null;
  walk(payload, (part) => {
    const mime = (part.mimeType ?? "").toLowerCase();
    const data = part.body?.data;
    if (data === undefined || (part.filename ?? "") !== "") return;
    if (mime === "text/plain" && plain === null) plain = decodeBase64Url(data);
    else if (mime === "text/html" && html === null) html = decodeBase64Url(data);
  });
  if (plain !== null && (plain as string).trim() !== "") return (plain as string).replace(/\r\n/gu, "\n").trim();
  if (html !== null) return htmlToText(html);
  return "";
}

export function messageAttachments(payload: GmailMessagePart | undefined): GmailAttachmentInfo[] {
  const found: GmailAttachmentInfo[] = [];
  walk(payload, (part) => {
    const filename = part.filename ?? "";
    if (filename === "") return;
    found.push({ filename, mimeType: part.mimeType ?? "application/octet-stream", size: part.body?.size ?? 0 });
  });
  return found;
}

function clip(text: string, max: number): { text: string; truncated: boolean } {
  if (text.length <= max) return { text, truncated: false };
  return { text: `${text.slice(0, max).trimEnd()}\n…[truncated]`, truncated: true };
}

/** A `Message` resource as the agent reads it. */
export function messageView(resource: GmailMessageResource, options: { maxBodyChars?: number } = {}): GmailMessageView {
  const payload = resource.payload;
  const labels = resource.labelIds ?? [];
  const at = resource.internalDate === undefined ? Number.NaN : Number.parseInt(resource.internalDate, 10);
  const body = clip(messageText(payload), options.maxBodyChars ?? MAX_MESSAGE_BODY_CHARS);
  return {
    id: resource.id,
    threadId: resource.threadId,
    date: Number.isFinite(at) ? new Date(at).toISOString() : null,
    from: header(payload, "From"),
    to: header(payload, "To"),
    cc: header(payload, "Cc"),
    subject: header(payload, "Subject"),
    snippet: htmlToText(resource.snippet ?? ""),
    labels,
    unread: labels.includes("UNREAD"),
    body: body.text,
    truncated: body.truncated,
    attachments: messageAttachments(payload),
    webUrl: gmailMessageUrl(resource.id),
  };
}

/** The headers a reply needs from the message it answers. */
export interface ReplyContext {
  threadId: string;
  subject: string;
  messageId: string;
  references: string;
  /** Where a reply goes: the Reply-To address, else the sender. */
  replyTo: string;
  from: string;
  to: string;
  cc: string;
}

export function replyContext(resource: GmailMessageResource): ReplyContext {
  const payload = resource.payload;
  const replyTo = header(payload, "Reply-To");
  return {
    threadId: resource.threadId,
    subject: header(payload, "Subject"),
    messageId: header(payload, "Message-ID") || header(payload, "Message-Id"),
    references: header(payload, "References"),
    replyTo: replyTo === "" ? header(payload, "From") : replyTo,
    from: header(payload, "From"),
    to: header(payload, "To"),
    cc: header(payload, "Cc"),
  };
}

/** "Re: Subject", once. */
export function replySubject(subject: string): string {
  const trimmed = subject.trim();
  return /^re:/iu.test(trimmed) ? trimmed : `Re: ${trimmed}`;
}

/* ------------------------------ writing ---------------------------------- */

/** One recipient: an address, with the name the person would see beside it. */
export interface Mailbox {
  /** The addr-spec: `local@domain`, no brackets. */
  address: string;
  /** The display name, unquoted; empty when the address stands alone. */
  name: string;
}

export interface OutgoingMessage {
  from: Mailbox;
  to: Mailbox[];
  cc: Mailbox[];
  bcc: Mailbox[];
  subject: string;
  /** Plain text. */
  body: string;
  /** Present on a reply: what threads it. */
  inReplyTo?: string;
  references?: string;
}

/** Anything a header must never contain: CR, LF, and every other control character. */
// eslint-disable-next-line no-control-regex
const HEADER_CONTROL_RE = /[\u0000-\u001f\u007f]/u;

/** A syntactically plausible addr-spec: one `@`, a non-empty local part, a dotted domain with no spaces or brackets. */
const ADDR_SPEC_RE = /^[^\s@<>()[\],;:"\\]+@[A-Za-z0-9](?:[A-Za-z0-9-]*[A-Za-z0-9])?(?:\.[A-Za-z0-9](?:[A-Za-z0-9-]*[A-Za-z0-9])?)+$/u;

/** An RFC 2047 encoded word when the text is not plain ASCII. */
export function encodeHeaderText(text: string): string {
  if (/^[ -~]*$/u.test(text)) return text;
  return `=?utf-8?B?${Buffer.from(text, "utf8").toString("base64")}?=`;
}

/** Header text with any line break or control character folded to a space, so nothing can start a new header. */
export function headerText(text: string): string {
  // eslint-disable-next-line no-control-regex
  return text.replace(/[\u0000-\u001f\u007f]+/gu, " ").trim();
}

/**
 * Split a mailbox list on its separators — commas and semicolons — but not
 * inside a quoted display name or angle brackets, so `"Doe, Jane" <jane@x>`
 * is one mailbox. Empty items are dropped.
 */
function splitMailboxList(value: string): string[] {
  const items: string[] = [];
  let current = "";
  let quoted = false;
  let bracketed = false;
  for (let index = 0; index < value.length; index += 1) {
    const char = value[index]!;
    if (quoted) {
      current += char;
      if (char === "\\" && index + 1 < value.length) {
        index += 1;
        current += value[index]!;
      } else if (char === '"') quoted = false;
      continue;
    }
    if (char === '"') {
      quoted = true;
      current += char;
    } else if (char === "<") {
      bracketed = true;
      current += char;
    } else if (char === ">") {
      bracketed = false;
      current += char;
    } else if ((char === "," || char === ";") && !bracketed) {
      items.push(current);
      current = "";
    } else current += char;
  }
  items.push(current);
  return items.map((item) => item.trim()).filter((item) => item !== "");
}

/**
 * One mailbox from its written form: a bare address, `Name <address>`, or
 * `"Quoted, Name" <address>`. Throws in words the model can act on when the
 * text is not a mailbox — and, before anything else, when it carries a
 * line break or control character, since a display name that reaches the
 * wire unchecked could otherwise smuggle a header of its own.
 */
export function parseMailbox(text: string): Mailbox {
  const raw = text.trim();
  if (HEADER_CONTROL_RE.test(raw)) throw new Error(`a recipient contains a line break or control character: ${JSON.stringify(raw)}`);
  const angled = /^(.*?)\s*<([^<>]*)>\s*$/u.exec(raw);
  let name = "";
  let address = raw;
  if (angled !== null) {
    name = angled[1]!.trim();
    address = angled[2]!.trim();
    const quoted = /^"((?:[^"\\]|\\.)*)"$/u.exec(name);
    if (quoted !== null) name = quoted[1]!.replace(/\\(.)/gu, "$1");
    // An unquoted name is a phrase of atoms: none of RFC 5322's specials,
    // which is what tells `a@x.com <b@y.com>` apart from a real name.
    else if (/[()<>@,;:\\"[\]]/u.test(name)) throw new Error(`a recipient's name is malformed: ${raw}`);
  } else if (/["<>]/u.test(raw)) {
    throw new Error(`a recipient is malformed: ${raw}`);
  }
  if (!ADDR_SPEC_RE.test(address)) throw new Error(`not an email address: ${address === "" ? raw : address}`);
  return { address, name };
}

/** A whole mailbox list — a string, a list of strings, or nothing — as parsed mailboxes. Throws on the first bad one. */
export function parseMailboxes(value: string | readonly string[] | null | undefined): Mailbox[] {
  if (value === null || value === undefined) return [];
  const items = typeof value === "string" ? splitMailboxList(value) : value.flatMap(splitMailboxList);
  return items.map(parseMailbox);
}

/** Whether a name can ride unquoted: RFC 5322 atext plus spaces. */
const ATOM_NAME_RE = /^[A-Za-z0-9!#$%&'*+/=?^_`{|}~ .-]*$/u;

/**
 * A mailbox on the wire. A name that is not plain atoms is quoted (with
 * its quotes and backslashes escaped), and a non-ASCII name becomes an
 * encoded word — which is itself atom-safe, so never quoted.
 */
export function formatMailbox(mailbox: Mailbox): string {
  const name = headerText(mailbox.name);
  if (name === "") return mailbox.address;
  const encoded = encodeHeaderText(name);
  if (encoded !== name) return `${encoded} <${mailbox.address}>`;
  if (ATOM_NAME_RE.test(name)) return `${name} <${mailbox.address}>`;
  return `"${name.replace(/["\\]/gu, "\\$&")}" <${mailbox.address}>`;
}

function formatMailboxes(mailboxes: readonly Mailbox[]): string {
  return mailboxes.map(formatMailbox).join(", ");
}

function wrapBase64(encoded: string): string {
  return encoded.replace(/(.{76})/gu, "$1\r\n");
}

/** A message id header value: the id itself, or nothing when it would not be one. */
function messageIdHeader(value: string | undefined): string | null {
  if (value === undefined) return null;
  const trimmed = headerText(value);
  return trimmed === "" ? null : trimmed;
}

/** The raw message, base64url-encoded the way `messages.send` and `drafts.create` take it. */
export function buildRawMessage(message: OutgoingMessage, now: () => Date = () => new Date()): string {
  const lines: string[] = [
    `From: ${formatMailbox(message.from)}`,
    `To: ${formatMailboxes(message.to)}`,
  ];
  if (message.cc.length > 0) lines.push(`Cc: ${formatMailboxes(message.cc)}`);
  if (message.bcc.length > 0) lines.push(`Bcc: ${formatMailboxes(message.bcc)}`);
  lines.push(`Subject: ${encodeHeaderText(headerText(message.subject))}`);
  lines.push(`Date: ${now().toUTCString()}`);
  const inReplyTo = messageIdHeader(message.inReplyTo);
  if (inReplyTo !== null) {
    const references = messageIdHeader(message.references);
    lines.push(`In-Reply-To: ${inReplyTo}`);
    lines.push(`References: ${references === null ? inReplyTo : `${references} ${inReplyTo}`}`);
  }
  lines.push("MIME-Version: 1.0");
  lines.push("Content-Type: text/plain; charset=utf-8");
  lines.push("Content-Transfer-Encoding: base64");
  lines.push("");
  lines.push(wrapBase64(Buffer.from(message.body.replace(/\r?\n/gu, "\r\n"), "utf8").toString("base64")));
  return Buffer.from(lines.join("\r\n"), "utf8").toString("base64url");
}
