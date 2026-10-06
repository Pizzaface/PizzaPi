/**
 * pi event-bus channel + relay event type for structured `/plugin` results.
 * Dependency-free so the remote extension can import it without pulling in
 * plugin discovery (and its config imports).
 */
export const PLUGIN_COMMAND_RESULT_CHANNEL = "plugin:command_result";
export const PLUGIN_COMMAND_RESULT_EVENT = "plugin_command_result";
