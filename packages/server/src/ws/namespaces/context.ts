import type { Socket } from "socket.io";
import { bindAuthContext, type AuthContext } from "../../auth.js";

/**
 * Socket.IO event handlers run long after the initial connection callback.
 * Bind every subsequently-registered `socket.on` / `socket.once` listener to
 * the server's auth context so DB/auth lookups remain request-local instead of
 * relying on module-level singletons.
 */
export function bindSocketHandlersToAuthContext(socket: Socket, context: AuthContext): void {
    const originalOn = socket.on.bind(socket);
    socket.on = ((event: string, listener: (...args: any[]) => any) => {
        return originalOn(event, bindAuthContext(context, listener));
    }) as typeof socket.on;

    const originalOnce = socket.once.bind(socket);
    socket.once = ((event: string, listener: (...args: any[]) => any) => {
        return originalOnce(event, bindAuthContext(context, listener));
    }) as typeof socket.once;
}
