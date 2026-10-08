const PROMPT_XML_ESCAPE: Record<string, string> = {
    "&": "&amp;",
    "<": "&lt;",
    ">": "&gt;",
    '"': "&quot;",
    "'": "&#39;",
};

export function escapePromptXml(value: string): string {
    return value.replace(/[&<>"']/g, (char) => PROMPT_XML_ESCAPE[char] ?? char);
}
