import { beforeEach, describe, expect, it } from "bun:test";

import { localTerminalBuffers, localTerminalViewerSockets, localTerminalGcTimers } from "./context.js";
import { sendToTerminalViewer } from "./terminals.js";

describe("terminal buffering", () => {
    beforeEach(() => {
        localTerminalBuffers.clear();
        localTerminalViewerSockets.clear();
        for (const timer of localTerminalGcTimers.values()) {
            clearTimeout(timer);
        }
        localTerminalGcTimers.clear();
    });

    it("caps buffered terminal messages when no viewer is attached", () => {
        const terminalId = "term-buffer-cap";
        localTerminalBuffers.set(terminalId, []);

        for (let i = 0; i < 1500; i++) {
            sendToTerminalViewer(terminalId, {
                type: "terminal_data",
                terminalId,
                data: `chunk-${i}`,
            });
        }

        const buffer = localTerminalBuffers.get(terminalId);
        expect(buffer).toBeDefined();
        expect(buffer!.length).toBe(1000);
        expect((buffer![0] as { data: string }).data).toBe("chunk-500");
        expect((buffer![999] as { data: string }).data).toBe("chunk-1499");
    });
});
