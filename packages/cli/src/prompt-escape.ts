const PROMPT_XML_TEXT_ESCAPE: Record<string, string> = {
    "&": "&amp;",
    "<": "&lt;",
    ">": "&gt;",
};

const PROMPT_XML_ATTRIBUTE_ESCAPE: Record<string, string> = {
    ...PROMPT_XML_TEXT_ESCAPE,
    '"': "&quot;",
    "'": "&#39;",
};

export function escapePromptXmlText(value: string): string {
    return value.replace(/[&<>]/g, (char) => PROMPT_XML_TEXT_ESCAPE[char]);
}

export function escapePromptXmlAttribute(value: string): string {
    return value.replace(/[&<>"']/g, (char) => PROMPT_XML_ATTRIBUTE_ESCAPE[char]);
}
