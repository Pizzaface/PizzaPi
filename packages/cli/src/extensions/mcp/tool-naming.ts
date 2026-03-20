/**
 * Collision-safe tool name allocation for MCP tools registered with the pi provider.
 *
 * MCP tool names must be unique within a provider and match the pattern
 * `[a-zA-Z0-9_-]{1,64}`. When multiple MCP servers expose tools with the
 * same name, or when a tool name is too long, these utilities generate a
 * deterministic, collision-free alias.
 */

const PROVIDER_TOOL_NAME_MAX_LENGTH = 64;

function shortHash(value: string): string {
  let h1 = 0xdeadbeef ^ value.length;
  let h2 = 0x41c6ce57 ^ value.length;

  for (let i = 0; i < value.length; i++) {
    const ch = value.charCodeAt(i);
    h1 = Math.imul(h1 ^ ch, 2654435761);
    h2 = Math.imul(h2 ^ ch, 1597334677);
  }

  h1 = Math.imul(h1 ^ (h1 >>> 16), 2246822507) ^ Math.imul(h2 ^ (h2 >>> 13), 3266489909);
  h2 = Math.imul(h2 ^ (h2 >>> 16), 2246822507) ^ Math.imul(h1 ^ (h1 >>> 13), 3266489909);

  return `${(h1 >>> 0).toString(36)}${(h2 >>> 0).toString(36)}`;
}

function sanitizeToolNamePart(value: string): string {
  const sanitized = value
    .trim()
    .replace(/[^a-zA-Z0-9_-]+/g, "_")
    .replace(/_+/g, "_")
    .replace(/^_+|_+$/g, "");

  return sanitized || "tool";
}

function clampToolName(name: string, seed: string): string {
  if (name.length <= PROVIDER_TOOL_NAME_MAX_LENGTH) return name;

  const hash = shortHash(seed).slice(0, 8);
  const keep = Math.max(1, PROVIDER_TOOL_NAME_MAX_LENGTH - hash.length - 1);
  return `${name.slice(0, keep)}_${hash}`;
}

/**
 * Generate a provider-safe, collision-free tool name for an MCP tool.
 *
 * The resulting name:
 *  - Uses the `mcp_<server>_<tool>` convention
 *  - Is at most 64 characters
 *  - Is unique within `usedNames` (hash suffix added on collision)
 *
 * Mutates `usedNames` by inserting the allocated name.
 */
export function allocateProviderSafeToolName(serverName: string, mcpToolName: string, usedNames: Set<string>): string {
  const source = `${serverName}:${mcpToolName}`;
  const normalizedBase = `mcp_${sanitizeToolNamePart(serverName).toLowerCase()}_${sanitizeToolNamePart(mcpToolName).toLowerCase()}`;

  const preferred = clampToolName(normalizedBase, source);
  if (!usedNames.has(preferred)) {
    usedNames.add(preferred);
    return preferred;
  }

  const hash = shortHash(source).slice(0, 8);
  const withHash = clampToolName(`${normalizedBase}_${hash}`, `${source}:${hash}`);
  if (!usedNames.has(withHash)) {
    usedNames.add(withHash);
    return withHash;
  }

  let counter = 2;
  while (true) {
    const candidate = clampToolName(`${normalizedBase}_${hash}_${counter}`, `${source}:${counter}`);
    if (!usedNames.has(candidate)) {
      usedNames.add(candidate);
      return candidate;
    }
    counter++;
  }
}
