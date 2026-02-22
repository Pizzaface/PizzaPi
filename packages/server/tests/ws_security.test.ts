import { describe, expect, test, mock, spyOn } from "bun:test";
import { auth } from "../src/auth.js";
import { handleWsUpgrade } from "../src/routes/ws.js";

// Mock auth.api.getSession
spyOn(auth.api, "getSession").mockImplementation(async () => {
    return {
        session: {
            id: "s1",
            expiresAt: new Date(Date.now() + 10000),
            token: "t1",
            createdAt: new Date(),
            updatedAt: new Date(),
            ipAddress: "127.0.0.1",
            userAgent: "test",
            userId: "u1"
        },
        user: {
            id: "u1",
            name: "User 1",
            email: "u1@example.com",
            emailVerified: true,
            image: null,
            createdAt: new Date(),
            updatedAt: new Date()
        }
    } as any;
});

// Mock server.upgrade
const mockUpgrade = mock(() => true);
const mockServer = { upgrade: mockUpgrade } as any;

describe("WebSocket Security (CSWSH)", () => {
    test("allows connection from trusted origin", async () => {
        mockUpgrade.mockClear();
        // Trusted origin as defined in auth.ts defaults (localhost:5173)
        const req = new Request("http://localhost:3000/ws/sessions/123", {
            headers: {
                "Origin": "http://localhost:5173",
                "Cookie": "session_token=valid"
            }
        });
        const url = new URL(req.url);

        await handleWsUpgrade(req, url, mockServer);
        expect(mockUpgrade).toHaveBeenCalled();
    });

    test("blocks connection from untrusted origin", async () => {
        mockUpgrade.mockClear();
        const req = new Request("http://localhost:3000/ws/sessions/123", {
            headers: {
                "Origin": "http://malicious.com",
                "Cookie": "session_token=valid"
            }
        });
        const url = new URL(req.url);

        const res = await handleWsUpgrade(req, url, mockServer);

        expect(mockUpgrade).not.toHaveBeenCalled();
        expect(res).toBeDefined();
        expect(res?.status).toBe(403);
    });

    test("blocks connection for hub from untrusted origin", async () => {
        mockUpgrade.mockClear();
        const req = new Request("http://localhost:3000/ws/hub", {
            headers: {
                "Origin": "http://malicious.com",
                "Cookie": "session_token=valid"
            }
        });
        const url = new URL(req.url);

        const res = await handleWsUpgrade(req, url, mockServer);

        expect(mockUpgrade).not.toHaveBeenCalled();
        expect(res).toBeDefined();
        expect(res?.status).toBe(403);
    });
});
