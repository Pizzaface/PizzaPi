// ============================================================================
// runner-namespace-harness.ts — drive the REAL /runner namespace handlers
//
// Bun runs every test file in one process, so `mock.module` is process-global
// and leaks into unrelated suites. Instead of mocking the namespace machinery,
// this harness injects its collaborators:
//
//   - an in-memory Redis covering the sio-state client surface
//     (initStateRedis), the redis-kv surface (redis-kv-store's
//     _injectRedisForTesting) and the relay event cache (sessions/redis.ts's
//     _injectRedisForTesting). Every module with a lazily-connected client on
//     the path under test MUST be injected, or it will dial a real Redis.
//   - a fake Socket.IO server that captures the /runner connection handler and
//     answers `ns.in(room).fetchSockets()` from sockets that actually joined
//   - fake sockets that capture event handlers and record emits
//
// Tests then call the captured handlers exactly as Socket.IO would. Nothing
// here touches a real Redis, network, or module registry.
// ============================================================================

/** In-memory Redis mock covering the sio-state and redis-kv client surfaces. */
export function createMemoryRedis() {
    const hashes = new Map<string, Record<string, string>>();
    const strings = new Map<string, string>();
    const sets = new Map<string, Set<string>>();
    const lists = new Map<string, string[]>();

    const hSetAll = (key: string, fields: Record<string, string>) => {
        hashes.set(key, { ...(hashes.get(key)), ...fields });
    };
    const sAddAll = (key: string, members: unknown[]) => {
        const s = sets.get(key) ?? new Set<string>();
        for (const m of members.flat()) s.add(String(m));
        sets.set(key, s);
    };
    const sRemAll = (key: string, members: unknown[]) => {
        const s = sets.get(key);
        if (s) for (const m of members.flat()) s.delete(String(m));
    };
    const delKey = (key: string) => {
        hashes.delete(key);
        strings.delete(key);
        lists.delete(key);
        sets.delete(key);
    };
    const hSet = (key: string, fieldsOrField: unknown, value?: string) => {
        if (typeof fieldsOrField === "string") hSetAll(key, { [fieldsOrField]: value ?? "" });
        else hSetAll(key, fieldsOrField as Record<string, string>);
        return 1;
    };

    const multi = () => {
        const ops: Array<() => unknown> = [];
        const m: Record<string, (...args: any[]) => any> = {
            hSet: (key: string, f: unknown, v?: string) => { ops.push(() => hSet(key, f, v)); return m; },
            hGetAll: (key: string) => { ops.push(() => ({ ...(hashes.get(key)) })); return m; },
            expire: () => { ops.push(() => 1); return m; },
            sAdd: (key: string, ...members: unknown[]) => { ops.push(() => { sAddAll(key, members); return 1; }); return m; },
            sRem: (key: string, ...members: unknown[]) => { ops.push(() => { sRemAll(key, members); return 1; }); return m; },
            del: (key: string) => { ops.push(() => { delKey(key); return 1; }); return m; },
            rPush: (key: string, value: string) => { ops.push(() => { const l = lists.get(key) ?? []; l.push(value); lists.set(key, l); return l.length; }); return m; },
            lTrim: () => { ops.push(() => "OK"); return m; },
            pExpire: () => { ops.push(() => 1); return m; },
            exec: async () => ops.map((op) => op()),
        };
        return m;
    };

    const client: Record<string, unknown> = {
        isOpen: true,
        on: () => client,
        connect: async () => {},
        multi,
        hGetAll: async (key: string) => ({ ...(hashes.get(key)) }),
        hSet: async (key: string, f: unknown, v?: string) => hSet(key, f, v),
        exists: async (key: string) => (hashes.has(key) || strings.has(key) || sets.has(key) ? 1 : 0),
        sMembers: async (key: string) => Array.from(sets.get(key) ?? []),
        sAdd: async (key: string, ...members: unknown[]) => { sAddAll(key, members); return 1; },
        sRem: async (key: string, ...members: unknown[]) => { sRemAll(key, members); return 1; },
        expire: async () => 1,
        set: async (key: string, value: string) => { strings.set(key, value); return "OK"; },
        get: async (key: string) => strings.get(key) ?? null,
        del: async (key: string) => { delKey(key); return 1; },
        incr: async (key: string) => { const n = Number(strings.get(key) ?? "0") + 1; strings.set(key, String(n)); return n; },
        publish: async () => 0,
    };

    return {
        client,
        clear() {
            hashes.clear();
            strings.clear();
            sets.clear();
            lists.clear();
        },
    };
}

// ponytail: fake socket is `any` — the real Socket interface has 70+
// members; structural typing is pointless for a captured-handler harness.
export type FakeSocket = any;

/**
 * Fake Socket.IO server. Every namespace shares one room registry so
 * `ns.in(room).fetchSockets()` reflects the sockets that called `join(room)`
 * and are still connected — the same cluster-liveness signal the real
 * handlers use. Set `failFetchSockets` to simulate an adapter error.
 */
export function createFakeIo() {
    let connectionHandler: ((socket: unknown) => void) | undefined;
    const nsCache = new Map<string, Record<string, unknown>>();
    const rooms = new Map<string, Set<FakeSocket>>();
    const state = { failFetchSockets: false };
    /** Every `ns.to(room).emit(...)` / `ns.in(room).emit(...)` call, in order. */
    const roomEmits: Array<{ namespace: string; room: string; event: string; payload: unknown }> = [];

    const fetchRoom = async (room: string) => {
        if (state.failFetchSockets) throw new Error("adapter unavailable");
        return Array.from(rooms.get(room) ?? []).filter((s) => s.connected);
    };

    const mkNs = (name: string): Record<string, unknown> => {
        const target = (room: string) => ({
            emit: (event: string, payload: unknown) => { roomEmits.push({ namespace: name, room, event, payload }); },
            fetchSockets: () => fetchRoom(room),
        });
        return {
            emit: () => {},
            to: target,
            in: target,
            local: { emit: () => {}, to: () => ({ emit: () => {} }) },
            fetchSockets: async () => [],
            use: () => {},
            on: (event: string, cb: (socket: unknown) => void) => {
                if (event === "connection") connectionHandler = cb;
            },
        };
    };

    return {
        io: {
            of: (name: string) => {
                if (!nsCache.has(name)) nsCache.set(name, mkNs(name));
                return nsCache.get(name);
            },
        },
        rooms,
        roomEmits,
        state,
        getConnectionHandler: () => connectionHandler,
    };
}

/** A fake socket that captures handlers, records emits, and joins rooms. */
export function makeSocket(
    id: string,
    rooms?: Map<string, Set<FakeSocket>>,
    data: Record<string, unknown> = {},
): FakeSocket {
    const handlers = new Map<string, (...args: any[]) => unknown>();
    const socket: FakeSocket = {
        id,
        data: { ...data },
        connected: true,
        handshake: { address: "127.0.0.1", headers: {}, auth: {} },
        conn: { transport: { name: "websocket" } },
        emitted: [] as Array<[string, unknown]>,
        join: async (room: string) => {
            if (!rooms) return;
            const members = rooms.get(room) ?? new Set();
            members.add(socket);
            rooms.set(room, members);
        },
        leave: async (room: string) => {
            rooms?.get(room)?.delete(socket);
        },
        emit(event: string, payload: unknown) {
            socket.emitted.push([event, payload]);
            return true;
        },
        disconnect: () => {
            socket.connected = false;
        },
        on(event: string, cb: (...args: any[]) => unknown) {
            handlers.set(event, cb);
            return socket;
        },
        once(event: string, cb: (...args: any[]) => unknown) {
            handlers.set(event, cb);
            return socket;
        },
        /** Fire a captured event handler, awaiting async listeners. */
        async fire(event: string, ...args: unknown[]) {
            const cb = handlers.get(event);
            if (!cb) throw new Error(`no '${event}' handler captured on socket ${id}`);
            await cb(...args);
        },
    };
    return socket;
}
