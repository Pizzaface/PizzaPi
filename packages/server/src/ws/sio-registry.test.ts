import { describe, expect, test, beforeEach, afterEach } from "bun:test";
import {
    _getTerminalBuffer,
    _getTerminalBufferSize,
    _initTerminalBuffer,
    _clearTerminalBuffer,
    _trimTerminalBuffer,
    _estimateMessageSize,
} from "./sio-registry.js";
import { LIMITS } from "../constants.js";

describe("estimateMessageSize", () => {
    test("estimates size of simple object", () => {
        const msg = { type: "data", content: "hello" };
        const size = _estimateMessageSize(msg);
        expect(size).toBe(JSON.stringify(msg).length);
    });

    test("returns fallback for non-serializable objects", () => {
        const circular: any = { a: 1 };
        circular.self = circular;
        const size = _estimateMessageSize(circular);
        expect(size).toBe(100);
    });
});

describe("terminal buffer trimming", () => {
    const testTerminalId = "test-terminal-123";

    beforeEach(() => {
        _initTerminalBuffer(testTerminalId);
    });

    afterEach(() => {
        _clearTerminalBuffer(testTerminalId);
    });

    test("does not trim when under line limit", () => {
        const buffer = _getTerminalBuffer(testTerminalId)!;
        for (let i = 0; i < 100; i++) {
            buffer.push({ type: "data", line: i });
        }
        const trimmed = _trimTerminalBuffer(testTerminalId);
        expect(trimmed).toBe(false);
        expect(buffer.length).toBe(100);
    });

    test("trims when exceeding line limit", () => {
        const buffer = _getTerminalBuffer(testTerminalId)!;
        const maxLines = LIMITS.MAX_TERMINAL_BUFFER_LINES;
        for (let i = 0; i < maxLines + 500; i++) {
            buffer.push({ type: "data", line: i });
        }
        const trimmed = _trimTerminalBuffer(testTerminalId);
        expect(trimmed).toBe(true);
        expect(buffer.length).toBe(maxLines);
        expect((buffer[0] as any).line).toBe(500);
    });

    test("buffer initialization sets zero size", () => {
        const buffer = _getTerminalBuffer(testTerminalId)!;
        const initialSize = _getTerminalBufferSize(testTerminalId);
        expect(buffer).toEqual([]);
        expect(initialSize).toBe(0);
    });
});
