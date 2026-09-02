import * as React from "react";
import { ChevronLeftIcon, ChevronRightIcon, Loader2Icon } from "lucide-react";
import { PptxRenderer } from "pptx-browser";

import { cn } from "@/lib/utils";
import { Button } from "@/components/ui/button";

/** Canvas render width; CSS scales it down to fit. Higher = crisper. */
const RENDER_WIDTH = 1280;

function base64ToBytes(base64: string): Uint8Array {
  const bin = atob(base64);
  const arr = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) arr[i] = bin.charCodeAt(i);
  return arr;
}

/**
 * Preview a .pptx by rendering its slides to a canvas with pptx-browser
 * (zero-dependency, native ZIP + Canvas 2D). One slide at a time with a
 * navigator. Lazy-loaded (see ArtifactCard) so the renderer stays out of the
 * main bundle.
 */
export default function PptxPreview({ content }: { content: string; full?: boolean }) {
  const canvasRef = React.useRef<HTMLCanvasElement>(null);
  const rendererRef = React.useRef<PptxRenderer | null>(null);
  const [slideCount, setSlideCount] = React.useState(0);
  const [current, setCurrent] = React.useState(0);
  const [loading, setLoading] = React.useState(true);
  const [navigating, setNavigating] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);

  React.useEffect(() => {
    let cancelled = false;
    const renderer = new PptxRenderer();
    rendererRef.current = renderer;
    setLoading(true);
    setError(null);

    void renderer
      .load(base64ToBytes(content))
      .then(async () => {
        if (cancelled) return;
        setSlideCount(renderer.slideCount);
        if (renderer.slideCount > 0 && canvasRef.current) {
          await renderer.renderSlide(0, canvasRef.current, RENDER_WIDTH);
        }
        if (!cancelled) {
          setCurrent(0);
          setLoading(false);
        }
      })
      .catch((err: unknown) => {
        if (!cancelled) {
          setError(err instanceof Error ? err.message : String(err));
          setLoading(false);
        }
      });

    return () => {
      cancelled = true;
      try { renderer.destroy(); } catch { /* nothing to release */ }
      rendererRef.current = null;
    };
  }, [content]);

  const goTo = React.useCallback(
    async (index: number) => {
      const renderer = rendererRef.current;
      if (!renderer || !canvasRef.current || index < 0 || index >= slideCount || navigating) return;
      setNavigating(true);
      setError(null);
      try {
        await renderer.renderSlide(index, canvasRef.current, RENDER_WIDTH);
        setCurrent(index);
      } catch (err: unknown) {
        setError(err instanceof Error ? err.message : String(err));
      } finally {
        setNavigating(false);
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
          <div className="px-4 py-8 text-center text-sm text-muted-foreground">Slides unavailable — {error}</div>
        )}
        <canvas
          ref={canvasRef}
          className={cn("max-h-full max-w-full rounded object-contain shadow-sm", (loading || error) && "invisible")}
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
