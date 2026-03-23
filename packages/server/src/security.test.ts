import { describe, expect, test, beforeAll, afterAll } from "bun:test";
import { RateLimiter, isValidEmail, isValidPassword, cwdMatchesRoots, getClientIp } from "./security";

describe("RateLimiter", () => {
    test("allows requests within limit", () => {
        const limiter = new RateLimiter(2, 1000);
        const ip = "127.0.0.1";

        expect(limiter.check(ip)).toBe(true);
        expect(limiter.check(ip)).toBe(true);
        limiter.destroy();
    });

    test("blocks requests over limit", () => {
        const limiter = new RateLimiter(2, 1000);
        const ip = "127.0.0.2";

        expect(limiter.check(ip)).toBe(true);
        expect(limiter.check(ip)).toBe(true);
        expect(limiter.check(ip)).toBe(false);
        limiter.destroy();
    });

    test("resets after window expires", async () => {
        const limiter = new RateLimiter(1, 100);
        const ip = "127.0.0.3";

        expect(limiter.check(ip)).toBe(true);
        expect(limiter.check(ip)).toBe(false);

        await new Promise(resolve => setTimeout(resolve, 150));

        expect(limiter.check(ip)).toBe(true);
        limiter.destroy();
    });

    test("tracks different keys independently", () => {
        const limiter = new RateLimiter(1, 1000);
        expect(limiter.check("ip-a")).toBe(true);
        expect(limiter.check("ip-b")).toBe(true);
        expect(limiter.check("ip-a")).toBe(false);
        expect(limiter.check("ip-b")).toBe(false);
        limiter.destroy();
    });

    test("limit of 1 blocks second request immediately", () => {
        const limiter = new RateLimiter(1, 60000);
        expect(limiter.check("x")).toBe(true);
        expect(limiter.check("x")).toBe(false);
        expect(limiter.check("x")).toBe(false);
        limiter.destroy();
    });

    test("cleanup removes expired entries", async () => {
        const limiter = new RateLimiter(1, 50);
        limiter.check("a");
        limiter.check("b");
        // Both should have entries now
        expect(limiter.check("a")).toBe(false);

        await new Promise(resolve => setTimeout(resolve, 100));

        // After window expires, both should be allowed again
        expect(limiter.check("a")).toBe(true);
        expect(limiter.check("b")).toBe(true);
        limiter.destroy();
    });
});

describe("isValidEmail", () => {
    test("accepts standard emails", () => {
        expect(isValidEmail("test@example.com")).toBe(true);
        expect(isValidEmail("user.name+tag@sub.domain.co.uk")).toBe(true);
    });

    test("accepts emails with local part exactly 64 chars", () => {
        const localPart = "a".repeat(64);
        expect(isValidEmail(`${localPart}@example.com`)).toBe(true);
    });

    test("accepts valid emails near the 254 char limit", () => {
        // Build a domain using multiple labels each ≤ 63 chars (DNS max per label).
        // Three labels: 63 + 63 + 58 chars, plus dots and a 2-char TLD = 189 chars.
        // localPart (64) + "@" (1) + domain (189) = 254 bytes — exactly at the RFC limit.
        const label63 = "d".repeat(63);
        const label58 = "d".repeat(58);
        const fullDomain = `${label63}.${label63}.${label58}.co`;
        const localPart = "a".repeat(64);
        expect(isValidEmail(`${localPart}@${fullDomain}`)).toBe(true);
    });

    test("rejects emails with > 64 chars in local part", () => {
        const localPart = "a".repeat(65);
        expect(isValidEmail(`${localPart}@example.com`)).toBe(false);
    });

    test("rejects emails > 254 chars total length", () => {
        const localPart = "a".repeat(60);
        // Make domain large enough to exceed 254 chars
        const domain = "d".repeat(200) + ".com";
        expect(isValidEmail(`${localPart}@${domain}`)).toBe(false);
    });

    test("rejects emails with single char TLD", () => {
        expect(isValidEmail("a@b.c")).toBe(false);
    });

    test("rejects emails without @", () => {
        expect(isValidEmail("invalid")).toBe(false);
        expect(isValidEmail("just-text")).toBe(false);
    });

    test("rejects emails with missing parts", () => {
        expect(isValidEmail("user@")).toBe(false);
        expect(isValidEmail("@domain.com")).toBe(false);
        expect(isValidEmail("@")).toBe(false);
    });

    test("rejects emails with spaces", () => {
        expect(isValidEmail("user @example.com")).toBe(false);
        expect(isValidEmail("user@ example.com")).toBe(false);
        expect(isValidEmail(" user@example.com")).toBe(false);
    });

    test("rejects empty string", () => {
        expect(isValidEmail("")).toBe(false);
    });

    test("rejects emails without TLD dot", () => {
        expect(isValidEmail("user@domain")).toBe(false);
    });

    // --- Multibyte / Unicode byte-length tests (P1) ---

    test("accepts multibyte local part at exactly 64 UTF-8 bytes (32 × 'é')", () => {
        // 'é' (U+00E9) encodes to 2 bytes in UTF-8; 32 × 2 = 64 bytes — at the RFC limit.
        // A character-count check would see only 32 chars, well under 64.
        const localPart = "é".repeat(32);
        expect(isValidEmail(`${localPart}@example.com`)).toBe(true);
    });

    test("rejects multibyte local part that exceeds 64 UTF-8 bytes but not 64 characters", () => {
        // 33 × 'é' = 66 UTF-8 bytes > 64-byte RFC limit, but only 33 JS characters.
        // Old character-count regex {1,64} would incorrectly accept this.
        const localPart = "é".repeat(33);
        expect(isValidEmail(`${localPart}@example.com`)).toBe(false);
    });

    test("rejects email whose total byte length exceeds 254 but character count does not", () => {
        // ASCII local part: 64 bytes.  '@': 1 byte.  Domain uses 'é' (2 bytes each).
        // domain = 94 × 'é' + ".com" = 188 + 4 = 192 bytes  →  total = 257 bytes > 254.
        // Character count: 64 + 1 + 94 + 4 = 163 — well under 254, so old code passes it.
        const localPart = "a".repeat(64);
        const domainLabel = "é".repeat(94);
        expect(isValidEmail(`${localPart}@${domainLabel}.com`)).toBe(false);
    });

    test("rejects email with non-ASCII chars in domain (strict DNS label validation)", () => {
        // DNS labels are restricted to [a-zA-Z0-9-] (RFC 1035). Non-ASCII characters
        // such as 'é' are not valid in a literal domain label and must be rejected,
        // regardless of whether the total byte length is within the 254-byte limit.
        const localPart = "a".repeat(32);
        const domainLabel = "é".repeat(32); // Total bytes well under 254, but invalid DNS chars.
        expect(isValidEmail(`${localPart}@${domainLabel}.com`)).toBe(false);
    });

    // --- Malformed domain tests (P2) ---

    test("rejects domain with consecutive dots", () => {
        expect(isValidEmail("a@..example.com")).toBe(false);
        expect(isValidEmail("a@example..com")).toBe(false);
        expect(isValidEmail("a@sub..example.com")).toBe(false);
    });

    test("rejects domain with a leading dot", () => {
        expect(isValidEmail("a@.example.com")).toBe(false);
    });

    test("rejects domain with a trailing dot", () => {
        expect(isValidEmail("a@example.com.")).toBe(false);
    });

    test("rejects domain that is only dots", () => {
        expect(isValidEmail("a@...")).toBe(false);
        expect(isValidEmail("a@.")).toBe(false);
    });

    // --- DNS label constraint tests (RFC 1035) ---

    test("accepts domain labels up to 63 chars", () => {
        const label = "a".repeat(63);
        expect(isValidEmail(`user@${label}.com`)).toBe(true);
    });

    test("rejects domain label exceeding 63 chars", () => {
        const label = "a".repeat(64);
        expect(isValidEmail(`user@${label}.com`)).toBe(false);
    });

    test("rejects domain label starting with a hyphen", () => {
        expect(isValidEmail("user@-label.com")).toBe(false);
        expect(isValidEmail("user@sub.-label.com")).toBe(false);
    });

    test("rejects domain label ending with a hyphen", () => {
        expect(isValidEmail("user@label-.com")).toBe(false);
        expect(isValidEmail("user@sub.label-.com")).toBe(false);
    });

    test("accepts domain labels with interior hyphens", () => {
        expect(isValidEmail("user@my-domain.com")).toBe(true);
        expect(isValidEmail("user@my-long-domain-name.co.uk")).toBe(true);
    });

    test("rejects domain label with invalid characters (underscores, dots within label)", () => {
        expect(isValidEmail("user@_dmarc.example.com")).toBe(false);
        expect(isValidEmail("user@exam_ple.com")).toBe(false);
    });

    test("rejects domain total length > 253 chars", () => {
        // 4 labels of 63 chars + dots = 63*4 + 3 = 255 > 253
        const label = "d".repeat(63);
        const domain = `${label}.${label}.${label}.${label}`;
        expect(isValidEmail(`user@${domain}`)).toBe(false);
    });

    test("accepts domain near max length (252 chars) with 1-char local part", () => {
        // A 253-char domain cannot appear in a valid email: even with the minimum
        // 1-char local part, total = 1 + "@"(1) + 253 = 255 bytes > 254-byte RFC limit.
        // 252-char domain with 1-char local = 254 bytes — exactly at the RFC limit.
        // Build: 3 × 63-char labels + 1 × 60-char label + 3 dots = 63*3+60+3 = 252 chars.
        const label63 = "d".repeat(63);
        const label60 = "d".repeat(60);
        const domain = `${label63}.${label63}.${label63}.${label60}`;
        expect(domain.length).toBe(252);
        expect(isValidEmail(`a@${domain}`)).toBe(true);
    });
});

describe("isValidPassword", () => {
    test("accepts valid passwords (>=8 chars, 1 upper, 1 lower, 1 number)", () => {
        expect(isValidPassword("Abc12345")).toBe(true);
        expect(isValidPassword("ComplexPass1")).toBe(true);
        expect(isValidPassword("1234Abcd")).toBe(true);
    });

    test("rejects passwords < 8 characters", () => {
        expect(isValidPassword("Short1A")).toBe(false);
        expect(isValidPassword("1234567")).toBe(false);
        expect(isValidPassword("")).toBe(false);
    });

    test("rejects passwords missing required character types", () => {
        // No uppercase
        expect(isValidPassword("abcdefg1")).toBe(false);
        // No lowercase
        expect(isValidPassword("ABCDEFG1")).toBe(false);
        // No number
        expect(isValidPassword("Abcdefgh")).toBe(false);
    });

    test("cwdMatchesRoots", () => {
        const root = "/home/user/project";
        // Exact match
        expect(cwdMatchesRoots([root], "/home/user/project")).toBe(true);
        // Child directory
        expect(cwdMatchesRoots([root], "/home/user/project/src")).toBe(true);

        // Path traversal attempts
        expect(cwdMatchesRoots([root], "/home/user/project/../../etc/passwd")).toBe(false);
        expect(cwdMatchesRoots([root], "/home/user/project/src/../../../etc/passwd")).toBe(false);

        // Partial folder name match (should fail)
        expect(cwdMatchesRoots([root], "/home/user/project-secret")).toBe(false);

        // Outside directory
        expect(cwdMatchesRoots([root], "/etc/passwd")).toBe(false);

        // Multiple roots
        const roots = ["/app/data", "/tmp"];
        expect(cwdMatchesRoots(roots, "/app/data/file.txt")).toBe(true);
        expect(cwdMatchesRoots(roots, "/tmp/temp.txt")).toBe(true);
        expect(cwdMatchesRoots(roots, "/app/config")).toBe(false);
    });

    test("cwdMatchesRoots — filesystem root '/' matches everything", () => {
        // Root "/" is a special case — everything is under it
        expect(cwdMatchesRoots(["/"], "/home/user/project")).toBe(true);
        expect(cwdMatchesRoots(["/"], "/etc/passwd")).toBe(true);
        expect(cwdMatchesRoots(["/"], "/")).toBe(true);
    });

    test("cwdMatchesRoots — Windows-style paths are case-insensitive", () => {
        const root = "C:\\Users\\Admin\\Project";
        // Same path, different case
        expect(cwdMatchesRoots([root], "C:\\Users\\Admin\\Project")).toBe(true);
        expect(cwdMatchesRoots([root], "c:\\users\\admin\\project")).toBe(true);
        expect(cwdMatchesRoots([root], "C:\\Users\\Admin\\Project\\src")).toBe(true);
        expect(cwdMatchesRoots([root], "c:\\users\\admin\\project\\src")).toBe(true);

        // Should NOT match unrelated Windows path
        expect(cwdMatchesRoots([root], "C:\\Users\\Other\\Project")).toBe(false);
    });

    test("cwdMatchesRoots — path traversal via '..' is normalized", () => {
        const root = "/home/user/project";
        // ".." that collapses back into the allowed root should pass
        expect(cwdMatchesRoots([root], "/home/user/project/a/b/../../c")).toBe(true);

        // ".." that escapes the root should fail
        expect(cwdMatchesRoots([root], "/home/user/project/../other-project")).toBe(false);
        expect(cwdMatchesRoots([root], "/home/user/project/a/../../../../etc")).toBe(false);
    });

    test("cwdMatchesRoots — trailing slashes are normalized", () => {
        const root = "/home/user/project";
        expect(cwdMatchesRoots([root], "/home/user/project/")).toBe(true);
        expect(cwdMatchesRoots(["/home/user/project/"], "/home/user/project")).toBe(true);
        expect(cwdMatchesRoots(["/home/user/project/"], "/home/user/project/src")).toBe(true);
    });
});

describe("getClientIp", () => {
    const makeReq = (headers: Record<string, string>) =>
        new Request("http://localhost/test", { headers });

    const originalTrustProxy = process.env.PIZZAPI_TRUST_PROXY;
    const originalProxyDepth = process.env.PIZZAPI_PROXY_DEPTH;
    afterAll(() => {
        if (originalTrustProxy === undefined) delete process.env.PIZZAPI_TRUST_PROXY;
        else process.env.PIZZAPI_TRUST_PROXY = originalTrustProxy;
        if (originalProxyDepth === undefined) delete process.env.PIZZAPI_PROXY_DEPTH;
        else process.env.PIZZAPI_PROXY_DEPTH = originalProxyDepth;
    });

    test("returns x-pizzapi-client-ip for direct connections", () => {
        delete process.env.PIZZAPI_TRUST_PROXY;
        const req = makeReq({ "x-pizzapi-client-ip": "203.0.113.50" });
        expect(getClientIp(req)).toBe("203.0.113.50");
    });

    test("does not trust x-forwarded-for for public IPs", () => {
        delete process.env.PIZZAPI_TRUST_PROXY;
        const req = makeReq({
            "x-pizzapi-client-ip": "203.0.113.50",
            "x-forwarded-for": "198.51.100.1",
        });
        expect(getClientIp(req)).toBe("203.0.113.50");
    });

    test("auto-detects reverse proxy when remoteAddress is 127.0.0.1", () => {
        delete process.env.PIZZAPI_TRUST_PROXY;
        const req = makeReq({
            "x-pizzapi-client-ip": "127.0.0.1",
            "x-forwarded-for": "198.51.100.1",
        });
        expect(getClientIp(req)).toBe("198.51.100.1");
    });

    test("auto-detects reverse proxy when remoteAddress is IPv4-mapped ::ffff:127.0.0.1", () => {
        delete process.env.PIZZAPI_TRUST_PROXY;
        const req = makeReq({
            "x-pizzapi-client-ip": "::ffff:127.0.0.1",
            "x-forwarded-for": "198.51.100.1",
        });
        expect(getClientIp(req)).toBe("198.51.100.1");
    });

    test("uses right-most XFF entry to prevent client spoofing (single proxy)", () => {
        delete process.env.PIZZAPI_TRUST_PROXY;
        delete process.env.PIZZAPI_PROXY_DEPTH;
        // nginx $proxy_add_x_forwarded_for appends $remote_addr to any existing header:
        //   Client sends: X-Forwarded-For: 1.2.3.4 (spoofed)
        //   Proxy appends: X-Forwarded-For: 1.2.3.4, 203.0.113.50 (real client IP)
        // Right-most is the proxy-appended real client IP.
        const req = makeReq({
            "x-pizzapi-client-ip": "127.0.0.1",
            "x-forwarded-for": "1.2.3.4, 203.0.113.50",
        });
        expect(getClientIp(req)).toBe("203.0.113.50");
    });

    test("uses right-most XFF entry with TRUST_PROXY=true", () => {
        process.env.PIZZAPI_TRUST_PROXY = "true";
        delete process.env.PIZZAPI_PROXY_DEPTH;
        const req = makeReq({
            "x-pizzapi-client-ip": "172.17.0.1",
            "x-forwarded-for": "203.0.113.99, 10.0.0.1",
        });
        // Right-most entry (10.0.0.1) is the proxy-appended real client (depth=0 default)
        expect(getClientIp(req)).toBe("10.0.0.1");
    });

    test("PIZZAPI_PROXY_DEPTH=1 accepts the normal two-hop chain with 2 entries", () => {
        process.env.PIZZAPI_TRUST_PROXY = "true";
        process.env.PIZZAPI_PROXY_DEPTH = "1";
        // Typical CDN → local proxy → PizzaPi request with no client-supplied XFF:
        //   XFF: <real-client>, <cdn-proxy>
        const req = makeReq({
            "x-pizzapi-client-ip": "172.17.0.1",
            "x-forwarded-for": "203.0.113.50, 198.51.100.5",
        });
        expect(getClientIp(req)).toBe("203.0.113.50");
        delete process.env.PIZZAPI_PROXY_DEPTH;
    });

    test("fails closed to socket IP when PIZZAPI_PROXY_DEPTH exceeds XFF chain length", () => {
        process.env.PIZZAPI_TRUST_PROXY = "true";
        process.env.PIZZAPI_PROXY_DEPTH = "3";
        // Only 2 hops in the chain but depth expects 3 — depth >= parts.length,
        // so we can't safely identify the real client.
        const req = makeReq({
            "x-pizzapi-client-ip": "172.17.0.1",
            "x-forwarded-for": "203.0.113.50, 198.51.100.5",
        });
        // Falls back to the raw socket/proxy IP so callers can still apply
        // per-IP rate limiting instead of skipping it entirely.
        expect(getClientIp(req)).toBe("172.17.0.1");
        delete process.env.PIZZAPI_PROXY_DEPTH;
    });

    test("fails closed to socket IP when PIZZAPI_PROXY_DEPTH equals XFF chain length (padding attack)", () => {
        process.env.PIZZAPI_TRUST_PROXY = "true";
        process.env.PIZZAPI_PROXY_DEPTH = "2";
        // Chain too short for depth=2.
        const req = makeReq({
            "x-pizzapi-client-ip": "172.17.0.1",
            "x-forwarded-for": "1.2.3.4, 5.6.7.8",
        });
        expect(getClientIp(req)).toBe("172.17.0.1");
        delete process.env.PIZZAPI_PROXY_DEPTH;
    });

    test("accepts padded XFF chain when depth>0 and reads the correct right-anchored slot", () => {
        process.env.PIZZAPI_TRUST_PROXY = "true";
        process.env.PIZZAPI_PROXY_DEPTH = "2";
        // depth=2 expects 3 entries minimum. With 4 entries the client has prepended
        // a bogus left-side hop. The formula parts[parts.length - 1 - depth] still
        // reads from the right, so the correct client slot is unaffected.
        //   parts = ["1.1.1.1", "2.2.2.2", "3.3.3.3", "203.0.113.50"]
        //   index = 4 - 1 - 2 = 1 → "2.2.2.2" (the outermost trusted proxy's view of client)
        const req = makeReq({
            "x-pizzapi-client-ip": "172.17.0.1",
            "x-forwarded-for": "1.1.1.1, 2.2.2.2, 3.3.3.3, 203.0.113.50",
        });
        expect(getClientIp(req)).toBe("2.2.2.2");
        delete process.env.PIZZAPI_PROXY_DEPTH;
    });

    test("accepts padded XFF chain when depth=1 and returns the CDN-appended real client IP", () => {
        // With depth=1 (CDN → local proxy → server), each trusted proxy appends its peer:
        //   Client sends request → CDN appends real client IP → local proxy appends CDN IP
        // XFF = "evil-spoofed, 203.0.113.50, 198.51.100.5"
        //   parts[3 - 1 - 1] = parts[1] = "203.0.113.50" (what the CDN saw as client)
        // Left-side padding cannot shift the right-anchored trusted slots.
        process.env.PIZZAPI_TRUST_PROXY = "true";
        process.env.PIZZAPI_PROXY_DEPTH = "1";
        const req = makeReq({
            "x-pizzapi-client-ip": "172.17.0.1",
            "x-forwarded-for": "evil-spoofed, 203.0.113.50, 198.51.100.5",
        });
        expect(getClientIp(req)).toBe("203.0.113.50");
        delete process.env.PIZZAPI_PROXY_DEPTH;
    });

    test("single-entry XFF returns that entry (depth=0 default)", () => {
        delete process.env.PIZZAPI_TRUST_PROXY;
        delete process.env.PIZZAPI_PROXY_DEPTH;
        const req = makeReq({
            "x-pizzapi-client-ip": "127.0.0.1",
            "x-forwarded-for": "203.0.113.50",
        });
        // depth=0 (default): parts.length=1 > depth=0 → proceed, index=0 → client_ip
        expect(getClientIp(req)).toBe("203.0.113.50");
    });

    test("does NOT auto-trust XFF for private (non-loopback) IPs like 192.168.x.x", () => {
        delete process.env.PIZZAPI_TRUST_PROXY;
        const req = makeReq({
            "x-pizzapi-client-ip": "192.168.1.1",
            "x-forwarded-for": "198.51.100.1",
        });
        // Private IPs are NOT auto-trusted — they could be direct LAN clients
        expect(getClientIp(req)).toBe("192.168.1.1");
    });

    test("does NOT auto-trust XFF for IPv4-mapped private IPs (::ffff:192.168.x.x)", () => {
        delete process.env.PIZZAPI_TRUST_PROXY;
        const req = makeReq({
            "x-pizzapi-client-ip": "::ffff:192.168.1.1",
            "x-forwarded-for": "198.51.100.1",
        });
        expect(getClientIp(req)).toBe("::ffff:192.168.1.1");
    });

    test("does NOT auto-trust XFF for 10.x.x.x private IPs", () => {
        delete process.env.PIZZAPI_TRUST_PROXY;
        const req = makeReq({
            "x-pizzapi-client-ip": "10.0.0.1",
            "x-forwarded-for": "198.51.100.1",
        });
        expect(getClientIp(req)).toBe("10.0.0.1");
    });

    test("does NOT auto-trust XFF for Docker bridge IPs (172.17.x.x)", () => {
        delete process.env.PIZZAPI_TRUST_PROXY;
        const req = makeReq({
            "x-pizzapi-client-ip": "172.17.0.1",
            "x-forwarded-for": "198.51.100.1",
        });
        expect(getClientIp(req)).toBe("172.17.0.1");
    });

    test("PIZZAPI_TRUST_PROXY=true allows XFF trust for Docker bridge IPs", () => {
        process.env.PIZZAPI_TRUST_PROXY = "true";
        const req = makeReq({
            "x-pizzapi-client-ip": "172.17.0.1",
            "x-forwarded-for": "198.51.100.1",
        });
        expect(getClientIp(req)).toBe("198.51.100.1");
    });

    test("PIZZAPI_TRUST_PROXY=true trusts XFF from public-IP peers (explicit cloud LB opt-in)", () => {
        // When the operator explicitly sets PIZZAPI_TRUST_PROXY=true they are asserting
        // that all traffic arrives via a trusted proxy — including public cloud load
        // balancers whose peer address is a public IP.  The explicit opt-in is the
        // authorization; no additional peer-IP check is applied.
        process.env.PIZZAPI_TRUST_PROXY = "true";
        const req = makeReq({
            "x-pizzapi-client-ip": "203.0.113.50",
            "x-forwarded-for": "198.51.100.1",
        });
        expect(getClientIp(req)).toBe("198.51.100.1");
    });

    test("PIZZAPI_TRUST_PROXY=true trusts XFF from 10.x.x.x peers (private Docker/LAN proxy)", () => {
        process.env.PIZZAPI_TRUST_PROXY = "true";
        const req = makeReq({
            "x-pizzapi-client-ip": "10.0.0.1",
            "x-forwarded-for": "198.51.100.1",
        });
        expect(getClientIp(req)).toBe("198.51.100.1");
    });

    test("PIZZAPI_TRUST_PROXY=true trusts XFF from 192.168.x.x peers (private proxy)", () => {
        process.env.PIZZAPI_TRUST_PROXY = "true";
        const req = makeReq({
            "x-pizzapi-client-ip": "192.168.1.1",
            "x-forwarded-for": "198.51.100.1",
        });
        expect(getClientIp(req)).toBe("198.51.100.1");
    });

    test("PIZZAPI_TRUST_PROXY=false disables auto-detection for loopback IPs", () => {
        process.env.PIZZAPI_TRUST_PROXY = "false";
        const req = makeReq({
            "x-pizzapi-client-ip": "127.0.0.1",
            "x-forwarded-for": "198.51.100.1",
        });
        expect(getClientIp(req)).toBe("127.0.0.1");
    });

    test("PIZZAPI_TRUST_PROXY=false disables auto-detection for loopback", () => {
        process.env.PIZZAPI_TRUST_PROXY = "false";
        const req = makeReq({
            "x-pizzapi-client-ip": "::ffff:127.0.0.1",
            "x-forwarded-for": "198.51.100.1",
        });
        expect(getClientIp(req)).toBe("::ffff:127.0.0.1");
    });

    test("returns 'unknown' when no headers present", () => {
        delete process.env.PIZZAPI_TRUST_PROXY;
        const req = makeReq({});
        expect(getClientIp(req)).toBe("unknown");
    });
});
