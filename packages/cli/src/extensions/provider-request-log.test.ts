import { describe, test, expect } from "bun:test";
import { providerRequestLogExtension } from "./provider-request-log.js";

// Minimal fake ExtensionAPI capturing handlers.
function makeFakePi() {
    const handlers: Record<string, Function> = {};
    return {
        pi: { on: (ev: string, h: Function) => { handlers[ev] = h; } } as any,
        handlers,
    };
}

describe("providerRequestLogExtension", () => {
    test("does not register when env flag is off", () => {
        delete process.env.PIZZAPI_LOG_PROVIDER_REQUEST;
        const { pi, handlers } = makeFakePi();
        providerRequestLogExtension(pi);
        expect(handlers["before_provider_request"]).toBeUndefined();
    });

    test("registers a before_provider_request handler when enabled and never throws", () => {
        process.env.PIZZAPI_LOG_PROVIDER_REQUEST = "1";
        try {
            const { pi, handlers } = makeFakePi();
            providerRequestLogExtension(pi);
            const handler = handlers["before_provider_request"];
            expect(typeof handler).toBe("function");
            // Handler must be defensive against odd payloads.
            expect(() =>
                handler(
                    { payload: { model: "m", system: [{ text: "a" }, { text: "bb" }], tools: [{ name: "Bash" }] } },
                    { model: { provider: "claude-subscription", id: "claude-sonnet-5", api: "claude-subscription-native" } },
                ),
            ).not.toThrow();
            expect(() => handler({ payload: undefined }, {})).not.toThrow();
        } finally {
            delete process.env.PIZZAPI_LOG_PROVIDER_REQUEST;
        }
    });
});
