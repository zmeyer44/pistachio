import type { WatchtowerRawCapture } from "@pistachio/agent-runtime/watchtower";

/**
 * What crosses from the page to main. A block's path is an index into
 * `paths`: fifteen hundred blocks under forty parents carry forty paths, not
 * fifteen hundred. `wire.ts` validates it into a `WatchtowerRawCapture`.
 */
export interface WatchtowerWireCapture
  extends Omit<WatchtowerRawCapture, "blocks"> {
  paths: string[];
  blocks: { text: string; path: number; linkChars: number }[];
}

/**
 * Serialized into an isolated world. All dependencies must remain inside this function.
 *
 * It returns blocks WITH their place in the page (`path`, `linkChars`) and
 * decides nothing about ads or sidebars itself: `regions.ts` judges whole
 * layout regions afterwards, so one verdict covers every page of a site and
 * stays the same from visit to visit. What is dropped here is only what can
 * never be content — controls, hidden subtrees, live/ticking text, the video
 * player's own chrome.
 */
export async function capturePage(): Promise<WatchtowerWireCapture | null> {
  const maxBytes = 192 * 1024; // leave room for the bounded metadata card
  const startedAt = performance.now();
  const startedUrl = location.href;
  const passwords = document.querySelectorAll<HTMLInputElement>(
    'input[type="password"]',
  );
  if (
    passwords.length > 50 ||
    Array.from(passwords).some(
      (password) => password.getClientRects().length > 0,
    )
  )
    return null;
  const articles = document.querySelectorAll("article");
  const root =
    document.querySelector("main, [role=main]") ??
    (articles.length === 1 ? articles[0] : document.body);
  if (
    !root ||
    (root as HTMLElement).isContentEditable ||
    root.closest("[hidden], [aria-hidden=true], [contenteditable=true]") ||
    // `display: contents` has no box of its own, so checkVisibility() calls
    // it invisible while its children are plainly on screen (MDN's <main>).
    (!root.checkVisibility({ checkOpacity: true, checkVisibilityCSS: true }) &&
      getComputedStyle(root).display !== "contents")
  )
    return null;

  // Changes after this capture are counted by a passive observer, so the host
  // can skip re-walking a page that has not gained any substantial text.
  // Ticking clocks and counters replace a few characters and never count.
  const scope = globalThis as unknown as {
    __watchtowerDirty?: number;
    __watchtowerObserver?: MutationObserver;
  };
  scope.__watchtowerDirty = 0;
  if (!scope.__watchtowerObserver) {
    scope.__watchtowerObserver = new MutationObserver((records) => {
      if ((scope.__watchtowerDirty ?? 0) >= 100000) return;
      let added = 0;
      for (const record of records.slice(0, 50))
        for (const node of Array.from(record.addedNodes).slice(0, 20)) {
          const length =
            node.nodeType === Node.TEXT_NODE
              ? (node.nodeValue ?? "").trim().length
              : node.nodeType === Node.ELEMENT_NODE
                ? // textContent, not innerText: counting must never force layout.
                  (node.textContent ?? "").trim().length
                : 0;
          if (length >= 40) added += length;
        }
      scope.__watchtowerDirty = (scope.__watchtowerDirty ?? 0) + added;
    });
    scope.__watchtowerObserver.observe(document.documentElement, {
      childList: true,
      subtree: true,
    });
  }

  const title = document.title.slice(0, 500);
  const meta = (name: string): string =>
    (
      document.querySelector<HTMLMetaElement>(
        `meta[property="${name}"],meta[name="${name}"],meta[itemprop="${name}"]`,
      )?.content ?? ""
    ).slice(0, 3000);

  // Structured data names the creator, the full description and the duration
  // far more reliably than the rendered page does (a collapsed description,
  // a channel name buried in a custom element).
  const structured: Record<string, unknown>[] = [];
  const collect = (value: unknown, depth: number): void => {
    if (depth > 3 || structured.length >= 40 || !value) return;
    if (Array.isArray(value)) {
      for (const item of value.slice(0, 20)) collect(item, depth + 1);
      return;
    }
    if (typeof value !== "object") return;
    const record = value as Record<string, unknown>;
    if (record["@type"]) structured.push(record);
    if (record["@graph"]) collect(record["@graph"], depth + 1);
  };
  for (const script of Array.from(
    document.querySelectorAll('script[type="application/ld+json"]'),
  ).slice(0, 6)) {
    const source = script.textContent ?? "";
    if (source.length > 100000) continue;
    try {
      collect(JSON.parse(source), 0);
    } catch {
      /* malformed structured data is simply absent */
    }
  }
  const typed = (pattern: RegExp): Record<string, unknown> | undefined =>
    structured.find((item) =>
      ([] as unknown[])
        .concat(item["@type"])
        .some((type) => typeof type === "string" && pattern.test(type)),
    );
  const videoData = typed(/^(VideoObject|Movie|Clip|Episode)$/u);
  const articleData = typed(/(Article|BlogPosting|Report|Recipe)$/u);
  const primary = videoData ?? articleData ?? structured[0];
  const str = (value: unknown): string =>
    typeof value === "string" ? value.trim() : "";
  const nameOf = (value: unknown): string => {
    if (Array.isArray(value))
      return value.slice(0, 4).map(nameOf).filter(Boolean).join(", ");
    if (value && typeof value === "object")
      return str((value as Record<string, unknown>)["name"]);
    return str(value);
  };
  const microAuthor =
    document.querySelector<HTMLElement>(
      '[itemprop="author"] [itemprop="name"]',
    ) ?? document.querySelector<HTMLElement>('[itemprop="author"]');
  const creator = (
    nameOf(primary?.["author"]) ||
    nameOf(primary?.["creator"]) ||
    (microAuthor?.getAttribute("content") ?? "").trim() ||
    meta("author") ||
    meta("article:author")
  ).slice(0, 300);
  const description = [
    str(primary?.["description"]),
    meta("description"),
    meta("og:description"),
  ]
    .sort((a, b) => b.length - a.length)[0]!
    .slice(0, 3000);
  const published = (
    str(primary?.["uploadDate"]) ||
    str(primary?.["datePublished"]) ||
    meta("uploadDate") ||
    meta("datePublished") ||
    meta("article:published_time")
  ).slice(0, 40);
  const duration = (str(primary?.["duration"]) || meta("duration")).slice(
    0,
    40,
  );

  // The player and everything drawn over it (clock, scrubber, captions
  // toggles) is chrome, and its clock would make every capture "new".
  const players = new Set<Element>();
  let dominantVideo = false;
  const viewport = Math.max(1, innerWidth * innerHeight);
  for (const video of Array.from(document.querySelectorAll("video")).slice(
    0,
    8,
  )) {
    const rect = video.getBoundingClientRect();
    const area = rect.width * rect.height;
    if (area / viewport >= 0.2) dominantVideo = true;
    let player: Element = video;
    while (player.parentElement && player.parentElement !== root) {
      const outer = player.parentElement.getBoundingClientRect();
      if (area === 0 || outer.width * outer.height > area * 1.35) break;
      player = player.parentElement;
    }
    players.add(player);
  }
  const kind =
    videoData ||
    meta("og:type").startsWith("video") ||
    document.querySelector('[itemtype$="VideoObject"]') ||
    dominantVideo
      ? "video"
      : articleData ||
          root.tagName === "ARTICLE" ||
          meta("og:type") === "article"
        ? "article"
        : "page";

  const skip = new Set([
    "SCRIPT",
    "STYLE",
    "NOSCRIPT",
    "TEMPLATE",
    "NAV",
    "FOOTER",
    "ASIDE",
    "FORM",
    "INPUT",
    "TEXTAREA",
    "SELECT",
    "BUTTON",
    "SVG",
    "CANVAS",
    "IFRAME",
    "VIDEO",
    "AUDIO",
    "DIALOG",
    "MENU",
  ]);
  // Live regions and meters tick; site banners and menus are never content.
  const skipRoles = new Set([
    "navigation",
    "dialog",
    "alertdialog",
    "banner",
    "contentinfo",
    "search",
    "menu",
    "menubar",
    "toolbar",
    "tablist",
    "timer",
    "progressbar",
    "slider",
    "status",
    "alert",
    "marquee",
    "log",
    "tooltip",
  ]);
  const containers = new Set([
    "P",
    "DIV",
    "H1",
    "H2",
    "H3",
    "H4",
    "H5",
    "H6",
    "LI",
    "PRE",
    "TR",
    "BLOCKQUOTE",
    "FIGCAPTION",
    "SECTION",
    "ARTICLE",
    "MAIN",
    "DT",
    "DD",
    "SUMMARY",
  ]);
  type Block = WatchtowerWireCapture["blocks"][number];
  const blocks: Block[] = [];
  const paths: string[] = [];
  const pathIndex = new Map<string, number>();
  const links: WatchtowerRawCapture["links"] = [];
  const linkSet = new Set<string>();
  const encoder = new TextEncoder();
  let pendingLinks: number[] = [];
  let linkBytes = 0;
  let bytes = 0,
    nodes = 0,
    cpu = 0,
    truncated = false;
  let current: Element | null = null;
  let text = "";
  let textLinkChars = 0;

  // `tag#id.class.class`, minus the parts that change between page loads:
  // generated ids, hashed CSS-module classes, state classes.
  const signatures = new Map<Element, string>();
  const unstable = /\d{3,}|^(css|sc|jsx|svelte|emotion|tw)-|^_|[A-Z].*\d|\d.*[A-Z]|^(is|has)-|active|selected|hover|focus|open|visible|loaded/u;
  const signature = (element: Element): string => {
    let value = signatures.get(element);
    if (value !== undefined) return value;
    const id =
      element.id && element.id.length <= 40 && !/\d{3,}/u.test(element.id)
        ? `#${element.id}`
        : "";
    const classes = Array.from(element.classList)
      .filter(
        (name) =>
          name.length <= 40 &&
          !unstable.test(name) &&
          // "hygVWX", "cBWgom": a build's hash, gone with the next deploy.
          !(name.length <= 8 && (name.match(/[A-Z]/gu)?.length ?? 0) >= 2),
      )
      .slice(0, 2)
      .map((name) => `.${name}`)
      .join("");
    const role = element.getAttribute("role");
    value = `${element.tagName.toLowerCase()}${id}${classes}${role ? `[${role.slice(0, 20)}]` : ""}`
      .replace(/>/gu, "_")
      .slice(0, 100);
    signatures.set(element, value);
    return value;
  };
  const pathOf = (element: Element | null): number => {
    const path: string[] = [];
    for (
      let at: Element | null = element;
      at && at !== root;
      at = at.parentElement
    )
      path.unshift(signature(at));
    const key = path.slice(0, 10).join(">");
    let index = pathIndex.get(key);
    if (index === undefined) {
      // Past the bound, everything else shares the last path: still saved,
      // judged with its neighbours.
      if (paths.length >= 400) return paths.length - 1;
      index = paths.push(key) - 1;
      pathIndex.set(key, index);
    }
    return index;
  };

  // Consecutive list items and table rows become one block: a 13-byte block
  // costs more in hashes and index entries than the text it holds.
  let group: {
    parent: Element;
    lines: string[];
    size: number;
    linkChars: number;
    links: number[];
  } | null = null;
  const counters = new Map<Element, number>();
  const push = (block: Block, owned: number[]): void => {
    const previous = blocks[blocks.length - 1];
    if (previous && previous.text === block.text) return; // a headline repeated by its own link
    const size = encoder.encode(block.text).length;
    if (bytes + size > maxBytes || blocks.length >= 1500) {
      truncated = true;
      return;
    }
    for (const index of owned) links[index]!.block = blocks.length;
    blocks.push(block);
    bytes += size;
  };
  const closeGroup = (): void => {
    if (!group) return;
    push(
      {
        text: group.lines.join("\n"),
        path: pathOf(group.parent),
        linkChars: group.linkChars,
      },
      group.links,
    );
    group = null;
  };
  const flush = (): void => {
    const tag = current?.tagName ?? "P";
    const cleaned =
      tag === "PRE" ? text.trimEnd() : text.replace(/\s+/gu, " ").trim();
    const linkChars = Math.min(textLinkChars, cleaned.length);
    text = "";
    textLinkChars = 0;
    // Nothing to read: table borders ("| |"), bullets, and a bare playback
    // clock ("0:00 / 18:39"), which would otherwise make every capture new.
    if (
      !/[\p{L}\p{N}]/u.test(cleaned) ||
      /^\d{1,2}:\d{2}(:\d{2})?(\s*\/\s*\d{1,2}:\d{2}(:\d{2})?)?$/u.test(cleaned)
    )
      return;
    const owned = pendingLinks;
    pendingLinks = [];
    const parent =
      tag === "LI"
        ? (current?.closest("ul,ol,menu") ?? null)
        : tag === "TR"
          ? (current?.closest("table") ?? null)
          : null;
    if (parent) {
      let line = cleaned;
      if (tag === "LI") {
        if (parent.tagName === "OL") {
          const n = (counters.get(parent) ?? 0) + 1;
          counters.set(parent, n);
          line = `${n}. ${cleaned}`;
        } else line = `- ${cleaned}`;
      }
      if (group && (group.parent !== parent || group.size + line.length > 1200))
        closeGroup();
      group ??= { parent, lines: [], size: 0, linkChars: 0, links: [] };
      group.lines.push(line);
      group.size += line.length + 1;
      group.linkChars += linkChars;
      group.links.push(...owned);
      return;
    }
    closeGroup();
    const prefix = /^H[1-6]$/u.test(tag)
      ? `${"#".repeat(Number(tag[1]))} `
      : tag === "BLOCKQUOTE"
        ? "> "
        : "";
    push(
      {
        text:
          tag === "PRE"
            ? `~~~~\n${cleaned.replace(/~~~~/gu, "~~~ ~")}\n~~~~`
            : prefix + cleaned,
        path: pathOf(current),
        linkChars,
      },
      owned,
    );
  };
  // A manual depth-first walk lets rejected subtrees be skipped without scanning them.
  let node: Node | null = root.firstChild;
  const advance = (from: Node, descend: boolean): Node | null => {
    if (descend && from.firstChild) return from.firstChild;
    let next: Node | null = from;
    while (next && next !== root) {
      if (next.nextSibling) return next.nextSibling;
      next = next.parentNode;
    }
    return null;
  };
  while (node && !truncated) {
    await new Promise<void>((resolve) => {
      if (typeof requestIdleCallback === "function")
        requestIdleCallback(() => resolve(), { timeout: 500 });
      else setTimeout(resolve, 0);
    });
    if (location.href !== startedUrl || !root.isConnected) return null;
    if (performance.now() - startedAt > 4000) {
      truncated = true;
      break;
    }
    const slice = performance.now();
    while (node && performance.now() - slice < 4 && !truncated) {
      if (++nodes > 20000) {
        truncated = true;
        break;
      }
      let descend = true;
      if (node.nodeType === Node.ELEMENT_NODE) {
        const element = node as HTMLElement;
        const tag = element.tagName;
        const live = element.getAttribute("aria-live");
        const rejected =
          skip.has(tag) ||
          players.has(element) ||
          element.hidden ||
          element.getAttribute("aria-hidden") === "true" ||
          element.isContentEditable ||
          skipRoles.has(element.getAttribute("role") ?? "") ||
          (live !== null && live !== "off") ||
          // Text for screen readers repeats what is drawn ("Comment Icon
          // Bubble"); edit affordances and print-hidden parts are not prose.
          (typeof element.className === "string" &&
            element.className !== "" &&
            /(^|[\s_-])(sr-only|visually-?hidden|screen-?reader(-text)?|editsection|noprint)([\s_-]|$)/iu.test(
              element.className,
            )) ||
          // The site's own header, not an article's.
          (tag === "HEADER" &&
            (element.parentElement === document.body ||
              element.querySelector("nav") !== null));
        if (rejected) descend = false;
        else {
          const style = getComputedStyle(element);
          if (
            style.display === "none" ||
            style.visibility === "hidden" ||
            style.opacity === "0"
          )
            descend = false;
          else {
            if (containers.has(tag)) flush();
            if (tag === "A" && links.length < 100 && linkBytes < 24000) {
              const url = (element as HTMLAnchorElement).href;
              if (/^https?:/u.test(url) && !linkSet.has(url)) {
                linkSet.add(url);
                const label = (
                  element.getAttribute("aria-label") ??
                  element.textContent ??
                  ""
                )
                  .replace(/\s+/gu, " ")
                  .trim()
                  .slice(0, 300);
                linkBytes += encoder.encode(url.slice(0, 2048) + label).length;
                pendingLinks.push(links.length);
                links.push({ url: url.slice(0, 2048), text: label, block: -1 });
              }
            }
            if (tag === "TD" || tag === "TH") text += " | ";
            if (tag === "BR") text += "\n";
            if (tag === "IMG")
              text += ` ${(element.getAttribute("alt") ?? "").slice(0, 500)} `;
          }
        }
      } else if (node.nodeType === Node.TEXT_NODE) {
        let parent = node.parentElement;
        const inLink = parent?.closest("a") != null;
        while (parent && parent !== root && !containers.has(parent.tagName))
          parent = parent.parentElement;
        if (parent !== current) {
          flush();
          current = parent;
        }
        const value = node.nodeValue ?? "";
        // Never copy an arbitrarily large text node into an IPC payload.
        const remaining = Math.max(0, 20000 - text.length);
        text += value.slice(0, remaining);
        if (inLink) textLinkChars += value.trim().length;
        if (value.length > remaining) {
          flush();
          truncated = true;
        }
      }
      node = advance(node, descend);
    }
    cpu += performance.now() - slice;
    if (cpu >= 200) truncated = true;
  }
  flush();
  closeGroup();
  return {
    url: startedUrl,
    title,
    description,
    creator,
    published,
    duration,
    kind,
    paths,
    blocks,
    links: links.filter((link) => link.block >= 0),
    truncated,
  };
}

export const WATCHTOWER_CAPTURE_SCRIPT = `(${capturePage.toString()})()`;

/**
 * How much substantial text the page has gained since its last capture, or
 * -1 when this document has not been captured yet. Reading one number is all
 * a recapture check costs the page.
 */
export const WATCHTOWER_DIRTY_SCRIPT = "globalThis.__watchtowerDirty ?? -1";
