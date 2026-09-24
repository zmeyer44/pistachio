/**
 * Dependency-free IP literal parsing.
 *
 * Mirrors Rust's `IpAddr::from_str`, which is what harbor's egress gateway
 * judged targets with: strict dotted-quad IPv4 (no leading zeros, so "010" is
 * neither octal nor decimal), RFC 4291 IPv6 with at most one `::` and an
 * optional embedded IPv4 in the last 32 bits, and no zone ids. This package
 * is browser-safe (`types: []`), so `node:net` is not available here.
 */

export type Ipv4Octets = readonly [number, number, number, number];
export type Ipv6Segments = readonly [
  number,
  number,
  number,
  number,
  number,
  number,
  number,
  number,
];

export type IpAddress =
  | { readonly family: 4; readonly octets: Ipv4Octets }
  | { readonly family: 6; readonly segments: Ipv6Segments };

const IPV4_RE = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/;
const HEX_GROUP_RE = /^[0-9a-fA-F]{1,4}$/;

function parseOctet(text: string): number | null {
  if (text.length > 1 && text.startsWith("0")) return null;
  const n = Number(text);
  return n <= 255 ? n : null;
}

export function parseIpv4(text: string): Ipv4Octets | null {
  const m = IPV4_RE.exec(text);
  if (m === null) return null;
  const [, a = "", b = "", c = "", d = ""] = m;
  const o0 = parseOctet(a);
  const o1 = parseOctet(b);
  const o2 = parseOctet(c);
  const o3 = parseOctet(d);
  if (o0 === null || o1 === null || o2 === null || o3 === null) return null;
  return [o0, o1, o2, o3];
}

/**
 * One colon-separated run of groups — the part before or after `::`. An
 * embedded IPv4 literal is accepted only as the final group of the final run,
 * exactly where Rust accepts it.
 */
function parseGroups(section: string, allowTrailingIpv4: boolean): number[] | null {
  const parts = section.split(":");
  const groups: number[] = [];
  for (let i = 0; i < parts.length; i += 1) {
    const part = parts[i] ?? "";
    if (allowTrailingIpv4 && i === parts.length - 1 && part.includes(".")) {
      const v4 = parseIpv4(part);
      if (v4 === null) return null;
      groups.push((v4[0] << 8) | v4[1], (v4[2] << 8) | v4[3]);
      continue;
    }
    if (!HEX_GROUP_RE.test(part)) return null;
    groups.push(parseInt(part, 16));
  }
  return groups;
}

function segmentsFrom(groups: number[]): Ipv6Segments | null {
  if (groups.length !== 8) return null;
  const [s0, s1, s2, s3, s4, s5, s6, s7] = groups;
  if (
    s0 === undefined ||
    s1 === undefined ||
    s2 === undefined ||
    s3 === undefined ||
    s4 === undefined ||
    s5 === undefined ||
    s6 === undefined ||
    s7 === undefined
  ) {
    return null;
  }
  return [s0, s1, s2, s3, s4, s5, s6, s7];
}

export function parseIpv6(text: string): Ipv6Segments | null {
  const gap = text.indexOf("::");
  if (gap === -1) {
    const groups = parseGroups(text, true);
    return groups === null ? null : segmentsFrom(groups);
  }
  const headText = text.slice(0, gap);
  const tailText = text.slice(gap + 2);
  if (tailText.includes("::")) return null;
  const head = headText === "" ? [] : parseGroups(headText, false);
  const tail = tailText === "" ? [] : parseGroups(tailText, true);
  if (head === null || tail === null) return null;
  // `::` stands for at least one group of zeros.
  if (head.length + tail.length > 7) return null;
  const zeros = new Array<number>(8 - head.length - tail.length).fill(0);
  return segmentsFrom([...head, ...zeros, ...tail]);
}

export function parseIpAddress(text: string): IpAddress | null {
  const v4 = parseIpv4(text);
  if (v4 !== null) return { family: 4, octets: v4 };
  const v6 = parseIpv6(text);
  if (v6 !== null) return { family: 6, segments: v6 };
  return null;
}

/** Strips one pair of IPv6 brackets, as a CONNECT line or URL host carries them. */
export function unbracketHost(host: string): string {
  return host.startsWith("[") && host.endsWith("]") ? host.slice(1, -1) : host;
}

/** True when `host` is an IPv4 or IPv6 literal (brackets allowed). */
export function isIpLiteral(host: string): boolean {
  return parseIpAddress(unbracketHost(host)) !== null;
}

/* ------------------------------------------------------------------ *
 * Private-range classification (the ranges harbor's gateway refused)
 * ------------------------------------------------------------------ */

/**
 * Every IPv4 range no browser or gateway may reach on a user's behalf:
 * loopback, RFC1918, link-local, CGNAT, "this network", the IETF protocol
 * and benchmarking assignments, 6to4 relay anycast, the documentation nets,
 * and everything from multicast up through broadcast. One list, shared by
 * the desktop's bypass decision, the egress gateway and the cloud browser.
 */
export function ipv4IsPrivate(octets: Ipv4Octets): boolean {
  const [a, b, c] = octets;
  return (
    a === 127 || // loopback 127.0.0.0/8
    a === 10 || // RFC1918
    (a === 172 && b >= 16 && b <= 31) ||
    (a === 192 && b === 168) ||
    (a === 169 && b === 254) || // link-local
    a === 0 || // protocol-reserved "this network" 0.0.0.0/8
    (a === 100 && b >= 64 && b <= 127) || // CGNAT 100.64.0.0/10
    (a === 192 && b === 0 && c === 0) || // IETF protocol assignments 192.0.0.0/24
    (a === 192 && b === 88 && c === 99) || // 6to4 relay anycast 192.88.99.0/24
    (a === 198 && (b === 18 || b === 19)) || // benchmarking 198.18.0.0/15
    (a === 198 && b === 51 && c === 100) || // TEST-NET-2
    (a === 203 && b === 0 && c === 113) || // TEST-NET-3
    a >= 224 // multicast, reserved, broadcast
  );
}

/**
 * `::ffff:a.b.c.d` — must be judged as its embedded IPv4 address, or the
 * mapped form becomes a trivial bypass of every IPv4 refusal above.
 */
export function ipv4MappedAddress(segments: Ipv6Segments): Ipv4Octets | null {
  const [s0, s1, s2, s3, s4, s5, s6, s7] = segments;
  if (s0 !== 0 || s1 !== 0 || s2 !== 0 || s3 !== 0 || s4 !== 0 || s5 !== 0xffff) return null;
  return [s6 >> 8, s6 & 0xff, s7 >> 8, s7 & 0xff];
}

/** The IPv4 address an IPv6 transition form carries, judged as that address. */
function embeddedIpv4(segments: Ipv6Segments): Ipv4Octets | null {
  const [s0, s1, s2, s3, s4, s5, s6, s7] = segments;
  const zeroTo = (n: number): boolean => segments.slice(0, n).every((segment) => segment === 0);
  const tail = (): Ipv4Octets => [s6 >> 8, s6 & 0xff, s7 >> 8, s7 & 0xff];
  // ::ffff:a.b.c.d (mapped) and the deprecated ::a.b.c.d (compatible).
  if (zeroTo(5) && s5 === 0xffff) return tail();
  if (zeroTo(6)) return tail();
  // ::ffff:0:a.b.c.d IPv4-translatable (RFC 2765).
  if (zeroTo(4) && s4 === 0xffff && s5 === 0) return tail();
  // 64:ff9b::/96 well-known NAT64 prefix (RFC 6052).
  if (s0 === 0x0064 && s1 === 0xff9b && s2 === 0 && s3 === 0 && s4 === 0 && s5 === 0) return tail();
  // 2002::/16 6to4 embeds the IPv4 address right after the prefix.
  if (s0 === 0x2002) return [s1 >> 8, s1 & 0xff, s2 >> 8, s2 & 0xff];
  return null;
}

/**
 * IPv6 ranges refused alongside the IPv4 list: loopback, unspecified,
 * unique-local, link-local, deprecated site-local, multicast, the local-use
 * NAT64 /48, Teredo (which can tunnel to any IPv4 endpoint), and every
 * transition form that embeds a refused IPv4 address.
 */
export function ipv6IsPrivate(segments: Ipv6Segments): boolean {
  const [s0, s1, s2, s3, s4, s5, s6, s7] = segments;
  const leadingZeros =
    s0 === 0 && s1 === 0 && s2 === 0 && s3 === 0 && s4 === 0 && s5 === 0 && s6 === 0;
  if (leadingZeros && (s7 === 1 || s7 === 0)) return true; // ::1 and ::
  const embedded = embeddedIpv4(segments);
  if (embedded !== null) return ipv4IsPrivate(embedded);
  return (
    (s0 & 0xfe00) === 0xfc00 || // unique-local fc00::/7
    (s0 & 0xffc0) === 0xfe80 || // link-local fe80::/10
    (s0 & 0xffc0) === 0xfec0 || // deprecated site-local fec0::/10
    (s0 & 0xff00) === 0xff00 || // multicast ff00::/8
    (s0 === 0x0064 && s1 === 0xff9b && s2 === 1) || // NAT64 local-use 64:ff9b:1::/48
    (s0 === 0x2001 && s1 === 0) // Teredo 2001:0::/32
  );
}

export function ipIsPrivate(ip: IpAddress): boolean {
  return ip.family === 4 ? ipv4IsPrivate(ip.octets) : ipv6IsPrivate(ip.segments);
}
