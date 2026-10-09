// Regression test for GM idea 5x1fgxyr: @pizzapi/protocol and @pizzapi/extension-sdk
// were not publish-ready. extension-sdk declared its dependency on protocol as
// "workspace:*", which only resolves inside this monorepo (bun/npm workspace
// linking) and is meaningless to an external npm consumer who installs
// extension-sdk from the registry — protocol wouldn't exist on npm as
// "workspace:*", npm install would fail outright. protocol also lacked the
// package.json fields (files/publishConfig) required to produce a clean,
// dist-only publishable tarball.
import { describe, expect, test } from "bun:test";
import extensionSdkPkg from "../package.json" with { type: "json" };
import protocolPkg from "../../protocol/package.json" with { type: "json" };

/** Minimal caret-range check — good enough for this repo's x.y.z versions. */
function satisfiesCaretRange(range: string, version: string): boolean {
  const r = /^\^(\d+)\.(\d+)\.(\d+)$/.exec(range);
  const v = /^(\d+)\.(\d+)\.(\d+)/.exec(version);
  if (!r || !v) return false;
  const [rMajor, rMinor, rPatch] = [Number(r[1]), Number(r[2]), Number(r[3])];
  const [vMajor, vMinor, vPatch] = [Number(v[1]), Number(v[2]), Number(v[3])];
  if (vMajor !== rMajor) return false;
  if (vMinor !== rMinor) return vMinor > rMinor;
  return vPatch >= rPatch;
}

describe("extension-sdk and protocol are publish-ready", () => {
  test("extension-sdk depends on a registry-resolvable @pizzapi/protocol version, not workspace:*", () => {
    const declared = (extensionSdkPkg.dependencies as Record<string, string>)["@pizzapi/protocol"];
    expect(declared).toBeDefined();
    expect(declared.startsWith("workspace:")).toBe(false);
    expect(satisfiesCaretRange(declared, protocolPkg.version)).toBe(true);
  });

  test("protocol declares the metadata npm needs to publish a clean dist-only package", () => {
    expect(protocolPkg.files).toEqual(["dist"]);
    expect(protocolPkg.publishConfig?.access).toBe("public");
    expect(typeof protocolPkg.license).toBe("string");
    expect(protocolPkg.license.length).toBeGreaterThan(0);
  });
});
