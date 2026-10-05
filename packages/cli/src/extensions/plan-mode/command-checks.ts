import { GIT_SAFE_SUBCOMMANDS, GIT_SAFE_SUBCOMMAND_DESTRUCTIVE_OVERRIDES } from "./patterns.js";
import { splitShellWords, containsShellExpansion } from "./shell-parser.js";

// ── Git ──────────────────────────────────────────────────────────────────────

/**
 * `git format-patch --stdout` prints patches to stdout without writing files.
 * Without `--stdout`, format-patch writes `.patch` files to the working directory.
 */
export function isSafeGitFormatPatchInvocation(segment: string): boolean {
    const words = splitShellWords(segment);
    if (words.length < 2) return false;
    if (words[0].toLowerCase() !== "git" || words[1].toLowerCase() !== "format-patch") return false;
    // Safe only when --stdout is present (no file output)
    return words.some((w) => w === "--stdout");
}

export function isSafeGitNotesInvocation(segment: string): boolean {
    const words = splitShellWords(segment);
    // Also parse with quotes preserved so we can check shell expansion
    // against the raw token — single-quoted values like '$literal' must
    // not false-positive on `containsShellExpansion`.
    const rawWords = splitShellWords(segment, true);
    if (words.length < 2) return false;
    if (words[0].toLowerCase() !== "git" || words[1].toLowerCase() !== "notes") return false;

    let index = 2;
    while (index < words.length) {
        const arg = words[index].toLowerCase();
        if (arg === "--ref") {
            if (index + 1 >= words.length) return false;
            // Check the raw (still-quoted) token for shell expansion so
            // that properly quoted refs like '$literal' pass through while
            // unquoted $VAR or *.glob are still rejected.
            const rawRefValue = rawWords[index + 1];
            if (containsShellExpansion(rawRefValue)) return false;
            index += 2;
            continue;
        }
        if (arg.startsWith("--ref=")) {
            // Check the raw token's value portion for shell expansion.
            const rawRefValue = rawWords[index].slice("--ref=".length);
            if (containsShellExpansion(rawRefValue)) return false;
            index++;
            continue;
        }
        break;
    }

    // bare `git notes` (with or without `--ref`) defaults to `git notes list`
    if (index >= words.length) return true;

    const subcommand = words[index].toLowerCase();
    // show, list — read-only
    // get-ref  — prints the effective notes ref, also read-only
    return subcommand === "show" || subcommand === "list" || subcommand === "get-ref";
}

export function isDestructiveGitCommand(segment: string): boolean {
    const gitMatch = segment.match(/^\s*git\s+(\S+)/i);
    if (!gitMatch) return false; // not a git command

    const subcommand = gitMatch[1].toLowerCase();

    // Subcommand not on the safe list → allow known read-only invocations, then destructive
    if (!GIT_SAFE_SUBCOMMANDS.has(subcommand)) {
        if (isSafeGitNotesInvocation(segment)) return false;
        if (isSafeGitFormatPatchInvocation(segment)) return false;
        return true;
    }

    // Subcommand is safe in general, but check for destructive argument patterns
    return GIT_SAFE_SUBCOMMAND_DESTRUCTIVE_OVERRIDES.some((p) => p.test(segment));
}

// ── Tar ──────────────────────────────────────────────────────────────────────

const TAR_LONG_MODE_PATTERN = /(^|\s)--(?:create|append|update|extract|get|delete|catenate|concatenate)\b/;
const TAR_BUNDLED_MODE_PATTERN = /^\s*tar\s+(-?[A-Za-z]+)\b/i;
const TAR_DESTRUCTIVE_SHORT_MODE_PATTERN = /[cruxA]/;
/**
 * Short tar options that accept an attached argument (e.g. `-fARCHIVE`).
 * When scanning option bundles for mode letters, anything after such a flag
 * is treated as payload (not more flags) to avoid false positives.
 */
const TAR_SHORT_OPTS_WITH_ATTACHED_ARG = new Set(["f", "g", "C", "X", "T", "I", "H"]);

/** Short tar mode flags that write to or update archives. */
const TAR_WRITE_MODE_PATTERN = /[cruA]/;

export function tarShortOptsForModeScan(shortOpts: string): string {
    let out = "";
    for (let i = 0; i < shortOpts.length; i++) {
        const ch = shortOpts[i];
        out += ch;
        if (TAR_SHORT_OPTS_WITH_ATTACHED_ARG.has(ch) && i < shortOpts.length - 1) break;
    }
    return out;
}

export function isDestructiveTarCommand(segment: string): boolean {
    if (!/^\s*tar\b/i.test(segment)) return false;

    // Check for --to-stdout / -O BEFORE the long-mode early return so that
    // `tar --extract --to-stdout` is correctly treated as read-only.
    const hasLongToStdout = /(?:^|\s)--to-stdout(?:\s|$)/i.test(segment);

    if (TAR_LONG_MODE_PATTERN.test(segment)) {
        // Long-form extract/get with --to-stdout is read-only (no files written).
        // Long-form write modes (--create, --append, --update, etc.) are always
        // destructive even with --to-stdout (they produce archive data).
        if (hasLongToStdout) {
            const hasLongWriteMode = /(?:^|\s)--(?:create|append|update|delete|catenate|concatenate)\b/.test(segment);
            if (!hasLongWriteMode) return false;
        }
        return true;
    }

    // Collect all short-option mode letters across the entire command so we can
    // reason about -O (stdout) and write-mode flags (-c/-r/-u/-A) together.
    let allModeLetters = "";

    // Check the first token for the traditional no-dash form: `tar czf archive.tar`
    const bundledMatch = segment.match(TAR_BUNDLED_MODE_PATTERN);
    if (bundledMatch) {
        allModeLetters += tarShortOptsForModeScan(bundledMatch[1].replace(/^-/, ""));
    }

    // Also scan all dash-prefixed option tokens to catch patterns where the mode
    // letter appears after other options, e.g. `tar -f archive.tar -x`.
    for (const match of segment.matchAll(/(?:^|\s)-([A-Za-z]+)/g)) {
        allModeLetters += tarShortOptsForModeScan(match[1]);
    }

    // Also check for long-form --to-stdout
    const hasStdout = /O/.test(allModeLetters) || hasLongToStdout;
    const hasWriteMode = TAR_WRITE_MODE_PATTERN.test(allModeLetters);

    // -O (stdout) only makes tar safe when no write-mode flag is present.
    // `tar -cO` still creates an archive (to stdout pipe) — that's a write operation.
    // `tar -xO` extracts to stdout — genuinely read-only.
    if (hasStdout && !hasWriteMode) return false;

    // Any destructive short mode letter present → destructive
    if (TAR_DESTRUCTIVE_SHORT_MODE_PATTERN.test(allModeLetters)) return true;

    return false;
}

// ── Gawk ─────────────────────────────────────────────────────────────────────

const GAWK_INCLUDE_ARG_PATTERN = /(?:^|\s)(?:-i(\S+)|-i\s+(\S+)|--include=(\S+)|--include\s+(\S+))/gi;
const GAWK_FILE_ARG_PATTERN = /(?:^|\s)(?:-f\s*(\S+)|--file=(\S+)|--file\s+(\S+))/g;
const GAWK_INPLACE_MODULE_PATTERN = /(?:^|[\\/])inplace(?:\.awk)?$/i;

export function isDestructiveGawkCommand(segment: string): boolean {
    // Check for both `gawk` and `awk` (which may be GNU Awk on some systems)
    if (!/^\s*(?:gawk|awk)\b/i.test(segment)) return false;

    for (const match of segment.matchAll(GAWK_INCLUDE_ARG_PATTERN)) {
        const includeArg = (match[1] ?? match[2] ?? match[3] ?? match[4] ?? "").replace(/^['"]|['"]$/g, "");
        if (GAWK_INPLACE_MODULE_PATTERN.test(includeArg)) return true;
    }

    // Also flag `-f inplace.awk` / `--file=inplace.awk` because gawk ships an
    // inplace.awk library that rewrites files in-place, just like `-i inplace`.
    for (const match of segment.matchAll(GAWK_FILE_ARG_PATTERN)) {
        const fileArg = (match[1] ?? match[2] ?? match[3] ?? "").replace(/^['"]|['"]$/g, "");
        if (GAWK_INPLACE_MODULE_PATTERN.test(fileArg)) return true;
    }

    return false;
}

// ── Patch ────────────────────────────────────────────────────────────────────

const PATCH_SAFE_LONG_FLAG_PATTERN = /(?:^|\s)--(?:dry-run|check|help|version)(?:\s|$)/i;

export function isDestructivePatchCommand(segment: string): boolean {
    if (!/^\s*patch\b/i.test(segment)) return false;

    // Check for output-writing flags first, which always make patch destructive
    // even if --dry-run is present, because `-o` / `--output` causes file writes.
    // Exception: `-o -`, `--output=-`, `--output -`, and `-o-` write to stdout (read-only preview), so allow those.
    const hasOutputFlag = /\s-o\s|\s-o\S|--output\b|--output=/i.test(segment);
    if (hasOutputFlag) {
        // Check for various forms of stdout output:
        // - `-o -` (space after -o)
        // - `--output=-` (equals with dash)
        // - `--output -` (space after --output)
        // - `-o-` (no space, no equals, dash immediately after -o)
        const isStdout = /\s-o\s-(?:\s|$)|-o-(?:\s|$)|--output=-(?:\s|$)|--output\s+-(?:\s|$)/i.test(segment);
        if (isStdout) {
            // Output to stdout is read-only — but still check for reject-file
            // writing below (don't return early).
        } else {
            // Output to a file is destructive
            return true;
        }
    }

    // Check for reject-file flags: `-r FILE` / `--reject-file=FILE`.
    // If a real file path is given (not `-` for stdout), patch writes rejected
    // hunks to disk — destructive even when main output goes to stdout.
    const hasRejectFile = /\s-r\s|\s-r\S|--reject-file\b|--reject-file=/i.test(segment);
    let rejectIsStdout = false;
    if (hasRejectFile) {
        rejectIsStdout = /\s-r\s-(?:\s|$)|-r-(?:\s|$)|--reject-file=-(?:\s|$)|--reject-file\s+-(?:\s|$)/i.test(segment);
        if (!rejectIsStdout) {
            return true; // reject file writes to a real path
        }
    }

    // If output goes to stdout (`-o -`), the command is only safe if the
    // reject file is ALSO directed to stdout (`-r -`). When `-r` is omitted
    // entirely, GNU patch names the reject file after the output file with
    // `.rej` appended — so `patch -o -` without `-r -` creates `-.rej` on disk.
    if (hasOutputFlag) {
        return !rejectIsStdout;
    }

    // `patch` is generally destructive, but a few explicit flags make it read-only.
    // - `--dry-run` / `--check` verify applicability without modifying files
    // - `--help` / `--version` are informational
    // - Verify each is a complete flag, not a prefix of another (e.g., not --version-control)
    if (PATCH_SAFE_LONG_FLAG_PATTERN.test(segment)) {
        // Verify the matched flags are actually safe (not part of compound flags)
        // --dry-run, --check, --help, --version must be standalone or followed by space/=
        const isDryRun = /(?:^|\s)--dry-run(?:\s|=|$)/.test(segment);
        const isCheck = /(?:^|\s)--check(?:\s|=|$)/.test(segment);
        const isHelp = /(?:^|\s)--help(?:\s|=|$)/.test(segment);
        const isVersion = /(?:^|\s)--version(?:\s|=|$)/.test(segment);

        if (isDryRun || isCheck || isHelp || isVersion) {
            return false;
        }
    }

    // Also check for short-flag `-C` standalone (the actual --check alias is `-C`)
    // But reject patterns like `-zC` where `-C` is not standalone
    if (/(?:^|\s)-C(?:\s|$)/.test(segment)) {
        return false;
    }

    return true;
}

// ── Remote / network mutations ───────────────────────────────────────────────

const HTTP_READ_METHODS = new Set(["GET", "HEAD", "OPTIONS"]);

/**
 * curl sends a request body (and therefore usually a mutation) with any of
 * -d/--data*, -F/--form*, -T/--upload-file, --json, a non-GET -X/--request,
 * or a -K/--config file that may contain any of those. Short flags may be
 * bundled (`-sSd @body`), so bundles are scanned letter by letter.
 */
export function isDestructiveCurlCommand(segment: string): boolean {
    const words = splitShellWords(segment);
    if (words.length === 0 || words[0].toLowerCase() !== "curl") return false;
    for (let i = 1; i < words.length; i++) {
        const w = words[i];
        if (w === "--") break;
        if (w.startsWith("--")) {
            const eq = w.indexOf("=");
            const name = eq >= 0 ? w.slice(0, eq) : w;
            const inlineValue = eq >= 0 ? w.slice(eq + 1) : undefined;
            if (/^--(?:data(?:-\w+)?|json|form(?:-string)?|upload-file|config)$/i.test(name)) return true;
            if (name === "--request") {
                const method = inlineValue ?? words[i + 1] ?? "";
                if (!HTTP_READ_METHODS.has(method.toUpperCase())) return true;
            }
            continue;
        }
        if (/^-[A-Za-z0-9#:]+$/.test(w)) {
            const flags = w.slice(1);
            for (let j = 0; j < flags.length; j++) {
                const f = flags[j];
                if (f === "d" || f === "F" || f === "T" || f === "K") return true;
                if (f === "X") {
                    const method = flags.slice(j + 1) || words[i + 1] || "";
                    if (!HTTP_READ_METHODS.has(method.toUpperCase())) return true;
                    break;
                }
            }
        }
    }
    return false;
}

const GH_READ_TOP_LEVEL = new Set(["search", "status", "help", "version", "--version", "--help", "-h", "completion"]);
const GH_READ_VERBS = new Set(["list", "ls", "view", "status", "diff", "checks", "watch", "verify", "help", "--help", "-h"]);

/**
 * GitHub CLI: only explicitly read-only invocations are allowed. `gh api`
 * is allowed for GET/HEAD requests without request fields (fields switch it
 * to POST); everything else (create, edit, merge, delete, comment, run,
 * workflow dispatch, secret set, auth login, …) is treated as a mutation.
 */
export function isDestructiveGhCommand(segment: string): boolean {
    const words = splitShellWords(segment);
    if (words.length === 0 || words[0].toLowerCase() !== "gh") return false;
    // Skip global flags such as `-R owner/repo` / `--repo=owner/repo`.
    let i = 1;
    while (i < words.length && words[i].startsWith("-") && !GH_READ_TOP_LEVEL.has(words[i])) {
        if ((words[i] === "-R" || words[i] === "--repo") && i + 1 < words.length) i++;
        i++;
    }
    const group = (words[i] ?? "").toLowerCase();
    if (!group || GH_READ_TOP_LEVEL.has(group)) return false;
    if (group === "api") {
        for (let j = i + 1; j < words.length; j++) {
            const w = words[j];
            if (/^(?:-f|-F|--field|--raw-field|--input)(?:=|$)/.test(w) || /^-[fF]\S/.test(w)) return true;
            const methodMatch = w.match(/^(?:-X|--method)(?:=(.*))?$/) ?? w.match(/^-X(\S+)$/);
            if (methodMatch) {
                const method = methodMatch[1] ?? words[j + 1] ?? "";
                if (!HTTP_READ_METHODS.has(method.toUpperCase())) return true;
            }
        }
        return false;
    }
    const verb = (words[i + 1] ?? "").toLowerCase();
    return !GH_READ_VERBS.has(verb);
}

const CONTAINER_READ_SUBCOMMANDS = new Set([
    "ps", "images", "inspect", "logs", "version", "info", "stats", "top", "history", "port",
    "diff", "events", "search", "help", "--help", "-h", "--version", "-v",
]);
const CONTAINER_GROUP_SUBCOMMANDS = new Set([
    "container", "image", "volume", "network", "compose", "context", "system", "buildx",
    "plugin", "node", "service", "stack", "secret", "config", "manifest", "trust",
]);
const CONTAINER_READ_SECOND_LEVEL = new Set([
    "ls", "list", "ps", "inspect", "logs", "history", "top", "port", "config", "images", "version",
    "df", "info", "help", "--help", "-h",
]);
const KUBECTL_READ_SUBCOMMANDS = new Set([
    "get", "describe", "logs", "explain", "version", "api-resources", "api-versions", "cluster-info",
    "top", "help", "--help", "-h", "diff", "events",
]);
const KUBECTL_READ_CONFIG = new Set(["view", "get-contexts", "get-clusters", "get-users", "current-context"]);
const HELM_READ_SUBCOMMANDS = new Set([
    "list", "ls", "status", "get", "history", "show", "search", "version", "env", "template", "lint",
    "help", "--help", "-h",
]);

/**
 * Global options that take a separate value (`-n default`, `--context prod`).
 * Only options that *require* a value belong here: listing a boolean flag
 * would make it swallow the real subcommand (`docker -D rm ps` must not be
 * read as `ps`). Attached forms (`--namespace=x`, `-nx`) are a single token
 * and need no entry.
 *
 * Fail closed (review R2-2): before a subcommand is identified, a separate
 * option token that is in neither this table nor the tool's boolean table
 * might take a value (`kubectl --as-user-extra get delete pod x` runs
 * `delete`), so the command is treated as destructive.
 */
const DOCKER_GLOBAL_VALUE_OPTIONS = [
    "-c", "--context", "-H", "--host", "-l", "--log-level", "--config",
    "--tlscacert", "--tlscert", "--tlskey",
];
const PODMAN_GLOBAL_VALUE_OPTIONS = [
    "-c", "--connection", "--url", "--identity", "--log-level", "--root", "--runroot", "--runtime",
    "--runtime-flag", "--storage-driver", "--storage-opt", "--tmpdir", "--cgroup-manager", "--conmon",
    "--events-backend", "--hooks-dir", "--imagestore", "--module", "--network-cmd-path",
    "--network-config-dir", "--volumepath", "--out", "--ssh", "--config",
];
const NERDCTL_GLOBAL_VALUE_OPTIONS = [
    "-n", "--namespace", "-a", "-H", "--address", "--host", "--snapshotter", "--storage-driver",
    "--cni-path", "--cni-netconfpath", "--data-root", "--cgroup-manager", "--host-gateway-ip",
    "--hosts-dir", "--bridge-ip",
];
const KUBECTL_GLOBAL_VALUE_OPTIONS = [
    "-n", "--namespace", "--context", "--cluster", "--user", "-s", "--server", "--kubeconfig",
    "--token", "--as", "--as-group", "--as-uid", "--certificate-authority", "--client-certificate",
    "--client-key", "--request-timeout", "--tls-server-name", "-v", "--v", "--vmodule", "--cache-dir",
    "--username", "--password", "--profile", "--profile-output", "--log-file", "--log-dir",
    "--log-file-max-size", "--log-backtrace-at", "--stderrthreshold", "--kuberc",
    "--log-flush-frequency", "--config", "--as-user-extra",
];
const HELM_GLOBAL_VALUE_OPTIONS = [
    "-n", "--namespace", "--kube-context", "--kubeconfig", "--kube-apiserver", "--kube-as-group",
    "--kube-as-user", "--kube-ca-file", "--kube-token", "--kube-tls-server-name", "--registry-config",
    "--repository-cache", "--repository-config", "--burst-limit", "--qps", "--content-cache",
];
/** `docker compose` / `podman compose` options that sit before the compose subcommand. */
const COMPOSE_VALUE_OPTIONS = [
    "-f", "--file", "-p", "--project-name", "--profile", "--env-file", "--project-directory",
    "--ansi", "--parallel", "--progress",
];
/** Global options known to take no value (they never consume the next word). */
const COMMON_BOOLEAN_OPTIONS = ["-h", "--help"];
const DOCKER_GLOBAL_BOOLEAN_OPTIONS = ["-D", "--debug", "--tls", "--tlsverify", "-v", "--version"];
const PODMAN_GLOBAL_BOOLEAN_OPTIONS = ["-r", "--remote", "--syslog", "--noout", "--transient-store", "-v", "--version"];
const NERDCTL_GLOBAL_BOOLEAN_OPTIONS = ["--debug", "--debug-full", "--experimental", "--insecure-registry", "-v", "--version"];
const KUBECTL_GLOBAL_BOOLEAN_OPTIONS = [
    "--insecure-skip-tls-verify", "--match-server-version", "--warnings-as-errors", "--disable-compression",
    "--logtostderr", "--alsologtostderr", "--add-dir-header", "--skip-headers", "--skip-log-headers",
    "--one-output",
];
const HELM_GLOBAL_BOOLEAN_OPTIONS = ["--debug", "--kube-insecure-skip-tls-verify"];
const COMPOSE_BOOLEAN_OPTIONS = ["--dry-run", "--compatibility", "--all-resources"];
const CLUSTER_GLOBAL_BOOLEAN_OPTIONS: Record<string, ReadonlySet<string>> = {
    docker: new Set([...COMMON_BOOLEAN_OPTIONS, ...DOCKER_GLOBAL_BOOLEAN_OPTIONS]),
    podman: new Set([...COMMON_BOOLEAN_OPTIONS, ...PODMAN_GLOBAL_BOOLEAN_OPTIONS]),
    nerdctl: new Set([...COMMON_BOOLEAN_OPTIONS, ...NERDCTL_GLOBAL_BOOLEAN_OPTIONS]),
    kubectl: new Set([...COMMON_BOOLEAN_OPTIONS, ...KUBECTL_GLOBAL_BOOLEAN_OPTIONS]),
    oc: new Set([...COMMON_BOOLEAN_OPTIONS, ...KUBECTL_GLOBAL_BOOLEAN_OPTIONS]),
    helm: new Set([...COMMON_BOOLEAN_OPTIONS, ...HELM_GLOBAL_BOOLEAN_OPTIONS]),
};
/**
 * kubectl/oc options that write a file wherever they appear: `--profile`
 * (other than `none`) writes `./profile.pprof` or `--profile-output`, and the
 * klog options write log files.
 */
const KUBECTL_FILE_WRITING_OPTIONS = ["--profile", "--profile-output", "--log-file", "--log-dir"];
const CLUSTER_GLOBAL_VALUE_OPTIONS: Record<string, ReadonlySet<string>> = {
    docker: new Set(DOCKER_GLOBAL_VALUE_OPTIONS),
    podman: new Set(PODMAN_GLOBAL_VALUE_OPTIONS),
    nerdctl: new Set(NERDCTL_GLOBAL_VALUE_OPTIONS),
    kubectl: new Set(KUBECTL_GLOBAL_VALUE_OPTIONS),
    oc: new Set(KUBECTL_GLOBAL_VALUE_OPTIONS),
    helm: new Set(HELM_GLOBAL_VALUE_OPTIONS),
};
const COMPOSE_VALUE_OPTION_SET: ReadonlySet<string> = new Set(COMPOSE_VALUE_OPTIONS);
const HELP_VERSION_WORDS = new Set(["--help", "-h", "--version"]);
/** Stand-in "subcommand" for an unclassifiable option; never on a read allowlist. */
const UNKNOWN_OPTION = "\0unknown-option";

/**
 * Return the next positional word at or after `start`, skipping option
 * flags and consuming the separate value of each option in `valueOptions`.
 * `--help`/`-h`/`--version` count as positional so they can be classified.
 * A separate option token in neither `valueOptions` nor `booleanOptions`
 * yields {@link UNKNOWN_OPTION}: it might take a value and so hide the real
 * positional, and callers must treat it as unsafe.
 */
function nextClusterPositional(
    words: string[],
    start: number,
    valueOptions: ReadonlySet<string>,
    booleanOptions: ReadonlySet<string>,
): { word: string; next: number } {
    let i = start;
    while (i < words.length) {
        const w = words[i];
        if (w === "--") return { word: words[i + 1] ?? "", next: i + 2 };
        if (HELP_VERSION_WORDS.has(w)) return { word: w, next: i + 1 };
        if (w.startsWith("-") && w.length > 1) {
            if (valueOptions.has(w)) { i += 2; continue; }
            // Self-contained forms cannot consume the next word:
            // `--opt=value`, a known boolean, or an attached short value (`-nx`, `-n=x`).
            if (
                (w.startsWith("--") && w.includes("=")) ||
                booleanOptions.has(w) ||
                (!w.startsWith("--") && valueOptions.has(w.slice(0, 2)))
            ) {
                i += 1;
                continue;
            }
            return { word: UNKNOWN_OPTION, next: i + 1 };
        }
        return { word: w, next: i + 1 };
    }
    return { word: "", next: i };
}

/** Does a kubectl/oc command use an option that writes a local file? */
function usesKubectlFileWritingOption(words: string[]): boolean {
    for (let i = 1; i < words.length; i++) {
        const w = words[i];
        if (w === "--") break;
        for (const opt of KUBECTL_FILE_WRITING_OPTIONS) {
            let value: string | undefined;
            if (w === opt) value = words[i + 1] ?? "";
            else if (w.startsWith(`${opt}=`)) value = w.slice(opt.length + 1);
            else continue;
            if (opt === "--profile" && value === "none") continue;
            return true;
        }
    }
    return false;
}

/** docker/podman/nerdctl, kubectl/oc and helm: allowlist of read-only subcommands. */
export function isDestructiveClusterCommand(segment: string): boolean {
    const all = splitShellWords(segment);
    if (all.length === 0) return false;
    const tool = all[0].toLowerCase();
    const globalValueOptions = CLUSTER_GLOBAL_VALUE_OPTIONS[tool];
    if (!globalValueOptions) return false;
    // Skip global options (consuming their values) to find the subcommand,
    // then do the same for a second-level subcommand (`config view`,
    // `compose -f x.yml ps`). Global options may also appear between them.
    const globalBooleanOptions = CLUSTER_GLOBAL_BOOLEAN_OPTIONS[tool];
    if ((tool === "kubectl" || tool === "oc") && usesKubectlFileWritingOption(all)) return true;
    const first = nextClusterPositional(all, 1, globalValueOptions, globalBooleanOptions);
    if (first.word === UNKNOWN_OPTION) return true;
    const sub = first.word.toLowerCase();
    if (!sub) return false;
    const secondValueOptions = sub === "compose"
        ? new Set([...globalValueOptions, ...COMPOSE_VALUE_OPTION_SET])
        : globalValueOptions;
    const secondBooleanOptions = sub === "compose"
        ? new Set([...globalBooleanOptions, ...COMPOSE_BOOLEAN_OPTIONS])
        : globalBooleanOptions;
    // An unknown option here yields UNKNOWN_OPTION, which no second-level
    // allowlist contains, so it fails closed wherever sub2 is consulted.
    const sub2 = nextClusterPositional(all, first.next, secondValueOptions, secondBooleanOptions).word.toLowerCase();
    if (tool === "docker" || tool === "podman" || tool === "nerdctl") {
        if (CONTAINER_READ_SUBCOMMANDS.has(sub)) return false;
        if (CONTAINER_GROUP_SUBCOMMANDS.has(sub)) return !CONTAINER_READ_SECOND_LEVEL.has(sub2);
        return true;
    }
    if (tool === "kubectl" || tool === "oc") {
        if (sub === "config") return !KUBECTL_READ_CONFIG.has(sub2);
        if (sub === "auth") return sub2 !== "can-i" && sub2 !== "whoami";
        return !KUBECTL_READ_SUBCOMMANDS.has(sub);
    }
    return !HELM_READ_SUBCOMMANDS.has(sub);
}

// ── awk / sed command execution ──────────────────────────────────────────────

/**
 * awk can run shell commands (`system()`, `print | "cmd"`, `"cmd" | getline`,
 * `|&` coprocesses) and write files (`print > "file"`) from inside a quoted
 * program, which the shell-level redirection check cannot see.
 */
export function isDestructiveAwkProgram(segment: string): boolean {
    if (!/^\s*(?:awk|gawk|mawk|nawk)\b/i.test(segment)) return false;
    return /\bsystem\s*\(|\|\s*getline\b|\|&|\bprintf?\b[^;{}]*[|>]/.test(segment);
}

/**
 * GNU sed's `e` command / `s///e` flag execute shell commands, and `w`/`W`
 * (command or `s///w` flag) write files — all from inside a quoted script.
 */
export function isDestructiveSedScript(segment: string): boolean {
    if (!/^\s*(?:sed|gsed)\b/i.test(segment)) return false;
    const args = segment.replace(/^\s*\S+/, "");
    return /(?:^|[;{}'"\s])[\d,$]*[eEwW](?:\s|$|['"])/.test(args) ||
        /\/[gpiImM\d]*[ewW](?:\s|$|['";}])/.test(args);
}

// ── find -exec ───────────────────────────────────────────────────────────────

/**
 * Returns the commands run by `find … -exec/-execdir/-ok/-okdir CMD … ;|+`,
 * or null when the segment is not a `find` with an exec action.
 */
export function extractFindExecCommands(segment: string): string[] | null {
    const words = splitShellWords(segment);
    if (words.length === 0 || words[0].toLowerCase() !== "find") return null;
    const commands: string[] = [];
    for (let i = 1; i < words.length; i++) {
        if (!/^-(?:exec|execdir|ok|okdir)$/.test(words[i])) continue;
        const cmd: string[] = [];
        let j = i + 1;
        for (; j < words.length && words[j] !== ";" && words[j] !== "+"; j++) cmd.push(words[j]);
        commands.push(cmd.join(" "));
        i = j;
    }
    return commands.length > 0 ? commands : null;
}
