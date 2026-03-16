import { defineConfig } from "astro/config";
import starlight from "@astrojs/starlight";

// https://astro.build/config
export default defineConfig({
    site: "https://pizzaface.github.io",
    base: "/PizzaPi",
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
                    label: "Customization",
                    items: [
                        { label: "Configuration", slug: "customization/configuration" },
                        { label: "MCP Servers", slug: "customization/mcp-servers" },
                        { label: "Hooks", slug: "customization/hooks" },
                        { label: "Skills", slug: "customization/skills" },
                        { label: "Agent Definitions", slug: "customization/agent-definitions" },
                        { label: "Claude Code Plugins", slug: "customization/claude-plugins" },
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
