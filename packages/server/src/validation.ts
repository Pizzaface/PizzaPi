/**
 * Validates a skill name to prevent path traversal and enforce safe identifiers.
 * Allowed characters: a-z, A-Z, 0-9, -, _, .
 * Must not start or end with a dot, and must not contain consecutive dots.
 * Length: 1-64 characters
 *
 * @param name The skill name to validate
 * @returns true if the name is valid, false otherwise
 */
export function isValidSkillName(name: string): boolean {
    if (!name || typeof name !== "string") return false;
    if (name.length > 64) return false;

    // Allow alphanumeric, dash, underscore, dot.
    // Must start and end with alphanumeric/dash/underscore.
    // Dots must be separated by other characters (no consecutive dots).
    return /^[a-zA-Z0-9_-]+(\.[a-zA-Z0-9_-]+)*$/.test(name);
}
