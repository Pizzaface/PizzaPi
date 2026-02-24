/**
 * Caddy admin API client for dynamic upstream registration.
 *
 * Registers/deregisters per-org reverse proxy routes so that
 * `{slug}.pizzapi.example.com` routes to the org's container.
 */

const CADDY_ADMIN_URL = process.env.CADDY_ADMIN_URL ?? "http://localhost:2019";
const DOMAIN_SUFFIX = process.env.PIZZAPI_DOMAIN_SUFFIX ?? "pizzapi.example.com";

/**
 * Build the Caddy JSON route config for an org subdomain.
 */
function buildOrgRoute(slug: string, upstream: string) {
    return {
        match: [
            {
                host: [`${slug}.${DOMAIN_SUFFIX}`],
            },
        ],
        handle: [
            {
                handler: "reverse_proxy",
                upstreams: [{ dial: upstream }],
                headers: {
                    request: {
                        set: {
                            "X-Forwarded-Proto": ["{http.request.scheme}"],
                            "X-Real-IP": ["{http.request.remote.host}"],
                        },
                    },
                },
                // WebSocket support is automatic in Caddy's reverse_proxy
            },
        ],
        terminal: true,
    };
}

/**
 * Register an org's upstream route with Caddy.
 * Called after container provisioning succeeds.
 */
export async function registerUpstream(slug: string, host: string, port: number): Promise<void> {
    const upstream = `${host}:${port}`;
    const route = buildOrgRoute(slug, upstream);

    // We prepend the org route to the server's route list so it matches before the wildcard fallback.
    // Using Caddy's /config/ API to patch routes on the default "srv0" server.
    const configPath = "/config/apps/http/servers/srv0/routes";

    // First, get existing routes
    const getRes = await fetch(`${CADDY_ADMIN_URL}${configPath}`, { method: "GET" });

    let routes: unknown[] = [];
    if (getRes.ok) {
        routes = (await getRes.json()) as unknown[];
    }

    // Remove any existing route for this slug (idempotent)
    routes = routes.filter((r: any) => {
        const hosts = r?.match?.[0]?.host;
        return !(Array.isArray(hosts) && hosts.includes(`${slug}.${DOMAIN_SUFFIX}`));
    });

    // Prepend new route
    routes.unshift(route);

    // PUT the full routes array back
    const putRes = await fetch(`${CADDY_ADMIN_URL}${configPath}`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(routes),
    });

    if (!putRes.ok) {
        const body = await putRes.text();
        throw new Error(`Caddy register upstream failed (${putRes.status}): ${body}`);
    }

    console.log(`[caddy] Registered upstream ${slug}.${DOMAIN_SUFFIX} → ${upstream}`);
}

/**
 * Deregister an org's upstream route from Caddy.
 * Called when an org is deprovisioned/deleted.
 */
export async function deregisterUpstream(slug: string): Promise<void> {
    const configPath = "/config/apps/http/servers/srv0/routes";

    const getRes = await fetch(`${CADDY_ADMIN_URL}${configPath}`, { method: "GET" });
    if (!getRes.ok) {
        console.warn(`[caddy] Could not fetch routes for deregistration: ${getRes.status}`);
        return;
    }

    let routes = (await getRes.json()) as unknown[];

    const before = routes.length;
    routes = routes.filter((r: any) => {
        const hosts = r?.match?.[0]?.host;
        return !(Array.isArray(hosts) && hosts.includes(`${slug}.${DOMAIN_SUFFIX}`));
    });

    if (routes.length === before) {
        console.log(`[caddy] No route found for ${slug}.${DOMAIN_SUFFIX}, nothing to remove`);
        return;
    }

    const putRes = await fetch(`${CADDY_ADMIN_URL}${configPath}`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(routes),
    });

    if (!putRes.ok) {
        const body = await putRes.text();
        console.error(`[caddy] Deregister upstream failed (${putRes.status}): ${body}`);
        return;
    }

    console.log(`[caddy] Deregistered upstream for ${slug}.${DOMAIN_SUFFIX}`);
}
