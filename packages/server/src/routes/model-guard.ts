/**
 * Pure helpers for model-access enforcement.
 *
 * Kept in a dependency-free module so it can be imported directly in tests
 * without pulling in the full routes/runners dependency chain.
 */

/**
 * Returns true when the given model matches an entry in the hidden list.
 * Keys are formatted as "provider/id" (e.g. "anthropic/claude-3-5-haiku").
 */
export function isHiddenModel(
    hiddenModels: string[],
    model: { provider: string; id: string },
): boolean {
    const provider = model.provider.trim();
    const id = model.id.trim();
    if (!provider || !id) return false;
    const key = `${provider}/${id}`;
    return hiddenModels.some((stored) => {
        const parts = stored.split("/");
        if (parts.length !== 2) return stored.trim() === key;
        return `${parts[0].trim()}/${parts[1].trim()}` === key;
    });
}
