/**
 * Lazy boundary for the markdown rendering stack (streamdown + mermaid +
 * katex + micromark/hast — ~1MB minified). Keeping it out of the main chunk
 * cuts boot-time parse and heap, which the memory-constrained mobile WebView
 * needs; desktop just gets a faster first paint. The chunk loads on first
 * markdown render and stays cached.
 */
import * as React from "react";
import type * as sd from "streamdown";

export type StreamdownProps = React.ComponentProps<typeof sd.Streamdown>;

export type LazyStreamdownProps = StreamdownProps & {
    /**
     * Which rehype pipeline to use (resolved inside the lazy chunk):
     *  - "default": Streamdown's built-in sanitize/harden plugins
     *  - "sigils":  built-ins + rehypeSigils appended
     * Ignored when an explicit `rehypePlugins` prop is passed.
     */
    rehypeMode?: "default" | "sigils";
};

const Impl = React.lazy(() =>
    import("./streamdown-impl").then((m) => ({ default: m.StreamdownImpl })),
);

/** Drop-in Streamdown replacement with the standard plugin set bundled. */
export function LazyStreamdown({ children, ...props }: LazyStreamdownProps) {
    return (
        <React.Suspense
            // ponytail: raw text fallback — visible for one frame on first load
            fallback={<div className="whitespace-pre-wrap text-sm">{children}</div>}
        >
            <Impl {...props}>{children}</Impl>
        </React.Suspense>
    );
}
