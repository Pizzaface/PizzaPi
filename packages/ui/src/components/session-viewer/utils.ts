export function hasVisibleContent(content: unknown): boolean {
  if (content === undefined || content === null || content === "") return false;
  if (Array.isArray(content)) {
    return content.some((block) => {
      if (!block || typeof block !== "object") return false;
      const b = block as Record<string, unknown>;
      if (b.type === "text")
        return typeof b.text === "string" && b.text.trim() !== "";
      if (b.type === "thinking")
        return typeof b.thinking === "string" && b.thinking.trim() !== "";
      return true;
    });
  }
  return true;
}

export function tryParseJsonObject(text: string): Record<string, unknown> | null {
  try {
    const parsed = JSON.parse(text);
    return parsed && typeof parsed === "object"
      ? (parsed as Record<string, unknown>)
      : null;
  } catch {
    return null;
  }
}

export function normalizeToolName(toolName?: string): string {
  return (toolName ?? "").trim().toLowerCase();
}

export function extractTextFromToolContent(content: unknown): string | null {
  if (typeof content === "string") return content;

  if (Array.isArray(content)) {
    const parts: string[] = [];
    for (const block of content) {
      if (!block || typeof block !== "object") continue;
      const b = block as Record<string, unknown>;
      if (typeof b.text === "string") {
        parts.push(b.text);
      } else if (typeof b.content === "string") {
        parts.push(b.content);
      }
    }
    return parts.length > 0 ? parts.join("\n\n") : null;
  }

  if (content && typeof content === "object") {
    const obj = content as Record<string, unknown>;
    if (typeof obj.text === "string") return obj.text;
    if (typeof obj.content === "string") return obj.content;
  }

  return null;
}

export function extractPathFromToolContent(content: unknown): string | undefined {
  if (!content || typeof content !== "object") return undefined;

  if (Array.isArray(content)) {
    for (const block of content) {
      if (!block || typeof block !== "object") continue;
      const b = block as Record<string, unknown>;
      if (typeof b.path === "string") return b.path;
    }
    return undefined;
  }

  const obj = content as Record<string, unknown>;
  return typeof obj.path === "string" ? obj.path : undefined;
}

export function estimateBase64Bytes(data: string): number {
  const base64 = data.includes(",") ? data.split(",").pop() ?? "" : data;
  const padding = base64.endsWith("==") ? 2 : base64.endsWith("=") ? 1 : 0;
  return Math.max(0, Math.floor((base64.length * 3) / 4) - padding);
}

export function formatBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes <= 0) return "0 B";
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 ** 2) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / 1024 ** 2).toFixed(2)} MB`;
}

export function formatDateValue(value: unknown): string | null {
  if (typeof value === "number" && Number.isFinite(value)) {
    const date = new Date(value > 10_000_000_000 ? value : value * 1000);
    if (!Number.isNaN(date.getTime())) return date.toLocaleString();
  }

  if (typeof value === "string" && value.trim()) {
    const date = new Date(value);
    if (!Number.isNaN(date.getTime())) return date.toLocaleString();
    return value;
  }

  return null;
}

/**
 * Safely coerce `toolInput` to a plain object.
 *
 * Replaces the repeated pattern:
 * ```ts
 * const inputArgs = toolInput && typeof toolInput === "object"
 *   ? (toolInput as Record<string, unknown>)
 *   : {};
 * ```
 */
export function parseToolInputArgs(
  toolInput: unknown,
): Record<string, unknown> {
  return toolInput && typeof toolInput === "object"
    ? (toolInput as Record<string, unknown>)
    : {};
}

export function extToMime(path: string): string {
  const ext = path.split(".").pop()?.toLowerCase() ?? "";
  const map: Record<string, string> = {
    ts: "text/typescript",
    tsx: "text/tsx",
    js: "text/javascript",
    jsx: "text/jsx",
    py: "text/x-python",
    rs: "text/x-rust",
    go: "text/x-go",
    java: "text/x-java",
    c: "text/x-c",
    cpp: "text/x-c++",
    cs: "text/x-csharp",
    rb: "text/x-ruby",
    sh: "text/x-sh",
    bash: "text/x-sh",
    zsh: "text/x-sh",
    json: "application/json",
    yaml: "text/yaml",
    yml: "text/yaml",
    md: "text/markdown",
    html: "text/html",
    css: "text/css",
    toml: "application/toml",
    sql: "text/x-sql",
    png: "image/png",
    jpg: "image/jpeg",
    jpeg: "image/jpeg",
    gif: "image/gif",
    svg: "image/svg+xml",
    webp: "image/webp",
    pdf: "application/pdf",
    txt: "text/plain",
  };
  return map[ext] ?? "text/plain";
}
