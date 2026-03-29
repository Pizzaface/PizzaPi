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
        "/guides/standalone-mode/":  "/PizzaPi/running/standalone-mode/",
        "/guides/runner-daemon/":    "/PizzaPi/running/runner-daemon/",
        "/guides/self-hosting/":     "/PizzaPi/deployment/self-hosting/",
        "/guides/tailscale/":        "/PizzaPi/deployment/tailscale/",
        "/guides/mac-setup/":        "/PizzaPi/deployment/mac-setup/",
        "/guides/configuration/":    "/PizzaPi/customization/configuration/",
        "/guides/skills/":           "/PizzaPi/customization/skills/",
        "/guides/claude-plugins/":   "/PizzaPi/customization/claude-plugins/",
        "/guides/subagents/":        "/PizzaPi/customization/subagents/",
        "/guides/sandbox/":          "/PizzaPi/security/sandbox/",
        "/guides/safe-mode/":        "/PizzaPi/security/sandbox/",
        "/guides/development/":      "/PizzaPi/reference/development/",
        // getting-started was at root level, not under guides/
        "/getting-started/":         "/PizzaPi/start-here/getting-started/",
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
                {
                    label: "Start Here",
                    items: [
                        { label: "Overview", slug: "index" },
                        { label: "Installation", slug: "start-here/installation" },
                        { label: "Getting Started", slug: "start-here/getting-started" },
                        { label: "Your First Remote Session", slug: "start-here/first-remote-session" },
                    ],
                },
                {
                    label: "Running PizzaPi",
                    items: [
                        { label: "CLI Reference", slug: "running/cli-reference" },
                        { label: "Standalone Mode", slug: "running/standalone-mode" },
                        { label: "Runner Daemon", slug: "running/runner-daemon" },
                    ],
                },
                {
                    label: "Deployment",
                    items: [
                        { label: "Self-Hosting", slug: "deployment/self-hosting" },
                        { label: "Tailscale HTTPS", slug: "deployment/tailscale" },
                        { label: "macOS Service", slug: "deployment/mac-setup" },
                    ],
                },
                {
                    label: "Web UI",
                    items: [
                        { label: "Overview", slug: "web-ui/overview" },
                        { label: "File Explorer", slug: "web-ui/file-explorer" },
                        { label: "Git Panel", slug: "web-ui/git-panel" },
                        { label: "Web Terminal", slug: "web-ui/terminal" },
                        { label: "Usage Dashboard", slug: "web-ui/usage-dashboard" },
                        { label: "Push Notifications", slug: "web-ui/push-notifications" },
                    ],
                },
                {
                    label: "Features",
                    items: [
                        { label: "Slash Commands", slug: "features/slash-commands" },
                        { label: "Plan Mode", slug: "features/plan-mode" },
                        { label: "Multi-Agent Sessions", slug: "features/multi-agent" },
                        { label: "Webhooks", slug: "features/webhooks" },
                        { label: "Tunnel Tools", slug: "features/tunnels" },
                    ],
                },
                {
                    label: "Customization",
                    items: [
                        { label: "Configuration", slug: "customization/configuration" },
                        { label: "MCP Servers", slug: "customization/mcp-servers" },
                        { label: "Hooks", slug: "customization/hooks" },
                        { label: "Tool Search", slug: "customization/tool-search" },
                        { label: "Prompt Templates", slug: "customization/prompt-templates" },
                        { label: "Skills", slug: "customization/skills" },
                        { label: "Agent Definitions", slug: "customization/agent-definitions" },
                        { label: "Claude Code Plugins", slug: "customization/claude-plugins" },
                        { label: "Runner Services", slug: "customization/runner-services" },
                        { label: "Subagents", slug: "customization/subagents" },
                    ],
                },
                {
                    label: "Security",
                    items: [
                        { label: "Agent Sandbox", slug: "security/sandbox" },
                    ],
                },
                {
                    label: "Reference",
                    autogenerate: { directory: "reference" },
                },
            ],
            components: {},
            tableOfContents: { minHeadingLevel: 2, maxHeadingLevel: 4 },
        }),
    ],
});
