/**
 * Textual validation of Web Push subscription endpoints (SSRF pre-check).
 *
 * Kept free of DB/VAPID state so the subscribe route and the delivery path
 * share one implementation.
 */

import { isPublicUnicastAddress } from "./outbound-address.js";

/**
 * Error shown when a push endpoint names an IPv6 literal host. Real push
 * services (FCM, Mozilla autopush, APNs web push, enterprise proxies) use DNS
 * hostnames. On the pinned Bun runtime (1.3.10) a real HTTPS request to an
 * IPv6-literal host fails certificate identity verification
 * (ERR_TLS_CERT_ALTNAME_INVALID) against a certificate carrying that IP SAN,
 * whether `servername` is omitted, bare or bracketed, and a custom
 * `checkServerIdentity` is not consulted. Rather than ship a delivery path
 * that cannot be verified, such endpoints are refused at subscribe time and
 * again at send time.
 */
export const IPV6_LITERAL_PUSH_ENDPOINT_ERROR =
    "Invalid push endpoint: IPv6-literal hosts are not supported; use a DNS hostname";

const GENERIC_PUSH_ENDPOINT_ERROR =
    "Invalid push endpoint: must be an https:// URL not targeting private/loopback addresses";

/**
 * Validate that a push subscription endpoint is safe to store.
 *
 * Requirements:
 *   1. Must be a valid URL.
 *   2. Must use the `https:` scheme.
 *   3. Hostname must not be `localhost`/`*.localhost`; an IPv4-literal
 *      hostname must be a public unicast address (see
 *      {@link isPublicUnicastAddress}); IPv6-literal hostnames (including
 *      IPv4-mapped forms) are not supported (see
 *      {@link IPV6_LITERAL_PUSH_ENDPOINT_ERROR}).
 *
 * The URL parser normalizes bare-integer / hex / octal IPv4 forms
 * (2130706433, 0x7f000001) to dotted-quad, so those are covered too. No
 * hostname allowlist is enforced: it would break enterprise proxies and custom
 * HTTPS push providers on public addresses.
 *
 * This is only a fast, textual pre-check. A DNS name can still resolve (or
 * later rebind) to an internal address, so delivery additionally resolves the
 * host, rejects any non-public address, and pins the connection to the
 * validated addresses — see `sendWebPushPinned` in push.ts.
 *
 * Returns null if the endpoint is acceptable, otherwise a user-facing reason.
 */
export function pushEndpointRejectionReason(endpoint: string): string | null {
    let parsed: URL;
    try {
        parsed = new URL(endpoint);
    } catch {
        return GENERIC_PUSH_ENDPOINT_ERROR;
    }

    // Must be HTTPS
    if (parsed.protocol !== "https:") return GENERIC_PUSH_ENDPOINT_ERROR;

    const host = parsed.hostname.toLowerCase();
    if (!host) return GENERIC_PUSH_ENDPOINT_ERROR;

    // Reject localhost / .localhost hostnames (hostname-based loopback).
    if (host === "localhost" || host.endsWith(".localhost")) return GENERIC_PUSH_ENDPOINT_ERROR;

    // IPv6 literal (bracketed by the URL API): not supported, see above.
    if (host.startsWith("[") || host.includes(":")) {
        // Keep the SSRF wording for non-public IPv6 targets; explain the
        // unsupported-literal restriction for otherwise-public ones.
        const bare = host.replace(/^\[(.*)\]$/, "$1");
        return isPublicUnicastAddress(bare) ? IPV6_LITERAL_PUSH_ENDPOINT_ERROR : GENERIC_PUSH_ENDPOINT_ERROR;
    }

    // IPv4 literal: must be public unicast.
    if (/^[\d.]+$/.test(host) && !isPublicUnicastAddress(host)) return GENERIC_PUSH_ENDPOINT_ERROR;

    return null;
}

/** True when {@link pushEndpointRejectionReason} accepts the endpoint. */
export function isValidPushEndpoint(endpoint: string): boolean {
    return pushEndpointRejectionReason(endpoint) === null;
}
