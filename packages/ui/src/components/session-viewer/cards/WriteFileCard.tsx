import * as React from "react";
import { EditFileCard } from "@/components/ai-elements/edit-file-card";
import { CopyableCodeBlock } from "@/components/session-viewer/cards/InterAgentCards";
import { extToLang } from "@/components/session-viewer/tool-rendering";

export function WriteFileCard({
  path,
  content,
}: {
  path: string;
  content: string;
}) {
  const lineCount = content ? content.split("\n").length : 0;
  const lang = extToLang(path);
  return (
    <EditFileCard path={path} additions={lineCount} deletions={0}>
      <CopyableCodeBlock code={content} language={lang} className="border-0 rounded-none" />
    </EditFileCard>
  );
}
