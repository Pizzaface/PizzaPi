"use client";

import * as React from "react";
import type { BundledLanguage, ThemedToken } from "shiki";

import { highlightCode } from "@/components/ai-elements/code-block";
import { EditFileCard } from "@/components/ai-elements/edit-file-card";
import { cn } from "@/lib/utils";

type DiffLine =
  | { kind: "same"; text: string }
  | { kind: "del"; text: string }
  | { kind: "add"; text: string };

function computeDiff(oldText: string, newText: string): DiffLine[] {
  const oldLines = oldText === "" ? [] : oldText.split("\n");
  const newLines = newText === "" ? [] : newText.split("\n");
  const m = oldLines.length;
  const n = newLines.length;

  // LCS via DP
  const dp: number[][] = Array.from({ length: m + 1 }, () =>
    new Array(n + 1).fill(0)
  );
  for (let i = m - 1; i >= 0; i--) {
    for (let j = n - 1; j >= 0; j--) {
      if (oldLines[i] === newLines[j]) {
        dp[i][j] = dp[i + 1][j + 1] + 1;
      } else {
        dp[i][j] = Math.max(dp[i + 1][j], dp[i][j + 1]);
      }
    }
  }

  const result: DiffLine[] = [];
  let i = 0,
    j = 0;
  while (i < m || j < n) {
    if (i < m && j < n && oldLines[i] === newLines[j]) {
      result.push({ kind: "same", text: oldLines[i] });
      i++;
      j++;
    } else if (j < n && (i >= m || dp[i][j + 1] >= dp[i + 1][j])) {
      result.push({ kind: "add", text: newLines[j] });
      j++;
    } else {
      result.push({ kind: "del", text: oldLines[i] });
      i++;
    }
  }
  return result;
}

function extToLang(path: string): BundledLanguage {
  const ext = path.split(".").pop()?.toLowerCase() ?? "";
  const map: Record<string, BundledLanguage> = {
    ts: "typescript",
    tsx: "tsx",
    js: "javascript",
    jsx: "jsx",
    py: "python",
    rs: "rust",
    go: "go",
    java: "java",
    c: "c",
    cpp: "cpp",
    cs: "csharp",
    rb: "ruby",
    sh: "bash",
    bash: "bash",
    zsh: "bash",
    json: "json",
    yaml: "yaml",
    yml: "yaml",
    md: "markdown",
    html: "html",
    css: "css",
    toml: "toml",
    sql: "sql",
  };
  return map[ext] ?? "markdown";
}

function DiffContent({
  path,
  oldText,
  newText,
}: {
  path: string;
  oldText: string;
  newText: string;
}) {
  const lang = extToLang(path);
  const diffLines = React.useMemo(
    () => computeDiff(oldText, newText),
    [oldText, newText]
  );

  const oldCode = diffLines
    .filter((l) => l.kind !== "add")
    .map((l) => l.text)
    .join("\n");
  const newCode = diffLines
    .filter((l) => l.kind !== "del")
    .map((l) => l.text)
    .join("\n");

  const rawTokens = React.useCallback(
    (code: string) =>
      code
        .split("\n")
        .map((line) =>
          line === ""
            ? []
            : ([{ content: line, color: "inherit" }] as ThemedToken[])
        ),
    []
  );

  const [oldTokens, setOldTokens] = React.useState<ThemedToken[][]>(
    () => highlightCode(oldCode, lang)?.tokens ?? rawTokens(oldCode)
  );
  const [newTokens, setNewTokens] = React.useState<ThemedToken[][]>(
    () => highlightCode(newCode, lang)?.tokens ?? rawTokens(newCode)
  );

  React.useEffect(() => {
    let cancelled = false;
    const cached = highlightCode(oldCode, lang, (r) => {
      if (!cancelled) setOldTokens(r.tokens);
    });
    if (cached) setOldTokens(cached.tokens);
    return () => {
      cancelled = true;
    };
  }, [oldCode, lang]);

  React.useEffect(() => {
    let cancelled = false;
    const cached = highlightCode(newCode, lang, (r) => {
      if (!cancelled) setNewTokens(r.tokens);
    });
    if (cached) setNewTokens(cached.tokens);
    return () => {
      cancelled = true;
    };
  }, [newCode, lang]);

  // Map diff lines back to token rows
  let oldIdx = 0,
    newIdx = 0;
  const rows: { kind: DiffLine["kind"]; tokens: ThemedToken[] }[] = [];
  for (const line of diffLines) {
    if (line.kind === "del") {
      rows.push({ kind: "del", tokens: oldTokens[oldIdx++] ?? [] });
    } else if (line.kind === "add") {
      rows.push({ kind: "add", tokens: newTokens[newIdx++] ?? [] });
    } else {
      rows.push({ kind: "same", tokens: oldTokens[oldIdx++] ?? [] });
      newIdx++;
    }
  }

  return (
    <div className="overflow-x-auto min-h-full bg-background">
      <pre className="m-0 p-0 text-xs font-mono leading-5 min-h-full">
        <code>
          {rows.map((row, i) => (
            <span
              key={i}
              className={cn(
                "block px-2",
                row.kind === "del" && "bg-red-500/15 dark:bg-red-500/20",
                row.kind === "add" && "bg-green-500/15 dark:bg-green-500/20"
              )}
            >
              <span
                className={cn(
                  "inline-block w-4 select-none mr-1 text-center",
                  row.kind === "del" && "text-red-500",
                  row.kind === "add" && "text-green-500",
                  row.kind === "same" && "text-muted-foreground/30"
                )}
              >
                {row.kind === "del" ? "-" : row.kind === "add" ? "+" : " "}
              </span>
              {row.tokens.length === 0
                ? "\n"
                : row.tokens.map((t, ti) => (
                    <span
                      key={ti}
                      className="dark:text-(--shiki-dark)!"
                      style={{ color: t.color }}
                    >
                      {t.content}
                    </span>
                  ))}
            </span>
          ))}
        </code>
      </pre>
    </div>
  );
}

function countDiffStats(oldText: string, newText: string): {
  additions: number;
  deletions: number;
} {
  const lines = computeDiff(oldText, newText);
  let additions = 0;
  let deletions = 0;
  for (const line of lines) {
    if (line.kind === "add") additions++;
    if (line.kind === "del") deletions++;
  }
  return { additions, deletions };
}

export function DiffView({
  path,
  oldText,
  newText,
}: {
  path: string;
  oldText: string;
  newText: string;
}) {
  const { additions, deletions } = React.useMemo(
    () => countDiffStats(oldText, newText),
    [oldText, newText]
  );

  return (
    <EditFileCard path={path} additions={additions} deletions={deletions}>
      <DiffContent path={path} oldText={oldText} newText={newText} />
    </EditFileCard>
  );
}
