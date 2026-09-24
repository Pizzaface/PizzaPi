import { defineConfig } from "astro/config";
import starlight from "@astrojs/starlight";

// https://astro.build/config
export default defineConfig({
    site: "https://pizzaface.github.io",
    base: "/PizzaPi",
    // Redirect old /guides/* paths so existing public links don't 404.
    // Targets must include /PizzaPi base path — Astro doesn't prepend it automatically.
    redirects: {
        "/guides/installation/":     "/PizzaPi/start-here/installation/",
        "/guides/quick-setup/":      "/PizzaPi/start-here/getting-started/",
        "/guides/cli-reference/":    "/PizzaPi/running/cli-reference/",
        "/guides/standalone-mode/":  "/PizzaPi/start-here/installation/#relay-free-and-interactive-use",
        "/guides/runner-daemon/":    "/PizzaPi/running/runner-daemon/",
        "/guides/self-hosting/":     "/PizzaPi/deployment/self-hosting/",
        "/guides/tailscale/":        "/PizzaPi/deployment/self-hosting/#remote-access-with-tailscale-https",
        "/guides/mac-setup/":        "/PizzaPi/running/runner-daemon/#running-as-a-system-service",
        "/guides/configuration/":    "/PizzaPi/customization/configuration/",
        "/guides/skills/":           "/PizzaPi/customization/skills/",
        "/guides/claude-plugins/":   "/PizzaPi/customization/claude-plugins/",
        "/guides/subagents/":        "/PizzaPi/customization/subagents/",
        "/guides/sandbox/":          "/PizzaPi/security/sandbox/",
        "/guides/safe-mode/":        "/PizzaPi/security/sandbox/",
        "/guides/development/":      "/PizzaPi/reference/architecture/#development",
        // Consolidated onboarding pages.
        "/getting-started/":         "/PizzaPi/start-here/getting-started/",
        "/start-here/first-remote-session/": "/PizzaPi/start-here/getting-started/",
        "/running/standalone-mode/": "/PizzaPi/start-here/installation/#relay-free-and-interactive-use",
        "/web-ui/terminal/": "/PizzaPi/web-ui/workspaces/#web-terminal",
        // Merged public guides; fragments are retained by browser redirects.
        "/deployment/mac-setup/": "/PizzaPi/running/runner-daemon/",
        "/deployment/tailscale/": "/PizzaPi/deployment/self-hosting/#remote-access-with-tailscale-https",
        "/deployment/tunnel-tls/": "/PizzaPi/deployment/self-hosting/#https-for-tunnelled-development-servers",
        "/deployment/mobile-push/": "/PizzaPi/web-ui/preferences/#native-android-push",
        "/reference/mobile-builds/": "/PizzaPi/start-here/installation/",
        "/reference/windows-crashes/": "/PizzaPi/start-here/installation/",
        "/reference/environment-variables/": "/PizzaPi/customization/configuration/#environment-variables",
        "/reference/protocol/": "/PizzaPi/reference/architecture/#client-and-runner-communication",
        "/reference/development/": "/PizzaPi/reference/architecture/#development",
        "/web-ui/file-explorer/": "/PizzaPi/web-ui/workspaces/",
        "/web-ui/git-panel/": "/PizzaPi/web-ui/workspaces/#review-git-changes",
        "/web-ui/plan-mode/": "/PizzaPi/features/plan-mode/#plan-mode-in-the-web-ui",
        "/web-ui/slash-commands/": "/PizzaPi/features/slash-commands/",
        "/web-ui/push-notifications/": "/PizzaPi/web-ui/preferences/#notifications",
        "/features/multi-agent/": "/PizzaPi/customization/subagents/",
        "/customization/agent-definitions/": "/PizzaPi/customization/subagents/#agent-definitions",
        "/customization/tool-search/": "/PizzaPi/customization/mcp-servers/#tool-search-and-deferred-loading",
        "/customization/workflows/": "/PizzaPi/customization/subagents/#when-to-use-workflows",
        "/customization/prompt-templates/": "/PizzaPi/customization/skills/#prompt-templates"
    },
    integrations: [
        starlight({
            title: "PizzaPi",
            description:
                "A self-hosted web interface and relay server for the pi coding agent. Stream live AI coding sessions to any browser and interact remotely from mobile or desktop.",
            logo: {
                src: "./src/assets/logo.svg",
                replacesTitle: false,
            },
            social: [
                {
                    icon: "github",
                    label: "GitHub",
                    href: "https://github.com/Pizzaface/PizzaPi",
                },
            ],
            editLink: {
                baseUrl: "https://github.com/Pizzaface/PizzaPi/edit/main/packages/docs/",
            },
            customCss: ["./src/styles/custom.css"],
            favicon: "/favicon.svg",
            head: [
                {
                    tag: "meta",
                    attrs: {
                        name: "og:image",
                        content: "https://pizzaface.github.io/PizzaPi/og-image.png",
                    },
                },
            ],
            sidebar: [
                { label: "Start Here", items: [
                    { label: "Overview", slug: "index" },
                    { label: "Install", slug: "start-here/installation" },
                    { label: "Your First Working Session", slug: "start-here/getting-started" },
                ] },
                { label: "Running & Deployment", items: [
                    { label: "CLI Reference", slug: "running/cli-reference" },
                    { label: "Runner Daemon", slug: "running/runner-daemon" },
                    { label: "Self-Hosting & HTTPS", slug: "deployment/self-hosting" },
                    { label: "Runner Container", slug: "deployment/runner-container" },
                ] },
                { label: "Web UI", items: [
                    { label: "Overview", slug: "web-ui/overview" },
                    { label: "Workspace Panels", slug: "web-ui/workspaces" },
                    { label: "Usage Dashboard", slug: "web-ui/usage-dashboard" },
                    { label: "Preferences & Notifications", slug: "web-ui/preferences" },
                ] },
                { label: "Features", items: [
                    { label: "Providers & Models", slug: "features/providers-and-models" },
                    { label: "Sessions & Context", slug: "features/sessions" },
                    { label: "Slash Commands", slug: "features/slash-commands" },
                    { label: "Plan Mode", slug: "features/plan-mode" },
                    { label: "Session Goals", slug: "features/goals" },
                    { label: "Pi Packages", slug: "features/pi-packages" },
                    { label: "Webhooks", slug: "features/webhooks" },
                    { label: "Tunnel Tools", slug: "features/tunnels" },
                ] },
                { label: "Customization", items: [
                    { label: "Configuration & Environment", slug: "customization/configuration" },
                    { label: "MCP Servers & Tool Search", slug: "customization/mcp-servers" },
                    { label: "Hooks", slug: "customization/hooks" },
                    { label: "Skills", slug: "customization/skills" },
                    { label: "Claude Code Plugins", slug: "customization/claude-plugins" },
                    { label: "Agent Definitions & Subagents", slug: "customization/subagents" },
                    { label: "Runner Services", slug: "customization/runner-services" },
                    { label: "Overlay Packages & SDK", slug: "customization/overlay-packages" },
                ] },
                { label: "Security", items: [{ label: "Agent Sandbox", slug: "security/sandbox" }] },
                { label: "Reference", items: [{ autogenerate: { directory: "reference" } }] },
            ],
            components: {},
            tableOfContents: { minHeadingLevel: 2, maxHeadingLevel: 4 },
        }),
    ],
});
