/**
 * The real streamdown stack — only ever loaded through lazy-streamdown.tsx.
 * Do NOT import this module statically anywhere else, or the whole markdown
 * stack lands back in the main chunk.
 */
import { cjk } from "@streamdown/cjk";
import { code } from "@streamdown/code";
import { math } from "@streamdown/math";
import { mermaid } from "@streamdown/mermaid";
import { rehypeSigils } from "@/lib/sigils/rehype-sigils";
import { getMobileRuntimeConfig } from "@/lib/mobile-runtime";
import { Streamdown, defaultRehypePlugins } from "streamdown";
import type { LazyStreamdownProps } from "./lazy-streamdown";

// ponytail: mermaid disabled in the mobile WebView — a pathological diagram
// in message history pegs V8 (mermaid updateColors/marked getRegex hot in
// profiles) and allocates until the renderer OOMs. Diagrams render as plain
// code blocks on mobile; revisit with a size cap + worker if mobile diagrams
// matter.
const plugins = getMobileRuntimeConfig().isMobileBundled
    ? { cjk, code, math }
    : { cjk, code, math, mermaid };

// Spreading defaultRehypePlugins preserves the XSS protections
// (rehype-sanitize etc.) that Streamdown applies by default.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const safeRehypePlugins = [...Object.values(defaultRehypePlugins)] as any;
// Merge rehypeSigils WITH the built-ins instead of replacing them.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const sigilRehypePlugins = [...safeRehypePlugins, [rehypeSigils]] as any;

export function StreamdownImpl({ rehypeMode = "default", rehypePlugins, ...props }: LazyStreamdownProps) {
    return (
        <Streamdown
            plugins={plugins}
            rehypePlugins={rehypePlugins ?? (rehypeMode === "sigils" ? sigilRehypePlugins : safeRehypePlugins)}
            {...props}
        />
    );
}
