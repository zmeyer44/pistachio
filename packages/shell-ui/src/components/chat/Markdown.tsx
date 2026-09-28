import { memo, useEffect, useMemo, useState, type MouseEvent, type ReactNode } from "react";
import { Check, Copy } from "lucide-react";
import { cn } from "../../lib/cn";
import { citedSource, type CitedSource } from "../../lib/chat-sources";
import { parseMarkdown, plainText, words, type MarkdownToken, type MarkdownTokens } from "../../lib/markdown";
import { useAppStore } from "../../store";
import { SourceChip } from "./Sources";

/**
 * A reply, drawn from its Markdown (lib/markdown.ts) as elements rather
 * than as HTML: every token becomes a component here, so the model's text
 * can never become markup. Shared by the sidebar console and the home
 * page's chat, which differ only in `density`.
 *
 * Links go where the console's links go (MessageText): a click previews
 * the page as a Glance beside the conversation, ⌘-click opens a tab, and
 * a full-window surface (`links="tab"`) opens a tab for every click. A
 * link to a page the turn READ draws as a citation chip — the site's mark
 * and host — instead of as a run of underlined address.
 *
 * `streaming` marks a reply still being written: each word that lands is
 * wrapped so it can resolve into place (shell.css `chat-word`), and a
 * fence the text has not closed yet still draws as code.
 */
export const Markdown = memo(function Markdown({
  text,
  streaming = false,
  sources = NO_SOURCES,
  links = "glance",
  density = "page",
  className,
}: {
  text: string;
  streaming?: boolean;
  sources?: readonly CitedSource[];
  links?: "glance" | "tab";
  density?: "page" | "panel";
  className?: string;
}) {
  const tokens = useMemo(() => parseMarkdown(text), [text]);
  const context = useMemo<RenderContext>(() => ({ streaming, sources, links, density }), [streaming, sources, links, density]);
  return (
    <div
      data-testid="markdown"
      data-streaming={streaming ? "" : undefined}
      className={cn("chat-markdown min-w-0 wrap-anywhere select-text", density === "panel" ? "chat-markdown-panel" : "chat-markdown-page", className)}
    >
      {renderBlocks(tokens, context)}
    </div>
  );
});

const NO_SOURCES: readonly CitedSource[] = [];

interface RenderContext {
  streaming: boolean;
  sources: readonly CitedSource[];
  links: "glance" | "tab";
  density: "page" | "panel";
}

function renderBlocks(tokens: readonly MarkdownToken[], context: RenderContext): ReactNode[] {
  const out: ReactNode[] = [];
  tokens.forEach((token, index) => {
    const node = renderBlock(token, context, index);
    if (node !== null) out.push(node);
  });
  return out;
}

function renderBlock(token: MarkdownToken, context: RenderContext, key: number): ReactNode {
  switch (token.type) {
    case "space":
      return null;
    case "paragraph":
      return <p key={key}>{renderInline((token as MarkdownTokens.Paragraph).tokens, context)}</p>;
    case "heading": {
      const heading = token as MarkdownTokens.Heading;
      const Tag = (`h${String(Math.min(6, Math.max(1, heading.depth)))}`) as "h1" | "h2" | "h3" | "h4" | "h5" | "h6";
      return <Tag key={key}>{renderInline(heading.tokens, context)}</Tag>;
    }
    case "list": {
      const list = token as MarkdownTokens.List;
      const items = list.items.map((item, index) => (
        <li key={index} className={item.task ? "chat-task" : undefined}>
          {item.task ? (
            <input type="checkbox" checked={item.checked === true} readOnly tabIndex={-1} aria-label={item.checked === true ? "Done" : "To do"} />
          ) : null}
          {renderListItem(item.tokens, context)}
        </li>
      ));
      return list.ordered ? (
        <ol key={key} start={typeof list.start === "number" ? list.start : undefined}>
          {items}
        </ol>
      ) : (
        <ul key={key}>{items}</ul>
      );
    }
    case "code":
      return <CodeBlock key={key} code={token as MarkdownTokens.Code} />;
    case "blockquote":
      return <blockquote key={key}>{renderBlocks((token as MarkdownTokens.Blockquote).tokens, context)}</blockquote>;
    case "table":
      return <Table key={key} table={token as MarkdownTokens.Table} context={context} />;
    case "hr":
      return <hr key={key} />;
    case "html":
      // Raw HTML is drawn as the text it is: the model does not write markup here.
      return <p key={key}>{token.raw}</p>;
    case "text": {
      // A loose text block (marked hands one back for text outside any paragraph).
      const text = token as MarkdownTokens.Text;
      return <p key={key}>{text.tokens === undefined ? renderWords(text.text, context) : renderInline(text.tokens, context)}</p>;
    }
    default:
      return <p key={key}>{token.raw}</p>;
  }
}

/**
 * A list item's tokens are paragraphs when the list is loose and bare text
 * when it is tight; a tight item's text draws inline so the bullet and its
 * words sit on one line.
 */
function renderListItem(tokens: readonly MarkdownToken[], context: RenderContext): ReactNode[] {
  return tokens.map((token, index) => {
    if (token.type === "text") {
      const text = token as MarkdownTokens.Text;
      return <span key={index}>{text.tokens === undefined ? renderWords(text.text, context) : renderInline(text.tokens, context)}</span>;
    }
    return renderBlock(token, context, index);
  });
}

/**
 * Whether a link draws as a citation chip: to a page the turn read, or
 * written as a bare address.
 */
function isCitation(link: MarkdownTokens.Link, context: RenderContext): boolean {
  const href = link.href.trim();
  if (citedSource(context.sources, href) !== null) return true;
  const label = plainText(link.tokens).trim();
  const bare = label === "" || label === href || label.replace(/^https?:\/\//iu, "").replace(/\/$/u, "") === href.replace(/^https?:\/\//iu, "").replace(/\/$/u, "");
  return bare && isWebAddress(href);
}

/**
 * The spans of a run of text. A citation the model wrote in parentheses —
 * "…you dilute ([Serious Eats](…))." — draws as a chip, and the chip is
 * its own punctuation: the parentheses around it are dropped.
 */
function renderInline(tokens: readonly MarkdownToken[] | undefined, context: RenderContext): ReactNode[] {
  if (tokens === undefined) return [];
  const spans = tokens.map((token) => ({ ...token }) as MarkdownToken);
  spans.forEach((token, index) => {
    if (token.type !== "link" || !isCitation(token as MarkdownTokens.Link, context)) return;
    const before = spans[index - 1];
    const after = spans[index + 1];
    if (before?.type !== "text" || after?.type !== "text") return;
    const opens = /\(\s*$/u.exec(before.text);
    const closes = /^\s*\)/u.exec(after.text);
    if (opens === null || closes === null) return;
    const trimmedBefore = before.text.slice(0, opens.index);
    // The space the parenthesis followed stays, so the chip does not touch the word before it.
    before.text = trimmedBefore.endsWith(" ") ? trimmedBefore : `${trimmedBefore} `;
    after.text = after.text.slice(closes[0].length);
    delete (before as MarkdownTokens.Text).tokens;
    delete (after as MarkdownTokens.Text).tokens;
  });
  return spans.map((token, index) => renderSpan(token, context, index));
}

function renderSpan(token: MarkdownToken, context: RenderContext, key: number): ReactNode {
  switch (token.type) {
    case "text": {
      const text = token as MarkdownTokens.Text;
      return text.tokens !== undefined && text.tokens.length > 0 ? (
        <span key={key}>{renderInline(text.tokens, context)}</span>
      ) : (
        <span key={key}>{renderWords(text.text, context)}</span>
      );
    }
    case "escape":
      return <span key={key}>{renderWords((token as MarkdownTokens.Escape).text, context)}</span>;
    case "strong":
      return <strong key={key}>{renderInline((token as MarkdownTokens.Strong).tokens, context)}</strong>;
    case "em":
      return <em key={key}>{renderInline((token as MarkdownTokens.Em).tokens, context)}</em>;
    case "del":
      return <del key={key}>{renderInline((token as MarkdownTokens.Del).tokens, context)}</del>;
    case "codespan":
      return <code key={key}>{(token as MarkdownTokens.Codespan).text}</code>;
    case "br":
      return <br key={key} />;
    case "link":
      return <Link key={key} link={token as MarkdownTokens.Link} context={context} />;
    case "image": {
      // A picture the model names is a link to it: the chat shows nothing it did not fetch itself.
      const image = token as MarkdownTokens.Image;
      return <Link key={key} link={{ type: "link", raw: image.raw, href: image.href, title: image.title ?? null, text: image.text, tokens: [{ type: "text", raw: image.text, text: image.text }] }} context={context} />;
    }
    case "html":
      return <span key={key}>{renderWords(token.raw, context)}</span>;
    default:
      return <span key={key}>{renderWords(token.raw, context)}</span>;
  }
}

/**
 * A run of text. While the reply streams each word is its own span, so a
 * word that has just landed can resolve into place (shell.css); once the
 * reply is done it is one text node again, and the swap is invisible
 * because every word was already showing.
 */
function renderWords(text: string, context: RenderContext): ReactNode {
  if (!context.streaming) return text;
  return words(text).map((part, index) =>
    part.kind === "space" ? (
      part.value
    ) : (
      <span key={index} className="chat-word">
        {part.value}
      </span>
    ),
  );
}

/** How long the copy button shows its check before going back to the icon. */
const COPIED_MS = 1_500;

function CodeBlock({ code }: { code: MarkdownTokens.Code }) {
  const [copied, setCopied] = useState(false);
  useEffect(() => {
    if (!copied) return;
    const timer = window.setTimeout(() => setCopied(false), COPIED_MS);
    return () => window.clearTimeout(timer);
  }, [copied]);
  const language = (code.lang ?? "").trim().split(/\s+/)[0] ?? "";
  const copy = async (): Promise<void> => {
    try {
      await navigator.clipboard.writeText(code.text);
      setCopied(true);
    } catch {
      // The clipboard refused (no focus, no permission): nothing to show.
    }
  };
  return (
    <figure className="chat-code" data-testid="chat-code" data-language={language === "" ? undefined : language}>
      <figcaption className="chat-code-bar">
        <span className="chat-code-lang">{language === "" ? "Code" : language}</span>
        <button type="button" className="chat-code-copy" title={copied ? "Copied" : "Copy code"} aria-label={copied ? "Copied" : "Copy code"} onClick={() => void copy()}>
          {copied ? <Check className="size-3.5 text-green-900" aria-hidden="true" /> : <Copy className="size-3.5" aria-hidden="true" />}
          <span>{copied ? "Copied" : "Copy"}</span>
        </button>
      </figcaption>
      <pre>
        <code>{code.text}</code>
      </pre>
    </figure>
  );
}

function Table({ table, context }: { table: MarkdownTokens.Table; context: RenderContext }) {
  const align = (index: number): "left" | "center" | "right" | undefined => table.align[index] ?? undefined;
  return (
    <div className="chat-table">
      <table>
        <thead>
          <tr>
            {table.header.map((cell, index) => (
              <th key={index} style={{ textAlign: align(index) }}>
                {renderInline(cell.tokens, context)}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {table.rows.map((row, rowIndex) => (
            <tr key={rowIndex}>
              {row.map((cell, index) => (
                <td key={index} style={{ textAlign: align(index) }}>
                  {renderInline(cell.tokens, context)}
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function isWebAddress(href: string): boolean {
  try {
    const url = new URL(href);
    return url.protocol === "http:" || url.protocol === "https:" || url.protocol === "pistachio:";
  } catch {
    return false;
  }
}

/**
 * A link in a reply. To a page the turn read, or written as a bare
 * address, it is a citation chip; otherwise the underlined words. Either
 * way it opens as the console's links do (MessageText): a Glance, or a tab.
 */
function Link({ link, context }: { link: MarkdownTokens.Link; context: RenderContext }) {
  const openLink = useAppStore((state) => state.openLink);
  const href = link.href.trim();
  const label = plainText(link.tokens).trim();
  const open = (event: MouseEvent<HTMLElement>, inNewTab: boolean): void => {
    event.preventDefault();
    if (!isWebAddress(href)) return;
    const { x, y, width, height } = event.currentTarget.getBoundingClientRect();
    void openLink(href, { x, y, width, height }, inNewTab || context.links === "tab");
  };
  const handlers = {
    onClick: (event: MouseEvent<HTMLElement>) => open(event, event.metaKey || event.ctrlKey),
    onAuxClick: (event: MouseEvent<HTMLElement>) => {
      if (event.button === 1) open(event, true);
    },
  };
  const source = citedSource(context.sources, href);
  if (isCitation(link, context)) {
    return <SourceChip href={href} title={source?.title ?? label} index={source?.index ?? null} {...handlers} />;
  }
  return (
    <a href={href} title={link.title ?? href} draggable={false} className="chat-link" {...handlers}>
      {renderInline(link.tokens, context)}
    </a>
  );
}
