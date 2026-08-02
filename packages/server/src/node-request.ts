import type { IncomingMessage, ServerResponse } from "node:http";

/** Convert Node's HTTP request while propagating premature client disconnects. */
export function nodeReqToFetchRequest(req: IncomingMessage, res: ServerResponse, port: number): Request {
    const controller = new AbortController();
    const cleanup = () => {
        req.off("aborted", onAborted);
        res.off("close", onResponseClose);
    };
    const onAborted = () => {
        controller.abort();
        cleanup();
    };
    const onResponseClose = () => {
        if (!res.writableFinished) controller.abort();
        cleanup();
    };
    req.once("aborted", onAborted);
    res.once("close", onResponseClose);

    const proto = req.headers["x-forwarded-proto"] ?? "http";
    const host = req.headers.host ?? `localhost:${port}`;
    const url = new URL(req.url ?? "/", `${proto}://${host}`);
    const headers = new Headers();
    for (const [key, value] of Object.entries(req.headers)) {
        if (value === undefined) continue;
        if (key.toLowerCase() === "x-pizzapi-client-ip") continue;
        if (Array.isArray(value)) {
            for (const v of value) headers.append(key, v);
        } else {
            headers.set(key, value);
        }
    }
    if (req.socket.remoteAddress) headers.set("x-pizzapi-client-ip", req.socket.remoteAddress);

    const method = (req.method ?? "GET").toUpperCase();
    const hasBody = method !== "GET" && method !== "HEAD";
    return new Request(url.toString(), {
        method,
        headers,
        body: hasBody ? req as any : undefined,
        signal: controller.signal,
        // @ts-expect-error — Bun supports duplex on Request
        duplex: hasBody ? "half" : undefined,
    });
}
