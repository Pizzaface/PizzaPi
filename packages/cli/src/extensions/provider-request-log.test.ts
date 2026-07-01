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
    test("registers a before_provider_request handler that never throws", () => {
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
    });
});
