/**
 * @deprecated This file is a re-export shim for backward compatibility.
 * Import from "./plan-mode/index.js" instead.
 */
export type { PlanTodoItem } from "./plan-mode/todo-items.js";
export { splitShellSegments } from "./plan-mode/shell-parser.js";
export { isDestructiveCommand, isSafeCommand } from "./plan-mode/safe-command.js";
export {
    isPlanModeEnabled,
    isExecutionMode,
    getPlanTodoItems,
    requestContextClear,
    setPlanModeChangeCallback,
    setPlanModeMetaEmitter,
    togglePlanModeFromRemote,
    setPlanModeFromRemote,
    planModeToggleExtension,
} from "./plan-mode/extension.js";
