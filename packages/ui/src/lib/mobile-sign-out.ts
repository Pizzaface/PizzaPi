/** Run mobile sign-out's best-effort server steps in credential-safe order. */
export async function runMobileSignOutSteps(
    stopPush: () => Promise<unknown>,
    revokeKey: () => Promise<unknown>,
    clearApiKey: () => Promise<unknown>,
): Promise<void> {
    try {
        await stopPush();
    } catch {
        // Push cleanup must not prevent local sign-out.
    }
    try {
        await revokeKey();
    } catch {
        // Server-side revocation is best-effort; local sign-out must complete.
    }
    try {
        await clearApiKey();
    } catch {
        // Local breadcrumbs are still cleared by the caller.
    }
}
