import { afterAll, beforeEach, describe, expect, mock, test } from "bun:test";

afterAll(() => mock.restore());

const mockRequireSession = mock((_req: Request) =>
  Promise.resolve({ userId: "user-1", userName: "TestUser" } as any),
);
mock.module("../middleware.js", () => ({
  requireSession: mockRequireSession,
}));

const mockGetRunnerData = mock((_runnerId: string) => Promise.resolve({ userId: "user-1", runnerId: "runner-A" } as any));
mock.module("../ws/sio-registry.js", () => ({
  getRunnerData: mockGetRunnerData,
}));

const mockSendRunnerCommand = mock((_runnerId: string, _command: Record<string, unknown>) => Promise.resolve({ ok: true } as any));
mock.module("../ws/namespaces/runner.js", () => ({
  sendRunnerCommand: mockSendRunnerCommand,
}));

const { handleRunnerSettingsRoute } = await import("./runner-settings.js");

function makeReq(method: string, path: string, body?: object): [Request, URL] {
  const url = new URL(`http://localhost${path}`);
  const init: RequestInit = {
    method,
    headers: { "content-type": "application/json" },
  };
  if (body) init.body = JSON.stringify(body);
  return [new Request(url.toString(), init), url];
}

describe("handleRunnerSettingsRoute", () => {
  beforeEach(() => {
    mockRequireSession.mockReset();
    mockRequireSession.mockReturnValue(Promise.resolve({ userId: "user-1", userName: "TestUser" } as any));
    mockGetRunnerData.mockReset();
    mockGetRunnerData.mockReturnValue(Promise.resolve({ userId: "user-1", runnerId: "runner-A" } as any));
    mockSendRunnerCommand.mockReset();
    mockSendRunnerCommand.mockReturnValue(Promise.resolve({ ok: true } as any));
  });

  test("accepts toolSearch as a valid settings section", async () => {
    const payload = {
      enabled: true,
      tokenThreshold: 12000,
      maxResults: 8,
      keepLoadedTools: false,
    };

    const [req, url] = makeReq("PUT", "/api/runners/runner-A/settings", {
      section: "toolSearch",
      value: payload,
    });
    const res = await handleRunnerSettingsRoute(req, url);
    expect(res).toBeTruthy();
    expect(res!.status).toBe(200);
    expect(mockSendRunnerCommand).toHaveBeenCalledWith("runner-A", {
      type: "settings_update_section",
      section: "toolSearch",
      value: payload,
    });
  });

  test("also accepts the preferred mcp section", async () => {
    const payload = { servers: [{ name: "github", url: "https://example.test/mcp", type: "http" }] };
    const [req, url] = makeReq("PUT", "/api/runners/runner-A/settings", {
      section: "mcp",
      value: payload,
    });
    const res = await handleRunnerSettingsRoute(req, url);
    expect(res!.status).toBe(200);
    expect(mockSendRunnerCommand).toHaveBeenCalledWith("runner-A", {
      type: "settings_update_section",
      section: "mcp",
      value: payload,
    });
  });

  test("returns the daemon response body for toolSearch saves", async () => {
    mockSendRunnerCommand.mockReturnValue(Promise.resolve({
      ok: true,
      saved: true,
      message: "Tool Search settings saved.",
      reloadHint: true,
    } as any));

    const [req, url] = makeReq("PUT", "/api/runners/runner-A/settings", {
      section: "toolSearch",
      value: { enabled: true },
    });
    const res = await handleRunnerSettingsRoute(req, url);
    expect(res!.status).toBe(200);
    const body = await res!.json();
    expect(body).toEqual({
      ok: true,
      saved: true,
      message: "Tool Search settings saved.",
      reloadHint: true,
    });
  });

  test("still rejects unknown sections", async () => {
    const [req, url] = makeReq("PUT", "/api/runners/runner-A/settings", {
      section: "notASection",
      value: {},
    });
    const res = await handleRunnerSettingsRoute(req, url);
    expect(res!.status).toBe(400);
    const body = await res!.json();
    expect(body.error).toContain('Invalid section "notASection"');
  });
});
