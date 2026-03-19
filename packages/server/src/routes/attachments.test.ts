import { describe, test, expect } from "bun:test";
import { buildContentDisposition, encodeHeaderFilename, rfc5987Encode } from "./attachments";

describe("rfc5987Encode", () => {
    test("encodes basic special characters", () => {
        expect(rfc5987Encode("hello world")).toBe("hello%20world");
    });

    test("encodes apostrophe (RFC 5987 delimiter)", () => {
        expect(rfc5987Encode("O'Reilly")).toBe("O%27Reilly");
    });

    test("encodes parentheses and asterisk", () => {
        expect(rfc5987Encode("file (1).txt")).toBe("file%20%281%29.txt");
        expect(rfc5987Encode("file*.txt")).toBe("file%2A.txt");
    });

    test("encodes non-ASCII characters", () => {
        expect(rfc5987Encode("résumé.pdf")).toContain("%C3%A9");
    });

    test("round-trips through decodeURIComponent", () => {
        const names = [
            "O'Reilly résumé (1).png",
            "Screenshot 2026-03-19 at 2.02.18\u202FPM.png",
            "截图_2026.png",
            "file*.txt",
        ];
        for (const name of names) {
            expect(decodeURIComponent(rfc5987Encode(name))).toBe(name);
        }
    });
});

describe("buildContentDisposition", () => {
    test("handles plain ASCII filenames", () => {
        const result = buildContentDisposition("photo.png");
        expect(result).toBe(`inline; filename="photo.png"; filename*=UTF-8''photo.png`);
    });

    test("handles filenames with regular spaces", () => {
        const result = buildContentDisposition("my photo.png");
        expect(result).toBe(`inline; filename="my photo.png"; filename*=UTF-8''my%20photo.png`);
        // Must not throw when used in a Response header
        const r = new Response("", { headers: { "content-disposition": result } });
        expect(r.headers.get("content-disposition")).toBe(result);
    });

    test("handles macOS screenshot filenames with U+202F narrow no-break space", () => {
        const filename = "Screenshot 2026-03-19 at 2.02.18\u202FPM.png";
        const result = buildContentDisposition(filename);
        // ASCII fallback should replace U+202F with underscore
        expect(result).toContain('filename="Screenshot 2026-03-19 at 2.02.18_PM.png"');
        // RFC 5987 encoded version should preserve the character
        expect(result).toContain("filename*=UTF-8''");
        expect(result).toContain("%E2%80%AF"); // U+202F in UTF-8
        // Must not throw when used in a Response header
        const r = new Response("", { headers: { "content-disposition": result } });
        expect(r.headers.get("content-disposition")).toBeTruthy();
    });

    test("handles filenames with U+00A0 non-breaking space", () => {
        const filename = "file\u00A0name.txt";
        const result = buildContentDisposition(filename);
        expect(result).toContain('filename="file_name.txt"');
        const r = new Response("", { headers: { "content-disposition": result } });
        expect(r.headers.get("content-disposition")).toBeTruthy();
    });

    test("escapes double quotes in filenames", () => {
        const result = buildContentDisposition('file"name.txt');
        expect(result).toContain('filename="file_name.txt"');
    });

    test("escapes backslashes in filenames", () => {
        const result = buildContentDisposition("file\\name.txt");
        expect(result).toContain('filename="file_name.txt"');
    });

    test("handles non-Latin characters (CJK, emoji)", () => {
        const filename = "截图_2026.png";
        const result = buildContentDisposition(filename);
        // ASCII fallback replaces CJK characters
        expect(result).toContain('filename="___2026.png"');
        // RFC 5987 encodes them
        expect(result).toContain("filename*=UTF-8''");
        const r = new Response("", { headers: { "content-disposition": result } });
        expect(r.headers.get("content-disposition")).toBeTruthy();
    });

    test("handles filenames with apostrophes (RFC 5987 delimiter)", () => {
        const filename = "O'Reilly résumé (1).png";
        const result = buildContentDisposition(filename);
        // Apostrophe must be percent-encoded in filename* to avoid
        // being interpreted as the charset/language separator
        expect(result).toContain("%27");
        // Parentheses must also be encoded
        expect(result).toContain("%28");
        expect(result).toContain("%29");
        const r = new Response("", { headers: { "content-disposition": result } });
        expect(r.headers.get("content-disposition")).toBeTruthy();
    });

    test("supports attachment mode", () => {
        const result = buildContentDisposition("file.pdf", "attachment");
        expect(result).toStartWith("attachment;");
    });

    test("defaults to inline mode", () => {
        const result = buildContentDisposition("file.pdf");
        expect(result).toStartWith("inline;");
    });
});

describe("encodeHeaderFilename", () => {
    test("preserves ASCII alphanumeric and safe characters", () => {
        const result = encodeHeaderFilename("photo.png");
        expect(result).toBe("photo.png");
        const r = new Response("", { headers: { "x-filename": result } });
        expect(r.headers.get("x-filename")).toBe(result);
    });

    test("percent-encodes non-ASCII characters", () => {
        const result = encodeHeaderFilename("résumé.pdf");
        expect(result).not.toContain("é");
        expect(result).toContain("%C3%A9");
        // Must round-trip
        expect(decodeURIComponent(result)).toBe("résumé.pdf");
        // Must not throw in a header
        const r = new Response("", { headers: { "x-filename": result } });
        expect(r.headers.get("x-filename")).toBe(result);
    });

    test("handles macOS screenshot names and round-trips", () => {
        const name = "Screenshot 2026-03-19 at 2.02.18\u202FPM.png";
        const result = encodeHeaderFilename(name);
        // Must not throw in a header
        const r = new Response("", { headers: { "x-filename": result } });
        expect(r.headers.get("x-filename")).toBe(result);
        // Must round-trip
        expect(decodeURIComponent(result)).toBe(name);
    });

    test("handles CJK filenames and round-trips", () => {
        const name = "截图_2026.png";
        const result = encodeHeaderFilename(name);
        const r = new Response("", { headers: { "x-filename": result } });
        expect(r.headers.get("x-filename")).toBe(result);
        expect(decodeURIComponent(result)).toBe(name);
    });

    test("preserves empty string", () => {
        expect(encodeHeaderFilename("")).toBe("");
    });
});
