import { describe, expect, test } from "bun:test";
import {
  SOCKET_PROTOCOL_VERSION,
  parseSemverTriplet,
  compareSemver,
  isSocketProtocolCompatible,
} from "./version";

describe("version helpers", () => {
  test("SOCKET_PROTOCOL_VERSION is a positive integer", () => {
    expect(Number.isInteger(SOCKET_PROTOCOL_VERSION)).toBe(true);
    expect(SOCKET_PROTOCOL_VERSION).toBeGreaterThan(0);
  });

  test("parseSemverTriplet parses common semver forms", () => {
    expect(parseSemverTriplet("1.2.3")).toEqual([1, 2, 3]);
    expect(parseSemverTriplet("v1.2.3")).toEqual([1, 2, 3]);
    expect(parseSemverTriplet("1.2")).toEqual([1, 2, 0]);
    expect(parseSemverTriplet("1")).toEqual([1, 0, 0]);
    expect(parseSemverTriplet("1.2.3-beta.1")).toEqual([1, 2, 3]);
  });

  test("parseSemverTriplet rejects invalid input", () => {
    expect(parseSemverTriplet("")).toBeNull();
    expect(parseSemverTriplet("abc")).toBeNull();
    expect(parseSemverTriplet("1.2.3.4")).toBeNull();
    expect(parseSemverTriplet("-1.2.3")).toBeNull();
  });

  test("compareSemver orders versions correctly", () => {
    expect(compareSemver("1.2.3", "1.2.3")).toBe(0);
    expect(compareSemver("1.2.4", "1.2.3")).toBe(1);
    expect(compareSemver("1.3.0", "1.2.99")).toBe(1);
    expect(compareSemver("2.0.0", "1.99.99")).toBe(1);
    expect(compareSemver("1.2.3", "1.2.4")).toBe(-1);
  });

  test("compareSemver degrades gracefully on invalid versions", () => {
    expect(compareSemver("invalid", "1.2.3")).toBe(0);
    expect(compareSemver("1.2.3", "invalid")).toBe(0);
  });

  test("isSocketProtocolCompatible handles missing and mismatched values", () => {
    expect(isSocketProtocolCompatible(undefined)).toBe(true);
    expect(isSocketProtocolCompatible("1")).toBe(true);
    expect(isSocketProtocolCompatible(SOCKET_PROTOCOL_VERSION)).toBe(true);
    expect(isSocketProtocolCompatible(SOCKET_PROTOCOL_VERSION + 1)).toBe(false);
  });
});
