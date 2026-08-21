import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

const source = readFileSync(join(__dirname, "sw-push.js"), "utf8");

describe("sw-push cold-start deep link", () => {
  test("opens /session/<id> when no client window exists", () => {
    // The notification click handler must open the canonical pathname route
    // that App.tsx parses on cold start, not the legacy /#/sessions/<id> hash.
    expect(source).toContain('"/session/" + encodeURIComponent(sessionId)');
    expect(source).not.toContain('"/#/sessions/" + encodeURIComponent(sessionId)');
  });
});
