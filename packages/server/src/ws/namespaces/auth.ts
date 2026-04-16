import type { Socket } from "socket.io";
import { isSocketProtocolCompatible, SOCKET_PROTOCOL_VERSION } from "@pizzapi/protocol";
import { bindAuthContext, getAuth, getKysely, getTrustedOrigins, type AuthContext } from "../../auth.js";
import { createLogger } from "@pizzapi/tools";

const log = createLogger("sio/auth");

export function parseHandshakeProtocolVersion(socket: Socket): number | undefined {
    const raw = socket.handshake.auth?.protocolVersion;
    if (typeof raw === "number" && Number.isInteger(raw)) return raw;
    if (typeof raw === "string" && /^\d+$/.test(raw)) {
        const parsed = Number(raw);
        if (Number.isInteger(parsed)) return parsed;
    }
    return undefined;
}

function applyHandshakeClientMetadata(socket: Socket): void {
    const clientVersion = socket.handshake.auth?.clientVersion;
    if (typeof clientVersion === "string" && clientVersion.trim()) {
        socket.data.clientVersion = clientVersion.trim();
    }

    const clientProtocolVersion = parseHandshakeProtocolVersion(socket);
    if (clientProtocolVersion !== undefined) {
        socket.data.clientProtocolVersion = clientProtocolVersion;
    }

    const protocolCompatible = isSocketProtocolCompatible(clientProtocolVersion);
    socket.data.protocolCompatible = protocolCompatible;

    if (!protocolCompatible) {
        log.warn(
            `Socket protocol mismatch: server=${SOCKET_PROTOCOL_VERSION} client=${clientProtocolVersion ?? "unknown"} socket=${socket.id}`,
        );
    }
}

export function apiKeyAuthMiddleware(context: AuthContext) {
    return bindAuthContext(context, async (socket: Socket, next: (err?: Error) => void): Promise<void> => {
        try {
            applyHandshakeClientMetadata(socket);

            const apiKey = socket.handshake.auth?.apiKey;
            if (typeof apiKey !== "string" || !apiKey) {
                return next(new Error("unauthorized"));
            }

            const result = await getAuth().api.verifyApiKey({ body: { key: apiKey } });
            if (!result.valid || !result.key?.userId) {
                return next(new Error("unauthorized"));
            }

            const userId = result.key.userId;
            const row = await getKysely()
                .selectFrom("user")
                .select("name")
                .where("id", "=", userId)
                .executeTakeFirst();

            socket.data.userId = userId;
            socket.data.userName = row?.name ?? userId;
            next();
        } catch {
            next(new Error("unauthorized"));
        }
    });
}

export function sessionCookieAuthMiddleware(context: AuthContext) {
    return bindAuthContext(context, async (socket: Socket, next: (err?: Error) => void): Promise<void> => {
        try {
            applyHandshakeClientMetadata(socket);

            const origin = socket.handshake.headers.origin;
            if (origin && !getTrustedOrigins().includes(origin)) {
                return next(new Error("forbidden: untrusted origin"));
            }

            const cookieHeader = socket.handshake.headers.cookie;
            if (!cookieHeader) {
                return next(new Error("unauthorized"));
            }

            const headers = new Headers();
            headers.set("cookie", cookieHeader);

            const session = await getAuth().api.getSession({ headers });
            if (!session?.user?.id) {
                return next(new Error("unauthorized"));
            }

            socket.data.userId = session.user.id;
            socket.data.userName = session.user.name ?? session.user.id;
            next();
        } catch {
            next(new Error("unauthorized"));
        }
    });
}
