---
name: sandbox-integration
description: Integrate Anthropic sandbox-runtime to safeguard agent tool execution
status: backlog
created: 2026-03-12T18:22:50Z
updated: 2026-03-12T18:33:35Z
---

# PRD: Agent Sandbox Integration

## Problem Statement

PizzaPi currently executes all agent tool calls (bash commands, file reads/writes, MCP tool invocations) **directly on the host machine with the full privileges of the runner process**. There is no isolation boundary between the agent and the user's filesystem, network, or system resources.

This creates several risks:

1. **Filesystem exfiltration** — A prompt injection or model hallucination could read `~/.ssh/id_rsa`, `~/.aws/credentials`, browser cookies, or any file the runner user can access.
2. **Filesystem destruction** — An errant `rm -rf /` or `rm -rf ~` could destroy the host system.
3. **Network abuse** — The agent can `curl` arbitrary endpoints, exfiltrate data to attacker-controlled servers, or make unauthorized API calls.
4. **Lateral movement** — Access to Unix sockets (Docker socket, SSH agent, etc.) lets the agent pivot to other systems.
5. **Supply chain attacks** — MCP servers and plugins run unsandboxed, so a malicious MCP server gets full host access.

The existing `hooks` system (PreToolUse/PostToolUse) provides a software-level gate but does **not** enforce OS-level isolation — a crafty bash command can bypass hook-based checks.

## Proposed Solution

Integrate [Anthropic's `sandbox-runtime`](https://github.com/anthropic-experimental/sandbox-runtime) (`@anthropic-ai/sandbox-runtime`) as the OS-level enforcement layer for all tool execution in PizzaPi.

The sandbox-runtime provides:
- **Filesystem restrictions** — allowlist/denylist for read and write paths, enforced via macOS `sandbox-exec` or Linux `bubblewrap` + seccomp filters
- **Network restrictions** — domain-level allowlists via HTTP/SOCKS proxy interception
- **Unix socket restrictions** — control access to local IPC sockets
- **Violation monitoring** — real-time sandbox violation detection and logging
- **Cross-platform** — native implementations for both macOS and Linux
- **Library API** — `SandboxManager.initialize(config)` + `SandboxManager.wrapWithSandbox(cmd)` for programmatic use

## Architecture

### Current Execution Flow (Unsandboxed)

```
Agent LLM → tool_call(bash, "npm install") → child_process.exec("npm install") → HOST
Agent LLM → tool_call(write_file, "/etc/passwd") → fs.writeFile("/etc/passwd") → HOST
```

### Proposed Execution Flow (Sandboxed)

```
Agent LLM → tool_call(bash, "npm install")
         → SandboxManager.wrapWithSandbox("npm install")
         → sandbox-exec / bubblewrap wrapper
         → Restricted child process (can only access allowlisted paths/network)

Agent LLM → tool_call(write_file, "/etc/passwd")
         → Path validation against sandbox config
         → DENIED (not in allowWrite list)
```

### Integration Points

#### 1. `packages/tools/src/bash.ts` — Command Execution
The primary integration point. Currently uses raw `child_process.exec()`. Must be wrapped with `SandboxManager.wrapWithSandbox()` so every bash command inherits sandbox restrictions.

#### 2. `packages/tools/src/write-file.ts` — File Writes
Currently uses raw `fs.writeFile()`. Must validate paths against the sandbox config's `allowWrite` / `denyWrite` rules before execution. For defense-in-depth, the bash sandbox also catches write attempts from shell commands.

#### 3. `packages/tools/src/read-file.ts` — File Reads
Currently uses raw `fs.readFile()`. Must validate paths against `denyRead` rules (e.g., `~/.ssh`, `~/.aws`, browser profiles).

#### 4. `packages/cli/src/runner/worker.ts` — Session Worker
The sandbox must be initialized once per worker session, before any tools execute. The `SandboxManager.initialize(config)` call sets up proxy servers and sandbox profiles.

#### 5. `packages/cli/src/extensions/mcp-extension.ts` — MCP Servers
MCP server processes should also be wrapped with sandbox restrictions. This is the highest-risk surface since MCP servers are third-party code.

#### 6. `packages/cli/src/config.ts` — Configuration
New `sandbox` configuration section in `PizzaPiConfig` to control sandbox behavior.

### Configuration Schema

```typescript
interface SandboxConfig {
  /** Enable/disable the sandbox. Default: true when available. */
  enabled?: boolean;

  /** Sandbox enforcement mode.
   *  - "enforce" — block violations (default)
   *  - "audit"   — log violations but don't block (for onboarding)
   *  - "off"     — disable sandbox entirely
   */
  mode?: "enforce" | "audit" | "off";

  /** Network restrictions */
  network?: {
    /**
     * Network restriction mode.
     *  - "denylist" — all domains reachable except deniedDomains (default)
     *  - "allowlist" — only allowedDomains reachable (strict)
     */
    mode?: "denylist" | "allowlist";
    /** Domains the agent is allowed to reach. Used in allowlist mode. */
    allowedDomains?: string[];
    /** Domains explicitly blocked. Used in denylist mode. */
    deniedDomains?: string[];
  };

  /** Filesystem restrictions */
  filesystem?: {
    /** Paths the agent cannot read. Default: ["~/.ssh", "~/.aws", "~/.gnupg"] */
    denyRead?: string[];
    /** Paths the agent can write to. Default: [".", "/tmp"] (cwd + temp) */
    allowWrite?: string[];
    /** Paths the agent explicitly cannot write to. Default: [".env", "~/.ssh"] */
    denyWrite?: string[];
  };

  /** Unix socket restrictions */
  sockets?: {
    /** Sockets to explicitly deny. Default: ["/var/run/docker.sock"] */
    deny?: string[];
  };

  /** MCP-specific sandbox overrides (more restrictive by default) */
  mcp?: {
    /** Override network allowlist for MCP servers. Default: [] (no network) */
    allowedDomains?: string[];
    /** Override filesystem write list for MCP servers. Default: ["/tmp"] */
    allowWrite?: string[];
  };
}
```

### Example Configuration

```json
// ~/.pizzapi/config.json
{
  "sandbox": {
    "enabled": true,
    "mode": "enforce",
    "network": {
      "allowedDomains": [
        "github.com",
        "*.github.com",
        "registry.npmjs.org",
        "bun.sh",
        "*.anthropic.com"
      ]
    },
    "filesystem": {
      "denyRead": ["~/.ssh", "~/.aws", "~/.gnupg", "~/.config/gcloud"],
      "allowWrite": [".", "/tmp"],
      "denyWrite": [".env", ".env.local", "~/.ssh"]
    }
  }
}
```

### Sensible Defaults

The sandbox should ship with **secure-by-default** settings that work for typical development:

**Filesystem (deny-read)**:
- `~/.ssh` — SSH keys
- `~/.aws` — AWS credentials
- `~/.gnupg` — GPG keys
- `~/.config/gcloud` — GCP credentials
- Browser profile directories (Chrome, Firefox, Safari cookies/passwords)
- `~/.docker/config.json` — Docker registry auth

**Filesystem (allow-write)**:
- `.` (project working directory)
- `/tmp`

**Network (allowed by default)**:
- `registry.npmjs.org` — npm
- `bun.sh` — Bun
- `github.com`, `*.github.com` — Git operations
- `*.anthropic.com` — API calls
- `*.openai.com` — API calls
- `*.googleapis.com` — API calls

**Sockets (denied by default)**:
- `/var/run/docker.sock` — Docker daemon

## User Experience

### Audit Mode (Onboarding)

New users start with `"mode": "audit"` to see what the sandbox *would* block without breaking their workflow:

```
⚠️ [sandbox:audit] Would block: read ~/.aws/credentials (tool: bash, command: "aws s3 ls")
⚠️ [sandbox:audit] Would block: network access to evil.com (tool: bash, command: "curl evil.com")
✅ [sandbox:audit] Allowed: write ./src/index.ts (in project directory)
```

### Enforce Mode (Production)

In enforce mode, violations are blocked and reported:

```
❌ [sandbox] Blocked: read ~/.ssh/id_rsa — not in allowed paths
   Tool: bash | Command: cat ~/.ssh/id_rsa
   To allow: add "~/.ssh" to sandbox.filesystem.denyRead exceptions in config
```

### UI Integration

The PizzaPi web UI should show:
- 🛡️ Sandbox status indicator (active/audit/off) in the session header
- Sandbox violation log viewable per session
- Configuration editor for sandbox rules

## Implementation Phases

### Phase 1: Complete Security Story (MVP — Phases 1+2 combined)
- Add `@anthropic-ai/sandbox-runtime` dependency
- Integrate `SandboxManager` into the worker lifecycle (`worker.ts`)
- Wrap `bash.ts` tool execution with sandbox
- Path validation in `write-file.ts` and `read-file.ts`
- Add `sandbox` config section to `PizzaPiConfig`
- 3-tier tool profiles: bash (full), read/write (filesystem), MCP (maximum restriction)
- Network denylist mode with configurable blocked domains
- SSH agent auto-detection and allowlisting via `$SSH_AUTH_SOCK`
- Default deny-read list for sensitive paths (`~/.ssh`, `~/.aws`, etc.)
- Separate sandbox profiles for MCP servers (no network, `/tmp`-only writes)
- Violation logging and forwarding to relay
- CLI flag: `--sandbox=enforce|audit|off`
- Enabled in enforce mode by default

### Phase 2: UI & Observability
- 🛡️ Sandbox status indicator in web UI session header
- Violation log viewer per session
- Config editor for sandbox rules in web UI
- Push notifications for sandbox violations

### Phase 3: Advanced Features
- Per-project sandbox profiles (`.pizzapi/config.json` sandbox overrides)
- Custom MITM proxy support for fine-grained API filtering
- Docker-based sandbox option for maximum isolation
- Sandbox profiles marketplace (community-contributed presets)
- Allowlist network mode as opt-in alternative

## Platform Support

| Platform | Mechanism | Status |
|----------|-----------|--------|
| macOS | `sandbox-exec` (Seatbelt) | ✅ Supported by sandbox-runtime |
| Linux | bubblewrap + seccomp | ✅ Supported by sandbox-runtime |
| Docker (Linux) | bubblewrap + seccomp (nested) | ⚠️ Requires `--privileged` or specific caps |
| Windows | N/A | ❌ Not supported — graceful degradation to audit mode |

## Risks & Mitigations

| Risk | Mitigation |
|------|------------|
| Sandbox breaks legitimate workflows | Audit mode for onboarding; sensible defaults; easy config escape hatches |
| Performance overhead from proxying | Proxy only when network restrictions are active; benchmark impact |
| sandbox-runtime is experimental/unstable | Pin to specific version; wrap API surface for easy replacement |
| macOS sandbox-exec deprecation concerns | Monitor Apple's stance; Linux bubblewrap is the long-term path |
| Nested sandbox in Docker | Document required capabilities; test in CI |
| Agent can modify sandbox config | Config loaded at worker start, immutable during session; project configs can't self-authorize (existing pattern) |

## Success Metrics

- **P0**: Agent cannot read `~/.ssh/id_rsa` or `~/.aws/credentials` when sandbox is enabled
- **P0**: Agent cannot `curl` arbitrary external domains when network restrictions are active
- **P1**: MCP servers run with no network access by default
- **P1**: Audit mode logs all would-be violations without blocking
- **P2**: < 5% latency increase for typical bash tool calls
- **P2**: Zero increase in configuration required for default secure setup

## Dependencies

- `@anthropic-ai/sandbox-runtime` — the core sandbox library
- macOS: built-in `sandbox-exec` (no extra install)
- Linux: `bubblewrap` package (available in most distros; may need install on minimal Docker images)

## Decisions (Finalized)

1. **Opt-out by default** — Sandbox is enabled in enforce mode for all new installs. Maximum security posture from day one. Existing users upgrading also get enforce mode (with clear release notes).

2. **SSH agent auto-detection** — The sandbox auto-detects `$SSH_AUTH_SOCK` and allowlists it when git operations are in use. The SSH agent only forwards key *signatures* (never exposes private keys), and `git push` is a core agent workflow. All SSH agent usage is logged in the violation log for audit visibility.

3. **Per-tool sandbox profiles (3 tiers):**
   - **`bash`** — Full sandbox: filesystem restrictions + network restrictions. Gets the broadest access since shell commands are the primary work surface.
   - **`write_file` / `read_file`** — Filesystem-only sandbox. No network needed. Path validation against allow/deny lists.
   - **MCP servers** — Maximum restriction. No network by default, write access to `/tmp` only, no socket access. Each MCP server can declare its own requirements in config.

4. **Network: denylist mode by default** — All domains are reachable except explicitly blocked ones. This is the permissive approach — avoids breaking workflows while still providing a mechanism to block known-bad destinations. Users can switch to allowlist mode in config for stricter environments.

5. **Ship Phase 1 + 2 together** — Deliver a complete security story: filesystem isolation + network denylist + MCP sandboxing + config schema + CLI flag + audit logging. This avoids shipping a "half sandbox" that gives false confidence.

6. **Hooks + sandbox are complementary** — Hooks run first (software gate with custom logic), then the OS sandbox enforces (kernel-level boundary). A hook can allow a command that the sandbox still blocks if it violates OS-level policy. This is defense-in-depth by design.
