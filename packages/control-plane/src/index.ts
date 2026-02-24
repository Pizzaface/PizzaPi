import { auth, kysely } from "./auth.js";
import { ensureSigningKey, issueOrgToken, getJwks } from "./jwt.js";
import { provisionInstance, deprovisionInstance } from "./provisioner.js";

const PORT = parseInt(process.env.PORT ?? "3100");

// ── Helpers ────────────────────────────────────────────────────────────────────

function slugify(name: string): string {
    return name
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, "-")
        .replace(/^-|-$/g, "")
        .slice(0, 40);
}

const SLUG_RE = /^[a-z0-9][a-z0-9-]{1,38}[a-z0-9]$/;

function isValidSlug(slug: string): boolean {
    return SLUG_RE.test(slug) && !slug.includes("--");
}

function uuid(): string {
    return crypto.randomUUID();
}

async function getSession(req: Request) {
    const session = await auth.api.getSession({ headers: req.headers });
    return session;
}

function json(data: unknown, status = 200) {
    return Response.json(data, { status });
}

// ── Server ─────────────────────────────────────────────────────────────────────

// Initialize signing key on startup
await ensureSigningKey();

const server = Bun.serve({
    port: PORT,
    async fetch(req) {
        const url = new URL(req.url);
        const { pathname } = url;

        // Health check
        if (pathname === "/health" && req.method === "GET") {
            return json({ status: "ok" });
        }

        // better-auth handler
        if (pathname.startsWith("/api/auth")) {
            try {
                return await auth.handler(req);
            } catch (e) {
                console.error("[auth] handler threw:", e);
                return json({ error: "Auth error" }, 500);
            }
        }

        // ── Caddy on_demand_tls validation ────────────────────────────────
        if (pathname === "/api/caddy/validate" && req.method === "GET") {
            const domain = url.searchParams.get("domain");
            if (!domain) return json({ error: "domain required" }, 400);

            const suffix = process.env.PIZZAPI_DOMAIN_SUFFIX ?? "pizzapi.example.com";
            if (!domain.endsWith(`.${suffix}`)) {
                return json({ error: "Invalid domain" }, 404);
            }

            const slug = domain.replace(`.${suffix}`, "");
            if (!slug || slug.includes(".")) {
                return json({ error: "Invalid subdomain" }, 404);
            }

            const org = await kysely
                .selectFrom("organizations")
                .select("id")
                .where("slug", "=", slug)
                .where("status", "=", "active")
                .executeTakeFirst();

            if (!org) return json({ error: "Unknown org" }, 404);

            // 200 = Caddy should issue a certificate for this domain
            return json({ ok: true });
        }

        // ── Authenticated routes ───────────────────────────────────────────

        // POST /api/orgs — create org
        if (pathname === "/api/orgs" && req.method === "POST") {
            const session = await getSession(req);
            if (!session?.user) return json({ error: "Unauthorized" }, 401);

            const body = (await req.json()) as { name?: string };
            const name = body.name?.trim();
            if (!name || name.length < 2 || name.length > 100) {
                return json({ error: "Name must be 2-100 characters" }, 400);
            }

            const slug = slugify(name);
            if (!isValidSlug(slug)) {
                return json({ error: "Cannot generate valid slug from name" }, 400);
            }

            const existing = await kysely
                .selectFrom("organizations")
                .select("id")
                .where("slug", "=", slug)
                .executeTakeFirst();
            if (existing) {
                return json({ error: "Organization slug already taken" }, 409);
            }

            const orgId = uuid();
            const now = new Date().toISOString();

            await kysely
                .insertInto("organizations")
                .values({ id: orgId, slug, name, status: "active", created_at: now, updated_at: now })
                .execute();

            await kysely
                .insertInto("org_memberships")
                .values({ id: uuid(), user_id: session.user.id, org_id: orgId, role: "owner", created_at: now })
                .execute();

            // Fire-and-forget provisioning
            provisionInstance(orgId, slug).catch((err) => {
                console.error(`[api] Background provisioning failed for ${slug}:`, err);
            });

            return json({ id: orgId, slug, name, status: "active", created_at: now, updated_at: now }, 201);
        }

        // GET /api/user/orgs — list orgs for authenticated user
        if (pathname === "/api/user/orgs" && req.method === "GET") {
            const session = await getSession(req);
            if (!session?.user) return json({ error: "Unauthorized" }, 401);

            const orgs = await kysely
                .selectFrom("org_memberships as m")
                .innerJoin("organizations as o", "o.id", "m.org_id")
                .select(["o.id", "o.slug", "o.name", "o.status", "o.created_at", "o.updated_at", "m.role"])
                .where("m.user_id", "=", session.user.id)
                .where("o.status", "!=", "deleted")
                .execute();

            return json(orgs);
        }

        // Routes with :slug
        const orgSlugMatch = pathname.match(/^\/api\/orgs\/([a-z0-9-]+)$/);
        const orgMembersMatch = pathname.match(/^\/api\/orgs\/([a-z0-9-]+)\/members$/);

        // GET /api/orgs/:slug
        if (orgSlugMatch && req.method === "GET") {
            const session = await getSession(req);
            if (!session?.user) return json({ error: "Unauthorized" }, 401);

            const slug = orgSlugMatch[1];
            const org = await kysely
                .selectFrom("organizations")
                .selectAll()
                .where("slug", "=", slug)
                .where("status", "!=", "deleted")
                .executeTakeFirst();

            if (!org) return json({ error: "Not found" }, 404);

            // Check membership
            const membership = await kysely
                .selectFrom("org_memberships")
                .select("role")
                .where("org_id", "=", org.id)
                .where("user_id", "=", session.user.id)
                .executeTakeFirst();

            if (!membership) return json({ error: "Not found" }, 404);

            return json({ ...org, role: membership.role });
        }

        // DELETE /api/orgs/:slug — soft-delete (owner only)
        if (orgSlugMatch && req.method === "DELETE") {
            const session = await getSession(req);
            if (!session?.user) return json({ error: "Unauthorized" }, 401);

            const slug = orgSlugMatch[1];
            const org = await kysely
                .selectFrom("organizations")
                .select("id")
                .where("slug", "=", slug)
                .where("status", "!=", "deleted")
                .executeTakeFirst();

            if (!org) return json({ error: "Not found" }, 404);

            const membership = await kysely
                .selectFrom("org_memberships")
                .select("role")
                .where("org_id", "=", org.id)
                .where("user_id", "=", session.user.id)
                .executeTakeFirst();

            if (membership?.role !== "owner") {
                return json({ error: "Forbidden: owner only" }, 403);
            }

            // Deprovision container first
            try {
                await deprovisionInstance(org.id, slug);
            } catch (err) {
                console.error(`[api] Deprovision error for ${slug}:`, err);
            }

            await kysely
                .updateTable("organizations")
                .set({ status: "deleted", updated_at: new Date().toISOString() })
                .where("id", "=", org.id)
                .execute();

            return json({ ok: true });
        }

        // POST /api/orgs/:slug/members — add member
        if (orgMembersMatch && req.method === "POST") {
            const session = await getSession(req);
            if (!session?.user) return json({ error: "Unauthorized" }, 401);

            const slug = orgMembersMatch[1];
            const body = (await req.json()) as { user_id?: string; role?: string };
            const { user_id, role } = body;

            if (!user_id || !role || !["owner", "admin", "member"].includes(role)) {
                return json({ error: "user_id and role (owner|admin|member) required" }, 400);
            }

            const org = await kysely
                .selectFrom("organizations")
                .select("id")
                .where("slug", "=", slug)
                .where("status", "!=", "deleted")
                .executeTakeFirst();

            if (!org) return json({ error: "Not found" }, 404);

            // Requester must be owner or admin
            const requesterMembership = await kysely
                .selectFrom("org_memberships")
                .select("role")
                .where("org_id", "=", org.id)
                .where("user_id", "=", session.user.id)
                .executeTakeFirst();

            if (!requesterMembership || requesterMembership.role === "member") {
                return json({ error: "Forbidden: admin or owner required" }, 403);
            }

            // Check target user exists
            const targetUser = await kysely
                .selectFrom("user")
                .select("id")
                .where("id", "=", user_id)
                .executeTakeFirst();
            if (!targetUser) return json({ error: "User not found" }, 404);

            // Check not already a member
            const existingMembership = await kysely
                .selectFrom("org_memberships")
                .select("id")
                .where("org_id", "=", org.id)
                .where("user_id", "=", user_id)
                .executeTakeFirst();
            if (existingMembership) {
                return json({ error: "User is already a member" }, 409);
            }

            const membershipId = uuid();
            const now = new Date().toISOString();
            await kysely
                .insertInto("org_memberships")
                .values({ id: membershipId, user_id, org_id: org.id, role: role as any, created_at: now })
                .execute();

            return json({ id: membershipId, user_id, org_id: org.id, role, created_at: now }, 201);
        }

        // GET /.well-known/jwks.json
        if (pathname === "/.well-known/jwks.json" && req.method === "GET") {
            const jwks = await getJwks();
            return json(jwks);
        }

        // POST /api/auth/org-token — issue JWT for org context
        if (pathname === "/api/auth/org-token" && req.method === "POST") {
            const session = await getSession(req);
            if (!session?.user) return json({ error: "Unauthorized" }, 401);

            const body = (await req.json()) as { orgSlug?: string };
            const orgSlug = body.orgSlug?.trim();
            if (!orgSlug) return json({ error: "orgSlug required" }, 400);

            const org = await kysely
                .selectFrom("organizations")
                .select(["id", "slug"])
                .where("slug", "=", orgSlug)
                .where("status", "!=", "deleted")
                .executeTakeFirst();
            if (!org) return json({ error: "Organization not found" }, 404);

            const membership = await kysely
                .selectFrom("org_memberships")
                .select("role")
                .where("org_id", "=", org.id)
                .where("user_id", "=", session.user.id)
                .executeTakeFirst();
            if (!membership) return json({ error: "Not a member of this organization" }, 403);

            const token = await issueOrgToken({
                sub: session.user.id,
                org_id: org.id,
                org_slug: org.slug,
                role: membership.role,
            });

            return json({ token });
        }

        return json({ error: "Not found" }, 404);
    },
});

console.log(`Control-plane server running on http://localhost:${server.port}`);
