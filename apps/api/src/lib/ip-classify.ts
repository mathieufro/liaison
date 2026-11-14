// SPDX-License-Identifier: FSL-1.1-ALv2
/**
 * Pure classifiers of an address token: private / loopback / reserved, and
 * the always-refused link-local and metadata addresses. No I/O and no
 * environment, so offline code (the CLI's adapter validation) can use the
 * same rules as the outbound-fetch egress guard that imports them.
 */

/**
 * Parse a host token as an IPv4 address into a 32-bit unsigned integer, or
 * return `null` if it is not parseable as IPv4. Accepts the obscure but valid
 * encodings the kernel's URL/`net` layers will happily dial: decimal-encoded
 * (`2130706433`), octal octets (`0177.0.0.1`), and hex octets (`0x7f.0.0.1`).
 * Rejecting these by value (not by string prefix) closes the decimal/octal
 * SSRF bypass.
 */
function parseIpv4ToInt(host: string): number | null {
  const parts = host.split(".")
  if (parts.length === 0 || parts.length > 4) return null

  const parsePart = (s: string): number | null => {
    if (s.length === 0) return null
    let value: number
    if (/^0[xX][0-9a-fA-F]+$/.test(s)) {
      value = Number.parseInt(s, 16)
    } else if (/^0[0-7]+$/.test(s)) {
      value = Number.parseInt(s, 8)
    } else if (/^[0-9]+$/.test(s)) {
      value = Number.parseInt(s, 10)
    } else {
      return null
    }
    return Number.isNaN(value) ? null : value
  }

  // Dotted forms: a, a.b, a.b.c, a.b.c.d (inet_aton semantics — the last part
  // absorbs the remaining low-order bytes).
  const nums: number[] = []
  for (const p of parts) {
    const n = parsePart(p)
    if (n === null) return null
    nums.push(n)
  }

  // The switch below reads only the parts its arm's length guarantees.
  const [a = 0, b = 0, c = 0, d = 0] = nums
  let result: number
  switch (nums.length) {
    case 1: {
      if (a > 0xffffffff) return null
      result = a
      break
    }
    case 2: {
      if (a > 0xff || b > 0xffffff) return null
      result = (a << 24) | b
      break
    }
    case 3: {
      if (a > 0xff || b > 0xff || c > 0xffff) return null
      result = (a << 24) | (b << 16) | c
      break
    }
    default: {
      if (nums.some((n) => n > 0xff)) return null
      result = (a << 24) | (b << 16) | (c << 8) | d
      break
    }
  }
  return result >>> 0
}

/**
 * True when the 32-bit IPv4 address falls in a non-routable / loopback /
 * link-local / unspecified range (CIDR comparison, not string prefix).
 */
function isPrivateIpv4Int(addr: number): boolean {
  const inRange = (base: string, prefix: number): boolean => {
    const baseInt = parseIpv4ToInt(base)
    if (baseInt === null) return false
    const mask = prefix === 0 ? 0 : (0xffffffff << (32 - prefix)) >>> 0
    return (addr & mask) === (baseInt & mask)
  }
  return (
    inRange("0.0.0.0", 8) || // "this" network + unspecified
    inRange("10.0.0.0", 8) || // RFC1918
    inRange("100.64.0.0", 10) || // CGNAT
    inRange("127.0.0.0", 8) || // loopback
    inRange("169.254.0.0", 16) || // link-local (cloud IMDS)
    inRange("168.63.129.16", 32) || // Azure wire server / metadata helper (a public-looking address)
    inRange("172.16.0.0", 12) || // RFC1918
    inRange("192.0.0.0", 24) || // IETF protocol assignments
    inRange("192.168.0.0", 16) || // RFC1918
    inRange("192.0.2.0", 24) || // documentation (TEST-NET-1)
    inRange("198.18.0.0", 15) || // benchmarking
    inRange("198.51.100.0", 24) || // documentation (TEST-NET-2)
    inRange("203.0.113.0", 24) || // documentation (TEST-NET-3)
    inRange("224.0.0.0", 4) || // multicast
    inRange("240.0.0.0", 4) // reserved + broadcast
  )
}

/**
 * Normalize a host token for private-range classification:
 *   - lowercase (so `FD00::1`, `0X7F...` etc. match)
 *   - strip surrounding brackets (`[::1]` → `::1`)
 *   - unwrap IPv4-mapped/-compatible IPv6 (`::ffff:127.0.0.1`, `::ffff:0:a.b.c.d`,
 *     `::a.b.c.d`) to the embedded IPv4 so it is re-classified as the IPv4 it
 *     actually reaches. This closes the IPv4-mapped-IPv6 SSRF hole that let
 *     `::ffff:169.254.169.254` past every prefix check.
 */
function normalizeHostForClassification(ip: string): string {
  let host = ip.trim().toLowerCase()
  if (host.startsWith("[") && host.endsWith("]")) {
    host = host.slice(1, -1)
  }
  // Drop an IPv6 zone id (`fe80::1%eth0`) before matching.
  const pct = host.indexOf("%")
  if (pct !== -1) host = host.slice(0, pct)

  // IPv4-mapped (`::ffff:a.b.c.d`), IPv4-mapped with explicit zero block
  // (`::ffff:0:a.b.c.d`), or IPv4-compatible (`::a.b.c.d`) — unwrap to the
  // trailing IPv4 literal.
  const mapped = host.match(/^::(?:ffff:)?(?:0:)?((?:\d{1,3}\.){3}\d{1,3})$/)
  if (mapped?.[1]) return mapped[1]
  // IPv4-mapped where the address is given in hex words (`::ffff:7f00:1`).
  const hexMapped = host.match(/^::ffff:([0-9a-f]{1,4}):([0-9a-f]{1,4})$/)
  if (hexMapped?.[1] && hexMapped[2]) {
    const hi = Number.parseInt(hexMapped[1], 16)
    const lo = Number.parseInt(hexMapped[2], 16)
    if (!Number.isNaN(hi) && !Number.isNaN(lo)) {
      const a = (hi >> 8) & 0xff
      const b = hi & 0xff
      const c = (lo >> 8) & 0xff
      const d = lo & 0xff
      return `${a}.${b}.${c}.${d}`
    }
  }
  return host
}

/**
 * Expand an IPv6 literal (with `::` compression and an optional dotted IPv4
 * tail) to its eight 16-bit groups, or null when it is not a valid literal.
 */
function parseIpv6Groups(host: string): number[] | null {
  let text = host
  const tail = text.match(/(\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3})$/)
  if (tail) {
    const v4 = parseIpv4ToInt(tail[1] as string)
    if (v4 === null) return null
    text = `${text.slice(0, -tail[1]!.length)}${((v4 >>> 16) & 0xffff).toString(16)}:${(v4 & 0xffff).toString(16)}`
  }
  const halves = text.split("::")
  if (halves.length > 2) return null
  const parse = (part: string): number[] | null => {
    if (part === "") return []
    const groups = part.split(":")
    const out: number[] = []
    for (const g of groups) {
      if (!/^[0-9a-f]{1,4}$/.test(g)) return null
      out.push(Number.parseInt(g, 16))
    }
    return out
  }
  const head = parse(halves[0] as string)
  if (!head) return null
  if (halves.length === 1) return head.length === 8 ? head : null
  const rest = parse(halves[1] as string)
  if (!rest) return null
  const missing = 8 - head.length - rest.length
  if (missing < 1) return null
  return [...head, ...new Array<number>(missing).fill(0), ...rest]
}

function embeddedIpv4(hi: number, lo: number): number {
  return (((hi & 0xffff) << 16) | (lo & 0xffff)) >>> 0
}

/**
 * IPv6 classification by value. Addresses that EMBED an IPv4 address (the
 * IPv4-compatible `::/96`, IPv4-mapped `::ffff:0:0/96`, NAT64 `64:ff9b::/96`,
 * 6to4 `2002::/16`) take the verdict of the IPv4 they reach: on a host with
 * NAT64 or 6to4 routing `64:ff9b::a00:1` is 10.0.0.1. Ranges that are never
 * public unicast (ULA, link-local, site-local, multicast, documentation,
 * Teredo, local-use NAT64) are private outright.
 */
function isPrivateIpv6(host: string): boolean {
  const g = parseIpv6Groups(host)
  if (!g) return true // not a valid literal: refuse rather than guess
  const [g0, g1, g2, g3, g4, g5, g6, g7] = g as [
    number,
    number,
    number,
    number,
    number,
    number,
    number,
    number,
  ]
  const first96Zero = g0 === 0 && g1 === 0 && g2 === 0 && g3 === 0 && g4 === 0 && g5 === 0
  if (first96Zero) return isPrivateIpv4Int(embeddedIpv4(g6, g7)) // ::, ::1, ::a.b.c.d
  if (g0 === 0 && g1 === 0 && g2 === 0 && g3 === 0 && g4 === 0 && g5 === 0xffff) {
    return isPrivateIpv4Int(embeddedIpv4(g6, g7)) // ::ffff:a.b.c.d
  }
  if (g0 === 0 && g1 === 0 && g2 === 0 && g3 === 0 && g4 === 0xffff && g5 === 0) {
    return isPrivateIpv4Int(embeddedIpv4(g6, g7)) // ::ffff:0:a.b.c.d (SIIT)
  }
  if (g0 === 0x64 && g1 === 0xff9b) {
    if (g2 === 0 && g3 === 0 && g4 === 0 && g5 === 0) return isPrivateIpv4Int(embeddedIpv4(g6, g7))
    return true // 64:ff9b:1::/48 local-use NAT64
  }
  if (g0 === 0x2002) return isPrivateIpv4Int(embeddedIpv4(g1, g2)) // 6to4
  if ((g0 & 0xfe00) === 0xfc00) return true // fc00::/7 unique-local
  if ((g0 & 0xffc0) === 0xfe80) return true // fe80::/10 link-local
  if ((g0 & 0xffc0) === 0xfec0) return true // fec0::/10 site-local (deprecated)
  if ((g0 & 0xff00) === 0xff00) return true // ff00::/8 multicast
  if (g0 === 0x2001 && g1 === 0x0db8) return true // 2001:db8::/32 documentation
  if (g0 === 0x2001 && g1 === 0) return true // 2001::/32 Teredo
  return false
}

/**
 * Classify a host token as pointing at a private / loopback / link-local /
 * reserved network. Works on bare hostnames, IPv4 literals (including obscure
 * decimal/octal/hex encodings), bracketed or bare IPv6 literals, and
 * IPv4-mapped/-compatible IPv6. Comparison is by value (CIDR / canonical IPv6),
 * never by string prefix, so encoding tricks cannot slip past.
 */
export function isPrivateIp(ip: string): boolean {
  if (!ip) return false
  const host = normalizeHostForClassification(ip)

  if (host === "localhost") return true

  // IPv4 (any encoding) → integer → CIDR classification.
  const v4 = parseIpv4ToInt(host)
  if (v4 !== null) return isPrivateIpv4Int(v4)

  // IPv6 literal classification.
  if (host.includes(":")) return isPrivateIpv6(host)

  return false
}

/**
 * Addresses no outbound call may reach, whatever the caller allows: link-local
 * (169.254.0.0/16, where cloud instance metadata answers, and fe80::/10), the
 * unspecified network, and the known metadata helpers (Azure's wire server,
 * AWS's IPv6 metadata endpoint). A caller that may reach PRIVATE addresses
 * (`allowPrivate`, an operator's own model server on the LAN) still never
 * reaches these.
 */
export function isAlwaysBlockedIp(ip: string): boolean {
  if (!ip) return false
  const host = normalizeHostForClassification(ip)
  const v4 = parseIpv4ToInt(host)
  if (v4 !== null) return isAlwaysBlockedIpv4Int(v4)
  if (!host.includes(":")) return false
  const g = parseIpv6Groups(host)
  if (!g) return true
  const [g0, g1, g2, g3, g4, g5, g6, g7] = g as [
    number,
    number,
    number,
    number,
    number,
    number,
    number,
    number,
  ]
  if ((g0 & 0xffc0) === 0xfe80) return true // fe80::/10 link-local
  if (g0 === 0xfd00 && g1 === 0x0ec2 && g2 === 0 && g3 === 0 && g7 === 0x254) return true // AWS IMDS
  const first80Zero = g0 === 0 && g1 === 0 && g2 === 0 && g3 === 0 && g4 === 0
  if (first80Zero && (g5 === 0 || g5 === 0xffff)) {
    if (g5 === 0 && g6 === 0 && g7 <= 1) return g7 === 0 // :: unspecified (::1 is loopback)
    return isAlwaysBlockedIpv4Int(embeddedIpv4(g6, g7))
  }
  if (g0 === 0x64 && g1 === 0xff9b) return isAlwaysBlockedIpv4Int(embeddedIpv4(g6, g7))
  if (g0 === 0x2002) return isAlwaysBlockedIpv4Int(embeddedIpv4(g1, g2))
  return false
}

function isAlwaysBlockedIpv4Int(addr: number): boolean {
  const inRange = (base: string, prefix: number): boolean => {
    const baseInt = parseIpv4ToInt(base)
    if (baseInt === null) return false
    const mask = prefix === 0 ? 0 : (0xffffffff << (32 - prefix)) >>> 0
    return (addr & mask) === (baseInt & mask)
  }
  return inRange("0.0.0.0", 8) || inRange("169.254.0.0", 16) || inRange("168.63.129.16", 32)
}
