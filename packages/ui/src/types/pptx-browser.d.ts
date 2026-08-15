// pptx-browser ships no TypeScript declarations. Declare the subset we use.
declare module "pptx-browser" {
  export class PptxRenderer {
    /** Total slides, available after load() resolves. */
    readonly slideCount: number;
    load(
      source: File | Blob | ArrayBuffer | Uint8Array,
      onProgress?: (progress: number, message: string) => void,
    ): Promise<void>;
    renderSlide(index: number, canvas: HTMLCanvasElement, width?: number): Promise<void>;
    renderAllSlides(width?: number): Promise<HTMLCanvasElement[]>;
    destroy(): void;
  }
}
