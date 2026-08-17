import * as React from "react";
import { ChevronLeftIcon, ChevronRightIcon, Loader2Icon } from "lucide-react";
import { PptxViewer, RECOMMENDED_ZIP_LIMITS } from "@aiden0z/pptx-renderer";

import { cn } from "@/lib/utils";
import { Button } from "@/components/ui/button";

function base64ToBytes(base64: string): Uint8Array {
  const bin = atob(base64);
  const arr = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) arr[i] = bin.charCodeAt(i);
  return arr;
}

/**
 * Preview a .pptx with its OOXML themes, masters, layouts, and fonts intact.
 * Lazy-loaded (see ArtifactCard) so the renderer stays out of the main bundle.
 */
export default function PptxPreview({ content, full = false }: { content: string; full?: boolean }) {
  const slideRef = React.useRef<HTMLDivElement>(null);
  const rendererRef = React.useRef<PptxViewer | null>(null);
  const [slideCount, setSlideCount] = React.useState(0);
  const [current, setCurrent] = React.useState(0);
  const [loading, setLoading] = React.useState(true);
  const [navigating, setNavigating] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);

  React.useEffect(() => {
    let cancelled = false;
    const controller = new AbortController();
    const container = slideRef.current;
    if (!container) return;

    setLoading(true);
    setNavigating(false);
    setSlideCount(0);
    setCurrent(0);
    setError(null);

    let bytes: Uint8Array;
    try {
      bytes = base64ToBytes(content);
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : String(err));
      setLoading(false);
      return;
    }

    const renderer = new PptxViewer(container, {
      fitMode: "contain",
      zipLimits: RECOMMENDED_ZIP_LIMITS,
      lazyMedia: true,
      lazySlides: true,
      pdfjs: false,
    });
    rendererRef.current = renderer;

    void renderer
      .open(bytes, { renderMode: "slide", signal: controller.signal })
      .then(() => {
        if (cancelled) return;
        setSlideCount(renderer.slideCount);
        setCurrent(0);
        setLoading(false);
      })
      .catch((err: unknown) => {
        if (!cancelled) {
          setError(err instanceof Error ? err.message : String(err));
          setLoading(false);
        }
      });

    return () => {
      cancelled = true;
      controller.abort();
      renderer.destroy();
      rendererRef.current = null;
    };
  }, [content]);

  const goTo = React.useCallback(
    async (index: number) => {
      const renderer = rendererRef.current;
      if (!renderer || index < 0 || index >= slideCount || navigating) return;
      setNavigating(true);
      setError(null);
      try {
        await renderer.renderSlide(index);
        if (rendererRef.current === renderer) setCurrent(index);
      } catch (err: unknown) {
        if (rendererRef.current === renderer) setError(err instanceof Error ? err.message : String(err));
      } finally {
        if (rendererRef.current === renderer) setNavigating(false);
      }
    },
    [slideCount, navigating],
  );

  return (
    <div className="flex h-full min-h-0 flex-col">
      {/* Letterbox the slide so the whole slide always fits — no inner scrollbar. */}
      <div className="relative flex min-h-0 flex-1 items-center justify-center overflow-hidden bg-muted/20 p-3">
        {loading && (
          <div className="absolute inset-0 flex items-center justify-center gap-2 text-sm text-muted-foreground">
            <Loader2Icon className="size-4 animate-spin" /> Rendering slides…
          </div>
        )}
        {error && !loading && (
          <div className="absolute top-3 z-10 rounded bg-background/90 px-3 py-2 text-center text-sm text-muted-foreground shadow-sm">
            {slideCount === 0 ? "Slides unavailable" : "Could not change slides"} — {error}
          </div>
        )}
        <div
          ref={slideRef}
          aria-label="Rendered slide"
          className={cn("h-full w-full overflow-hidden rounded shadow-sm", (loading || slideCount === 0) && "invisible")}
        />
      </div>

      {slideCount > 1 && (
        <div className="flex shrink-0 items-center justify-center gap-3 border-t border-border px-3 py-1.5">
          <Button type="button" size="icon" variant="ghost" className="size-7" disabled={current <= 0 || navigating} onClick={() => void goTo(current - 1)} aria-label="Previous slide">
            <ChevronLeftIcon className="size-4" />
          </Button>
          <span className="text-xs tabular-nums text-muted-foreground">
            {current + 1} / {slideCount}
          </span>
          <Button type="button" size="icon" variant="ghost" className="size-7" disabled={current >= slideCount - 1 || navigating} onClick={() => void goTo(current + 1)} aria-label="Next slide">
            <ChevronRightIcon className="size-4" />
          </Button>
        </div>
      )}
    </div>
  );
}
