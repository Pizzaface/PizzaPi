/**
 * Shared constants for the PizzaPi server.
 *
 * These constants centralize timeout, limit, and retention settings
 * that are used across multiple modules.
 */

export const TIMEOUTS = {
    /** Default timeout for operations (30 seconds) */
    DEFAULT: 30_000,
    /** Timeout for slow operations like file uploads (60 seconds) */
    SLOW_OPERATION: 60_000,
    /** Base delay for retry operations (2 seconds) */
    RETRY_BASE: 2_000,
    /** Maximum delay for retry operations (60 seconds) */
    RETRY_MAX: 60_000,
} as const;

export const LIMITS = {
    /**
     * Maximum number of lines in a terminal buffer.
     * When exceeded, oldest lines are trimmed.
     */
    MAX_TERMINAL_BUFFER_LINES: 10_000,

    /**
     * Maximum size of a terminal buffer in bytes (1MB).
     * When exceeded, oldest messages are trimmed.
     */
    MAX_TERMINAL_BUFFER_BYTES: 1024 * 1024,

    /**
     * Maximum number of attachments stored per server.
     * When exceeded, oldest attachments are evicted.
     */
    MAX_ATTACHMENTS: 1000,

    /**
     * Default TTL for attachments (15 minutes).
     * Attachments are automatically deleted after this period.
     */
    ATTACHMENT_TTL_MS: 15 * 60 * 1000,
} as const;
