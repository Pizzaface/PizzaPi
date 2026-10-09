type Hash = Record<string, string>;

type Op = () => unknown | Promise<unknown>;

export interface SioStateRedisFixture {
    client: Record<string, unknown>;
    store: Map<string, string>;
    setStore: Map<string, Set<string>>;
    ttlStore: Map<string, number>;
    reset: () => void;
    failHGet: (err: Error | null) => void;
}

export function createSioStateRedisFixture(): SioStateRedisFixture {
    const store = new Map<string, string>();
    const setStore = new Map<string, Set<string>>();
    const ttlStore = new Map<string, number>();
    let hGetError: Error | null = null;

    const readHash = (key: string): Hash => JSON.parse(store.get(`__hash__:${key}`) ?? "{}");
    const writeHash = (key: string, hash: Hash) => store.set(`__hash__:${key}`, JSON.stringify(hash));

    const addSetMembers = (key: string, members: unknown[]) => {
        const set = setStore.get(key) ?? new Set<string>();
        for (const member of members.flat() as string[]) set.add(member);
        setStore.set(key, set);
    };

    const removeSetMembers = (key: string, members: unknown[]) => {
        const set = setStore.get(key);
        if (!set) return;
        for (const member of members.flat() as string[]) set.delete(member);
    };

    const makeMulti = () => {
        const ops: Op[] = [];
        const multi = {
            hSet(key: string, fieldsOrField: Hash | string, value?: string) {
                ops.push(() => {
                    const hash = readHash(key);
                    if (typeof fieldsOrField === "string") hash[fieldsOrField] = String(value ?? "");
                    else Object.assign(hash, fieldsOrField);
                    writeHash(key, hash);
                });
                return multi;
            },
            hGetAll(key: string) {
                ops.push(() => readHash(key));
                return multi;
            },
            hGet(key: string, field: string) {
                ops.push(() => {
                    if (hGetError) throw hGetError;
                    return readHash(key)[field] ?? null;
                });
                return multi;
            },
            hmGet(key: string, fields: readonly string[]) {
                ops.push(() => {
                    const hash = readHash(key);
                    return fields.map((field) => hash[field] ?? null);
                });
                return multi;
            },
            sAdd(key: string, ...members: unknown[]) {
                ops.push(() => addSetMembers(key, members));
                return multi;
            },
            sRem(key: string, ...members: unknown[]) {
                ops.push(() => removeSetMembers(key, members));
                return multi;
            },
            expire(key: string, ttl: number) {
                ops.push(() => ttlStore.set(key, ttl));
                return multi;
            },
            del(...keys: string[]) {
                ops.push(() => {
                    for (const key of keys) {
                        store.delete(key);
                        store.delete(`__hash__:${key}`);
                        setStore.delete(key);
                        ttlStore.delete(key);
                    }
                });
                return multi;
            },
            exec: async () => Promise.all(ops.map((op) => op())),
        };
        return multi;
    };

    const client = {
        isOpen: true,
        on: () => client,
        connect: async () => {},
        multi: makeMulti,
        hGetAll: async (key: string) => readHash(key),
        hmGet: async (key: string, fields: readonly string[]) => {
            const hash = readHash(key);
            return fields.map((field) => hash[field] ?? null);
        },
        hGet: async (key: string, field: string) => {
            if (hGetError) throw hGetError;
            return readHash(key)[field] ?? null;
        },
        hSet: async (key: string, fieldOrFields: Hash | string, value?: string) => {
            const hash = readHash(key);
            if (typeof fieldOrFields === "string") hash[fieldOrFields] = String(value ?? "");
            else Object.assign(hash, fieldOrFields);
            writeHash(key, hash);
        },
        exists: async (key: string) => (store.has(key) || store.has(`__hash__:${key}`) ? 1 : 0),
        expire: async (key: string, ttl: number) => { ttlStore.set(key, ttl); },
        set: async (key: string, value: string, opts?: { NX?: boolean }) => {
            if (opts?.NX && store.has(key)) return null;
            store.set(key, value);
            return "OK";
        },
        get: async (key: string) => store.get(key) ?? null,
        del: async (...keys: string[]) => {
            let deleted = 0;
            for (const key of keys) {
                if (store.delete(key)) deleted++;
                if (store.delete(`__hash__:${key}`)) deleted++;
                if (setStore.delete(key)) deleted++;
                ttlStore.delete(key);
            }
            return deleted;
        },
        sAdd: async (key: string, ...members: unknown[]) => addSetMembers(key, members),
        sRem: async (key: string, ...members: unknown[]) => removeSetMembers(key, members),
        sMembers: async (key: string) => Array.from(setStore.get(key) ?? []),
        sIsMember: async (key: string, member: string) => setStore.get(key)?.has(member) ?? false,
        incr: async (key: string) => {
            const next = Number(store.get(key) ?? 0) + 1;
            store.set(key, String(next));
            return next;
        },
        eval: async (_script: string, opts: { keys: string[]; arguments: string[] }) => {
            if (opts.keys.length === 1) {
                const [key] = opts.keys;
                const [owner] = opts.arguments;
                if (store.get(key) !== owner) return 0;
                store.delete(key);
                return 1;
            }
            const [sessionKey, seqKey, allSessionsKey] = opts.keys;
            const [expectedToken, sessionId, userSessionsPrefix] = opts.arguments;
            const hash = readHash(sessionKey);
            if (hash.token !== expectedToken) return 0;
            store.delete(`__hash__:${sessionKey}`);
            store.delete(seqKey);
            removeSetMembers(allSessionsKey, [sessionId]);
            if (hash.userId) removeSetMembers(`${userSessionsPrefix}${hash.userId}`, [sessionId]);
            return 1;
        },
    };

    return {
        client,
        store,
        setStore,
        ttlStore,
        reset: () => {
            store.clear();
            setStore.clear();
            ttlStore.clear();
            hGetError = null;
        },
        failHGet: (err) => { hGetError = err; },
    };
}
