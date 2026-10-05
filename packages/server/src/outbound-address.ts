/**
 * Outbound address safety helpers (SSRF protection).
 *
 * Validating a URL's *textual* hostname is not enough to keep server-side
 * requests away from internal networks: an attacker-controlled DNS name can
 * resolve (or later rebind) to a loopback, RFC1918, link-local, or other
 * non-global address. These helpers classify IP addresses, resolve hostnames
 * and reject the destination if ANY resolved address is non-global, and build
 * a `lookup` function that pins the connection to the validated addresses so a
 * second resolution inside the HTTP client cannot be rebound.
 */

import { lookup as dnsLookup, type LookupAddress } from "node:dns";
import { isIP } from "node:net";

function parseIPv4(ip: string): number | null {
    const parts = ip.split(".");
    if (parts.length !== 4) return null;
    let value = 0;
    for (const part of parts) {
        if (!/^\d{1,3}$/.test(part)) return null;
        const octet = Number(part);
        if (octet > 255) return null;
        value = value * 256 + octet;
    }
    return value;
}

/** Non-global IPv4 ranges (IANA special-purpose registry + multicast/reserved). */
const NON_GLOBAL_IPV4: ReadonlyArray<readonly [string, number]> = [
    ["0.0.0.0", 8],        // "this" network
    ["10.0.0.0", 8],       // RFC1918
    ["100.64.0.0", 10],    // CGNAT shared address space
    ["127.0.0.0", 8],      // loopback
    ["169.254.0.0", 16],   // link-local (incl. cloud metadata 169.254.169.254)
    ["172.16.0.0", 12],    // RFC1918
    ["192.0.0.0", 24],     // IETF protocol assignments
    ["192.0.2.0", 24],     // TEST-NET-1
    ["192.88.99.0", 24],   // 6to4 relay anycast (deprecated)
    ["192.168.0.0", 16],   // RFC1918
    ["198.18.0.0", 15],    // benchmarking
    ["198.51.100.0", 24],  // TEST-NET-2
    ["203.0.113.0", 24],   // TEST-NET-3
    ["224.0.0.0", 4],      // multicast
    ["240.0.0.0", 4],      // reserved + limited broadcast
];

const NON_GLOBAL_IPV4_RANGES = NON_GLOBAL_IPV4.map(([base, bits]) => {
    const start = parseIPv4(base) as number;
    const size = 2 ** (32 - bits);
    return { start, end: start + size - 1 };
});

function isPublicIPv4(ip: string): boolean {
    const value = parseIPv4(ip);
    if (value === null) return false;
    return !NON_GLOBAL_IPV4_RANGES.some((r) => value >= r.start && value <= r.end);
}

/** Parse an IPv6 address (optionally with an embedded dotted IPv4 tail) to 16 bytes. */
function parseIPv6(input: string): Uint8Array | null {
    let ip = input;
    // Strip zone index (fe80::1%eth0) — zones only appear on link-local, which we reject anyway.
    const zone = ip.indexOf("%");
    if (zone !== -1) ip = ip.slice(0, zone);

    let tail: number[] = [];
    const lastColon = ip.lastIndexOf(":");
    if (ip.slice(lastColon + 1).includes(".")) {
        const v4 = parseIPv4(ip.slice(lastColon + 1));
        if (v4 === null) return null;
        tail = [(v4 >>> 16) & 0xffff, v4 & 0xffff];
        ip = ip.slice(0, lastColon + 1) + "0:0";
    }

    const halves = ip.split("::");
    if (halves.length > 2) return null;
    const parseGroups = (s: string): number[] | null => {
        if (s === "") return [];
        const groups: number[] = [];
        for (const g of s.split(":")) {
            if (!/^[0-9a-f]{1,4}$/i.test(g)) return null;
            groups.push(parseInt(g, 16));
        }
        return groups;
    };
    const head = parseGroups(halves[0]);
    const rest = halves.length === 2 ? parseGroups(halves[1]) : [];
    if (!head || !rest) return null;
    let groups: number[];
    if (halves.length === 2) {
        const missing = 8 - head.length - rest.length;
        if (missing < 1) return null;
        groups = [...head, ...Array.from({ length: missing }, () => 0), ...rest];
    } else {
        groups = head;
    }
    if (groups.length !== 8) return null;
    if (tail.length === 2) {
        groups[6] = tail[0];
        groups[7] = tail[1];
    }
    const bytes = new Uint8Array(16);
    groups.forEach((g, i) => {
        bytes[i * 2] = (g >> 8) & 0xff;
        bytes[i * 2 + 1] = g & 0xff;
    });
    return bytes;
}

function isPublicIPv6(ip: string): boolean {
    const b = parseIPv6(ip);
    if (!b) return false;

    // IPv4-mapped (::ffff:a.b.c.d) — classify the embedded IPv4 address.
    const isMapped = b.slice(0, 10).every((x) => x === 0) && b[10] === 0xff && b[11] === 0xff;
    if (isMapped) return isPublicIPv4(`${b[12]}.${b[13]}.${b[14]}.${b[15]}`);

    // Only global unicast 2000::/3 is acceptable. This excludes ::, ::1,
    // NAT64 64:ff9b::/96, discard 100::/64, ULA fc00::/7, link-local
    // fe80::/10, site-local fec0::/10, and multicast ff00::/8.
    if ((b[0] & 0xe0) !== 0x20) return false;
    // 2001::/23 — IETF protocol assignments (Teredo 2001::/32, ORCHID, etc.)
    if (b[0] === 0x20 && b[1] === 0x01 && (b[2] & 0xfe) === 0x00) return false;
    // 2001:db8::/32 — documentation
    if (b[0] === 0x20 && b[1] === 0x01 && b[2] === 0x0d && b[3] === 0xb8) return false;
    // 2002::/16 — 6to4 (embeds arbitrary IPv4, including private ranges)
    if (b[0] === 0x20 && b[1] === 0x02) return false;
    return true;
}

/**
 * True only for globally routable unicast IP addresses. Returns false for
 * loopback, private, link-local, CGNAT, multicast, documentation, reserved,
 * and unparseable input. IPv6 literals may be passed with or without brackets.
 */
export function isPublicUnicastAddress(address: string): boolean {
    const ip = address.startsWith("[") && address.endsWith("]") ? address.slice(1, -1) : address;
    const family = isIP(ip);
    if (family === 4) return isPublicIPv4(ip);
    if (family === 6) return isPublicIPv6(ip);
    return false;
}

export type HostLookupFn = (hostname: string) => Promise<LookupAddress[]>;

const defaultHostLookup: HostLookupFn = (hostname) =>
    new Promise((resolve, reject) => {
        dnsLookup(hostname, { all: true, verbatim: true }, (err, addresses) => {
            if (err) reject(err);
            else resolve(addresses);
        });
    });

export class UnsafeOutboundAddressError extends Error {
    constructor(message: string) {
        super(message);
        this.name = "UnsafeOutboundAddressError";
    }
}

/**
 * Resolve `hostname` and return its addresses only if EVERY one is a public
 * unicast address. Throws {@link UnsafeOutboundAddressError} when the host
 * resolves to nothing or to any non-global address (fail closed: a name that
 * mixes public and private records could otherwise be steered internally).
 */
export async function resolvePublicAddresses(
    hostname: string,
    lookupHost: HostLookupFn = defaultHostLookup,
): Promise<LookupAddress[]> {
    const bare = hostname.startsWith("[") && hostname.endsWith("]") ? hostname.slice(1, -1) : hostname;
    const literalFamily = isIP(bare);
    if (literalFamily) {
        if (!isPublicUnicastAddress(bare)) {
            throw new UnsafeOutboundAddressError("Destination address is not a public unicast address");
        }
        return [{ address: bare, family: literalFamily }];
    }

    const addresses = await lookupHost(bare);
    if (addresses.length === 0) {
        throw new UnsafeOutboundAddressError("Destination host did not resolve to any address");
    }
    for (const entry of addresses) {
        if (!isPublicUnicastAddress(entry.address)) {
            throw new UnsafeOutboundAddressError("Destination host resolves to a non-public address");
        }
    }
    return addresses;
}

type LookupCallback = (
    err: NodeJS.ErrnoException | null,
    address: string | LookupAddress[],
    family?: number,
) => void;

/**
 * Build a `lookup` implementation (for `https.request` options) that ignores
 * the requested hostname and returns only the pre-validated addresses. The
 * request's `hostname` is still used for TLS SNI and certificate verification,
 * so pinning does not weaken TLS; it only prevents a second DNS resolution
 * from being rebound to an internal address between validation and connect.
 */
export function createPinnedLookup(addresses: LookupAddress[]) {
    const pinned = addresses.map((a) => ({ address: a.address, family: a.family }));
    return (_hostname: string, options: unknown, callback?: LookupCallback): void => {
        const cb = (typeof options === "function" ? options : callback) as LookupCallback;
        const opts = (typeof options === "object" && options !== null ? options : {}) as {
            all?: boolean;
            family?: number;
        };
        const candidates = opts.family === 4 || opts.family === 6
            ? pinned.filter((a) => a.family === opts.family)
            : pinned;
        if (candidates.length === 0) {
            const err = Object.assign(new Error("No pinned address for requested family"), { code: "ENOTFOUND" });
            cb(err, opts.all ? [] : "", undefined);
            return;
        }
        if (opts.all) cb(null, candidates);
        else cb(null, candidates[0].address, candidates[0].family);
    };
}
