import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";

/**
 * Unit tests for `mobile/index.html` — the Capacitor bootstrap page that
 * captures a PizzaPi server URL on first launch (with QR scanning).
 *
 * These tests verify the static HTML + inline script structure. Full browser
 * integration testing (camera → jsQR → redirect) is deferred to Playwright.
 */

const html = readFileSync(import.meta.resolve("./index.html").replace("file://", ""), "utf-8");

function extractScripts(): string[] {
    const out: string[] = [];
    const re = /<script(?:\s[^>]*)?>([\s\S]*?)<\/script[^>]*>/gi;
    let m: RegExpExecArray | null;
    while ((m = re.exec(html)) !== null) {
        out.push(m[1]);
    }
    return out;
}

function extractInlineScript(): string {
    const scripts = extractScripts();
    // Inline app script is the last one (vendor/jsqr.js is loaded first).
    return scripts[scripts.length - 1];
}

describe("mobile bootstrap", () => {
    test("HTML contains the inline PizzaPi logo", () => {
        expect(html).toContain("<svg");
        expect(html).toContain('aria-label="PizzaPi"');
        expect(html).toContain("PizzaPi");
    });

    test("HTML contains the setup form with a URL input and Connect + Scan buttons", () => {
        expect(html).toContain('id="server-url"');
        expect(html).toContain('type="url"');
        expect(html).toMatch(/placeholder="https:\/\/relay/);
        expect(html).toContain(">Connect</button>");
        expect(html).toContain(">Scan QR code</button>");
    });

    test("HTML contains the scanner viewport and cancel button", () => {
        expect(html).toContain('id="scanner-wrap"');
        expect(html).toContain('id="scanner-video"');
        expect(html).toContain('id="cancel-scan-btn"');
        expect(html).toMatch(/Point at the PizzaPi QR code/);
    });

    test("loads jsQR from vendor/jsqr.js before the app script", () => {
        expect(html).toContain('<script src="vendor/jsqr.js"></script>');
        // vendor script must appear before the inline app script that calls window.jsQR
        const vendorIdx = html.indexOf('<script src="vendor/jsqr.js"></script>');
        const appIdx = html.indexOf("(function () {");
        expect(vendorIdx).toBeGreaterThan(0);
        expect(appIdx).toBeGreaterThan(0);
        expect(vendorIdx).toBeLessThan(appIdx);
    });

    test("HTML contains dark theme colors matching PizzaPi branding", () => {
        expect(html).toContain("--bg: #1c1917");
        expect(html).toContain("--accent: #22c55e");
    });
});

describe("static script analysis", () => {
    test("STORAGE_KEY is exactly 'pizzapi.serverUrl' (API key no longer uses localStorage)", () => {
        const script = extractInlineScript();
        expect(script).toContain("var STORAGE_KEY = 'pizzapi.serverUrl'");
        // The API key must not be stored in clear-text localStorage.
        expect(script).not.toContain("API_KEY_STORAGE_KEY");
        expect(script).not.toContain("'pizzapi.apiKey'");
    });

    test("validates URLs with a URL_REGEX", () => {
        const script = extractInlineScript();
        const regexMatch = script.match(/URL_REGEX\s*=\s*(\/[^\s;]+\/[a-z]*)/);
        expect(regexMatch).toBeTruthy();
        const regex = eval(regexMatch![1]) as RegExp;

        // Valid.
        expect(regex.test("https://relay.example.com")).toBe(true);
        expect(regex.test("http://localhost:7492")).toBe(true);
        expect(regex.test("http://192.168.1.5:8080/api")).toBe(true);

        // Invalid.
        expect(regex.test("not-a-url")).toBe(false);
        expect(regex.test("ftp://example.com")).toBe(false);
        expect(regex.test("")).toBe(false);
    });

    test("extracts relay base URL and claim path from setup/link QR URLs", () => {
        const script = extractInlineScript();
        const regexMatch = script.match(/SETUP_CLAIM_REGEX\s*=\s*(\/[^\s;]+\/[a-z]*)/);
        expect(regexMatch).toBeTruthy();
        const regex = eval(regexMatch![1]) as RegExp;

        // Setup-claim URLs: base and claim path should match.
        const m1 = "https://relay.example.com/setup-claim?t=abc123".match(regex);
        expect(m1?.[1]).toBe("https://relay.example.com");
        expect(m1?.[2]).toBe("/setup-claim?t=abc123");

        const m2 = "http://localhost:7492/setup-claim?t=0123456789abcdef".match(regex);
        expect(m2?.[1]).toBe("http://localhost:7492");
        expect(m2?.[2]).toBe("/setup-claim?t=0123456789abcdef");

        const m3 = "https://relay.example.com:8443/setup-claim?t=token".match(regex);
        expect(m3?.[1]).toBe("https://relay.example.com:8443");
        expect(m3?.[2]).toBe("/setup-claim?t=token");

        // Raw server URLs: regex should not match.
        expect("https://relay.example.com".match(regex)).toBeNull();
        expect("https://relay.example.com/auth/sign-in".match(regex)).toBeNull();

        // W5/P2-8: the setup-claim flow must redirect to the claim URL (with its
        // token), not the bare base. The old bug pinned `attemptConnect(url,
        // redirectToServer)`, which dropped the token.
        expect(script).toContain("attemptConnect(url, function () { redirectToServer(redirectUrl); })");
        expect(script).not.toContain("attemptConnect(url, redirectToServer)");
        expect(script).toContain("onSuccess(raw)");
        expect(script).toContain("function launchBundledUi(baseUrl, apiKey)");
        expect(script).toContain("window.location.replace('./app/index.html'");
        // A freshly redeemed key is passed via the URL fragment, not storage.
        expect(script).toContain("'#pizzapi.apiKey=' + encodeURIComponent(apiKey)");

        const mobileRegexMatch = script.match(/MOBILE_LINK_REGEX\s*=\s*(\/.*?\/);/);
        expect(mobileRegexMatch).toBeTruthy();
        const mobileRegex = eval(mobileRegexMatch![1]) as RegExp;
        const ml = "https://relay.example.com/mobile-link?id=link123".match(mobileRegex);
        expect(ml?.[1]).toBe("https://relay.example.com");
        expect(ml?.[2]).toBe("link123");
        expect(script).toContain("startMobileLink(mobileMatch[1].replace");
    });

    test("requests camera via getUserMedia with facingMode: environment", () => {
        const script = extractInlineScript();
        // Must call navigator.mediaDevices.getUserMedia
        expect(script).toContain("navigator.mediaDevices.getUserMedia");
        expect(script).toContain("'environment'");
        // Must handle NotAllowedError and NotFoundError gracefully.
        expect(script).toContain("NotAllowedError");
        expect(script).toContain("NotFoundError");
    });

    test("uses jsQR from the vendor script to decode each frame", () => {
        const script = extractInlineScript();
        // Guard: ensure window.jsQR is available before using it.
        expect(script).toContain("window.jsQR");
        // Sample centre of video, call jsQR with ImageData.
        expect(script).toContain("tmpCtx.getImageData");
        expect(script).toContain("getImageData(0, 0, 320, 320)");
        expect(script).toContain("jsQR(imageData.data, 320, 320");
        // Uses requestAnimationFrame scanning loop.
        expect(script).toContain("requestAnimationFrame");
    });

    test("on initial visit with stored URL, the bundled UI is launched without passing a key", () => {
        const script = extractInlineScript();
        // No storedKey lookup; the bundled UI loads the key from secure storage.
        expect(script).not.toContain("localStorage.getItem(API_KEY_STORAGE_KEY)");
        expect(script).toMatch(/launchBundledUi\(stored\)/);
        expect(script).toContain("window.location.replace('./app/index.html'");
    });

    test("'change=1' query param forces setup screen even when stored", () => {
        const script = extractInlineScript();
        expect(script).toContain("params.get('change') === '1'");
        expect(script).toContain("forceSetup");
    });

    test("form validation rejects URLs without scheme by prepending https:// for bare hosts", () => {
        const script = extractInlineScript();
        expect(script).toContain("'https://' + raw");
    });

    test("mobile-link scan redeems the link and launches the bundled UI with an API key", () => {
        const script = extractInlineScript();
        expect(html).toContain('id="screen-waiting"');
        expect(script).toContain("'/api/mobile-link/'");
        expect(script).toContain("'/redeem'");
        expect(script).toContain("redeemMobileLink(baseUrl, linkId)");
        expect(script).toContain("claim.status === 'approved'");
        expect(script).toContain("launchBundledUi(baseUrl, claim.apiKey)");
    });

    test("stopScanner() releases all camera tracks and clears srcObject (W17)", () => {
        const script = extractInlineScript();
        expect(script).toContain("getTracks().forEach");
        expect(script).toContain("t.stop()");
        expect(script).toContain("scannerVideo.srcObject = null");
    });

    test("scanned hosts are gated behind an explicit confirmation (W7/P0-1/P0-2)", () => {
        const script = extractInlineScript();
        // A confirmation screen exists and both scan branches route through it.
        expect(html).toContain('id="screen-confirm"');
        expect(html).toContain('id="confirm-connect-btn"');
        expect(script).toContain("function confirmScannedHost(url, onConfirm)");
        expect(script).toContain("confirmScannedHost(mlBase, function ()");
        expect(script).toContain("confirmScannedHost(url, function ()");
        // The host (not full URL) is what the user confirms.
        expect(script).toContain("confirmHostEl.textContent = hostOf(url)");
    });

    test("forceSave gate resets on success and on input change (W8)", () => {
        const script = extractInlineScript();
        expect(script).toContain("form.dataset.forceSave = '0'; // W8");
        expect(script).toContain("input.addEventListener('input', function () { form.dataset.forceSave = '0'; })");
    });

    test("cleartext http:// is rejected except on loopback/LAN (W10)", () => {
        const script = extractInlineScript();
        expect(script).toContain("function cleartextError(url)");
        expect(script).toContain("function isLoopbackHost(host)");
        // Applied to both scanned and manually-entered URLs.
        expect(script).toContain("var httpErr = cleartextError(raw)");
        expect(script).toContain("var httpErr = cleartextError(url)");

        // Exercise the loopback logic directly.
        const fnMatch = script.match(/function isLoopbackHost\(host\) \{[\s\S]*?\n {6}\}/);
        expect(fnMatch).toBeTruthy();
        // eslint-disable-next-line no-eval
        const isLoopbackHost = eval("(" + fnMatch![0] + ")") as (h: string) => boolean;
        expect(isLoopbackHost("localhost")).toBe(true);
        expect(isLoopbackHost("127.0.0.1")).toBe(true);
        expect(isLoopbackHost("192.168.1.5:8080")).toBe(true);
        expect(isLoopbackHost("10.0.0.2")).toBe(true);
        expect(isLoopbackHost("pi.local")).toBe(true);
        expect(isLoopbackHost("relay.example.com")).toBe(false);
    });

    test("startScanner uses a generation token so Cancel can't leak the camera (W1)", () => {
        const script = extractInlineScript();
        expect(script).toContain("var myGen = ++scanGen");
        expect(script).toContain("scanGen++"); // stopScanner invalidates in-flight starts
        // After awaiting getUserMedia, a cancelled start tears the stream down.
        expect(script).toContain("if (myGen !== scanGen)");
        expect(script).toContain("stream.getTracks().forEach(function (t) { t.stop(); })");
    });

    test("jsQR decoding is throttled to ~10fps (W2)", () => {
        const script = extractInlineScript();
        expect(script).toContain("now - lastDecode");
    });

    test("scan has a timeout fallback (W16)", () => {
        const script = extractInlineScript();
        expect(script).toContain("scanTimeoutId = setTimeout");
    });

    test("mobile-link poll is bounded and fetches are abortable (W4/W6)", () => {
        const script = extractInlineScript();
        expect(script).toContain("POLL_MAX");
        expect(script).toContain("++pollTries > POLL_MAX");
        expect(script).toContain("new AbortController()");
        expect(script).toContain("signal: linkAbort.signal");
        expect(script).toContain("err.name === 'AbortError'");
    });

    test("camera is released on backgrounding + hardware back is handled (W3/W14)", () => {
        const script = extractInlineScript();
        expect(script).toContain("visibilitychange");
        expect(script).toContain("pagehide");
        expect(script).toContain("'backbutton'");
    });

    test("dead code removed (W15)", () => {
        const script = extractInlineScript();
        expect(script).not.toContain("REDEEM_REGEX");
        expect(script).not.toContain("function showConnecting");
    });
});
