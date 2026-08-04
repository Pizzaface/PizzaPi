import { afterAll, beforeEach, describe, expect, mock, test } from "bun:test";

afterAll(() => mock.restore());

const mockRequireSession = mock((_req: Request) => Promise.resolve({ userId: "user-1", userName: "TestUser" } as any));
mock.module("../middleware.js", () => ({ requireSession: mockRequireSession }));

const mockGetRunnerData = mock((_runnerId: string) => Promise.resolve({ userId: "user-1", runnerId: "runner-A" } as any));
mock.module("../ws/sio-registry.js", () => ({ getRunnerData: mockGetRunnerData }));

const mockSendRunnerCommand = mock((_runnerId: string, _command: Record<string, unknown>, _timeout?: number) =>
    Promise.resolve({ ok: true } as any),
);
mock.module("../ws/namespaces/runner.js", () => ({ sendRunnerCommand: mockSendRunnerCommand }));

const { handleRunnerAuthRoute } = await import("./runner-auth.js");

function makeReq(method: string, path: string, body?: object): [Request, URL] {
    const url = new URL(`http://localhost${path}`);
    const init: RequestInit = { method, headers: { "content-type": "application/json" } };
    if (body) init.body = JSON.stringify(body);
    return [new Request(url.toString(), init), url];
}

describe("handleRunnerAuthRoute", () => {
    beforeEach(() => {
        mockRequireSession.mockReset();
        mockRequireSession.mockReturnValue(Promise.resolve({ userId: "user-1", userName: "TestUser" } as any));
        mockGetRunnerData.mockReset();
        mockGetRunnerData.mockReturnValue(Promise.resolve({ userId: "user-1", runnerId: "runner-A" } as any));
        mockSendRunnerCommand.mockReset();
        mockSendRunnerCommand.mockReturnValue(Promise.resolve({ ok: true } as any));
    });

    test("routes list / start / submit / cancel to the right runner commands", async () => {
        await handleRunnerAuthRoute(...makeReq("GET", "/api/runners/runner-A/providers"));
        await handleRunnerAuthRoute(...makeReq("POST", "/api/runners/runner-A/providers/login", { providerId: "anthropic" }));
        await handleRunnerAuthRoute(...makeReq("POST", "/api/runners/runner-A/providers/login/submit", { loginId: "L", value: "v" }));
        await handleRunnerAuthRoute(...makeReq("POST", "/api/runners/runner-A/providers/login/cancel", { loginId: "L" }));
        await handleRunnerAuthRoute(...makeReq("GET", "/api/runners/runner-A/providers/login/status?loginId=L"));

        expect(mockSendRunnerCommand.mock.calls.map((call) => (call[1] as any).type)).toEqual([
            "auth_list",
            "auth_login_start",
            "auth_login_submit",
            "auth_login_cancel",
            "auth_login_status",
        ]);
        // Unknown auth types must not reach the runner as-is.
        expect((mockSendRunnerCommand.mock.calls[1][1] as any).authType).toBe("oauth");
    });

    test("another user's runner is forbidden", async () => {
        mockGetRunnerData.mockReturnValue(Promise.resolve({ userId: "someone-else", runnerId: "runner-A" } as any));
        const res = await handleRunnerAuthRoute(...makeReq("GET", "/api/runners/runner-A/providers"));
        expect(res?.status).toBe(403);
        expect(mockSendRunnerCommand).not.toHaveBeenCalled();
    });

    test("start requires a providerId", async () => {
        const res = await handleRunnerAuthRoute(...makeReq("POST", "/api/runners/runner-A/providers/login", {}));
        expect(res?.status).toBe(400);
        expect(mockSendRunnerCommand).not.toHaveBeenCalled();
    });

    test("ignores unrelated runner paths", async () => {
        expect(await handleRunnerAuthRoute(...makeReq("GET", "/api/runners/runner-A/settings"))).toBeUndefined();
    });
});
