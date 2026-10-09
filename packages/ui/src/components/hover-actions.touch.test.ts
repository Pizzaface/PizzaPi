import { describe, expect, test } from "bun:test";

const files = [
  "./SessionViewer.tsx",
  "./AgentsManager.tsx",
  "./SkillsManager.tsx",
  "./TerminalManager.tsx",
  "./NewSessionWizardDialog.tsx",
  "./ai-elements/attachments.tsx",
  "./session-viewer/ActivityToolCard.tsx",
  "./git/GitWorktreeList.tsx",
];

const touchFallback = "[@media(hover:none)]:opacity-100";

describe("hover-revealed action controls", () => {
  test("are visible on touch/no-hover devices", async () => {
    const offenders: string[] = [];

    for (const file of files) {
      const source = await Bun.file(new URL(file, import.meta.url)).text();
      source.split("\n").forEach((line, index) => {
        if (!line.includes("opacity-0") || !line.includes("group-hover:opacity-100")) return;
        if (line.includes(touchFallback)) return;
        if (line.includes("opacity-100 @md:opacity-0 @md:group-hover:opacity-100")) return;
        offenders.push(`${file}:${index + 1}: ${line.trim()}`);
      });
    }

    expect(offenders).toEqual([]);
  });
});
