// ============================================================================
// Password validation — shared across server, UI, and CLI
// ============================================================================

/** Human-readable description of each password requirement. */
export const PASSWORD_REQUIREMENTS = [
  "At least 8 characters",
  "At least one uppercase letter (A-Z)",
  "At least one lowercase letter (a-z)",
  "At least one number (0-9)",
] as const;

/** Summary string for error messages. */
export const PASSWORD_REQUIREMENTS_SUMMARY =
  "Password must be at least 8 characters long and contain at least one uppercase letter, one lowercase letter, and one number";

export interface PasswordCheck {
  /** Overall pass/fail. */
  valid: boolean;
  /** Per-requirement results (same order as PASSWORD_REQUIREMENTS). */
  checks: readonly PasswordCheckItem[];
}

export interface PasswordCheckItem {
  /** The human-readable requirement label. */
  label: string;
  /** Whether this individual requirement is met. */
  met: boolean;
}

/**
 * Validate a password against all requirements and return detailed results.
 *
 * Use `.valid` for a quick boolean, or iterate `.checks` for per-rule feedback.
 */
export function validatePassword(password: string): PasswordCheck {
  const checks: PasswordCheckItem[] = [
    { label: PASSWORD_REQUIREMENTS[0], met: password.length >= 8 },
    { label: PASSWORD_REQUIREMENTS[1], met: /[A-Z]/.test(password) },
    { label: PASSWORD_REQUIREMENTS[2], met: /[a-z]/.test(password) },
    { label: PASSWORD_REQUIREMENTS[3], met: /[0-9]/.test(password) },
  ];
  return {
    valid: checks.every((c) => c.met),
    checks,
  };
}

/**
 * Simple boolean check — drop-in replacement for the old `isValidPassword`.
 */
export function isValidPassword(password: string): boolean {
  return validatePassword(password).valid;
}
