// ============================================================================
// Password validation — shared across server, UI, and CLI
// ============================================================================

/**
 * Maximum password length (in characters) accepted by the server.
 *
 * Better Auth uses scrypt for hashing, which — unlike bcrypt — does NOT truncate
 * input. Arbitrarily long passwords translate to proportionally expensive hashing,
 * creating a DoS vector. 128 characters is generous for any real password/passphrase
 * while bounding scrypt cost.
 */
export const MAX_PASSWORD_LENGTH = 128;

/** Human-readable description of each password requirement. */
export const PASSWORD_REQUIREMENTS = [
  "At least 8 characters",
  "At least one uppercase letter (A-Z)",
  "At least one lowercase letter (a-z)",
  "At least one number (0-9)",
] as const;

/** Summary string for error messages. */
export const PASSWORD_REQUIREMENTS_SUMMARY =
  `Password must be at least 8 characters long, no more than ${MAX_PASSWORD_LENGTH} characters, and contain at least one uppercase letter, one lowercase letter, and one number`;

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
  // Guard against non-string values that bypass TypeScript at runtime (e.g. JS
  // callers, JSON deserialization). Return a safe invalid result rather than
  // throwing, so callers don't need try/catch around a validation function.
  if (typeof password !== "string") {
    return {
      valid: false,
      checks: PASSWORD_REQUIREMENTS.map((label) => ({ label, met: false })),
    };
  }

  // Always compute per-rule checks against actual content so that callers
  // (e.g. UI components) receive truthful per-requirement feedback regardless
  // of the max-length path below.
  const checks: PasswordCheckItem[] = [
    { label: PASSWORD_REQUIREMENTS[0], met: password.length >= 8 },
    { label: PASSWORD_REQUIREMENTS[1], met: /[A-Z]/.test(password) },
    { label: PASSWORD_REQUIREMENTS[2], met: /[a-z]/.test(password) },
    { label: PASSWORD_REQUIREMENTS[3], met: /[0-9]/.test(password) },
  ];

  // Reject passwords exceeding the maximum length. This mirrors server-side
  // enforcement and prevents unbounded scrypt cost (DoS vector). We still
  // return the truthfully-computed checks so the UI can show which of the
  // standard requirements are met — the caller should surface the max-length
  // error separately (e.g. via PASSWORD_REQUIREMENTS_SUMMARY).
  if (password.length > MAX_PASSWORD_LENGTH) {
    return { valid: false, checks };
  }

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
