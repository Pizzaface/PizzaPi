import { createRequire } from "node:module";
import { delimiter, dirname } from "node:path";

/**
 * NODE_PATH for runner subprocesses so pi packages resolve the HOST pi.
 *
 * Under Bun, pi's extension loader imports extensions natively, which bypasses
 * its alias table. A package without its own pi copy would then make Bun
 * auto-install a second pi into ~/.bun/install/cache (~50 MB per worker).
 * NODE_PATH takes precedence over that auto-install, so packages fall through
 * to the node_modules dir holding the host's pi-coding-agent (and its siblings:
 * pi-ai, pi-agent-core, pi-tui, typebox).
 *
 * ponytail: a package with pi in its OWN node_modules still wins over
 * NODE_PATH. That case is a packaging rule (peerDependencies only), documented
 * in the extension-sdk-reference skill.
 */
export function hostPiNodePath(existing: string | undefined, resolveFrom: string = import.meta.url): string | undefined {
    let hostDir: string;
    try {
        // .../node_modules/@earendil-works/pi-coding-agent/package.json → .../node_modules
        const pkg = createRequire(resolveFrom).resolve("@earendil-works/pi-coding-agent/package.json");
        hostDir = dirname(dirname(dirname(pkg)));
    } catch {
        return existing;
    }
    // Compiled binaries embed pi (virtual modules); there is no on-disk copy to point at.
    if (/\$bunfs|~BUN/.test(hostDir)) return existing;
    const parts = (existing ?? "").split(delimiter).filter(Boolean);
    if (parts.includes(hostDir)) return existing;
    return [hostDir, ...parts].join(delimiter);
}
