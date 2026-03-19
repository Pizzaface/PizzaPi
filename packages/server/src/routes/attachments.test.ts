import { describe, test, expect } from "bun:test";
import { buildContentDisposition, sanitizeHeaderValue } from "./attachments";

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
        // macOS uses U+202F (NARROW NO-BREAK SPACE) before AM/PM in screenshot filenames
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

    test("supports attachment mode", () => {
        const result = buildContentDisposition("file.pdf", "attachment");
        expect(result).toStartWith("attachment;");
    });

    test("defaults to inline mode", () => {
        const result = buildContentDisposition("file.pdf");
        expect(result).toStartWith("inline;");
    });
});

describe("sanitizeHeaderValue", () => {
    test("preserves ASCII printable characters", () => {
        expect(sanitizeHeaderValue("hello world")).toBe("hello world");
        expect(sanitizeHeaderValue("file-name_v2.txt")).toBe("file-name_v2.txt");
    });

    test("replaces non-ASCII characters with ?", () => {
        expect(sanitizeHeaderValue("file\u202Fname.txt")).toBe("file?name.txt");
        expect(sanitizeHeaderValue("résumé.pdf")).toBe("r?sum?.pdf");
    });

    test("handles macOS screenshot names", () => {
        const name = "Screenshot 2026-03-19 at 2.02.18\u202FPM.png";
        const result = sanitizeHeaderValue(name);
        expect(result).toBe("Screenshot 2026-03-19 at 2.02.18?PM.png");
        // Must not throw in a header
        const r = new Response("", { headers: { "x-filename": result } });
        expect(r.headers.get("x-filename")).toBe(result);
    });

    test("preserves empty string", () => {
        expect(sanitizeHeaderValue("")).toBe("");
    });
});
