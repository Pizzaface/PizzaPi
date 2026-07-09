# Audit: deployment/tailscale.mdx
Verdict: MINOR ISSUES
Claims checked: 26 | Failed: 2

## Findings

### [P1] Step 1 `tailscale cert` is unnecessary and the "Serve uses these automatically" claim is false
- Claim (line ~20): "`tailscale cert your-hostname.tail12345.ts.net` ... This writes `.crt` and `.key` to the current directory. Tailscale Serve uses these automatically — you don't need to configure them manually."
- Reality: `tailscale serve` and `tailscale cert` are independent features. `tailscale serve --bg http://localhost:7492` provisions and manages its own HTTPS certificate on port 443; it does NOT read the `.crt`/`.key` files produced by `tailscale cert`. Those files are only useful when running your own TLS-terminating web server (e.g. the Vite dev server in the later "Development with Tailscale TLS" section, which does read `certs/ts.crt`/`certs/ts.key` per `packages/ui/vite.config.ts:36-43`). No code in the repo references host-generated `.crt`/`.key` files for the production serve path. The step is harmless but misleading — it implies Serve depends on a manually-generated cert it never consumes.
- Fix: Drop Step 1 entirely for the Serve flow (Serve auto-provisions TLS), or relabel it as optional background on how Tailscale issues certs. Reserve `tailscale cert` for the dev-server section where the files are actually used.

### [P3] "Without Docker" tab omits the required build step
- Claim (line ~62): "Without Docker" tab ends with `export PIZZAPI_EXTRA_ORIGINS=...` then `cd packages/server && bun run start`.
- Reality: `packages/server/package.json:10` defines `"start": "bun dist/index.js"`, which requires a prior `bun run build` to produce `dist/`. Running `bun run start` on a fresh checkout fails. `deployment/self-hosting.mdx` "Running Without Docker" correctly includes `bun install` + `bun run build` before starting.
- Fix: Add `bun install && bun run build` before `bun run start`, or point at `bun run dev` (`packages/server/package.json:9`) which runs source directly with `--watch`.

### [P3] Duplicated extraOrigins guidance overlaps self-hosting.mdx
- Claim: Step 3 re-explains `PIZZAPI_EXTRA_ORIGINS` / `docker/compose.override.yml` / `pizzapi web config set extraOrigins`.
- Reality: `deployment/self-hosting.mdx` already documents `PIZZAPI_EXTRA_ORIGINS` (env-var table), `pizzapi web config set extraOrigins`, `pizzapi web --origins`, and the `docker/compose.override.yml` override pattern. The Tailscale page restates the mechanics rather than linking.
- Fix: Keep only the Tailscale-specific value (`https://your-hostname.tail12345.ts.net`) and link to self-hosting.mdx for the env-var/override mechanics, reducing drift risk.

### [P3] Verbosity: `tailscale serve --https=443 off` is non-obvious vs `tailscale serve off`
- Claim (line ~88): "Stop serving: `tailscale serve --https=443 off`"
- Reality: This is a valid Tailscale incantation but the simpler `tailscale serve off` / `tailscale serve reset` is the documented way to clear a serve config. The `--https=443` qualifier is not needed for a single-port serve and may confuse readers copying commands.
- Fix: Use `tailscale serve off` (or note both).

## Redesign notes
- Reorder Setup so the only required action is `tailscale serve --bg http://localhost:7492` + setting `PIZZAPI_EXTRA_ORIGINS`; demote cert generation to the dev-only section.
- The three TabItem variants (pizza web / manual compose / no-Docker) duplicate the "how to set an env var" decision tree already in self-hosting.mdx — consider a single canonical instruction plus a cross-link.
- Troubleshooting table is useful and accurate; keep as-is.
- "MagicDNS enabled by default" and `tailscale status --self` tips are accurate external facts; fine to keep.

## Code UX opportunities
- `packages/cli/src/web.ts` could expose a first-class `pizzapi web config add-origin <url>` helper that normalizes (strips trailing slash, dedupes) so users don't hit the "Invalid origin" trap documented in the troubleshooting table.
- The server could auto-trust the Tailscale hostname when `tailscale serve`/`funnel` is detected, removing the manual `PIZZAPI_EXTRA_ORIGINS` step that is the most error-prone part of this guide (most troubleshooting rows trace back to it).
- `bun run start` failing without `dist/` is a footgun; `packages/server/package.json:10` could fall back to `bun src/index.ts` when `dist/index.js` is absent, eliminating the missing-build-step doc gap.
