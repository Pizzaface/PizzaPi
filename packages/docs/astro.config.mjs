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
                        { label: "Overview", link: "/" },
                        { label: "Getting Started", link: "/getting-started/" },
                    ],
                },
                {
                    label: "Guides",
                    autogenerate: { directory: "guides" },
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
