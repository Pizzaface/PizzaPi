// Barrel re-exports for the plan-mode module.
// All public API that was previously in plan-mode-toggle.ts is re-exported here.

export type { PlanTodoItem } from "./todo-items.js";
export { splitShellSegments } from "./shell-parser.js";
export { isDestructiveCommand, isSafeCommand } from "./safe-command.js";
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
} from "./extension.js";
