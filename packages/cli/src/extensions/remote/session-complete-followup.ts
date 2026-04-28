type SessionCompleteFollowUpSocket = {
    on: (...args: any[]) => void;
    off: (...args: any[]) => void;
    emit: (...args: any[]) => void;
    connected?: boolean;
};

export async function sendSessionCompleteFollowUp(opts: {
    socket: SessionCompleteFollowUpSocket;
    token: string;
    childSessionId: string;
    message: string;
    timeoutMs?: number;
}): Promise<{ ok: boolean }> {
    const timeoutMs = opts.timeoutMs ?? 3_000;

    return await new Promise<{ ok: boolean }>((resolve) => {
        let settled = false;
        let sawDisconnect = false;
        const finish = (result: { ok: boolean }) => {
            if (settled) return;
            settled = true;
            clearTimeout(timeout);
            opts.socket.off("session_message_error", onError);
            opts.socket.off("disconnect", onDisconnect);
            resolve(result);
        };

        const onError = (err: { targetSessionId: string; error: string }) => {
            if (err.targetSessionId === opts.childSessionId) {
                finish({ ok: false });
            }
        };
        const onDisconnect = () => {
            sawDisconnect = true;
        };

        const timeout = setTimeout(() => {
            if (sawDisconnect || opts.socket.connected === false) {
                finish({ ok: false });
                return;
            }
            finish({ ok: true });
        }, timeoutMs);
        opts.socket.on("session_message_error", onError);
        opts.socket.on("disconnect", onDisconnect);
        opts.socket.emit("session_message", {
            token: opts.token,
            targetSessionId: opts.childSessionId,
            message: opts.message,
            deliverAs: "input",
        });
    });
}
