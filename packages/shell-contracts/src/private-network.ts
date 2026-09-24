/**
 * Which addresses are NOT on the public web.
 *
 * Pistachio reads a page for a bookmark over the person's own Space session
 * — their cookies — at an address they did not necessarily choose: the agent
 * names it, and the agent can be acting on what a page told it. An address
 * that points back at the machine, at the network it sits on, or at a cloud
 * instance's metadata endpoint would reach a private service with the
 * person's credentials attached and hand what it says to the model. So every
 * address in a page read is checked here first, the redirects included
 * (main/browser-controller.ts `fetchPageHtml`).
 *
 * Pure and node-free on purpose: the whole point is that vitest can pin the
 * ranges without an Electron process.
 */

/**
 * Names that never leave the machine or the local network, however they
 * happen to resolve. `.local` is mDNS, `.internal` is what every cloud
 * hands its private zone, and `.home.arpa` is the standard home network.
 */
const PRIVATE_SUFFIX = /(^|\.)(localhost|local|internal|intranet|lan|home\.arpa)$/;

/** The four octets of a dotted-decimal IPv4 literal, or null. */
function ipv4Octets(host: string): number[] | null {
  const parts = host.split(".");
  if (parts.length !== 4) return null;
  const octets: number[] = [];
  for (const part of parts) {
    if (!/^\d{1,3}$/.test(part)) return null;
    const value = Number(part);
    if (value > 255) return null;
    octets.push(value);
  }
  return octets;
}

/**
 * The eight hextets of an IPv6 literal, or null. Handles `::` elision and
 * an IPv4 tail (`::ffff:127.0.0.1`), which is how a v4 address reaches a
 * v6 socket — and how a naive check gets walked past.
 */
function ipv6Hextets(host: string): number[] | null {
  if (!host.includes(":")) return null;
  let text = host;
  const tail = /:(\d{1,3}(?:\.\d{1,3}){3})$/.exec(text);
  if (tail !== null) {
    const octets = ipv4Octets(tail[1]!);
    if (octets === null) return null;
    const high = ((octets[0]! << 8) | octets[1]!).toString(16);
    const low = ((octets[2]! << 8) | octets[3]!).toString(16);
    text = `${text.slice(0, tail.index)}:${high}:${low}`;
  }
  const halves = text.split("::");
  if (halves.length > 2) return null;
  const parse = (chunk: string): number[] | null => {
    if (chunk === "") return [];
    const out: number[] = [];
    for (const part of chunk.split(":")) {
      if (!/^[0-9a-f]{1,4}$/.test(part)) return null;
      out.push(Number.parseInt(part, 16));
    }
    return out;
  };
  const head = parse(halves[0] ?? "");
  const rest = parse(halves[1] ?? "");
  if (head === null || rest === null) return null;
  if (halves.length === 1) return head.length === 8 ? head : null;
  const fill = 8 - head.length - rest.length;
  if (fill < 0) return null;
  return [...head, ...(Array.from({ length: fill }, () => 0)), ...rest];
}

/** Every IPv4 range that is not a routable public address. */
function isPrivateIpv4(octets: number[]): boolean {
  const [a, b] = octets as [number, number, number, number];
  if (a === 0) return true; // 0.0.0.0/8, "this network"
  if (a === 10) return true; // 10/8
  if (a === 127) return true; // loopback
  if (a === 100 && b >= 64 && b <= 127) return true; // 100.64/10, carrier NAT
  if (a === 169 && b === 254) return true; // link-local, and 169.254.169.254
  if (a === 172 && b >= 16 && b <= 31) return true; // 172.16/12
  if (a === 192 && b === 0) return true; // 192.0.0/24 and 192.0.2/24
  if (a === 192 && b === 168) return true; // 192.168/16
  if (a === 198 && (b === 18 || b === 19)) return true; // 198.18/15, benchmarking
  if (a >= 224) return true; // multicast, reserved, and 255.255.255.255
  return false;
}

function isPrivateIpv6(hextets: number[]): boolean {
  const first = hextets[0]!;
  if ((first & 0xffc0) === 0xfe80) return true; // fe80::/10, link-local
  if ((first & 0xfe00) === 0xfc00) return true; // fc00::/7, unique local
  if ((first & 0xff00) === 0xff00) return true; // ff00::/8, multicast
  // ::, ::1, ::ffff:a.b.c.d and ::a.b.c.d all carry a v4 address in the low
  // 32 bits — judge that, which also settles the loopback and unspecified
  // addresses as 0.0.0.1 and 0.0.0.0.
  if (hextets.slice(0, 5).every((part) => part === 0) && (hextets[5] === 0xffff || hextets[5] === 0)) {
    return isPrivateIpv4([hextets[6]! >> 8, hextets[6]! & 0xff, hextets[7]! >> 8, hextets[7]! & 0xff]);
  }
  return false;
}

/**
 * Whether `host` — a hostname or an IP literal, as `URL.hostname` gives it
 * — names somewhere off the public web. A name is judged on the name alone;
 * what it RESOLVES to is a separate question the caller answers by checking
 * each resolved address through here too.
 */
export function isPrivateHost(host: string): boolean {
  // `URL.hostname` keeps IPv6 in brackets and may keep a trailing root dot.
  const bare = host.replace(/^\[|\]$/g, "").replace(/\.$/, "").toLowerCase();
  if (bare === "") return true;
  const v4 = ipv4Octets(bare);
  if (v4 !== null) return isPrivateIpv4(v4);
  const v6 = ipv6Hextets(bare);
  if (v6 !== null) return isPrivateIpv6(v6);
  return PRIVATE_SUFFIX.test(bare);
}
