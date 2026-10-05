import { describe, expect, it } from "bun:test";
import {
    createPinnedLookup,
    isPublicUnicastAddress,
    resolvePublicAddresses,
    UnsafeOutboundAddressError,
} from "./outbound-address.js";

describe("isPublicUnicastAddress", () => {
    it("accepts global unicast IPv4 and IPv6", () => {
        for (const ip of ["8.8.8.8", "142.250.80.10", "1.1.1.1", "2607:f8b0:4005:80a::200a", "[2a00:1450::1]", "::ffff:8.8.8.8"]) {
            expect(isPublicUnicastAddress(ip)).toBe(true);
        }
    });

    it("rejects every reserved/non-global IPv4 class", () => {
        for (const ip of [
            "0.0.0.0", "0.1.2.3", "10.0.0.1", "100.64.0.1", "100.127.255.254", "127.0.0.1",
            "169.254.169.254", "172.16.0.1", "172.31.255.255", "192.0.0.8", "192.0.2.1",
            "192.88.99.1", "192.168.1.1", "198.18.0.1", "198.19.255.255", "198.51.100.1",
            "203.0.113.5", "224.0.0.1", "239.255.255.250", "240.0.0.1", "255.255.255.255",
        ]) {
            expect(isPublicUnicastAddress(ip)).toBe(false);
        }
    });

    it("rejects every reserved/non-global IPv6 class", () => {
        for (const ip of [
            "::", "::1", "[::1]", "::ffff:127.0.0.1", "::ffff:7f00:1", "::ffff:10.0.0.1",
            "::ffff:169.254.169.254", "64:ff9b::a00:1", "100::1", "2001::1", "2001:db8::1",
            "2002:7f00:1::1", "fc00::1", "fd12:3456::1", "fe80::1", "fe80::1%eth0", "fec0::1", "ff02::1",
        ]) {
            expect(isPublicUnicastAddress(ip)).toBe(false);
        }
    });

    it("rejects hostnames and garbage", () => {
        for (const v of ["example.com", "", "1.2.3", "999.1.1.1", "::g"]) {
            expect(isPublicUnicastAddress(v)).toBe(false);
        }
    });
});

describe("resolvePublicAddresses", () => {
    it("returns resolved addresses when every record is public", async () => {
        const addrs = await resolvePublicAddresses("push.example.com", async () => [
            { address: "8.8.8.8", family: 4 },
            { address: "2607:f8b0::1", family: 6 },
        ]);
        expect(addrs.map((a) => a.address)).toEqual(["8.8.8.8", "2607:f8b0::1"]);
    });

    it("rejects a hostname resolving to any private address (mixed records)", async () => {
        await expect(resolvePublicAddresses("rebind.example.com", async () => [
            { address: "8.8.8.8", family: 4 },
            { address: "10.0.0.5", family: 4 },
        ])).rejects.toBeInstanceOf(UnsafeOutboundAddressError);
    });

    it("rejects hostnames resolving to each reserved class", async () => {
        for (const address of ["127.0.0.1", "169.254.169.254", "192.168.0.1", "::1", "fd00::1", "fe80::1", "::ffff:10.1.1.1"]) {
            await expect(resolvePublicAddresses("evil.example.com", async () => [
                { address, family: address.includes(":") ? 6 : 4 },
            ])).rejects.toBeInstanceOf(UnsafeOutboundAddressError);
        }
    });

    it("rejects an empty resolution", async () => {
        await expect(resolvePublicAddresses("empty.example.com", async () => [])).rejects.toBeInstanceOf(UnsafeOutboundAddressError);
    });

    it("validates IP literals without resolving", async () => {
        let called = false;
        const lookup = async () => { called = true; return []; };
        await expect(resolvePublicAddresses("[::1]", lookup)).rejects.toBeInstanceOf(UnsafeOutboundAddressError);
        expect(await resolvePublicAddresses("8.8.4.4", lookup)).toEqual([{ address: "8.8.4.4", family: 4 }]);
        expect(called).toBe(false);
    });
});

describe("createPinnedLookup", () => {
    it("ignores the requested hostname and returns only pinned addresses", () => {
        const lookup = createPinnedLookup([{ address: "8.8.8.8", family: 4 }, { address: "2607:f8b0::1", family: 6 }]);
        const results: unknown[] = [];
        lookup("rebound.example.com", { all: true }, (err, addrs) => results.push([err, addrs]));
        lookup("rebound.example.com", {}, (err, addr, family) => results.push([err, addr, family]));
        lookup("rebound.example.com", { family: 6 }, (err, addr, family) => results.push([err, addr, family]));
        expect(results).toEqual([
            [null, [{ address: "8.8.8.8", family: 4 }, { address: "2607:f8b0::1", family: 6 }]],
            [null, "8.8.8.8", 4],
            [null, "2607:f8b0::1", 6],
        ]);
    });

    it("errors instead of falling back to DNS when no pinned address matches the family", () => {
        const lookup = createPinnedLookup([{ address: "8.8.8.8", family: 4 }]);
        let error: unknown = null;
        lookup("x.example.com", { family: 6 }, (err) => { error = err; });
        expect(error).toBeInstanceOf(Error);
    });
});
