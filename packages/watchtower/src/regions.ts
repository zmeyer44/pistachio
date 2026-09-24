import type {
  WatchtowerCapture,
  WatchtowerRawBlock,
  WatchtowerRawCapture,
  WatchtowerRegion,
  WatchtowerRegionRule,
} from "@pistachio/agent-runtime/watchtower";

/**
 * Which parts of a captured page are worth keeping.
 *
 * The extractor reports every block with its place in the layout. Here the
 * blocks are grouped into REGIONS — runs of the page that share an ancestor
 * path, so a column of recommendation cards is one region and the article
 * body another — and each region gets one verdict:
 *
 *   1. a remembered rule for this site's layout (so the same sidebar is
 *      judged once, and a page extracts identically on every visit, which
 *      revisit deduplication depends on);
 *   2. local evidence that is decisive on its own (the page's headline
 *      region, a block that announces itself as sponsored, a link rail
 *      named "related");
 *   3. otherwise the region is UNDECIDED, and the host may ask the decision
 *      model about it (`agent-runtime/watchtower-filter`).
 *
 * Doubt keeps text. A region is dropped only on a decisive local signal, a
 * confident model verdict, or a remembered rule; and if the verdicts would
 * throw away most of a page, they are not believed.
 */

const RULE_TTL_MS = 30 * 86400000;
const MAX_REGIONS = 40;

interface Node {
  segment: string;
  children: Map<string, Node>;
  own: number[];
  chars: number;
}

export function buildRegions(blocks: WatchtowerRawBlock[]): WatchtowerRegion[] {
  const root: Node = { segment: "", children: new Map(), own: [], chars: 0 };
  blocks.forEach((block, index) => {
    let node = root;
    node.chars += block.text.length;
    for (const segment of block.path.slice(0, 10)) {
      let child = node.children.get(segment);
      if (!child) {
        child = { segment, children: new Map(), own: [], chars: 0 };
        node.children.set(segment, child);
      }
      child.chars += block.text.length;
      node = child;
    }
    node.own.push(index);
  });
  const all = (node: Node): number[] => [
    ...node.own,
    ...[...node.children.values()].flatMap(all),
  ];
  for (let depth = 6; depth >= 1; depth--) {
    const leaves: { signature: string; blocks: number[] }[] = [];
    const split = (node: Node, path: string[], level: number): void => {
      const children = [...node.children.values()];
      // Big enough to be a part of the layout — or small but NAMED, which
      // is what an ad slot or a byline is.
      const substantial = children.filter(
        (child) =>
          child.chars >= Math.max(120, node.chars * 0.04) ||
          (child.chars >= 40 && specificSegment(child.segment)),
      );
      // Nothing below here is big enough to be a part of the layout.
      if (level >= depth || substantial.length === 0) {
        leaves.push({ signature: path.join(">"), blocks: all(node) });
        return;
      }
      // The node's own text and its crumbs stay together; each substantial
      // child is a candidate region (or a wrapper around some).
      const crumbs = [
        ...node.own,
        ...children.filter((child) => !substantial.includes(child)).flatMap(all),
      ];
      if (crumbs.length)
        leaves.push({ signature: [...path, "*"].join(">"), blocks: crumbs });
      // A bare wrapper around one child is not a level of the layout.
      const wrapper = substantial.length === 1 && crumbs.length === 0;
      for (const child of substantial)
        split(child, [...path, child.segment], wrapper ? level : level + 1);
    };
    split(root, [], 0);
    if (leaves.length <= MAX_REGIONS || depth === 1)
      return leaves
        .filter((leaf) => leaf.blocks.length > 0)
        .map((leaf) => {
          const sorted = leaf.blocks.sort((a, b) => a - b);
          const members = sorted.map((index) => blocks[index]!);
          const chars = members.reduce((n, block) => n + block.text.length, 0);
          return {
            signature: leaf.signature.slice(0, 400),
            blocks: sorted,
            chars,
            linkChars: Math.min(
              chars,
              members.reduce((n, block) => n + block.linkChars, 0),
            ),
            // The page's headline. Cards and rails have h2s of their own.
            hasHeading: members.some((block) => /^# /u.test(block.text)),
            excerpt: members
              .map((block) => block.text)
              .join(" · ")
              .replace(/\s+/gu, " ")
              .slice(0, 200),
          };
        });
  }
  return [];
}

const FURNITURE =
  /(^|[^a-z])(ads?|advert\w*|sponsor\w*|promo\w*|cookie\w*|consent|newsletter|subscribe|signup|paywall|related|recommend\w*|trending|popular|most-?read|more-?from|sidebar|rail|secondary|share|social|footer|breadcrumbs?|outbrain|taboola|merch|upsell|also-?like)([^a-z]|$)/iu;
const CONTENT =
  /(^|[^a-z])(article|post|story|content|entry|body|primary|description|transcript|comments?|answers?|question|readme|markdown|prose|main)([^a-z]|$)/iu;
const ANNOUNCED_AD =
  /^(#+ )?(advertisement|advertising content|sponsored|promoted|paid (content|post|partnership)|ad)\b/iu;

function specificSegment(segment: string): boolean {
  return /[#.[]|^(aside|footer|header|section|figure|details)\b|^[a-z]+-[a-z-]+/u.test(
    segment,
  );
}

/**
 * A rule is only remembered for a signature that names something — itself
 * or close above it: cards are often bare `a > h3` under a `div#related`.
 */
export function specificSignature(signature: string): boolean {
  return signature.split(">").slice(-4).some(specificSegment);
}

/** A short block that says of itself that it is an ad, wherever it sits. */
const AD_LABEL =
  /^(advertisement|sponsored|promoted|ad)\b\s*([·:|—–-]|$)/iu;

export type RegionVerdict =
  | { keep: boolean; decided: true; source: "rule" | "local" }
  | { keep: boolean; decided: false };

/**
 * One verdict per region. `decided: false` carries the local best guess,
 * used as is when no model is available to ask.
 */
export function judgeLocally(
  regions: WatchtowerRegion[],
  rules: ReadonlyMap<string, WatchtowerRegionRule>,
  kind: string = "page",
  now = Date.now(),
): RegionVerdict[] {
  const total = Math.max(
    1,
    regions.reduce((n, region) => n + region.chars, 0),
  );
  const linked = regions.reduce((n, region) => n + region.linkChars, 0);
  // A front page, a search result, a forum index: the links ARE the content,
  // so being made of links says nothing about a region there. A page with a
  // declared subject (an article, a video) is the opposite: a wall of links
  // beside it is somebody else's content.
  const index = kind === "page" && linked / total >= 0.5;
  return regions.map((region): RegionVerdict => {
    const share = region.chars / total;
    const density = region.linkChars / Math.max(1, region.chars);
    const average = region.chars / Math.max(1, region.blocks.length);
    const tail = region.signature.split(">").slice(-3).join(">");
    const specific = specificSignature(region.signature);
    const wall = !index && density >= 0.6;
    // What the page is about is never furniture, whatever it is called.
    if (region.hasHeading && share >= 0.1 && !wall)
      return { keep: true, decided: true, source: "local" };
    if (share >= 0.5 && !wall)
      return { keep: true, decided: true, source: "local" };
    if (ANNOUNCED_AD.test(region.excerpt) && share < 0.3)
      return { keep: false, decided: true, source: "local" };
    const rule = specific ? rules.get(region.signature) : undefined;
    if (rule && now - rule.at < RULE_TTL_MS)
      return { keep: rule.keep, decided: true, source: "rule" };
    // A rail is named by whatever holds it (#secondary, .sidebar), however
    // deep its cards sit; content is named by what is nearest.
    const furniture = FURNITURE.test(region.signature);
    const content = CONTENT.test(tail);
    if (specific && furniture && !content && (share < 0.35 || wall))
      return { keep: false, decided: true, source: "local" };
    if (content && !furniture && density < 0.5)
      return { keep: true, decided: true, source: "local" };
    // Too small to be worth a question or a loss.
    if (region.chars < 120) return { keep: true, decided: true, source: "local" };
    // An unnamed wrapper can mean anything on the next page: never drop it.
    if (!specific) return { keep: true, decided: true, source: "local" };
    // Everything else that has a name is a question for the decision model,
    // asked once per site layout. The guess stands only when nobody can be
    // asked: a wall of short links beside a page's subject goes, the rest stays.
    const railLike = !index && density >= 0.65 && average < 140;
    return { keep: !railLike, decided: false };
  });
}

/** Do not believe verdicts that would discard most of a page. */
export function sane(regions: WatchtowerRegion[], keep: boolean[]): boolean[] {
  const total = regions.reduce((n, region) => n + region.chars, 0);
  const kept = regions.reduce(
    (n, region, index) => n + (keep[index] ? region.chars : 0),
    0,
  );
  // A video page is mostly other videos: losing most of its text is right
  // as long as what it is about — the part with the headline — was kept.
  const subject = regions.some(
    (region, index) => keep[index] && region.hasHeading,
  );
  if (total < 500 || kept >= total * 0.3 || subject) return keep;
  return regions.map((region) => !ANNOUNCED_AD.test(region.excerpt));
}

export function applyRegions(
  raw: WatchtowerRawCapture,
  regions: WatchtowerRegion[],
  keep: boolean[],
): WatchtowerCapture {
  const dropped = new Set<number>();
  regions.forEach((region, index) => {
    if (!keep[index]) for (const block of region.blocks) dropped.add(block);
  });
  const { blocks, links, ...card } = raw;
  return {
    ...card,
    blocks: blocks.flatMap((block, index) => {
      if (!dropped.has(index) && block.text.length < 200 && AD_LABEL.test(block.text))
        dropped.add(index);
      return dropped.has(index) ? [] : [block.text];
    }),
    links: links.flatMap((link) =>
      dropped.has(link.block) ? [] : [{ url: link.url, text: link.text }],
    ),
  };
}

/** The rules worth remembering from one page's decided regions. */
export function rulesFrom(
  regions: WatchtowerRegion[],
  decisions: (
    | { keep: boolean; role: WatchtowerRegionRule["role"]; source: "local" | "model" }
    | undefined
  )[],
  now = Date.now(),
): WatchtowerRegionRule[] {
  return regions.flatMap((region, index) => {
    const decision = decisions[index];
    return decision && specificSignature(region.signature)
      ? [{ signature: region.signature, at: now, ...decision }]
      : [];
  });
}
