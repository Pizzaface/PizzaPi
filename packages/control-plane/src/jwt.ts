import { generateKeyPair, exportJWK, importJWK, SignJWT, type JWK } from "jose";
import { kysely } from "./auth.js";

const ALG = "EdDSA";

interface JwtKeyRow {
    id: string;
    public_key: string;
    private_key: string;
    active: number;
    created_at: string;
}

// ── Key Management ─────────────────────────────────────────────────────────────

export async function ensureSigningKey(): Promise<void> {
    const existing = await kysely
        .selectFrom("jwt_keys")
        .select("id")
        .where("active", "=", 1)
        .executeTakeFirst();

    if (existing) return;

    const { publicKey, privateKey } = await generateKeyPair(ALG, { extractable: true });
    const pubJwk = await exportJWK(publicKey);
    const privJwk = await exportJWK(privateKey);
    const kid = crypto.randomUUID();

    pubJwk.kid = kid;
    pubJwk.alg = ALG;
    pubJwk.use = "sig";
    privJwk.kid = kid;
    privJwk.alg = ALG;

    await kysely
        .insertInto("jwt_keys")
        .values({
            id: kid,
            public_key: JSON.stringify(pubJwk),
            private_key: JSON.stringify(privJwk),
            active: 1,
            created_at: new Date().toISOString(),
        })
        .execute();

    console.log(`control-plane: generated signing key ${kid}`);
}

async function getActiveKey(): Promise<JwtKeyRow> {
    const key = await kysely
        .selectFrom("jwt_keys")
        .selectAll()
        .where("active", "=", 1)
        .orderBy("created_at", "desc")
        .executeTakeFirst();

    if (!key) throw new Error("No active signing key");
    return key as unknown as JwtKeyRow;
}

// ── Token Issuance ─────────────────────────────────────────────────────────────

export async function issueOrgToken(params: {
    sub: string;
    org_id: string;
    org_slug: string;
    role: string;
}): Promise<string> {
    const keyRow = await getActiveKey();
    const privJwk = JSON.parse(keyRow.private_key) as JWK;
    const privateKey = await importJWK(privJwk, ALG);

    return new SignJWT({
        org_id: params.org_id,
        org_slug: params.org_slug,
        role: params.role,
    })
        .setProtectedHeader({ alg: ALG, kid: keyRow.id })
        .setSubject(params.sub)
        .setIssuer("pizzapi-control-plane")
        .setIssuedAt()
        .setExpirationTime("15m")
        .sign(privateKey);
}

// ── JWKS ───────────────────────────────────────────────────────────────────────

export async function getJwks(): Promise<{ keys: JWK[] }> {
    const rows = await kysely
        .selectFrom("jwt_keys")
        .select(["id", "public_key"])
        .execute();

    const keys = rows.map((row) => {
        const jwk = JSON.parse(row.public_key) as JWK;
        return jwk;
    });

    return { keys };
}
