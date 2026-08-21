import { afterEach, describe, expect, it } from "bun:test";
import { closeStateRedis, initStateRedis, acquireSessionOwnershipLock, releaseSessionOwnershipLock } from "./sio-state.js";

const owners = new Map<string, string>();
const evalScripts: string[] = [];
const redis = {
    isOpen: true,
    set: async (key: string, value: string, opts: { NX?: boolean }) => {
        if (opts.NX && owners.has(key)) return null;
        owners.set(key, value);
        return "OK";
    },
    quit: async () => {},
    eval: async (script: string, args: { keys: string[]; arguments: string[] }) => {
        evalScripts.push(script);
        const key = args.keys[0];
        if (owners.get(key) !== args.arguments[0]) return 0;
        if (script.includes("PEXPIRE")) return 1;
        owners.delete(key);
        return 1;
    },
} as never;

afterEach(async () => {
    owners.clear();
    evalScripts.length = 0;
    await closeStateRedis();
});

describe("session ownership lock", () => {
    it("serializes observable teardown and registration side effects", async () => {
        await initStateRedis(redis);
        const effects: string[] = [];
        let releaseFirst!: () => void;
        const firstHeld = new Promise<void>((resolve) => (releaseFirst = resolve));

        const first = (async () => {
            await acquireSessionOwnershipLock("session-1", "teardown");
            effects.push("teardown-start");
            await firstHeld;
            effects.push("teardown-end");
            await releaseSessionOwnershipLock("session-1", "teardown");
        })();
        const second = (async () => {
            await acquireSessionOwnershipLock("session-1", "registration");
            effects.push("registration");
            await releaseSessionOwnershipLock("session-1", "registration");
        })();

        await new Promise((resolve) => setTimeout(resolve, 0));
        expect(effects).toEqual(["teardown-start"]);
        releaseFirst();
        await Promise.all([first, second]);
        expect(effects).toEqual(["teardown-start", "teardown-end", "registration"]);
    });

    it("times out instead of waiting forever for a held lock", async () => {
        await initStateRedis(redis);
        owners.set("pizzapi:sio:session-lock:session-1", "other-owner");

        await expect(acquireSessionOwnershipLock("session-1", "waiter", 20)).rejects.toThrow(
            "Timed out acquiring session ownership lock",
        );
    });

    it("renews the lease while a long operation holds the lock", async () => {
        await initStateRedis(redis);
        await acquireSessionOwnershipLock("session-1", "teardown", 100, 30);

        await new Promise((resolve) => setTimeout(resolve, 20));
        expect(evalScripts.some((script) => script.includes("PEXPIRE"))).toBe(true);

        await releaseSessionOwnershipLock("session-1", "teardown");
    });
});
