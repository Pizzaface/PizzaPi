import { RateLimiter } from "./security.js";

export const chatRateLimiter = new RateLimiter(20, 60_000);
export const spawnRateLimiter = new RateLimiter(10, 60_000);

export function getClientIp(req: Request): string {
    const forwarded = req.headers.get("x-forwarded-for");
    if (forwarded) {
        const firstIp = forwarded.split(",")[0]?.trim();
        if (firstIp) return firstIp;
    }
    const realIp = req.headers.get("x-real-ip");
    if (realIp) return realIp;
    return "unknown";
}

export function rateLimitResponse(retryAfterSeconds: number = 60): Response {
    return Response.json(
        { error: "Too many requests. Please try again later." },
        { status: 429, headers: { "Retry-After": String(retryAfterSeconds) } }
    );
}
