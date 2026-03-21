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
    return hiddenModels.includes(`${model.provider}/${model.id}`);
}
